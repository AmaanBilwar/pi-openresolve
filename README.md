# pi-openresolve

`pi-openresolve` is a Pi Coding Agent extension that detects unresolved Git merge conflicts in TypeScript files and returns structured JSON context for each conflict.

It registers a `conflicts` command that can scan a whole workspace, a specific directory, or a single TypeScript file (`.ts`, `.tsx`, `.mts`, `.cts`).

## What it does

- Recursively scans TypeScript files while skipping `node_modules`, `.git`, and `dist`.
- Detects conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) and groups them into conflict hunks.
- Captures both sides of each conflict (`ours` and `theirs`) with exact line ranges.
- Extracts surrounding TypeScript scope context (function, method, class, interface, type, enum, namespace, or generic block).
- Sends a structured payload as `openresolve.conflicts` for downstream tooling/automation.

## Command

- Name: `/conflicts`
- Description: `Find TypeScript merge conflicts and return structured JSON context`

### Arguments

- No args: scan from current working directory.
- Relative path (file or folder): scan only that target.
- `@path` is also accepted (leading `@` is stripped before resolving).

Examples:

```txt
conflicts
conflicts src
conflicts src/app/main.ts
conflicts @src
```

## Output shape

The command emits JSON with high-level scan stats and detailed conflict entries per file.

```json
{
  "cwd": "...",
  "target": "src",
  "scannedFiles": 42,
  "filesWithConflicts": 3,
  "totalConflicts": 7,
  "files": [
    {
      "filePath": "src/example.ts",
      "conflictCount": 2,
      "conflicts": [
        {
          "hunk": {
            "startLine": 10,
            "endLine": 22,
            "oursStartLine": 11,
            "oursEndLine": 15,
            "theirsStartLine": 17,
            "theirsEndLine": 21,
            "ours": "...",
            "theirs": "...",
            "raw": "..."
          },
          "context": {
            "scopeType": "function",
            "scopeStartLine": 1,
            "scopeEndLine": 40,
            "conflictStartLine": 10,
            "conflictEndLine": 22,
            "snippet": "..."
          }
        }
      ]
    }
  ]
}
```

## Behavior notes

- Unsupported file extensions return an error message with supported extensions.
- Missing paths return `Path not found`.
- If no enclosing TypeScript block is detected, context falls back to a nearby window around the conflict.

## Integration details

When conflicts are found, the extension:

- Sends a message with:
  - `customType`: `openresolve.conflicts`
  - `content`: pretty-printed JSON payload
  - `details`: target + scan counts
- Shows a UI notification summarizing scanned files and discovered conflicts.

## Source

Primary implementation: `extensions/openresolve.ts`
