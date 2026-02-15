// Execute stack commands (help, restack, merge, merge-all).
module.exports = async function command({ github, context, core, exec, command, force }) {
  const { owner, repo } = context.repo;
  const prNumber = context.payload.issue.number;

  // ════════════════════════════════════════
  // Helpers
  // ════════════════════════════════════════

  async function getStackMeta(prNum) {
    const { data: pr } = await github.rest.pulls.get({
      owner, repo, pull_number: prNum,
    });
    const pat = /<!-- stack-rebase:([\s\S]*?) -->/;

    const m = (pr.body || '').match(pat);
    if (m) {
      try { return { meta: JSON.parse(m[1]), pr }; } catch {}
    }

    const { data: comments } = await github.rest.issues.listComments({
      owner, repo, issue_number: prNum,
    });
    for (const c of comments) {
      const cm = (c.body || '').match(pat);
      if (cm) {
        try { return { meta: JSON.parse(cm[1]), pr }; } catch {}
      }
    }
    return { meta: null, pr };
  }

  async function isApproved(prNum) {
    const { data: reviews } = await github.rest.pulls.listReviews({
      owner, repo, pull_number: prNum,
    });
    const latest = {};
    for (const r of reviews) {
      if (!r.user) continue;
      const u = r.user.login;
      if (
        !latest[u] ||
        new Date(r.submitted_at) > new Date(latest[u].submitted_at)
      ) {
        latest[u] = r;
      }
    }
    const vals = Object.values(latest);
    return (
      vals.some(r => r.state === 'APPROVED') &&
      !vals.some(r => r.state === 'CHANGES_REQUESTED')
    );
  }

  async function tryMerge(prNum, method = 'squash', retries = 0) {
    for (let i = 0; i <= retries; i++) {
      try {
        const { data } = await github.rest.pulls.merge({
          owner,
          repo,
          pull_number: prNum,
          merge_method: method,
        });
        return { ok: true, sha: data.sha };
      } catch (e) {
        const msg = e.message || '';
        const retryable =
          /required status|pending|expected|head branch was modified/i.test(
            msg
          );
        if (retryable && i < retries) {
          console.log(
            `  #${prNum} attempt ${i + 1}: ${msg}. Retry in 30s...`
          );
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }
        return { ok: false, error: msg };
      }
    }
  }

  async function doRestack(branch, onto, skip) {
    try {
      await exec.exec('git', ['checkout', onto, '--detach'], {
        silent: true,
      });
      await exec.exec('git', [
        'rebase', '--onto', onto, skip, branch,
      ]);
      await exec.exec('git', [
        'push', '--force-with-lease', 'origin', branch,
      ]);
      return { ok: true };
    } catch (e) {
      try {
        await exec.exec('git', ['rebase', '--abort']);
      } catch {}
      return { ok: false, error: String(e) };
    }
  }

  async function post(prNum, body) {
    await github.rest.issues.createComment({
      owner, repo, issue_number: prNum, body,
    });
  }

  async function getOldTip(branch) {
    try {
      const { stdout } = await exec.getExecOutput('git', [
        'rev-parse', `origin/${branch}`,
      ]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async function ensureLocalBranch(branch) {
    await exec
      .exec('git', ['branch', branch, `origin/${branch}`])
      .catch(() => {});
  }

  // ════════════════════════════════════════
  // Restack logic
  // ════════════════════════════════════════

  // All items in children array are siblings (direct children).
  // No chaining — each rebases onto the same parent.
  async function restackChildren(children, baseBranch, initialSkip, { parentBranch = null } = {}) {
    await exec.exec('git', ['fetch', 'origin']);

    const merged = !parentBranch;
    const ontoBase = parentBranch ? `origin/${parentBranch}` : `origin/${baseBranch}`;
    const results = [];

    for (const child of children) {
      const oldTip = await getOldTip(child.branch);

      if (!oldTip) {
        results.push({ ...child, status: 'missing' });
        continue;
      }

      await ensureLocalBranch(child.branch);
      const r = await doRestack(child.branch, ontoBase, initialSkip);

      if (r.ok) {
        results.push({ ...child, status: 'restacked', oldTip });
      } else {
        results.push({
          ...child, status: 'conflict', oldTip, error: r.error,
        });
      }
    }

    // After parent is merged, update all children's base to main
    if (merged) {
      for (const r of results) {
        if (r.status === 'restacked') {
          await github.rest.pulls
            .update({
              owner, repo, pull_number: r.pr, base: baseBranch,
            })
            .catch(() => {});
        }
      }
    }

    return results;
  }

  function formatResults(results, baseBranch, skipSha, { parentBranch = null } = {}) {
    const label = {
      restacked: 'Restacked',
      merged: 'Merged',
      conflict: 'Conflict',
      missing: 'Branch not found',
      skipped: 'Skipped',
      merge_failed: 'Merge failed',
    };
    const rows = results.map(
      r =>
        `| \`${r.branch}\` | #${r.pr} | ${label[r.status] || r.status} |`
    );

    const failed = results.filter(
      r => !['restacked', 'merged'].includes(r.status) && r.oldTip
    );
    let manual = '';
    if (failed.length) {
      const ontoTarget = parentBranch ? `origin/${parentBranch}` : `origin/${baseBranch}`;
      const cmds = ['git fetch origin', ''];
      for (const r of failed) {
        cmds.push(`# ${r.branch} (PR #${r.pr})`);
        cmds.push(
          `git rebase --onto ${ontoTarget} ${skipSha.substring(0, 8)} ${r.branch}`
        );
        cmds.push('# resolve conflicts if any, then:');
        cmds.push(
          `git push --force-with-lease origin ${r.branch}`
        );
        cmds.push('');
      }
      manual = [
        '',
        '<details><summary>Manual restack commands</summary>',
        '',
        '```bash',
        ...cmds,
        '```',
        '</details>',
      ].join('\n');
    }

    return [
      '| Branch | PR | Status |',
      '|--------|-----|--------|',
      ...rows,
      manual,
    ].join('\n');
  }

  // ════════════════════════════════════════
  // Command dispatch
  // ════════════════════════════════════════

  const { meta, pr } = await getStackMeta(prNumber);
  const baseBranch = pr.base.ref;
  const children = meta?.children || [];
  const mergeMethod = meta?.merge_method || 'squash';

  // ── discover ──
  if (command === 'discover') {
    const visited = new Set();
    const tree = [];

    async function findChildren(headBranch) {
      const { data: prs } = await github.rest.pulls.list({
        owner, repo, state: 'open', base: headBranch,
      });
      return prs.map(p => ({ branch: p.head.ref, pr: p.number }));
    }

    async function updatePrMeta(prData, existingMeta, newChildren) {
      const body = prData.body || '';
      const pat = /\n*<!-- stack-rebase:[\s\S]*? -->/;

      if (!newChildren.length) {
        // Remove stale metadata
        if (pat.test(body)) {
          await github.rest.pulls.update({
            owner, repo, pull_number: prData.number,
            body: body.replace(pat, '').trim(),
          });
        }
        return;
      }

      const newMeta = { children: newChildren };
      if (existingMeta?.merge_method) {
        newMeta.merge_method = existingMeta.merge_method;
      }
      const metaComment = `<!-- stack-rebase:${JSON.stringify(newMeta)} -->`;
      const newBody = pat.test(body)
        ? body.replace(pat, '\n\n' + metaComment)
        : body + '\n\n' + metaComment;

      await github.rest.pulls.update({
        owner, repo, pull_number: prData.number, body: newBody.trim(),
      });
    }

    async function needsRestack(parentBranch, childBranch) {
      try {
        const { data } = await github.rest.repos.compareCommits({
          owner, repo, base: childBranch, head: parentBranch,
        });
        return data.ahead_by > 0;
      } catch {
        return false;
      }
    }

    async function discover(prNum, depth) {
      if (visited.has(prNum)) return;
      visited.add(prNum);

      const { meta: existingMeta, pr: prData } = await getStackMeta(prNum);
      const discoveredChildren = await findChildren(prData.head.ref);

      await updatePrMeta(prData, existingMeta, discoveredChildren);

      // Check restack status for each child
      const childrenWithStatus = [];
      for (const child of discoveredChildren) {
        const stale = await needsRestack(prData.head.ref, child.branch);
        childrenWithStatus.push({ ...child, needsRestack: stale });
      }

      tree.push({
        pr: prNum,
        branch: prData.head.ref,
        children: childrenWithStatus,
        depth,
      });

      for (const child of discoveredChildren) {
        await discover(child.pr, depth + 1);
      }
    }

    await discover(prNumber, 0);

    const restackNeeded = tree.some(
      node => node.children.some(c => c.needsRestack)
    );

    const lines = tree.map(node => {
      const indent = '  '.repeat(node.depth);
      const childInfo = node.children.length
        ? ` → ${node.children.map(c => {
            const warn = c.needsRestack ? ' ⚠️' : '';
            return `#${c.pr}${warn}`;
          }).join(', ')}`
        : '';
      return `${indent}- #${node.pr} (\`${node.branch}\`)${childInfo}`;
    });

    await post(prNumber, [
      `### Stack Discovered`,
      '',
      `Found **${tree.length}** PR(s) in the stack:`,
      '',
      ...lines,
      '',
      tree.length > 1
        ? 'All PR metadata has been updated.'
        : 'No children found.',
      ...(restackNeeded
        ? [
            '',
            '> ⚠️ Some PRs are out of date with their parent branch.',
            '> Run `st restack` on the parent PR to rebase.',
          ]
        : []),
    ].join('\n'));
    return;
  }

  // ── help ──
  if (command === 'help') {
    const stack = children.length
      ? [`#${prNumber} (\`${pr.head.ref}\`)`]
          .concat(
            children.map(c => `#${c.pr} (\`${c.branch}\`)`)
          )
          .join(' → ')
      : '_No stack metadata found._';

    await post(prNumber, [
      '### Staqd Commands',
      '',
      '| Command | Description |',
      '|---------|-------------|',
      '| `stack merge` (`st merge`) | Merge this PR, restack children |',
      '| `stack merge-all` (`st merge-all`) | Merge entire stack (requires approval) |',
      '| `stack merge-all --force` (`st merge-all --force`) | Skip approval check |',
      '| `stack restack` (`st restack`) | Restack children only |',
      '| `stack discover` (`st discover`) | Auto-discover stack tree from base branches |',
      '',
      `**Stack:** ${stack}`,
    ].join('\n'));
    return;
  }

  // ── restack ──
  if (command === 'restack') {
    if (!children.length) {
      await post(prNumber, 'No children to restack.');
      return;
    }

    const results = await restackChildren(
      children, baseBranch, pr.head.sha,
      { parentBranch: pr.head.ref }
    );
    const ok = results.every(r => r.status === 'restacked');

    await post(prNumber, [
      ok ? '### Restack: Complete' : '### Restack: Action Needed',
      '',
      formatResults(results, baseBranch, pr.head.sha, { parentBranch: pr.head.ref }),
    ].join('\n'));

    if (!ok) core.setFailed('Restack had failures');
    return;
  }

  // ── merge ──
  if (command === 'merge') {
    const merged = await tryMerge(prNumber, mergeMethod);
    if (!merged.ok) {
      await post(prNumber, `Merge failed: ${merged.error}`);
      core.setFailed(merged.error);
      return;
    }

    if (!children.length) {
      await post(prNumber, `Merged into \`${baseBranch}\`.`);
      return;
    }

    const results = await restackChildren(
      children, baseBranch, pr.head.sha
    );
    const ok = results.every(r => r.status === 'restacked');

    await post(prNumber, [
      ok
        ? '### Merged + Restacked'
        : '### Merged (restack needs attention)',
      '',
      `#${prNumber} merged into \`${baseBranch}\`.`,
      '',
      formatResults(results, baseBranch, pr.head.sha),
    ].join('\n'));

    for (const r of results) {
      await post(r.pr, [
        `#${prNumber} (\`${pr.head.ref}\`) was merged.`,
        r.status === 'restacked'
          ? 'Your branch was automatically restacked.'
          : `Restack status: **${r.status}**`,
      ].join(' ')).catch(() => {});
    }

    if (!ok) core.setFailed('Restack had failures');
    return;
  }

  // ── merge-all ──
  if (command === 'merge-all') {
    // Collect all PRs recursively (DFS)
    async function collectAllPRs(prNum) {
      const nums = [prNum];
      const { meta } = await getStackMeta(prNum);
      if (meta?.children) {
        for (const child of meta.children) {
          nums.push(...(await collectAllPRs(child.pr)));
        }
      }
      return nums;
    }

    if (!force) {
      const allPRs = await collectAllPRs(prNumber);
      const unapproved = [];
      for (const n of allPRs) {
        if (!(await isApproved(n))) unapproved.push(n);
      }
      if (unapproved.length) {
        await post(prNumber, [
          '### Cannot merge-all',
          '',
          `Not approved: ${unapproved.map(n => `#${n}`).join(', ')}`,
          '',
          'Use `stack merge-all --force` to skip approval check.',
        ].join('\n'));
        core.setFailed('Not all PRs approved');
        return;
      }
    }

    const first = await tryMerge(prNumber, mergeMethod);
    if (!first.ok) {
      await post(
        prNumber,
        `Merge failed for #${prNumber}: ${first.error}`
      );
      core.setFailed(first.error);
      return;
    }

    if (!children.length) {
      await post(
        prNumber,
        `Merged into \`${baseBranch}\`. (no children)`
      );
      return;
    }

    // Recursively merge children → grandchildren in DFS order
    const results = [];

    async function mergeChildren(childrenList, parentSkipSha) {
      for (const child of childrenList) {
        await exec.exec('git', ['fetch', 'origin']);

        const oldTip = await getOldTip(child.branch);
        if (!oldTip) {
          results.push({ ...child, status: 'missing' });
          continue;
        }

        await ensureLocalBranch(child.branch);

        const rs = await doRestack(
          child.branch, `origin/${baseBranch}`, parentSkipSha
        );
        if (!rs.ok) {
          results.push({
            ...child, status: 'conflict', oldTip, error: rs.error,
          });
          continue;
        }

        await github.rest.pulls
          .update({
            owner, repo, pull_number: child.pr, base: baseBranch,
          })
          .catch(() => {});

        console.log(
          `Waiting for CI on #${child.pr} (${child.branch})...`
        );
        const merged = await tryMerge(child.pr, mergeMethod, 20);

        if (!merged.ok) {
          results.push({
            ...child,
            status: 'merge_failed',
            oldTip,
            error: merged.error,
          });
          continue;
        }

        results.push({ ...child, status: 'merged', oldTip });

        // Recursively process this child's children
        const { meta: childMeta } = await getStackMeta(child.pr);
        if (childMeta?.children?.length) {
          await mergeChildren(childMeta.children, oldTip);
        }
      }
    }

    await mergeChildren(children, pr.head.sha);

    const allMerged = results.every(r => r.status === 'merged');
    const mergedCount =
      results.filter(r => r.status === 'merged').length + 1;
    const total = results.length + 1;

    const rows = results.map(r => {
      const st = {
        merged: 'Merged',
        conflict: 'Conflict',
        merge_failed: `Merge failed: ${r.error || ''}`,
        missing: 'Branch not found',
        skipped: 'Skipped',
      }[r.status] || r.status;
      return `| \`${r.branch}\` | #${r.pr} | ${st} |`;
    });

    await post(prNumber, [
      allMerged
        ? `### Stack Merged (${mergedCount}/${total})`
        : `### Stack Merge: Stopped (${mergedCount}/${total} merged)`,
      '',
      '| Branch | PR | Status |',
      '|--------|-----|--------|',
      `| \`${pr.head.ref}\` | #${prNumber} | Merged |`,
      ...rows,
      '',
      !allMerged
        ? 'Fix the issue and run `stack merge` on the failed PR.'
        : '',
    ].join('\n'));

    if (!allMerged) core.setFailed('Not all PRs merged');
    return;
  }
};
