#!/usr/bin/env bun
/**
 * Definition-of-Done Gate — the deterministic terminal verifier for an autonomous
 * build loop. Proves a change is actually DONE rather than trusting the building
 * agent's word. First buildable increment of the "trustworthy autonomous loop"
 * (see .claude/PRPs/autonomous-loop-prd.md).
 *
 * What it does (all deterministic — NO LLM in the pass/fail decision):
 *   R1  Re-executes the operator's acceptance CHECKS itself. Any non-zero → FAIL.
 *   R2  Test-efficacy REVERT-PROBE: reverts only the non-test source changes and
 *       re-runs the test command; if no test flips red, the tests are vacuous → FAIL.
 *   R3  Self-scoped: reads ONLY this run's own worktree (process.cwd()). It issues
 *       NO "recent run" / shared-DB query — so it can never misread another run's result.
 *   R4  Hard-stop: exits non-zero on any FAIL so a downstream push/PR node cannot run.
 *   R5  Writes a re-runnable verdict to $ARTIFACTS_DIR/dod/verdict.json (+ verdict.md).
 *   R6  Deterministic: same worktree + same spec → same verdict + same exit code.
 *   R7  Hermetic: unsets GIT_DIR/GIT_WORK_TREE, uses explicit `git diff <base> HEAD`,
 *       no $BASE_BRANCH token in comments, NAMED script (inline truncates on Windows).
 *       Honest about infra gaps: reports UNVERIFIED, never a false PASS/FAIL it can detect.
 *
 * Acceptance spec resolution (first found wins):
 *   1. $DOD_SPEC              — explicit path to a spec (.json canonical; .yaml best-effort)
 *   2. .archon/dod/$DOD_TASK.json (or .yaml/.yml where the `yaml` package is available)
 *   3. $ARTIFACTS_DIR/plan.md `## Validation Commands` numbered list (compiled to checks)
 * No spec resolvable → FAIL ("no acceptance spec found"). Never passes by default.
 * JSON is canonical: it is dependency-free and portable to any target repo. YAML
 * specs only parse when the `yaml` package is resolvable from the script's location.
 *
 * Spec shape (KISS — a check is a shell command; exit 0 = pass; no DSL beyond that):
 *   checks:
 *     - name: type-check
 *       run: bun run type-check
 *     - name: tests
 *       run: bun run test
 *       is_test_command: true            # used for the revert-probe
 *   test_globs: ["** /*.test.ts"]        # what counts as a test file
 *   require_test_efficacy: true          # default true
 *
 * Env inputs:
 *   ARTIFACTS_DIR (required)  — where the verdict is written.
 *   DOD_SPEC / DOD_TASK       — acceptance spec selection (see above).
 *   DOD_BASE / BASE_BRANCH    — base ref for the change diff (defensively resolved).
 *   DOD_STRICT ("1" default)  — FAIL-closed: UNVERIFIED efficacy → FAIL. "0" = WARN-open.
 *   WORKFLOW_ID               — recorded for audit only (no DB read).
 *
 * Exit: 0 = gate PASS, 1 = gate FAIL (or a fatal input error).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

// ── Hermeticity (R7): a leaked GIT_DIR/GIT_WORK_TREE evaluates the WRONG repo ──
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;

const cwd = process.cwd();
const artRoot = process.env.ARTIFACTS_DIR;
const strict = (process.env.DOD_STRICT ?? '1') !== '0';
const workflowId = process.env.WORKFLOW_ID ?? null;

// ── Types ──────────────────────────────────────────────────────────────────
interface Check {
  name: string;
  run: string;
  is_test_command?: boolean;
}
interface Spec {
  checks: Check[];
  test_globs: string[];
  require_test_efficacy: boolean;
  source: string; // provenance, for the verdict
}
type Tri = 'PASS' | 'FAIL' | 'UNVERIFIED';

const DEFAULT_TEST_GLOBS = ['**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/*_test.py', '**/test_*.py'];

