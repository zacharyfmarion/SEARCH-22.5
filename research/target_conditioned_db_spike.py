#!/usr/bin/env python3
"""Run a bounded target-conditioned experiment over existing ExplOri DBs.

The experiment answers three questions without changing the production query:

1. Does reconstructing a stored tiling still produce a fully Kawasaki-valid CP?
2. Does the freshly extracted tree exactly match the tree stored in the DB?
3. After excluding the source candidate, how often does the bounded archive
   contain another exact-topology tree with a close metric match?

Example:
    .venv/bin/python research/target_conditioned_db_spike.py \
      --db-dir /path/to/explori_db --glob 'tilings_2_*.db' --output report.json
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import pickle
import sqlite3
import sys

import networkx as nx

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.engine.fold225 import cp_to_fold
from src.engine.target_tree_match import match_metric_trees
from src.engine.tiling2cp import add_hinges, build_crease_pattern, load_frozen_blob


@dataclass
class Candidate:
    database: str
    tiling_id: int
    tree: nx.Graph
    cp_vertices: int | None
    cp_edges: int | None


def parse_database_name(path: Path) -> tuple[int, str]:
    parts = path.stem.split("_", 2)
    if len(parts) != 3 or parts[0] != "tilings":
        raise ValueError(f"expected tilings_N_symmetry.db, received {path.name}")
    return int(parts[1]), parts[2]


def load_candidates(
    db_paths: list[Path], limit_per_db: int | None, *, reconstruct: bool
) -> tuple[list[Candidate], dict]:
    candidates: list[Candidate] = []
    summary = {
        "rows": 0,
        "reconstruction_errors": 0,
        "empty_stored_trees": 0,
        "empty_extracted_trees": 0,
        "remaining_kawasaki_errors": 0,
        "stored_tree_topology_mismatches": 0,
        "stored_tree_metric_mismatches": 0,
        "metric_match_truncations": 0,
        "stored_only": not reconstruct,
    }

    for db_path in db_paths:
        n, _ = parse_database_name(db_path)
        query = "SELECT id, tiling_blob, embedding FROM tilings ORDER BY id"
        params: tuple[int, ...] = ()
        if limit_per_db is not None:
            query += " LIMIT ?"
            params = (limit_per_db,)
        with sqlite3.connect(db_path) as connection:
            rows = connection.execute(query, params).fetchall()

        for tiling_id, tiling_blob, stored_tree_blob in rows:
            summary["rows"] += 1
            try:
                stored_tree = pickle.loads(stored_tree_blob)
                if stored_tree.number_of_nodes() == 0:
                    summary["empty_stored_trees"] += 1
                    continue
                if not reconstruct:
                    candidates.append(
                        Candidate(
                            database=db_path.name,
                            tiling_id=tiling_id,
                            tree=stored_tree,
                            cp_vertices=None,
                            cp_edges=None,
                        )
                    )
                    continue
                graph, positions, faces = load_frozen_blob(pickle.loads(tiling_blob))
                cp = add_hinges(build_crease_pattern(graph, positions, faces, N=n, verbose=False))
                kawasaki_errors = cp.kawasaki_errors()
                if kawasaki_errors:
                    summary["remaining_kawasaki_errors"] += 1
                    continue
                extracted_tree = cp_to_fold(cp).get_tree_and_packing()[0]
                if extracted_tree.number_of_nodes() == 0:
                    summary["empty_extracted_trees"] += 1
                    continue
                reconstruction_match = match_metric_trees(stored_tree, extracted_tree)
                if reconstruction_match is None:
                    summary["stored_tree_topology_mismatches"] += 1
                    continue
                if reconstruction_match.search_truncated:
                    summary["metric_match_truncations"] += 1
                if reconstruction_match.max_normalized_length_error > 1.0e-9:
                    summary["stored_tree_metric_mismatches"] += 1
                candidates.append(
                    Candidate(
                        database=db_path.name,
                        tiling_id=tiling_id,
                        tree=extracted_tree,
                        cp_vertices=len(cp.vertices),
                        cp_edges=len(cp.edges),
                    )
                )
            except Exception as error:  # The report must retain per-row failures.
                summary["reconstruction_errors"] += 1
                print(
                    f"reconstruction failed for {db_path.name}:{tiling_id}: "
                    f"{type(error).__name__}: {error}",
                    file=sys.stderr,
                )
    summary["accepted_candidates"] = len(candidates)
    if not reconstruct:
        for key in (
            "empty_extracted_trees",
            "metric_match_truncations",
            "reconstruction_errors",
            "remaining_kawasaki_errors",
            "stored_tree_metric_mismatches",
            "stored_tree_topology_mismatches",
        ):
            summary[key] = None
    return candidates, summary


def select_targets(candidates: list[Candidate], maximum: int) -> list[Candidate]:
    if maximum <= 0 or maximum >= len(candidates):
        return candidates
    if maximum == 1:
        return [candidates[0]]
    return [
        candidates[round(index * (len(candidates) - 1) / (maximum - 1))]
        for index in range(maximum)
    ]


def run_leave_one_out(candidates: list[Candidate], maximum_targets: int) -> dict:
    target_results = []
    for target in select_targets(candidates, maximum_targets):
        best = None
        topology_matches = 0
        for candidate in candidates:
            if (candidate.database, candidate.tiling_id) == (target.database, target.tiling_id):
                continue
            match = match_metric_trees(target.tree, candidate.tree)
            if match is None:
                continue
            topology_matches += 1
            key = (match.rms_normalized_length_error, match.max_normalized_length_error)
            if best is None or key < best[0]:
                best = (key, candidate, match)

        row = {
            "target": f"{target.database}:{target.tiling_id}",
            "topology_matches": topology_matches,
            "best": None,
        }
        if best is not None:
            _, candidate, match = best
            row["best"] = {
                "candidate": f"{candidate.database}:{candidate.tiling_id}",
                "rms_normalized_length_error": match.rms_normalized_length_error,
                "max_normalized_length_error": match.max_normalized_length_error,
                "isomorphisms_examined": match.isomorphisms_examined,
                "search_truncated": match.search_truncated,
            }
        target_results.append(row)

    matched = [row for row in target_results if row["best"] is not None]
    return {
        "targets": len(target_results),
        "exact_topology_retrievals": len(matched),
        "within_1_percent_max_normalized_error": sum(
            row["best"]["max_normalized_length_error"] <= 0.01 for row in matched
        ),
        "within_5_percent_max_normalized_error": sum(
            row["best"]["max_normalized_length_error"] <= 0.05 for row in matched
        ),
        "results": target_results,
    }


def load_target_trees(path: Path) -> list[tuple[str, nx.Graph]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    targets = []
    for record in payload["targets"]:
        tree = nx.Graph()
        for node in record["nodes"]:
            tree.add_node(node["id"], label=node.get("label", node["id"]))
        for edge in record["edges"]:
            tree.add_edge(*edge["nodes"], length=float(edge["length"]))
        targets.append((record["name"], tree))
    return targets


def run_external_targets(targets: list[tuple[str, nx.Graph]], candidates: list[Candidate]) -> dict:
    results = []
    for name, target in targets:
        matches = []
        for candidate in candidates:
            match = match_metric_trees(target, candidate.tree)
            if match is not None:
                matches.append((match.rms_normalized_length_error, match.max_normalized_length_error, candidate, match))
        matches.sort(key=lambda item: item[:2])
        best = None
        if matches:
            rms_error, max_error, candidate, match = matches[0]
            best = {
                "candidate": f"{candidate.database}:{candidate.tiling_id}",
                "rms_normalized_length_error": rms_error,
                "max_normalized_length_error": max_error,
                "isomorphisms_examined": match.isomorphisms_examined,
                "search_truncated": match.search_truncated,
            }
        results.append(
            {
                "target": name,
                "nodes": target.number_of_nodes(),
                "leaves": sum(degree == 1 for _, degree in target.degree()),
                "topology_matches": len(matches),
                "best": best,
            }
        )
    return {"targets": len(results), "results": results}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-dir", type=Path, required=True)
    parser.add_argument("--glob", default="tilings_2_*.db")
    parser.add_argument("--limit-per-db", type=int)
    parser.add_argument("--max-targets", type=int, default=12)
    parser.add_argument("--skip-leave-one-out", action="store_true")
    parser.add_argument(
        "--stored-only",
        action="store_true",
        help="Use cached extracted trees without reconstructing CPs; useful for large coverage scans",
    )
    parser.add_argument("--targets", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    db_paths = sorted(args.db_dir.glob(args.glob))
    if not db_paths:
        parser.error(f"no databases matched {args.db_dir / args.glob}")

    candidates, validation = load_candidates(
        db_paths, args.limit_per_db, reconstruct=not args.stored_only
    )
    report = {
        "schema": "search-22.5/target-conditioned-db-spike/v1",
        "databases": [path.name for path in db_paths],
        "validation": validation,
        "leave_one_out": (
            None if args.skip_leave_one_out else run_leave_one_out(candidates, args.max_targets)
        ),
        "external_targets": (
            run_external_targets(load_target_trees(args.targets), candidates)
            if args.targets is not None
            else None
        ),
        "known_limitations": [
            "stored trees contain no flap labels, so matching is unlabeled",
            "Kawasaki is checked, but MV satisfiability and layer order are not solved",
            "archive targets measure exact retrieval behavior, not novel user-tree synthesis",
            "external target labels are retained in fixtures but ignored by the unlabeled archive matcher",
        ],
    }
    rendered = json.dumps(report, indent=2, sort_keys=True)
    print(rendered)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
