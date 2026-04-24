// st track — Register branches in the stack.

import * as git from '../git.mjs';

export function track(flags) {
  if (flags.list) {
    listTracked();
    return;
  }

  const current = git.currentBranch();
  if (!current) throw new Error('Not on a branch (detached HEAD).');

  const defBranch = git.defaultBranch();
  if (current === defBranch) {
    throw new Error(`Cannot track the default branch (${defBranch}).`);
  }

  if (flags.parent === true) {
    throw new Error('--parent requires a value, e.g. --parent=main');
  }
  const parent = flags.parent || detectParent(current);

  // Validate parent chain reaches default branch
  if (!validateParent(parent)) {
    throw new Error(
      `Cannot track: parent "${parent}" is not tracked and does not reach ${defBranch}.\n` +
      `Either track "${parent}" first, or use --parent to specify a valid parent.`
    );
  }

  git.setTrackedParent(current, parent);
  console.log(`\x1b[32m✓\x1b[0m Tracking \x1b[1m${current}\x1b[0m → \x1b[1m${parent}\x1b[0m`);
}

export function untrack() {
  const current = git.currentBranch();
  if (!current) throw new Error('Not on a branch (detached HEAD).');

  const parent = git.getTrackedParent(current);
  if (!parent) {
    console.log(`\x1b[90m·\x1b[0m ${current} is not tracked`);
    return;
  }

  git.unsetTrackedParent(current);
  console.log(`\x1b[32m✓\x1b[0m Untracked \x1b[1m${current}\x1b[0m`);
}

function listTracked() {
  const tracked = git.listTrackedBranches();
  const defBranch = git.defaultBranch();
  const current = git.currentBranch();

  if (tracked.length === 0) {
    console.log('No tracked branches.');
    return;
  }

  console.log('\x1b[1mTracked branches:\x1b[0m\n');
  for (const { branch, parent } of tracked) {
    const marker = branch === current ? ' \x1b[36m◀\x1b[0m' : '';
    console.log(`  \x1b[1m${branch}\x1b[0m → ${parent}${marker}`);
  }
}

/**
 * Detect the parent for the current branch.
 * Finds the closest tracked ancestor or the default branch.
 */
function detectParent(branch) {
  const defBranch = git.defaultBranch();
  const tracked = git.listTrackedBranches();

  // Check tracked branches that are ancestors of the current branch
  let best = null;
  let bestDistance = Infinity;

  for (const { branch: trackedBranch } of tracked) {
    const mb = git.mergeBase(trackedBranch, branch);
    const sha = git.localSha(trackedBranch);
    if (mb && sha && mb === sha) {
      const distance = git.commitDistance(sha, branch);
      if (distance < bestDistance) {
        best = trackedBranch;
        bestDistance = distance;
      }
    }
  }

  return best || defBranch;
}

/**
 * Validate that a parent is either the default branch or a tracked branch
 * whose chain reaches the default branch.
 */
function validateParent(parent) {
  const defBranch = git.defaultBranch();
  if (parent === defBranch) return true;

  let b = parent;
  const visited = new Set();
  while (b) {
    if (visited.has(b)) return false; // cycle protection
    visited.add(b);
    const p = git.getTrackedParent(b);
    if (!p) return false;  // chain broken
    if (p === defBranch) return true;
    b = p;
  }
  return false;
}
