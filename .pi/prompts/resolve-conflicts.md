# Resolve Merge Conflicts

When you receive a message with `customType: "conflicts_found"`, the extension has detected merge conflicts in the codebase.

## Input Structure

The `details` object contains:

| Field | Description |
|-------|------------|
| `cwd` | Working directory |
| `git` | Repo metadata (branch, HEAD SHA, merge-base, etc.) |
| `files` | Array of files with conflicts |

### Per-File Data

Each file has:

| Field | Description |
|-------|------------|
| `filePath` | Relative path to file |
| `conflictCount` | Number of conflicts |
| `conflicts` | Array of hunk + context |
| `git` | Git metadata for file |

### Conflict Hunk

| Field | Description |
|-------|------------|
| `ours` | Your side content |
| `theirs` | Their side content |
| `oursLabel` / `theirsLabel` | Branch names from `<<<<<<<` / `>>>>>>>` markers |
| `startLine` / `endLine` | Line numbers |

### Git Metadata (if available)

| Field | Description |
|-------|------------|
| `oursAuthors` / `theirsAuthors` | Authors who changed this file on each branch |
| `oursCommits` / `theirsCommits` | Recent commits touching this file |
| `baseToOursDiff` / `baseToTheirsDiff` | Diff from merge-base |
| `oursToTheirsDiff` | Direct diff between sides |

## Your Task

For each conflict file:

1. Read the file content and identify conflicts
2. Use git metadata to understand who changed what:
   - Check `oursAuthors` / `theirsAuthors` for context
   - Review `baseToOursDiff` / `baseToTheirsDiff` to see changes
3. Decide resolution strategy:
   - Keep `ours` (your changes)
   - Keep `theirs` (incoming changes)
   - Keep both (merge)
   - Rewrite with new solution
4. Write resolved file content using the `bash` tool with `Write` command
5. Report what you did per file

## Output Format

Report per file:

```
Resolved: <filePath>
- <conflictCount> conflict(s)
- Strategy: <ours|theirs|both|manual>
- Authors: <relevant authors>
- Summary: <what you kept/changed>
```

Remove all `<<<<<<<`, `=======`, `>>>>>>>` conflict markers.
