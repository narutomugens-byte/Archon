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
const SKIP_VACUOUS_TEST =
  "import { test, expect } from 'bun:test';\n" +
  "import { add } from './math';\n" +
  "test('unrelated dummy', () => { expect(1 + 1).toBe(2); });\n" +
  "test.skip('add works (skipped)', () => { expect(add(2, 3)).toBe(5); });\n";

// Round-4 confirmed false-PASS shape: a long non-ASCII exported identifier. Defined once
// so the impl file and both tests reference the byte-identical name (no drift).
const UNICODE_LONG_NAME = '$_αβγΩ_veryLongIdentifierName_9876543210';
const UNICODE_LONG_IMPL = `export const ${UNICODE_LONG_NAME} = 42;\n`;
const UNICODE_LONG_VACUOUS_TEST =
  "import { test, expect } from 'bun:test';\n" +
  `import { ${UNICODE_LONG_NAME} } from './u';\n` +
  `test('vacuous', () => { const _ = ${UNICODE_LONG_NAME}; expect(1 + 1).toBe(2); });\n`;
const UNICODE_LONG_REAL_TEST =
  "import { test, expect } from 'bun:test';\n" +
  `import { ${UNICODE_LONG_NAME} } from './u';\n` +
  `test('real', () => { expect(${UNICODE_LONG_NAME}).toBe(42); });\n`;

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
    name: '8-skip-vacuous-added',
    why: 'DEFECT1: added impl file + the only test that exercises it is test.skip; an unrelated test passes. Truncation miscredited the link-error as efficacy; the throwing stub must expose it as vacuous.',
    base: { 'README.md': '# fixture\n' },
    change: { 'math.ts': GOOD_IMPL, 'math.test.ts': SKIP_VACUOUS_TEST },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'vacuous',
  },
  {
    name: '9-skip-real-runs-added',
    why: 'anti-over-correction: same added impl file but the meaningful test is NOT skipped — it calls add at runtime, so the throwing stub makes it RED. Must still PASS (the fix must not fail every added-file case).',
    base: { 'README.md': '# fixture\n' },
    change: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST },
    expectGate: 'PASS',
    expectExitZero: true,
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
  {
    name: 'enum-added-vacuous',
    why: 'DEFECT1: added flags.ts = `export enum Mode`; test imports+references Mode but asserts only 1+1. The enum export must be stubbed (or fail-closed) so the vacuous test is caught, never miscredited via a link error.',
    base: { 'README.md': '# fixture\n' },
    change: {
      'flags.ts': 'export enum Mode { A, B }\n',
      'flags.test.ts':
        "import { test, expect } from 'bun:test';\n" +
        "import { Mode } from './flags';\n" +
        "test('vacuous', () => { const _ = Mode; expect(1 + 1).toBe(2); });\n",
    },
    // reason may be `vacuous` OR the unrecognized-shape reason — either is an acceptable
    // FAIL, so we assert only gate=FAIL + exit!=0 (NOT PASS), per spec.
    expectGate: 'FAIL',
    expectExitZero: false,
  },
  {
    name: 'enum-added-real',
    why: 'anti-over-correction: same added flags.ts, but the test depends on the enum value (expect(Mode.A).toBe(0)). Under the value-collapsed stub the assertion diverges -> RED -> correctly credited PASS. A genuine enum change must still pass.',
    base: { 'README.md': '# fixture\n' },
    change: {
      'flags.ts': 'export enum Mode { A, B }\n',
      'flags.test.ts':
        "import { test, expect } from 'bun:test';\n" +
        "import { Mode } from './flags';\n" +
        "test('mode A is 0', () => { expect(Mode.A).toBe(0); });\n",
    },
    expectGate: 'PASS',
    expectExitZero: true,
  },
  {
    name: 'multi-declarator-added-vacuous',
    why: 'DEFECT1: added k.ts = `export const a = 1, b = 2;`. The old parser collected only `a`; import { b } against a stub missing `b` was a link error miscredited as efficacy. Multi-declarator must collect every name so the vacuous test is caught.',
    base: { 'README.md': '# fixture\n' },
    change: {
      'k.ts': 'export const a = 1, b = 2;\n',
      'k.test.ts':
        "import { test, expect } from 'bun:test';\n" +
        "import { a, b } from './k';\n" +
        "test('vacuous', () => { const _ = a + b; expect(1 + 1).toBe(2); });\n",
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'vacuous',
  },
  {
    name: 'nonjs-added-failclosed',
    why: 'surviving fail-closed net (v1.4): an ADDED non-test source file whose language is not JS/TS cannot be runtime-enumerated for its exports, so no behavior-removed stub can be built. Paired with a green test, efficacy is UNVERIFIED -> FAIL under strict — never a silent PASS. Runtime enumeration closed the source-text-shape class entirely; this proves the remaining fail-closed path (non-JS/TS or non-importable) still holds.',
    base: { 'README.md': '# fixture\n' },
    change: {
      'impl.py': 'def foo():\n    return 1\n',
      'stuff.test.ts':
        "import { test, expect } from 'bun:test';\n" +
        "test('unrelated but green', () => { expect(1 + 1).toBe(2); });\n",
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'unsupported language',
  },
  {
    name: 'two-exports-one-line-vacuous',
    why: 'F1 (CRITICAL false PASS): two export statements on ONE physical line ' +
      '(`export function foo(){...} export const bar = 2;`). The line-oriented scanner ' +
      'collected only `foo` and dropped `bar`, so the stub was missing `bar`; `import { bar }` ' +
      'link-crashed under revert and the crash was miscredited as efficacy. Both exports must be ' +
      'stubbed so a test that only references them as values stays green and is caught as vacuous.',
    base: { 'README.md': '# fixture\n' },
    change: {
      'one.ts': 'export function foo() { return 1; } export const bar = 2;\n',
      'one.test.ts':
        "import { test, expect } from 'bun:test';\n" +
        "import { foo, bar } from './one';\n" +
        "test('vacuous', () => { const _ = foo; const __ = bar; expect(1 + 1).toBe(2); });\n",
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'vacuous',
  },
  {
    name: 'two-exports-one-line-real',
    why: 'anti-over-correction twin of two-exports-one-line-vacuous: same two-exports-on-one-line ' +
      'shape, but the test actually calls foo() and depends on bar. Under the throwing stub foo() ' +
      'throws -> RED -> correctly credited PASS. The fix must stub BOTH exports without fail-closing ' +
      'every two-export-line case.',
    base: { 'README.md': '# fixture\n' },
    change: {
      'one.ts': 'export function foo() { return 1; } export const bar = 2;\n',
      'one.test.ts':
        "import { test, expect } from 'bun:test';\n" +
        "import { foo, bar } from './one';\n" +
        "test('foo and bar', () => { expect(foo()).toBe(1); expect(bar).toBe(2); });\n",
    },
    expectGate: 'PASS',
    expectExitZero: true,
  },
  {
    name: 'unicode-long-vacuous',
    why: 'ROUND-4 confirmed false PASS under the regex parser: an added file exporting a long non-ASCII identifier (`export const $_αβγΩ_veryLong… = 42;`). A regex length/codepoint bound mis-extracted the name, the stub omitted it, `import { name }` link-crashed under revert, and the crash was miscredited as efficacy. Runtime enumeration returns the exact name, the stub preserves it, and the vacuous test (references the value, asserts 1+1) stays green under revert -> correctly caught as vacuous.',
    base: { 'README.md': '# fixture\n' },
    change: { 'u.ts': UNICODE_LONG_IMPL, 'u.test.ts': UNICODE_LONG_VACUOUS_TEST },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'vacuous',
  },
  {
    name: 'unicode-long-real',
    why: 'anti-over-correction twin: same added unicode-identifier file, but the test depends on the value (expect(name).toBe(42)). Under the value-collapsed throwing stub the assertion diverges -> RED -> correctly credited PASS. A genuine change on a unicode-named export must still pass.',
    base: { 'README.md': '# fixture\n' },
    change: { 'u.ts': UNICODE_LONG_IMPL, 'u.test.ts': UNICODE_LONG_REAL_TEST },
    expectGate: 'PASS',
    expectExitZero: true,
  },
  {
    name: 'multifile-one-untested-added',
    why: 'DIFF-WIDE gaming vector (v1.5): commit ADDS two non-test files — a.ts is genuinely tested (real assertion), b.ts only has a vacuous test that references it as a value. The old diff-wide probe PASSed (a.ts made the whole revert red); the per-file probe must FAIL and name b.ts as unprotected.',
    base: { 'README.md': '# fixture\n' },
    change: {
      'a.ts': 'export const a = (): number => 1;\n',
      'b.ts': 'export const b = (): number => 2;\n',
      'ab.test.ts':
        "import { test, expect } from 'bun:test';\n" +
        "import { a } from './a';\n" +
        "import { b } from './b';\n" +
        "test('a real', () => { expect(a()).toBe(1); });\n" +
        "test('b vacuous', () => { const _ = b; expect(1 + 1).toBe(2); });\n",
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'b.ts',
  },
  {
    name: 'multifile-both-tested-added',
    why: 'anti-over-correction twin: the same two added files, but BOTH have a real assertion that calls the export. Each file\u2019s solo revert throws under the stub -> RED -> both individually protected -> PASS. The strict per-file policy must not fail a genuinely-covered multi-file change.',
    base: { 'README.md': '# fixture\n' },
    change: {
      'a.ts': 'export const a = (): number => 1;\n',
      'b.ts': 'export const b = (): number => 2;\n',
      'ab.test.ts':
        "import { test, expect } from 'bun:test';\n" +
        "import { a } from './a';\n" +
        "import { b } from './b';\n" +
        "test('a real', () => { expect(a()).toBe(1); });\n" +
        "test('b real', () => { expect(b()).toBe(2); });\n",
    },
    expectGate: 'PASS',
    expectExitZero: true,
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

// ── DeletedFile-clean-tree (Defect 2): deleting a non-test source file must not leave
//    the working tree dirty (no resurrected file staged as `A`, no stray `??`). ──
try {
  const dir = join(ROOT, 'deleted-nonTest-clean-tree').replace(/\\/g, '/');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  sh('git', ['init', '--quiet'], dir);
  sh('git', ['config', 'user.email', 'gate@example.test'], dir);
  sh('git', ['config', 'user.name', 'Gate Fixture'], dir);
  sh('git', ['config', 'commit.gpgsign', 'false'], dir);
  // base commit: victim.ts (to be deleted) + math.ts (BASE_IMPL) + a real test that covers math.
  writeFiles(dir, {
    'victim.ts': 'export const victim = (): number => 42;\n',
    'math.ts': BASE_IMPL,
    'math.test.ts': REAL_TEST,
  });
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '--quiet', '-m', 'base'], dir);
  // change commit: DELETE victim.ts and upgrade math.ts to the covered implementation.
  // Modify the test file too, so the probe's `testFiles` is non-empty and the
  // revert-probe actually runs — resurrecting victim.ts and exercising the
  // finally-block `git rm` cleanup. Without a changed test file the gate
  // short-circuits at "no test file changed" and never touches the tree,
  // making this Defect-2 fixture vacuous.
  rmSync(join(dir, 'victim.ts'), { force: true });
  writeFiles(dir, {
    'math.ts': GOOD_IMPL,
    'math.test.ts': REAL_TEST + "test('add works 2', () => { expect(add(4, 5)).toBe(9); });\n",
  });
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '--quiet', '-m', 'delete victim + real change'], dir);

  writeFileSync(join(dir, 'spec.json'), JSON.stringify(COMMON_SPEC, null, 2));
  const run = runGate(dir, { DOD_SPEC: join(dir, 'spec.json').replace(/\\/g, '/') });

  // The assertion: after the gate returns, the tree/index must be clean — victim.ts must
  // NOT reappear as `A`/`??`. Gate verdict itself may be PASS or FAIL; we assert cleanliness.
  const status = spawnSync('git', ['-c', 'core.autocrlf=false', 'status', '--porcelain'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const dirty = (status.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('??'))
    .join(' / ');
  const ok = dirty === '';
  record(
    'DeletedFile-clean-tree',
    ok,
    ok
      ? `tree clean after gate (gate=${run.verdict?.gate ?? '(none)'} exit=${run.exit})`
      : `tree left dirty after gate: "${dirty.replace(/\n/g, ' / ')}" (gate=${run.verdict?.gate ?? '(none)'})`
  );
} catch (e) {
  record('DeletedFile-clean-tree', false, `harness error: ${(e as Error).message}`);
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

// ── NoOrphan: after a timeout, the tree-kill must leave no surviving grandchild ──
try {
  const dir = makeRepo(
    'no-orphan',
    { 'README.md': '# fixture\n' },
    { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST }
  );
  writeFileSync(
    join(dir, 'spec.json'),
    JSON.stringify({
      checks: [
        { name: 'tests', run: 'bun test', is_test_command: true },
        { name: 'hang', run: 'bun -e "/*DODORPHAN9137*/ while(true){}"' },
      ],
      test_globs: ['**/*.test.ts'],
      require_test_efficacy: true,
    })
  );
  const run = runGate(dir, {
    DOD_SPEC: join(dir, 'spec.json').replace(/\\/g, '/'),
    DOD_CMD_TIMEOUT_MS: '3000',
  });

  // Give the OS a moment to reap the killed tree, then count survivors by marker.
  const countOrphans = (): number => {
    if (process.platform === 'win32') {
      const ps = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "(Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { $_.CommandLine -like '*DODORPHAN9137*' } | Measure-Object).Count",
        ],
        { encoding: 'utf8' }
      );
      return parseInt((ps.stdout ?? '').trim(), 10) || 0;
    }
    const pg = spawnSync('pgrep', ['-f', 'DODORPHAN9137'], { encoding: 'utf8' });
    return (pg.stdout ?? '').trim() ? (pg.stdout ?? '').trim().split('\n').filter(Boolean).length : 0;
  };

  const orphans = countOrphans();
  if (orphans > 0) {
    // Cleanup so a failure here does not leak CPU-bound orphans out of the harness.
    if (process.platform === 'win32') {
      spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { $_.CommandLine -like '*DODORPHAN9137*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ]);
    } else {
      spawnSync('pkill', ['-9', '-f', 'DODORPHAN9137']);
    }
  }
  const ok = run.verdict?.gate === 'FAIL' && run.exit !== 0 && orphans === 0;
  record(
    'NoOrphan-after-timeout',
    ok,
    `exit=${run.exit} gate=${run.verdict?.gate ?? '(none)'} survivingOrphans=${orphans} (must be 0)`
  );
} catch (e) {
  record('NoOrphan-after-timeout', false, `harness error: ${(e as Error).message}`);
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
console.log(`HARNESS_EXIT=${failed.length === 0 ? 0 : 1}`);
process.exit(failed.length === 0 ? 0 : 1);
