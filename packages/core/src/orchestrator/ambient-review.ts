/**
 * Ambient PR review dispatch — deterministic workflow dispatch for pull_request.opened.
 *
 * This module is the core entry point for the ambient PR review feature.
 * The GitHub adapter calls `dispatchReviewWorkflowByName` after all setup steps
 * (codebase clone, isolation hints, conversation creation). The function discovers
 * workflows for the codebase cwd, resolves the configured workflow by exact match,
 * and delegates to `dispatchOrchestratorWorkflow` (which owns isolation resolution,
 * resume semantics, and the foreground/background dispatch decision).
 *
 * Strict constraints:
 * - No AI in the routing decision (deterministic dispatch).
 * - The adapter never sets `actorByConversation`, so verdicts post as the bot identity.
 * - `dispatchOrchestratorWorkflow` is the single write path; it only calls
 *   `platform.sendMessage()`. There are no merge, label, or PR-update calls.
 */
import { createLogger } from '@archon/paths';
import type { IPlatformAdapter, HandleMessageContext, Conversation, Codebase } from '../types';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { findWorkflow } from '@archon/workflows/router';
import { loadConfig } from '../config/config-loader';
import { dispatchOrchestratorWorkflow } from './orchestrator-agent';

const log = createLogger('ambient-review');

/**
 * Discover workflows for the codebase cwd and dispatch the named review workflow
 * by exact match. Uses `dispatchOrchestratorWorkflow` — inheriting isolation
 * resolution, resume semantics, and the existing single-write-path contract
 * (sendMessage only, no merge/label writes).
 *
 * If the workflow is not found, logs an error and returns without posting a comment.
 *
 * @param platform       - Platform adapter (used by dispatchOrchestratorWorkflow)
 * @param conversationId - Stable conversation ID for this PR (owner/repo#number)
 * @param conversation   - Conversation DB record (created by the adapter)
 * @param codebase       - Codebase record for the repo
 * @param workflowName   - Exact name of the review workflow to run
 * @param userMessage    - PR context message passed to the workflow
 * @param isolationHints - PR-branch isolation hints (prBranch, prSha, isForkPR, etc.)
 */
export async function dispatchReviewWorkflowByName(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase,
  workflowName: string,
  userMessage: string,
  isolationHints?: HandleMessageContext['isolationHints']
): Promise<void> {
  const { workflows: discovered } = await discoverWorkflowsWithConfig(
    codebase.default_cwd,
    loadConfig
  );

  const workflow = findWorkflow(
    workflowName,
    discovered.map(w => w.workflow)
  );

  if (!workflow) {
    log.error(
      { workflowName, codebaseId: codebase.id, conversationId },
      'ambient_review.workflow_not_found'
    );
    return;
  }

  // TODO(ambient-review): optional read-only credential mode
  await dispatchOrchestratorWorkflow(
    platform,
    conversationId,
    conversation,
    codebase,
    workflow,
    userMessage,
    isolationHints,
    undefined, // userId: undefined — verdict posts as bot/installation identity
    'project' // source
  );
}
