# Handoff: Definition-of-Done Gate (increment #1 of the trustworthy autonomous loop)

**Date:** 2026-07-05
**Branch:** feat/standing-eval-suite
**Last Commit:** see below — my work is committed as a checkpoint on this branch (DoD gate + PRD + this handoff)

## Goal

Make an unattended coding loop _safe_ for a non-coder (who ships via specs + smoke tests and
cannot read diffs). Derived design + built the first increment: a **Definition-of-Done Gate** —
a deterministic, independently-re-run, un-gameable verifier that hard-blocks the loop before
push/PR. Full design (missing-capabilities A, first-increment B, PRD C, operator-decisions D)
lives in `.claude/PRPs/autonomous-loop-prd.md`.

## Completed

- [x] Design PRD (A–D) derived independently from the 6 failure modes → `.claude/PRPs/autonomous-loop-prd.md`
- [x] Built the DoD Gate:
  - `.archon/scripts/dod-gate.ts` — check-runner + test-efficacy revert-probe + verdict emitter (no LLM in pass/fail)
  - `.archon/workflows/experimental/archon-dod-gate.yaml` — thin standalone workflow (append `dod-gate` as any build loop's last node)
- [x] Verified (all green): 3 smoke scenarios (real→PASS, broken→FAIL, vacuous-test→FAIL),
      R6 determinism (identical verdict × 2 runs), R3 self-scoped (grep: zero run/DB queries),
      working tree restored clean each run, `cli validate workflows archon-dod-gate` → ok
- [x] Fixed 2 real bugs found during verify (see Dead Ends)

## In Progress / Next Steps

- [ ] **Increment #2 — Work-claim / in-flight ledger keyed by task intent (FM4).** Two orchestration
      contexts built the SAME feature blind because the only lock is _path_-level
      (`getActiveWorkflowRunByPath` in `packages/core/src/db/workflows.ts`) — two loops on the same
      feature use _different_ worktrees, so it doesn't catch them. Needs a claim keyed by normalized
      task identity (issue #, task slug), checked before work starts, surfaced on collision.
      Do this as a fresh-context PRD first (falsifiable spec, same discipline as increment #1), then build.
- [ ] Confirm/override the 2 still-open operator decisions from the PRD: **D2** (UNVERIFIED → FAIL-closed,
      currently `DOD_STRICT=1`) and **D4** (on FAIL: fix-retry then hard-stop, no "approve anyway" button).
- [ ] (Optional) Consider moving the DoD gate to its own branch/PR — it's thematically part of the
      standing-verifier line but is a distinct feature from standing-eval-suite.

## Key Decisions

- **DoD gate is increment #1** — a loop _amplifies its verifier_; fix the verifier or the loop
  industrializes plausible-looking breakage. It's the only capability that stops the one event a
  non-coder can't survive (told "done", ships broken). Absorbs the safety slices of FM3 (self-scoped
  reads) and FM5 (non-zero-exit hard-stop) too.
- **Revert-probe = the un-gameable core** — revert only non-test source, re-run tests; if nothing
  flips red the tests are vacuous → FAIL. Deterministic; no LLM in the decision (the calibrated
  judge stays in standing-eval-suite, deliberately separate).
- **JSON is the canonical spec format** (`.archon/dod/<task>.json`) — dependency-free/portable;
  YAML is best-effort only (see Dead End #2).
- **FAIL-closed (D2) + hard-stop-no-override (D4)** — for a non-coder, "couldn't verify" must mean
  "stop", and there must be no button that lets broken work be rubber-stamped to unblock.
- **Reuse, don't rebuild** — the gate is just a named `script:` node over `$ARTIFACTS_DIR`/`$WORKFLOW_ID`;
  the existing path-lock is reserved for increment #2, not duplicated.

## Dead Ends (Don't Repeat These)

- **Whole-tree `git status --porcelain` clean-check** — false-positived on untracked spec/artifacts
  and Windows CRLF renormalization, so the revert-probe never ran. Fix: scope the guard to _only the
  non-test files being reverted_, ignore untracked, pin `core.autocrlf=false` on the gate's git calls.
- **`require('yaml')` for YAML specs** — resolves from the script's module path, NOT guaranteed present
  in an arbitrary target repo → YAML specs silently FAILed. Fix: JSON canonical; YAML best-effort with
  a clear error. Don't reintroduce a hard YAML dep in a portable script.

## Files Changed

- `.archon/scripts/dod-gate.ts` — NEW: the deterministic DoD gate (self-contained, node builtins only)
- `.archon/workflows/experimental/archon-dod-gate.yaml` — NEW: standalone gate workflow
- `.claude/PRPs/autonomous-loop-prd.md` — NEW: full design (A–D)
- `HANDOFF-dod-gate.md` — NEW: this file

## Current State

- **Gate behavior:** proven via 3 temp-repo smoke scenarios + determinism + self-scoped grep — all pass
- **Workflow validation:** `archon-dod-gate` → ok (1 valid, 0 errors)
- **Type-check/lint:** not run repo-wide; `dod-gate.ts` is a standalone bun script (like the `eval-*.ts`
  scripts), runs clean under bun. It is NOT bundled (experimental) → no `generate:bundled` needed.
- **Tests:** no unit tests added (verification is the smoke harness); a fresh context could add a
  `.test.ts` for the glob/partition/base-resolution helpers if desired.

## Context for Next Session

The DoD gate is built, verified, and committed on `feat/standing-eval-suite`. The trust anchor for
autonomy now exists. The next unit of leverage is **increment #2 (work-claim ledger, FM4)** — required
the moment more than one loop runs concurrently. Continue in a FRESH context (this one accumulated
design+build+debug bias): first derive a falsifiable PRD for the ledger, grounded in the existing
path-lock (`getActiveWorkflowRunByPath`) and `workflow_runs` schema, then gate it with the operator
before building.

**Recommended first action:** In a fresh session — `Read .claude/PRPs/autonomous-loop-prd.md (section A #4)
and .claude/PRPs/dod-gate context in HANDOFF-dod-gate.md, then write a falsifiable PRD for increment #2:
the work-claim / in-flight ledger keyed by task intent (FM4).`
