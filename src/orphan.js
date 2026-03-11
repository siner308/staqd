// Auto-update orphaned child PRs when a parent PR is merged.
module.exports = async function orphan({ github, context }) {
  const pr = context.payload.pull_request;
  if (!pr.merged) return;

  const { owner, repo } = context.repo;
  const pat = /<!-- stack-rebase:([\s\S]*?) -->/;
  const m = (pr.body || '').match(pat);
  if (!m) return;

  let meta;
  try { meta = JSON.parse(m[1]); } catch { return; }
  if (!meta?.children?.length) return;

  const baseBranch = pr.base.ref;

  for (const child of meta.children) {
    // Validate: pr number must be a positive integer.
    if (!Number.isInteger(child.pr) || child.pr <= 0) continue;

    // Validate: child PR must be open and its base must match the merged
    // PR's head branch (guards against stale or tampered metadata).
    let childPr;
    try {
      ({ data: childPr } = await github.rest.pulls.get({
        owner, repo, pull_number: child.pr,
      }));
    } catch {
      continue;
    }
    if (childPr.state !== 'open') continue;
    if (childPr.base.ref !== pr.head.ref) continue;

    // Update child's base branch to the merged PR's base (e.g. main).
    const updated = await github.rest.pulls
      .update({ owner, repo, pull_number: child.pr, base: baseBranch })
      .then(() => true)
      .catch(() => false);

    if (!updated) {
      await github.rest.issues
        .createComment({
          owner, repo, issue_number: child.pr,
          body: [
            `#${pr.number} (\`${pr.head.ref}\`) was merged.`,
            `Failed to update base branch to \`${baseBranch}\`.`,
            'Run `st restack` manually if your branch needs rebasing.',
          ].join('\n'),
        })
        .catch(() => {});
      continue;
    }

    // Embed parent's head SHA so the restack command knows where to
    // split the child's own commits from the (now squash-merged) parent.
    // Without this, `st restack` cannot rebase the child itself — it
    // only restacks the child's children.
    const orphanMeta = JSON.stringify({ parentHeadSha: pr.head.sha });

    await github.rest.issues
      .createComment({
        owner, repo, issue_number: child.pr,
        body: [
          `#${pr.number} (\`${pr.head.ref}\`) was merged.`,
          `Base branch updated to \`${baseBranch}\`.`,
          '',
          'Auto-restack will be attempted shortly.',
          'If it does not trigger, run `st restack` manually.',
          '',
          `<!-- orphan-rebase:${orphanMeta} -->`,
        ].join('\n'),
      })
      .catch(() => {});

    // Post `st restack` command to trigger the command workflow.
    // Must match the regex in action.yml Parse command step:
    //   /^(?:stack|st)\s+(merge-all|merge|restack|discover|help)\b(.*)$/i
    // With a GitHub App token this fires an issue_comment event that
    // auto-restacks the child.  With GITHUB_TOKEN the event won't fire
    // (GitHub Actions limitation), but the notification above tells the
    // user to run it manually.
    await github.rest.issues
      .createComment({
        owner, repo, issue_number: child.pr,
        body: 'st restack',
      })
      .catch(() => {});
  }
};
