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
  expectExcluded?: string[]; // v1.7: files that MUST appear in verdict.efficacy.excluded_files
  expectNotExcluded?: string[]; // v1.8: files that must NEVER appear in verdict.efficacy.excluded_files
  env?: Record<string, string>;
  branch?: string; // rename the fixture branch after commits (to reproduce BASE_BRANCH==current branch)
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

const GITIGNORE_BODY = 'node_modules\ndist\n';
const CONFIG_JSON_BODY = '{\n  "featureFlag": true\n}\n';
const SH_SCRIPT_BODY = '#!/usr/bin/env bash\necho build\n';
const GREEN_UNRELATED_TEST =
  "import { test, expect } from 'bun:test';\n" +
  "test('unrelated but green', () => { expect(1 + 1).toBe(2); });\n";

// ── v1.9 curated-exclusion fixture bodies ─────────────────────────────────────────────────
// config.json is a NON-CURATED data file: under v1.9 it is unconditionally probed regardless
// of whether any tracked source references it (v1.8's reference-scan no longer exists).
const V19_CONFIG_JSON_BASE = '{\n  "specialMultiplier": 5\n}\n';
const V19_CONFIG_JSON_CHANGED = '{\n  "specialMultiplier": 999\n}\n';
const V19_FEATURE_TS =
  "import cfg from './config.json';\n" +
  "export function computeSpecial(mode: string, x: number): number {\n" +
  "  if (mode === 'special') return x * cfg.specialMultiplier;\n" +
  "  return x;\n" +
  "}\n";
const V19_FEATURE_TEST_NORMAL_ONLY =
  "import { test, expect } from 'bun:test';\n" +
  "import { computeSpecial } from './feature';\n" +
  "test('normal mode unaffected by config', () => { expect(computeSpecial('normal', 10)).toBe(10); });\n";
const V19_FEATURE_TEST_SPECIAL_BASE =
  "import { test, expect } from 'bun:test';\n" +
  "import { computeSpecial } from './feature';\n" +
  "test('special mode uses configured multiplier', () => { expect(computeSpecial('special', 10)).toBe(50); });\n";
const V19_FEATURE_TEST_SPECIAL_CHANGED =
  "import { test, expect } from 'bun:test';\n" +
  "import { computeSpecial } from './feature';\n" +
  "test('special mode uses configured multiplier', () => { expect(computeSpecial('special', 10)).toBe(9990); });\n";
// package.json bumped alone — a CURATED basename, excluded unconditionally by fiat (ergonomics),
// regardless of whether anything references it.
const V19_PACKAGE_JSON_BASE = '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n';
const V19_PACKAGE_JSON_CHANGED = '{\n  "name": "fixture",\n  "version": "1.0.1"\n}\n';
// tsconfig.json bumped alone — likewise a curated basename, excluded unconditionally.
const V19_TSCONFIG_JSON_BASE = '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n';
const V19_TSCONFIG_JSON_CHANGED = '{\n  "compilerOptions": {\n    "strict": true,\n    "target": "ES2022"\n  }\n}\n';

// ── v1.9 THE REGRESSION: templated env-config path defeats any textual reference-scan ────────
// `require('./config.' + env + '.json')` never contains the literal string "config.production.json"
// anywhere in configEnv.ts's source, so a textual reference-scan (v1.8) would have classified
// config.production.json as "unreferenced" and excluded it — a confirmed false PASS (round 9).
// v1.9 has no reference-scan at all: config.production.json is simply non-curated, so it is
// unconditionally probed.
const V19_ENV_CONFIG_JSON_BASE = '{\n  "specialMultiplier": 5\n}\n';
const V19_ENV_CONFIG_JSON_CHANGED = '{\n  "specialMultiplier": 999\n}\n';
const V19_CONFIG_ENV_TS =
  "const env = 'production';\n" +
  "const cfg = require('./config.' + env + '.json');\n" +
  "export function computeSpecial(mode: string, x: number): number {\n" +
  "  if (mode === 'special') return x * cfg.specialMultiplier;\n" +
  "  return x;\n" +
  "}\n";
const V19_CONFIG_ENV_TEST_NORMAL_ONLY =
  "import { test, expect } from 'bun:test';\n" +
  "import { computeSpecial } from './configEnv';\n" +
  "test('normal mode unaffected by config', () => { expect(computeSpecial('normal', 10)).toBe(10); });\n";

