import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ScopeType = "function" | "method" | "class" | "interface" | "type" | "enum" | "namespace" | "block";

interface ConflictHunk {
	startLine: number;
	endLine: number;
	oursStartLine: number;
	oursEndLine: number;
	theirsStartLine: number;
	theirsEndLine: number;
	ours: string;
	theirs: string;
	raw: string;
}

interface ConflictContext {
	scopeType: ScopeType;
	scopeStartLine: number;
	scopeEndLine: number;
	conflictStartLine: number;
	conflictEndLine: number;
	snippet: string;
}

interface ConflictPayload {
	cwd: string;
	target?: string;
	scannedFiles: number;
	filesWithConflicts: number;
	totalConflicts: number;
	files: Array<{
		filePath: string;
		conflictCount: number;
		conflicts: Array<{ hunk: ConflictHunk; context: ConflictContext }>;
	}>;
}

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function normalizeTarget(args: string): string | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function isIgnoredDir(name: string): boolean {
	return name === "node_modules" || name === ".git" || name === "dist";
}

function collectTypeScriptFiles(baseDir: string): string[] {
	const files: string[] = [];
	const stack = [baseDir];

	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
				name: String(entry.name),
				isDirectory: () => entry.isDirectory(),
				isFile: () => entry.isFile(),
			}));
		} catch {
			continue;
		}
		for (const entry of entries) {
			const absolute = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				if (!isIgnoredDir(entry.name)) stack.push(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(absolute);
		}
	}

	return files;
}

function resolveTargetFiles(cwd: string, target: string | undefined): { files: string[]; error?: string } {
	if (!target) return { files: collectTypeScriptFiles(cwd) };

	const absolute = resolve(cwd, target);
	if (!existsSync(absolute)) return { files: [], error: `Path not found: ${target}` };

	const stats = statSync(absolute);
	if (stats.isFile()) {
		const extension = extname(absolute).toLowerCase();
		if (!SUPPORTED_EXTENSIONS.has(extension)) {
			return {
				files: [],
				error: `Unsupported file extension: ${extension || "(none)"}. Supported: ${Array.from(SUPPORTED_EXTENSIONS).join(", ")}`,
			};
		}
		return { files: [absolute] };
	}

	if (stats.isDirectory()) return { files: collectTypeScriptFiles(absolute) };

	return { files: [], error: `Path is neither file nor directory: ${target}` };
}

function splitLines(content: string): string[] {
	if (content.length === 0) return [""];
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function detectConflictHunks(content: string): ConflictHunk[] {
	const lines = splitLines(content);
	const hunks: ConflictHunk[] = [];

	let startLine: number | undefined;
	let separatorLine: number | undefined;
	let ours: string[] = [];
	let theirs: string[] = [];
	let state: "outside" | "ours" | "theirs" = "outside";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = i + 1;
		if (state === "outside") {
			if (line.trimStart().startsWith("<<<<<<< ")) {
				state = "ours";
				startLine = lineNumber;
				separatorLine = undefined;
				ours = [];
				theirs = [];
			}
			continue;
		}

		if (state === "ours") {
			if (line.trim() === "=======") {
				state = "theirs";
				separatorLine = lineNumber;
				continue;
			}
			ours.push(line);
			continue;
		}

		if (line.trimStart().startsWith(">>>>>>> ") && startLine !== undefined && separatorLine !== undefined) {
			const endLine = lineNumber;
			hunks.push({
				startLine,
				endLine,
				oursStartLine: startLine + 1,
				oursEndLine: separatorLine - 1,
				theirsStartLine: separatorLine + 1,
				theirsEndLine: endLine - 1,
				ours: ours.join("\n"),
				theirs: theirs.join("\n"),
				raw: lines.slice(startLine - 1, endLine).join("\n"),
			});
			state = "outside";
			startLine = undefined;
			separatorLine = undefined;
			ours = [];
			theirs = [];
			continue;
		}

		theirs.push(line);
	}

	return hunks;
}

function stripStringsAndComments(
	line: string,
	state: { inBlockComment: boolean },
): { text: string; inBlockComment: boolean } {
	let inBlockComment = state.inBlockComment;
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let inTemplate = false;
	let escaped = false;
	let out = "";

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		const next = i + 1 < line.length ? line[i + 1] : "";
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (!inSingleQuote && !inDoubleQuote && !inTemplate) {
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				i++;
				continue;
			}
			if (ch === "/" && next === "/") break;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inSingleQuote) {
			if (ch === "\\") escaped = true;
			else if (ch === "'") inSingleQuote = false;
			continue;
		}
		if (inDoubleQuote) {
			if (ch === "\\") escaped = true;
			else if (ch === '"') inDoubleQuote = false;
			continue;
		}
		if (inTemplate) {
			if (ch === "\\") escaped = true;
			else if (ch === "`") inTemplate = false;
			continue;
		}
		if (ch === "'") {
			inSingleQuote = true;
			continue;
		}
		if (ch === '"') {
			inDoubleQuote = true;
			continue;
		}
		if (ch === "`") {
			inTemplate = true;
			continue;
		}
		out += ch;
	}
	return { text: out, inBlockComment };
}

