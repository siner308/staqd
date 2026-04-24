// st track — Register branches in the stack.

import * as git from '../git.mjs';

export const trackSpec = {
  name: 'track',
  summary: 'Register current branch in the stack',
  usage: 'st track [--parent=<branch>] [--list] [--dry-run]',
  flags: {
    'parent': { description: 'Parent branch name (defaults to auto-detected ancestor)', requiresValue: true },
    'list': { description: 'List all tracked branches' },
    'dry-run': { description: 'Show what would be tracked without writing git config' },
  },
};

export const untrackSpec = {
  name: 'untrack',
  summary: 'Remove current branch from the stack',
  usage: 'st untrack [--dry-run]',
  flags: {
    'dry-run': { description: 'Show what would be untracked without writing git config' },
  },
};

export function track(flags) {
  if (flags.list) {
    listTracked();
    return;
  }

  const dryRun = flags['dry-run'];
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

  if (parent === current) {
    throw new Error(`Cannot track "${current}" onto itself.`);
  }

  // Include the pending edge (current -> parent) so a proposed assignment
  // that would close a cycle is caught. Without this, tracking C -> A when
  // A -> B -> C already exists would loop through config.
  if (!validateParent(parent, current)) {
    throw new Error(
      `Cannot track: parent "${parent}" is not tracked and does not reach ${defBranch}, ` +
      `or the chain contains a cycle.\n` +
      `Either track "${parent}" first, or use --parent to specify a valid parent.`
    );
  }

  if (dryRun) {
    console.log(`\x1b[33m~\x1b[0m Would track \x1b[1m${current}\x1b[0m → \x1b[1m${parent}\x1b[0m`);
    return;
  }

  git.setTrackedParent(current, parent);
  console.log(`\x1b[32m✓\x1b[0m Tracking \x1b[1m${current}\x1b[0m → \x1b[1m${parent}\x1b[0m`);
}

export function untrack(flags = {}) {
  const dryRun = flags['dry-run'];
  const current = git.currentBranch();
  if (!current) throw new Error('Not on a branch (detached HEAD).');

  const parent = git.getTrackedParent(current);
  if (!parent) {
    console.log(`\x1b[90m·\x1b[0m ${current} is not tracked`);
    return;
  }

  if (dryRun) {
    console.log(`\x1b[33m~\x1b[0m Would untrack \x1b[1m${current}\x1b[0m (current parent: ${parent})`);
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

// Detect the closest tracked ancestor of `branch`. A tracked branch T is a
// plausible parent if its merge-base with `branch` sits above the default
// branch's history — i.e. T and `branch` share private work, not just main.
// Among candidates, pick the one with the smallest commit distance.
//
// This is more forgiving than requiring T's tip SHA to equal the merge-base,
// which breaks whenever T advances (e.g. after st sync).
function detectParent(branch) {
  const defBranch = git.defaultBranch();
  const defSha = git.remoteSha(defBranch) || git.localSha(defBranch);
  const tracked = git.listTrackedBranches();

  let best = null;
  let bestDistance = Infinity;

  for (const { branch: trackedBranch } of tracked) {
    if (trackedBranch === branch) continue;
    const mb = git.mergeBase(trackedBranch, branch);
    if (!mb) continue;
    // Skip if the only shared history is the default branch — means T was
    // never an ancestor of `branch`.
    if (defSha && git.isAncestor(mb, defSha)) continue;
    const distance = git.commitDistance(mb, branch);
    if (distance < bestDistance) {
      best = trackedBranch;
      bestDistance = distance;
    }
  }

  return best || defBranch;
}

// Validate that assigning `child -> parent` would produce a chain that
// terminates at the default branch without forming a cycle.
function validateParent(parent, child) {
  const defBranch = git.defaultBranch();
  if (parent === defBranch) return true;

  const visited = new Set();
  if (child) visited.add(child); // reject cycles through the pending edge
  let b = parent;
  while (b) {
    if (visited.has(b)) return false;
    visited.add(b);
    const p = git.getTrackedParent(b);
    if (!p) return false;
    if (p === defBranch) return true;
    b = p;
  }
  return false;
}