// ── v1.9 added non-curated data file (no v1.8 fixture exercised the ADDED-file revert path) ──
const V19_MULTIPLIER_JSON_BODY = '{\n  "value": 4\n}\n';
const V19_SCALE_TS =
  "import cfg from './multiplier.json';\n" +
  "export function scale(x: number): number {\n" +
  "  return x * cfg.value;\n" +
  "}\n";
const V19_SCALE_TEST =
  "import { test, expect } from 'bun:test';\n" +
  "import { scale } from './scale';\n" +
  "test('scale uses multiplier', () => { expect(scale(3)).toBe(12); });\n";

// ── v1.10: wildcard-abuse — app data wearing a linter-config NAME ────────────────────────────
// v1.9 curated linter configs by PREFIX wildcard ('.eslintrc*' matched base.startsWith('.eslintrc.')),
// so a file deliberately named `.eslintrc.data.json` — real source imports it and branches on its
// value — was swallowed by the exclusion set and rode through untested: a silent false PASS reachable
// by adversarial naming alone. v1.10 curates EXACT basenames only, so this name is ordinary
// non-curated data and is unconditionally revert-probed like any other .json.
const V110_ESLINTRC_DATA_JSON_BASE = '{\n  "bonusMultiplier": 3\n}\n';
const V110_ESLINTRC_DATA_JSON_CHANGED = '{\n  "bonusMultiplier": 777\n}\n';
const V110_BONUS_TS =
  "const cfg = require('./.eslintrc.data.json');\n" +
  'export function computeBonus(mode: string, x: number): number {\n' +
  "  if (mode === 'bonus') return x * cfg.bonusMultiplier;\n" +
  '  return x;\n' +
  '}\n';
const V110_BONUS_TEST_NORMAL_ONLY =
  "import { test, expect } from 'bun:test';\n" +
  "import { computeBonus } from './bonus';\n" +
  "test('normal mode unaffected by config', () => { expect(computeBonus('normal', 10)).toBe(10); });\n";
