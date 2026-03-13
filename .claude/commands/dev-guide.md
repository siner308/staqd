# staqd Development Guide

You are helping develop **staqd**, a GitHub Actions-based stacked PR merge queue tool.

## Context

Read the following files to understand the current state:
- `src/command.js` — core command logic (~1050 lines)
- `src/guide.js` — stack guide comment bot
- `src/orphan.js` — orphan child PR handler
- `action.yml` — composite action entry point
- `README.md` — user-facing documentation

## Architecture Constraints

- **Runtime**: GitHub Actions `actions/github-script@v7` — code receives `{ github, context, core, exec }` objects
- **No npm**: No `package.json`, no external dependencies. Only GitHub Actions toolkit utilities.
- **No build step**: Plain JavaScript (ES2020+), changes to `src/*.js` are immediately effective.
- **API calls**: Use `github.rest.*` (Octokit REST). Do NOT use raw `fetch` or `node-fetch`.
- **Git operations**: Use `exec.exec()` and `exec.getExecOutput()` from `@actions/exec`. Do NOT use `child_process`.
- **Metadata**: Stored as `<!-- stack-rebase:{...} -->` HTML comments in PR body (with comment fallback).

## Key Patterns

1. **Rebase primitive**: `git rebase --onto <new_base> <skip_sha> <child_branch>` + `--force-with-lease` push
2. **Tree traversal**: DFS with `getStackMeta()` → `children` → recurse
3. **Pre-compute merge-bases**: Before any rebase in `merge-all`, compute all merge-bases while history is intact
4. **2-phase merge**: Pre-restack children onto parent HEAD → squash-merge → restack children onto main
5. **Retry pattern**: `tryMerge()` retries 30s × 20 for CI status checks

## Testing

No test framework exists. Changes are tested via:
1. Push to a branch and trigger via PR comments on a real repo
2. Dogfood workflows in `.github/workflows/dogfood-*.yml`
3. Manual verification of PR comments and branch states

## When making changes

- Keep functions within `src/command.js` unless a clear separation concern exists (like `guide.js` and `orphan.js`)
- Always post user-facing error messages as PR comments with actionable fix instructions
- Include manual rebase commands in conflict reports
- Maintain idempotency — commands should be safe to retry
- Update `README.md`, `docs/llms-full.txt`, and `docs/llms.txt` if behavior changes (use `/sync-docs` to verify)
