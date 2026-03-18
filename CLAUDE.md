# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Staqd (`/stakt/`) is a stacked PR tool with two components:
1. **GitHub Action** — Composite action for managing stacked PRs via PR comment commands (`st merge`, `st restack`, `st discover`, `st merge-all`, `st help`)
2. **CLI** (`st`) — Local CLI for syncing, restacking, submitting, and moving branches (`st sync`, `st restack`, `st submit`, `st move`)

Written in plain JavaScript (ESM), no external npm dependencies. Distributed via `npx staqd` or `npm i -g staqd`.

## Development

No build step, no test framework. Changes to `src/*.js` and `cli/*.mjs` are effective immediately.

- **Action code** (`src/`): Runs inside GitHub Actions using `actions/github-script@v7` which provides `github` (Octokit), `context`, `core`, and `exec` objects. Test by pushing to a branch and triggering via PR comments, or use the dogfood workflows in `.github/workflows/dogfood-*.yml`.
- **CLI code** (`cli/`): ESM modules using `child_process.execSync` to call `git` and `gh` CLI. Test locally with `node bin/st.mjs <command>`. Requires `git` and `gh` CLI installed and authenticated.

## Architecture

### Entry Point
- `action.yml` — Composite action definition. Dispatches between three code paths based on event type:
  - `pull_request` events → `src/guide.js` (post/update stack guide) + `src/orphan.js` (handle merged parent)
  - `issue_comment` events → parses `st <command>` from comment body → `src/command.js`

### Source Files (all in `src/`)
- **`command.js`** (~1050 lines) — Core logic for all five commands. Contains the rebase engine, merge orchestration, tree traversal, metadata management, and GitHub API interactions.
- **`guide.js`** (~60 lines) — Posts/updates a bot comment on PRs listing available commands and current stack children.
- **`orphan.js`** (~90 lines) — When a parent PR is merged via GitHub UI (not via `st merge`), retargets children to the parent's base branch and triggers auto-restack.

### Metadata Storage
Stack relationships are stored as HTML comments in PR bodies:
```html
<!-- stack-rebase:{"children":[{"branch":"feature-b","pr":42}]} -->
```
Falls back to searching issue comments if not found in PR body. No external database.

### Key Algorithms in `command.js`
- **`merge-all` uses 3 phases**: (0) pre-compute merge-bases for entire tree, (1) pre-restack tree recursively, (2) sequential DFS merge + restack
- **`merge` uses 2 phases**: pre-merge rebase (to prevent file duplication in squash merge), then post-merge rebase of children onto main
- **`doRestack()`**: Core rebase operation using `git rebase --onto <new_base> <skip_sha> <branch>` with `--force-with-lease` push
- **`tryMerge()`**: Squash-merge with retry loop (30s × 20 attempts) waiting for CI status checks

### Workflow Split
Two separate workflows handle different GitHub events:
- `staqd-auto-detect.yml` — `pull_request` events (opened, edited, closed)
- `staqd-command.yml` — `issue_comment` events with concurrency control per base branch (`concurrency: staqd-${{ base-ref }}`)

### Authentication
Supports both `GITHUB_TOKEN` and GitHub App tokens (via `app-id` + `app-private-key` inputs). App tokens are needed to trigger CI workflows after force-push.

### CLI (`cli/`)
- **`bin/st.mjs`** — Entry point, registered as `st` via `package.json` `bin` field
- **`cli/index.mjs`** — Command dispatcher and flag parser
- **`cli/git.mjs`** — Git and `gh` CLI wrappers (no Octokit, uses `child_process.execSync`)
- **`cli/stack.mjs`** — Stack tree discovery from PR list (`gh pr list` → build tree from base/head relationships)
- **`cli/commands/`** — One file per command: `sync.mjs`, `restack.mjs`, `submit.mjs`, `move.mjs`

## Code Conventions

- Plain JavaScript (ES2020+), no TypeScript, no transpilation
- No external npm dependencies
- **Action** (`src/`): `exec.exec()` for git, `github.rest.*` (Octokit) for API, error messages posted as PR comments
- **CLI** (`cli/`): ESM modules, `child_process.execSync` for `git`/`gh` CLI, colored terminal output with ANSI codes
- Recursive tree operations use DFS traversal
- `--dry-run` flag supported on all CLI commands
