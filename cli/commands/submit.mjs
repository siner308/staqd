// st submit — Push branches and create/update PRs.

import * as git from '../git.mjs';
import { buildStackTree, findStackFor, collectDFS, printTree } from '../stack.mjs';

export async function submit(flags) {
  const dryRun = flags['dry-run'];
  const current = git.currentBranch();

  if (!current) {
    throw new Error('Not on a branch (detached HEAD).');
  }

  const defBranch = git.defaultBranch();

  if (current === defBranch) {
    throw new Error(`Cannot submit the default branch (${defBranch}). Check out a feature branch first.`);
  }

  // Best-effort fetch so stale remote state doesn't cause us to target or push
  // a merged/deleted branch. Proceed with cached state if offline.
  const fetched = dryRun ? true : git.fetchBestEffort();
  if (!fetched) {
    console.log('\x1b[33m!\x1b[0m fetch failed (offline?) — proceeding with cached remote state');
  }

  // Caches to avoid repeated `gh` API calls.
  const openPrCache = new Map();
  const openPrFor = (branch) => {
    if (openPrCache.has(branch)) return openPrCache.get(branch);
    const result = git.ghPrListForBranch(branch);
    openPrCache.set(branch, result);
    return result;
  };
  const mergedPrCache = new Map();
  const mergedPrFor = (branch) => {
    if (mergedPrCache.has(branch)) return mergedPrCache.get(branch);
    const result = git.ghPrListMergedForBranch(branch);
    mergedPrCache.set(branch, result);
    return result;
  };

  // Hard gate: refuse to push a branch that has already been merged.
  //
  // Detection layers:
  //   1. GitHub: any merged PR with this head branch (primary signal).
  //   2. Patch-id: all commits already landed on default (`git cherry`).
  //      Catches rebase/fast-forward merges; does NOT catch squash-merges.
  //
  // Both layers must be CONFIDENT (not errored) for us to clear a branch that
  // doesn't have an open PR. An unknown state fails closed — the red line is
  // "never push a merged branch", so when we can't tell, we refuse.
  const canPush = (branch, prs) => {
    const hasOpenPr = prs.some(p => p.headRefName === branch) || openPrFor(branch).length > 0;
    if (hasOpenPr) return { ok: true };

    const merged = mergedPrFor(branch);
    if (!merged.known) {
      return { ok: false, reason: 'cannot verify merge status (gh unavailable) — refusing to push without open PR' };
    }
    if (merged.prs.length > 0) {
      return { ok: false, reason: `previously merged as PR #${merged.prs[0].number}` };
    }
    const landed = git.isLandedOn(`origin/${defBranch}`, branch);
    if (!landed.known) {
      return { ok: false, reason: `cannot verify against origin/${defBranch} — refusing to push without open PR` };
    }
    if (landed.landed) {
      return { ok: false, reason: `commits already on ${defBranch}` };
    }
    return { ok: true };
  };

  // Detect already-merged branches for chain construction. Uses the same layers
  // as canPush but treats "unknown" as merged so we don't include ambiguous
  // branches in the chain (the later canPush call would refuse them anyway).
  const isMerged = (branch) => {
    const merged = mergedPrFor(branch);
    if (!merged.known || merged.prs.length > 0) return true;
    const landed = git.isLandedOn(`origin/${defBranch}`, branch);
    if (!landed.known || landed.landed) return true;
    return false;
  };

  // Build chain, skipping over merged parents.
  const chain = [];
  const visited = new Set();
  let b = current;
  while (b && b !== defBranch) {
    if (visited.has(b)) {
      console.log(`\x1b[33m!\x1b[0m Cycle in tracked parents at ${b}; stopping chain walk`);
      break;
    }
    visited.add(b);

    const isCurrent = b === current;
    if (isCurrent) {
      chain.push(b);
    } else if (isMerged(b)) {
      console.log(`\x1b[33m!\x1b[0m Skipping ${b}: already merged`);
    } else {
      chain.push(b);
    }

    const parent = git.getTrackedParent(b);
    if (!parent) break;
    b = parent;
  }
  chain.reverse(); // root-first order

  if (chain.length === 0) chain.push(current);

  // Push current branch first
  let prs = git.ghPrList();
  const currentGate = canPush(current, prs);
  if (!currentGate.ok) {
    throw new Error(`Refusing to push ${current}: ${currentGate.reason}`);
  }
  console.log(`Pushing ${current}...`);
  if (!dryRun) {
    git.pushUpstream(current);
  }

  prs = git.ghPrList();

  // Create PRs for each branch in the chain (root → leaf)
  for (const branch of chain) {
    const existingPr = prs.find(p => p.headRefName === branch) || openPrFor(branch)[0];
    if (existingPr) {
      console.log(`  \x1b[90m·\x1b[0m PR #${existingPr.number} already exists for ${branch}`);
      continue;
    }

    const base = resolveBase(branch, prs, openPrFor, mergedPrFor, defBranch);
    console.log(`Creating PR: ${branch} → ${base}`);
    if (!dryRun) {
      const gate = canPush(branch, prs);
      if (!gate.ok) {
        console.log(`  \x1b[31m✗\x1b[0m Refused to push ${branch}: ${gate.reason}`);
        continue;
      }
      git.pushUpstream(branch);
      const title = branchToTitle(branch);
      try {
        const url = git.ghPrCreate(branch, base, title);
        console.log(`  \x1b[32m✓\x1b[0m Created: ${url}`);
      } catch (e) {
        const existing = git.ghPrListForBranch(branch);
        if (existing.length > 0) {
          console.log(`  \x1b[90m·\x1b[0m PR #${existing[0].number} already exists for ${branch}`);
        } else {
          console.log(`  \x1b[31m✗\x1b[0m Failed to create PR for ${branch}: ${e.message.split('\n')[0]}`);
        }
      }
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

      const gate = canPush(node.branch, freshPrs);
      if (!gate.ok) {
        results.push({ branch: node.branch, pr: node.pr, status: 'refused', detail: gate.reason });
        continue;
      }
      try {
        git.pushForce(node.branch);
        results.push({ branch: node.branch, pr: node.pr, status: 'pushed' });
      } catch (e) {
        results.push({ branch: node.branch, pr: node.pr, status: 'push-failed', detail: e.message.split('\n')[0] });
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
      'refused': '\x1b[31m✗\x1b[0m',
      'no-local': '\x1b[90m-\x1b[0m',
    };

    for (const r of results) {
      const i = icon[r.status] || ' ';
      const detail = r.detail ? ` \x1b[90m(${r.detail})\x1b[0m` : '';
      console.log(`  ${i} \x1b[1m${r.branch}\x1b[0m \x1b[90m#${r.pr}\x1b[0m ${r.status}${detail}`);
    }

    console.log('\n\x1b[1mStack:\x1b[0m');
    printTree(stack);
  }
}

// A parent is "usable" as a PR base if:
//   - it is the default branch,
//   - it has an open PR (either in the @me-scoped list or repo-wide), or
//   - its remote ref still exists AND it has not been merged.
// Merged branches (even if the local ref lingers) are never usable as a base.
function isUsableParent(parent, prs, openPrFor, mergedPrFor, defBranch) {
  if (parent === defBranch) return true;
  if (prs.some(p => p.headRefName === parent)) return true;
  if (openPrFor(parent).length > 0) return true;
  const merged = mergedPrFor(parent);
  if (merged.known && merged.prs.length > 0) return false;
  const landed = git.isLandedOn(`origin/${defBranch}`, parent);
  if (landed.known && landed.landed) return false;
  if (git.remoteSha(parent)) return true;
  return false;
}

// Resolve the PR base for `branch` by walking the tracked-parent chain past any
// stale entries until we find a usable parent, falling back to ancestor
// detection and finally the default branch.
function resolveBase(branch, prs, openPrFor, mergedPrFor, defBranch) {
  let parent = git.getTrackedParent(branch);
  const seen = new Set([branch]);
  while (parent) {
    if (seen.has(parent)) break; // cycle
    seen.add(parent);
    if (isUsableParent(parent, prs, openPrFor, mergedPrFor, defBranch)) return parent;
    console.log(`\x1b[33m!\x1b[0m Ignoring stale tracked parent ${parent} (merged or deleted); walking up`);
    parent = git.getTrackedParent(parent);
  }
  return detectBase(branch, prs) || defBranch;
}

// Fallback: find an ancestor PR branch whose tip is reachable from `branch`.
function detectBase(branch, prs) {
  const defBranch = git.defaultBranch();
  let best = null;
  let bestDistance = Infinity;

  for (const pr of prs) {
    const mb = git.mergeBase(pr.headRefName, branch);
    const prSha = git.localSha(pr.headRefName) || git.remoteSha(pr.headRefName);
    if (mb && prSha && mb === prSha) {
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
