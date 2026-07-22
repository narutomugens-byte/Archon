#!/usr/bin/env bun
/**
 * Definition-of-Done Gate — the deterministic terminal verifier for an autonomous
 * build loop. Proves a change is actually DONE rather than trusting the building
 * agent's word. First buildable increment of the "trustworthy autonomous loop"
 * (see .claude/PRPs/autonomous-loop-prd.md).
 *
 * What it does (all deterministic — NO LLM in the pass/fail decision):
 *   R1  Re-executes the operator's acceptance CHECKS itself. Any non-zero -> FAIL.
 *   R2  Test-efficacy REVERT-PROBE: reverts only the non-test source changes and
 *       re-runs the test command; if no test flips red, the tests are vacuous -> FAIL.
 *   R3  Self-scoped: reads ONLY this run's own worktree (process.cwd()). It issues
 *       no shared-store query at all, so it can never misread another run's result.
 *   R4  Hard-stop: exits non-zero on any FAIL so a downstream push/PR node cannot run.
 *   R5  Writes a re-runnable verdict to $ARTIFACTS_DIR/dod/verdict.json (+ verdict.md).
 *   R6  Deterministic: same worktree + same spec -> same verdict + same exit code.
 *   R7  Hermetic: unsets GIT_DIR/GIT_WORK_TREE, uses explicit `git diff <base> HEAD`,
 *       NAMED script (an inline multi-line script truncates on Windows).
 *       Honest about infra gaps: reports UNVERIFIED, never a false PASS it can detect.
 *
 * INTEGRITY MECHANISMS (each closes a hole found by adversarial verification of the
 * first spike; every one is covered by a fixture in dod-gate-verify.ts):
 *   - Hollow-check detection: a check whose command is a pure no-op chain
 *     (echo/true/:/exit 0/printf/cd) is refused, not credited.
 *   - Implementation-inside-test-file: if every changed source file matches a test
 *     glob there is nothing to revert, so efficacy is unprovable -> hard FAIL.
 *     (The spike auto-PASSed here. That was the confirmed bypass.)
 *   - Newly-added source files are TRUNCATED, never deleted, so a vacuous test cannot
 *     be credited by an import-resolution break.
 *   - Every spawned command carries a timeout + SIGKILL, and main() has exactly one
 *     terminal exit, so the gate can never hang or fall through without a verdict.
 *
 * WHAT "efficacy PASS" MEANS (honest boundary — see plan section 2.8):
 *   A file-granularity revert-probe proves "at least one test flips red when the
 *   implementation is REMOVED". It does NOT prove "the test catches every wrong value
 *   the implementation could return". A test that calls the implementation but asserts
 *   weakly still flips red on removal and is credited. The guarantee this gate makes is
 *   the narrow, checkable one: a test that never exercises the change at all cannot make
 *   anything flip red, and therefore FAILs.
 *
 * Acceptance spec resolution (first found wins):
 *   1. $DOD_SPEC              — explicit path to a .json spec
 *   2. .archon/dod/$DOD_TASK.json
 *   3. $ARTIFACTS_DIR/plan.md `## Validation Commands` numbered list (compiled to checks)
 * No spec resolvable -> FAIL ("no acceptance spec found"). Never passes by default.
 * JSON is the canonical spec format: dependency-free and portable to any target repo.
 *
 * Spec shape (KISS — a check is a shell command; exit 0 = pass; no DSL beyond that):
 *   {
 *     "checks": [
 *       { "name": "type-check", "run": "bun run type-check" },
 *       { "name": "tests", "run": "bun run test", "is_test_command": true }
 *     ],
 *     "test_globs": ["**\/*.test.ts"],
 *     "require_test_efficacy": true
 *   }
 *
 * Env inputs:
 *   ARTIFACTS_DIR (required)  — where the verdict is written.
 *   DOD_SPEC / DOD_TASK       — acceptance spec selection (see above).
 *   DOD_BASE / BASE_BRANCH    — base ref for the change diff (defensively resolved).
 *   DOD_STRICT ("1" default)  — FAIL-closed: UNVERIFIED efficacy -> FAIL. "0" = WARN-open.
 *   DOD_CMD_TIMEOUT_MS        — per-spawned-command timeout in ms (default 300000).
 *
 * Exit: 0 = gate PASS, 1 = gate FAIL (or a fatal input error).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

// ── Hermeticity (R7): a leaked GIT_DIR/GIT_WORK_TREE evaluates the WRONG repo ──
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;

const cwd = process.cwd();
const artRoot = process.env.ARTIFACTS_DIR;
const strict = (process.env.DOD_STRICT ?? '1') !== '0';
const CMD_TIMEOUT_MS = Number(process.env.DOD_CMD_TIMEOUT_MS ?? '300000') || 300000;

/** Audit-only run identifier, parsed from this run's own artifacts path. Never queried. */
const runId = artRoot ? (artRoot.replace(/\\/g, '/').match(/runs\/([^/]+)/)?.[1] ?? null) : null;

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

