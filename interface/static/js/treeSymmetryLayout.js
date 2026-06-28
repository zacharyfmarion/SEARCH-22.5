const LENGTH_EPSILON = 1e-6;
const AXIS_ANGLE = -Math.PI / 2;
const AXIS_SIDE_FAN = Math.PI * 0.55;
const SUBTREE_FAN = Math.PI * 0.72;
const MIN_SUBTREE_FAN = Math.PI * 0.28;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function cloneGraph(graph) {
  return {
    ...graph,
    nodes: (graph.nodes || []).map((node) => ({
      ...node,
      pos: node.pos ? [node.pos[0], node.pos[1]] : undefined,
    })),
    edges: (graph.edges || []).map((edge) => ({ ...edge })),
  };
}

function compareIds(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function compareBranches(a, b) {
  return (
    a.signature.localeCompare(b.signature) ||
    compareIds(a.to, b.to) ||
    a.index - b.index
  );
}

function pointDistance(a, b) {
  if (!a || !b) return null;
  const dx = Number(a[0]) - Number(b[0]);
  const dy = Number(a[1]) - Number(b[1]);
  const distance = Math.hypot(dx, dy);
  return Number.isFinite(distance) && distance > LENGTH_EPSILON ? distance : null;
}

function edgeLength(edge, nodeMap) {
  if (isFiniteNumber(edge.length) && edge.length > LENGTH_EPSILON) return edge.length;
  if (isFiniteNumber(edge.weight) && edge.weight > LENGTH_EPSILON) return edge.weight;

  const start = nodeMap.get(edge.u);
  const end = nodeMap.get(edge.v);
  return pointDistance(start?.pos, end?.pos) ?? 1;
}

function lengthKey(length) {
  return Math.round(length / LENGTH_EPSILON).toString();
}

function buildTree(graph) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  if (!nodes.length || edges.length !== nodes.length - 1) return null;

  const nodeMap = new Map();
  for (const node of nodes) {
    if (nodeMap.has(node.id)) return null;
    nodeMap.set(node.id, node);
  }

  const adjacency = new Map(nodes.map((node) => [node.id, []]));

  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    if (!adjacency.has(edge.u) || !adjacency.has(edge.v)) return null;
    const length = edgeLength(edge, nodeMap);
    const key = `${String(edge.u)}--${String(edge.v)}--${index}`;

    adjacency.get(edge.u).push({ from: edge.u, to: edge.v, length, index, key });
    adjacency.get(edge.v).push({ from: edge.v, to: edge.u, length, index, key });
  }

  const visited = new Set();
  const stack = [nodes[0].id];
  while (stack.length) {
    const nodeId = stack.pop();
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const edge of adjacency.get(nodeId)) {
      if (!visited.has(edge.to)) stack.push(edge.to);
    }
  }

  if (visited.size !== nodes.length) return null;
  return { nodes, edges, nodeMap, adjacency };
}

function createTreeAnalyzer(tree) {
  const signatureMemo = new Map();
  const sizeMemo = new Map();

  function memoKey(nodeId, parentId) {
    return `${String(nodeId)}|${parentId == null ? "" : String(parentId)}`;
  }

  function branchSignature(edge) {
    return `${lengthKey(edge.length)}:${subtreeSignature(edge.to, edge.from)}`;
  }

  function subtreeSignature(nodeId, parentId) {
    const key = memoKey(nodeId, parentId);
    if (signatureMemo.has(key)) return signatureMemo.get(key);

    const childSignatures = (tree.adjacency.get(nodeId) || [])
      .filter((edge) => edge.to !== parentId)
      .map((edge) => branchSignature(edge))
      .sort();
    const signature = `(${childSignatures.join("|")})`;
    signatureMemo.set(key, signature);
    return signature;
  }

  function subtreeSize(nodeId, parentId) {
    const key = memoKey(nodeId, parentId);
    if (sizeMemo.has(key)) return sizeMemo.get(key);

    let size = 1;
    for (const edge of tree.adjacency.get(nodeId) || []) {
      if (edge.to !== parentId) size += subtreeSize(edge.to, nodeId);
    }
    sizeMemo.set(key, size);
    return size;
  }

  function branchesFrom(nodeId, parentId) {
    return (tree.adjacency.get(nodeId) || [])
      .filter((edge) => edge.to !== parentId)
      .map((edge) => ({
        ...edge,
        signature: branchSignature(edge),
        size: subtreeSize(edge.to, nodeId),
      }))
      .sort(compareBranches);
  }

  return { branchesFrom, subtreeSize };
}

