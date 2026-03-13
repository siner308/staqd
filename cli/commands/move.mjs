// st move <parent> — Move current branch to a new parent.

import * as git from '../git.mjs';
import { buildStackTree, printTree } from '../stack.mjs';

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

  // Find old parent (current base branch from PR)
  const prs = git.ghPrList();
  const myPr = prs.find(p => p.headRefName === current);

  if (!myPr) {
    throw new Error(`No open PR found for branch "${current}". Run "st submit" first.`);
  }

  const oldParent = myPr.baseRefName;

  if (oldParent === newParent) {
    console.log(`Already based on ${newParent}.`);
    return;
  }

  console.log(`Moving \x1b[1m${current}\x1b[0m: ${oldParent} → ${newParent}`);

  // Compute merge-base with old parent
  const mb = git.mergeBase(`origin/${oldParent}`, current);
  if (!mb) {
    throw new Error(`Cannot find merge-base between origin/${oldParent} and ${current}.`);
  }

  const newParentRef = git.remoteSha(newParent) ? `origin/${newParent}` : newParent;

  if (dryRun) {
    console.log(`  \x1b[33m~\x1b[0m Would rebase --onto ${newParentRef} ${mb.slice(0, 7)} ${current}`);
    console.log(`  \x1b[33m~\x1b[0m Would update PR #${myPr.number} base to ${newParent}`);
    return;
  }

  // Rebase onto new parent
  const r = git.rebaseOnto(newParentRef, mb, current);
  if (!r.ok) {
    console.error('\n\x1b[31mConflict during rebase.\x1b[0m Resolve manually:');
    console.log(`  git rebase --onto ${newParentRef} ${mb.slice(0, 7)} ${current}`);
    console.log('  # resolve conflicts, then:');
    console.log(`  git push --force-with-lease origin ${current}`);
    console.log(`  gh pr edit ${myPr.number} --base ${newParent}`);
    throw new Error('Rebase had conflicts.');
  }

  // Push and update PR
  git.pushForce(current);
  git.ghPrEditBase(myPr.number, newParent);

  console.log(`  \x1b[32m✓\x1b[0m Rebased and pushed`);
  console.log(`  \x1b[32m✓\x1b[0m PR #${myPr.number} base updated to ${newParent}`);

  // Trigger discover to update metadata
  const { roots } = buildStackTree(git.ghPrList());
  const defBranch = git.defaultBranch();

  // Find root PR of the stack to trigger discover
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
