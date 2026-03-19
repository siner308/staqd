// Git and gh CLI helpers — no external dependencies.

import { execFileSync } from 'node:child_process';

// ── Shell execution ──

function run(cmd, args, { silent = false } = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      stdio: silent ? 'pipe' : ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (silent) return null;
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${e.stderr || e.message}`);
  }
}

// ── Git helpers ──

export function currentBranch() {
  return run('git', ['symbolic-ref', '--short', 'HEAD'], { silent: true });
}

export function defaultBranch() {
  const ref = run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { silent: true });
  if (ref) return ref.replace('refs/remotes/origin/', '');
  // fallback: try main, then master
  const branches = run('git', ['branch', '-r'], { silent: true }) || '';
  if (branches.includes('origin/main')) return 'main';
  if (branches.includes('origin/master')) return 'master';
  return 'main';
}

export function isClean() {
  const diff = run('git', ['diff', '--quiet'], { silent: true });
  if (diff === null) return false;
  const cached = run('git', ['diff', '--cached', '--quiet'], { silent: true });
  return cached !== null;
}

export function fetch() {
  run('git', ['fetch', '--prune', 'origin']);
}

export function localBranches() {
  const out = run('git', ['branch', '--format=%(refname:short)'], { silent: true });
  return out ? out.split('\n').filter(Boolean) : [];
}

export function remoteSha(branch) {
  return run('git', ['rev-parse', `origin/${branch}`], { silent: true });
}

export function localSha(branch) {
  return run('git', ['rev-parse', branch], { silent: true });
}

export function mergeBase(a, b) {
  return run('git', ['merge-base', a, b], { silent: true });
}

export function commitDistance(from, to) {
  const out = run('git', ['rev-list', '--count', `${from}..${to}`], { silent: true });
  return out ? Number(out) : Infinity;
}

export function rebaseOnto(onto, skip, branch) {
  try {
    execFileSync('git', ['rebase', '--onto', onto, skip, branch], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { ok: true };
  } catch (e) {
    try { execFileSync('git', ['rebase', '--abort'], { stdio: 'pipe' }); } catch {}
    return { ok: false, error: e.stderr || e.message };
  }
}

export function pushUpstream(branch) {
  run('git', ['push', '-u', 'origin', branch]);
}

export function pushForce(branch) {
  run('git', ['push', '--force-with-lease', 'origin', branch]);
}

export function branchForceUpdate(branch, ref) {
  run('git', ['branch', '-f', branch, ref]);
}

export function resetHard(ref) {
  run('git', ['reset', '--hard', ref]);
}

export function checkout(branch) {
  run('git', ['checkout', branch]);
}

export function checkoutNew(branch) {
  run('git', ['checkout', '-b', branch]);
}

export function ensureLocalBranch(branch) {
  run('git', ['branch', branch, `origin/${branch}`], { silent: true });
}

export function deleteBranch(branch) {
  run('git', ['branch', '-D', branch], { silent: true });
}

// ── Track helpers (git config local) ──

export function getTrackedParent(branch) {
  return run('git', ['config', '--local', `branch.${branch}.staqd-parent`], { silent: true });
}

export function setTrackedParent(branch, parent) {
  run('git', ['config', '--local', `branch.${branch}.staqd-parent`, parent]);
}

export function unsetTrackedParent(branch) {
  run('git', ['config', '--local', '--unset', `branch.${branch}.staqd-parent`], { silent: true });
}

export function listTrackedBranches() {
  const out = run('git', ['config', '--local', '--get-regexp', 'branch\\..*\\.staqd-parent'], { silent: true });
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const spaceIdx = line.indexOf(' ');
    const key = line.slice(0, spaceIdx);
    const parent = line.slice(spaceIdx + 1);
    const match = key.match(/^branch\.(.+)\.staqd-parent$/);
    const branch = match ? match[1] : key;
    return { branch, parent };
  });
}

// ── gh CLI helpers ──

export function ghPrList() {
  const out = run(
    'gh', ['pr', 'list', '--author', '@me', '--state', 'open',
           '--json', 'number,headRefName,baseRefName,title,url'],
    { silent: true },
  );
  if (!out) return [];
  return JSON.parse(out);
}

export function ghPrView(number) {
  const out = run(
    'gh', ['pr', 'view', String(number),
           '--json', 'number,headRefName,baseRefName,title,body,url'],
    { silent: true },
  );
  if (!out) return null;
  return JSON.parse(out);
}

export function ghPrCreate(head, base, title) {
  const out = run(
    'gh', ['pr', 'create', '--base', base, '--head', head, '--title', title, '--fill'],
    { silent: true },
  );
  return out; // URL of created PR
}

export function ghPrEditBase(number, base) {
  run('gh', ['pr', 'edit', String(number), '--base', base], { silent: true });
}

export function ghPrComment(number, body) {
  run('gh', ['pr', 'comment', String(number), '--body', body], { silent: true });
}
// feature A
// extra change in A
// feature A
