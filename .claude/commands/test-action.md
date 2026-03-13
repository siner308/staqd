# Test staqd Action Changes

Guide for testing changes to staqd source code.

## Pre-flight checks

1. Read the changed files and verify:
   - All `github.rest.*` calls use correct Octokit REST API signatures
   - All `exec.exec()` / `exec.getExecOutput()` calls have proper error handling
   - PR comments include actionable information for the developer
   - No `require()` of external packages (only relative `./` imports allowed)

2. Trace the affected command path end-to-end:
   - For `merge`: discover → preRestack → tryMerge → restackChildren → deleteBranch → post
   - For `merge-all`: discover → computeMergeBases → preRestackTree → tryMerge root → mergeChildren (DFS) → post
   - For `restack`: orphan check → discover → recursiveRestack (DFS) → post
   - For `discover`: runDiscover (DFS) → updatePrMeta → post

3. Check edge cases:
   - No children (leaf PR)
   - Single child (linear stack)
   - Multiple children (tree/fan-out stack)
   - Deleted/missing branches
   - Conflict during rebase
   - CI timeout during merge

## Manual test procedure

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

## What to verify

- [ ] Bot reaction emojis appear (👀 → 🚀 or 😕)
- [ ] Stack guide comment is posted/updated on PR open
- [ ] `st discover` correctly identifies tree structure
- [ ] `st restack` rebases children and reports status table
- [ ] `st merge` pre-restacks, merges, restacks children, deletes branch
- [ ] Conflict reports include manual fix commands
- [ ] Child PRs get notification comments after parent merge
