# Test staqd Changes

Guide for testing changes to staqd source code (both Action and CLI).

## Step 1: Lint

Run `pnpm run lint` first. Fix any errors before proceeding. Security warnings from `eslint-plugin-security` (like `detect-child-process`, `detect-non-literal-exec`) indicate potential shell injection — these must be addressed.

## Step 2: Pre-flight code review

### For Action changes (`src/`)

1. Verify:
   - All `github.rest.*` calls use correct Octokit REST API signatures
   - All `exec.exec()` / `exec.getExecOutput()` calls have proper error handling
   - PR comments include actionable information for the developer
   - No `require()` of external packages (only relative `./` imports allowed)

2. Trace the affected command path end-to-end:
   - `merge`: discover → preRestack → tryMerge → restackChildren → deleteBranch → post
   - `merge-all`: discover → computeMergeBases → preRestackTree → tryMerge root → mergeChildren (DFS) → post
   - `restack`: orphan check → discover → recursiveRestack (DFS) → post
   - `discover`: runDiscover (DFS) → updatePrMeta → post

### For CLI changes (`cli/`)

1. Verify:
   - All shell calls use `execFileSync` with argument arrays (never string interpolation with `execSync`)
   - `--dry-run` flag is respected (log the command but don't execute)
   - Error messages are clear and include recovery steps
   - No external npm runtime dependencies added

2. Trace the affected command:
   - `sync`: fetch → checkout main → pull → checkout original branch → rebase
   - `restack`: discover stack → rebase children onto updated parent → force-push
   - `submit`: create/update PR via `gh pr create`/`gh pr edit`
   - `move`: update base branch reference → rebase

## Step 3: Check edge cases

- No children (leaf PR)
- Single child (linear stack)
- Multiple children (tree/fan-out stack)
- Deleted/missing branches
- Conflict during rebase
- CI timeout during merge
- Dirty working tree (CLI only)
- No `gh` CLI authenticated (CLI only)

## Step 4: Manual test — Action

```bash
# 1. Create a test stack
git checkout main && git pull
git checkout -b test-parent && echo "parent" > test.txt && git add . && git commit -m "parent" && git push -u origin test-parent
git checkout -b test-child && echo "child" >> test.txt && git add . && git commit -m "child" && git push -u origin test-child

# 2. Create PRs
gh pr create --base main --head test-parent --title "test: parent"
gh pr create --base test-parent --head test-child --title "test: child"

# 3. Comment on parent PR to trigger commands
# st discover → st restack → st merge (or st merge-all --force)

# 4. Clean up after testing
git checkout main
git branch -D test-parent test-child 2>/dev/null
git push origin --delete test-parent test-child 2>/dev/null
```

## Step 5: Manual test — CLI

```bash
# Test each command with --dry-run first
node bin/st.mjs sync --dry-run
node bin/st.mjs restack --dry-run
node bin/st.mjs submit --dry-run
node bin/st.mjs move <target-branch> --dry-run

# Then run for real on a test stack
node bin/st.mjs sync
node bin/st.mjs restack
```

## What to verify

- [ ] `pnpm run lint` passes with no errors
- [ ] Bot reaction emojis appear (👀 → 🚀 or 😕) for Action commands
- [ ] Stack guide comment is posted/updated on PR open
- [ ] `st discover` correctly identifies tree structure
- [ ] `st restack` rebases children and reports status table
- [ ] `st merge` pre-restacks, merges, restacks children, deletes branch
- [ ] Conflict reports include manual fix commands
- [ ] Child PRs get notification comments after parent merge
- [ ] CLI `--dry-run` logs commands without executing
- [ ] CLI handles missing `gh` auth gracefully
