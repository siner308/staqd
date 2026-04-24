// st sync — Sync local branches with remote after Actions restack.

import readline from 'node:readline';
import * as git from '../git.mjs';
import { buildStackTree, printTree } from '../stack.mjs';

export const spec = {
  name: 'sync',
  summary: 'Sync local branches with remote (after Actions restack)',
  usage: 'st sync [--dry-run] [--prune | --no-prune]',
  flags: {
    'dry-run': { description: 'Show what would be done without modifying branches' },
    'prune': { description: 'Auto-delete tracked local branches whose remote is gone (skip the prompt)' },
    'no-prune': { description: 'Skip pruning entirely (default is to prompt)' },
  },
};

async function promptYesNo(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise(resolve => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function sync(flags) {
  const dryRun = flags['dry-run'];

  console.log('Fetching origin...');
  if (!dryRun) git.fetch();

  const prs = git.ghPrList();
  if (!prs.length) {
    console.log('No open PRs found.');
    return;
  }

  const { roots } = buildStackTree(prs);
  const current = git.currentBranch();
  const results = [];

  for (const pr of prs) {
    const branch = pr.headRefName;
    const local = git.localSha(branch);
    const remote = git.remoteSha(branch);

    if (!local) {
      results.push({ branch, pr: pr.number, status: 'no-local', detail: 'no local branch' });
      continue;
    }

    if (!remote) {
      results.push({ branch, pr: pr.number, status: 'pruned', detail: 'remote deleted' });
      continue;
    }

    if (local === remote) {
      results.push({ branch, pr: pr.number, status: 'up-to-date' });
      continue;
    }

    // Local and remote differ — sync
    if (dryRun) {
      results.push({ branch, pr: pr.number, status: 'would-sync', detail: `${local.slice(0, 7)} → ${remote.slice(0, 7)}` });
      continue;
    }

    if (branch === current) {
      if (!git.isClean()) {
        results.push({ branch, pr: pr.number, status: 'dirty', detail: 'uncommitted changes, skipped' });
        continue;
      }
      git.resetHard(`origin/${branch}`);
    } else {
      git.branchForceUpdate(branch, `origin/${branch}`);
    }

    results.push({ branch, pr: pr.number, status: 'synced', detail: `${local.slice(0, 7)} → ${remote.slice(0, 7)}` });
  }

  // Prune: staqd-tracked local branches whose remote is gone AND whose PR
  // is no longer open (typical signal of a merged stacked branch). Scoped to
  // tracked branches so we never delete a user's untracked local work.
  //
  // Mode:
  //   --prune    → auto-delete without asking
  //   --no-prune → skip entirely
  //   (default)  → prompt "Delete local branch X? [y/N]" per branch (TTY only)
  if (!flags['no-prune']) {
    const tracked = git.listTrackedBranches();
    const trackedBranchNames = new Set(tracked.map(t => t.branch));
    const prBranches = new Set(prs.map(p => p.headRefName));

    const candidates = [];
    for (const branch of trackedBranchNames) {
      if (branch === current || branch === git.defaultBranch()) continue;
      if (prBranches.has(branch)) continue;
      if (git.remoteSha(branch)) continue;
      candidates.push(branch);
    }

    for (const branch of candidates) {
      if (dryRun) {
        results.push({ branch, status: 'would-prune' });
        continue;
      }
      let confirmed = !!flags.prune;
      if (!confirmed) {
        if (!process.stdin.isTTY) {
          results.push({ branch, status: 'prune-skipped', detail: 'non-interactive; use --prune to auto-delete' });
          continue;
        }
        confirmed = await promptYesNo(`Delete local branch \x1b[1m${branch}\x1b[0m (remote gone)? [y/N] `);
        if (!confirmed) {
          results.push({ branch, status: 'prune-skipped', detail: 'user declined' });
          continue;
        }
      }
      const deleted = git.deleteBranch(branch);
      git.unsetTrackedParent(branch);
      results.push({ branch, status: deleted !== null ? 'pruned' : 'prune-failed' });
    }

    // Also unset tracked-parent config that points at a branch no longer
    // present anywhere (merged-and-deleted parents). Always safe to clean
    // up — no branch deletion, just config.
    for (const { branch, parent } of tracked) {
      if (parent === git.defaultBranch()) continue;
      if (trackedBranchNames.has(parent)) continue;
      if (git.remoteSha(parent)) continue;
      if (prBranches.has(parent)) continue;
      if (dryRun) {
        results.push({ branch, status: 'would-unset-parent', detail: `parent ${parent} is gone` });
        continue;
      }
      git.unsetTrackedParent(branch);
      results.push({ branch, status: 'unset-parent', detail: `cleared stale parent ${parent}` });
    }
  }

  // Print results
  console.log('');
  const icon = {
    'synced': '\x1b[32m✓\x1b[0m',
    'would-sync': '\x1b[33m~\x1b[0m',
    'up-to-date': '\x1b[90m·\x1b[0m',
    'dirty': '\x1b[31m✗\x1b[0m',
    'pruned': '\x1b[33m✂\x1b[0m',
    'would-prune': '\x1b[33m✂\x1b[0m',
    'prune-skipped': '\x1b[90m·\x1b[0m',
    'unset-parent': '\x1b[33m✂\x1b[0m',
    'would-unset-parent': '\x1b[33m✂\x1b[0m',
    'no-local': '\x1b[90m-\x1b[0m',
    'prune-failed': '\x1b[31m✗\x1b[0m',
  };

  for (const r of results) {
    const i = icon[r.status] || ' ';
    const detail = r.detail ? ` \x1b[90m(${r.detail})\x1b[0m` : '';
    const prLabel = r.pr ? ` \x1b[90m#${r.pr}\x1b[0m` : '';
    console.log(`  ${i} \x1b[1m${r.branch}\x1b[0m${prLabel}${detail}`);
  }

  const synced = results.filter(r => r.status === 'synced').length;
  const pruned = results.filter(r => r.status === 'pruned').length;
  if (synced || pruned) {
    const parts = [];
    if (synced) parts.push(`synced ${synced}`);
    if (pruned) parts.push(`pruned ${pruned}`);
    console.log(`\n${parts.join(', ')}.`);
  }

  // Show stack tree
  if (roots.length) {
    console.log('\n\x1b[1mStack:\x1b[0m');
    for (const root of roots) {
      printTree(root);
    }
  }
}
