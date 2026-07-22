#!/usr/bin/env bun
/**
 * Acceptance harness for the Definition-of-Done gate.
 *
 * Materializes throwaway git repos that each embody one way an agent can claim
 * "done" while the change is not actually done, runs the real gate against them,
 * and asserts the verdict + process exit code. This is the implementer's
 * self-check; a blind verifier is expected to rebuild these fixtures independently
 * from the plan's fixture table and agree.
 *
 * Every fixture here corresponds to a hole that was either confirmed by adversarial
 * verification of the first spike or specified by the PRD. Fixture 7 in particular
 * (implementation hidden inside a *.test.ts file) is a PERMANENT regression test:
 * the spike returned PASS on it, which was the confirmed bypass.
 *
 * Run: bun run .archon/scripts/dod-gate-verify.ts
 * Exit: 0 = every acceptance case behaved as required, 1 = at least one did not.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const GATE = join(import.meta.dir, 'dod-gate.ts');
// Short root path: Windows MAX_PATH makes deep nesting fail in confusing ways.
const ROOT = process.platform === 'win32' ? 'C:/hw/dodfx' : join(tmpdir(), 'dodfx');

const COMMON_SPEC = {
  checks: [{ name: 'tests', run: 'bun test', is_test_command: true }],
  test_globs: ['**/*.test.ts'],
  require_test_efficacy: true,
};

type Files = Record<string, string>;

interface Fixture {
  name: string;
  why: string;
  base: Files;
  change: Files;
  spec?: unknown;
  expectGate: 'PASS' | 'FAIL';
  expectExitZero: boolean;
  expectReason?: string; // case-insensitive substring of the joined reasons
  env?: Record<string, string>;
}

// ── fixture bodies ────────────────────────────────────────────────────────────
const GOOD_IMPL = 'export const add = (a: number, b: number): number => a + b;\n';
const BASE_IMPL = 'export const add = (a: number, b: number): number => 0;\n';
const REAL_TEST =
  "import { test, expect } from 'bun:test';\n" +
  "import { add } from './math';\n" +
  "test('add works', () => { expect(add(2, 3)).toBe(5); });\n";
const VACUOUS_TEST =
  "import { test, expect } from 'bun:test';\n" + "test('vacuous', () => { expect(1 + 1).toBe(2); });\n";
const VACUOUS_TEST_WITH_IMPORT =
  "import { test, expect } from 'bun:test';\n" +
  "import { add } from './math';\n" +
  "test('vacuous', () => { expect(1 + 1).toBe(2); });\n";

