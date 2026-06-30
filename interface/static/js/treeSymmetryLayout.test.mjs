import assert from "node:assert/strict";
import { computeSymmetricTreeLayout } from "./treeSymmetryLayout.js";

const EPSILON = 1e-6;

function makeGraph(nodeIds, edgeSpecs) {
  return {
    nodes: nodeIds.map((id) => ({ id })),
    edges: edgeSpecs.map(([u, v, length, compId]) => ({
      u,
      v,
      length,
      ...(compId === undefined ? {} : { comp_id: compId }),
    })),
  };
}

function positionsById(graph) {
  return new Map(graph.nodes.map((node) => [node.id, node.pos]));
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function maxLengthError(sourceGraph, laidOutGraph) {
  const positions = positionsById(laidOutGraph);
  let maxError = 0;
  for (const edge of sourceGraph.edges) {
    maxError = Math.max(
      maxError,
      Math.abs(distance(positions.get(edge.u), positions.get(edge.v)) - edge.length)
    );
  }
  return maxError;
}

function assertLengthPreserved(sourceGraph, laidOutGraph) {
  assert.ok(maxLengthError(sourceGraph, laidOutGraph) < EPSILON);
}

function rectFacet(compId, x, y, halfWidth = 0.018, halfHeight = 0.018) {
  return {
    comp_id: compId,
    vertices: [
      [x - halfWidth, y - halfHeight],
      [x + halfWidth, y - halfHeight],
      [x + halfWidth, y + halfHeight],
      [x - halfWidth, y + halfHeight],
    ],
  };
}

function bookComponentMap({ pairs = [], fixed = [] }) {
  const facets = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const [leftComp, rightComp, x = 1 + index * 0.2, y = index * 0.25] = pairs[index];
    facets.push(rectFacet(leftComp, -Math.abs(x), y));
    facets.push(rectFacet(rightComp, Math.abs(x), y));
  }
  for (let index = 0; index < fixed.length; index += 1) {
    const [compId, y = -0.25 - index * 0.25] = Array.isArray(fixed[index])
      ? fixed[index]
      : [fixed[index]];
    facets.push(rectFacet(compId, 0, y));
  }
  return facets;
}

function assertOffAxis(parent, child) {
  assert.ok(Math.abs(parent[0] - child[0]) > 0.01);
}

function testFallbackWithoutComponentMap() {
  const graph = makeGraph(["root", "left", "right"], [
    ["root", "left", 1],
    ["root", "right", 1],
  ]);

  const laidOut = computeSymmetricTreeLayout(graph, { resultSymmetry: "book" });

  assert.ok(laidOut);
  assertLengthPreserved(graph, laidOut);
}

function testFallbackWhenCompIdsAreMissing() {
  const graph = makeGraph(["root", "left", "right"], [
    ["root", "left", 1],
    ["root", "right", 1],
  ]);

  const laidOut = computeSymmetricTreeLayout(graph, {
    resultSymmetry: "book",
    componentMap: bookComponentMap({ pairs: [[0, 1]] }),
  });

  assert.ok(laidOut);
  assertLengthPreserved(graph, laidOut);
}

function testOneAxisFixedInteriorFlap() {
  const graph = makeGraph([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [
    [0, 1, 1.0, 0],
    [1, 2, 1.0, 1],
    [0, 3, 0.5, 2],
    [0, 4, 0.5, 3],
    [1, 5, 0.7, 4],
    [1, 6, 0.7, 5],
    [2, 7, 0.5, 6],
    [2, 8, 0.5, 7],
    [1, 9, 0.3, 8],
  ]);

  const laidOut = computeSymmetricTreeLayout(graph, {
    resultSymmetry: "book",
    componentMap: bookComponentMap({
      pairs: [[2, 3], [4, 5], [6, 7]],
      fixed: [0, 1, 8],
    }),
  });

  assert.ok(laidOut);
  assertLengthPreserved(graph, laidOut);
  const positions = positionsById(laidOut);
  assertOffAxis(positions.get(1), positions.get(9));
}

function testTwoUnequalAxisFixedFlaps() {
  const graph = makeGraph([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [
    [0, 1, 1.0, 0],
    [1, 2, 1.0, 1],
    [0, 3, 0.5, 2],
    [0, 4, 0.5, 3],
    [1, 5, 0.7, 4],
    [1, 6, 0.7, 5],
    [2, 7, 0.5, 6],
    [2, 8, 0.5, 7],
    [1, 9, 0.25, 8],
    [1, 10, 1.4, 9],
  ]);

  const laidOut = computeSymmetricTreeLayout(graph, {
    resultSymmetry: "book",
    componentMap: bookComponentMap({
      pairs: [[2, 3], [4, 5], [6, 7]],
      fixed: [0, 1, 8, 9],
    }),
  });

  assert.ok(laidOut);
  assertLengthPreserved(graph, laidOut);
  const positions = positionsById(laidOut);
  assertOffAxis(positions.get(1), positions.get(9));
  assertOffAxis(positions.get(1), positions.get(10));
}

function testCpDisagreementRejectsAbstractSymmetry() {
  const graph = makeGraph(["root", "a", "b"], [
    ["root", "a", 1, 0],
    ["root", "b", 1, 1],
  ]);

  const laidOut = computeSymmetricTreeLayout(graph, {
    resultSymmetry: "book",
    componentMap: bookComponentMap({ pairs: [[0, 2], [1, 3]] }),
  });

  assert.equal(laidOut, null);
}

function test3b135UsesCpAxis() {
  const graph = makeGraph([0, 1, 4, 5, 6, 11, 12, 19, 20, 21, 22, 23, 24, 29, 30, 31, 32], [
    [0, 6, 0.3535533905932738, 0],
    [1, 6, 0.3535533905932738, 1],
    [4, 19, 0.1464466094067262, 2],
    [5, 19, 0.1464466094067262, 3],
    [6, 20, 0.1464466094067262, 4],
    [6, 21, 0.1464466094067262, 5],
    [11, 22, 0.08578643762690485, 6],
    [12, 22, 0.08578643762690485, 7],
    [19, 21, 0.06066017177982136, 8],
    [19, 23, 0.06066017177982136, 9],
    [21, 24, 0.06066017177982136, 10],
    [22, 24, 0.06066017177982136, 11],
    [23, 29, 0.08578643762690485, 12],
    [23, 30, 0.08578643762690485, 13],
    [24, 31, 0.1464466094067262, 14],
    [24, 32, 0.1464466094067262, 15],
  ]);

  const laidOut = computeSymmetricTreeLayout(graph, {
    resultSymmetry: "book",
    componentMap: bookComponentMap({
      pairs: [[0, 1], [8, 10], [2, 14], [3, 15], [9, 11], [12, 6], [13, 7]],
      fixed: [4, 5],
    }),
  });

  assert.ok(laidOut);
  assertLengthPreserved(graph, laidOut);

  const positions = positionsById(laidOut);
  const p19 = positions.get(19);
  const p21 = positions.get(21);
  const p24 = positions.get(24);
  assert.ok(Math.abs((p19[0] - p21[0]) + (p24[0] - p21[0])) < EPSILON);
  assert.ok(Math.abs((p19[1] - p21[1]) - (p24[1] - p21[1])) < EPSILON);
}

testFallbackWithoutComponentMap();
testFallbackWhenCompIdsAreMissing();
testOneAxisFixedInteriorFlap();
testTwoUnequalAxisFixedFlaps();
testCpDisagreementRejectsAbstractSymmetry();
test3b135UsesCpAxis();

console.log("treeSymmetryLayout tests passed");
