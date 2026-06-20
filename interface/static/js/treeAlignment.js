const EPS = 1e-9;

function keyFor(id) {
  return String(id);
}

function edgeKey(a, b) {
  const ka = keyFor(a);
  const kb = keyFor(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function addVec(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function subVec(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function mulVec(a, scalar) {
  return [a[0] * scalar, a[1] * scalar];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

function lengthOf(v) {
  return Math.hypot(v[0], v[1]);
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function getNodePoint(node, ySign = 1) {
  if (Array.isArray(node.pos) && node.pos.length >= 2) {
    return [Number(node.pos[0]), Number(node.pos[1]) * ySign];
  }
  if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
    return [Number(node.x), Number(node.y) * ySign];
  }
  return null;
}

export function cloneGraph(graph) {
  return {
    nodes: (graph?.nodes || []).map((node) => ({
      ...node,
      pos: Array.isArray(node.pos) ? [node.pos[0], node.pos[1]] : node.pos,
    })),
    edges: (graph?.edges || []).map((edge) => ({ ...edge })),
  };
}

function buildAdjacency(graph, ySign = 1) {
  const nodeByKey = new Map();
  const adjacency = new Map();

  for (const node of graph.nodes || []) {
    const key = keyFor(node.id);
    nodeByKey.set(key, node);
    adjacency.set(key, []);
  }

  for (const edge of graph.edges || []) {
    const u = keyFor(edge.u);
    const v = keyFor(edge.v);
    if (!adjacency.has(u) || !adjacency.has(v)) continue;

    let edgeLength = Number(edge.length);
    if (!Number.isFinite(edgeLength) || edgeLength <= EPS) {
      const uPoint = getNodePoint(nodeByKey.get(u), ySign);
      const vPoint = getNodePoint(nodeByKey.get(v), ySign);
      edgeLength = uPoint && vPoint ? Math.max(distance(uPoint, vPoint), EPS) : 1;
    }

    const payload = { u, v, length: edgeLength, key: edgeKey(u, v), raw: edge };
    adjacency.get(u).push({ to: v, length: edgeLength, edge: payload });
    adjacency.get(v).push({ to: u, length: edgeLength, edge: payload });
  }

  return { nodeByKey, adjacency };
}

function buildSkeleton(graph, { ySign = 1 } = {}) {
  const { nodeByKey, adjacency } = buildAdjacency(graph, ySign);
  const graphNodes = [...nodeByKey.keys()];
  if (graphNodes.length === 0) {
    return { nodes: new Map(), edges: [], adjacency: new Map(), totalLength: 1 };
  }

  const skeletonKeys = new Set();
  for (const key of graphNodes) {
    const degree = adjacency.get(key)?.length || 0;
    if (degree !== 2) skeletonKeys.add(key);
  }

  if (skeletonKeys.size === 0) {
    skeletonKeys.add(graphNodes[0]);
  }

  const skeletonNodes = new Map();
  for (const key of skeletonKeys) {
    const node = nodeByKey.get(key);
    const degree = adjacency.get(key)?.length || 0;
    skeletonNodes.set(key, {
      key,
      id: node.id,
      degree,
      pos: getNodePoint(node, ySign) || [0, 0],
    });
  }

  const visitedEdges = new Set();
  const skeletonEdges = [];

  for (const startKey of skeletonKeys) {
    for (const firstStep of adjacency.get(startKey) || []) {
      if (visitedEdges.has(firstStep.edge.key)) continue;

      const path = [startKey];
      const segmentLengths = [];
      let totalLength = 0;
      let previous = startKey;
      let current = firstStep.to;
      let currentStep = firstStep;

      while (currentStep) {
        visitedEdges.add(currentStep.edge.key);
        path.push(current);
        segmentLengths.push(currentStep.length);
        totalLength += currentStep.length;

        if (skeletonKeys.has(current)) break;

        const nextStep = (adjacency.get(current) || []).find((step) => step.to !== previous);
        if (!nextStep) break;
        previous = current;
        current = nextStep.to;
        currentStep = nextStep;
      }

      const endKey = path[path.length - 1];
      if (startKey === endKey || !skeletonKeys.has(endKey)) continue;

      skeletonEdges.push({
        u: startKey,
        v: endKey,
        length: Math.max(totalLength, EPS),
        path,
        segmentLengths,
        key: edgeKey(startKey, endKey),
      });
    }
  }

  const skeletonAdjacency = new Map([...skeletonNodes.keys()].map((key) => [key, []]));
  let totalLength = 0;
  for (const edge of skeletonEdges) {
    totalLength += edge.length;
    skeletonAdjacency.get(edge.u)?.push({ to: edge.v, edge, length: edge.length });
    skeletonAdjacency.get(edge.v)?.push({ to: edge.u, edge, length: edge.length });
  }

  return {
    nodes: skeletonNodes,
    edges: skeletonEdges,
    adjacency: skeletonAdjacency,
    totalLength: Math.max(totalLength, EPS),
  };
}

function getRootCandidates(skeleton) {
  const nodes = [...skeleton.nodes.values()];
  if (nodes.length <= 36) return nodes.map((node) => node.key);

  return nodes
    .slice()
    .sort((a, b) => {
      const branchA = a.degree >= 3 ? 1 : 0;
      const branchB = b.degree >= 3 ? 1 : 0;
      return branchB - branchA || b.degree - a.degree;
    })
    .slice(0, 36)
    .map((node) => node.key);
}

function createSubtreeStats(skeleton) {
  const memo = new Map();

  function stats(nodeKey, parentKey) {
    const memoKey = `${nodeKey}>${parentKey ?? ""}`;
    if (memo.has(memoKey)) return memo.get(memoKey);

    const node = skeleton.nodes.get(nodeKey);
    let nodeCount = 1;
    let leafCount = node?.degree <= 1 ? 1 : 0;
    let branchCount = node?.degree >= 3 ? 1 : 0;
    let totalLength = 0;

    for (const child of skeleton.adjacency.get(nodeKey) || []) {
      if (child.to === parentKey) continue;
      const childStats = stats(child.to, nodeKey);
      nodeCount += childStats.nodeCount;
      leafCount += childStats.leafCount;
      branchCount += childStats.branchCount;
      totalLength += child.length + childStats.totalLength;
    }

    const result = { nodeCount, leafCount, branchCount, totalLength };
    memo.set(memoKey, result);
    return result;
  }

  return stats;
}

function createSkeletonMatcher(resultSkeleton, referenceSkeleton) {
  const resultStats = createSubtreeStats(resultSkeleton);
  const referenceStats = createSubtreeStats(referenceSkeleton);
  const memo = new Map();

  function subtreePenalty(skeleton, statsFn, nodeKey, parentKey) {
    const stats = statsFn(nodeKey, parentKey);
    const lengthScale = skeleton.totalLength || 1;
    return (
      0.85 * stats.nodeCount +
      0.70 * stats.leafCount +
      0.55 * stats.branchCount +
      0.45 * (stats.totalLength / lengthScale)
    );
  }

  function nodeCost(resultKey, referenceKey) {
    const resultNode = resultSkeleton.nodes.get(resultKey);
    const referenceNode = referenceSkeleton.nodes.get(referenceKey);
    const resultDegree = resultNode?.degree || 0;
    const referenceDegree = referenceNode?.degree || 0;
    const resultLeaf = resultDegree <= 1;
    const referenceLeaf = referenceDegree <= 1;
    const resultBranch = resultDegree >= 3;
    const referenceBranch = referenceDegree >= 3;

    let cost = Math.abs(resultDegree - referenceDegree) * 0.45;
    if (resultLeaf !== referenceLeaf) cost += 1.35;
    if (resultBranch !== referenceBranch) cost += 1.05;
    return cost;
  }

  function edgeLengthCost(resultLength, referenceLength) {
    const normalizedResult = resultLength / resultSkeleton.totalLength;
    const normalizedReference = referenceLength / referenceSkeleton.totalLength;
    return Math.abs(Math.log((normalizedResult + EPS) / (normalizedReference + EPS))) * 0.35;
  }

  function assignChildren(resultChildren, referenceChildren, resultParent, referenceParent) {
    const m = resultChildren.length;
    const n = referenceChildren.length;

    if (m === 0) {
      return {
        cost: referenceChildren.reduce(
          (sum, child) => sum + subtreePenalty(referenceSkeleton, referenceStats, child.to, referenceParent),
          0,
        ),
        pairs: referenceChildren.map((child) => ({ result: null, reference: child })),
      };
    }

    if (n === 0) {
      return {
        cost: resultChildren.reduce(
          (sum, child) => sum + subtreePenalty(resultSkeleton, resultStats, child.to, resultParent),
          0,
        ),
        pairs: resultChildren.map((child) => ({ result: child, reference: null })),
      };
    }

    if (m <= 12 && n <= 12) {
      const assignmentMemo = new Map();

      function solve(index, usedMask) {
        const assignmentKey = `${index}|${usedMask}`;
        if (assignmentMemo.has(assignmentKey)) return assignmentMemo.get(assignmentKey);

        if (index === m) {
          const pairs = [];
          let cost = 0;
          for (let j = 0; j < n; j += 1) {
            if ((usedMask & (1 << j)) === 0) {
              cost += subtreePenalty(referenceSkeleton, referenceStats, referenceChildren[j].to, referenceParent);
              pairs.push({ result: null, reference: referenceChildren[j] });
            }
          }
          const terminal = { cost, pairs };
          assignmentMemo.set(assignmentKey, terminal);
          return terminal;
        }

        const resultChild = resultChildren[index];
        let best = {
          cost: subtreePenalty(resultSkeleton, resultStats, resultChild.to, resultParent),
          pairs: [{ result: resultChild, reference: null }],
        };
        const deleteRest = solve(index + 1, usedMask);
        best = {
          cost: best.cost + deleteRest.cost,
          pairs: best.pairs.concat(deleteRest.pairs),
        };

        for (let j = 0; j < n; j += 1) {
          if (usedMask & (1 << j)) continue;
          const referenceChild = referenceChildren[j];
          const substitutionCost =
            edgeLengthCost(resultChild.length, referenceChild.length) +
            matchCost(resultChild.to, resultParent, referenceChild.to, referenceParent).cost;
          const rest = solve(index + 1, usedMask | (1 << j));
          const candidate = {
            cost: substitutionCost + rest.cost,
            pairs: [{ result: resultChild, reference: referenceChild }].concat(rest.pairs),
          };
          if (candidate.cost < best.cost) best = candidate;
        }

        assignmentMemo.set(assignmentKey, best);
        return best;
      }

      return solve(0, 0);
    }

    const unmatchedReference = new Set(referenceChildren.map((_, index) => index));
    const pairs = [];
    let cost = 0;

    for (const resultChild of resultChildren) {
      let bestReferenceIndex = null;
      let bestPairCost = Infinity;

      for (const referenceIndex of unmatchedReference) {
        const referenceChild = referenceChildren[referenceIndex];
        const substitutionCost =
          edgeLengthCost(resultChild.length, referenceChild.length) +
          matchCost(resultChild.to, resultParent, referenceChild.to, referenceParent).cost;
        if (substitutionCost < bestPairCost) {
          bestPairCost = substitutionCost;
          bestReferenceIndex = referenceIndex;
        }
      }

      const deleteCost = subtreePenalty(resultSkeleton, resultStats, resultChild.to, resultParent);
      if (bestReferenceIndex !== null && bestPairCost < deleteCost) {
        const referenceChild = referenceChildren[bestReferenceIndex];
        unmatchedReference.delete(bestReferenceIndex);
        pairs.push({ result: resultChild, reference: referenceChild });
        cost += bestPairCost;
      } else {
        pairs.push({ result: resultChild, reference: null });
        cost += deleteCost;
      }
    }

    for (const referenceIndex of unmatchedReference) {
      const referenceChild = referenceChildren[referenceIndex];
      pairs.push({ result: null, reference: referenceChild });
      cost += subtreePenalty(referenceSkeleton, referenceStats, referenceChild.to, referenceParent);
    }

    return { cost, pairs };
  }

  function matchCost(resultKey, resultParent, referenceKey, referenceParent) {
    const memoKey = `${resultKey}>${resultParent ?? ""}|${referenceKey}>${referenceParent ?? ""}`;
    if (memo.has(memoKey)) return memo.get(memoKey);

    const resultChildren = (resultSkeleton.adjacency.get(resultKey) || []).filter((child) => child.to !== resultParent);
    const referenceChildren = (referenceSkeleton.adjacency.get(referenceKey) || []).filter((child) => child.to !== referenceParent);
    const childAssignment = assignChildren(resultChildren, referenceChildren, resultKey, referenceKey);
    const result = {
      cost: nodeCost(resultKey, referenceKey) + childAssignment.cost,
      pairs: childAssignment.pairs,
    };
    memo.set(memoKey, result);
    return result;
  }

  function collect(resultKey, resultParent, referenceKey, referenceParent, nodeMatches, edgeMatches) {
    nodeMatches.set(resultKey, referenceKey);
    const entry = matchCost(resultKey, resultParent, referenceKey, referenceParent);

    for (const pair of entry.pairs) {
      if (!pair.result || !pair.reference) continue;
      edgeMatches.push({
        resultParent: resultKey,
        resultChild: pair.result.to,
        referenceParent: referenceKey,
        referenceChild: pair.reference.to,
        resultEdgeKey: pair.result.edge.key,
        referenceEdgeKey: pair.reference.edge.key,
      });
      collect(pair.result.to, resultKey, pair.reference.to, referenceKey, nodeMatches, edgeMatches);
    }
  }

  function bestMatch() {
    const resultRoots = getRootCandidates(resultSkeleton);
    const referenceRoots = getRootCandidates(referenceSkeleton);
    let best = null;

    for (const resultRoot of resultRoots) {
      for (const referenceRoot of referenceRoots) {
        const candidate = matchCost(resultRoot, null, referenceRoot, null);
        const normalizedCost = candidate.cost / Math.max(resultSkeleton.nodes.size + referenceSkeleton.nodes.size, 1);
        if (!best || normalizedCost < best.normalizedCost) {
          best = { resultRoot, referenceRoot, cost: candidate.cost, normalizedCost };
        }
      }
    }

    const nodeMatches = new Map();
    const edgeMatches = [];
    if (best) {
      collect(best.resultRoot, null, best.referenceRoot, null, nodeMatches, edgeMatches);
    }

    return {
      ...(best || {}),
      nodeMatches,
      edgeMatches,
    };
  }

  return { bestMatch };
}

function weightedProcrustes(sourcePoints, targetPoints, weights) {
  if (sourcePoints.length === 0 || targetPoints.length === 0) {
    return {
      apply: (point) => [point[0], point[1]],
      error: Infinity,
    };
  }

  if (sourcePoints.length === 1) {
    const delta = subVec(targetPoints[0], sourcePoints[0]);
    return {
      apply: (point) => addVec(point, delta),
      error: 0,
    };
  }

  function candidate(reflectX) {
    const prepared = sourcePoints.map((point) => (reflectX ? [-point[0], point[1]] : [point[0], point[1]]));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    const sourceCentroid = prepared.reduce((sum, point, index) => addVec(sum, mulVec(point, weights[index])), [0, 0]).map((value) => value / totalWeight);
    const targetCentroid = targetPoints.reduce((sum, point, index) => addVec(sum, mulVec(point, weights[index])), [0, 0]).map((value) => value / totalWeight);

    let a = 0;
    let b = 0;
    let denominator = 0;

    for (let i = 0; i < prepared.length; i += 1) {
      const source = subVec(prepared[i], sourceCentroid);
      const target = subVec(targetPoints[i], targetCentroid);
      const weight = weights[i];
      a += weight * (source[0] * target[0] + source[1] * target[1]);
      b += weight * (source[0] * target[1] - source[1] * target[0]);
      denominator += weight * dot(source, source);
    }

    const angle = Math.atan2(b, a);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    function rotate(point) {
      return [cos * point[0] - sin * point[1], sin * point[0] + cos * point[1]];
    }

    let numerator = 0;
    for (let i = 0; i < prepared.length; i += 1) {
      const source = subVec(prepared[i], sourceCentroid);
      const target = subVec(targetPoints[i], targetCentroid);
      numerator += weights[i] * dot(rotate(source), target);
    }

    const scale = denominator > EPS ? Math.max(numerator / denominator, EPS) : 1;
    const rotatedCentroid = rotate(sourceCentroid);
    const translation = subVec(targetCentroid, mulVec(rotatedCentroid, scale));

    function apply(point) {
      const preparedPoint = reflectX ? [-point[0], point[1]] : [point[0], point[1]];
      return addVec(mulVec(rotate(preparedPoint), scale), translation);
    }

    let error = 0;
    for (let i = 0; i < sourcePoints.length; i += 1) {
      const delta = subVec(apply(sourcePoints[i]), targetPoints[i]);
      error += weights[i] * dot(delta, delta);
    }

    return { apply, error, scale, reflectX, angle };
  }

  const direct = candidate(false);
  const reflected = candidate(true);
  return reflected.error < direct.error ? reflected : direct;
}

function buildLandmarkSets(resultSkeleton, referenceSkeleton, nodeMatches) {
  const source = [];
  const target = [];
  const weights = [];

  for (const [resultKey, referenceKey] of nodeMatches.entries()) {
    const resultNode = resultSkeleton.nodes.get(resultKey);
    const referenceNode = referenceSkeleton.nodes.get(referenceKey);
    if (!resultNode || !referenceNode) continue;

    source.push(resultNode.pos);
    target.push(referenceNode.pos);

    let weight = 1;
    if (resultNode.degree >= 3 || referenceNode.degree >= 3) weight += 1.4;
    if (resultNode.degree <= 1 && referenceNode.degree <= 1) weight += 0.6;
    weights.push(weight);
  }

  return { source, target, weights };
}

function averageEdgeLength(edges, positions) {
  if (!edges.length) return 1;
  const total = edges.reduce((sum, edge) => {
    const start = positions.get(edge.u);
    const end = positions.get(edge.v);
    return sum + (start && end ? distance(start, end) : edge.length);
  }, 0);
  return Math.max(total / edges.length, EPS);
}

function optimizeSkeletonLayout(resultSkeleton, referenceSkeleton, match, transform) {
  const positions = new Map();
  for (const [key, node] of resultSkeleton.nodes.entries()) {
    positions.set(key, transform.apply(node.pos));
  }

  const targets = new Map();
  for (const [resultKey, referenceKey] of match.nodeMatches.entries()) {
    const referenceNode = referenceSkeleton.nodes.get(referenceKey);
    if (referenceNode) targets.set(resultKey, referenceNode.pos);
  }

  const restLengths = new Map();
  for (const edge of resultSkeleton.edges) {
    const start = positions.get(edge.u);
    const end = positions.get(edge.v);
    restLengths.set(edge.key, Math.max(start && end ? distance(start, end) : edge.length, EPS));
  }

  const averageRest = averageEdgeLength(resultSkeleton.edges, positions);
  const maxMove = averageRest * 0.16;
  const minSeparation = averageRest * 0.10;

  const referenceEdgeDirections = new Map();
  for (const edgeMatch of match.edgeMatches) {
    const referenceStart = referenceSkeleton.nodes.get(edgeMatch.referenceParent)?.pos;
    const referenceEnd = referenceSkeleton.nodes.get(edgeMatch.referenceChild)?.pos;
    if (!referenceStart || !referenceEnd) continue;
    const vector = subVec(referenceEnd, referenceStart);
    const vectorLength = lengthOf(vector);
    if (vectorLength <= EPS) continue;
    referenceEdgeDirections.set(edgeMatch.resultEdgeKey, {
      parent: edgeMatch.resultParent,
      child: edgeMatch.resultChild,
      direction: mulVec(vector, 1 / vectorLength),
    });
  }

  const nodeKeys = [...resultSkeleton.nodes.keys()];

  for (let iteration = 0; iteration < 360; iteration += 1) {
    const forces = new Map(nodeKeys.map((key) => [key, [0, 0]]));

    for (const [key, target] of targets.entries()) {
      const position = positions.get(key);
      const node = resultSkeleton.nodes.get(key);
      const anchorWeight = node?.degree >= 3 ? 0.060 : node?.degree <= 1 ? 0.044 : 0.035;
      forces.set(key, addVec(forces.get(key), mulVec(subVec(target, position), anchorWeight)));
    }

    for (const edge of resultSkeleton.edges) {
      const start = positions.get(edge.u);
      const end = positions.get(edge.v);
      const vector = subVec(end, start);
      const currentLength = Math.max(lengthOf(vector), EPS);
      const direction = mulVec(vector, 1 / currentLength);
      const stretch = currentLength - restLengths.get(edge.key);
      const force = mulVec(direction, stretch * 0.090);
      forces.set(edge.u, addVec(forces.get(edge.u), force));
      forces.set(edge.v, subVec(forces.get(edge.v), force));
    }

    for (const edge of resultSkeleton.edges) {
      const directionConstraint = referenceEdgeDirections.get(edge.key);
      if (!directionConstraint) continue;
      const start = positions.get(directionConstraint.parent);
      const end = positions.get(directionConstraint.child);
      if (!start || !end) continue;

      const vector = subVec(end, start);
      const projectedLength = Math.max(dot(vector, directionConstraint.direction), EPS);
      const desiredVector = mulVec(directionConstraint.direction, projectedLength);
      const correction = subVec(desiredVector, vector);
      const force = mulVec(correction, 0.045);
      forces.set(directionConstraint.child, addVec(forces.get(directionConstraint.child), force));
      forces.set(directionConstraint.parent, subVec(forces.get(directionConstraint.parent), force));
    }

    for (let i = 0; i < nodeKeys.length; i += 1) {
      for (let j = i + 1; j < nodeKeys.length; j += 1) {
        const aKey = nodeKeys[i];
        const bKey = nodeKeys[j];
        const a = positions.get(aKey);
        const b = positions.get(bKey);
        const vector = subVec(b, a);
        const currentDistance = Math.max(lengthOf(vector), EPS);
        if (currentDistance >= minSeparation) continue;
        const push = ((minSeparation - currentDistance) / minSeparation) * 0.025;
        const direction = currentDistance > EPS ? mulVec(vector, 1 / currentDistance) : [1, 0];
        forces.set(aKey, subVec(forces.get(aKey), mulVec(direction, push * averageRest)));
        forces.set(bKey, addVec(forces.get(bKey), mulVec(direction, push * averageRest)));
      }
    }

    const step = 1 / (1 + iteration * 0.012);
    for (const key of nodeKeys) {
      const force = mulVec(forces.get(key), step);
      const moveLength = lengthOf(force);
      const cappedForce = moveLength > maxMove ? mulVec(force, maxMove / moveLength) : force;
      positions.set(key, addVec(positions.get(key), cappedForce));
    }
  }

  return positions;
}

function expandSkeletonPositions(graph, skeleton, skeletonPositions, transform) {
  const output = cloneGraph(graph);
  const nodeByKey = new Map(output.nodes.map((node) => [keyFor(node.id), node]));

  for (const [key, position] of skeletonPositions.entries()) {
    const node = nodeByKey.get(key);
    if (node) node.pos = [position[0], position[1]];
  }

  for (const edge of skeleton.edges) {
    const start = skeletonPositions.get(edge.u);
    const end = skeletonPositions.get(edge.v);
    if (!start || !end || edge.path.length <= 2) continue;

    let cumulativeLength = 0;
    for (let i = 1; i < edge.path.length - 1; i += 1) {
      cumulativeLength += edge.segmentLengths[i - 1] || 0;
      const t = Math.min(Math.max(cumulativeLength / edge.length, 0), 1);
      const node = nodeByKey.get(edge.path[i]);
      if (node) {
        node.pos = [
          start[0] + (end[0] - start[0]) * t,
          start[1] + (end[1] - start[1]) * t,
        ];
      }
    }
  }

  for (const node of output.nodes) {
    if (!Array.isArray(node.pos)) {
      const original = getNodePoint(node, 1) || [0, 0];
      node.pos = transform.apply(original);
    }
  }

  return output;
}

export function alignGraphToReference(resultGraph, referenceGraph, options = {}) {
  if (!resultGraph?.nodes?.length || !referenceGraph?.nodes?.length) {
    return cloneGraph(resultGraph);
  }

  const referenceYSign = options.referenceYSign ?? -1;
  const resultSkeleton = buildSkeleton(resultGraph, { ySign: 1 });
  const referenceSkeleton = buildSkeleton(referenceGraph, { ySign: referenceYSign });

  if (resultSkeleton.nodes.size === 0 || referenceSkeleton.nodes.size === 0) {
    return cloneGraph(resultGraph);
  }

  const matcher = createSkeletonMatcher(resultSkeleton, referenceSkeleton);
  const match = matcher.bestMatch();
  if (!match.nodeMatches.size) {
    return cloneGraph(resultGraph);
  }

  const landmarks = buildLandmarkSets(resultSkeleton, referenceSkeleton, match.nodeMatches);
  const transform = weightedProcrustes(landmarks.source, landmarks.target, landmarks.weights);
  const skeletonPositions = optimizeSkeletonLayout(resultSkeleton, referenceSkeleton, match, transform);

  return expandSkeletonPositions(resultGraph, resultSkeleton, skeletonPositions, transform);
}
