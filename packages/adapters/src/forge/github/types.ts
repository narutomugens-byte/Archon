export interface WebhookEvent {
  action: 'opened' | 'closed' | 'created' | 'edited' | 'reopened' | 'labeled' | (string & {});
  issue?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    labels: { name: string }[];
    state: 'open' | 'closed';
    pull_request?: { url: string }; // Present if the issue is actually a PR
  };
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    state: 'open' | 'closed';
    merged?: boolean;
    changed_files?: number;
    additions?: number;
    deletions?: number;
    /**
     * PR head ref info. Present on pull_request.opened (and most PR events).
     * Used for isolation hints (prBranch, prSha) and fork detection.
     */
    head?: {
      ref: string;
      sha: string;
      /** null when the fork has been deleted after PR creation */
      repo: { full_name: string } | null;
    };
  };
  comment?: {
    body: string;
    user: { login: string };
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
    html_url: string;
    default_branch: string;
  };
  sender: { login: string };
  /**
   * GitHub App webhook deliveries include the installation id on every event.
   * Used to short-circuit the per-(owner, repo) installation lookup in App
   * mode — saves one HTTP round trip per inbound event. Absent on PAT-mode
   * "manual webhook" deliveries; the adapter falls back to the lookup path.
   */
  installation?: { id: number };
}
