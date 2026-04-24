// st log — Visualize the tracked stack tree.

import * as git from '../git.mjs';

export const spec = {
  name: 'log',
  summary: 'Visualize the tracked stack tree',
  usage: 'st log',
  flags: {},
};

export function log() {
  const tracked = git.listTrackedBranches();
  const current = git.currentBranch();
  const defBranch = git.defaultBranch();

  if (tracked.length === 0) {
    console.log('No tracked branches. Use \x1b[1mst track\x1b[0m to start.');
    return;
  }

  // Build parent → children map
  const childrenOf = new Map();
  for (const { branch, parent } of tracked) {
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(branch);
  }

  // Print tree starting from default branch roots
  console.log(`\x1b[1m${defBranch}\x1b[0m`);
  const roots = childrenOf.get(defBranch) || [];
  for (let i = 0; i < roots.length; i++) {
    const isLast = i === roots.length - 1;
    printBranch(roots[i], '', isLast, childrenOf, current);
  }
}

function printBranch(branch, prefix, isLast, childrenOf, current) {
  const connector = isLast ? '└─ ' : '├─ ';
  const marker = branch === current ? ' \x1b[36m◀\x1b[0m' : '';
  console.log(`${prefix}${connector}\x1b[1m${branch}\x1b[0m${marker}`);

  const children = childrenOf.get(branch) || [];
  const childPrefix = prefix + (isLast ? '   ' : '│  ');
  for (let i = 0; i < children.length; i++) {
    const childIsLast = i === children.length - 1;
    printBranch(children[i], childPrefix, childIsLast, childrenOf, current);
  }
}
