# staqd Development Guide

You are helping develop **staqd**, a stacked PR tool with two components: a GitHub Action and a local CLI (`st`).

## Context

Read the relevant files before making changes:

**Action** (`src/`):
- `src/command.js` — core command logic (~1050 lines)
- `src/guide.js` — stack guide comment bot
- `src/orphan.js` — orphan child PR handler
- `action.yml` — composite action entry point

**CLI** (`cli/`):
- `bin/st.mjs` — entry point, registered as `st` via `package.json` bin field
- `cli/index.mjs` — command dispatcher and flag parser
- `cli/git.mjs` — git and `gh` CLI wrappers (uses `execFileSync` with arg arrays for safety)
- `cli/stack.mjs` — stack tree discovery from `gh pr list`
- `cli/commands/` — one file per command: `sync.mjs`, `restack.mjs`, `submit.mjs`, `move.mjs`

**Docs**: `README.md`, `docs/llms-full.txt`, `docs/llms.txt`

## Architecture Constraints

### Action (`src/`)
- **Runtime**: GitHub Actions `actions/github-script@v7` — code receives `{ github, context, core, exec }` objects
- **API calls**: Use `github.rest.*` (Octokit REST). Do NOT use raw `fetch` or `node-fetch`.
- **Git operations**: Use `exec.exec()` and `exec.getExecOutput()` from `@actions/exec`. Do NOT use `child_process`.
- **Metadata**: Stored as `<!-- stack-rebase:{...} -->` HTML comments in PR body (with comment fallback).

### CLI (`cli/`)
- **Runtime**: Node.js ESM modules, invoked via `node bin/st.mjs <command>` or `npx staqd <command>`
- **Git/GitHub**: Uses `child_process.execFileSync` with argument arrays (not string interpolation — prevents shell injection). Uses `gh` CLI for GitHub API calls (not Octokit).
- **Flags**: All commands support `--dry-run`. Parse flags in `cli/index.mjs`.

### Shared
- **No external npm dependencies** at runtime. `devDependencies` (ESLint) are for development only.
- **No build step**: Plain JavaScript (ES2020+), changes are immediately effective.
- **Linting**: `pnpm run lint` runs ESLint with `eslint-plugin-security` rules. Run before committing.

## Key Patterns

1. **Rebase primitive**: `git rebase --onto <new_base> <skip_sha> <child_branch>` + `--force-with-lease` push
2. **Tree traversal**: DFS with `getStackMeta()` → `children` → recurse
3. **Pre-compute merge-bases**: Before any rebase in `merge-all`, compute all merge-bases while history is intact
4. **2-phase merge**: Pre-restack children onto parent HEAD → squash-merge → restack children onto main
5. **Retry pattern**: `tryMerge()` retries 30s × 20 for CI status checks
6. **Shell safety**: CLI uses `execFileSync` with argument arrays — never construct shell commands via string interpolation

## Testing

- **Linting**: `pnpm run lint` — must pass (ESLint with security rules)
- **Action**: Push to a branch and trigger via PR comments. Dogfood workflows in `.github/workflows/dogfood-*.yml`.
- **CLI**: `node bin/st.mjs <command>` locally. Requires `git` and `gh` CLI installed and authenticated.

## When making changes

- Keep functions within `src/command.js` unless a clear separation concern exists
- Always post user-facing error messages as PR comments with actionable fix instructions
- Include manual rebase commands in conflict reports
- Maintain idempotency — commands should be safe to retry
- Run `pnpm run lint` before committing
- Update `README.md`, `docs/llms-full.txt`, and `docs/llms.txt` if behavior changes (use `/sync-docs` to verify)
