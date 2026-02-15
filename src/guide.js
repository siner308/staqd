// Post or update stack guide comment when a PR is opened/edited.
module.exports = async function guide({ github, context }) {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  const pattern = /<!-- stack-rebase:([\s\S]*?) -->/;
  const marker = '<!-- stack-guide -->';

  let children = null;
  const bodyMatch = (pr.body || '').match(pattern);
  if (bodyMatch) {
    try { children = JSON.parse(bodyMatch[1]).children; } catch {}
  }

  const { data: comments } = await github.rest.issues.listComments({
    owner, repo, issue_number: pr.number,
  });
  const existing = comments.find(c =>
    c.body.includes(marker) && c.user.type === 'Bot'
  );

  if (!children?.length) {
    if (existing) {
      await github.rest.issues.deleteComment({
        owner, repo, comment_id: existing.id,
      });
    }
    return;
  }

  const stack = [`#${pr.number} (\`${pr.head.ref}\`)`]
    .concat(children.map(c => `#${c.pr} (\`${c.branch}\`)`))
    .join(' → ');

  const guide = [
    marker,
    '### Staqd',
    '',
    '| Command | Description |',
    '|---------|-------------|',
    '| `stack merge` (`st merge`) | Merge this PR, restack children |',
    '| `stack merge-all` (`st merge-all`) | Merge entire stack (requires all approved) |',
    '| `stack merge-all --force` (`st merge-all --force`) | Merge entire stack (skip approval check) |',
    '| `stack restack` (`st restack`) | Restack children without merging |',
    '| `stack discover` (`st discover`) | Auto-discover stack tree from base branches |',
    '',
    `**Stack:** ${stack}`,
  ].join('\n');

  if (existing) {
    await github.rest.issues.updateComment({
      owner, repo, comment_id: existing.id, body: guide,
    });
  } else {
    await github.rest.issues.createComment({
      owner, repo, issue_number: pr.number, body: guide,
    });
  }
};
