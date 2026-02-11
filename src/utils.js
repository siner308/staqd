// Stack Queue utilities

function parseStackMeta(body) {
  const pattern = /<!-- stack-rebase:([\s\S]*?) -->/;
  const match = body.match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function buildStackGraph(prs) {
  const graph = {};
  for (const pr of prs) {
    const meta = parseStackMeta(pr.body);
    graph[pr.number] = meta?.children || [];
  }
  return graph;
}

module.exports = { parseStackMeta, buildStackGraph };
