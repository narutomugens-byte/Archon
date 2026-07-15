/**
 * Tests for the ambient PR review dispatch path in GitHubAdapter.
 *
 * Must run in its OWN bun test batch (separate from adapter.test.ts) because
 * it mocks `@archon/core` at the module level to intercept
 * `dispatchReviewWorkflowByName`, and Bun's `mock.module()` is process-global
 * and irreversible. The adapter.test.ts batch uses the real `@archon/core`;
 * mixing them in one process causes mock pollution.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ─── Mock @archon/paths ───────────────────────────────────────────────────────
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info' as const,
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/tmp/test-workspaces/${owner}/${repo}/source`
  ),
  ensureProjectStructure: mock(async () => undefined),
}));

// ─── Mock child_process ────────────────────────────────────────────────────────
mock.module('child_process', () => ({
  execFile: mock(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      callback(null, { stdout: '', stderr: '' });
    }
  ),
}));

// ─── Mock @archon/core — captures dispatchReviewWorkflowByName + handleMessage ─
const mockDispatchReviewWorkflow = mock(async () => undefined);
const mockHandleMessage = mock(async () => undefined);

mock.module('@archon/core', () => ({
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    name = 'ConversationNotFoundError';
  },
  AppNotInstalledError: class AppNotInstalledError extends Error {
    name = 'AppNotInstalledError';
  },
  handleMessage: mockHandleMessage,
  dispatchReviewWorkflowByName: mockDispatchReviewWorkflow,
  classifyAndFormatError: mock((e: Error) => e.message),
  toError: mock((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
  getLinkedIssueNumbers: mock(async () => []),
  onConversationClosed: mock(async () => undefined),
  ConversationLockManager: class MockConversationLockManager {
    async acquireLock(_id: string, handler: () => Promise<void>): Promise<void> {
      await handler();
    }
    getStats() {
      return {
        active: 0,
        queuedTotal: 0,
        queuedByConversation: [],
        maxConcurrent: 10,
        activeConversationIds: [],
      };
    }
  },
  installCredentialHelper: mock(async () => ({ kind: 'skipped', reason: 'test', sourcePath: '' })),
}));

// ─── Mock @archon/core DB sub-modules ─────────────────────────────────────────
const MOCK_CONVERSATION = {
  id: 'conv-review-test',
  codebase_id: null,
  cwd: null,
  isolation_env_id: null,
};

const MOCK_CODEBASE_PARTIAL = {
  id: 'codebase-review-test',
  name: 'testuser/testrepo',
  default_cwd: '/tmp/test-workspaces/testuser/testrepo/source',
};

const MOCK_CODEBASE_FULL = {
  ...MOCK_CODEBASE_PARTIAL,
  repository_url: 'https://github.com/testuser/testrepo',
  default_branch: 'main',
  ai_assistant_type: 'claude',
  commands: {},
  created_at: new Date(),
  updated_at: new Date(),
};

const mockGetOrCreateConversation = mock(async () => MOCK_CONVERSATION);
mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  updateConversation: mock(async () => {}),
}));

const mockFindCodebaseByRepoUrl = mock(async () => null);
const mockCreateCodebase = mock(async () => MOCK_CODEBASE_PARTIAL);
const mockGetCodebase = mock(async () => MOCK_CODEBASE_FULL);

mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByRepoUrl: mockFindCodebaseByRepoUrl,
  createCodebase: mockCreateCodebase,
  getCodebase: mockGetCodebase,
  updateCodebase: mock(async () => {}),
  getCodebaseCommands: mock(async () => ({})),
  updateCodebaseCommands: mock(async () => {}),
}));

mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(async () => ({
    id: 'user-test-uuid',
    display_name: 'Test',
    email: null,
    created_at: new Date(),
    updated_at: new Date(),
  })),
}));

mock.module('@archon/core/config/resolve-assistant', () => ({
  resolveDefaultAssistant: mock(async () => 'claude'),
}));

// ─── Mock @archon/git ─────────────────────────────────────────────────────────
mock.module('@archon/git', () => ({
  cloneRepository: mock(async () => ({ ok: true, value: undefined })),
  syncRepository: mock(async () => ({ ok: true, value: undefined })),
  addSafeDirectory: mock(async () => undefined),
  isWorktreePath: mock(async () => false),
  toRepoPath: (p: string) => p,
  toBranchName: (n: string) => n,
  toWorktreePath: (p: string) => p,
  execFileAsync: mock(async () => ({ stdout: '', stderr: '' })),
  mkdirAsync: mock(async () => undefined),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { GitHubAdapter } from './adapter';
import { ConversationLockManager } from '@archon/core';

const mockLockManager = new ConversationLockManager() as unknown as InstanceType<
  typeof ConversationLockManager
>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal pull_request.opened webhook payload. Pass `{ fork: true }`
 * to set the head repo full_name to a different user (fork PR).
 */
function createPROpenedPayload(opts: { fork?: boolean } = {}): string {
  return JSON.stringify({
    action: 'opened',
    pull_request: {
      number: 42,
      title: 'Test PR',
      body: 'Test description',
      user: { login: 'prauthor' },
      state: 'open',
      head: {
        ref: 'feature-branch',
        sha: 'abc123def456',
        repo: { full_name: opts.fork ? 'fork-user/testrepo' : 'testuser/testrepo' },
      },
    },
    repository: {
      owner: { login: 'testuser' },
      name: 'testrepo',
      full_name: 'testuser/testrepo',
      html_url: 'https://github.com/testuser/testrepo',
      default_branch: 'main',
    },
    sender: { login: 'prauthor' },
  });
}

