import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScriptGrammars from "tree-sitter-typescript";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Rust from "tree-sitter-rust";

type ScopeType = "function" | "method" | "class" | "interface" | "type" | "enum" | "namespace" | "block";
type SupportedLanguage = "javascript" | "typescript" | "tsx" | "python" | "go" | "rust";

interface ConflictHunk {
	startLine: number;
	endLine: number;
	oursStartLine: number;
	oursEndLine: number;
	theirsStartLine: number;
	theirsEndLine: number;
	ours: string;
	theirs: string;
	oursLabel?: string;
	theirsLabel?: string;
	raw: string;
}

interface GitCommitSummary {
	sha: string;
	shortSha: string;
	authorName: string;
	authorEmail: string;
	subject: string;
}

interface RepoGitMetadata {
	repoRoot: string;
	currentBranch?: string;
	headSha?: string;
	mergeHeadSha?: string;
	mergeBaseSha?: string;
}

interface ConflictFileGitMetadata {
	pathFromRepoRoot: string;
	baseBlobSha?: string;
	oursBlobSha?: string;
	theirsBlobSha?: string;
	baseToOursDiff?: string;
	baseToTheirsDiff?: string;
	oursToTheirsDiff?: string;
	oursCommits?: GitCommitSummary[];
	theirsCommits?: GitCommitSummary[];
	oursAuthors?: string[];
	theirsAuthors?: string[];
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
	git?: RepoGitMetadata;
	scannedFiles: number;
	filesWithConflicts: number;
	totalConflicts: number;
	files: Array<{
		filePath: string;
		conflictCount: number;
		git?: ConflictFileGitMetadata;
		conflicts: Array<{ hunk: ConflictHunk; context: ConflictContext }>;
	}>;
}

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".py", ".go", ".rs"]);
const parserCache: Partial<Record<SupportedLanguage, Parser>> = {};

function normalizeTarget(args: string): string | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function isIgnoredDir(name: string): boolean {
	return name === "node_modules" || name === ".git" || name === "dist";
}

function collectSupportedFiles(baseDir: string): string[] {
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
	if (!target) return { files: collectSupportedFiles(cwd) };

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

	if (stats.isDirectory()) return { files: collectSupportedFiles(absolute) };

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
	let oursLabel: string | undefined;
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
				oursLabel = line.trimStart().slice("<<<<<<< ".length).trim() || undefined;
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
			const theirsLabel = line.trimStart().slice(">>>>>>> ".length).trim() || undefined;
			hunks.push({
				startLine,
				endLine,
				oursStartLine: startLine + 1,
				oursEndLine: separatorLine - 1,
				theirsStartLine: separatorLine + 1,
				theirsEndLine: endLine - 1,
				ours: ours.join("\n"),
				theirs: theirs.join("\n"),
				oursLabel,
				theirsLabel,
				raw: lines.slice(startLine - 1, endLine).join("\n"),
			});
			state = "outside";
			startLine = undefined;
			separatorLine = undefined;
			ours = [];
			theirs = [];
			oursLabel = undefined;
			continue;
		}

		theirs.push(line);
	}

	return hunks;
}

function runGitCommand(cwd: string, args: string[], trimOutput = true): { ok: boolean; stdout: string } {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.error || result.status !== 0) return { ok: false, stdout: "" };
	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	return { ok: true, stdout: trimOutput ? stdout.trim() : stdout };
}

function getOptionalGitValue(cwd: string, args: string[]): string | undefined {
	const result = runGitCommand(cwd, args, true);
	return result.ok && result.stdout ? result.stdout : undefined;
}

function parseGitLogSummaries(output: string): GitCommitSummary[] {
	if (!output.trim()) return [];
	return output
		.split(/\r?\n/)
		.map((line) => line.split("\u001f"))
		.filter((parts) => parts.length >= 5)
		.map(([sha, shortSha, authorName, authorEmail, subject]) => ({
			sha,
			shortSha,
			authorName,
			authorEmail,
			subject,
		}));
}

function collectAuthors(commits: GitCommitSummary[]): string[] {
	const seen = new Set<string>();
	for (const commit of commits) seen.add(`${commit.authorName} <${commit.authorEmail}>`);
	return Array.from(seen);
}

function parseUnmergedStages(output: string): Partial<Record<1 | 2 | 3, string>> {
	const stages: Partial<Record<1 | 2 | 3, string>> = {};
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^\d+\s+([0-9a-f]{40})\s+([123])\t/);
		if (!match) continue;
		const sha = match[1];
		const stage = Number(match[2]) as 1 | 2 | 3;
		if (!stages[stage]) stages[stage] = sha;
	}
	return stages;
}

function diffBlobPair(cwd: string, leftSha: string | undefined, rightSha: string | undefined): string | undefined {
	if (!leftSha || !rightSha) return undefined;
	const diff = runGitCommand(cwd, ["diff", "--no-color", leftSha, rightSha], false);
	return diff.ok ? diff.stdout.trim() : undefined;
}