interface CheckResult {
  name: string;
  exit: number;
  hollow: boolean;
  infra_unverified: boolean;
  tail: string;
}
interface Efficacy {
  ran: boolean;
  verdict: Tri;
  test_files_changed?: number;
  nonTest_files?: number;
  baseline_green?: boolean;
  red_under_revert?: boolean;
  reason?: string;
}

const DEFAULT_TEST_GLOBS = ['**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/*_test.py', '**/test_*.py'];

// ── Small helpers ────────────────────────────────────────────────────────────
function tail(s: string, n = 2000): string {
  const t = s.replace(/\r\n/g, '\n');
  return t.length > n ? '…' + t.slice(-n) : t;
}

/**
 * Run a shell command string with a hard timeout. shell:true -> cmd.exe on Windows,
 * /bin/sh on posix. A wedged command is SIGKILLed and mapped to a non-zero code, so
 * a hanging check can never stall the gate (spawnSync returns status null when killed).
 */
function runShell(cmd: string): { code: number; out: string; timedOut: boolean } {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: CMD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  // status is null when the process was killed or failed to spawn -> treat as failure.
  const code = r.status ?? (timedOut ? 124 : r.error ? 127 : 1);
  return { code, out, timedOut };
}

/**
 * Run git with argv (never a shell string). Returns {ok, out}. Never throws.
 * Pins core.autocrlf=false so Windows EOL renormalization cannot make a clean,
 * committed file look "modified" and spuriously block the revert-probe.
 */
function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: CMD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
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

/** Minimal glob -> RegExp (supports **, *, ? and literal segments). Enough for test_globs. */
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

/**
 * Conservative infra-gap detection. A check that could not TRULY run (missing runtime,
 * missing deps in a bare worktree) must be UNVERIFIED — never a silent PASS and never a
 * misleading FAIL attributed to the code. Only unambiguous signatures qualify.
 */
function isInfraGap(code: number, out: string): boolean {
  if (code === 127) return true; // posix: command not found
  if (code === 9009) return true; // cmd.exe: command not found
  return /command not found|is not recognized as an internal or external command|Cannot find module|Cannot find package|error: Cannot find|Module not found|No such file or directory/i.test(
    out
  );
}

/**
 * Hollow-check detection. A check whose command is a provable no-op must not be
 * credited as verification. A command is HOLLOW iff EVERY effective segment (split on
 * && || ; |) is a member of the no-op set. Conservative by design: `echo ok && bun test`
 * has a real segment and is NOT hollow, so real commands are never false-flagged.
 */
