// st submit — Push branches and create/update PRs.

import * as git from '../git.mjs';
import { buildStackTree, findStackFor, collectDFS, printTree } from '../stack.mjs';

export async function submit(flags) {
  const dryRun = flags['dry-run'];
  const current = git.currentBranch();

  if (!current) {
    throw new Error('Not on a branch (detached HEAD).');
  }

  // Collect tracked chain: walk from current up to root
  const chain = [];
  let b = current;
  while (b) {
    const parent = git.getTrackedParent(b);
    if (parent) {
      chain.push(b);
      b = parent;
    } else {
      // b is either default branch (stop) or untracked (include current only)
      if (b !== git.defaultBranch()) chain.push(b);
      break;
    }
  }
  chain.reverse(); // root-first order

  // If no tracked chain, fall back to just the current branch
  if (chain.length === 0) chain.push(current);

  // Push current branch first
  console.log(`Pushing ${current}...`);
  if (!dryRun) {
    git.pushUpstream(current);
  }

  // Discover existing PRs
  let prs = git.ghPrList();

  // Create PRs for each tracked branch in the chain (root → leaf)
  const defBranch = git.defaultBranch();
  for (const branch of chain) {
    const existingPr = prs.find(p => p.headRefName === branch);
    if (existingPr) {
      console.log(`  \x1b[90m·\x1b[0m PR #${existingPr.number} already exists for ${branch}`);
      continue;
    }

    const base = git.getTrackedParent(branch) || detectBase(branch, prs);
    console.log(`Creating PR: ${branch} → ${base}`);
    if (!dryRun) {
      git.pushUpstream(branch);
      const title = branchToTitle(branch);
      try {
        const url = git.ghPrCreate(branch, base, title);
        console.log(`  \x1b[32m✓\x1b[0m Created: ${url}`);
      } catch {
        // PR creation failed — check if one already exists (possibly by another author)
        const existing = git.ghPrListForBranch(branch);
        if (existing.length > 0) {
          console.log(`  \x1b[90m·\x1b[0m PR #${existing[0].number} already exists for ${branch}`);
        } else {
          console.log(`  \x1b[31m✗\x1b[0m Failed to create PR for ${branch}`);
        }
      }
      // Re-fetch so subsequent iterations see the new PR
      prs = git.ghPrList();
    } else {
      console.log(`  \x1b[33m~\x1b[0m Would create PR: ${branch} → ${base}`);
    }
  }

  // Re-fetch PR list after potential creation, including PRs by other authors for tracked branches
  let freshPrs = dryRun ? prs : git.ghPrList();
  for (const branch of chain) {
    if (!freshPrs.find(p => p.headRefName === branch)) {
      const others = git.ghPrListForBranch(branch);
      if (others.length > 0) freshPrs.push(others[0]);
    }
  }
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
        git.pushForce(node.branch);
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

  // Collect all PR branches that are ancestors of the current branch
  let best = null;
  let bestDistance = Infinity;

  for (const pr of prs) {
    const mb = git.mergeBase(pr.headRefName, branch);
    const prSha = git.localSha(pr.headRefName) || git.remoteSha(pr.headRefName);
    if (mb && prSha && mb === prSha) {
      // Count commits between this ancestor and the branch to find the closest one
      const distance = git.commitDistance(prSha, branch);
      if (distance < bestDistance) {
        best = pr.headRefName;
        bestDistance = distance;
      }
    }
  }

  return best || defBranch;
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