// ── Small helpers ────────────────────────────────────────────────────────────
function fatal(reasons: string[]): never {
  writeVerdict('FAIL', { checks: [], efficacy: { ran: false, verdict: 'UNVERIFIED' }, reasons });
  process.exit(1);
}

function tail(s: string, n = 2000): string {
  const t = s.replace(/\r\n/g, '\n');
  return t.length > n ? '…' + t.slice(-n) : t;
}

/** Run a shell command string. shell:true → cmd.exe on Windows, /bin/sh on posix. */
function runShell(cmd: string): { code: number; out: string } {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  // spawnSync sets status null when the process was killed / failed to spawn.
  const code = r.status ?? (r.error ? 127 : 1);
  return { code, out };
}

/**
 * Run git with argv (never a shell string). Returns {ok, out}. Never throws.
 * Pins core.autocrlf=false so Windows EOL renormalization can't make a clean,
 * committed file look "modified" and spuriously block the revert-probe.
 */
function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
}

/** Uncommitted TRACKED modifications among `files` (untracked `??` entries ignored). */
function trackedDirty(files: string[]): string[] {
  if (files.length === 0) return [];
  return git(['status', '--porcelain', '--', ...files])
    .out.split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('??'));
}

/** Minimal glob → RegExp (supports **, *, and literal segments). Enough for test_globs. */
function globToRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // consume the slash after **
      } else {
        re += '[^/]*';
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}
function matchesAny(path: string, globs: string[]): boolean {
  const p = path.replace(/\\/g, '/');
  return globs.some((g) => globToRe(g).test(p) || globToRe('**/' + g.replace(/^\*\*\//, '')).test(p));
}

// ── Verdict writer (R5) ───────────────────────────────────────────────────────
function writeVerdict(
  gate: 'PASS' | 'FAIL',
  body: {
    checks: Array<{ name: string; exit: number; tail: string }>;
    efficacy: {
      ran: boolean;
      verdict: Tri;
      test_files_changed?: number;
      baseline_green?: boolean;
      red_under_revert?: boolean;
      reason?: string;
    };
    reasons: string[];
    base?: string | null;
  }
): void {
  const reproduce = `ARTIFACTS_DIR=${artRoot ?? '<artifacts>'} bun run .archon/scripts/dod-gate.ts`;
  const verdict = {
    gate,
    workflow_id: workflowId,
    strict,
    checks: body.checks,
    efficacy: body.efficacy,
    reasons: body.reasons,
    base: body.base ?? null,
    reproduce,
    gated_at: new Date().toISOString(),
  };
  if (artRoot) {
    const dir = join(artRoot, 'dod');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2));
    const md =
      `# Definition-of-Done: ${gate}\n\n` +
      (gate === 'FAIL' ? `## Blocking reasons\n${body.reasons.map((r) => `- ${r}`).join('\n')}\n\n` : '') +
      `## Checks\n${body.checks.map((c) => `- ${c.exit === 0 ? 'PASS' : 'FAIL'} — ${c.name} (exit ${c.exit})`).join('\n') || '- (none)'}\n\n` +
      `## Test efficacy (revert-probe)\n- verdict: ${body.efficacy.verdict}` +
      (body.efficacy.reason ? ` — ${body.efficacy.reason}` : '') +
      `\n\n## Reproduce\n\`${reproduce}\`\n`;
    writeFileSync(join(dir, 'verdict.md'), md);
    // Trend line in gitignored cross-run state (self-scoped; never read back for gating).
    try {
      const st = join(cwd, '.archon', 'state');
      mkdirSync(st, { recursive: true });
      appendFileSync(join(st, 'dod-history.jsonl'), JSON.stringify(verdict) + '\n');
    } catch {
      /* trend line is best-effort */
    }
  }
  console.log(JSON.stringify(verdict, null, 2));
}

// ── Spec loading ──────────────────────────────────────────────────────────────
function parseSpecFile(path: string): Spec {
  const raw = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  let obj: unknown;
  if (ext === '.json') {
    obj = JSON.parse(raw);
  } else {
    // YAML via the repo's `yaml` dep; fall back to a clear error if unavailable.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const yaml = require('yaml') as { parse: (s: string) => unknown };
      obj = yaml.parse(raw);
    } catch {
      fatal([`Spec ${path} is YAML but the 'yaml' package is unavailable — use a .json spec.`]);
    }
  }
  const o = obj as Record<string, unknown>;
  const checks = Array.isArray(o.checks) ? (o.checks as Check[]) : [];
  if (checks.length === 0) fatal([`Spec ${path} has no 'checks' — cannot verify done-ness.`]);
  for (const c of checks) {
    if (!c || typeof c.name !== 'string' || typeof c.run !== 'string') {
      fatal([`Spec ${path} has a malformed check (needs name + run).`]);
    }
  }
  return {
    checks,
    test_globs: Array.isArray(o.test_globs) && o.test_globs.length ? (o.test_globs as string[]) : DEFAULT_TEST_GLOBS,
    require_test_efficacy: o.require_test_efficacy !== false,
    source: path,
  };
}