function collectRepoGitMetadata(cwd: string): RepoGitMetadata | undefined {
	const root = getOptionalGitValue(cwd, ["rev-parse", "--show-toplevel"]);
	if (!root) return undefined;

	const currentBranch = getOptionalGitValue(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const headSha = getOptionalGitValue(cwd, ["rev-parse", "HEAD"]);
	const mergeHeadSha = getOptionalGitValue(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
	const mergeBaseSha = headSha && mergeHeadSha ? getOptionalGitValue(cwd, ["merge-base", headSha, mergeHeadSha]) : undefined;

	return {
		repoRoot: root,
		currentBranch,
		headSha,
		mergeHeadSha,
		mergeBaseSha,
	};
}

function collectConflictFileGitMetadata(
	repo: RepoGitMetadata | undefined,
	absoluteFilePath: string,
): ConflictFileGitMetadata | undefined {
	if (!repo) return undefined;
	const pathFromRepoRoot = relative(repo.repoRoot, absoluteFilePath).replace(/\\/g, "/");
	if (!pathFromRepoRoot || pathFromRepoRoot.startsWith("..")) return undefined;

	const unmerged = runGitCommand(repo.repoRoot, ["ls-files", "-u", "--", pathFromRepoRoot]);
	if (!unmerged.ok || !unmerged.stdout) return { pathFromRepoRoot };

	const stages = parseUnmergedStages(unmerged.stdout);
	const baseBlobSha = stages[1];
	const oursBlobSha = stages[2];
	const theirsBlobSha = stages[3];

	let oursCommits: GitCommitSummary[] | undefined;
	let theirsCommits: GitCommitSummary[] | undefined;
	let oursAuthors: string[] | undefined;
	let theirsAuthors: string[] | undefined;

	if (repo.mergeBaseSha && repo.headSha) {
		const oursLog = runGitCommand(
			repo.repoRoot,
			[
				"log",
				"--format=%H%x1f%h%x1f%an%x1f%ae%x1f%s",
				"-n",
				"10",
				`${repo.mergeBaseSha}..${repo.headSha}`,
				"--",
				pathFromRepoRoot,
			],
		);
		if (oursLog.ok) {
			oursCommits = parseGitLogSummaries(oursLog.stdout);
			oursAuthors = collectAuthors(oursCommits);
		}
	}

	if (repo.mergeBaseSha && repo.mergeHeadSha) {
		const theirsLog = runGitCommand(
			repo.repoRoot,
			[
				"log",
				"--format=%H%x1f%h%x1f%an%x1f%ae%x1f%s",
				"-n",
				"10",
				`${repo.mergeBaseSha}..${repo.mergeHeadSha}`,
				"--",
				pathFromRepoRoot,
			],
		);
		if (theirsLog.ok) {
			theirsCommits = parseGitLogSummaries(theirsLog.stdout);
			theirsAuthors = collectAuthors(theirsCommits);
		}
	}

	return {
		pathFromRepoRoot,
		baseBlobSha,
		oursBlobSha,
		theirsBlobSha,
		baseToOursDiff: diffBlobPair(repo.repoRoot, baseBlobSha, oursBlobSha),
		baseToTheirsDiff: diffBlobPair(repo.repoRoot, baseBlobSha, theirsBlobSha),
		oursToTheirsDiff: diffBlobPair(repo.repoRoot, oursBlobSha, theirsBlobSha),
		oursCommits,
		theirsCommits,
		oursAuthors,
		theirsAuthors,
	};
}

function detectLanguageFromPath(filePath: string): SupportedLanguage | undefined {
	const extension = extname(filePath).toLowerCase();
	if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "javascript";
	if (extension === ".tsx") return "tsx";
	if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "typescript";
	if (extension === ".py") return "python";
	if (extension === ".go") return "go";
	if (extension === ".rs") return "rust";
	return undefined;
}

function getParserForLanguage(language: SupportedLanguage): Parser | undefined {
	if (parserCache[language]) return parserCache[language];

	const parser = new Parser();
	try {
		if (language === "javascript") parser.setLanguage(JavaScript);
		if (language === "typescript") parser.setLanguage(TypeScriptGrammars.typescript);
		if (language === "tsx") parser.setLanguage(TypeScriptGrammars.tsx);
		if (language === "python") parser.setLanguage(Python);
		if (language === "go") parser.setLanguage(Go);
		if (language === "rust") parser.setLanguage(Rust);
		parserCache[language] = parser;
		return parser;
	} catch {
		return undefined;
	}
}

function mapNodeTypeToScopeType(nodeType: string): ScopeType | undefined {
	if (
		nodeType === "function_declaration" ||
		nodeType === "generator_function_declaration" ||
		nodeType === "function_expression" ||
		nodeType === "arrow_function"
	) {
		return "function";
	}
	if (nodeType === "method_definition" || nodeType === "method_signature" || nodeType === "abstract_method_signature") {
		return "method";
	}
	if (nodeType === "class_declaration" || nodeType === "class") return "class";
	if (nodeType === "class_definition") return "class";
	if (nodeType === "interface_declaration") return "interface";
	if (nodeType === "interface_type" || nodeType === "trait_item") return "interface";
	if (nodeType === "type_alias_declaration") return "type";
	if (nodeType === "type_declaration" || nodeType === "type_spec" || nodeType === "type_item" || nodeType === "struct_item") {
		return "type";
	}
	if (nodeType === "enum_declaration") return "enum";
	if (nodeType === "enum_item") return "enum";
	if (nodeType === "internal_module") return "namespace";
	if (nodeType === "module" || nodeType === "mod_item") return "namespace";
	if (nodeType === "method_declaration") return "method";
	if (nodeType === "function_definition" || nodeType === "function_declaration" || nodeType === "function_item") {
		return "function";
	}
	if (nodeType === "statement_block" || nodeType === "class_body") return "block";
	return undefined;
}

function fallbackConflictContext(lines: string[], conflictStartLine: number, conflictEndLine: number): ConflictContext {
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

function extractConflictContext(
	content: string,
	filePath: string,
	conflictStartLine: number,
	conflictEndLine: number,
): ConflictContext {
	const lines = splitLines(content);
	const language = detectLanguageFromPath(filePath);
	if (!language) return fallbackConflictContext(lines, conflictStartLine, conflictEndLine);

	const parser = getParserForLanguage(language);
	if (!parser) return fallbackConflictContext(lines, conflictStartLine, conflictEndLine);

	try {
		const tree = parser.parse(content);
		const endLineIndex = Math.max(0, conflictEndLine - 1);
		const endColumn = lines[endLineIndex]?.length ?? 0;
		let node = tree.rootNode.descendantForPosition(
			{ row: Math.max(0, conflictStartLine - 1), column: 0 },
			{ row: endLineIndex, column: endColumn },
		);

		while (node) {
			const scopeType = mapNodeTypeToScopeType(node.type);
			if (scopeType) {
				const scopeStartLine = node.startPosition.row + 1;
				const scopeEndLine = Math.max(scopeStartLine, node.endPosition.row + 1);
				return {
					scopeType,
					scopeStartLine,
					scopeEndLine,
					conflictStartLine,
					conflictEndLine,
					snippet: lines.slice(scopeStartLine - 1, scopeEndLine).join("\n"),
				};
			}
			node = node.parent!;
		}
	} catch {
		return fallbackConflictContext(lines, conflictStartLine, conflictEndLine);
	}

	return fallbackConflictContext(lines, conflictStartLine, conflictEndLine);
}

async function buildPayload(cwd: string, target: string | undefined): Promise<ConflictPayload | { error: string }> {
	const resolved = resolveTargetFiles(cwd, target);
	if (resolved.error) return { error: resolved.error };

	const payload: ConflictPayload = {
		cwd,
		target,
		git: collectRepoGitMetadata(cwd),
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
			context: extractConflictContext(content, filePath, hunk.startLine, hunk.endLine),
		}));

		payload.files.push({
			filePath: relative(cwd, filePath).replace(/\\/g, "/") || filePath,
			conflictCount: conflicts.length,
			git: collectConflictFileGitMetadata(payload.git, filePath),
			conflicts,
		});
		payload.totalConflicts += conflicts.length;
	}

	payload.filesWithConflicts = payload.files.length;
	return payload;
}

