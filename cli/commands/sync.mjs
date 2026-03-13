// st sync — Sync local branches with remote after Actions restack.

import * as git from '../git.mjs';
import { buildStackTree, printTree } from '../stack.mjs';

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

  // Prune: local branches whose remote tracking branch is gone (merged PRs)
  if (flags.prune) {
    const locals = git.localBranches();
    const prBranches = new Set(prs.map(p => p.headRefName));
    for (const branch of locals) {
      if (branch === current || branch === git.defaultBranch()) continue;
      if (prBranches.has(branch)) continue;
      const remote = git.remoteSha(branch);
      if (!remote) {
        if (dryRun) {
          results.push({ branch, status: 'would-prune' });
        } else {
          try {
            git.exec(`git branch -D ${branch}`);
            results.push({ branch, status: 'pruned' });
          } catch {
            results.push({ branch, status: 'prune-failed' });
          }
        }
      }
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
