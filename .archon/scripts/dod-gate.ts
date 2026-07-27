#!/usr/bin/env bun
/**
 * Definition-of-Done Gate — the deterministic terminal verifier for an autonomous
 * build loop. Proves a change is actually DONE rather than trusting the building
 * agent's word. First buildable increment of the "trustworthy autonomous loop"
 * (see .claude/PRPs/autonomous-loop-prd.md).
 *
 * What it does (all deterministic — NO LLM in the pass/fail decision):
 *   R1  Re-executes the operator's acceptance CHECKS itself. Any non-zero -> FAIL.
 *   R2  Test-efficacy REVERT-PROBE (per-file): reverts EACH changed non-test source
 *       file individually and re-runs the test command; a file whose solo revert flips
 *       no test red is unprotected -> FAIL, naming it. Efficacy PASSes iff every changed
 *       non-test file is individually protected. Genuinely non-behavioral files are
 *       unconditionally excluded by a SMALL CURATED allowlist ONLY (docs, images,
 *       lockfiles, common dotfile configs, and the manifest basenames package.json /
 *       tsconfig.json / jsconfig.json — v1.9). No other data/manifest file (.json/.yaml/
 *       /.yml/.toml) can be excluded by any heuristic — every one is efficacy-gated
 *       exactly like any other changed file (v1.9 dropped the v1.8 textual reference-scan,
 *       which a templated `require('./config.' + env + '.json')` path defeated). Exclusions
 *       are listed in `verdict.efficacy.excluded_files`; source in a language the gate
 *       cannot analyze (.py/.go/.rs/.sh) is never excluded and stays UNVERIFIED (anti-gaming).
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
 *   - Newly-added JS/TS source files are replaced with a THROWING STUB that preserves
 *     the export surface but removes behavior; unsupported/unenumerable added files fold
 *     to UNVERIFIED (fail-closed).
 *   - v1.9 CURATED non-behavioral file partition: docs/lockfiles/config-dotfiles/images
 *     plus a small curated manifest basename set (package.json/tsconfig.json/jsconfig.json)
 *     are unconditionally excluded from the efficacy probe — by fiat, never by content or
 *     a repo-wide reference scan. v1.7 excluded ALL `.json/.yaml/.yml/.toml` by extension
 *     (a config file a source genuinely imports and branches on could be changed ALONE,
 *     untested, and falsely PASS); v1.8 tried to save that by conditioning exclusion on a
 *     textual "does any source reference this basename" scan, but a templated path like
 *     `` require(`./config.${env}.json`) `` never contains the literal referenced basename,
 *     so the scan said "unreferenced" and the same false PASS recurred. v1.9 removes the
 *     scan entirely: NO data/manifest file can be excluded except the three curated
 *     basenames above; every other `.json/.yaml/.yml/.toml` is probed like any other
 *     changed file — a MODIFIED one reverts via `git checkout <base> -- <f>`; an ADDED one
 *     reverts to a minimal empty valid document of its own type (e.g. `{}` for JSON) so the
 *     import still resolves but the values are gone — never the JS/TS export-stub path,
 *     which does not apply to non-JS/TS files.
 *   - Every spawned command carries a timeout with a watchdog that tree-kills (taskkill /t /f
 *     on Windows, negative-pid SIGKILL on POSIX), so orphans cannot survive a timeout.
 *
 * WHAT "efficacy PASS" MEANS (honest boundary — see plan section 2.8):
 *   A file-granularity revert-probe proves "at least one test flips red when the
 *   implementation is REMOVED". It does NOT prove "the test catches every wrong value
 *   the implementation could return". A test that calls the implementation but asserts
 *   weakly still flips red on removal and is credited. The guarantee this gate makes is
 *   the narrow, checkable one: a test that never exercises the change at all cannot make
 *   anything flip red, and therefore FAILs.
 *
 *   Two known boundaries follow from that (both confirmed by adversarial verification;
 *   neither is fixable without abandoning the deterministic, file-granularity design):
 *   - WEAK-ASSERTION: merely INVOKING the changed symbol counts as exercising it, even
 *     if nothing about its result is asserted. `add(2,3); expect(1+1).toBe(2)` and
 *     `new Counter(5); expect(1+1).toBe(2)` both flip red on removal (the call/constructor
 *     throws under the stub) and are credited PASS. Distinguishing "invokes and depends
 *     on the result" from "invokes and ignores it" needs assertion-dataflow analysis,
 *     which is out of scope. The gate catches "never invokes it at all", not "invokes it
 *     but checks nothing".
 *   - PER-FILE (v1.5): the probe reverts EACH changed non-test file individually and
 *     requires that file's solo revert to turn at least one test red. A file that stays
 *     green when reverted alone is unprotected and FAILs, named in verdict.json.efficacy.
 *     This closes the earlier diff-wide blind spot (an untested file bundled with a
 *     tested one). Cost is O(number-of-changed-non-test-files) suite runs; a single-file
 *     change (the common case) is N=1 — identical cost and behavior to the diff-wide probe.
 *     STRICT policy: every changed non-test file must be individually protected, so a
 *     legitimate refactor whose helper file no test hits directly will FAIL — split the
 *     commit or add a direct test (the right response for an unattended gate).
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
 *   DOD_BASE / BASE_BRANCH    — base ref for the change diff. A ref that resolves to HEAD
 *                               (empty base..HEAD diff) is discarded; the chain falls through
 *                               to @{upstream} then HEAD~1. See §base-resolution above resolveBase.
 *   DOD_STRICT ("1" default)  — FAIL-closed: UNVERIFIED efficacy -> FAIL. "0" = WARN-open.
 *   DOD_CMD_TIMEOUT_MS        — per-spawned-command timeout in ms (default 300000).
 *
 * Exit: 0 = gate PASS, 1 = gate FAIL (or a fatal input error).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
  protected_files?: string[];   // changed non-test files whose solo revert turned a test red
  unprotected_files?: string[]; // changed non-test files that stayed green when reverted alone
  excluded_files?: string[];    // v1.9: changed non-test files matching the CURATED non-behavioral allowlist (docs/lockfiles/dotfile-configs/images/package.json/tsconfig.json/jsconfig.json) — never subject to the efficacy probe. No other data/manifest file can appear here.
  reason?: string;
}

// v1.11: EXACT suffix patterns only — never a directory glob (`test/**`) or a
// substring match (`**/*test*`). This list is an EXEMPTION set: anything matching
// it is excluded from the revert probe and counts as "protection", so an over-broad
// entry is a silent false PASS (change `test/helper.js`, claim the change is tested).
// Erring narrow only costs a false FAIL. Pre-v1.11 the list carried the TS/Python
// suffixes but no JS ones at all, so in any JavaScript repo a real `*.test.js` edit
// was classified as behavioral source — "no test file changed — nothing protects
// this change" on genuinely well-tested work. The 43-fixture harness could not see
// it because every fixture pins `test_globs` in its own spec; only the calibration
// suite, which leaves the default in force, exercises this constant.
const DEFAULT_TEST_GLOBS = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.test.mjs',
  '**/*.test.cjs',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.spec.js',
  '**/*.spec.jsx',
  '**/*.spec.mjs',
  '**/*.spec.cjs',
  '**/*_test.py',
  '**/test_*.py',
];

// ── Small helpers ────────────────────────────────────────────────────────────
function tail(s: string, n = 2000): string {
  const t = s.replace(/\r\n/g, '\n');
  return t.length > n ? '…' + t.slice(-n) : t;
}

/**
 * Run a shell command string with a hard timeout. Uses an async spawn + a watchdog
 * that tree-kills on expiry (taskkill /t /f on Windows, negative-pid SIGKILL on POSIX)
 * so a hanging check can never stall the gate and no orphan survives.
 */
async function runShell(cmd: string): Promise<{ code: number; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, env: process.env, detached: process.platform !== 'win32' });
    let out = '';
    let total = 0;
    const cap = 64 * 1024 * 1024;
    const append = (chunk: Buffer) => {
      if (total >= cap) return;
      const s = chunk.toString('utf8');
      const room = cap - total;
      out += s.slice(0, room);
      total = Math.min(cap, total + Buffer.byteLength(s, 'utf8'));
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          child.kill('SIGKILL');
        }
      }
    }, CMD_TIMEOUT_MS);

    child.on('close', (code, signal) => {
      clearTimeout(watchdog);
      const exitCode = code ?? (timedOut ? 124 : signal ? 1 : 0);
      resolve({ code: exitCode, out, timedOut });
    });

    child.on('error', () => {
      clearTimeout(watchdog);
      resolve({ code: 127, out, timedOut });
    });
  });
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

// ── v1.9: non-behavioral file classification (content-INDEPENDENT — CURATED allowlist only) ──
//
// A file that cannot carry testable runtime behavior is EXCLUDED from the efficacy revert-probe:
// a changed .gitignore / README / lockfile is not an untested implementation, and before v1.7 the
// probe folded such a file to UNVERIFIED ("unsupported language") and FAILed the whole gate on
// almost every real commit.
//
// CRITICAL anti-gaming boundary: this list contains ONLY clearly non-executable file types plus a
// SMALL, EXPLICIT, well-known set of manifest basenames (see below). A source-code language the
// gate cannot analyze (.py/.go/.rs/.sh/...) is NEVER listed here — it stays in the probe set and
// fails closed (UNVERIFIED under strict) so real code cannot hide in an "excluded" bucket.
// Classification is on the file's own extension/basename, never its content, so it is
// deterministic and unspoofable.
//
// MANIFEST DECISION (v1.9 — replaces v1.7's blanket extension exclusion AND v1.8's textual
// reference-scan): v1.7 excluded every `.json/.yaml/.yml/.toml` by extension alone, which let a
// config file that source genuinely imports and branches on be changed ALONE, untested, and PASS
// (a confirmed false PASS). v1.8 tried to fix that by excluding a data/manifest file only if no
// tracked source textually referenced its basename — but a templated path like
// `` require(`./config.${env}.json`) `` never contains the literal basename, so the scan said
// "unreferenced" and the same false PASS recurred (round 9). "Is this data file depended on" is
// not textually decidable; v1.9 stops guessing. The ONLY data/manifest files ever excluded are the
// three curated basenames below (version/dependency/compiler config that needs no runtime test);
// every other `.json/.yaml/.yml/.toml` file, referenced or not, goes into the same efficacy probe
// as any other changed file (see runRevertProbe) — a MODIFIED one reverts via `git checkout`, an
// ADDED one reverts to a minimal empty valid document of its type (see DATA_MANIFEST_EXTS below).
const NON_BEHAVIORAL_EXTS = new Set<string>([
  // docs
  '.md', '.mdx', '.txt', '.rst',
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
]);
const NON_BEHAVIORAL_BASENAMES = new Set<string>([
  // lockfiles
  'bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'cargo.lock', 'poetry.lock', 'composer.lock', 'gemfile.lock',
  // common repo dotfiles / config
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.dockerignore',
  // v1.9: curated manifest basenames — version/dep/compiler config, no runtime test needed.
  // Deliberately SMALL and well-known; do not add speculative entries. No other .json/.yaml/
  // .yml/.toml basename or extension is excludable by any means (see MANIFEST DECISION above).
  'package.json', 'tsconfig.json', 'jsconfig.json',
  // v1.10: linter/formatter configs as EXACT basenames. These used to be prefix-wildcards
  // ('.eslintrc*' / '.prettierrc*'), so an app-data file deliberately named `.eslintrc.data.json`
  // — real code importing and branching on it — rode the wildcard into the exclusion set and
  // produced a silent false PASS. Exact names leave no wildcard to abuse: any other
  // `.eslintrc.<x>` / `.prettierrc.<x>` is revert-probed like ordinary data.
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml', '.eslintrc.yml',
  '.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.yaml',
  '.prettierrc.yml', '.prettierrc.toml',
]);

/** True iff `path` is a genuinely non-behavioral file (never efficacy-gated). Basename/ext only. */
function isNonBehavioralFile(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1).toLowerCase();
  if (NON_BEHAVIORAL_BASENAMES.has(base)) return true;
  return NON_BEHAVIORAL_EXTS.has(extname(base).toLowerCase());
}

// Data/manifest extensions. v1.9 DELETED the v1.8 reference-scan that used to conditionally
// exclude files of these extensions — this set is now used ONLY to pick the minimal empty-doc
// revert stub for an ADDED non-curated data file in the probe set (see addedStubs below); it is
// never an exclusion driver. A file of one of these extensions is excluded ONLY if its basename
// is also in NON_BEHAVIORAL_BASENAMES (the curated manifest list above) — never by extension.
const DATA_MANIFEST_EXTS = new Set<string>(['.json', '.yaml', '.yml', '.toml']);

// JS/TS-family source extensions. Used by the added-file export-enumeration probe further down
// (what the gate can runtime-stub).
const JS_TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

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
  body: { checks: CheckResult[]; efficacy: Efficacy; reasons: string[]; base?: string | null; base_source?: string | null }
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
    base_source: body.base_source ?? null,
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
        `## Test efficacy (per-file revert-probe)\n- verdict: ${body.efficacy.verdict}` +
        (body.efficacy.reason ? ` — ${body.efficacy.reason}` : '') +
        (body.efficacy.protected_files?.length
          ? `\n- protected (solo revert turns a test red): ${body.efficacy.protected_files.join(', ')}`
          : '') +
        (body.efficacy.unprotected_files?.length
          ? `\n- unprotected (solo revert leaves every test green): ${body.efficacy.unprotected_files.join(', ')}`
          : '') +
        (body.efficacy.excluded_files?.length
          ? `\n- excluded (non-behavioral — not efficacy-gated): ${body.efficacy.excluded_files.join(', ')}`
          : '') +
        `\n\n> "efficacy PASS" means EVERY changed non-test file is individually protected:\n` +
        `> reverting that one file alone flips at least one test red. It does NOT mean the\n` +
        `> tests catch every wrong value, nor that a test which only invokes the change\n` +
        `> (without asserting on its result) is meaningful. A file that stays green when\n` +
        `> reverted alone is unprotected and FAILs, named above.\n` +
        `\n## Base\n- base: ${body.base ?? '(none)'}` +
        (body.base_source ? ` — ${body.base_source}` : '') + `\n` +
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
//
// §base-resolution — A base that resolves to HEAD gives an EMPTY `base..HEAD` diff and is
// therefore useless (the gate would see "no change" and FAIL a genuine tested commit). This
// happens when the change is committed ON the same branch the injected BASE_BRANCH names
// (merge-base(HEAD, that-branch) == HEAD). When a candidate resolves to HEAD we DISCARD it and
// fall through the chain: explicit ref (DOD_BASE/BASE_BRANCH) -> @{upstream} -> HEAD~1. HEAD~1
// is only reached when the explicit ref genuinely resolved to HEAD (degenerate), was not
// resolvable, or upstream was unusable — never as a general broadening.
//
// KNOWN BOUND (multi-commit): the HEAD~1 fallback verifies only the LAST commit. For the
// gated build (one commit == the whole change) that is exactly correct. If a caller commits a
// change across MULTIPLE commits on the same branch BASE_BRANCH names, HEAD~1 covers only the
// final commit and an earlier commit's untested change could be missed. verdict.json records
// base_source so the operator can see the fallback in plain English; it never silently PASSes an
// empty diff (an empty base..HEAD still FAILs "no changes in base..HEAD diff").
function resolveBase(): { base: string | null; source?: string; reason?: string } {
  const headRes = git(['rev-parse', 'HEAD']);
  const head = headRes.ok ? headRes.out : null;
  const verify = (ref: string) => git(['rev-parse', '--verify', '--quiet', ref + '^{commit}']).ok;
  // A committish that resolves to HEAD yields an empty base..HEAD diff -> not a useful base.
  const isHead = (committish: string): boolean => {
    if (head === null) return false;
    const r = git(['rev-parse', committish]);
    return r.ok && r.out === head;
  };

  // Tracks why we ended up at HEAD~1, for an honest base_source string.
  let fellBecause = 'no base ref resolvable';

  // 1. Explicit ref (DOD_BASE / BASE_BRANCH), via merge-base with HEAD.
  const explicitRef = process.env.DOD_BASE || process.env.BASE_BRANCH;
  if (explicitRef && verify(explicitRef)) {
    const mb = git(['merge-base', 'HEAD', explicitRef]);
    const candidate = mb.ok ? mb.out : explicitRef;
    if (!isHead(candidate)) {
      return { base: candidate, source: `${explicitRef} (merge-base with HEAD)` };
    }
    // Degenerate: the ref points at or behind HEAD's own branch tip -> empty diff. Fall through.
    fellBecause = `base ref '${explicitRef}' resolved to HEAD — empty diff`;
  }

  // 2. Upstream tracking branch, via merge-base with HEAD.
  const up = git(['rev-parse', '--verify', '--quiet', '@{upstream}']);
  if (up.ok) {
    const mb = git(['merge-base', 'HEAD', '@{upstream}']);
    if (mb.ok && !isHead(mb.out)) {
      return { base: mb.out, source: '@{upstream} (merge-base with HEAD)' };
    }
    if (mb.ok) fellBecause = '@{upstream} resolved to HEAD — empty diff';
  }

  // 3. HEAD~1 — the immediately-preceding commit (final fallback).
  if (verify('HEAD~1')) {
    return { base: git(['rev-parse', 'HEAD~1']).out, source: `HEAD~1 (${fellBecause})` };
  }

  // Single-commit repo: no prior commit exists -> UNVERIFIED (unchanged behavior).
  return { base: null, reason: 'could not resolve a base ref to diff against' };
}