/** Fallback: compile the plan's `## Validation Commands` numbered list into checks. */
function specFromPlan(planPath: string): Spec | null {
  if (!existsSync(planPath)) return null;
  const lines = readFileSync(planPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##+\s+Validation Commands/i.test(l));
  if (start === -1) return null;
  const checks: Check[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##+\s/.test(lines[i])) break; // next heading ends the section
    // "1. Type check: `cmd`" or "- `cmd`" — extract the backticked command.
    const m = lines[i].match(/`([^`]+)`/);
    if (m) {
      const run = m[1].trim();
      const labelMatch = lines[i].match(/^\s*(?:\d+\.|[-*])\s*([^:`]+):/);
      const name = (labelMatch ? labelMatch[1].trim() : run).slice(0, 40);
      const isTest = /\btest\b|\bvalidate\b/i.test(name) || /\btest\b|\bvalidate\b/.test(run);
      checks.push({ name, run, is_test_command: isTest });
    }
  }
  if (checks.length === 0) return null;
  // Mark exactly one test command for the revert-probe (prefer a `test` over `validate`).
  if (!checks.some((c) => c.is_test_command)) {
    const t = checks.find((c) => /test/i.test(c.run));
    if (t) t.is_test_command = true;
  }
  return { checks, test_globs: DEFAULT_TEST_GLOBS, require_test_efficacy: true, source: `${planPath} (## Validation Commands)` };
}

function resolveSpec(): Spec {
  const explicit = process.env.DOD_SPEC;
  if (explicit) {
    if (!existsSync(explicit)) fatal([`DOD_SPEC=${explicit} does not exist.`]);
    return parseSpecFile(explicit);
  }
  const task = process.env.DOD_TASK;
  if (task) {
    // JSON is canonical (dependency-free, portable to any target repo). YAML is a
    // best-effort convenience that needs the `yaml` package on the resolution path.
    for (const ext of ['.json', '.yaml', '.yml']) {
      const p = join(cwd, '.archon', 'dod', task + ext);
      if (existsSync(p)) return parseSpecFile(p);
    }
    fatal([`No .archon/dod/${task}.{json,yaml,yml} found for DOD_TASK=${task}.`]);
  }
  if (artRoot) {
    const fromPlan = specFromPlan(join(artRoot, 'plan.md'));
    if (fromPlan) return fromPlan;
  }
  fatal(['No acceptance spec found (set DOD_SPEC, DOD_TASK, or provide a plan.md with a `## Validation Commands` section).']);
}