function createAdapter(opts: {
  enabled?: boolean;
  workflow?: string;
  forkPolicy?: 'skip' | 'review';
}): GitHubAdapter {
  const adapter = new GitHubAdapter(
    { kind: 'pat', token: 'fake-token' },
    'fake-secret',
    mockLockManager,
    'archon',
    {
      ambientReview: {
        enabled: opts.enabled ?? true,
        workflow: opts.workflow,
        forkPolicy: opts.forkPolicy ?? 'skip',
      },
    }
  );
  // Bypass HMAC signature verification for tests
  // @ts-expect-error - accessing private method
  adapter.verifySignature = mock(() => true);
  return adapter;
}

describe('GitHubAdapter — ambient PR review', () => {
  beforeEach(() => {
    mockDispatchReviewWorkflow.mockClear();
    mockHandleMessage.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockGetOrCreateConversation.mockClear();
    mockGetCodebase.mockClear();
  });

  test('enabled=false → dispatch never called (zero-cost)', async () => {
    const adapter = createAdapter({ enabled: false, workflow: 'pr-review' });
    await adapter.handleWebhook(createPROpenedPayload(), 'mock-sig');
    expect(mockDispatchReviewWorkflow).not.toHaveBeenCalled();
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('enabled + same-repo → dispatchReviewWorkflowByName called once with configured workflow name', async () => {
    const adapter = createAdapter({ enabled: true, workflow: 'pr-review' });
    await adapter.handleWebhook(createPROpenedPayload(), 'mock-sig');
    expect(mockDispatchReviewWorkflow).toHaveBeenCalledTimes(1);
    // The 5th argument is workflowName
    const [, , , , calledWorkflowName] = mockDispatchReviewWorkflow.mock.calls[0] as unknown[];
    expect(calledWorkflowName).toBe('pr-review');
  });

  test('enabled + same-repo → handleMessage (AI path) never called (deterministic)', async () => {
    const adapter = createAdapter({ enabled: true, workflow: 'pr-review' });
    await adapter.handleWebhook(createPROpenedPayload(), 'mock-sig');
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('enabled + fork + forkPolicy=skip → dispatch not called', async () => {
    const adapter = createAdapter({ enabled: true, workflow: 'pr-review', forkPolicy: 'skip' });
    await adapter.handleWebhook(createPROpenedPayload({ fork: true }), 'mock-sig');
    expect(mockDispatchReviewWorkflow).not.toHaveBeenCalled();
  });

  test('enabled + fork + forkPolicy=review → dispatch called', async () => {
    const adapter = createAdapter({ enabled: true, workflow: 'pr-review', forkPolicy: 'review' });
    await adapter.handleWebhook(createPROpenedPayload({ fork: true }), 'mock-sig');
    expect(mockDispatchReviewWorkflow).toHaveBeenCalledTimes(1);
  });

  test('workflow unset → not called + warn logged', async () => {
    const adapter = createAdapter({ enabled: true, workflow: undefined });
    await adapter.handleWebhook(createPROpenedPayload(), 'mock-sig');
    expect(mockDispatchReviewWorkflow).not.toHaveBeenCalled();
    // Warn must be logged with the expected event name
    const warnCalls = mockLogger.warn.mock.calls as [unknown, string][];
    const warnedEvent = warnCalls.find(([, msg]) => msg === 'ambient_review.workflow_unset');
    expect(warnedEvent).toBeDefined();
  });

  test('never-merge: pulls.merge / issues.update / pulls.update never called', async () => {
    const mockMerge = mock(async () => ({}));
    const mockIssuesUpdate = mock(async () => ({}));
    const mockPullsUpdate = mock(async () => ({}));
    const mockCreateComment = mock(async () => ({ data: { id: 1 } }));

    const adapter = createAdapter({ enabled: true, workflow: 'pr-review' });

    // Reach into the adapter and attach a mock Octokit
    // @ts-expect-error - accessing private field for testing
    adapter.octokit = {
      rest: {
        issues: { createComment: mockCreateComment, update: mockIssuesUpdate },
        pulls: { merge: mockMerge, update: mockPullsUpdate },
      },
    };

    await adapter.handleWebhook(createPROpenedPayload(), 'mock-sig');

    // Dispatch was attempted (feature is enabled + workflow set)
    expect(mockDispatchReviewWorkflow).toHaveBeenCalledTimes(1);
    // No merge/update operations
    expect(mockMerge).not.toHaveBeenCalled();
    expect(mockIssuesUpdate).not.toHaveBeenCalled();
    expect(mockPullsUpdate).not.toHaveBeenCalled();
  });

  test('conversationId passed to dispatchReviewWorkflowByName uses PR format (owner/repo#N)', async () => {
    const adapter = createAdapter({ enabled: true, workflow: 'my-review' });
    await adapter.handleWebhook(createPROpenedPayload(), 'mock-sig');
    expect(mockDispatchReviewWorkflow).toHaveBeenCalledTimes(1);
    const [, conversationId] = mockDispatchReviewWorkflow.mock.calls[0] as unknown[];
    expect(conversationId).toBe('testuser/testrepo#42');
  });
});