// ── R1: independently re-run every acceptance check ───────────────────────────
async function runChecks(spec: Spec): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of spec.checks) {
    const hollow = isHollowCommand(c.run);
    const { code, out, timedOut } = await runShell(c.run);
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
async function runRevertProbe(spec: Spec, testCmd: Check, base: string): Promise<Efficacy> {
  const diff = git(['diff', '--no-renames', '--name-only', base, 'HEAD']);
  if (!diff.ok) return { ran: false, verdict: 'UNVERIFIED', reason: `git diff ${base}..HEAD failed` };
  const changed = diff.out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort(); // R6 determinism
  const testFiles = changed.filter((f) => matchesAny(f, spec.test_globs));
  const nonTest = changed.filter((f) => !matchesAny(f, spec.test_globs));

  // ── v1.9 partition: behavioral source (probed) vs curated non-behavioral (excluded) ──
  // `nonTest` is already sorted (R6); building both arrays with a single ordered pass keeps
  // them sorted too. NO repo scan, no content inspection: isNonBehavioralFile is the entire
  // decision. Every data/manifest file (.json/.yaml/.yml/.toml) that is not one of the three
  // curated basenames lands in probeSet like any other changed file (see the per-file revert
  // below for how it is reverted).
  const excluded: string[] = [];
  const probeSet: string[] = [];
  for (const f of nonTest) {
    if (isNonBehavioralFile(f)) {
      excluded.push(f);
    } else {
      probeSet.push(f); // JS/TS + any non-curated data/manifest file + any unknown-language source
    }
  }

  // A. No behavioral / probe-able source changed.
  if (probeSet.length === 0) {
    // A1. A test file changed but there is no non-test SOURCE file to revert. Either the
    //     implementation is hidden inside the test file (regression fixture 7) or this is a
    //     test-only change — neither is provable, so FAIL closed. Non-behavioral files being
    //     present does not change this: impl could still be hidden in the test file.
    if (testFiles.length > 0) {
      return {
        ran: true,
        verdict: 'FAIL',
        test_files_changed: testFiles.length,
        nonTest_files: 0,
        excluded_files: excluded,
        reason:
          'implementation lives only in test file(s) — a vacuous assertion could hide it; move the implementation into a non-test source file so efficacy can be proven',
      };
    }
    // A2. Degenerate empty diff (base resolved but base..HEAD is empty): keep failing closed —
    //     an empty diff must never silently PASS (preserves the base-resolution invariant).
    if (changed.length === 0) {
      return {
        ran: true,
        verdict: 'FAIL',
        test_files_changed: 0,
        nonTest_files: 0,
        reason: 'no changes in base..HEAD diff — nothing to gate',
      };
    }
    // A3. Only curated non-behavioral files changed (docs/lockfiles/dotfile-configs/images/
    //     package.json/tsconfig.json/jsconfig.json), no test. There is no implementation to
    //     protect → efficacy N/A → PASS on the efficacy dimension. (R1 checks still ran and must
    //     pass; a docs/curated-manifest-only change with green checks PASSes. Any OTHER data file
    //     — e.g. a non-curated config.json — would have landed in probeSet, not here.)
    return {
      ran: true,
      verdict: 'PASS',
      test_files_changed: 0,
      nonTest_files: 0,
      excluded_files: excluded,
      reason: 'no behavioral source changed — efficacy not applicable',
    };
  }

  // B. Behavioral source exists (probeSet.length >= 1) → a test file must protect it.
  if (testFiles.length === 0) {
    return {
      ran: true,
      verdict: 'FAIL',
      test_files_changed: 0,
      nonTest_files: probeSet.length,
      excluded_files: excluded,
      reason: 'no test file changed — nothing protects this change',
    };
  }

  // Safety: the revert would destroy uncommitted work in these files.
  if (trackedDirty(probeSet).length > 0) {
    return {
      ran: false,
      verdict: 'UNVERIFIED',
      test_files_changed: testFiles.length,
      nonTest_files: probeSet.length,
      excluded_files: excluded,
      reason: 'uncommitted changes to source under test — commit before gating so the revert-probe is safe',
    };
  }

  // Baseline must be green before a revert can mean anything.
  const baseRun = await runShell(testCmd.run);
  if (baseRun.code !== 0) {
    const infra = isInfraGap(baseRun.code, baseRun.out);
    return {
      ran: true,
      verdict: 'UNVERIFIED',
      test_files_changed: testFiles.length,
      nonTest_files: probeSet.length,
      excluded_files: excluded,
      baseline_green: false,
      reason: infra
        ? 'test command could not truly run (environment incomplete) — cannot prove efficacy'
        : 'baseline test command is not green — cannot run the revert-probe (fix checks first)',
    };
  }

  // Which non-test files existed at base (restore) vs were added at HEAD (stub)?
  const existedAtBase = new Map<string, boolean>();
  for (const f of probeSet) existedAtBase.set(f, git(['cat-file', '-e', `${base}:${f}`]).ok);
  const existsAtHead = new Map<string, boolean>();
  for (const f of probeSet) existsAtHead.set(f, git(['cat-file', '-e', `HEAD:${f}`]).ok);

  // Pre-compute stubs for all added JS/TS files before mutating anything.
  // v1.4: export names come from RUNTIME ENUMERATION of the real module at HEAD, not
  // from parsing source text. The working tree currently equals HEAD (the change is
  // committed and trackedDirty(probeSet) is already empty above), so the on-disk file IS
  // the real module — importing it yields the exact runtime export surface for EVERY
  // source shape (unicode, enum, multi-declarator, N-exports-per-line, destructured,
  // re-export barrel) with zero text parsing. Enumerate BEFORE any revert mutation; the
  // test command runs in a SEPARATE process, so the stub written to disk afterward cannot
  // collide with this gate process's own module cache. Types are erased at runtime, which
  // is correct — only VALUE exports need a stub. (JS_TS_EXTS is declared module-level above.)
  const addedStubs = new Map<string, string>();
  for (const f of probeSet) {
    if (existedAtBase.get(f) === true) continue;
    const ext = extname(f).toLowerCase();

    // v1.9: an ADDED non-curated data/manifest file (any .json/.yaml/.yml/.toml that is not one
    // of the three curated basenames) is not JS/TS — it has no exports to stub, and deleting it
    // would break `import x from './f.json'` (a link-crash miscredited as efficacy — the
    // CRITICAL-1 class). Revert it to a MINIMAL EMPTY VALID document of its own type instead: the
    // import/parse still resolves but the values are gone, so a test that genuinely depends on a
    // value goes red (protected) and a vacuous one stays green (unprotected -> FAIL), exactly
    // like any other added file.
    if (DATA_MANIFEST_EXTS.has(ext)) {
      addedStubs.set(f, ext === '.json' ? '{}\n' : ''); // yaml/yml/toml: empty string is a valid empty document
      continue;
    }

    if (!JS_TS_EXTS.has(ext)) {
      return {
        ran: false,
        verdict: 'UNVERIFIED',
        test_files_changed: testFiles.length,
        nonTest_files: probeSet.length,
        excluded_files: excluded,
        reason: `cannot enumerate exports of added file ${f} (unsupported language — not JS/TS) — efficacy unprovable`,
      };
    }
    let ns: Record<string, unknown>;
    try {
      // Import the real on-disk HEAD module to read its runtime export names.
      ns = (await import(pathToFileURL(join(cwd, f)).href)) as Record<string, unknown>;
    } catch {
      return {
        ran: false,
        verdict: 'UNVERIFIED',
        test_files_changed: testFiles.length,
        nonTest_files: probeSet.length,
        excluded_files: excluded,
        reason: `cannot import added file ${f} at HEAD to enumerate its exports — efficacy unprovable`,
      };
    }
    const keys = Object.keys(ns).sort(); // R6 determinism: stable stub surface
    const hasDefault = keys.includes('default');
    const names = keys.filter((k) => k !== 'default');
    const stubLines = ["const __dodReverted = () => { throw new Error('dod-gate: implementation reverted for the efficacy probe'); };"];
    for (const n of names) stubLines.push(`export { __dodReverted as ${JSON.stringify(n)} };`);
    if (hasDefault) stubLines.push('export default __dodReverted;');
    addedStubs.set(f, stubLines.join('\n'));
  }

  // Per-file revert-probe (v1.5): revert each changed non-test file ALONE, run the tests,
  // and require that solo revert to turn at least one test red. A file that stays green
  // when reverted by itself is unprotected. STRICT: efficacy PASSes iff every file is
  // individually protected. N=1 (the common single-file change) behaves exactly as the
  // former diff-wide probe. Serial by construction (each iteration mutates then restores
  // the one file); O(number-of-changed-non-test-files) suite runs — no parallelism.
  const protectedFiles: string[] = [];
  const unprotectedFiles: string[] = [];

  for (const f of probeSet) {
    let red = false;
    try {
      // Revert ONLY this file (others stay at HEAD).
      if (existedAtBase.get(f)) {
        git(['checkout', base, '--', f]); // modified or deleted-at-HEAD -> restore base content
      } else {
        // Added file: JS/TS gets a throwing stub that preserves the export surface but removes
        // behavior; an added non-curated data/manifest file gets a minimal empty valid document
        // of its type. Either way a test that only imports/reads (never truly depends on) the
        // content stays green (vacuous).
        try {
          writeFileSync(join(cwd, f), addedStubs.get(f)!);
        } catch {
          /* unwritable path is surfaced by the per-file cleanliness check below */
        }
      }
      const revertRun = await runShell(testCmd.run);
      red = revertRun.code !== 0;
    } finally {
      // Restore ONLY this file to its HEAD state, leaving the tree clean for the next file.
      if (existsAtHead.get(f)) {
        git(['checkout', 'HEAD', '--', f]); // present at HEAD -> restore committed content
      } else {
        // Deleted at HEAD but resurrected by the probe: return to HEAD's "file absent" state.
        git(['rm', '-f', '--quiet', '--', f]);
      }
    }

    // Cleanliness guard: the tree must be clean again before probing the next file.
    if (trackedDirty([f]).length > 0) {
      return {
        ran: true,
        verdict: 'UNVERIFIED',
        test_files_changed: testFiles.length,
        nonTest_files: probeSet.length,
        excluded_files: excluded,
        baseline_green: true,
        reason: `revert-probe could not cleanly restore ${f} — run \`git checkout HEAD -- .\` and re-gate`,
      };
    }

    if (red) protectedFiles.push(f);
    else unprotectedFiles.push(f);
  }

  // Whole-set cleanliness safety net (preserves the existing final guard).
  const stillDirty = trackedDirty(probeSet);
  if (stillDirty.length > 0) {
    return {
      ran: true,
      verdict: 'UNVERIFIED',
      test_files_changed: testFiles.length,
      nonTest_files: probeSet.length,
      excluded_files: excluded,
      baseline_green: true,
      reason: 'revert-probe could not cleanly restore the tree — run `git checkout HEAD -- .` and re-gate',
    };
  }

  if (unprotectedFiles.length > 0) {
    return {
      ran: true,
      verdict: 'FAIL',
      test_files_changed: testFiles.length,
      nonTest_files: probeSet.length,
      excluded_files: excluded,
      baseline_green: true,
      red_under_revert: false,
      protected_files: protectedFiles,
      unprotected_files: unprotectedFiles,
      reason:
        `${unprotectedFiles.length} of ${probeSet.length} changed non-test file(s) are unprotected — ` +
        `reverting each one alone leaves every test green, so their tests are vacuous ` +
        `(nothing exercises them): ${unprotectedFiles.join(', ')}. ` +
        `Add a test that fails when the file is reverted, or split the commit.`,
    };
  }

  return {
    ran: true,
    verdict: 'PASS',
    test_files_changed: testFiles.length,
    nonTest_files: probeSet.length,
    excluded_files: excluded,
    baseline_green: true,
    red_under_revert: true,
    protected_files: protectedFiles,
    unprotected_files: [],
    reason:
      `all ${probeSet.length} changed non-test file(s) are individually protected — ` +
      `reverting any one alone turns at least one test red`,
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
async function main(): Promise<void> {
  try {
    if (!artRoot) fatal(['ARTIFACTS_DIR not set — cannot write a verdict.']);
    if (!git(['rev-parse', '--is-inside-work-tree']).ok) fatal(['not inside a git work tree — cannot gate.']);

    const spec = resolveSpec();
    const checks = await runChecks(spec);

    let efficacy: Efficacy;
    let base: string | null = null;
    let baseSource: string | null = null;

    if (!spec.require_test_efficacy) {
      efficacy = { ran: false, verdict: 'PASS', reason: 'efficacy not required by spec' };
    } else {
      const testCmd = spec.checks.find((c) => c.is_test_command);
      const testResult = testCmd ? checks.find((c) => c.name === testCmd.name) : undefined;
      const resolved = resolveBase();
      base = resolved.base;
      baseSource = resolved.source ?? null;
      if (!testCmd) {
        efficacy = { ran: false, verdict: 'UNVERIFIED', reason: 'no check marked is_test_command' };
      } else if (testResult?.hollow) {
        // A stubbed test command cannot support a revert-probe at all.
        efficacy = { ran: false, verdict: 'UNVERIFIED', reason: 'test command is a no-op stub' };
      } else if (!base) {
        efficacy = { ran: false, verdict: 'UNVERIFIED', reason: resolved.reason };
      } else {
        efficacy = await runRevertProbe(spec, testCmd, base);
      }
    }

    const { gate, reasons } = fold(spec, checks, efficacy);
    writeVerdict(gate, { checks, efficacy, reasons, base, base_source: baseSource });
    process.exit(gate === 'PASS' ? 0 : 1);
  } catch (e) {
    fatal([`unexpected error: ${(e as Error).message}`]);
  }
}

main();