function detectScopeType(lines: string[], lineIndex: number, braceColumn: number, lookbackLines: number): ScopeType {
	const start = Math.max(0, lineIndex - lookbackLines + 1);
	const parts = lines.slice(start, lineIndex + 1);
	if (parts.length === 0) return "block";
	parts[parts.length - 1] = parts[parts.length - 1].slice(0, braceColumn);
	const header = parts.join("\n").trim();
	const headerLines = header.split("\n");
	const lastLine = headerLines[headerLines.length - 1]?.trim() ?? "";

	if (/\bfunction\s+[A-Za-z_$][\w$]*\s*\(/.test(lastLine)) return "function";
	if (/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/.test(lastLine)) return "function";
	if (
		/^(?:public|private|protected|static|async|readonly|get|set\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*$/.test(lastLine)
	) {
		return "method";
	}
	if (/\bclass\s+[A-Za-z_$][\w$]*/m.test(header)) return "class";
	if (/\binterface\s+[A-Za-z_$][\w$]*/m.test(header)) return "interface";
	if (/\btype\s+[A-Za-z_$][\w$]*\s*=\s*/m.test(header)) return "type";
	if (/\benum\s+[A-Za-z_$][\w$]*/m.test(header)) return "enum";
	if (/\bnamespace\s+[A-Za-z_$][\w$]*/m.test(header)) return "namespace";
	return "block";
}

function extractTypeScriptConflictContext(
	content: string,
	conflictStartLine: number,
	conflictEndLine: number,
): ConflictContext {
	const lines = splitLines(content);
	const blocks: Array<{ openLine: number; closeLine: number; scopeType: ScopeType }> = [];
	const stack: Array<{ line: number; scopeType: ScopeType }> = [];
	let inBlockComment = false;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const cleaned = stripStringsAndComments(lines[lineIndex], { inBlockComment });
		inBlockComment = cleaned.inBlockComment;
		for (let i = 0; i < cleaned.text.length; i++) {
			const ch = cleaned.text[i];
			if (ch === "{") {
				stack.push({ line: lineIndex + 1, scopeType: detectScopeType(lines, lineIndex, i, 6) });
			} else if (ch === "}") {
				const open = stack.pop();
				if (open) blocks.push({ openLine: open.line, closeLine: lineIndex + 1, scopeType: open.scopeType });
			}
		}
	}

	let best: { openLine: number; closeLine: number; scopeType: ScopeType } | undefined;
	for (const block of blocks) {
		if (block.openLine > conflictStartLine || block.closeLine < conflictEndLine) continue;
		if (!best || block.closeLine - block.openLine < best.closeLine - best.openLine) best = block;
	}

	if (!best) {
		const startLine = Math.max(1, conflictStartLine - 20);
		const endLine = Math.min(lines.length, conflictEndLine + 20);
		return {
			scopeType: "block",
			scopeStartLine: startLine,
			scopeEndLine: endLine,
			conflictStartLine,
			conflictEndLine,
			snippet: lines.slice(startLine - 1, endLine).join("\n"),
		};
	}

	return {
		scopeType: best.scopeType,
		scopeStartLine: best.openLine,
		scopeEndLine: best.closeLine,
		conflictStartLine,
		conflictEndLine,
		snippet: lines.slice(best.openLine - 1, best.closeLine).join("\n"),
	};
}

async function buildPayload(cwd: string, target: string | undefined): Promise<ConflictPayload | { error: string }> {
	const resolved = resolveTargetFiles(cwd, target);
	if (resolved.error) return { error: resolved.error };

	const payload: ConflictPayload = {
		cwd,
		target,
		scannedFiles: resolved.files.length,
		filesWithConflicts: 0,
		totalConflicts: 0,
		files: [],
	};

	for (const filePath of resolved.files) {
		const content = readFileSync(filePath, "utf-8");
		const hunks = detectConflictHunks(content);
		if (hunks.length === 0) continue;

		const conflicts = hunks.map((hunk) => ({
			hunk,
			context: extractTypeScriptConflictContext(content, hunk.startLine, hunk.endLine),
		}));

		payload.files.push({
			filePath: relative(cwd, filePath).replace(/\\/g, "/") || filePath,
			conflictCount: conflicts.length,
			conflicts,
		});
		payload.totalConflicts += conflicts.length;
	}

	payload.filesWithConflicts = payload.files.length;
	return payload;
}

export default function openresolve(pi: ExtensionAPI) {
	pi.registerCommand("conflicts", {
		description: "Find TypeScript merge conflicts and return structured JSON context",
		handler: async (args, ctx) => {
			const target = normalizeTarget(args);
			const payloadOrError = await buildPayload(ctx.cwd, target);
			if ("error" in payloadOrError) {
				ctx.ui.notify(payloadOrError.error, "error");
				return;
			}

			const json = JSON.stringify(payloadOrError, null, 2);
			pi.sendMessage({
				customType: "openresolve.conflicts",
				content: json,
				display: true,
				details: {
					target,
					totalConflicts: payloadOrError.totalConflicts,
					filesWithConflicts: payloadOrError.filesWithConflicts,
					scannedFiles: payloadOrError.scannedFiles,
				},
			});

			ctx.ui.notify(
				`openresolve: scanned ${payloadOrError.scannedFiles} file(s), found ${payloadOrError.totalConflicts} conflict(s) in ${payloadOrError.filesWithConflicts} file(s)`,
				"info",
			);
		},
	});
}