export default function openresolve(pi: ExtensionAPI) {
	pi.registerMessageRenderer("conflicts_found", (message, options, theme) => {
		const { expanded } = options;
		let text = theme.fg("accent", "⚔l ");
		text += message.content;

		if (expanded && message.details) {
			const d = message.details as { filesWithConflicts: number; totalConflicts: number; files: Array<{ filePath: string; conflictCount: number; git?: { oursAuthors?: string[]; theirsAuthors?: string[] } }> };
			for (const f of d.files) {
				const authors = f.git
					? [...(f.git.oursAuthors ?? []), ...(f.git.theirsAuthors ?? [])].filter(Boolean).join(", ") || "unknown"
					: "no git info";
				text += "\n" + theme.fg("dim", `  ${f.filePath}: ${f.conflictCount} conflict(s), authors: ${authors}`);
			}
		}

		return new (require("@mariozechner/pi-tui").Text)(text, 0, 0);
	});

	pi.registerCommand("resolve-conflict", {
		description: "Find JS/TS/Python/Go/Rust merge conflicts and return structured JSON context",
		handler: async (args, ctx): Promise<void> => {
			const target = normalizeTarget(args);
			const payloadOrError = await buildPayload(ctx.cwd, target);
			if ("error" in payloadOrError) {
				ctx.ui.notify(payloadOrError.error, "error");
				return;
			}

			ctx.ui.notify(
				`found ${payloadOrError.totalConflicts} conflict(s)`,
				"info",
			);

			// Send message to trigger agent action
			pi.sendMessage(
				{
				    customType: "conflicts_found",
				    content: `Found ${payloadOrError.totalConflicts} merge conflict(s) in ${payloadOrError.filesWithConflicts} file(s)`,
				    display: true,
				    details: payloadOrError,
				},
				{ triggerTurn: true },
			);

			return;
		},
	});
}
