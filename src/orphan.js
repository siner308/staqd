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
    await github.rest.pulls
      .update({ owner, repo, pull_number: child.pr, base: baseBranch })
      .catch(() => {});

    await github.rest.issues
      .createComment({
        owner, repo, issue_number: child.pr,
        body: [
          `#${pr.number} (\`${pr.head.ref}\`) was merged.`,
          `Base branch updated to \`${baseBranch}\`.`,
        ].join('\n'),
      })
      .catch(() => {});

    // Post `st restack` command to trigger the command workflow.
    // With a GitHub App token this fires an issue_comment event that
    // auto-restacks the child.  With GITHUB_TOKEN the event won't fire
    // (GitHub limitation), but the comment remains as a manual hint.
    await github.rest.issues
      .createComment({
        owner, repo, issue_number: child.pr,
        body: 'st restack',
      })
      .catch(() => {});
  }
};
