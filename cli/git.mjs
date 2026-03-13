// Git and gh CLI helpers — no external dependencies.

import { execSync } from 'node:child_process';

// ── Shell execution ──

export function exec(cmd, { silent = false } = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: silent ? 'pipe' : ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (silent) return null;
    throw new Error(`Command failed: ${cmd}\n${e.stderr || e.message}`);
  }
}

// ── Git helpers ──

export function currentBranch() {
  return exec('git symbolic-ref --short HEAD', { silent: true });
}

export function defaultBranch() {
  const ref = exec('git symbolic-ref refs/remotes/origin/HEAD', { silent: true });
  if (ref) return ref.replace('refs/remotes/origin/', '');
  // fallback: try main, then master
  const branches = exec('git branch -r', { silent: true }) || '';
  if (branches.includes('origin/main')) return 'main';
  if (branches.includes('origin/master')) return 'master';
  return 'main';
}

export function isClean() {
  try {
    execSync('git diff --quiet && git diff --cached --quiet', {
      encoding: 'utf-8',
      stdio: 'pipe',
      shell: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function fetch() {
  exec('git fetch --prune origin');
}

export function localBranches() {
  const out = exec('git branch --format="%(refname:short)"', { silent: true });
  return out ? out.split('\n').filter(Boolean) : [];
}

export function remoteSha(branch) {
  return exec(`git rev-parse origin/${branch}`, { silent: true });
}

export function localSha(branch) {
  return exec(`git rev-parse ${branch}`, { silent: true });
}

export function mergeBase(a, b) {
  return exec(`git merge-base ${a} ${b}`, { silent: true });
}

export function rebaseOnto(onto, skip, branch) {
  try {
    execSync(`git rebase --onto ${onto} ${skip} ${branch}`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { ok: true };
  } catch (e) {
    try { execSync('git rebase --abort', { stdio: 'pipe' }); } catch {}
    return { ok: false, error: e.stderr || e.message };
  }
}

export function pushForce(branch) {
  exec(`git push --force-with-lease origin ${branch}`);
}

export function branchForceUpdate(branch, ref) {
  exec(`git branch -f ${branch} ${ref}`);
}

export function resetHard(ref) {
  exec(`git reset --hard ${ref}`);
}

export function checkout(branch) {
  exec(`git checkout ${branch}`);
}

// ── gh CLI helpers ──

export function ghPrList() {
  const out = exec(
    'gh pr list --author @me --state open --json number,headRefName,baseRefName,title,url',
    { silent: true },
  );
  if (!out) return [];
  return JSON.parse(out);
}

export function ghPrView(number) {
  const out = exec(
    `gh pr view ${number} --json number,headRefName,baseRefName,title,body,url`,
    { silent: true },
  );
  if (!out) return null;
  return JSON.parse(out);
}

export function ghPrCreate(head, base, title) {
  const out = exec(
    `gh pr create --base ${base} --head ${head} --title ${JSON.stringify(title)} --fill`,
    { silent: true },
  );
  return out; // URL of created PR
}

export function ghPrEditBase(number, base) {
  exec(`gh pr edit ${number} --base ${base}`, { silent: true });
}

export function ghPrComment(number, body) {
  exec(`gh pr comment ${number} --body ${JSON.stringify(body)}`, { silent: true });
}
