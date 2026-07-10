import unittest

import networkx as nx

from src.engine.target_tree_match import match_metric_trees, validate_metric_tree


def metric_tree(edges, labels=None):
    graph = nx.Graph()
    for u, v, length in edges:
        graph.add_edge(u, v, length=length)
    if labels is not None:
        nx.set_node_attributes(graph, labels, "label")
    return graph


class TargetTreeMatchTests(unittest.TestCase):
    def test_unlabeled_match_chooses_metric_best_symmetric_permutation(self):
        target = metric_tree([(0, 1, 1.0), (0, 2, 2.0), (0, 3, 3.0)])
        candidate = metric_tree([(9, 7, 6.0), (9, 8, 2.0), (9, 6, 4.0)])

        result = match_metric_trees(target, candidate)

        self.assertIsNotNone(result)
        self.assertAlmostEqual(result.rms_normalized_length_error, 0.0)
        self.assertEqual(result.node_mapping[0], 9)
        self.assertEqual(result.node_mapping[1], 8)

    def test_label_requirement_preserves_flap_identity(self):
        labels = {0: "body", 1: "head", 2: "tail"}
        target = metric_tree([(0, 1, 1.0), (0, 2, 2.0)], labels)
        candidate = metric_tree([(5, 6, 2.0), (5, 7, 1.0)], {5: "body", 6: "head", 7: "tail"})

        unlabeled = match_metric_trees(target, candidate)
        labeled = match_metric_trees(target, candidate, require_labels=True)

        self.assertAlmostEqual(unlabeled.rms_normalized_length_error, 0.0)
        self.assertGreater(labeled.rms_normalized_length_error, 0.0)

    def test_nonisomorphic_tree_returns_none(self):
        path = metric_tree([(0, 1, 1.0), (1, 2, 1.0), (2, 3, 1.0)])
        star = metric_tree([(0, 1, 1.0), (0, 2, 1.0), (0, 3, 1.0)])

        self.assertIsNone(match_metric_trees(path, star))

    def test_exact_metric_match_stops_before_enumerating_all_symmetries(self):
        target = metric_tree([(0, 1, 1.0), (0, 2, 1.0), (0, 3, 1.0), (0, 4, 1.0)])
        candidate = metric_tree([(9, 5, 2.0), (9, 6, 2.0), (9, 7, 2.0), (9, 8, 2.0)])

        result = match_metric_trees(target, candidate)

        self.assertEqual(result.rms_normalized_length_error, 0.0)
        self.assertEqual(result.isomorphisms_examined, 1)
        self.assertFalse(result.search_truncated)

    def test_invalid_metric_length_is_rejected(self):
        graph = metric_tree([(0, 1, 0.0)])

        with self.assertRaisesRegex(ValueError, "invalid length"):
            validate_metric_tree(graph)


if __name__ == "__main__":
    unittest.main()
