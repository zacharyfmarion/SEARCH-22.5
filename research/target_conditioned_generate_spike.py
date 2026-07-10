#!/usr/bin/env python3
"""Generate bounded SEARCH-22.5 candidates until one matches a target tree.

This is the deliberately simple baseline for forward synthesis. It does not use
the precomputed tiling archive: Z3 enumerates axial topologies, the existing
MILP realizes them, and the existing CP/fold pipeline extracts each result.
Only candidates with no remaining Kawasaki errors and exact target topology are
accepted.

Example:
    .venv/bin/python research/target_conditioned_generate_spike.py \
      --targets research/target_tree_fixtures.json --target equal_tripod \
      --N 2 --symmetry none --max-topologies 80 --output /tmp/tripod.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time

import networkx as nx

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.engine.fold225 import cp_to_fold
from src.engine.target_tree_match import match_metric_trees
from src.engine.tiling2cp import add_hinges, build_crease_pattern
from src.engine.topology225 import enumerate_graphs, get_canonical_hash
from src.engine.topology2tiling import solve_tiling


def load_target(path: Path, name: str) -> nx.Graph:
    payload = json.loads(path.read_text(encoding="utf-8"))
    record = next((item for item in payload["targets"] if item["name"] == name), None)
    if record is None:
        available = ", ".join(item["name"] for item in payload["targets"])
        raise ValueError(f"unknown target '{name}'; available targets: {available}")
    tree = nx.Graph(name=name)
    for node in record["nodes"]:
        tree.add_node(node["id"], label=node.get("label", node["id"]))
    for edge in record["edges"]:
        tree.add_edge(*edge["nodes"], length=float(edge["length"]))
    return tree


def topology_key(graph: nx.Graph, n: int) -> list:
    return [
        [[int(a[0]), int(a[1])], [int(b[0]), int(b[1])]]
        for a, b in get_canonical_hash(list(graph.edges()), n)
    ]


def generate_for_target(
    target: nx.Graph,
    *,
    n: int,
    symmetry: str,
    max_topologies: int,
    time_limit: int,
    max_matches: int,
) -> dict:
    started = time.perf_counter()
    counts = {
        "topologies_enumerated": 0,
        "topologies_solved": 0,
        "tilings_realized": 0,
        "cp_failures": 0,
        "remaining_kawasaki_failures": 0,
        "tree_extraction_failures": 0,
        "tree_topology_mismatches": 0,
        "tree_topology_matches": 0,
    }
    matches = []

    for topology_index, graph in enumerate(enumerate_graphs(N=n, symmetry=symmetry), start=1):
        if topology_index > max_topologies:
            break
        counts["topologies_enumerated"] += 1
        try:
            outputs = solve_tiling(
                graph,
                symmetry=symmetry,
                N=n,
                verbose=False,
                time_limit=time_limit,
                diversity_threshold=1,
                num_solutions=1,
            )
        except Exception as error:  # Keep the bounded experiment running.
            print(
                f"topology {topology_index}: solve failed: {type(error).__name__}: {error}",
                file=sys.stderr,
            )
            continue
        if not outputs:
            continue
        counts["topologies_solved"] += 1

        for graph_solved, _, positions, faces, _ in outputs:
            counts["tilings_realized"] += 1
            try:
                cp = add_hinges(
                    build_crease_pattern(graph_solved, positions, faces, N=n, verbose=False)
                )
            except Exception as error:
                counts["cp_failures"] += 1
                print(
                    f"topology {topology_index}: CP failed: {type(error).__name__}: {error}",
                    file=sys.stderr,
                )
                continue

            kawasaki_errors = cp.kawasaki_errors()
            if kawasaki_errors:
                counts["remaining_kawasaki_failures"] += 1
                continue
            try:
                extracted = cp_to_fold(cp).get_tree_and_packing()[0]
                match = match_metric_trees(target, extracted)
            except Exception as error:
                counts["tree_extraction_failures"] += 1
                print(
                    f"topology {topology_index}: extraction failed: "
                    f"{type(error).__name__}: {error}",
                    file=sys.stderr,
                )
                continue
            if match is None:
                counts["tree_topology_mismatches"] += 1
                continue

            counts["tree_topology_matches"] += 1
            matches.append(
                {
                    "topology_index": topology_index,
                    "topology_key": topology_key(graph, n),
                    "cp_vertices": len(cp.vertices),
                    "cp_edges": len(cp.edges),
                    "extracted_nodes": extracted.number_of_nodes(),
                    "extracted_edges": extracted.number_of_edges(),
                    "rms_normalized_length_error": match.rms_normalized_length_error,
                    "max_normalized_length_error": match.max_normalized_length_error,
                    "isomorphisms_examined": match.isomorphisms_examined,
                }
            )
            if len(matches) >= max_matches:
                return {
                    "counts": counts,
                    "matches": matches,
                    "elapsed_seconds": time.perf_counter() - started,
                    "stopped": "match_limit",
                }

    return {
        "counts": counts,
        "matches": matches,
        "elapsed_seconds": time.perf_counter() - started,
        "stopped": "topology_limit_or_exhaustion",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--targets", type=Path, required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--N", type=int, default=2)
    parser.add_argument("--symmetry", choices=("none", "book", "diag"), default="none")
    parser.add_argument("--max-topologies", type=int, default=80)
    parser.add_argument("--time-limit", type=int, default=5)
    parser.add_argument("--max-matches", type=int, default=1)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    target = load_target(args.targets, args.target)
    result = generate_for_target(
        target,
        n=args.N,
        symmetry=args.symmetry,
        max_topologies=args.max_topologies,
        time_limit=args.time_limit,
        max_matches=args.max_matches,
    )
    report = {
        "schema": "search-22.5/target-conditioned-generation-spike/v1",
        "target": args.target,
        "target_nodes": target.number_of_nodes(),
        "target_edges": target.number_of_edges(),
        "N": args.N,
        "symmetry": args.symmetry,
        **result,
    }
    rendered = json.dumps(report, indent=2, sort_keys=True)
    print(rendered)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