function groupBySignature(branches) {
  const groups = new Map();
  for (const branch of branches) {
    if (!groups.has(branch.signature)) groups.set(branch.signature, []);
    groups.get(branch.signature).push(branch);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([signature, members]) => [signature, members.sort(compareBranches)]);
}

function createAxisPlanner(analyzer) {
  const memo = new Map();

  function memoKey(nodeId, parentId) {
    return `${String(nodeId)}|${parentId == null ? "" : String(parentId)}`;
  }

  function build(nodeId, parentId) {
    const key = memoKey(nodeId, parentId);
    if (memo.has(key)) return memo.get(key);

    const pairs = [];
    let axisEdge = null;

    for (const [, group] of groupBySignature(analyzer.branchesFrom(nodeId, parentId))) {
      const members = [...group];
      if (members.length % 2 === 1) {
        if (axisEdge) {
          memo.set(key, null);
          return null;
        }
        axisEdge = members.shift();
      }

      for (let index = 0; index < members.length; index += 2) {
        pairs.push({ left: members[index], right: members[index + 1] });
      }
    }

    const childPlan = axisEdge ? build(axisEdge.to, nodeId) : null;
    if (axisEdge && !childPlan) {
      memo.set(key, null);
      return null;
    }

    const plan = { nodeId, parentId, axisEdge, childPlan, pairs };
    memo.set(key, plan);
    return plan;
  }

  return { build };
}

function planStats(plan, analyzer) {
  let axisEdges = 0;
  let axisLength = 0;
  let mirroredNodes = 0;
  let pairCount = 0;

  for (let current = plan; current; current = current.childPlan) {
    for (const pair of current.pairs) {
      pairCount += 1;
      mirroredNodes += analyzer.subtreeSize(pair.left.to, current.nodeId);
      mirroredNodes += analyzer.subtreeSize(pair.right.to, current.nodeId);
    }
    if (current.axisEdge) {
      axisEdges += 1;
      axisLength += current.axisEdge.length;
    }
  }

  return { axisEdges, axisLength, mirroredNodes, pairCount };
}

function betterPlan(candidate, currentBest) {
  if (!currentBest) return true;
  const a = candidate.stats;
  const b = currentBest.stats;
  if (a.mirroredNodes !== b.mirroredNodes) return a.mirroredNodes > b.mirroredNodes;
  if (a.pairCount !== b.pairCount) return a.pairCount > b.pairCount;
  if (a.axisEdges !== b.axisEdges) return a.axisEdges > b.axisEdges;
  if (Math.abs(a.axisLength - b.axisLength) > LENGTH_EPSILON) return a.axisLength > b.axisLength;
  return compareIds(candidate.rootId, currentBest.rootId) < 0;
}

function findBestAxisPlan(tree, analyzer) {
  const planner = createAxisPlanner(analyzer);
  let best = null;

  for (const node of tree.nodes) {
    const plan = planner.build(node.id, null);
    if (!plan) continue;

    const stats = planStats(plan, analyzer);
    if (stats.axisEdges === 0 && stats.mirroredNodes === 0) continue;

    const candidate = { rootId: node.id, plan, stats };
    if (betterPlan(candidate, best)) best = candidate;
  }

  return best?.plan || null;
}

function centeredOffsets(count, fan) {
  if (count <= 0) return [];
  if (count === 1) return [0];

  const step = fan / count;
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    offsets.push(-fan / 2 + step / 2 + step * index);
  }
  return offsets.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
}

