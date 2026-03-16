# sync-docs

Review the current state of all source files and documentation, then fix any gaps or outdated content.

## Scope

Compare the actual implementation against what the docs describe:

**Source files to check**:
- `src/command.js` — Action commands (`st merge`, `st merge-all`, `st restack`, `st discover`, `st help`)
- `src/guide.js` — stack guide bot behavior
- `src/orphan.js` — orphan child PR handling
- `cli/index.mjs` — CLI command dispatcher and flags
- `cli/commands/*.mjs` — CLI commands (`st sync`, `st restack`, `st submit`, `st move`)

**Documentation files to update**:
- `README.md` — user-facing docs (Action + CLI usage)
- `docs/llms-full.txt` — detailed LLM-readable docs
- `docs/llms.txt` — concise LLM-readable docs
- `CLAUDE.md` — developer instructions for Claude Code

## What to check

1. **Action command behavior** — Does each command's description match what the code actually does?
   - `st merge`: squash-merge, branch deletion, restack children, 2-phase pre-merge rebase
   - `st merge-all`: DFS order, branch deletion per PR, merge order table, failure guidance
   - `st restack`: rebase children, conflict output, recursive by default
   - `st discover`: tree output format
   - `st help`: current output format

2. **CLI command behavior** — Are CLI commands accurately documented?
   - `st sync`: fetch + rebase onto main
   - `st restack`: discover stack + rebase children
   - `st submit`: create/update PRs
   - `st move`: change base branch
   - `--dry-run` flag behavior

3. **Output examples** — Are any hardcoded output examples in the docs out of sync with the actual output format?

4. **New behaviors not yet documented** — Any code paths that have no corresponding documentation?

5. **Removed or changed behaviors** — Any docs that describe behavior that no longer exists?

6. **CLAUDE.md accuracy** — Does it correctly describe the architecture, file layout, and conventions?

## What to produce

Output a clear report with:

- **Up to date**: items that are correctly documented
- **Needs update**: specific diffs — what the doc says vs what the code does, with file:line references
- **Missing**: behaviors in code with no documentation

Then apply all necessary updates to the documentation files, keeping the writing style consistent with the existing prose in each file.
