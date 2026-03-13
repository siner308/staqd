// st submit — Push branches and create/update PRs.

import * as git from '../git.mjs';
import { buildStackTree, findStackFor, collectDFS, printTree } from '../stack.mjs';

export async function submit(flags) {
  const dryRun = flags['dry-run'];
  const current = git.currentBranch();

  if (!current) {
    throw new Error('Not on a branch (detached HEAD).');
  }

  // Push current branch first
  console.log(`Pushing ${current}...`);
  if (!dryRun) {
    git.exec(`git push -u origin ${current}`);
  }

  // Discover stack from PRs
  const prs = git.ghPrList();
  const { roots, nodes } = buildStackTree(prs);

  // Check if current branch already has a PR
  const existingPr = prs.find(p => p.headRefName === current);

  if (!existingPr) {
    // Need to create a PR — figure out the base branch
    const base = detectBase(current, prs);

    console.log(`Creating PR: ${current} → ${base}`);
    if (!dryRun) {
      // Generate title from branch name
      const title = branchToTitle(current);
      const url = git.ghPrCreate(current, base, title);
      console.log(`  \x1b[32m✓\x1b[0m Created: ${url}`);
    } else {
      console.log(`  \x1b[33m~\x1b[0m Would create PR: ${current} → ${base}`);
    }
  } else {
    console.log(`  \x1b[90m·\x1b[0m PR #${existingPr.number} already exists`);
  }

  // Re-fetch PR list after potential creation
  const freshPrs = dryRun ? prs : git.ghPrList();
  const { roots: freshRoots, nodes: freshNodes } = buildStackTree(freshPrs);

  // Push all branches in the current stack
  const stack = findStackFor(current, freshRoots, freshNodes);
  if (stack) {
    const allNodes = collectDFS(stack);
    const results = [];

    for (const node of allNodes) {
      const local = git.localSha(node.branch);
      const remote = git.remoteSha(node.branch);

      if (!local) {
        results.push({ branch: node.branch, pr: node.pr, status: 'no-local' });
        continue;
      }

      if (local === remote) {
        results.push({ branch: node.branch, pr: node.pr, status: 'up-to-date' });
        continue;
      }

      if (dryRun) {
        results.push({ branch: node.branch, pr: node.pr, status: 'would-push' });
        continue;
      }

      try {
        git.exec(`git push --force-with-lease origin ${node.branch}`);
        results.push({ branch: node.branch, pr: node.pr, status: 'pushed' });
      } catch {
        results.push({ branch: node.branch, pr: node.pr, status: 'push-failed' });
      }
    }

    // Update base branches if mismatched
    for (const node of allNodes) {
      const parentNode = findParent(node, stack);
      if (!parentNode) continue;

      const pr = freshPrs.find(p => p.number === node.pr);
      if (pr && pr.baseRefName !== parentNode.branch) {
        console.log(`  Updating #${node.pr} base: ${pr.baseRefName} → ${parentNode.branch}`);
        if (!dryRun) {
          git.ghPrEditBase(node.pr, parentNode.branch);
        }
      }
    }

    // Trigger discover on root PR
    if (!dryRun) {
      console.log(`\nTriggering discover on #${stack.pr}...`);
      git.ghPrComment(stack.pr, 'st discover');
    }

    // Print results
    console.log('');
    const icon = {
      'pushed': '\x1b[32m✓\x1b[0m',
      'would-push': '\x1b[33m~\x1b[0m',
      'up-to-date': '\x1b[90m·\x1b[0m',
      'push-failed': '\x1b[31m✗\x1b[0m',
      'no-local': '\x1b[90m-\x1b[0m',
    };

    for (const r of results) {
      const i = icon[r.status] || ' ';
      console.log(`  ${i} \x1b[1m${r.branch}\x1b[0m \x1b[90m#${r.pr}\x1b[0m ${r.status}`);
    }

    console.log('\n\x1b[1mStack:\x1b[0m');
    printTree(stack);
  }
}

/**
 * Detect the base branch for a new PR.
 * If any open PR's head is an ancestor of the current branch, use that as base.
 * Otherwise, use the default branch.
 */
function detectBase(branch, prs) {
  const defBranch = git.defaultBranch();

  // Check if any PR branch is the parent (current branch was created from it)
  for (const pr of prs) {
    const mb = git.mergeBase(pr.headRefName, branch);
    const prSha = git.localSha(pr.headRefName) || git.remoteSha(pr.headRefName);
    if (mb && prSha && mb === prSha) {
      return pr.headRefName;
    }
  }

  return defBranch;
}

function findParent(node, root) {
  if (root === node) return null;
  for (const child of root.children) {
    if (child === node) return root;
    const found = findParent(node, child);
    if (found) return found;
  }
  return null;
}

function branchToTitle(branch) {
  // feat/auth-module → feat: auth module
  // fix-login-bug → fix login bug
  const parts = branch.replace(/[/_-]/g, ' ').trim().split(/\s+/);
  const prefixes = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'ci'];
  if (parts.length > 1 && prefixes.includes(parts[0])) {
    return `${parts[0]}: ${parts.slice(1).join(' ')}`;
  }
  return parts.join(' ');
}
