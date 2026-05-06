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

  // Rebase whenever the PR base changes — we need to drop oldParent's
  // contribution and replay onto newParent. Skipping the rebase based solely
  // on `isAncestor(newParent, current)` is wrong: in `main → B → C`, moving C
  // to main would leave B's commits inside C's PR diff against main.
  const trackedNeedsUpdate = trackedParent !== newParent;
  const prBaseNeedsUpdate = oldParent !== newParent;
  const needsRebase = prBaseNeedsUpdate;

  if (!needsRebase && !trackedNeedsUpdate) {
    console.log(`Already based on ${newParent}; metadata already matches.`);
    return;
  }

  console.log(`Moving \x1b[1m${current}\x1b[0m → ${newParent}`);

  // Step 1: rebase if needed.
  if (needsRebase) {
    // Need oldParent's tip to know which commits belong to oldParent vs current.
    // If both remote and local refs are gone (e.g. squash-merged and pruned),
    // we cannot derive a safe rebase boundary — bail rather than silently
    // replaying already-merged commits onto newParent and force-pushing.
    const oldParentRef = git.remoteSha(oldParent)
      ? `origin/${oldParent}`
      : (git.localSha(oldParent) ? oldParent : null);

    if (!oldParentRef) {
      throw new Error(
        `Old parent "${oldParent}" is no longer reachable in origin or locally. ` +
        `Cannot determine which commits to drop from ${current} without it.\n` +
        `Recover manually:\n` +
        `  1. Find the old parent's tip SHA (e.g. \`gh pr view <old-pr> --json headRefOid\`)\n` +
        `  2. git rebase --onto ${newParentRef} <old-parent-tip> ${current}\n` +
        `  3. git push --force-with-lease origin ${current}\n` +
        `  4. gh pr edit ${myPr.number} --base ${newParent}\n` +
        `  5. git config --local branch.${current}.staqd-parent ${newParent}`
      );
    }

    const mb = git.mergeBase(oldParentRef, current);
    if (!mb) {
      throw new Error(`Cannot find merge-base between ${oldParentRef} and ${current}.`);
    }

    if (dryRun) {
      console.log(`  \x1b[33m~\x1b[0m Would rebase --onto ${newParentRef} ${mb.slice(0, 7)} ${current}`);
    } else {
      const r = git.rebaseOnto(newParentRef, mb, current);
      if (!r.ok) {
        console.error('\n\x1b[31mConflict during rebase.\x1b[0m Resolve manually:');
        console.log(`  git rebase --onto ${newParentRef} ${mb.slice(0, 7)} ${current}`);
        console.log('  # resolve conflicts, then:');
        console.log(`  git push --force-with-lease origin ${current}`);
        if (prBaseNeedsUpdate) {
          console.log(`  gh pr edit ${myPr.number} --base ${newParent}`);
        }
        if (trackedNeedsUpdate) {
          console.log(`  git config --local branch.${current}.staqd-parent ${newParent}`);
        }
        throw new Error('Rebase had conflicts.');
      }
      git.pushForce(current);
      console.log(`  \x1b[32m✓\x1b[0m Rebased and pushed`);
    }
  } else {
    console.log(`  \x1b[90m·\x1b[0m ${current} already contains ${newParent}; skipping rebase`);
  }

  // Step 2: reconcile PR base unconditionally.
  if (prBaseNeedsUpdate) {
    if (dryRun) {
      console.log(`  \x1b[33m~\x1b[0m Would update PR #${myPr.number} base: ${oldParent} → ${newParent}`);
    } else {
      git.ghPrEditBase(myPr.number, newParent);
      console.log(`  \x1b[32m✓\x1b[0m PR #${myPr.number} base updated to ${newParent}`);
    }
  }

  // Step 3: reconcile tracked-parent metadata unconditionally.
  if (trackedNeedsUpdate) {
    if (dryRun) {
      console.log(`  \x1b[33m~\x1b[0m Would update tracked parent: ${trackedParent || '<none>'} → ${newParent}`);
    } else {
      git.setTrackedParent(current, newParent);
      console.log(`  \x1b[32m✓\x1b[0m Tracked parent updated: ${trackedParent || '<none>'} → ${newParent}`);
    }
  }

  if (dryRun) return;

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