// The real ESLint config, exact curated basename — must STILL be excluded (the tightening must not
// over-correct into failing every ordinary lint-config bump).
const V110_REAL_ESLINTRC_BASE = '{\n  "rules": {\n    "no-console": "warn"\n  }\n}\n';
const V110_REAL_ESLINTRC_CHANGED = '{\n  "rules": {\n    "no-console": "error"\n  }\n}\n';

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
  {
    name: 'base-branch-head-good',
    why: 'WORKFLOW SCENARIO (v1.6): the change is committed ON branch `main` and the executor injects BASE_BRANCH=main, so merge-base(HEAD, main)==HEAD -> an empty base..HEAD diff. Before the base-resolution fix the gate FAILed "no test file changed"; the fix discards the degenerate base and falls through to HEAD~1, sees the real added+tested change, and PASSes.',
    base: { 'README.md': '# fixture\n' },
    change: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST },
    branch: 'main',
    env: { BASE_BRANCH: 'main' },
    expectGate: 'PASS',
    expectExitZero: true,
  },
  {
    name: 'base-branch-head-vacuous',
    why: 'VACUOUS TWIN of base-branch-head-good: same BASE_BRANCH=main empty-diff scenario, but the added impl is only imported (never exercised) by the test. The HEAD~1 fallback must still see the change and the per-file revert-probe must catch it as vacuous -> FAIL. Proves the base-resolution fix does NOT create a new false PASS.',
    base: { 'README.md': '# fixture\n' },
    change: { 'math.ts': GOOD_IMPL, 'math.test.ts': VACUOUS_TEST_WITH_IMPORT },
    branch: 'main',
    env: { BASE_BRANCH: 'main' },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'vacuous',
  },
  {
    name: 'v17-js-plus-gitignore',
    why: 'v1.7 THE FINDING: genuinely-tested math.ts + math.test.ts committed alongside a .gitignore. The .gitignore is non-behavioral and must be EXCLUDED from the efficacy probe (before v1.7 it folded to UNVERIFIED "unsupported language" and FAILed the whole gate). The real source is protected -> PASS.',
    base: { 'README.md': '# fixture\n' },
    change: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST, '.gitignore': GITIGNORE_BODY },
    expectGate: 'PASS',
    expectExitZero: true,
    expectExcluded: ['.gitignore'],
  },
  {
    name: 'v17-docs-only',
    why: 'v1.7: a docs-only commit (only README.md changed; the existing test is unchanged and still green; no behavioral source). No behavioral source -> efficacy N/A -> PASS.',
    base: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST, 'README.md': '# v1\n' },
    change: { 'README.md': '# v2 — docs update\n' },
    expectGate: 'PASS',
    expectExitZero: true,
  },
  {
    name: 'v17-added-shell-source-unverified',
    why: 'v1.7 ANTI-GAMING: an ADDED .sh source file (a language the gate cannot analyze) is NEVER excluded — it stays in the probe set and fails closed as UNVERIFIED "unsupported language" -> FAIL. Proves real code cannot hide in a non-JS/TS file and be waved through as "non-behavioral".',
    base: { 'README.md': '# fixture\n' },
    change: { 'build.sh': SH_SCRIPT_BODY, 'stuff.test.ts': GREEN_UNRELATED_TEST },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'unsupported language',
  },
  {
    name: 'v19-added-noncurated-manifest-vacuous-fails',
    why: 'v1.9 MANIFEST DECISION (was v1.7 "manifest excluded"; UPDATED): an ADDED .json data file (config.json, not a curated basename) changed alongside a genuinely-tested math.ts. Under v1.9 config.json is NOT excluded — it lands in probeSet as an added file and gets the minimal-empty-doc revert stub. No test in this diff exercises config.json at all, so its solo revert stays green -> unprotected -> FAIL, naming config.json. (Under the old v1.7/v1.8 model this used to PASS with config.json excluded; v1.9 deliberately removes that exclusion for non-curated data files.)',
    base: { 'README.md': '# fixture\n' },
    change: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST, 'config.json': CONFIG_JSON_BODY },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'config.json',
    expectNotExcluded: ['config.json'],
  },
  {
    name: 'v19-noncurated-manifest-plus-vacuous-js-fails',
    why: 'v1.9 MANIFEST DECISION twin (was v1.7 "manifest excluded" twin; UPDATED): the same non-curated .json data file alongside a JS change whose test only imports (never exercises) the symbol. Neither config.json nor math.ts is excluded now — both are efficacy-gated and both are unprotected -> FAIL. Proves a non-curated manifest can never ride along excluded next to an untested JS change.',
    base: { 'README.md': '# fixture\n' },
    change: { 'math.ts': GOOD_IMPL, 'math.test.ts': VACUOUS_TEST_WITH_IMPORT, 'config.json': CONFIG_JSON_BODY },
    expectGate: 'FAIL',
    expectReason: 'vacuous',
    expectExitZero: false,
    expectNotExcluded: ['config.json'],
  },
  {
    name: 'v19-noncurated-config-untested-fails',
    why: 'v1.9 (was v1.8 "THE BUG, closed"; UPDATED): config.json is imported+branched-on by feature.ts (base, unchanged in this diff); feature.test.ts (base, unchanged) exercises only the untested path. Commit changes ONLY config.json. v1.7 PASSed this ("no behavioral source changed" — confirmed blind-round-8 false PASS). v1.8 fixed it with a whole-repo textual reference-scan. v1.9 deletes that scan entirely: config.json is simply a non-curated data file, so it is UNCONDITIONALLY probed regardless of whether anything references it — no test protects it (no test file changed in this diff) -> FAIL, never excluded, never described as non-behavioral.',
    base: {
      'config.json': V19_CONFIG_JSON_BASE,
      'feature.ts': V19_FEATURE_TS,
      'feature.test.ts': V19_FEATURE_TEST_NORMAL_ONLY,
    },
    change: { 'config.json': V19_CONFIG_JSON_CHANGED },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'no test file changed',
    expectNotExcluded: ['config.json'],
  },
  {
    name: 'v19-curated-package-json-excluded-pass',
    why: 'v1.9 ERGONOMICS PRESERVED (was v1.8 "unreferenced" reasoning; UPDATED): package.json is changed ALONE (a version bump). It is excluded because its basename is in the CURATED allowlist by fiat — not because a reference-scan found no importer (that scan no longer exists). A manifest-only bump still PASSes with zero test burden.',
    base: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST, 'package.json': V19_PACKAGE_JSON_BASE },
    change: { 'package.json': V19_PACKAGE_JSON_CHANGED },
    expectGate: 'PASS',
    expectExitZero: true,
    expectExcluded: ['package.json'],
  },
  {
    name: 'v19-curated-tsconfig-json-excluded-pass',
    why: 'v1.9 ERGONOMICS (DoD item 2): tsconfig.json is changed ALONE (a compiler-option addition). Like package.json, its basename is in the curated allowlist, so it is excluded unconditionally and the commit PASSes with zero test burden.',
    base: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST, 'tsconfig.json': V19_TSCONFIG_JSON_BASE },
    change: { 'tsconfig.json': V19_TSCONFIG_JSON_CHANGED },
    expectGate: 'PASS',
    expectExitZero: true,
    expectExcluded: ['tsconfig.json'],
  },
  {
    name: 'v19-noncurated-config-tested-passes',
    why: 'v1.9 anti-over-correction (was v1.8 "anti-over-correction"; UPDATED): same non-curated config.json as v19-noncurated-config-untested-fails, but this time feature.test.ts genuinely asserts on the config-derived value and is updated alongside the config change (999 * 10 = 9990). config.json is unconditionally probed (it is never excluded, referenced or not); reverting it during the probe restores specialMultiplier=5, so the (unchanged-in-the-revert) test still expects 9990 but gets 50 -> RED -> config.json is individually protected -> gate=PASS. Proves a genuinely-tested non-curated data file still passes, and the protected file is never in excluded_files.',
    base: {
      'config.json': V19_CONFIG_JSON_BASE,
      'feature.ts': V19_FEATURE_TS,
      'feature.test.ts': V19_FEATURE_TEST_SPECIAL_BASE,
    },
    change: {
      'config.json': V19_CONFIG_JSON_CHANGED,
      'feature.test.ts': V19_FEATURE_TEST_SPECIAL_CHANGED,
    },
    expectGate: 'PASS',
    expectExitZero: true,
    expectNotExcluded: ['config.json'],
  },
  {
    name: 'v19-untested-ts-plus-curated-manifest-fails',
    why: 'v1.9 ANTI-GAMING (was v1.8 "unreferenced, tier 2"; UPDATED): a real added .ts file whose only test is vacuous (imports but never calls it) is committed alongside an unrelated package.json version bump. package.json is excluded because it is a curated basename (not because it happens to be unreferenced) but the untested .ts file is STILL efficacy-gated -> caught as vacuous -> FAIL. Proves a curated-manifest exclusion never lets an untested JS/TS change ride along (the twin of the pre-existing .py/.sh added-source fixtures, which stay UNVERIFIED/FAIL unaffected by this change since they are never data/manifest types).',
    base: { 'README.md': '# fixture\n', 'package.json': V19_PACKAGE_JSON_BASE },
    change: {
      'mul.ts': 'export const mul = (a: number, b: number): number => a * b;\n',
      'mul.test.ts':
        "import { test, expect } from 'bun:test';\n" +
        "import { mul } from './mul';\n" +
        "test('vacuous', () => { expect(1 + 1).toBe(2); });\n",
      'package.json': V19_PACKAGE_JSON_CHANGED,
    },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'vacuous',
    expectExcluded: ['package.json'],
  },
  {
    name: 'v19-templated-path-regression-fails',
    why: "v1.9 DoD item 1 — THE PERMANENT REGRESSION FIXTURE (round 9): configEnv.ts (base, unchanged) loads its config via a TEMPLATED path, require('./config.' + env + '.json'), so the literal string \"config.production.json\" never appears anywhere in configEnv.ts's source. A textual reference-scan (v1.8) would see no match and classify config.production.json as \"unreferenced\" -> excluded -> false PASS on an untested config-branch change. v1.9 has no reference-scan: config.production.json is simply non-curated, so it is unconditionally probed. Commit changes ONLY config.production.json; the only test (base, unchanged) exercises solely the untested-branch-irrelevant \"normal\" path -> no test file changed in this diff -> gate=FAIL, excluded_files empty (config.production.json is the only non-test changed file and it is never excluded).",
    base: {
      'config.production.json': V19_ENV_CONFIG_JSON_BASE,
      'configEnv.ts': V19_CONFIG_ENV_TS,
      'configEnv.test.ts': V19_CONFIG_ENV_TEST_NORMAL_ONLY,
    },
    change: { 'config.production.json': V19_ENV_CONFIG_JSON_CHANGED },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'no test file changed',
    expectNotExcluded: ['config.production.json'],
  },
  {
    name: 'v19-added-noncurated-manifest-real-passes',
    why: 'v1.9 DoD item 4 twin (real case; no v1.8 fixture exercised the ADDED-file revert path for a non-curated data file): multiplier.json (added, non-curated) + scale.ts (added) that imports and uses its value + scale.test.ts (added) that genuinely asserts on the computed result. Reverting multiplier.json alone to the minimal-empty-doc stub ({}) makes cfg.value undefined, so scale(3) diverges from the expected 12 -> RED -> protected. Reverting scale.ts alone throws under its stub -> RED -> protected. Both individually protected -> gate=PASS. Proves the added-data-file revert path correctly credits a genuinely-tested addition, not just fail it.',
    base: { 'README.md': '# fixture\n' },
    change: {
      'multiplier.json': V19_MULTIPLIER_JSON_BODY,
      'scale.ts': V19_SCALE_TS,
      'scale.test.ts': V19_SCALE_TEST,
    },
    expectGate: 'PASS',
    expectExitZero: true,
    expectNotExcluded: ['multiplier.json'],
  },
  {
    name: 'v110-eslintrc-wildcard-abuse-fails',
    why: "v1.10 THE PERMANENT REGRESSION FIXTURE (blind round 10): `.eslintrc.data.json` is APP DATA wearing a linter-config name — bonus.ts (base, unchanged) requires it and branches on cfg.bonusMultiplier. v1.9's prefix-wildcard curation ('.eslintrc*') matched the basename and excluded it, so changing it ALONE and untested was a silent false PASS reachable by naming alone. v1.10 curates exact basenames only, so this file is non-curated data and is unconditionally probed: the commit changes ONLY .eslintrc.data.json, the sole (base, unchanged) test exercises just the irrelevant 'normal' path -> no test file changed -> gate=FAIL with the data file NOT excluded.",
    base: {
      '.eslintrc.data.json': V110_ESLINTRC_DATA_JSON_BASE,
      'bonus.ts': V110_BONUS_TS,
      'bonus.test.ts': V110_BONUS_TEST_NORMAL_ONLY,
    },
    change: { '.eslintrc.data.json': V110_ESLINTRC_DATA_JSON_CHANGED },
    expectGate: 'FAIL',
    expectExitZero: false,
    expectReason: 'no test file changed',
    expectNotExcluded: ['.eslintrc.data.json'],
  },
  {
    name: 'v110-real-eslintrc-json-still-excluded-pass',
    why: 'v1.10 anti-over-correction twin: `.eslintrc.json` is the REAL ESLint config and an exact curated basename, so tightening the wildcard must not start efficacy-gating ordinary lint-rule bumps. Changed ALONE, it is excluded unconditionally and the commit PASSes with zero test burden — the same ergonomics package.json/tsconfig.json get.',
    base: { 'math.ts': GOOD_IMPL, 'math.test.ts': REAL_TEST, '.eslintrc.json': V110_REAL_ESLINTRC_BASE },
    change: { '.eslintrc.json': V110_REAL_ESLINTRC_CHANGED },
    expectGate: 'PASS',
    expectExitZero: true,
    expectExcluded: ['.eslintrc.json'],
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
function makeRepo(name: string, base: Files, change: Files, branch?: string): string {
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
  if (branch) sh('git', ['branch', '-M', branch], dir);
  return dir;
}

interface GateRun {
  exit: number;
  verdict: { gate?: string; reasons?: string[]; efficacy?: { verdict?: string; excluded_files?: string[] } } | null;
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
    const dir = makeRepo(f.name, f.base, f.change, f.branch);
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(f.spec ?? COMMON_SPEC, null, 2));
    const run = runGate(dir, { DOD_SPEC: join(dir, 'spec.json').replace(/\\/g, '/'), ...(f.env ?? {}) });

    const gateOk = run.verdict?.gate === f.expectGate;
    const exitOk = f.expectExitZero ? run.exit === 0 : run.exit !== 0;
    const reasons = (run.verdict?.reasons ?? []).join(' | ');
    const reasonOk = !f.expectReason || reasons.toLowerCase().includes(f.expectReason.toLowerCase());
    const excludedList = run.verdict?.efficacy?.excluded_files ?? [];
    const excludedOk = !f.expectExcluded || f.expectExcluded.every((e) => excludedList.includes(e));
    const notExcludedOk = !f.expectNotExcluded || f.expectNotExcluded.every((e) => !excludedList.includes(e));

    record(
      f.name,
      gateOk && exitOk && reasonOk && excludedOk && notExcludedOk,
      `gate=${run.verdict?.gate ?? '(none)'} exit=${run.exit}` +
        (f.expectReason ? ` reason${reasonOk ? '✓' : '✗'}="${f.expectReason}"` : '') +
        (f.expectExcluded ? ` excluded${excludedOk ? '✓' : '✗'}=[${f.expectExcluded.join(', ')}]` : '') +
        (f.expectNotExcluded ? ` notExcluded${notExcludedOk ? '✓' : '✗'}=[${f.expectNotExcluded.join(', ')}]` : '') +
        (gateOk && exitOk && reasonOk && excludedOk && notExcludedOk ? '' : `  << expected gate=${f.expectGate} exit${f.expectExitZero ? '=0' : '≠0'}; reasons: ${reasons || '(none)'}; excluded_files=[${excludedList.join(', ')}]`)
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