function isHollowCommand(run: string): boolean {
  const segments = run
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return true;
  return segments.every((s) => {
    const bare = s.replace(/^["']|["']$/g, '').trim();
    if (bare === 'true' || bare === ':' || bare === 'exit 0') return true;
    return /^(echo|printf|cd)\b/i.test(bare);
  });
}

// ── Verdict writer (R5) ───────────────────────────────────────────────────────
function writeVerdict(
  gate: 'PASS' | 'FAIL',
  body: { checks: CheckResult[]; efficacy: Efficacy; reasons: string[]; base?: string | null }
): void {
  const reproduce = `ARTIFACTS_DIR=${artRoot ?? '<artifacts>'} DOD_SPEC=${process.env.DOD_SPEC ?? '<spec.json>'} bun run .archon/scripts/dod-gate.ts`;
  const verdict = {
    gate,
    strict,
    run_id: runId,
    checks: body.checks,
    efficacy: body.efficacy,
    reasons: body.reasons,
    base: body.base ?? null,
    reproduce,
    gated_at: new Date().toISOString(),
  };
  if (artRoot) {
    try {
      const dir = join(artRoot, 'dod');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2));
      const md =
        `# Definition-of-Done: ${gate}\n\n` +
        (gate === 'FAIL' ? `## Blocking reasons\n${body.reasons.map((r) => `- ${r}`).join('\n')}\n\n` : '') +
        `## Checks\n${
          body.checks
            .map(
              (c) =>
                `- ${c.exit === 0 && !c.hollow && !c.infra_unverified ? 'PASS' : 'FAIL'} — ${c.name} (exit ${c.exit})` +
                (c.hollow ? ' [no-op stub]' : '') +
                (c.infra_unverified ? ' [UNVERIFIED: environment incomplete]' : '')
            )
            .join('\n') || '- (none)'
        }\n\n` +
        `## Test efficacy (revert-probe)\n- verdict: ${body.efficacy.verdict}` +
        (body.efficacy.reason ? ` — ${body.efficacy.reason}` : '') +
        `\n\n> "efficacy PASS" means at least one test flipped red when the implementation was\n` +
        `> removed. It does not mean the tests catch every wrong value.\n` +
        `\n## Reproduce\n\`${reproduce}\`\n`;
      writeFileSync(join(dir, 'verdict.md'), md);
    } catch {
      /* the verdict echo below is the fallback if the artifacts dir is unwritable */
    }
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

function fatal(reasons: string[]): never {
  writeVerdict('FAIL', {
    checks: [],
    efficacy: { ran: false, verdict: 'UNVERIFIED', reason: 'gate could not start' },
    reasons,
  });
  process.exit(1);
}

// ── Spec loading (JSON is the canonical, dependency-free format) ───────────────
function parseSpecFile(path: string): Spec {
  const ext = extname(path).toLowerCase();
  if (ext !== '.json') {
    fatal([
      `Spec ${path} is not JSON. v1 accepts .json acceptance specs only (dependency-free and portable); convert the spec to JSON.`,
    ]);
  }
  const raw = readFileSync(path, 'utf8');
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    fatal([`Spec ${path} is not valid JSON: ${(e as Error).message}`]);
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
  if (!checks.some((c) => c.is_test_command)) {
    const t = checks.find((c) => /test/i.test(c.run));
    if (t) t.is_test_command = true;
  }
  return {
    checks,
    test_globs: DEFAULT_TEST_GLOBS,
    require_test_efficacy: true,
    source: `${planPath} (## Validation Commands)`,
  };
}

function resolveSpec(): Spec {
  const explicit = process.env.DOD_SPEC;
  if (explicit) {
    if (!existsSync(explicit)) fatal([`DOD_SPEC=${explicit} does not exist.`]);
    return parseSpecFile(explicit);
  }
  const task = process.env.DOD_TASK;
  if (task) {
    const p = join(cwd, '.archon', 'dod', task + '.json');
    if (existsSync(p)) return parseSpecFile(p);
    fatal([`No .archon/dod/${task}.json found for DOD_TASK=${task}.`]);
  }
  if (artRoot) {
    const fromPlan = specFromPlan(join(artRoot, 'plan.md'));
    if (fromPlan) return fromPlan;
  }
  fatal([
    'no acceptance spec found (set DOD_SPEC to a .json spec, set DOD_TASK, or provide a plan.md with a `## Validation Commands` section).',
  ]);
}

// ── Base resolution (R7: defensive; never hard-fail on a repo without an origin) ──
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
  if (verify('HEAD~1')) {
    return { base: git(['rev-parse', 'HEAD~1']).out, reason: 'fell back to HEAD~1 (no base ref resolvable)' };
  }
  return { base: null, reason: 'could not resolve a base ref to diff against' };
}

// ── R1: independently re-run every acceptance check ───────────────────────────
function runChecks(spec: Spec): CheckResult[] {
  const results: CheckResult[] = [];
  for (const c of spec.checks) {
    const hollow = isHollowCommand(c.run);
    const { code, out, timedOut } = runShell(c.run);
    results.push({
      name: c.name,
      exit: code,
      hollow,
      infra_unverified: !timedOut && code !== 0 && isInfraGap(code, out),
      tail: timedOut ? tail(out) + `\n[killed after ${CMD_TIMEOUT_MS}ms]` : tail(out),
    });
  }
  return results;
}

/**
 * The revert-probe (R2). Preconditions: base resolved, changes committed to HEAD.
 * 1. Guard: at least one test file changed, and at least one NON-test source file
 *    changed (otherwise there is nothing to revert and efficacy is unprovable).
 * 2. Baseline: run the test command -> must be GREEN.
 * 3. Revert only the non-test files (restore base content, or truncate if newly added);
 *    re-run tests -> expect RED.
 * 4. ALWAYS restore in `finally`, then verify the tree is clean again.
 */
function runRevertProbe(spec: Spec, testCmd: Check, base: string): Efficacy {
  const diff = git(['diff', '--name-only', base, 'HEAD']);
  if (!diff.ok) return { ran: false, verdict: 'UNVERIFIED', reason: `git diff ${base}..HEAD failed` };
  const changed = diff.out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort(); // R6 determinism
  const testFiles = changed.filter((f) => matchesAny(f, spec.test_globs));
  const nonTest = changed.filter((f) => !matchesAny(f, spec.test_globs));

  if (testFiles.length === 0) {
    return {
      ran: true,
      verdict: 'FAIL',
      test_files_changed: 0,
      nonTest_files: nonTest.length,
      reason: 'no test file changed — nothing protects this change',
    };
  }

  // THE regression guard. Every changed source file matches a test glob, so there is no
  // implementation to revert and efficacy cannot be proven. A vacuous assertion sitting
  // next to the implementation in the same test file would otherwise sail through.
  // This is a hard FAIL verdict, deliberately independent of strict mode.
  if (nonTest.length === 0) {
    return {
      ran: true,
      verdict: 'FAIL',
      test_files_changed: testFiles.length,
      nonTest_files: 0,
      reason:
        'implementation lives only in test file(s) — a vacuous assertion could hide it; move the implementation into a non-test source file so efficacy can be proven',
    };
  }

  // Safety: the revert would destroy uncommitted work in these files.
  if (trackedDirty(nonTest).length > 0) {
    return {
      ran: false,
      verdict: 'UNVERIFIED',
      test_files_changed: testFiles.length,
      nonTest_files: nonTest.length,
      reason: 'uncommitted changes to source under test — commit before gating so the revert-probe is safe',
    };
  }

  // Baseline must be green before a revert can mean anything.
  const baseRun = runShell(testCmd.run);
  if (baseRun.code !== 0) {
    const infra = isInfraGap(baseRun.code, baseRun.out);
    return {
      ran: true,
      verdict: 'UNVERIFIED',
      test_files_changed: testFiles.length,
      nonTest_files: nonTest.length,
      baseline_green: false,
      reason: infra
        ? 'test command could not truly run (environment incomplete) — cannot prove efficacy'
        : 'baseline test command is not green — cannot run the revert-probe (fix checks first)',
    };
  }

  // Which non-test files existed at base (restore) vs were added at HEAD (truncate)?
  const existedAtBase = new Map<string, boolean>();
  for (const f of nonTest) existedAtBase.set(f, git(['cat-file', '-e', `${base}:${f}`]).ok);

  let redUnderRevert = false;
  try {
    for (const f of nonTest) {
      if (existedAtBase.get(f)) {
        git(['checkout', base, '--', f]);
      } else {
        // TRUNCATE, never delete. Deleting a newly-added implementation file breaks
        // import resolution, the test file fails to load, and a naive probe would
        // credit that module-load break as "efficacy". Truncating keeps the module
        // resolvable but strips its behavior, so a test that merely imports a symbol
        // without calling it stays green and is correctly judged vacuous.
        try {
          writeFileSync(join(cwd, f), '');
        } catch {
          /* unwritable path is caught by the post-restore cleanliness check */
        }
      }
    }
    const revertRun = runShell(testCmd.run);
    redUnderRevert = revertRun.code !== 0;
  } finally {
    for (const f of nonTest) git(['checkout', 'HEAD', '--', f]);
  }

  const stillDirty = trackedDirty(nonTest);
  if (stillDirty.length > 0) {
    return {
      ran: true,
      verdict: 'UNVERIFIED',
      test_files_changed: testFiles.length,
      nonTest_files: nonTest.length,
      baseline_green: true,
      red_under_revert: redUnderRevert,
      reason: 'revert-probe could not cleanly restore the tree — run `git checkout HEAD -- .` and re-gate',
    };
  }

  if (!redUnderRevert) {
    return {
      ran: true,
      verdict: 'FAIL',
      test_files_changed: testFiles.length,
      nonTest_files: nonTest.length,
      baseline_green: true,
      red_under_revert: false,
      reason:
        'tests still pass with the implementation reverted — they are vacuous (they do not exercise the change)',
    };
  }

  return {
    ran: true,
    verdict: 'PASS',
    test_files_changed: testFiles.length,
    nonTest_files: nonTest.length,
    baseline_green: true,
    red_under_revert: true,
    reason: 'at least one test flips red when the implementation is reverted',
  };
}

/** Pure fold: integrity + checks + efficacy + strict -> gate. Reasons in fixed order (R6). */
function fold(
  spec: Spec,
  checks: CheckResult[],
  efficacy: Efficacy
): { gate: 'PASS' | 'FAIL'; reasons: string[] } {
  const reasons: string[] = [];

  // 1. Integrity: hollow checks are refused before anything is credited.
  for (const c of checks) {
    if (c.hollow) {
      reasons.push(`check "${c.name}" is a no-op stub (echo/true/exit 0) — not a real verification`);
    }
  }
  // 2. R1: real check failures, and infra gaps folded fail-closed under strict.
  for (const c of checks) {
    if (c.infra_unverified) {
      if (strict) {
        reasons.push(
          `check "${c.name}" is UNVERIFIED — it could not truly run (environment incomplete), and strict mode fails closed`
        );
      }
    } else if (c.exit !== 0) {
      const src = spec.checks.find((s) => s.name === c.name);
      reasons.push(`check "${c.name}" failed (exit ${c.exit}): \`${src?.run ?? c.name}\``);
    }
  }
  // 3. R2: efficacy.
  if (efficacy.verdict === 'FAIL') {
    reasons.push(efficacy.reason ? `test efficacy: ${efficacy.reason}` : 'test efficacy: revert-probe failed');
  } else if (efficacy.verdict === 'UNVERIFIED' && spec.require_test_efficacy && strict) {
    reasons.push(`test efficacy UNVERIFIED and strict mode is on: ${efficacy.reason ?? 'could not verify'}`);
  }

  return { gate: reasons.length === 0 ? 'PASS' : 'FAIL', reasons };
}

// ── Main: exactly one terminal exit; no path can escape without a verdict ──────
function main(): void {
  try {
    if (!artRoot) fatal(['ARTIFACTS_DIR not set — cannot write a verdict.']);
    if (!git(['rev-parse', '--is-inside-work-tree']).ok) fatal(['not inside a git work tree — cannot gate.']);

    const spec = resolveSpec();
    const checks = runChecks(spec);

    let efficacy: Efficacy;
    let base: string | null = null;

    if (!spec.require_test_efficacy) {
      efficacy = { ran: false, verdict: 'PASS', reason: 'efficacy not required by spec' };
    } else {
      const testCmd = spec.checks.find((c) => c.is_test_command);
      const testResult = testCmd ? checks.find((c) => c.name === testCmd.name) : undefined;
      const resolved = resolveBase();
      base = resolved.base;
      if (!testCmd) {
        efficacy = { ran: false, verdict: 'UNVERIFIED', reason: 'no check marked is_test_command' };
      } else if (testResult?.hollow) {
        // A stubbed test command cannot support a revert-probe at all.
        efficacy = { ran: false, verdict: 'UNVERIFIED', reason: 'test command is a no-op stub' };
      } else if (!base) {
        efficacy = { ran: false, verdict: 'UNVERIFIED', reason: resolved.reason };
      } else {
        efficacy = runRevertProbe(spec, testCmd, base);
      }
    }

    const { gate, reasons } = fold(spec, checks, efficacy);
    writeVerdict(gate, { checks, efficacy, reasons, base });
    process.exit(gate === 'PASS' ? 0 : 1);
  } catch (e) {
    fatal([`unexpected error: ${(e as Error).message}`]);
  }
}

main();
