# Target-conditioned synthesis spike

## Question

Can SEARCH-22.5 replace approximate CWKS retrieval with a deterministic oracle
that accepts only candidates whose extracted metric tree has the requested
topology and sufficiently close edge proportions?

## First experiment

`target_conditioned_db_spike.py` uses existing tiling databases rather than
regenerating topologies. It reconstructs each CP, rejects remaining Kawasaki
errors, extracts the folded tree, and verifies that extraction against the tree
stored in the database. It then performs leave-one-out exact matching so the
source tiling cannot retrieve itself.

Run the complete small corpus:

```bash
.venv/bin/python research/target_conditioned_db_spike.py \
  --db-dir /path/to/explori_db \
  --glob 'tilings_2_*.db' \
  --targets research/target_tree_fixtures.json \
  --output /tmp/search225-target-spike.json
```

## Interpretation

- Reconstruction mismatches indicate the stored tiling is not a stable lossless
  representation of the extracted tree.
- Remaining Kawasaki errors quantify candidates that the current database
  pipeline accepted without complete local flat-foldability.
- Exact-topology leave-one-out matches show whether the archive has redundant
  realizations suitable for metric optimization.
- Targets without another topology match are evidence that generate-and-test
  will need target constraints earlier in topology enumeration.

This is not yet a proof of forward synthesis. Stored trees are unlabeled, and
the current engine does not solve MV satisfiability or layer order. The next
experiment should use novel labeled target trees and condition topology search
on junction/component constraints.

## Complete N=2 result

The first run used all three complete N=2 databases: book, diagonal, and no
symmetry. Together they contain 126 tilings.

| Measurement | Result |
| --- | ---: |
| Non-empty candidates accepted | 123 / 126 |
| Stored empty trees | 3 / 126 |
| Remaining Kawasaki failures | 0 / 123 |
| Stored/extracted topology mismatches | 0 / 123 |
| Stored/extracted metric mismatches | 0 / 123 |
| Sampled leave-one-out topology retrievals | 10 / 12 |
| Leave-one-out matches within 1% maximum normalized error | 7 / 12 |
| Leave-one-out matches within 5% maximum normalized error | 8 / 12 |

This supports using the stored tiling as a stable reconstruction source for
non-empty N=2 entries. It also shows that exact target topology is already a
meaningful discriminator: two sampled archive targets had no second candidate
with the same topology even in the complete N=2 corpus. Approximate spectral
retrieval hides that absence.

The run also exposed factorial ambiguity for symmetric unlabeled trees. The
matcher must optimize over flap permutations rather than accept the first graph
isomorphism; it now terminates immediately when it proves a zero-error mapping.

## Novel N=2 target result

Four hand-authored target trees were compared against the 123 non-empty N=2
candidates. Labels describe intended flap identity but are ignored for this
archive baseline because stored trees are unlabeled.

| Target | Exact-topology candidates | Best maximum normalized length error |
| --- | ---: | ---: |
| Equal tripod | 2 | 25.25% |
| Asymmetric quadruped | 2 | 6.19% |
| Double tripod | 0 | no match |
| Three-junction chain | 1 | 10.90% |

This is negative evidence for using a small blind archive as a forward solver.
Even very small target trees may be absent, and topology matches can have poor
metric proportions. The next coverage scan should use the larger N=6 archive;
`--stored-only --skip-leave-one-out` avoids rebuilding thousands of CPs during
that scan. Any selected winners must subsequently be reconstructed and checked.

## N=6 book-symmetry coverage result

The stored-tree-only scan loaded all 4,765 available N=6 book-symmetric
candidates. None of the four small target topologies appeared in that archive.
This does not mean larger N is less expressive: the sampled N=6 archive is not
complete and its generated axial graphs produce substantially more complex
trees. It does show that increasing N is not a monotonic replacement for
searching the smaller topology classes. A practical archive lookup must search
across resolutions, while a forward solver should derive a complexity bound
from the requested tree instead of assuming a single large N covers it.

## From-scratch generation baseline

`target_conditioned_generate_spike.py` closes the first end-to-end loop without
using a tiling database. Given any target fixture, it enumerates axial
topologies with Z3, realizes each topology with the existing MILP, builds and
folds the CP, rejects remaining Kawasaki errors, and accepts only an exact tree
topology match.

```bash
.venv/bin/python research/target_conditioned_generate_spike.py \
  --targets research/target_tree_fixtures.json \
  --target equal_tripod --N 2 --symmetry none \
  --max-topologies 80 --output /tmp/search225-tripod-generation.json
```

This baseline is intentionally brute-force. Its result tells us how much work
is wasted before the first target match and gives a measurable baseline for the
next change: target-derived pruning inside topology enumeration.

The equal-tripod baseline found an exact-topology CP after two enumerated
topologies and 0.24 seconds. The CP had no remaining Kawasaki errors, but its
worst normalized flap-length error was 16.18%. This confirms that topology and
metric targeting are separate stages.

The double-tripod baseline exhausted all 80 N=2 no-symmetry topologies in 4.69
seconds. It realized 79 tilings, rejected one empty tree extraction, and found
no topology match. This agrees with the complete archive scan and gives a clear
negative control for future topology constraints.
