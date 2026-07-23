# Decision eval suites (`.archon/evals/decision-*`)

Datasets for the **`decision-eval-suite`** workflow — the decision-quality sibling of
`standing-eval-suite`. Where the standing suite gates **code** against a 5-dimension
rubric, this gates **architectural decisions / success-contracts** against a
6-dimension rubric: a plan, ADR, or "we will build X; done means Y; verified by Z"
statement is scored for the class of defects that sink implementations one level up —
scope creep, unfalsifiable "done", gameable acceptance clauses, solving the wrong
problem, house-rule violations, and irreversible blast radius.

It reuses the dimension-agnostic `eval-load-suite` + `eval-aggregate` scripts verbatim;
only the rubric (`suite.json`), the judge prompt (`decision-eval-suite.yaml`), and the
cases differ.

```
.archon/evals/decision-<suite>/
  suite.json       # 6-dim rubric + weights + thresholds ("kind": "decision")
  cases/*.yaml     # one labelled case each (task / candidate / reference)
  baseline.json    # OPTIONAL, COMMITTED: blessed mean_by_dim from an accepted run
  labels.json      # OPTIONAL: detection labels for failure-derived DEFECT cases
```

Shipped suites:
- `decision-seed` — small default smoke suite (a strong + a weak contract).
- `decision-calibration` — 12 labelled cases + `human-labels.json`, for validating the
  judge (see `DECISION-CALIBRATION.md`).
- `decision-regressions` — real escaped-decision failures with an inverted detection
  gate (the flywheel).

## Run it

The shared scripts default `EVAL_SUITE` to `seed` — a **code** suite. Decision runs
**must** select a `decision-*` suite:

```bash
EVAL_SUITE=decision-seed        bun run cli workflow run decision-eval-suite
EVAL_SUITE=decision-calibration bun run cli workflow run decision-eval-suite
EVAL_SUITE=decision-regressions bun run cli workflow run decision-eval-suite
```

If pointed at a code suite by mistake, the judge's self-check flags it and the
aggregate fails loud on a dimension mismatch — never a silent wrong PASS.

Outputs: a per-run `scorecard.json` in the run's artifacts dir, plus one trend line
appended to `.archon/state/eval-history.jsonl` (gitignored).

## Case schema (`cases/*.yaml`)

```yaml
id: kebab-unique-id           # unique within the suite
tags: [area, note]
task: |                       # the SITUATION / what was asked (neutral context)
candidate: |                  # the proposed decision/contract under test
reference: |                  # what a SOUND decision looks like — BLIND (ideal-only)
```

## The 6 dimensions (scored 1-5; 5 = excellent, 1 = absent/broken)

| dimension | weight | what it catches |
|---|---|---|
| `problem_fit` | 0.22 | wrong-problem, broken causal reasoning, unstated false assumptions |
| `scope_discipline` | 0.18 | scope creep, speculative abstraction, gold-plating |
| `verifiability` | 0.22 | unfalsifiable "done", success with no concrete check method |
| `gameability_resistance` | 0.18 | acceptance clauses satisfiable by stubs/tautologies/happy-path |
| `principle_alignment` | 0.12 | violations of standing constraints (single-tenant, KISS/YAGNI, fail-fast, no autonomous cross-process mutation, type-safety, git-safety) |
| `reversibility` | 0.08 | irreversible/all-or-nothing changes with no rollback named |

The judge prompt carries **mandatory inspections** (trace every commitment to a stated
need; every success criterion must be able to *fail*; construct the laziest passing
implementation) and the standing constraints are embedded so the blind judge scores
`principle_alignment` without reading `CLAUDE.md`. Weights + thresholds live in
`suite.json`.

## N-vote judging

Every run casts **3 independent fresh-context judge votes** (`score-1/2/3`, identical
prompts); the `aggregate` node takes the per-case-per-dimension **median** to de-flake
single-vote ±1 wobble, and enforces **queue identity** (every queued case scored
exactly once per vote). Scorecards record `votes: N`.

## Gate logic (deterministic, in the `aggregate` node)

PASS only if ALL hold:
- weighted `overall` ≥ `thresholds.overall_min`
- every dimension mean ≥ `thresholds.dim_floor`
- no case whose worst dimension < `thresholds.case_min`
- (if `baseline.json` present) no dimension regressed beyond `regression_tolerance`
- (if `labels.json` present) no detection miss (below)

## Failure-derived regression cases (`labels.json` — the flywheel)

`decision-regressions` holds cases whose `candidate:` is a REAL decision failure that
escaped review once. For those the gate INVERTS — success means the judge **catches**
the defect:

- `labels.json` maps case id → `{ "trap_dim": "<dimension>", "max_score": 2, "source": "<what escaped + date>" }`
- a labelled case passes when its **median** score on `trap_dim` is `<= max_score`;
  anything higher is a `detection_miss` → gate FAIL (the judge has a blind spot)
- labelled cases are **excluded** from the mean/threshold math

**Blindness rules (mandatory):** a case YAML's `reference:` describes ONLY what a sound
decision looks like — never the defect, the trap dimension, or an expected score.
Labels live in `labels.json`, which judges are prompt-mandated (and tool-restricted)
never to read. Raising `max_score` to make a miss pass is gaming your own gate — a
detection miss is a real finding; fix the rubric/judge or accept the RED.

**Adding a case:** drop a `cases/<slug>.yaml` (blind), add a `labels.json` entry with
`trap_dim` + `max_score` + a one-line `source`, then run
`EVAL_SUITE=decision-regressions bun run cli workflow run decision-eval-suite` — the new
case must be CAUGHT before you trust it as a guard.

## Bless a baseline

After an accepted run, copy its scorecard's `mean_by_dim` into
`decision-<suite>/baseline.json` and commit it; every later run is then checked for
regressions against it.

## Live gate (decision-gate)

The standing suites above regression-guard the *judge* over time. To flow a single
*live* decision through the same judge at decision-time, see `decision-gate` (scores one
supplied contract file and returns PASS/FAIL + blocking reasons) — the "just like code
does" half.
