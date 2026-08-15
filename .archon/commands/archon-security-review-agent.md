---
description: Review security posture for auth gaps, injection risks, secret exposure, and unsafe endpoints
argument-hint: (none - reads from scope artifact)
---

# Security Review Agent

---

## Your Mission

Hunt for security vulnerabilities: auth/authz gaps, unvalidated input, injection (SQL/command/path), secret or token exposure (including in logs), missing webhook-signature checks, unsafe deserialization, SSRF, exposure of `/internal/*` credential endpoints beyond loopback, permission broadening, and any CLAUDE.md security-rule violations. Produce a structured artifact with findings, fix suggestions with options, and reasoning.

**Output artifact**: `$ARTIFACTS_DIR/review/security-findings.md`

---

## Phase 1: LOAD - Get Context

### 1.1 Get PR Number from Registry

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
```

### 1.2 Read Scope

```bash
cat $ARTIFACTS_DIR/review/scope.md
```

**CRITICAL**: Check for "NOT Building (Scope Limits)" section. Items listed there are **intentionally excluded** - do NOT flag them as bugs or missing features!

### 1.3 Get PR Diff

```bash
gh pr diff {number}
```

### 1.4 Read CLAUDE.md Security Rules

```bash
cat CLAUDE.md | grep -A 20 -i "security\|auth\|secret\|token\|webhook\|internal"
```

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] Scope loaded
- [ ] Diff available

---

## Phase 2: ANALYZE - Hunt for Issues

### 2.1 Find All Security-Relevant Code

Search for:
- Auth/authz checks (or missing ones) on new/changed endpoints and handlers
- User input flowing into SQL, shell commands, file paths, or `eval`-like sinks
- Secrets, API keys, or tokens read, logged, echoed, or included in responses
- New or modified webhook handlers (signature verification present and correct?)
- Deserialization of untrusted data (JSON.parse of external payloads, YAML load, etc.)
- Outbound requests built from user-controlled URLs/hosts (SSRF)
- Routes under `/internal/*` or anything handing out credentials/tokens
- Changes that broaden permissions, scopes, or bypass an existing guard

### 2.2 Scrutinize Each Finding

For every security-relevant location, evaluate:

**Authentication/Authorization:**
- Is the identity check present and applied before the sensitive action?
- Could the check be bypassed (wrong order, early return, missing await)?
- Does it match the pattern used elsewhere in the codebase (e.g. `resolveAuthContext`, `requireWebUser`)?

**Input Validation:**
- Is user input validated/sanitized before use in a sensitive sink?
- Is the validation applied on the server, not just client-side?
- Could a crafted input reach an injection sink?

**Secret Handling:**
- Are secrets ever logged, returned in API responses, or committed to artifacts?
- Are secrets masked when logged (per CLAUDE.md `token.slice(0, 8) + '...'` convention)?
- Is the secret stored encrypted at rest where the codebase pattern requires it?

**Exposure Surface:**
- Does a new/changed route correctly stay behind its intended boundary (loopback-only, webhook-signature-verified, auth-gated)?
- Does the change widen what an unauthenticated or lower-privileged caller can reach?

### 2.3 Find Codebase Security Patterns

```bash
# Find auth/secret handling patterns in codebase
grep -r "requireWebUser\|resolveAuthContext" packages/ --include="*.ts" -A 3 | head -30
grep -r "X-Hub-Signature\|verifySignature\|HMAC" packages/ --include="*.ts" -B 2 -A 2 | head -30
```

**PHASE_2_CHECKPOINT:**
- [ ] All security-relevant code identified
- [ ] Each finding evaluated
- [ ] Codebase patterns found

---

## Phase 3: GENERATE - Create Artifact

Write to `$ARTIFACTS_DIR/review/security-findings.md`:

```markdown
# Security Findings: PR #{number}

**Reviewer**: security-review-agent
**Date**: {ISO timestamp}
**Security-Relevant Locations Reviewed**: {count}

---

## Summary

{2-3 sentence overview of security posture}

**Verdict**: {APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION}

---

## Findings

### Finding 1: {Descriptive Title}

**Severity**: CRITICAL | HIGH | MEDIUM | LOW
**Category**: auth | input-validation | injection | secret-exposure | unsafe-deserialization | permission-broadening | other
**Location**: `{file}:{line}`

**Issue**:
{Clear description of the security problem}

**Evidence**:
```typescript
// Current code at {file}:{line}
{problematic code}
```

**Exploit Scenario**:
{How could this be abused? What would an attacker need?}

**User/System Impact**:
{What happens if this is exploited? Why is it bad?}

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | {e.g., Add auth check before action} | {benefits} | {drawbacks} |
| B | {e.g., Validate/sanitize input} | {benefits} | {drawbacks} |
| C | {e.g., Encrypt/mask secret} | {benefits} | {drawbacks} |

**Recommended**: Option {X}

**Reasoning**:
{Explain why this option is preferred:
- Aligns with project security patterns
- Closes the exploit path completely
- Follows CLAUDE.md rules}

**Recommended Fix**:
```typescript
// Corrected code
{corrected code with proper auth/validation/secret handling}
```

**Codebase Pattern Reference**:
```typescript
// SOURCE: {file}:{lines}
// This is how similar security concerns are handled elsewhere
{existing security pattern from codebase}
```

---

### Finding 2: {Title}

{Same structure...}

---

## Security Audit

| Location | Type | Auth Check | Input Validated | Secrets Handled | Verdict |
|----------|------|------------|------------------|------------------|---------|
| `file:line` | endpoint | GOOD/BAD | GOOD/BAD | GOOD/BAD | PASS/FAIL |
| ... | ... | ... | ... | ... | ... |

---

## Statistics

| Severity | Count | Auto-fixable |
|----------|-------|--------------|
| CRITICAL | {n} | {n} |
| HIGH | {n} | {n} |
| MEDIUM | {n} | {n} |
| LOW | {n} | {n} |

---

## Exposure Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| {potential exposure} | HIGH/MED/LOW | {impact} | {fix needed} |
| ... | ... | ... | ... |

---

## Patterns Referenced

| File | Lines | Pattern |
|------|-------|---------|
| `src/example.ts` | 42-50 | {security pattern} |
| ... | ... | ... |

---

## Positive Observations

{Security done well, good patterns, proper auth/validation/secret handling}

---

## Metadata

- **Agent**: security-review-agent
- **Timestamp**: {ISO timestamp}
- **Artifact**: `$ARTIFACTS_DIR/review/security-findings.md`
```

**PHASE_3_CHECKPOINT:**
- [ ] Artifact file created
- [ ] All security-relevant locations audited
- [ ] Exploit scenario listed for each finding
- [ ] Fix options with reasoning provided

---

## Success Criteria

- **SECURITY_LOCATIONS_FOUND**: All auth, input, secret, and exposure surfaces identified
- **EACH_LOCATION_AUDITED**: Auth, validation, secret handling evaluated
- **EXPLOIT_SCENARIOS_LISTED**: Each finding lists how it could be abused
- **ARTIFACT_CREATED**: Findings file written with complete structure
