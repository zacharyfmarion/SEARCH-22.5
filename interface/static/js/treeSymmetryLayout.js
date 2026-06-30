const LENGTH_EPSILON = 1e-6;
const AXIS_ANGLE = -Math.PI / 2;
const AXIS_SIDE_FAN = Math.PI * 0.55;
const AXIS_FIXED_FLAP_OFFSET = Math.PI * 0.34;
const AXIS_FIXED_FLAP_SPACING = Math.PI * 0.12;
const SUBTREE_FAN = Math.PI * 0.72;
const MIN_SUBTREE_FAN = Math.PI * 0.28;
const COMPONENT_MATCH_TOLERANCE_RATIO = 1e-5;

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

function componentKey(value) {
  if (value === null || value === undefined) return null;
  return String(value);
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

    const compId = componentKey(edge.comp_id);
    adjacency.get(edge.u).push({ from: edge.u, to: edge.v, length, index, key, compId });
    adjacency.get(edge.v).push({ from: edge.v, to: edge.u, length, index, key, compId });
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

function finitePoint(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function boundsFromPoints(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    minX = Math.min(minX, point[0]);
    maxX = Math.max(maxX, point[0]);
    minY = Math.min(minY, point[1]);
    maxY = Math.max(maxY, point[1]);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return null;
  }

  return { minX, maxX, minY, maxY };
}

function reflectPoint(point, bounds, resultSymmetry) {
  if (resultSymmetry === "book") {
    return [bounds.minX + bounds.maxX - point[0], point[1]];
  }

  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  if (spanX <= LENGTH_EPSILON || spanY <= LENGTH_EPSILON) return null;

  const normalizedX = (point[0] - bounds.minX) / spanX;
  const normalizedY = (point[1] - bounds.minY) / spanY;
  return [
    bounds.minX + normalizedY * spanX,
    bounds.minY + normalizedX * spanY,
  ];
}

function nearestDistance(point, points) {
  let best = Infinity;
  for (const candidate of points) {
    best = Math.min(best, Math.hypot(point[0] - candidate[0], point[1] - candidate[1]));
  }
  return best;
}

function directedPointCloudDistance(points, targets) {
  let worst = 0;
  for (const point of points) {
    worst = Math.max(worst, nearestDistance(point, targets));
  }
  return worst;
}

function pointCloudDistance(a, b) {
  if (!a.length || !b.length) return Infinity;
  return Math.max(directedPointCloudDistance(a, b), directedPointCloudDistance(b, a));
}

function buildComponentSymmetryHints(componentMap, resultSymmetry) {
  const normalizedSymmetry = String(resultSymmetry || "none").toLowerCase();
  if (!isKnownSymmetric(normalizedSymmetry) || !Array.isArray(componentMap) || componentMap.length === 0) {
    return null;
  }

  const groupedPoints = new Map();
  const allPoints = [];

  for (const facet of componentMap) {
    const compId = componentKey(facet?.comp_id);
    if (compId === null || !Array.isArray(facet?.vertices)) continue;

    if (!groupedPoints.has(compId)) groupedPoints.set(compId, []);
    for (const vertex of facet.vertices) {
      const point = finitePoint(vertex);
      if (!point) continue;
      groupedPoints.get(compId).push(point);
      allPoints.push(point);
    }
  }

  if (groupedPoints.size === 0 || allPoints.length === 0) return null;

  const bounds = boundsFromPoints(allPoints);
  if (!bounds) return null;

  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const tolerance = Math.max(span * COMPONENT_MATCH_TOLERANCE_RATIO, LENGTH_EPSILON);
  const components = new Map();

  for (const [compId, points] of groupedPoints) {
    if (!points.length) continue;
    const reflected = points.map((point) => reflectPoint(point, bounds, normalizedSymmetry));
    if (reflected.some((point) => point === null)) continue;
    components.set(compId, { points, reflected });
  }

  const mirrorPartner = new Map();
  for (const [compId, component] of components) {
    const scores = [];
    for (const [candidateId, candidate] of components) {
      scores.push({
        compId: candidateId,
        score: pointCloudDistance(component.reflected, candidate.points),
      });
    }

    scores.sort((a, b) => a.score - b.score || compareIds(a.compId, b.compId));
    const best = scores[0];
    const second = scores[1];
    if (!best || best.score > tolerance) continue;
    if (second && second.score <= tolerance) continue;
    mirrorPartner.set(compId, best.compId);
  }

  for (const [compId, partnerId] of [...mirrorPartner]) {
    if (mirrorPartner.get(partnerId) !== compId) {
      mirrorPartner.delete(compId);
    }
  }

  const axisFixed = new Set();
  for (const [compId, partnerId] of mirrorPartner) {
    if (compId === partnerId) axisFixed.add(compId);
  }

  if (mirrorPartner.size === 0) return null;
  return { mirrorPartner, axisFixed, components: new Set(mirrorPartner.keys()) };
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

function isKnownSymmetric(resultSymmetry) {
  const normalized = String(resultSymmetry || "none").toLowerCase();
  return normalized === "diag" || normalized === "book";
}

function treeHasCompleteComponentHints(tree, componentHints) {
  if (!componentHints) return false;
  for (const edge of tree.edges) {
    const compId = componentKey(edge.comp_id);
    if (compId === null || !componentHints.components.has(compId)) return false;
  }
  return true;
}

function planTreeOnlyBranches(branches, allowMultipleFixedBranches) {
  const pairs = [];
  const fixedEdges = [];

  for (const [, group] of groupBySignature(branches)) {
    const members = [...group];
    if (members.length % 2 === 1) {
      if (!allowMultipleFixedBranches && fixedEdges.length > 0) return null;
      fixedEdges.push(members.shift());
    }

    for (let index = 0; index < members.length; index += 2) {
      pairs.push({ left: members[index], right: members[index + 1] });
    }
  }

  return { pairs, fixedEdges };
}

function planComponentGuidedBranches(branches, componentHints, allowMultipleFixedBranches) {
  const pairs = [];
  const fixedEdges = [];
  const remaining = [...branches].sort(compareBranches);

  while (remaining.length) {
    const branch = remaining.shift();
    if (componentHints.axisFixed.has(branch.compId)) {
      fixedEdges.push(branch);
      continue;
    }

    const partnerId = componentHints.mirrorPartner.get(branch.compId);
    if (!partnerId || partnerId === branch.compId) return null;

    const matches = [];
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (candidate.compId === partnerId && candidate.signature === branch.signature) {
        matches.push({ candidate, index });
      }
    }

    if (matches.length !== 1) return null;
    const [match] = matches;
    remaining.splice(match.index, 1);
    pairs.push({ left: branch, right: match.candidate });
  }

  if (!allowMultipleFixedBranches && fixedEdges.length > 1) return null;
  return { pairs, fixedEdges };
}

function createAxisPlanner(analyzer, { allowMultipleFixedBranches = false, componentHints = null } = {}) {
  const memo = new Map();

  function memoKey(nodeId, parentId) {
    return `${String(nodeId)}|${parentId == null ? "" : String(parentId)}`;
  }

  function build(nodeId, parentId) {
    const key = memoKey(nodeId, parentId);
    if (memo.has(key)) return memo.get(key);

    const branches = analyzer.branchesFrom(nodeId, parentId);
    const branchPlan = componentHints
      ? planComponentGuidedBranches(branches, componentHints, allowMultipleFixedBranches)
      : planTreeOnlyBranches(branches, allowMultipleFixedBranches);

    if (!branchPlan) {
      memo.set(key, null);
      return null;
    }

    const fixedBranches = [];
    for (const edge of branchPlan.fixedEdges.sort((a, b) => b.size - a.size || compareBranches(a, b))) {
      const childPlan = build(edge.to, nodeId);
      if (!childPlan) {
        memo.set(key, null);
        return null;
      }
      fixedBranches.push({ edge, childPlan });
    }

    const plan = { nodeId, parentId, fixedBranches, pairs: branchPlan.pairs };
    memo.set(key, plan);
    return plan;
  }

  return { build };
}

function planStats(plan, analyzer) {
  let axisEdges = 0;
  let axisLength = 0;
  let axisForks = 0;
  let mirroredNodes = 0;
  let pairCount = 0;

  const stack = [plan];
  while (stack.length) {
    const current = stack.pop();
    for (const pair of current.pairs) {
      pairCount += 1;
      mirroredNodes += analyzer.subtreeSize(pair.left.to, current.nodeId);
      mirroredNodes += analyzer.subtreeSize(pair.right.to, current.nodeId);
    }
    const continuationCount = current.fixedBranches.filter((fixedBranch) => planContinuesAxis(fixedBranch.childPlan)).length;
    axisForks += Math.max(0, continuationCount - 1);
    for (const fixedBranch of current.fixedBranches) {
      axisEdges += 1;
      axisLength += fixedBranch.edge.length;
      stack.push(fixedBranch.childPlan);
    }
  }

  return { axisEdges, axisLength, axisForks, mirroredNodes, pairCount };
}

function betterPlan(candidate, currentBest) {
  if (!currentBest) return true;
  const a = candidate.stats;
  const b = currentBest.stats;
  if (a.mirroredNodes !== b.mirroredNodes) return a.mirroredNodes > b.mirroredNodes;
  if (a.pairCount !== b.pairCount) return a.pairCount > b.pairCount;
  if (a.axisEdges !== b.axisEdges) return a.axisEdges > b.axisEdges;
  if (Math.abs(a.axisLength - b.axisLength) > LENGTH_EPSILON) return a.axisLength > b.axisLength;
  if (a.axisForks !== b.axisForks) return a.axisForks < b.axisForks;
  return compareIds(candidate.rootId, currentBest.rootId) < 0;
}

function findBestAxisPlan(tree, analyzer, options = {}) {
  const planner = createAxisPlanner(analyzer, options);
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

function matchComponentGuidedMirroredBranches(leftBranches, rightBranches, componentHints) {
  if (leftBranches.length !== rightBranches.length) return null;

  const rightRemaining = [...rightBranches].sort(compareBranches);
  const pairs = [];

  for (const leftBranch of [...leftBranches].sort(compareBranches)) {
    const partnerId = componentHints.mirrorPartner.get(leftBranch.compId);
    if (!partnerId || partnerId === leftBranch.compId) return null;

    const matches = [];
    for (let index = 0; index < rightRemaining.length; index += 1) {
      const rightBranch = rightRemaining[index];
      if (rightBranch.compId === partnerId && rightBranch.signature === leftBranch.signature) {
        matches.push({ rightBranch, index });
      }
    }

    if (matches.length !== 1) return null;
    const [match] = matches;
    rightRemaining.splice(match.index, 1);
    pairs.push({ left: leftBranch, right: match.rightBranch });
  }

  return pairs;
}

function matchMirroredBranches(leftBranches, rightBranches, componentHints = null) {
  if (componentHints) {
    return matchComponentGuidedMirroredBranches(leftBranches, rightBranches, componentHints);
  }

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

function mirroredAngle(rightAngle, axisAngle = AXIS_ANGLE) {
  return 2 * axisAngle - rightAngle;
}

function fixedBranchAngle(baseAngle, index) {
  if (index === 0) return baseAngle;

  const fixedFlapIndex = index - 1;
  const side = fixedFlapIndex % 2 === 0 ? 1 : -1;
  const spacing = Math.floor(fixedFlapIndex / 2) * AXIS_FIXED_FLAP_SPACING;
  return baseAngle + side * (AXIS_FIXED_FLAP_OFFSET + spacing);
}

function planContinuesAxis(plan) {
  if (!plan) return false;
  if (plan.pairs.length > 0) return true;
  return plan.fixedBranches.some((fixedBranch) => planContinuesAxis(fixedBranch.childPlan));
}

function layOutFromAxis(plan, tree, analyzer, positions, x, y, axisAngle = AXIS_ANGLE, componentHints = null) {
  positions.set(plan.nodeId, [x, y]);

  const branchPairs = sortedPairs(plan.pairs);
  const offsets = centeredOffsets(branchPairs.length, AXIS_SIDE_FAN);
  for (let index = 0; index < branchPairs.length; index += 1) {
    const pair = branchPairs[index];
    const rightAngle = axisAngle + Math.PI / 2 + offsets[index];
    layOutMirroredPair(
      pair.left,
      pair.right,
      tree,
      analyzer,
      positions,
      mirroredAngle(rightAngle, axisAngle),
      rightAngle,
      axisAngle,
      SUBTREE_FAN,
      componentHints
    );
  }

  const fixedBranches = [...plan.fixedBranches].sort((a, b) => {
    const continuationDiff = Number(planContinuesAxis(b.childPlan)) - Number(planContinuesAxis(a.childPlan));
    return continuationDiff || b.edge.size - a.edge.size || compareBranches(a.edge, b.edge);
  });
  let hasAxisContinuation = false;
  let fixedFlapIndex = 0;
  for (const fixedBranch of fixedBranches) {
    const continuesAxis = planContinuesAxis(fixedBranch.childPlan);
    const childAngle = continuesAxis && !hasAxisContinuation
      ? axisAngle
      : fixedBranchAngle(axisAngle, fixedFlapIndex + 1);
    hasAxisContinuation = hasAxisContinuation || continuesAxis;
    if (childAngle !== axisAngle) fixedFlapIndex += 1;
    const next = addPolar([x, y], fixedBranch.edge.length, childAngle);
    layOutFromAxis(fixedBranch.childPlan, tree, analyzer, positions, next[0], next[1], childAngle, componentHints);
  }
}

function layOutMirroredPair(leftEdge, rightEdge, tree, analyzer, positions, leftAngle, rightAngle, axisAngle, fan, componentHints = null) {
  const leftParent = positions.get(leftEdge.from);
  const rightParent = positions.get(rightEdge.from);
  if (!leftParent || !rightParent) return;

  const leftPos = addPolar(leftParent, leftEdge.length, leftAngle);
  const rightPos = addPolar(rightParent, rightEdge.length, rightAngle);
  positions.set(leftEdge.to, leftPos);
  positions.set(rightEdge.to, rightPos);

  const leftBranches = analyzer.branchesFrom(leftEdge.to, leftEdge.from);
  const rightBranches = analyzer.branchesFrom(rightEdge.to, rightEdge.from);
  const branchPairs = matchMirroredBranches(leftBranches, rightBranches, componentHints);
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
      mirroredAngle(childRightAngle, axisAngle),
      childRightAngle,
      axisAngle,
      childFan,
      componentHints
    );
  }
}

function layOutPlan(graph, tree, analyzer, plan, componentHints = null) {
  if (!plan) return null;

  const positions = new Map();
  layOutFromAxis(plan, tree, analyzer, positions, 0, 0, AXIS_ANGLE, componentHints);
  if (positions.size !== tree.nodes.length) return null;

  const laidOutGraph = cloneGraph(graph);
  for (const node of laidOutGraph.nodes) {
    const position = positions.get(node.id);
    if (position) node.pos = position;
  }
  return laidOutGraph;
}

export function computeSymmetricTreeLayout(graph, options = {}) {
  const tree = buildTree(graph);
  if (!tree) return null;

  const analyzer = createTreeAnalyzer(tree);
  const componentHints = buildComponentSymmetryHints(options.componentMap, options.resultSymmetry);
  if (treeHasCompleteComponentHints(tree, componentHints)) {
    const componentPlan = findBestAxisPlan(tree, analyzer, {
      allowMultipleFixedBranches: true,
      componentHints,
    });
    return layOutPlan(graph, tree, analyzer, componentPlan, componentHints);
  }

  const plan = findBestAxisPlan(tree, analyzer, {
    allowMultipleFixedBranches: isKnownSymmetric(options.resultSymmetry),
  });
  return layOutPlan(graph, tree, analyzer, plan);
}
