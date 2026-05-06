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

// Path to the .git directory (or the worktree-resolved destination if .git
// is a file). Used to anchor staqd's local state files (e.g. recovery
// markers).
export function gitDir() {
  return run('git', ['rev-parse', '--git-dir'], { silent: true });
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

export function fetch({ silent = false } = {}) {
  if (silent) {
    run('git', ['fetch', '--prune', '--quiet', 'origin'], { silent: true });
  } else {
    run('git', ['fetch', '--prune', 'origin']);
  }
}

// Best-effort fetch: returns true on success, false on failure (offline, auth, etc).
// Never throws. Always quiet on stderr. Use when stale remote state is
// tolerable but desired.
export function fetchBestEffort() {
  const out = run('git', ['fetch', '--prune', '--quiet', 'origin'], { silent: true });
  return out !== null;
}

// Checks whether every commit reachable from `branch` but not from `base` has
// an equivalent patch already on `base`.
// Returns:
//   { known: true, landed: true }  — all commits already on base, or branch has
//                                     no commits beyond base
//   { known: true, landed: false } — at least one commit not on base
//   { known: false }               — cherry errored (missing ref, etc.)
// Note: patch-id equivalence. Does NOT detect squash-merges (squashing
// combines patch-ids so individual commits no longer match).
export function isLandedOn(base, branch) {
  const out = run('git', ['cherry', base, branch], { silent: true });
  if (out === null) return { known: false };
  const lines = out.split('\n').filter(Boolean);
  if (lines.length === 0) return { known: true, landed: true };
  return { known: true, landed: lines.every(l => l.startsWith('-')) };
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

// True if `ancestor` is an ancestor (or equal) of `descendant`. False on error.
export function isAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
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

// Open PRs authored by the current user. Used by push paths so we never
// attempt to force-push a teammate's branch. For stack tree DISCOVERY that
// may include teammate PRs, use `ghPrListAll()` instead — but never feed its
// output into push paths.
//
// headRepository/headRepositoryOwner are included so callers can distinguish
// PRs from the same-repo (safe to treat as ownership of `origin/<branch>`)
// from fork PRs (whose head lives in a different repo).
export function ghPrList() {
  const out = run(
    'gh', ['pr', 'list', '--author', '@me', '--state', 'open', '--limit', '500',
           '--json', 'number,headRefName,baseRefName,title,url,headRepository,headRepositoryOwner'],
    { silent: true },
  );
  if (!out) return [];
  return JSON.parse(out);
}

// Repo-wide PR list for `branch` across all states. Used by push paths to
// refuse force-pushing a branch that has any non-current-user PR history
// (open, closed-unmerged) — the branch may be a teammate's abandoned work.
// Returns { known, prs } same as ghPrListMergedForBranch.
export function ghPrListAnyStateForBranch(branch) {
  const out = run(
    'gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '100',
           '--json', 'number,state,headRefName,author,url,headRepository,headRepositoryOwner'],
    { silent: true },
  );
  if (out === null) return { known: false };
  if (!out) return { known: true, prs: [] };
  try {
    return { known: true, prs: JSON.parse(out) };
  } catch {
    return { known: false };
  }
}

// The owner/name of the origin remote, parsed from its URL. Used to decide
// whether a PR's head repo is this repo (safe for push) or a fork.
// Returns { owner, name } or null.
export function originRepo() {
  const url = run('git', ['remote', 'get-url', 'origin'], { silent: true });
  if (!url) return null;
  // Supports https://github.com/OWNER/NAME(.git)? and git@github.com:OWNER/NAME(.git)?
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

// The current GitHub user's login, or null on failure. Cached at module load.
let _currentUserCache;
export function ghCurrentUser() {
  if (_currentUserCache !== undefined) return _currentUserCache;
  const out = run('gh', ['api', 'user', '--jq', '.login'], { silent: true });
  _currentUserCache = out || null;
  return _currentUserCache;
}

// Repo-wide open PR list (all authors). Safe for READ-ONLY stack tree
// construction. Must NOT be used to drive push/force-push decisions.
export function ghPrListAll() {
  const out = run(
    'gh', ['pr', 'list', '--state', 'open', '--limit', '500',
           '--json', 'number,headRefName,baseRefName,title,url,author'],
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
  return run(
    'gh', ['pr', 'create', '--base', base, '--head', head, '--title', title, '--fill'],
  );
}

export function ghPrListForBranch(branch) {
  const out = run(
    'gh', ['pr', 'list', '--head', branch, '--state', 'open',
           '--json', 'number,headRefName,baseRefName,title,url'],
    { silent: true },
  );
  if (!out) return [];
  return JSON.parse(out);
}

// Returns merged PRs for `branch` (state=merged).
// Returns:
//   { known: true, prs: [...] } — gh succeeded, list may be empty.
//                                 Each PR includes mergeCommit.oid when
//                                 available so callers can detect stale
//                                 local branches pointing at merged content.
//   { known: false }            — gh errored (unauth, offline, rate limit)
export function ghPrListMergedForBranch(branch) {
  const out = run(
    'gh', ['pr', 'list', '--head', branch, '--state', 'merged',
           '--json', 'number,headRefName,mergedAt,url,mergeCommit,headRefOid'],
    { silent: true },
  );
  if (out === null) return { known: false };
  if (!out) return { known: true, prs: [] };
  try {
    return { known: true, prs: JSON.parse(out) };
  } catch {
    return { known: false };
  }
}

export function ghPrEditBase(number, base) {
  run('gh', ['pr', 'edit', String(number), '--base', base], { silent: true });
}

export function ghPrComment(number, body) {
  run('gh', ['pr', 'comment', String(number), '--body', body], { silent: true });
}
// feature A
// extra change in A
