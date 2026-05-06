// st move <parent> — Move current branch to a new parent.

import * as git from '../git.mjs';
import { buildStackTree, printTree } from '../stack.mjs';

export const spec = {
  name: 'move',
  summary: 'Move current branch to a new parent',
  usage: 'st move <parent-branch> [--dry-run]',
  flags: {
    'dry-run': { description: 'Show what would be rebased without modifying branches' },
  },
};

export async function move(flags) {
  const dryRun = flags['dry-run'];
  const newParent = flags._[0];

  if (!newParent) {
    throw new Error('Usage: st move <parent-branch>');
  }

  const current = git.currentBranch();
  if (!current) {
    throw new Error('Not on a branch (detached HEAD).');
  }

  if (current === newParent) {
    throw new Error('Cannot move a branch onto itself.');
  }

  const defBranch = git.defaultBranch();

  if (!git.getTrackedParent(current)) {
    throw new Error(
      `Branch "${current}" is not tracked. Run "st track" first to register it in the stack.`
    );
  }

  if (newParent !== defBranch && !git.getTrackedParent(newParent)) {
    throw new Error(
      `Parent "${newParent}" is not tracked. Run "st track" on that branch first ` +
      `(or use "${defBranch}" as the parent).`
    );
  }

  if (!dryRun && !git.isClean()) {
    throw new Error('Uncommitted changes detected. Commit or stash before running st move.');
  }

  console.log('Fetching origin...');
  if (!dryRun) git.fetch();

  // Verify new parent exists
  const parentSha = git.remoteSha(newParent) || git.localSha(newParent);
  if (!parentSha) {
    throw new Error(`Branch "${newParent}" not found.`);
  }
  const newParentRef = git.remoteSha(newParent) ? `origin/${newParent}` : newParent;

  // Find old parent (current base branch from PR)
  const prs = git.ghPrList();
  const myPr = prs.find(p => p.headRefName === current);

  if (!myPr) {
    throw new Error(`No open PR found for branch "${current}". Run "st submit" first.`);
  }

  const oldParent = myPr.baseRefName;
  const trackedParent = git.getTrackedParent(current);

  // Refuse to operate on drifted metadata. If PR base and tracked-parent
  // disagree, neither alone is a safe rebase boundary — force the user to
  // pick a side first. Without this guard, a metadata-only sync (only one of
  // the two changing) can leave the branch contents inconsistent with the
  // updated metadata.
  if (oldParent !== trackedParent) {
    throw new Error(
      `Inconsistent metadata for ${current}: ` +
      `PR #${myPr.number} base is "${oldParent}" but tracked-parent is "${trackedParent}". ` +
      `One of them was edited outside st move. Reconcile before retrying:\n` +
      `  Option A — align tracked to PR (if the branch is rebased onto "${oldParent}"):\n` +
      `    st track --parent=${oldParent}\n` +
      `  Option B — align PR to tracked (if the branch is rebased onto "${trackedParent}"):\n` +
      `    gh pr edit ${myPr.number} --base ${trackedParent}\n` +
      `Then re-run: st move ${newParent}`
    );
  }

  const currentParent = oldParent; // === trackedParent at this point

  if (currentParent === newParent) {
    console.log(`Already based on ${newParent}; nothing to do.`);
    return;
  }

  console.log(`Moving \x1b[1m${current}\x1b[0m: ${currentParent} → ${newParent}`);

  // Resolve the rebase boundary. Prefer the remote ref for the previous
  // parent, since local refs can be stale or accidentally fast-forwarded
  // (e.g. after `git pull` while on the parent). When the remote is gone
  // (squash-merged and pruned), recover the original head SHA from the
  // merged-PR record on GitHub. Bail otherwise — replaying with the wrong
  // boundary force-pushes corrupted history.
  let parentRef = git.remoteSha(currentParent) ? `origin/${currentParent}` : null;

  if (!parentRef) {
    const merged = git.ghPrListMergedForBranch(currentParent);
    // Refuse ambiguous recovery: if the head ref name has multiple merged
    // PRs, branch-name reuse may have associated the SHA with a different
    // PR than the actual previous parent.
    if (merged.known && merged.prs.length === 1) {
      const headRefOid = merged.prs[0].headRefOid;
      // Only trust the SHA if it's locally reachable AND is actually an
      // ancestor of current. Without the ancestry check, a stale object
      // (loose pre-GC, reflog) can resolve as "exists" while having no
      // relationship to current's history — picking it as the rebase
      // boundary would force-push wrong content.
      if (headRefOid && git.localSha(headRefOid) && git.isAncestor(headRefOid, current)) {
        parentRef = headRefOid;
      }
    }
  }

  if (!parentRef) {
    throw new Error(
      `Previous parent "${currentParent}" is no longer reachable in origin and ` +
      `cannot be recovered from merged-PR history. ` +
      `Cannot determine which commits to drop from ${current}.\n` +
      `Recover manually:\n` +
      `  1. Find the previous parent's tip SHA (e.g. \`gh pr view <pr-number> --json headRefOid\`)\n` +
      `  2. git rebase --onto ${newParentRef} <previous-parent-tip> ${current}\n` +
      `  3. git push --force-with-lease origin ${current}\n` +
      `  4. gh pr edit ${myPr.number} --base ${newParent}\n` +
      `  5. git config --local branch.${current}.staqd-parent ${newParent}`
    );
  }

  const mb = git.mergeBase(parentRef, current);
  if (!mb) {
    throw new Error(`Cannot find merge-base between ${parentRef} and ${current}.`);
  }

  if (dryRun) {
    console.log(`  \x1b[33m~\x1b[0m Would rebase --onto ${newParentRef} ${mb.slice(0, 7)} ${current}`);
    console.log(`  \x1b[33m~\x1b[0m Would update PR #${myPr.number} base: ${currentParent} → ${newParent}`);
    console.log(`  \x1b[33m~\x1b[0m Would update tracked parent: ${currentParent} → ${newParent}`);
    return;
  }

  const r = git.rebaseOnto(newParentRef, mb, current);
  if (!r.ok) {
    console.error('\n\x1b[31mConflict during rebase.\x1b[0m Resolve manually:');
    console.log(`  git rebase --onto ${newParentRef} ${mb.slice(0, 7)} ${current}`);
    console.log('  # resolve conflicts, then:');
    console.log(`  git push --force-with-lease origin ${current}`);
    console.log(`  gh pr edit ${myPr.number} --base ${newParent}`);
    console.log(`  git config --local branch.${current}.staqd-parent ${newParent}`);
    throw new Error('Rebase had conflicts.');
  }
  git.pushForce(current);
  console.log(`  \x1b[32m✓\x1b[0m Rebased and pushed`);

  // Update tracked-parent BEFORE the fallible PR edit. If ghPrEditBase later
  // throws (network/auth), the next run sees tracked=newParent vs PR base=
  // oldParent — the drift gate fires with a clear reconciliation menu instead
  // of silently treating the stale metadata as authoritative.
  git.setTrackedParent(current, newParent);
  console.log(`  \x1b[32m✓\x1b[0m Tracked parent updated: ${currentParent} → ${newParent}`);

  git.ghPrEditBase(myPr.number, newParent);
  console.log(`  \x1b[32m✓\x1b[0m PR #${myPr.number} base updated to ${newParent}`);

  // Trigger discover on the new parent's PR (if any) so the action-side
  // metadata catches up too.
  const rootPr = prs.find(p => p.baseRefName === defBranch && p.headRefName === newParent)
    || prs.find(p => p.headRefName === newParent);

  if (rootPr) {
    console.log(`  Triggering discover on #${rootPr.number}...`);
    git.ghPrComment(rootPr.number, 'st discover');
  }

  // Show updated tree
  const freshPrs = git.ghPrList();
  const { roots: freshRoots } = buildStackTree(freshPrs);
  if (freshRoots.length) {
    console.log('\n\x1b[1mStack:\x1b[0m');
    for (const root of freshRoots) {
      printTree(root);
    }
  }
}
