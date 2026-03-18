// st restack — Locally rebase stack branches onto their parents.

import * as git from '../git.mjs';
import { buildStackTree, findStackFor, walkDFS, printTree } from '../stack.mjs';

export async function restack(flags) {
  const dryRun = flags['dry-run'];

  if (!dryRun && !git.isClean()) {
    throw new Error('Uncommitted changes detected. Commit or stash before running st restack.');
  }

  const current = git.currentBranch();
  if (!current) {
    throw new Error('Not on a branch (detached HEAD).');
  }

  console.log('Fetching origin...');
  if (!dryRun) git.fetch();

  const prs = git.ghPrList();
  const { roots, nodes } = buildStackTree(prs);
  const stack = findStackFor(current, roots, nodes);

  if (!stack) {
    throw new Error(`Branch "${current}" is not part of any open PR stack.`);
  }

  // Pre-compute all merge-bases before any rebasing
  const mergeBases = new Map();
  walkDFS(stack, (node, parent) => {
    if (!parent) return;
    const mb = git.mergeBase(`origin/${parent.branch}`, `origin/${node.branch}`);
    if (mb) mergeBases.set(node.branch, mb);
  });

  // DFS rebase: parent before children
  const results = [];
  const originalBranch = current;

  walkDFS(stack, (node, parent) => {
    if (!parent) return; // skip root

    const mb = mergeBases.get(node.branch);
    if (!mb) {
      results.push({ branch: node.branch, pr: node.pr, status: 'no-merge-base' });
      return;
    }

    const parentRef = `origin/${parent.branch}`;
    const remoteChild = git.remoteSha(node.branch);
    const parentSha = git.remoteSha(parent.branch);

    // Check if restack is needed
    if (remoteChild && mb === parentSha) {
      results.push({ branch: node.branch, pr: node.pr, status: 'up-to-date' });
      return;
    }

    if (dryRun) {
      results.push({ branch: node.branch, pr: node.pr, status: 'would-restack', parent: parent.branch });
      return;
    }

    // Ensure local branch exists
    git.ensureLocalBranch(node.branch);

    const r = git.rebaseOnto(parentRef, mb, node.branch);
    if (r.ok) {
      git.pushForce(node.branch);
      results.push({ branch: node.branch, pr: node.pr, status: 'restacked', parent: parent.branch });
    } else {
      results.push({ branch: node.branch, pr: node.pr, status: 'conflict', parent: parent.branch, error: r.error });
    }
  });

  // Restore original branch
  if (!dryRun) {
    try { git.checkout(originalBranch); } catch {}
  }

  // Print results
  console.log('');
  const icon = {
    'restacked': '\x1b[32m✓\x1b[0m',
    'would-restack': '\x1b[33m~\x1b[0m',
    'up-to-date': '\x1b[90m·\x1b[0m',
    'conflict': '\x1b[31m✗\x1b[0m',
    'no-merge-base': '\x1b[31m?\x1b[0m',
  };

  for (const r of results) {
    const i = icon[r.status] || ' ';
    const parent = r.parent ? ` \x1b[90m← ${r.parent}\x1b[0m` : '';
    console.log(`  ${i} \x1b[1m${r.branch}\x1b[0m \x1b[90m#${r.pr}\x1b[0m${parent}`);
  }

  const restacked = results.filter(r => r.status === 'restacked').length;
  const conflicts = results.filter(r => r.status === 'conflict');

  if (restacked) {
    console.log(`\nRestacked ${restacked} branch(es).`);
  }

  if (conflicts.length) {
    console.log('\n\x1b[31mConflicts:\x1b[0m');
    for (const c of conflicts) {
      console.log(`\n  # ${c.branch} (PR #${c.pr})`);
      console.log(`  git rebase --onto origin/${c.parent} $(git merge-base origin/${c.parent} origin/${c.branch}) ${c.branch}`);
      console.log(`  # resolve conflicts, then:`);
      console.log(`  git push --force-with-lease origin ${c.branch}`);
    }
    throw new Error('Restack had conflicts.');
  }

  // Show stack
  console.log('\n\x1b[1mStack:\x1b[0m');
  printTree(stack);
}