const FIXTURES: Fixture[] = [
  {
    name: '1-good-change',
    why: 'real implementation in a non-test file + a test that actually calls it',
    base: { 'README.md': '# fixture\n' },
    change: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST },
    expectGate: 'PASS',
    expectExitZero: true,
  },
  {
    name: '2-failing-check',
    why: 'a declared acceptance check genuinely fails',
    base: { 'README.md': '# fixture\n' },
    change: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST },
    spec: {
      checks: [
        { name: 'tests', run: 'bun test', is_test_command: true },
        { name: 'type-check', run: 'exit 3' },
      ],
      test_globs: ['**/*.test.ts'],
      require_test_efficacy: true,
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'check "type-check" failed',
  },
  {
    name: '3-vacuous-test',
    why: 'tests never exercise the implementation — they pass with it reverted',
    base: { 'math.ts': GOOD_IMPL, 'math.test.ts': VACUOUS_TEST },
    change: {
      'math.ts': GOOD_IMPL + 'export const sub = (a: number, b: number): number => a - b;\n',
      'math.test.ts': VACUOUS_TEST + "test('vacuous 2', () => { expect(2 + 2).toBe(4); });\n",
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'vacuous',
  },
  {
    name: '4-no-test-touched',
    why: 'implementation-only diff — nothing protects the change',
    base: { 'math.ts': BASE_IMPL, 'math.test.ts': VACUOUS_TEST },
    change: { 'math.ts': GOOD_IMPL },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'no test file changed',
  },
  {
    name: '5a-import-no-assert-modified',
    why: 'test imports the symbol but never calls it; implementation file was MODIFIED',
    base: { 'math.ts': GOOD_IMPL, 'math.test.ts': VACUOUS_TEST_WITH_IMPORT },
    change: {
      'math.ts': GOOD_IMPL + 'export const sub = (a: number, b: number): number => a - b;\n',
      'math.test.ts': VACUOUS_TEST_WITH_IMPORT + "test('still vacuous', () => { expect(3 + 3).toBe(6); });\n",
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'vacuous',
  },
  {
    name: '5b-import-no-assert-added',
    why: 'same, but the implementation file is NEWLY ADDED — deleting it would break the import and be miscredited as efficacy',
    base: { 'README.md': '# fixture\n' },
    change: {
      'mul.ts': 'export const mul = (a: number, b: number): number => a * b;\n',
      'mul.test.ts':
        "import { test, expect } from 'bun:test';\n" +
        "import { mul } from './mul';\n" +
        "test('vacuous', () => { expect(1 + 1).toBe(2); });\n",
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'vacuous',
  },
  {
    name: '6-stubbed-test-command',
    why: 'the test command is a no-op stub, so nothing is actually verified',
    base: { 'README.md': '# fixture\n' },
    change: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST },
    spec: {
      checks: [{ name: 'tests', run: 'echo test-ok', is_test_command: true }],
      test_globs: ['**/*.test.ts'],
      require_test_efficacy: true,
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'no-op stub',
  },
  {
    name: '7-impl-inside-test-file',
    why: 'REGRESSION: implementation hidden inside a *.test.ts file so the diff looks test-only (the spike PASSed this)',
    base: { 'README.md': '# fixture\n' },
    change: {
      'math.test.ts':
        "import { test, expect } from 'bun:test';\n" +
        'export function mul(a: number, b: number): number { return a * b; }\n' +
        "test('vacuous', () => { expect(1 + 1).toBe(2); });\n",
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'implementation lives only in test file',
  },
  {
    name: 'BareWT-missing-binary',
    why: 'a check that cannot truly run (missing runtime) must be UNVERIFIED folded to FAIL, never a false PASS',
    base: { 'README.md': '# fixture\n' },
    change: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST },
    spec: {
      checks: [
        { name: 'tests', run: 'bun test', is_test_command: true },
        { name: 'deps', run: 'totally-missing-binary-xyz --version' },
      ],
      test_globs: ['**/*.test.ts'],
      require_test_efficacy: true,
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'UNVERIFIED',
  },
];

// ── plumbing ──────────────────────────────────────────────────────────────────
function sh(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${(r.stdout ?? '') + (r.stderr ?? '')}`);
  }
}

function writeFiles(dir: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** Build a throwaway repo with a base commit and a change commit. */
function makeRepo(name: string, base: Files, change: Files): string {
  const dir = join(ROOT, name).replace(/\\/g, '/');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  sh('git', ['init', '--quiet'], dir);
  sh('git', ['config', 'user.email', 'gate@example.test'], dir);
  sh('git', ['config', 'user.name', 'Gate Fixture'], dir);
  sh('git', ['config', 'commit.gpgsign', 'false'], dir);
  writeFiles(dir, base);
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '--quiet', '-m', 'base'], dir);
  writeFiles(dir, change);
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '--quiet', '-m', 'change'], dir);
  return dir;
}

interface GateRun {
  exit: number;
  verdict: { gate?: string; reasons?: string[]; efficacy?: { verdict?: string } } | null;
  elapsedMs: number;
  raw: string;
}

/** Run the real gate against a fixture repo with a deliberately clean environment. */
function runGate(dir: string, extraEnv: Record<string, string> = {}): GateRun {
  const artifacts = join(dir, 'artifacts').replace(/\\/g, '/');
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Never let the harness's own run context leak into the fixture run.
  for (const k of ['DOD_SPEC', 'DOD_TASK', 'DOD_BASE', 'DOD_STRICT', 'DOD_CMD_TIMEOUT_MS', 'BASE_BRANCH', 'ARTIFACTS_DIR', 'GIT_DIR', 'GIT_WORK_TREE']) {
    delete env[k];
  }
  env.ARTIFACTS_DIR = artifacts;
  Object.assign(env, extraEnv);

  const started = Date.now();
  // process.execPath is the running bun binary. Spawning the bare name "bun" fails on
  // Windows, where it is a .cmd/.ps1 shim that argv-mode spawnSync cannot resolve.
  const r = spawnSync(process.execPath, ['run', GATE], {
    cwd: dir,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
    killSignal: 'SIGKILL',
  });
  const elapsedMs = Date.now() - started;
  const vp = join(artifacts, 'dod', 'verdict.json');
  let verdict = null;
  if (existsSync(vp)) {
    try {
      verdict = JSON.parse(readFileSync(vp, 'utf8'));
    } catch {
      verdict = null;
    }
  }
  return { exit: r.status ?? -1, verdict, elapsedMs, raw: (r.stdout ?? '') + (r.stderr ?? '') };
}

// ── results ───────────────────────────────────────────────────────────────────
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
}

mkdirSync(ROOT, { recursive: true });

// ── the fixture table ─────────────────────────────────────────────────────────
for (const f of FIXTURES) {
  try {
    const dir = makeRepo(f.name, f.base, f.change);
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(f.spec ?? COMMON_SPEC, null, 2));
    const run = runGate(dir, { DOD_SPEC: join(dir, 'spec.json').replace(/\\/g, '/'), ...(f.env ?? {}) });

    const gateOk = run.verdict?.gate === f.expectGate;
    const exitOk = f.expectExitZero ? run.exit === 0 : run.exit !== 0;
    const reasons = (run.verdict?.reasons ?? []).join(' | ');
    const reasonOk = !f.expectReason || reasons.toLowerCase().includes(f.expectReason.toLowerCase());

    record(
      f.name,
      gateOk && exitOk && reasonOk,
      `gate=${run.verdict?.gate ?? '(none)'} exit=${run.exit}` +
        (f.expectReason ? ` reason${reasonOk ? '✓' : '✗'}="${f.expectReason}"` : '') +
        (gateOk && exitOk && reasonOk ? '' : `  << expected gate=${f.expectGate} exit${f.expectExitZero ? '=0' : '≠0'}; reasons: ${reasons || '(none)'}`)
    );
  } catch (e) {
    record(f.name, false, `harness error: ${(e as Error).message}`);
  }
}

// ── Det: identical verdicts across 3 runs (ignoring the timestamp) ────────────
try {
  const dir = makeRepo('det-3x', FIXTURES[2].base, FIXTURES[2].change);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(COMMON_SPEC, null, 2));
  const specPath = join(dir, 'spec.json').replace(/\\/g, '/');
  const runs = [0, 1, 2].map(() => runGate(dir, { DOD_SPEC: specPath }));
  const norm = (r: GateRun) => {
    const v = { ...(r.verdict as Record<string, unknown>) };
    delete v.gated_at;
    // check output tails embed timings from the test runner, so compare the decision surface
    delete v.checks;
    return JSON.stringify(v) + `|exit=${r.exit}`;
  };
  const [a, b, c] = runs.map(norm);
  // Identical-but-empty is not determinism: require every run to have actually produced a
  // verdict, otherwise three identical crashes would report as a green determinism check.
  const allRan = runs.every((r) => r.verdict?.gate === 'FAIL');
  const identical = a === b && b === c;
  record(
    'Det-3x-identical',
    allRan && identical,
    !allRan
      ? `runs did not all produce a verdict: ${runs.map((r) => r.verdict?.gate ?? '(none)').join(', ')}`
      : identical
        ? 'gate+reasons+exit identical across 3 runs'
        : `drift: ${a} !== ${b} !== ${c}`
  );
} catch (e) {
  record('Det-3x-identical', false, `harness error: ${(e as Error).message}`);
}

// ── Term: a hanging check must be killed and still produce a verdict ──────────
try {
  const dir = makeRepo('term-hang', { 'README.md': '# fixture\n' }, { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST });
  writeFileSync(
    join(dir, 'spec.json'),
    JSON.stringify({
      checks: [
        { name: 'tests', run: 'bun test', is_test_command: true },
        { name: 'hang', run: 'bun -e "while(true){}"' },
      ],
      test_globs: ['**/*.test.ts'],
      require_test_efficacy: true,
    })
  );
  const run = runGate(dir, { DOD_SPEC: join(dir, 'spec.json').replace(/\\/g, '/'), DOD_CMD_TIMEOUT_MS: '3000' });
  const ok = run.exit !== 0 && run.verdict?.gate === 'FAIL' && run.elapsedMs < 90_000;
  record('Term-hanging-check', ok, `exit=${run.exit} gate=${run.verdict?.gate ?? '(none)'} elapsed=${run.elapsedMs}ms (must be killed, verdict written, no stall)`);
} catch (e) {
  record('Term-hanging-check', false, `harness error: ${(e as Error).message}`);
}

// ── NoSpec: no resolvable acceptance spec is a FAIL, never a pass ────────────
try {
  const dir = makeRepo('no-spec', { 'README.md': '# fixture\n' }, { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST });
  const run = runGate(dir); // no DOD_SPEC, no DOD_TASK, no plan.md
  const reasons = (run.verdict?.reasons ?? []).join(' | ').toLowerCase();
  const ok = run.exit !== 0 && run.verdict?.gate === 'FAIL' && reasons.includes('no acceptance spec found');
  record('NoSpec-fails-closed', ok, `exit=${run.exit} gate=${run.verdict?.gate ?? '(none)'} reasons="${reasons}"`);
} catch (e) {
  record('NoSpec-fails-closed', false, `harness error: ${(e as Error).message}`);
}

// ── Scope (R3): the gate must not read anything outside its own worktree ─────
try {
  const src = readFileSync(GATE, 'utf8');
  const offenders = /recent|ORDER BY|LIMIT|getActiveWorkflow|listRuns|\bdb\b/gi;
  const hits = src.match(offenders) ?? [];
  record('Scope-self-scoped', hits.length === 0, hits.length === 0 ? 'no cross-run/shared-store access patterns in dod-gate.ts' : `found: ${[...new Set(hits)].join(', ')}`);
} catch (e) {
  record('Scope-self-scoped', false, `harness error: ${(e as Error).message}`);
}

// ── summary ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} acceptance cases behaved as required.`);
if (failed.length > 0) {
  console.log('Not satisfied:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
console.log(
  '\nNOT covered by this harness (needs a live Archon run): the workflow-level R4 assertion that a\n' +
    'downstream push node is skipped after a gate FAIL. The gate\'s non-zero exit (asserted above for\n' +
    'every FAIL case) is the mechanism, but the executor-level skip is not exercised here.'
);
process.exit(failed.length === 0 ? 0 : 1);
