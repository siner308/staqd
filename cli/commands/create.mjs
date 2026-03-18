// st create — Create a new branch and auto-track it.

import * as git from '../git.mjs';

export function create(flags) {
  const name = flags._[0];
  if (!name) throw new Error('Usage: st create <branch-name>');

  const current = git.currentBranch();
  if (!current) throw new Error('Not on a branch (detached HEAD).');

  const defBranch = git.defaultBranch();

  // Current branch must be default branch or tracked
  if (current !== defBranch && !git.getTrackedParent(current)) {
    throw new Error(
      `Current branch "${current}" is not tracked. Track it first with: st track`
    );
  }

  // Create and checkout new branch
  git.checkoutNew(name);

  // Auto-track with current branch as parent
  git.setTrackedParent(name, current);
  console.log(`\x1b[32m✓\x1b[0m Created and tracking \x1b[1m${name}\x1b[0m → \x1b[1m${current}\x1b[0m`);
}
