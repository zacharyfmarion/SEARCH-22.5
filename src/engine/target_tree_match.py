"""Exact topology and scale-normalized metric matching for extracted trees.

SEARCH-22.5 uses a spectral signature for approximate retrieval.  This module
is deliberately stricter: it enumerates graph isomorphisms and returns the
mapping with the smallest normalized edge-length error.  It is intended for
bounded synthesis experiments, not the production FAISS query path.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Hashable

import networkx as nx


@dataclass(frozen=True)
class MetricTreeMatch:
    """Best topology-preserving correspondence from target to candidate."""

    node_mapping: dict[Hashable, Hashable]
    rms_normalized_length_error: float
    max_normalized_length_error: float
    isomorphisms_examined: int
    search_truncated: bool


def validate_metric_tree(tree: nx.Graph) -> None:
    """Raise ``ValueError`` when ``tree`` is not a usable finite metric tree."""

    if tree.number_of_nodes() == 0:
        raise ValueError("metric tree must contain at least one node")
    if not nx.is_tree(tree):
        raise ValueError("metric tree must be connected and acyclic")
    for u, v, data in tree.edges(data=True):
        length = data.get("length")
        if not isinstance(length, (int, float)) or not math.isfinite(length) or length <= 0:
            raise ValueError(f"edge {(u, v)} has invalid length {length!r}")


def match_metric_trees(
    target: nx.Graph,
    candidate: nx.Graph,
    *,
    require_labels: bool = False,
    label_attribute: str = "label",
    max_isomorphisms: int = 100_000,
) -> MetricTreeMatch | None:
    """Return the metric-best graph isomorphism, or ``None`` for different trees.

    Edge lengths are divided by total tree length before comparison, making the
    score invariant to uniform scale.  When labels are required, every node
    must carry ``label_attribute`` and only equal labels may correspond.

    Symmetric trees can have many graph isomorphisms.  Stopping at the first is
    incorrect because different permutations of otherwise identical flaps can
    have different lengths, so the bounded spike explicitly minimizes across
    mappings.
    """

    validate_metric_tree(target)
    validate_metric_tree(candidate)
    if max_isomorphisms <= 0:
        raise ValueError("max_isomorphisms must be positive")
    if target.number_of_nodes() != candidate.number_of_nodes():
        return None

    node_match = None
    if require_labels:
        missing_target = [node for node, data in target.nodes(data=True) if label_attribute not in data]
        missing_candidate = [
            node for node, data in candidate.nodes(data=True) if label_attribute not in data
        ]
        if missing_target or missing_candidate:
            raise ValueError(
                f"required node label '{label_attribute}' is missing from "
                f"target={missing_target} candidate={missing_candidate}"
            )
        node_match = lambda left, right: left[label_attribute] == right[label_attribute]

    matcher = nx.algorithms.isomorphism.GraphMatcher(target, candidate, node_match=node_match)
    target_total = sum(data["length"] for _, _, data in target.edges(data=True))
    candidate_total = sum(data["length"] for _, _, data in candidate.edges(data=True))

    best: tuple[float, float, dict[Hashable, Hashable]] | None = None
    examined = 0
    truncated = False
    mappings = matcher.isomorphisms_iter()
    for mapping in mappings:
        examined += 1
        squared_error = 0.0
        max_error = 0.0
        for u, v, data in target.edges(data=True):
            candidate_length = candidate.edges[mapping[u], mapping[v]]["length"]
            error = abs(data["length"] / target_total - candidate_length / candidate_total)
            squared_error += error * error
            max_error = max(max_error, error)
        rms_error = math.sqrt(squared_error / target.number_of_edges())
        score = (rms_error, max_error)
        if best is None or score < best[:2]:
            best = (rms_error, max_error, dict(mapping))
        # Both error terms are non-negative, so an exact metric mapping is a
        # proven global optimum even when the topology has many symmetries.
        if rms_error <= 1.0e-15 and max_error <= 1.0e-15:
            break
        if examined >= max_isomorphisms:
            try:
                next(mappings)
            except StopIteration:
                pass
            else:
                truncated = True
            break

    if best is None:
        return None
    return MetricTreeMatch(
        node_mapping=best[2],
        rms_normalized_length_error=best[0],
        max_normalized_length_error=best[1],
        isomorphisms_examined=examined,
        search_truncated=truncated,
    )
