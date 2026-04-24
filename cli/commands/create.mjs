// st create — Create a new branch and auto-track it.

import * as git from '../git.mjs';

export const spec = {
  name: 'create',
  summary: 'Create a new branch and auto-track it',
  usage: 'st create <branch-name> [--dry-run]',
  flags: {
    'dry-run': { description: 'Show what would be created without modifying branches' },
  },
};

export function create(flags) {
  const dryRun = flags['dry-run'];
  const name = flags._[0];
  if (!name) throw new Error('Usage: st create <branch-name>');

  const current = git.currentBranch();
  if (!current) throw new Error('Not on a branch (detached HEAD).');

  const defBranch = git.defaultBranch();

  if (current !== defBranch && !git.getTrackedParent(current)) {
    throw new Error(
      `Current branch "${current}" is not tracked. Track it first with: st track`
    );
  }

  if (dryRun) {
    console.log(`\x1b[33m~\x1b[0m Would create branch \x1b[1m${name}\x1b[0m tracking \x1b[1m${current}\x1b[0m`);
    return;
  }

  git.checkoutNew(name);
  git.setTrackedParent(name, current);
  console.log(`\x1b[32m✓\x1b[0m Created and tracking \x1b[1m${name}\x1b[0m → \x1b[1m${current}\x1b[0m`);
}