// ── Base resolution (R7: defensive; never hard-fail on no-origin) ─────────────
function resolveBase(): { base: string | null; reason?: string } {
  const explicit = process.env.DOD_BASE || process.env.BASE_BRANCH;
  const verify = (ref: string) => git(['rev-parse', '--verify', '--quiet', ref + '^{commit}']).ok;
  if (explicit && verify(explicit)) {
    const mb = git(['merge-base', 'HEAD', explicit]);
    return { base: mb.ok ? mb.out : explicit };
  }
  const up = git(['rev-parse', '--verify', '--quiet', '@{upstream}']);
  if (up.ok) {
    const mb = git(['merge-base', 'HEAD', '@{upstream}']);
    if (mb.ok) return { base: mb.out };
  }
  if (verify('HEAD~1')) return { base: git(['rev-parse', 'HEAD~1']).out, reason: 'fell back to HEAD~1 (no base ref resolvable)' };
  return { base: null, reason: 'could not resolve a base ref to diff against' };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main(): void {
  if (!artRoot) fatal(['ARTIFACTS_DIR not set — cannot write a verdict.']);
  if (!git(['rev-parse', '--is-inside-work-tree']).ok) fatal(['not inside a git work tree — cannot gate.']);

  const spec = resolveSpec();

  // ── R1: independently re-run every acceptance check ──────────────────────────
  const checkResults: Array<{ name: string; exit: number; tail: string }> = [];
  const reasons: string[] = [];
  for (const c of spec.checks) {
    const { code, out } = runShell(c.run);
    checkResults.push({ name: c.name, exit: code, tail: tail(out) });
    if (code !== 0) reasons.push(`check "${c.name}" failed (exit ${code}): \`${c.run}\``);
  }
  const checksPass = checkResults.every((c) => c.exit === 0);

  // ── R2: test-efficacy revert-probe ───────────────────────────────────────────
  let efficacy: {
    ran: boolean;
    verdict: Tri;
    test_files_changed?: number;
    baseline_green?: boolean;
    red_under_revert?: boolean;
    reason?: string;
  } = { ran: false, verdict: 'UNVERIFIED', reason: 'not requested' };
  let base: string | null = null;

  if (spec.require_test_efficacy) {
    const testCmd = spec.checks.find((c) => c.is_test_command);
    const resolved = resolveBase();
    base = resolved.base;
    if (!testCmd) {
      efficacy = { ran: false, verdict: 'UNVERIFIED', reason: 'no check marked is_test_command' };
    } else if (!base) {
      efficacy = { ran: false, verdict: 'UNVERIFIED', reason: resolved.reason };
    } else {
      // Cleanliness is checked INSIDE the probe, scoped to only the files it will
      // revert — untracked specs/artifacts/gitignored state must not block gating.
      efficacy = runRevertProbe(spec, testCmd, base);
    }
  } else {
    efficacy = { ran: false, verdict: 'PASS', reason: 'efficacy not required by spec' };
  }

  // Fold efficacy into blocking reasons.
  if (efficacy.verdict === 'FAIL') {
    reasons.push(efficacy.reason ? `test efficacy: ${efficacy.reason}` : 'test efficacy: revert-probe failed');
  } else if (efficacy.verdict === 'UNVERIFIED' && spec.require_test_efficacy && strict) {
    reasons.push(`test efficacy UNVERIFIED and strict mode is on: ${efficacy.reason ?? 'could not verify'}`);
  }

  const efficacyOk =
    efficacy.verdict === 'PASS' || (efficacy.verdict === 'UNVERIFIED' && (!strict || !spec.require_test_efficacy));

  const gate: 'PASS' | 'FAIL' = checksPass && efficacyOk ? 'PASS' : 'FAIL';
  writeVerdict(gate, { checks: checkResults, efficacy, reasons, base });
  process.exit(gate === 'PASS' ? 0 : 1);
}

/**
 * The revert-probe (R2). Assumes: base resolved, working tree clean, changes committed to HEAD.
 * 1. Baseline: run the test command → must be GREEN (else UNVERIFIED — a red baseline is R1's job).
 * 2. Diff base..HEAD; partition into test vs non-test; if zero test files changed → FAIL.
 * 3. Revert only the non-test files in the working tree; re-run tests → expect RED.
 * 4. ALWAYS restore (finally), then verify the tree is clean again.
 */
function runRevertProbe(spec: Spec, testCmd: Check, base: string): {
  ran: boolean;
  verdict: Tri;
  test_files_changed?: number;
  baseline_green?: boolean;
  red_under_revert?: boolean;
  reason?: string;
} {
  const diff = git(['diff', '--name-only', base, 'HEAD']);
  if (!diff.ok) return { ran: false, verdict: 'UNVERIFIED', reason: `git diff ${base}..HEAD failed` };
  const changed = diff.out.split('\n').map((s) => s.trim()).filter(Boolean);
  const testFiles = changed.filter((f) => matchesAny(f, spec.test_globs));
  const nonTest = changed.filter((f) => !matchesAny(f, spec.test_globs));

  if (testFiles.length === 0) {
    return { ran: true, verdict: 'FAIL', test_files_changed: 0, reason: 'no test file changed — nothing protects this change' };
  }
  if (nonTest.length === 0) {
    // Only tests changed (e.g. a test-only PR). Nothing to revert → efficacy N/A, don't block.
    return { ran: true, verdict: 'PASS', test_files_changed: testFiles.length, reason: 'test-only change (no source to revert)' };
  }

  // Safety: the checkout-based revert would destroy uncommitted work in these files.
  // Scoped to only the files we will touch (untracked/gitignored files are fine).
  if (trackedDirty(nonTest).length > 0) {
    return { ran: false, verdict: 'UNVERIFIED', test_files_changed: testFiles.length, reason: 'uncommitted changes to source under test — commit before gating so the revert-probe is safe' };
  }

  // Step 1: baseline green.
  const baseRun = runShell(testCmd.run);
  if (baseRun.code !== 0) {
    return { ran: true, verdict: 'UNVERIFIED', test_files_changed: testFiles.length, baseline_green: false, reason: 'baseline test command is not green — cannot run the revert-probe (fix checks first)' };
  }

  // Track which non-test files existed at base (revert) vs were added at HEAD (remove).
  const existedAtBase = new Map<string, boolean>();
  for (const f of nonTest) existedAtBase.set(f, git(['cat-file', '-e', `${base}:${f}`]).ok);

  let redUnderRevert = false;
  try {
    // Step 3a: mutate the working tree to base's source.
    for (const f of nonTest) {
      if (existedAtBase.get(f)) git(['checkout', base, '--', f]);
      else {
        try {
          rmSync(join(cwd, f));
        } catch {
          /* file may already be gone */
        }
      }
    }
    // Step 3b: re-run tests — expect RED.
    const revertRun = runShell(testCmd.run);
    redUnderRevert = revertRun.code !== 0;
  } finally {
    // Step 4: ALWAYS restore committed HEAD versions of the reverted files.
    for (const f of nonTest) git(['checkout', 'HEAD', '--', f]);
  }

  // Safety: confirm the reverted files were restored; if not, warn loudly (don't silently pass).
  const leftDirty = trackedDirty(nonTest).length > 0;
  if (leftDirty) {
    return {
      ran: true,
      verdict: 'UNVERIFIED',
      test_files_changed: testFiles.length,
      baseline_green: true,
      red_under_revert: redUnderRevert,
      reason: 'revert-probe could not cleanly restore the working tree — run `git checkout HEAD -- .` and re-gate',
    };
  }

  if (redUnderRevert) {
    return { ran: true, verdict: 'PASS', test_files_changed: testFiles.length, baseline_green: true, red_under_revert: true };
  }
  return {
    ran: true,
    verdict: 'FAIL',
    test_files_changed: testFiles.length,
    baseline_green: true,
    red_under_revert: false,
    reason: 'tests still pass with the implementation reverted — they are vacuous (do not exercise the change)',
  };
}

main();