function sortedPairs(pairs) {
  return [...pairs].sort((a, b) => {
    const sizeDiff = b.left.size + b.right.size - (a.left.size + a.right.size);
    return sizeDiff || compareBranches(a.left, b.left) || compareBranches(a.right, b.right);
  });
}

function matchMirroredBranches(leftBranches, rightBranches) {
  const leftGroups = groupBySignature(leftBranches);
  const rightGroups = new Map(groupBySignature(rightBranches));
  const pairs = [];

  for (const [signature, leftGroup] of leftGroups) {
    const rightGroup = rightGroups.get(signature);
    if (!rightGroup || rightGroup.length !== leftGroup.length) return null;
    for (let index = 0; index < leftGroup.length; index += 1) {
      pairs.push({ left: leftGroup[index], right: rightGroup[index] });
    }
  }

  return pairs;
}

function addPolar(point, length, angle) {
  return [
    point[0] + length * Math.cos(angle),
    point[1] + length * Math.sin(angle),
  ];
}

function mirroredAngle(rightAngle) {
  return Math.PI - rightAngle;
}

function layOutFromAxis(plan, tree, analyzer, positions, x, y) {
  positions.set(plan.nodeId, [x, y]);

  const branchPairs = sortedPairs(plan.pairs);
  const offsets = centeredOffsets(branchPairs.length, AXIS_SIDE_FAN);
  for (let index = 0; index < branchPairs.length; index += 1) {
    const pair = branchPairs[index];
    const rightAngle = offsets[index];
    layOutMirroredPair(
      pair.left,
      pair.right,
      tree,
      analyzer,
      positions,
      mirroredAngle(rightAngle),
      rightAngle,
      SUBTREE_FAN
    );
  }

  if (plan.axisEdge && plan.childPlan) {
    const next = addPolar([x, y], plan.axisEdge.length, AXIS_ANGLE);
    layOutFromAxis(plan.childPlan, tree, analyzer, positions, next[0], next[1]);
  }
}

function layOutMirroredPair(leftEdge, rightEdge, tree, analyzer, positions, leftAngle, rightAngle, fan) {
  const leftParent = positions.get(leftEdge.from);
  const rightParent = positions.get(rightEdge.from);
  if (!leftParent || !rightParent) return;

  const leftPos = addPolar(leftParent, leftEdge.length, leftAngle);
  const rightPos = addPolar(rightParent, rightEdge.length, rightAngle);
  positions.set(leftEdge.to, leftPos);
  positions.set(rightEdge.to, rightPos);

  const leftBranches = analyzer.branchesFrom(leftEdge.to, leftEdge.from);
  const rightBranches = analyzer.branchesFrom(rightEdge.to, rightEdge.from);
  const branchPairs = matchMirroredBranches(leftBranches, rightBranches);
  if (!branchPairs || branchPairs.length === 0) return;

  const childFan = Math.max(MIN_SUBTREE_FAN, fan * 0.86);
  const orderedPairs = sortedPairs(branchPairs);
  const offsets = centeredOffsets(orderedPairs.length, fan);
  for (let index = 0; index < orderedPairs.length; index += 1) {
    const pair = orderedPairs[index];
    const childRightAngle = rightAngle + offsets[index];
    layOutMirroredPair(
      pair.left,
      pair.right,
      tree,
      analyzer,
      positions,
      mirroredAngle(childRightAngle),
      childRightAngle,
      childFan
    );
  }
}

export function computeSymmetricTreeLayout(graph) {
  const tree = buildTree(graph);
  if (!tree) return null;

  const analyzer = createTreeAnalyzer(tree);
  const plan = findBestAxisPlan(tree, analyzer);
  if (!plan) return null;

  const positions = new Map();
  layOutFromAxis(plan, tree, analyzer, positions, 0, 0);
  if (positions.size !== tree.nodes.length) return null;

  const laidOutGraph = cloneGraph(graph);
  for (const node of laidOutGraph.nodes) {
    const position = positions.get(node.id);
    if (position) node.pos = position;
  }
  return laidOutGraph;
}
