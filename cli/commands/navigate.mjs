// st up / st down — Navigate within the tracked stack.

import * as git from '../git.mjs';

export function up() {
  const current = git.currentBranch();
  if (!current) throw new Error('Not on a branch (detached HEAD).');

  const tracked = git.listTrackedBranches();
  const children = tracked.filter(t => t.parent === current);

  if (children.length === 0) {
    throw new Error('Already at top of stack (no children).');
  }

  // If multiple children, pick the first one
  const target = children[0].branch;
  if (children.length > 1) {
    console.log(`\x1b[33m!\x1b[0m Multiple children: ${children.map(c => c.branch).join(', ')}`);
    console.log(`  Checking out first: ${target}`);
  }

  git.checkout(target);
  console.log(`\x1b[32m✓\x1b[0m \x1b[1m${target}\x1b[0m`);
}

export function down() {
  const current = git.currentBranch();
  if (!current) throw new Error('Not on a branch (detached HEAD).');

  const parent = git.getTrackedParent(current);
  if (!parent) {
    throw new Error('Already at bottom of stack (not tracked or no parent).');
  }

  git.checkout(parent);
  console.log(`\x1b[32m✓\x1b[0m \x1b[1m${parent}\x1b[0m`);
}
