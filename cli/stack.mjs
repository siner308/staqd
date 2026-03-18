// Stack tree discovery and utilities.

import * as git from './git.mjs';

/**
 * Build a stack tree from open PRs.
 * Returns { nodes: Map<branch, node>, roots: node[] }
 * where node = { branch, pr, base, title, url, children: node[] }
 */
export function buildStackTree(prs) {
  const byHead = new Map();

  for (const pr of prs) {
    byHead.set(pr.headRefName, {
      branch: pr.headRefName,
      pr: pr.number,
      base: pr.baseRefName,
      title: pr.title,
      url: pr.url,
      children: [],
    });
  }

  const roots = [];
  for (const node of byHead.values()) {
    const parent = byHead.get(node.base);
    if (parent) {
      parent.children.push(node);
    } else {
      // base is default branch or non-PR branch → root
      roots.push(node);
    }
  }

  return { nodes: byHead, roots };
}

/**
 * Find the stack subtree that contains the given branch.
 * Returns the root node of that stack, or null.
 */
export function findStackFor(branch, roots, nodes) {
  let node = nodes.get(branch);
  if (!node) return null;
  // Walk up via base to find the stack root
  while (nodes.has(node.base)) {
    node = nodes.get(node.base);
  }
  return node;
}

/**
 * Walk tree in DFS order (parent before children).
 * Calls fn(node, parent) for each node.
 */
export function walkDFS(node, fn, parent = null) {
  fn(node, parent);
  for (const child of node.children) {
    walkDFS(child, fn, node);
  }
}

/**
 * Collect all nodes in DFS order.
 */
export function collectDFS(node) {
  const result = [];
  walkDFS(node, (n) => result.push(n));
  return result;
}

/**
 * Print stack tree.
 */
export function printTree(node, indent = 0) {
  const prefix = '  '.repeat(indent);
  const current = node.branch === git.currentBranch() ? ' \x1b[36m◀\x1b[0m' : '';
  console.log(`${prefix}${indent > 0 ? '└─ ' : ''}#${node.pr} \x1b[1m${node.branch}\x1b[0m${current}`);
  for (const child of node.children) {
    printTree(child, indent + 1);
  }
}
// feature B
