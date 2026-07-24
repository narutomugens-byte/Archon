---
description: Synthesize all review agent findings into consolidated report and post to GitHub
argument-hint: (none - reads from review artifacts)
---

# Synthesize Review

---

## Your Mission

Read all parallel review agent artifacts, synthesize findings into a consolidated report, create a master artifact, and post a comprehensive review comment to the GitHub PR.

**Output artifact**: `$ARTIFACTS_DIR/review/consolidated-review.md`
**GitHub action**: Post PR comment with full review

---

## Phase 1: LOAD - Gather All Findings

### 1.1 Get PR Number from Registry

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
```

### 1.2 Read Scope

```bash
cat $ARTIFACTS_DIR/review/scope.md
```

### 1.3 Read All Agent Artifacts

```bash
# Read every agent's findings that actually ran — do not assume a fixed set of agents
for f in "$ARTIFACTS_DIR"/review/*-findings.md; do
  [ -e "$f" ] || continue
  echo "=== $f ==="
  cat "$f"
done
```

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] Every `*-findings.md` artifact present in `$ARTIFACTS_DIR/review/` read (one row per file actually present; do not assume a fixed set of agents)
- [ ] Findings extracted from each

---

## Phase 2: SYNTHESIZE - Combine Findings

### 2.1 Aggregate by Severity

Combine all findings across agents:
- **CRITICAL**: Must fix before merge
- **HIGH**: Should fix before merge
- **MEDIUM**: Consider fixing (options provided)
- **LOW**: Nice to have (defer or create issue)

### 2.2 Deduplicate

Check for overlapping findings:
- Same issue reported by multiple agents
- Related issues that should be grouped
- Conflicting recommendations (resolve)

### 2.3 Prioritize

Rank findings by:
1. Severity (CRITICAL > HIGH > MEDIUM > LOW)
2. User impact
3. Ease of fix
4. Risk if not fixed

### 2.4 Compile Statistics

```
Total findings: {n}
- CRITICAL: {n}
- HIGH: {n}
- MEDIUM: {n}
- LOW: {n}

By agent:
{one line per *-findings.md file actually present, e.g.}
- code-review: {n} findings
- error-handling: {n} findings
- ...
```

**PHASE_2_CHECKPOINT:**
- [ ] Findings aggregated by severity
- [ ] Duplicates removed
- [ ] Priority order established
- [ ] Statistics compiled

---

## Phase 3: GENERATE - Create Consolidated Artifact

Write to `$ARTIFACTS_DIR/review/consolidated-review.md`:

```markdown
# Consolidated Review: PR #{number}

**Date**: {ISO timestamp}
**Agents**: {comma-separated list derived from the `*-findings.md` files actually present in $ARTIFACTS_DIR/review/}
**Total Findings**: {count}

---

## Executive Summary

{3-5 sentence overview of PR quality and main concerns}

**Overall Verdict**: {APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION}

**Auto-fix Candidates**: {n} CRITICAL + HIGH issues can be auto-fixed
**Manual Review Needed**: {n} MEDIUM + LOW issues require decision

---

## Statistics

One row per `*-findings.md` file actually present — do not assume a fixed set of agents. Derive the agent's display name from its artifact filename (e.g. `security-findings.md` -> "Security", `performance-findings.md` -> "Performance").

| Agent | CRITICAL | HIGH | MEDIUM | LOW | Total |
|-------|----------|------|--------|-----|-------|
| {Agent 1} | {n} | {n} | {n} | {n} | {n} |
| {Agent 2} | {n} | {n} | {n} | {n} | {n} |
| ... | ... | ... | ... | ... | ... |
| **Total** | **{n}** | **{n}** | **{n}** | **{n}** | **{n}** |

---

## CRITICAL Issues (Must Fix)

### Issue 1: {Title}

**Source Agent**: {agent-name}
**Location**: `{file}:{line}`
**Category**: {category}

**Problem**:
{description}

**Recommended Fix**:
```typescript
{fix code}
```

**Why Critical**:
{impact explanation}

---

### Issue 2: {Title}

{Same structure...}

---

## HIGH Issues (Should Fix)

### Issue 1: {Title}

{Same structure as CRITICAL...}

---

## MEDIUM Issues (Options for User)

### Issue 1: {Title}

**Source Agent**: {agent-name}
**Location**: `{file}:{line}`

**Problem**:
{description}

**Options**:

| Option | Approach | Effort | Risk if Skipped |
|--------|----------|--------|-----------------|
| Fix Now | {approach} | {LOW/MED/HIGH} | {risk} |
| Create Issue | Defer to separate PR | LOW | {risk} |
| Skip | Accept as-is | NONE | {risk} |

**Recommendation**: {which option and why}

---

## LOW Issues (For Consideration)

| Issue | Location | Agent | Suggestion |
|-------|----------|-------|------------|
| {title} | `file:line` | {agent} | {brief recommendation} |
| ... | ... | ... | ... |

---

## Positive Observations

{Aggregated good things from all agents:
- Well-structured code
- Good error handling in X
- Comprehensive tests for Y
- Clear documentation}

---

## Suggested Follow-up Issues

If not addressing in this PR, create issues for:

| Issue Title | Priority | Related Finding |
|-------------|----------|-----------------|
| "{suggested issue title}" | {P1/P2/P3} | MEDIUM issue #{n} |
| ... | ... | ... |

---

## Next Steps

1. **Auto-fix step** will address {n} CRITICAL + HIGH issues
2. **Review** the MEDIUM issues and decide: fix now, create issue, or skip
3. **Consider** LOW issues for future improvements

---

## Agent Artifacts

One row per `*-findings.md` file actually present in `$ARTIFACTS_DIR/review/` — do not assume a fixed set of agents. Security and performance findings must be included here when present.

| Agent | Artifact | Findings |
|-------|----------|----------|
| {Agent 1} | `{agent-1}-findings.md` | {n} |
| {Agent 2} | `{agent-2}-findings.md` | {n} |
| ... | ... | ... |

---

## Metadata

- **Synthesized**: {ISO timestamp}
- **Artifact**: `$ARTIFACTS_DIR/review/consolidated-review.md`
```

**PHASE_3_CHECKPOINT:**
- [ ] Consolidated artifact created
- [ ] All findings included
- [ ] Severity ordering correct
- [ ] Options provided for MEDIUM/LOW

---

## Phase 4: POST - GitHub PR Comment

### 4.1 Format for GitHub

Create a GitHub-friendly version of the review:

```bash
gh pr comment {number} --body "$(cat <<'EOF'
# 🔍 Comprehensive PR Review

**PR**: #{number}
**Reviewed by**: {count} specialized agents (one per `*-findings.md` artifact actually present)
**Date**: {date}

---

## Summary

{executive summary}

**Verdict**: `{APPROVE | REQUEST_CHANGES}`

| Severity | Count |
|----------|-------|
| 🔴 CRITICAL | {n} |
| 🟠 HIGH | {n} |
| 🟡 MEDIUM | {n} |
| 🟢 LOW | {n} |

---

## 🔴 Critical Issues (Auto-fixing)

{For each CRITICAL issue:}

### {Title}
📍 `{file}:{line}`

{Brief description}

<details>
<summary>View fix</summary>

```typescript
{fix code}
```

</details>

---

## 🟠 High Issues (Auto-fixing)

{Same format as CRITICAL}

---

## 🟡 Medium Issues (Needs Decision)

{For each MEDIUM issue:}

### {Title}
📍 `{file}:{line}`

{Brief description}

**Options**: Fix now | Create issue | Skip

<details>
<summary>View details</summary>

{full details and options table}

</details>

---

## 🟢 Low Issues

<details>
<summary>View {n} low-priority suggestions</summary>

| Issue | Location | Suggestion |
|-------|----------|------------|
| {title} | `file:line` | {suggestion} |

</details>

---

## ✅ What's Good

{Positive observations}

---

## 📋 Suggested Follow-up Issues

{If any MEDIUM/LOW issues should become issues}

---

## Next Steps

1. ⚡ Auto-fix step will address CRITICAL + HIGH issues
2. 📝 Review MEDIUM issues above
3. 🎯 Merge when ready

---

*Reviewed by Archon comprehensive-pr-review workflow*
*Artifacts: `$ARTIFACTS_DIR/review/`*
EOF
)"
```

**PHASE_4_CHECKPOINT:**
- [ ] GitHub comment posted
- [ ] Formatting renders correctly
- [ ] All severity levels included

---

## Phase 5: OUTPUT - Confirmation

Output only a brief confirmation (this will be posted as a comment):

```
✅ Review synthesis complete. Proceeding to auto-fix step...
```

---

## Success Criteria

- **ALL_ARTIFACTS_READ**: Every `*-findings.md` artifact present in `$ARTIFACTS_DIR/review/` loaded (not a fixed count)
- **FINDINGS_SYNTHESIZED**: Combined, deduplicated, prioritized
- **CONSOLIDATED_CREATED**: Master artifact written
- **GITHUB_POSTED**: PR comment visible
