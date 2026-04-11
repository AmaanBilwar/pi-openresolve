# pi-openresolve

`pi-openresolve` is a Pi Coding Agent extension that detects unresolved Git merge conflicts in source files and returns structured JSON context for each conflict.

It registers a `resolve-conflict` command that can scan a whole workspace, a specific directory, or a single supported file (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.py`, `.go`, `.rs`).

## Installation

**npm:**
```bash
pi install npm:pi-openresolve
```

**GitHub:**
```bash
pi install git:github.com/AmaanBilwar/pi-openresolve.git
```

## What it does

- Recursively scans supported source files while skipping `node_modules`, `.git`, and `dist`.
- Detects conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) and groups them into conflict hunks.
- Captures both sides of each conflict (`ours` and `theirs`) with exact line ranges.
- Extracts surrounding language-aware scope context using Tree-sitter parsers (JS, TS, TSX, Python, Go, Rust).
- Sends structured payload as message for downstream tooling/automation.

## Command

- Name: `/resolve-conflict`
- Description: `Find JS/TS/Python/Go/Rust merge conflicts and return structured JSON context`

### Arguments

- No args: scan from current working directory.
- Relative path (file or folder): scan only that target.
- `@path` is also accepted (leading `@` is stripped before resolving).

Examples:

```
resolve-conflict
resolve-conflict src
resolve-conflict src/app/main.ts
resolve-conflict @src
```

## Integration

When conflicts found:

- Sends a message with:
  - `customType`: `conflicts_found`
  - `content`: summary string
  - `details`: full scan payload
- Shows a UI notification summarizing scanned files and discovered conflicts.

## Source

Primary implementation: `extensions/openresolve.ts`

Test fixtures with intentional conflict markers: `fixtures/conflicts/`
