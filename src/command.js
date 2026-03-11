// Execute stack commands (help, restack, merge, merge-all).
module.exports = async function command({ github, context, core, exec, command, force, recursive = true }) {
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

  async function deleteBranch(branch) {
    try {
      await github.rest.git.deleteRef({
        owner, repo, ref: `heads/${branch}`,
      });
    } catch (e) {
      console.log(`Could not delete branch ${branch}: ${e.message}`);
    }
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

  /**
   * Phase 1: pre-merge rebase — move children onto parent HEAD before merge.
   * Conflicts surface here (parent is still alive, context is clear).
   *
   * @param {Array} children - direct children to pre-restack
   * @param {string} parentBranch - parent branch name
   * @param {Map} [mergeBases] - pre-computed merge-bases (childBranch → SHA).
   *   When provided, uses these instead of computing merge-base at call time.
   *   Required for merge-all where prior rebasing invalidates live merge-base.
   */
  async function preRestack(children, parentBranch, mergeBases = null) {
    await exec.exec('git', ['fetch', 'origin']);
    const results = [];

    for (const child of children) {
      const oldTip = await getOldTip(child.branch);
      if (!oldTip) {
        results.push({ ...child, status: 'missing' });
        continue;
      }

      await ensureLocalBranch(child.branch);

      // Use pre-computed merge-base if available, otherwise compute live
      let mergeBase;
      if (mergeBases && mergeBases.has(child.branch)) {
        mergeBase = mergeBases.get(child.branch);
      } else {
        try {
          const { stdout } = await exec.getExecOutput('git', [
            'merge-base', `origin/${parentBranch}`, `origin/${child.branch}`,
          ]);
          mergeBase = stdout.trim();
        } catch {
          results.push({
            ...child, status: 'conflict', oldTip,
            error: 'Could not find merge-base',
          });
          continue;
        }
      }

      const r = await doRestack(child.branch, `origin/${parentBranch}`, mergeBase);
      if (r.ok) {
        results.push({ ...child, status: 'pre-restacked', oldTip });
      } else {
        results.push({
          ...child, status: 'conflict', oldTip, error: r.error,
        });
      }
    }

    return results;
  }

  /**
   * Compute merge-bases for the entire stack tree before any rebasing.
   * Must be called while all branches still have their original history.
   * Returns a Map of childBranch → merge-base SHA.
   */
  async function computeMergeBases(rootPrNum, rootBranch) {
    const bases = new Map();

    async function walk(parentBranch, parentPrNum) {
      const { meta } = await getStackMeta(parentPrNum);
      const children = meta?.children || [];

      for (const child of children) {
        try {
          const { stdout } = await exec.getExecOutput('git', [
            'merge-base', `origin/${parentBranch}`, `origin/${child.branch}`,
          ]);
          bases.set(child.branch, stdout.trim());
        } catch {
          // Will surface as 'conflict' during preRestack
        }
        await walk(child.branch, child.pr);
      }
    }

    await walk(rootBranch, rootPrNum);
    return bases;
  }

  /**
   * Phase 1 for the entire tree: pre-restack all nodes top-down.
   * Must use pre-computed merge-bases since each rebase changes history.
   */
  async function preRestackTree(rootPrNum, rootBranch, mergeBases) {
    const results = [];

    async function walk(parentPrNum, parentBranch) {
      const { meta } = await getStackMeta(parentPrNum);
      const children = meta?.children || [];
      if (!children.length) return true;

      const levelResults = await preRestack(children, parentBranch, mergeBases);
      results.push(...levelResults);

      const levelOk = levelResults.every(r => r.status === 'pre-restacked');
      if (!levelOk) return false;

      // Recurse top-down: parent was just rebased, children use pre-computed bases
      for (const child of children) {
        const ok = await walk(child.pr, child.branch);
        if (!ok) return false;
      }
      return true;
    }

    const ok = await walk(rootPrNum, rootBranch);
    return { ok, results };
  }

  function formatPreRestackFailure(results, parentBranch) {
    const label = {
      'pre-restacked': 'OK',
      conflict: 'Conflict',
      missing: 'Branch not found',
    };
    const rows = results.map(
      r => `| \`${r.branch}\` | #${r.pr} | ${label[r.status] || r.status} |`
    );

    const failed = results.filter(r => r.status === 'conflict' && r.oldTip);
    let manual = '';
    if (failed.length) {
      const cmds = ['git fetch origin', ''];
      for (const r of failed) {
        cmds.push(`# ${r.branch} (PR #${r.pr})`);
        cmds.push(
          `git rebase --onto origin/${parentBranch} $(git merge-base origin/${parentBranch} origin/${r.branch}) ${r.branch}`
        );
        cmds.push('# resolve conflicts, then:');
        cmds.push(
          `git push --force-with-lease origin ${r.branch}`
        );
        cmds.push('');
      }
      manual = [
        '',
        '<details><summary>Manual rebase commands</summary>',
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
  // Discover helpers (shared by discover, merge, merge-all)
  // ════════════════════════════════════════

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

  async function runDiscover(startPrNum) {
    const visited = new Set();
    const tree = [];

    async function discover(prNum, depth) {
      if (visited.has(prNum)) return;
      visited.add(prNum);

      const { meta: existingMeta, pr: prData } = await getStackMeta(prNum);
      const discoveredChildren = await findChildren(prData.head.ref);

      await updatePrMeta(prData, existingMeta, discoveredChildren);

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

    await discover(startPrNum, 0);
    return tree;
  }

  // ════════════════════════════════════════
  // Command dispatch
  // ════════════════════════════════════════

  // ── discover ──
  if (command === 'discover') {
    const tree = await runDiscover(prNumber);

    const restackNeeded = tree.some(
      node => node.children.some(c => c.needsRestack)
    );

    const lines = tree.map(node => {
      const indent = '  '.repeat(node.depth);
      const warn = node.children.some(c => c.needsRestack) ? ' ⚠️' : '';
      return `${indent}- #${node.pr} (\`${node.branch}\`)${warn}`;
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

  // Read metadata (used by help, restack; merge/merge-all re-read after discover)
  const { meta, pr } = await getStackMeta(prNumber);
  const baseBranch = pr.base.ref;
  const children = meta?.children || [];
  const mergeMethod = meta?.merge_method || 'squash';

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
      '| `stack restack` (`st restack`) | Restack entire stack recursively |',
      '| `stack discover` (`st discover`) | Auto-discover stack tree from base branches |',
      '',
      `**Stack:** ${stack}`,
    ].join('\n'));
    return;
  }

  // ── restack ──
  if (command === 'restack') {
    // Orphan rebase: if the parent was merged via GitHub UI (not st merge),
    // orphan.js embeds <!-- orphan-rebase:{"parentHeadSha":"..."} --> in a
    // comment.  The parentHeadSha marks where the child's own commits begin,
    // allowing us to rebase the child itself onto its (new) base branch,
    // stripping the already-squash-merged parent commits.
    const orphanPat = /<!-- orphan-rebase:([\s\S]*?) -->/;
    let selfRebased = false;
    {
      const { data: prComments } = await github.rest.issues.listComments({
        owner, repo, issue_number: prNumber,
      });
      // Find the most recent orphan-rebase metadata
      let orphanMeta = null;
      for (const c of prComments) {
        const om = (c.body || '').match(orphanPat);
        if (om) {
          try { orphanMeta = JSON.parse(om[1]); } catch {}
        }
      }
      if (orphanMeta?.parentHeadSha) {
        const { data: thisPr } = await github.rest.pulls.get({
          owner, repo, pull_number: prNumber,
        });
        await exec.exec('git', ['fetch', 'origin']);
        await ensureLocalBranch(thisPr.head.ref);
        const r = await doRestack(
          thisPr.head.ref, `origin/${thisPr.base.ref}`, orphanMeta.parentHeadSha
        );
        if (r.ok) {
          selfRebased = true;
          await exec.exec('git', ['fetch', 'origin']);
          // Clean up: delete the orphan-rebase comment to prevent re-runs
          for (const c of prComments) {
            if (orphanPat.test(c.body || '')) {
              await github.rest.issues.deleteComment({
                owner, repo, comment_id: c.id,
              }).catch(() => {});
            }
          }
        } else {
          await post(prNumber, [
            '### Restack: Action Needed',
            '',
            `Failed to rebase \`${thisPr.head.ref}\` onto \`${thisPr.base.ref}\` after parent merge.`,
            '',
            '<details><summary>Manual restack command</summary>',
            '',
            '```bash',
            'git fetch origin',
            `git rebase --onto origin/${thisPr.base.ref} ${orphanMeta.parentHeadSha.substring(0, 8)} ${thisPr.head.ref}`,
            '# resolve conflicts, then:',
            `git push --force-with-lease origin ${thisPr.head.ref}`,
            '```',
            '</details>',
          ].join('\n'));
          core.setFailed('Orphan rebase had conflicts');
          return;
        }
      }
    }

    if (recursive) {
      // Discover full stack tree first to ensure metadata is fresh
      await runDiscover(prNumber);
      const { meta: freshMeta, pr: freshPr } = await getStackMeta(prNumber);
      const freshChildren = freshMeta?.children || [];

      if (!freshChildren.length) {
        if (selfRebased) {
          await post(prNumber, [
            '### Restack: Complete',
            '',
            `Rebased \`${freshPr.head.ref}\` onto \`${freshPr.base.ref}\` after parent merge.`,
          ].join('\n'));
        } else {
          await post(prNumber, 'No children to restack.');
        }
        return;
      }

      // Recursive restack: process tree in topological order (parent before children)
      const allResults = [];
      const visited = new Set();

      async function recursiveRestack(parentPrNum, parentBranch, parentSkipSha) {
        if (visited.has(parentPrNum)) return;
        visited.add(parentPrNum);

        const { meta: pMeta } = await getStackMeta(parentPrNum);
        const pChildren = pMeta?.children || [];
        if (!pChildren.length) return;

        for (const child of pChildren) {
          const oldTip = await getOldTip(child.branch);
          if (!oldTip) {
            allResults.push({ ...child, status: 'missing', parent: parentBranch });
            continue;
          }

          await ensureLocalBranch(child.branch);
          const r = await doRestack(child.branch, `origin/${parentBranch}`, parentSkipSha);

          if (r.ok) {
            allResults.push({ ...child, status: 'restacked', oldTip, parent: parentBranch });
            await exec.exec('git', ['fetch', 'origin']);
            // Recursively restack this child's children, using old tip as skip sha
            await recursiveRestack(child.pr, child.branch, oldTip);
          } else {
            allResults.push({
              ...child, status: 'conflict', oldTip, error: r.error, parent: parentBranch,
            });
            // Stop recursing into this subtree on conflict to avoid cascading failures
          }
        }
      }

      await exec.exec('git', ['fetch', 'origin']);
      await recursiveRestack(prNumber, freshPr.head.ref, freshPr.head.sha);

      const ok = allResults.every(r => r.status === 'restacked');
      const label = { restacked: 'Restacked', conflict: 'Conflict', missing: 'Branch not found' };
      const rows = allResults.map(
        r => `| \`${r.branch}\` | #${r.pr} | ${label[r.status] || r.status} | \`${r.parent}\` |`
      );

      const conflicting = allResults.filter(r => r.status === 'conflict' && r.oldTip);
      let manual = '';
      if (conflicting.length) {
        const cmds = ['git fetch origin', ''];
        for (const r of conflicting) {
          cmds.push(`# ${r.branch} (PR #${r.pr})`);
          cmds.push(
            `git rebase --onto origin/${r.parent} ${r.oldTip.substring(0, 8)} ${r.branch}`
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

      await post(prNumber, [
        ok ? '### Restack: Complete' : '### Restack: Action Needed',
        '',
        ...(selfRebased
          ? [`Rebased \`${freshPr.head.ref}\` onto \`${freshPr.base.ref}\` after parent merge.`, '']
          : []),
        `Restacked **${allResults.filter(r => r.status === 'restacked').length}/${allResults.length}** branch(es) across the stack.`,
        '',
        '| Branch | PR | Status | Parent |',
        '|--------|-----|--------|--------|',
        ...rows,
        manual,
        ...(ok ? [] : ['', '> ⚠️ Some branches had conflicts. Fix conflicts and re-run `st restack`.']),
      ].join('\n'));

      if (!ok) core.setFailed('Restack had failures');
      return;
    }

    // Non-recursive: restack direct children only
    if (!children.length) {
      if (selfRebased) {
        await post(prNumber, [
          '### Restack: Complete',
          '',
          `Rebased \`${pr.head.ref}\` onto \`${baseBranch}\` after parent merge.`,
        ].join('\n'));
      } else {
        await post(prNumber, 'No children to restack.');
      }
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
    // Auto-discover stack before merging
    console.log('Running discover before merge...');
    await runDiscover(prNumber);
    const { meta: freshMeta, pr: freshPr } = await getStackMeta(prNumber);
    const freshBaseBranch = freshPr.base.ref;
    const freshChildren = freshMeta?.children || [];
    const freshMergeMethod = freshMeta?.merge_method || 'squash';

    if (!freshChildren.length) {
      // No children → merge directly
      const merged = await tryMerge(prNumber, freshMergeMethod);
      if (!merged.ok) {
        await post(prNumber, `Merge failed: ${merged.error}`);
        core.setFailed(merged.error);
        return;
      }
      await deleteBranch(freshPr.head.ref);
      await post(prNumber, `Merged into \`${freshBaseBranch}\`.`);
      return;
    }

    // ── Phase 1: pre-merge rebase ──
    // Move children onto parent HEAD before merging.
    // Conflicts surface here where context is clear.
    const preResults = await preRestack(freshChildren, freshPr.head.ref);
    const preOk = preResults.every(r => r.status === 'pre-restacked');

    if (!preOk) {
      await post(prNumber, [
        '### Pre-merge restack failed',
        '',
        'Children must be cleanly rebased onto the parent before merge.',
        '',
        formatPreRestackFailure(preResults, freshPr.head.ref),
      ].join('\n'));
      core.setFailed('Pre-merge restack had conflicts');
      return;
    }

    // ── Phase 2: merge + post-merge rebase ──
    // Children are now on parent HEAD. After squash merge,
    // main's tree === parent HEAD's tree, so rebase is conflict-free.
    const parentHeadSha = freshPr.head.sha;
    const merged = await tryMerge(prNumber, freshMergeMethod);
    if (!merged.ok) {
      await post(prNumber, `Merge failed: ${merged.error}`);
      core.setFailed(merged.error);
      return;
    }

    const results = await restackChildren(
      freshChildren, freshBaseBranch, parentHeadSha
    );

    // Delete parent branch after children are restacked,
    // so child PRs' base branch still exists during restackChildren.
    await deleteBranch(freshPr.head.ref);

    const ok = results.every(r => r.status === 'restacked');

    await post(prNumber, [
      ok
        ? '### Merged + Restacked'
        : '### Merged (restack needs attention)',
      '',
      `#${prNumber} merged into \`${freshBaseBranch}\`.`,
      '',
      formatResults(results, freshBaseBranch, parentHeadSha),
    ].join('\n'));

    for (const r of results) {
      await post(r.pr, [
        `#${prNumber} (\`${freshPr.head.ref}\`) was merged.`,
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
    // Auto-discover stack before merge-all
    console.log('Running discover before merge-all...');
    await runDiscover(prNumber);
    const { meta: freshMeta, pr: freshPr } = await getStackMeta(prNumber);
    const freshBaseBranch = freshPr.base.ref;
    const freshChildren = freshMeta?.children || [];
    const freshMergeMethod = freshMeta?.merge_method || 'squash';

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

    if (!freshChildren.length) {
      const first = await tryMerge(prNumber, freshMergeMethod);
      if (!first.ok) {
        await post(
          prNumber,
          `Merge failed for #${prNumber}: ${first.error}`
        );
        core.setFailed(first.error);
        return;
      }
      await deleteBranch(freshPr.head.ref);
      await post(
        prNumber,
        `Merged into \`${freshBaseBranch}\`. (no children)`
      );
      return;
    }

    // ── Phase 0: compute all merge-bases before any rebasing ──
    // After any rebase, git merge-base between rebased and original branches
    // returns incorrect results. Pre-compute while history is intact.
    await exec.exec('git', ['fetch', 'origin']);
    const mergeBases = await computeMergeBases(prNumber, freshPr.head.ref);

    // ── Phase 1: pre-restack entire tree top-down ──
    // Each level rebases children onto parent HEAD using pre-computed merge-bases.
    // Conflicts surface here where parent context is still clear.
    const { ok: preOk, results: preResults } = await preRestackTree(
      prNumber, freshPr.head.ref, mergeBases
    );

    if (!preOk) {
      await post(prNumber, [
        '### Pre-merge restack failed',
        '',
        'All branches must be cleanly rebased before merge-all can proceed.',
        '',
        formatPreRestackFailure(preResults, freshPr.head.ref),
      ].join('\n'));
      core.setFailed('Pre-merge restack had conflicts');
      return;
    }

    // ── Phase 2: merge root ──
    const first = await tryMerge(prNumber, freshMergeMethod);
    if (!first.ok) {
      await post(
        prNumber,
        `Merge failed for #${prNumber}: ${first.error}`
      );
      core.setFailed(first.error);
      return;
    }

    // ── Phase 2 continued: restack + merge children in DFS order ──
    // After Phase 1, each child sits on its parent's HEAD.
    // Phase 2 uses the parent's Phase 1 tip as skip SHA to rebase onto main.
    // Since squash merge produces the same tree as parent HEAD, this is conflict-free.
    const results = [];
    let mergeOrder = 1; // #1 (root) is order 1

    async function mergeChildren(childrenList, parentPhase1Tip) {
      for (const child of childrenList) {
        await exec.exec('git', ['fetch', 'origin']);

        const order = ++mergeOrder;
        // This is the Phase 1 tip (child was pre-restacked onto parent in Phase 1)
        const phase1Tip = await getOldTip(child.branch);
        if (!phase1Tip) {
          results.push({ ...child, status: 'missing', order });
          continue;
        }

        await ensureLocalBranch(child.branch);

        // Phase 2: rebase child onto main using parent's Phase 1 tip as skip.
        // parentPhase1Tip is in child's history (child was rebased onto parent in Phase 1).
        const rs = await doRestack(
          child.branch, `origin/${freshBaseBranch}`, parentPhase1Tip
        );
        if (!rs.ok) {
          results.push({
            ...child, status: 'conflict', oldTip: phase1Tip, error: rs.error, order,
          });
          continue;
        }

        await github.rest.pulls
          .update({
            owner, repo, pull_number: child.pr, base: freshBaseBranch,
          })
          .catch(() => {});

        console.log(
          `Waiting for CI on #${child.pr} (${child.branch})...`
        );
        const merged = await tryMerge(child.pr, freshMergeMethod, 20);

        if (!merged.ok) {
          results.push({
            ...child,
            status: 'merge_failed',
            oldTip: phase1Tip,
            error: merged.error,
            order,
          });
          continue;
        }

        results.push({ ...child, status: 'merged', oldTip: phase1Tip, order });

        // Recurse: use this child's Phase 1 tip as skip for grandchildren.
        // phase1Tip is in grandchildren's history because Phase 1 rebased them
        // onto this child's HEAD (which was phase1Tip at that time).
        const { meta: childMeta } = await getStackMeta(child.pr);
        if (childMeta?.children?.length) {
          await mergeChildren(childMeta.children, phase1Tip);
        }

        await deleteBranch(child.branch);
      }
    }

    try {
      await mergeChildren(freshChildren, freshPr.head.sha);
    } finally {
      // Delete root branch after all children are processed,
      // so child PRs' base branch still exists during mergeChildren.
      await deleteBranch(freshPr.head.ref);
    }

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
      return `| ${r.order} | \`${r.branch}\` | #${r.pr} | ${st} |`;
    });

    const failedPRs = results
      .filter(r => !['merged'].includes(r.status))
      .sort((a, b) => a.order - b.order)
      .map(r => `#${r.pr}`);

    await post(prNumber, [
      allMerged
        ? `### Stack Merged (${mergedCount}/${total})`
        : `### Stack Merge: Stopped (${mergedCount}/${total} merged)`,
      '',
      '| Order | Branch | PR | Status |',
      '|-------|--------|-----|--------|',
      `| 1 | \`${freshPr.head.ref}\` | #${prNumber} | Merged |`,
      ...rows,
      '',
      !allMerged
        ? `Fix the issue and run \`st merge\` in order: ${failedPRs.join(' → ')}`
        : '',
    ].join('\n'));

    if (!allMerged) core.setFailed('Not all PRs merged');
    return;
  }
};
