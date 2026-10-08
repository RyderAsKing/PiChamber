import type { DraftStarterRef } from '@/lib/draftStarters';

type RuntimePlatform = 'web' | 'desktop';

interface RuntimeDescriptor {
  platform: RuntimePlatform;

  isDesktop: boolean;

  label?: string;
}

interface Subscription {

  close: () => void;
}

export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited' | 'error';
}

export type TerminalShell = 'auto' | 'bash' | 'zsh' | 'sh' | 'fish' | 'pwsh' | 'powershell' | 'cmd' | 'dash' | 'ksh' | 'nu';

export interface TerminalShellOption {
  id: TerminalShell;
  name: string;
  supportsLogin: boolean;
}

export interface TerminalStreamEvent {
  type: 'snapshot' | 'data' | 'exit' | 'reconnecting';
  sequence?: number;
  data?: string;
  replayData?: string;
  status?: 'running' | 'exited' | 'error';
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;

  runtime?: 'node' | 'bun';
  ptyBackend?: string;
}

export interface TerminalError extends Error {
  code?: string;
}

export interface CreateTerminalOptions {
  cwd: string;
  sessionId?: string;
  cols?: number;
  rows?: number;
  themeMode?: 'light' | 'dark';
  terminalBackground?: string;
  terminalForeground?: string;
  shell?: TerminalShell;
  loginShell?: boolean;
}

export interface ResizeTerminalPayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalHandlers {
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: (error: TerminalError, fatal?: boolean) => void;
}

export interface ForceKillOptions {
  sessionId?: string;
  cwd?: string;
}

export interface TerminalAPI {
  listShells?(): Promise<TerminalShellOption[]>;
  createSession(options: CreateTerminalOptions): Promise<TerminalSession>;
  connect(sessionId: string, handlers: TerminalHandlers): Subscription;
  sendInput(sessionId: string, input: string): Promise<void>;
  resize(payload: ResizeTerminalPayload): Promise<void>;
  updateAppearance?(sessionId: string, appearance: Pick<CreateTerminalOptions, 'themeMode' | 'terminalBackground' | 'terminalForeground'>): Promise<void>;
  close(sessionId: string): Promise<void>;
  restartSession?(currentSessionId: string, options: CreateTerminalOptions): Promise<TerminalSession>;
  forceKill?(options: ForceKillOptions): Promise<void>;
}

interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
}

export interface GitMergeInProgress {
  /** Short SHA of MERGE_HEAD */
  head: string;
  /** First line of MERGE_MSG */
  message: string;
}

export interface GitRebaseInProgress {
  /** Branch name being rebased */
  headName: string;
  /** Short SHA of the onto commit */
  onto: string;
}

export interface GitRemoteComparison {
  remote: string;
  branch: string;
  ahead: number;
  behind: number;
}

export interface GitStatus {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  upstreamComparison?: GitRemoteComparison | null;
  files: GitStatusFile[];
  isClean: boolean;
  diffStats?: Record<string, { insertions: number; deletions: number }>;
  /** Present when a merge is in progress with conflicts */
  mergeInProgress?: GitMergeInProgress | null;
  /** Present when a rebase is in progress */
  rebaseInProgress?: GitRebaseInProgress | null;
  /** Phase 1: reason for attention-required state */
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}

export interface GitDiffResponse {
  diff: string;
}

export interface GetGitDiffOptions {
  path: string;
  staged?: boolean;
  contextLines?: number;
}

/**
 * Diff between two refs. Uses three-dot (`base...head`) semantics server-side, so changes
 * pulled into `head` by merging `base` are excluded — only the branch's own work is returned.
 */
export interface GetGitRangeDiffOptions {
  base: string;
  head: string;
  path?: string;
  contextLines?: number;
}

export interface GitFileDiffResponse {
  original: string;
  modified: string;
  path: string;
  isBinary?: boolean;
}

export interface GetGitFileDiffOptions {
  path: string;
  staged?: boolean;
}

export interface GitBranchDetails {
  current: boolean;
  name: string;
  commit: string;
  label: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export interface GitBranch {
  all: string[];
  current: string;
  branches: Record<string, GitBranchDetails>;
  defaultBranches?: Record<string, string>;
}

interface GitCommitSummary {
  changes: number;
  insertions: number;
  deletions: number;
}

export interface GitCommitResult {
  success: boolean;
  commit: string;
  branch: string;
  summary: GitCommitSummary;
}

export interface GitPushResult {
  success: boolean;
  pushed: Array<{
    local: string;
    remote: string;
  }>;
  repo: string;
  ref: unknown;
}

export interface GitPullResult {
  success: boolean;
  summary: GitCommitSummary;
  files: string[];
  insertions: number;
  deletions: number;
}

export interface GitPullOptions {
  remote?: string;
  branch?: string;
  rebase?: boolean;
}

export interface GitStashEntry {
  ref: string;
  message: string;
  relativeTime: string;
  hash: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitMergeResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface CheckoutBranchOptions {
  expectedCurrent?: string | null;
  localOnly?: boolean;
}

export interface CheckoutBranchResponse {
  success: boolean;
  branch: string;
  previousBranch: string | null;
  currentBranch: string | null;
}

export interface CheckoutCommitResponse {
  success: boolean;
}

export interface CherryPickResponse {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface RevertCommitResponse {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface ResetToCommitResponse {
  success: boolean;
}

export interface GitRebaseResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface MergeConflictDetails {
  /** Git status --porcelain output showing current state */
  statusPorcelain: string;
  /** List of unmerged file paths */
  unmergedFiles: string[];
  /** Git diff output showing current conflict state */
  diff: string;
  /** Information about MERGE_HEAD or REBASE_HEAD */
  headInfo: string;
  /** The operation type: 'merge' or 'rebase' */
  operation: 'merge' | 'rebase';
}

export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
  refs: string;
  body: string;
  author_name: string;
  author_email: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  parents: string[];
}

export interface GitLogResponse {
  all: GitLogEntry[];
  latest: GitLogEntry | null;
  total: number;
}

export interface CommitFileEntry {
  path: string;
  insertions: number;
  deletions: number;
  isBinary: boolean;
  changeType: 'A' | 'M' | 'D' | 'R' | 'C' | string;
}

export interface GitCommitFilesResponse {
  files: CommitFileEntry[];
}

export interface CommitFileDiffResponse {
  original: string;
  modified: string;
  isBinary: boolean;
}

export interface GitDeleteBranchPayload {
  branch: string;
  force?: boolean;
}

export interface GitDeleteRemoteBranchPayload {
  branch: string;
  remote?: string;
}

export interface GitRemoveRemotePayload {
  remote: string;
}

export interface CreateGitCommitOptions {
  addAll?: boolean;
  files?: string[];
  stageFiles?: string[];
}

export interface GitLogOptions {
  maxCount?: number;
  from?: string;
  to?: string;
  file?: string;
  all?: boolean;
}

export interface GitWorktree {
  head: string;
  name: string;
  branch: string | null;
  path: string;
  isPrimary: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export type GitWorktreeCreateInput =
  | { mode: 'new'; startRef: string; worktreeName?: string; branchName?: string; returnAfterDirectoryCreated?: boolean }
  | { mode: 'existing'; existingBranch: string; worktreeName?: string; branchName?: string; returnAfterDirectoryCreated?: boolean };

export interface GitWorktreeBootstrapStatus {
  status: 'pending' | 'ready' | 'failed';
  phase: 'directory-created' | 'git-ready' | 'setup-ready';
  error?: string | null;
  updatedAt?: number;
}

export interface GitWorktreeCreateResult {
  head: string;
  name: string;
  branch: string;
  path: string;
  directoryCreated?: boolean;
  bootstrapStatus: GitWorktreeBootstrapStatus;
}

export interface RemoveGitWorktreePayload {
  directory: string;
  /** Remove a worktree even when it contains uncommitted changes. */
  force?: boolean;
}

export interface GitWorktreeValidationResult {
  ok: boolean;
  errors: Array<{ code: string; message: string }>;
  resolved?: { mode: 'new' | 'existing'; localBranch: string | null };
}

export interface GitAPI {
  checkIsGitRepository(directory: string): Promise<boolean>;
  getGitStatus(directory: string, options?: { mode?: 'light' }): Promise<GitStatus>;
  getGitDiff(directory: string, options: GetGitDiffOptions): Promise<GitDiffResponse>;
  getGitFileDiff(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse>;
  getGitRangeDiff?(directory: string, options: GetGitRangeDiffOptions): Promise<GitDiffResponse>;
  revertGitFile(directory: string, filePath: string, options?: { scope?: 'all' | 'working' }): Promise<void>;
  stageGitFile(directory: string, filePath: string): Promise<void>;
  stageGitFiles?(directory: string, filePaths: string[]): Promise<void>;
  unstageGitFile(directory: string, filePath: string): Promise<void>;
  unstageGitFiles?(directory: string, filePaths: string[]): Promise<void>;
  stageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  unstageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  revertGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  getGitBranches(directory: string): Promise<GitBranch>;
  listGitWorktrees?(directory: string): Promise<GitWorktree[]>;
  validateGitWorktree?(directory: string, input: GitWorktreeCreateInput): Promise<GitWorktreeValidationResult>;
  createGitWorktree?(directory: string, input: GitWorktreeCreateInput): Promise<GitWorktreeCreateResult>;
  deleteGitWorktree?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }>;
  getGitWorktreeBootstrapStatus?(directory: string): Promise<GitWorktreeBootstrapStatus>;
  deleteGitBranch(directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }>;
  deleteRemoteBranch(directory: string, payload: GitDeleteRemoteBranchPayload): Promise<{ success: boolean }>;
  removeRemote(directory: string, payload: GitRemoveRemotePayload): Promise<{ success: boolean }>;
  createGitCommit(directory: string, message: string, options?: CreateGitCommitOptions): Promise<GitCommitResult>;
  gitPush(directory: string, options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }): Promise<GitPushResult>;
  gitPull(directory: string, options?: GitPullOptions): Promise<GitPullResult>;
  gitFetch(directory: string, options?: { remote?: string; branch?: string }): Promise<{ success: boolean }>;
  listGitStashes(directory: string): Promise<{ stashes: GitStashEntry[] }>;
  countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }>;
  stashGitChanges(directory: string, options?: { message?: string }): Promise<{ success: boolean; created: boolean; message: string; output: string }>;
  applyGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  popGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  dropGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  checkoutBranch(directory: string, branch: string, options?: CheckoutBranchOptions): Promise<CheckoutBranchResponse>;
  createBranch(directory: string, name: string, startPoint?: string): Promise<{ success: boolean; branch: string }>;
  renameBranch(directory: string, oldName: string, newName: string): Promise<{ success: boolean; branch: string }>;
  getGitLog(directory: string, options?: GitLogOptions): Promise<GitLogResponse>;
  getCommitFiles(directory: string, hash: string): Promise<GitCommitFilesResponse>;
  getCommitFileDiff?(directory: string, hash: string, filePath: string, isBinary: boolean): Promise<CommitFileDiffResponse>;
  getRemoteUrl?(directory: string, remote?: string): Promise<string | null>;
  getRemotes(directory: string): Promise<GitRemote[]>;
  rebase(directory: string, options: { onto: string }): Promise<GitRebaseResult>;
  abortRebase(directory: string): Promise<{ success: boolean }>;
  continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  merge(directory: string, options: { branch: string }): Promise<GitMergeResult>;
  abortMerge(directory: string): Promise<{ success: boolean }>;
  continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  checkoutCommit(directory: string, hash: string): Promise<CheckoutCommitResponse>;
  cherryPick(directory: string, hash: string): Promise<CherryPickResponse>;
  revertCommit(directory: string, hash: string): Promise<RevertCommitResponse>;
  resetToCommit(directory: string, hash: string, mode: 'soft' | 'mixed' | 'hard', force?: boolean): Promise<ResetToCommitResponse>;
  stash(directory: string, options?: { message?: string; includeUntracked?: boolean }): Promise<{ success: boolean }>;
  stashPop(directory: string): Promise<{ success: boolean }>;
  getConflictDetails(directory: string): Promise<MergeConflictDetails>;
}

export interface FileListEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedTime?: number;
}

export interface DirectoryListResult {
  directory: string;
  entries: FileListEntry[];
}

export interface FileSearchQuery {
  directory: string;
  query: string;
  maxResults?: number;
  includeHidden?: boolean;
  respectGitignore?: boolean;
}

export interface FileSearchResult {
  path: string;
  score?: number;
  preview?: string[];
}

export interface CommandExecResult {
  command: string;
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

interface ListDirectoryOptions {
  respectGitignore?: boolean;
}

interface FileReadOptions {
  allowOutsideWorkspace?: boolean;
  outsideFileGrant?: string;
  optional?: boolean;
  directory?: string;
  /**
   * Stat-only optimization: the exact revision the client already holds for
   * this file. When size+mtime still match, the server skips the read+hash
   * and echoes the revision unchanged. Opaque: never modified or reinterpreted.
   */
  knownRevision?: string | null;
}

/**
 * Opaque read-content revision for file-save conflict detection (finding #8).
 * Clients retain the exact string with buffer/runtime/path/generation and
 * send it back as `expectedRevision`. `null` means the file was missing at
 * read time (create-only expectation). `undefined` means the server did not
 * supply a revision (legacy) and must not be used for guarded saves.
 */
export type FileContentRevision = string | null | undefined;

export interface FileReadResult {
  content: string;
  path: string;
  /** Opaque revision; `null` when the optional read found no file. */
  revision?: FileContentRevision;
  /** False when an optional read found no file. */
  exists?: boolean;
}

export interface FileStatResult {
  path: string;
  isFile: boolean;
  size: number;
  mtimeMs?: number;
  /** Opaque revision matching `readFile` for the same bytes. */
  revision?: FileContentRevision;
  exists?: boolean;
}

export interface FileWriteOptions {
  /**
   * Guarded-save expectation: exact revision from the base read, `null` to
   * require a missing file (create-only), or omitted for legacy
   * unconditional writes. `overwrite: true` forces explicit overwrite.
   */
  expectedRevision?: string | null;
  overwrite?: boolean;
}

export interface FileWriteResult {
  success: boolean;
  path: string;
  /** New current revision after write (or the existing revision for no-ops). */
  revision?: string | null;
  noop?: boolean;
}

export interface FilesAPI {
  listDirectory(path: string, options?: ListDirectoryOptions): Promise<DirectoryListResult>;
  search(payload: FileSearchQuery): Promise<FileSearchResult[]>;
  createDirectory(path: string): Promise<{ success: boolean; path: string }>;
  statFile?(path: string, options?: FileReadOptions): Promise<FileStatResult>;
  readFile?(path: string, options?: FileReadOptions): Promise<FileReadResult>;
  readFileBinary?(path: string, options?: FileReadOptions): Promise<{ dataUrl: string; path: string }>;
  writeFile?(path: string, content: string, options?: FileWriteOptions): Promise<FileWriteResult>;
  delete?(path: string): Promise<{ success: boolean }>;
  rename?(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }>;
  revealPath?(path: string): Promise<{ success: boolean }>;
  execCommands?(commands: string[], cwd: string): Promise<{ success: boolean; results: CommandExecResult[] }>;
  downloadFile?(path: string): Promise<void>;
}

export interface ProjectEntry {
  id: string;
  path: string;
  label?: string;
  icon?: string | null;
  iconImage?: {
    mime: string;
    updatedAt: number;
    source: 'custom' | 'auto';
  } | null;
  iconBackground?: string | null;
  color?: string | null;
  defaultModel?: string;
  addedAt?: number;
  lastOpenedAt?: number;
  sidebarCollapsed?: boolean;
}

export interface SettingsPayload {
  themeId?: string;
  useSystemTheme?: boolean;
  themeVariant?: 'light' | 'dark';
  lightThemeId?: string;
  darkThemeId?: string;
  lastDirectory?: string;
  homeDirectory?: string;
  projects?: ProjectEntry[];
  activeProjectId?: string;
  securityScopedBookmarks?: string[];
  pinnedDirectories?: string[];
  showDeletionDialog?: boolean;
  nativeNotificationsEnabled?: boolean;
  notificationMode?: 'always' | 'hidden-only';
  desktopUpdateChannel?: 'stable' | 'rc';
  serverUpdateChannel?: 'stable' | 'rc';
  autoDeleteEnabled?: boolean;
  autoSaveEnabled?: boolean;
  autoDeleteAfterDays?: number;
  sessionRetentionAction?: 'archive' | 'delete';
  followUpBehavior?: 'steer' | 'queue';
  queueModeEnabled?: boolean;
  fontSize?: number;
  terminalFontSize?: number;
  terminalShell?: TerminalShell;
  terminalLoginShells?: TerminalShell[];
  editorFontSize?: number;
  uiFont?: string;
  monoFont?: string;
  padding?: number;
  cornerRadius?: number;
  inputBarOffset?: number;
  shortcutOverrides?: Record<string, string>;
  diffLayoutPreference?: 'dynamic' | 'inline' | 'side-by-side';
  gitChangesViewMode?: 'flat' | 'tree';
  filesViewShowGitignored?: boolean;
  openInAppId?: string;
  gitProviderId?: string;
  gitModelId?: string;
  pwaAppName?: string;
  mobileKeyboardMode?: 'native' | 'resize-content';
  draftStarters?: DraftStarterRef[];
  draftStartersVisible?: boolean;

  [key: string]: unknown;
}

export interface SettingsLoadResult {
  settings: SettingsPayload;
  source: 'desktop' | 'web';
}

export interface SettingsAPI {
  load(): Promise<SettingsLoadResult>;
  save(changes: Partial<SettingsPayload>): Promise<SettingsPayload>;
}

export interface DirectoryPermissionRequest {
  path: string;
}

interface DirectoryPermissionResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface StartAccessingResult {
  success: boolean;
  error?: string;
}

export interface PermissionsAPI {
  requestDirectoryAccess(request: DirectoryPermissionRequest): Promise<DirectoryPermissionResult>;
  startAccessingDirectory(path: string): Promise<StartAccessingResult>;
  stopAccessingDirectory(path: string): Promise<StartAccessingResult>;
}

export interface NotificationPayload {
  title?: string;
  body?: string;

  tag?: string;
  kind?: string;
  sessionId?: string;
  directory?: string;
  requireHidden?: boolean;
}

export interface NotificationsAPI {
  notify(payload?: NotificationPayload): Promise<boolean>;
  canNotify?: () => boolean | Promise<boolean>;
}

interface DiagnosticsAPI {
  downloadLogs(): Promise<{ fileName: string; content: string }>;
}

export interface ToolsAPI {

  getAvailableTools(): Promise<string[]>;
}

export interface EditorAPI {
  openFile(path: string, line?: number, column?: number): Promise<void>;
  openDiff(
    original: string,
    modified: string,
    label?: string,
    options?: { line?: number; patch?: string },
  ): Promise<void>;
}

export interface PushSubscribePayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  origin?: string;
  /** Runtime surface ('ios' | 'android' | 'desktop' | 'web') for presence-aware routing. */
  platform?: string;
}

export interface PushUnsubscribePayload {
  endpoint: string;
}

export interface ApnsTokenPayload {
  token: string;
  /** 'ios' (APNs) or 'android' (FCM) — lets the relay route the token to the right service. */
  platform?: string;
  /**
   * APNs environment the token belongs to: 'sandbox' for Xcode/dev-signed installs,
   * 'production' for TestFlight/App Store. Omitted when unknown (server defaults to production).
   */
  environment?: 'sandbox' | 'production';
}

export interface PushAPI {
  getVapidPublicKey(): Promise<{ publicKey: string } | null>;
  subscribe(payload: PushSubscribePayload): Promise<{ ok: true } | null>;
  unsubscribe(payload: PushUnsubscribePayload): Promise<{ ok: true } | null>;
  setVisibility(payload: { visible: boolean; platform?: string }): Promise<{ ok: true } | null>;
  /** Register a native iOS APNs device token (Capacitor mobile app only). */
  registerApnsToken(payload: ApnsTokenPayload): Promise<{ ok: true } | null>;
  unregisterApnsToken(payload: ApnsTokenPayload): Promise<{ ok: true } | null>;
}

/**
 * GitHub integration contract (native gh-CLI plan, §6.1).
 *
 * One account owned by the server's GitHub CLI — no device flow, no account
 * switching. Every method mirrors a `/api/github/*` route (see
 * `packages/web/server/lib/github/DOCUMENTATION.md`); failures throw
 * `GitHubAPIError` carrying the server's `{ error }` taxonomy body, never
 * an empty list. `repo` is always `host/owner/name` allow-listed by the
 * server against the given `directory`.
 */

export type GitHubUserSummary = {
  login: string;
  id?: number;
  avatarUrl?: string;
  name?: string;
  email?: string;
};

/** Canonical repository reference: `host/owner/name`, server allow-listed. */
export type GitHubRepoRef = {
  host: string;
  owner: string;
  repo: string;
};

export type GitHubUnavailableReason =
  | 'gh-missing'
  | 'gh-outdated'
  | 'gh-unauthenticated'
  | 'not-github'
  | 'no-repository'
  | 'no-access'
  | 'scope-missing';

export type GitHubErrorBody =
  | { kind: 'unavailable'; reason: GitHubUnavailableReason; scopes?: string[]; host?: string }
  | { kind: 'rate-limited'; retryAt: number }
  | { kind: 'failed'; message: string };

export class GitHubAPIError extends Error {
  readonly body: GitHubErrorBody;
  readonly status: number;

  constructor(body: GitHubErrorBody, status: number) {
    super(body.kind === 'failed' ? body.message : body.kind);
    this.name = 'GitHubAPIError';
    this.body = body;
    this.status = status;
  }
}

export type GitHubHostStatus = {
  host: string;
  authenticated: boolean;
  login: string | null;
  scopes: string[];
};

export type GitHubStatus = {
  installed: boolean;
  version: string | null;
  hosts: GitHubHostStatus[];
  fetchedAt: number;
};

export type GitHubScopedRepository = {
  kind: 'containing' | 'enclosing' | 'nested';
  path: string;
  relativePath: string;
  host: string | null;
  owner: string | null;
  repo: string | null;
  remote: string | null;
  remotes?: string[];
  submodule: boolean;
  /** Null when fork state is unknown (e.g. unauthenticated). */
  fork: boolean | null;
  parent?: { owner: string; repo: string } | null;
  defaultBranch?: string | null;
  disabledReason?: string | null;
};

export type GitHubScope = {
  directory: string;
  topLevel: string | null;
  branch: string | null;
  repositories: GitHubScopedRepository[];
  defaultSelection: string | null;
  fetchedAt: number;
};

export type GitHubChecksSummary = {
  state: 'success' | 'failure' | 'pending' | 'unknown';
  total: number;
  success: number;
  failure: number;
  /** queued + in_progress + unconcluded runs. */
  pending: number;
  /** Earliest started_at among runs (ISO), for elapsed display. */
  startedAt?: string | null;
};

export type GitHubCheckRunStep = {
  name: string;
  status?: string | null;
  conclusion?: string | null;
  number?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type GitHubCheckRun = {
  id?: number;
  name: string;
  state?: string | null;
  status?: string | null;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  detailsUrl?: string | null;
  app?: {
    name?: string | null;
    slug?: string | null;
  } | null;
  /** Workflow run id for GitHub Actions runs (re-run target); null otherwise. */
  runId?: number | null;
};

export type GitHubCheckStatus = {
  id?: number | null;
  context: string;
  state?: string | null;
  description?: string | null;
  targetUrl?: string | null;
};

export type GitHubChecksResult = {
  repo: GitHubRepoRef;
  ref: string;
  summary: GitHubChecksSummary;
  runs: GitHubCheckRun[];
  statuses: GitHubCheckStatus[];
  /** Per-source fetch failures. A failed source keeps its array as `[]`
   * but is never an authoritative empty result. */
  sectionErrors?: {
    runs?: GitHubErrorBody;
    statuses?: GitHubErrorBody;
  };
  fetchedAt: number;
  stale?: boolean;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  body?: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  base: string;
  head: string;
  headSha?: string | null;
  mergeable?: boolean | null;
  mergeableState?: string | null;
};

export type GitHubPullRequestSummary = GitHubPullRequest & {
  author?: GitHubUserSummary | null;
  labels?: GitHubIssueLabel[];
  assignees?: GitHubUserSummary[];
  requestedReviewers?: GitHubUserSummary[];
  createdAt?: string | null;
  updatedAt?: string | null;
  mergedAt?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  comments?: number;
};

export type GitHubPullRequestDetail = GitHubPullRequestSummary & {
  /** GitHub-rendered `body_html` for the description (signed image URLs); null when unread. */
  bodyHtml?: string | null;
  labels: GitHubIssueLabel[];
  assignees: GitHubUserSummary[];
  requestedReviewers: GitHubUserSummary[];
  milestone?: { title: string; number: number } | null;
  reviewSummary: {
    approvals: number;
    changesRequested: number;
    commented: number;
    decision: 'approved' | 'changes-requested' | 'pending';
  };
};

export type GitHubReview = {
  id: number;
  state?: string | null;
  body: string;
  /** GitHub-rendered `bodyHTML` (signed image URLs); null when unread (list seeds, older caches). */
  bodyHtml?: string | null;
  author?: GitHubUserSummary | null;
  submittedAt?: string | null;
};

export type GitHubReviewThreadComment = {
  id?: number | null;
  body: string;
  /** GitHub-rendered `bodyHTML`; null when unread. */
  bodyHtml?: string | null;
  author?: GitHubUserSummary | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  url?: string;
  path?: string | null;
  line?: number | null;
};

export type GitHubReviewThread = {
  id: string;
  resolved: boolean;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  diffSide?: string | null;
  comments: GitHubReviewThreadComment[];
};

export type GitHubPullRequestFile = {
  filename: string;
  status?: string | null;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string | null;
};

export type GitHubPullRequestsListResult = {
  repo: GitHubRepoRef;
  items: GitHubPullRequestSummary[];
  nextCursor: string | null;
  fetchedAt: number;
  stale?: boolean;
};

/** Viewer repository permission for the authenticated (`gh`) user. */
export type GitHubPermissionLevel = 'admin' | 'maintain' | 'push' | 'triage' | 'pull';

export type GitHubViewerPermission = {
  /** Highest granted level, or null when unknown. */
  level: GitHubPermissionLevel | null;
  /**
   * True when permission resolution failed. Capabilities are permissive so
   * controls stay enabled and the single attempt reports the server error —
   * never hide controls silently.
   */
  fallback: boolean;
};

export type GitHubCapabilities = {
  canPush: boolean;
  canTriage: boolean;
  canPull: boolean;
  canComment: boolean;
};

export type GitHubLinkedPullRequest = {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  url: string;
  repo: GitHubRepoRef;
  /** Canonical `host/owner/repo` for scope matching. */
  repoRef: string;
};

export type GitHubPullRequestDetailResult = {
  repo: GitHubRepoRef;
  pr: GitHubPullRequestDetail | null;
  reviews: GitHubReview[];
  threads: GitHubReviewThread[];
  viewerPermission?: GitHubViewerPermission | null;
  capabilities?: GitHubCapabilities | null;
  /** Login of the authenticated user, for author-exception gating. */
  viewerLogin?: string | null;
  /** Per-section fetch failures. A failed section keeps `reviews`/`threads`
   * as `[]` but is never an authoritative empty result — callers must
   * render `sectionErrors` instead of an empty list. */
  sectionErrors?: {
    reviews?: GitHubErrorBody;
    threads?: GitHubErrorBody;
  };
  fetchedAt: number;
  stale?: boolean;
};

export type GitHubPullRequestFilesResult = {
  repo: GitHubRepoRef;
  number: number;
  files: GitHubPullRequestFile[];
  nextCursor: string | null;
  fetchedAt: number;
};

export type GitHubPullRequestStatus = {
  repo?: GitHubRepoRef | null;
  branch?: string | null;
  pr?: GitHubPullRequestSummary | null;
  checks?: GitHubChecksSummary | null;
  checksStale?: boolean;
  defaultBranch?: string | null;
  skippedDefaultBranch?: boolean;
  fetchedAt: number;
};

export type GitHubPullRequestCreateInput = {
  directory: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
};

export type GitHubPullRequestAction =
  | 'merge'
  | 'squash'
  | 'rebase'
  | 'ready'
  | 'draft'
  | 'close'
  | 'reopen'
  | 'update-branch';

export type GitHubPullRequestActionResult = {
  ok: boolean;
  action: GitHubPullRequestAction;
  message?: string | null;
  pr?: GitHubPullRequestDetail | null;
  fetchedAt: number;
};

export type GitHubReviewEvent = 'approve' | 'request-changes' | 'comment';

export type GitHubReviewInlineComment = {
  path: string;
  body: string;
  line?: number;
  position?: number;
  side?: 'LEFT' | 'RIGHT';
  startLine?: number;
  startSide?: 'LEFT' | 'RIGHT';
};

export type GitHubIssueLabel = {
  name: string;
  color?: string | null;
  description?: string | null;
};

export type GitHubIssueSummary = {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  author?: GitHubUserSummary | null;
  labels?: GitHubIssueLabel[];
  assignees?: GitHubUserSummary[];
  comments?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type GitHubIssue = GitHubIssueSummary & {
  body?: string;
  /** GitHub-rendered `body_html` (signed image URLs); null when unread. */
  bodyHtml?: string | null;
  milestone?: { title: string; number: number } | null;
  stateReason?: string | null;
};

export type GitHubIssueComment = {
  id: number;
  url: string;
  body: string;
  /** GitHub-rendered `body_html` (signed image URLs); null when unread (older cache, optimistic post). */
  bodyHtml?: string | null;
  author?: GitHubUserSummary | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type GitHubIssuesListResult = {
  repo: GitHubRepoRef;
  items: GitHubIssueSummary[];
  nextCursor: string | null;
  fetchedAt: number;
  stale?: boolean;
};

export type GitHubIssueGetResult = {
  repo: GitHubRepoRef;
  issue: GitHubIssue | null;
  linkedPullRequests?: GitHubLinkedPullRequest[];
  viewerPermission?: GitHubViewerPermission | null;
  capabilities?: GitHubCapabilities | null;
  /** Login of the authenticated user, for author-exception gating. */
  viewerLogin?: string | null;
  /**
   * Per-section fetch failures. A failed section keeps
   * `linkedPullRequests` as `[]` but is never an authoritative empty
   * result — callers must render `sectionErrors` instead of an empty list.
   */
  sectionErrors?: {
    linkedPullRequests?: GitHubErrorBody;
  };
  fetchedAt: number;
  stale?: boolean;
};

export type GitHubIssueCommentsResult = {
  repo: GitHubRepoRef;
  number: number;
  comments: GitHubIssueComment[];
  nextCursor: string | null;
  fetchedAt: number;
};

export type GitHubIssueTemplate = {
  filename: string;
  name: string;
  body: string;
};

export type GitHubIssueTemplatesResult = {
  repo: GitHubRepoRef;
  templates: GitHubIssueTemplate[];
  fetchedAt: number;
  stale?: boolean;
};

export type GitHubPullsQuery = {
  state?: 'open' | 'closed' | 'merged' | 'all';
  filter?: 'all' | 'mine' | 'review' | 'assigned';
  q?: string;
  cursor?: string | null;
  sort?: 'updated' | 'created';
  /** Page size 1..100, default 30. Lets the UI fetch one wide list and filter locally. */
  perPage?: number;
};

export type GitHubIssuesQuery = Omit<GitHubPullsQuery, 'filter' | 'sort'> & {
  filter?: 'all' | 'mine' | 'assigned' | 'mentioned';
  labels?: string;
  sort?: 'updated' | 'created';
};

export type GitHubContextType = 'issue' | 'pr' | 'checks' | 'threads';

export type GitHubContextResult = {
  kind: string;
  text: string;
  repo: GitHubRepoRef;
  number: number;
  fetchedAt: number;
};

export interface GitHubAPI {
  status(): Promise<GitHubStatus>;
  scope(directory: string): Promise<GitHubScope>;

  pullsList(directory: string, repo: string, query?: GitHubPullsQuery): Promise<GitHubPullRequestsListResult>;
  pullGet(directory: string, repo: string, number: number): Promise<GitHubPullRequestDetailResult>;
  pullFiles(directory: string, repo: string, number: number, cursor?: string | null): Promise<GitHubPullRequestFilesResult>;
  pullChecks(directory: string, repo: string, number: number, details?: boolean): Promise<GitHubChecksResult>;
  prStatus(directory: string, branch?: string | null): Promise<GitHubPullRequestStatus>;
  pullCreate(input: GitHubPullRequestCreateInput): Promise<{ repo: GitHubRepoRef; pr: GitHubPullRequestSummary; fetchedAt: number }>;
  pullAction(directory: string, repo: string, number: number, action: GitHubPullRequestAction): Promise<GitHubPullRequestActionResult>;
  pullUpdate(directory: string, repo: string, number: number, patch: { title?: string; body?: string }): Promise<{ ok: boolean; pr: GitHubPullRequestDetail | null; fetchedAt: number }>;
  pullComment(directory: string, repo: string, number: number, body: string): Promise<{ ok: boolean; comment: GitHubIssueComment; fetchedAt: number }>;
  pullComments(directory: string, repo: string, number: number, cursor?: string | null): Promise<GitHubIssueCommentsResult>;
  pullReview(
    directory: string,
    repo: string,
    number: number,
    review: { event: GitHubReviewEvent; body?: string; comments?: GitHubReviewInlineComment[] }
  ): Promise<{ ok: boolean; review: GitHubReview; fetchedAt: number }>;
  pullThread(
    directory: string,
    repo: string,
    number: number,
    threadId: string,
    action: { action: 'reply'; body: string; commentId: number } | { action: 'resolve' | 'unresolve' }
  ): Promise<{ ok: boolean; fetchedAt: number }>;
  pullCheckout(directory: string, repo: string, number: number, mode?: 'worktree' | 'current'): Promise<{ ok: boolean; mode: string; branch: string; headSha: string; path: string | null; fetchedAt: number }>;

  issuesList(directory: string, repo: string, query?: GitHubIssuesQuery): Promise<GitHubIssuesListResult>;
  issueGet(directory: string, repo: string, number: number): Promise<GitHubIssueGetResult>;
  issueComments(directory: string, repo: string, number: number, cursor?: string | null): Promise<GitHubIssueCommentsResult>;
  issueCreate(
    directory: string,
    repo: string,
    input: { title: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number | null }
  ): Promise<{ repo: GitHubRepoRef; issue: GitHubIssue; fetchedAt: number }>;
  issueUpdate(
    directory: string,
    repo: string,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; stateReason?: 'completed' | 'not_planned'; labels?: string[]; assignees?: string[]; milestone?: number | null }
  ): Promise<{ ok: boolean; issue: GitHubIssue | null; fetchedAt: number }>;
  issueComment(directory: string, repo: string, number: number, body: string): Promise<{ ok: boolean; comment: GitHubIssueComment; fetchedAt: number }>;

  repoMeta(directory: string, repo: string, kinds?: Array<'labels' | 'assignees'>): Promise<{ repo: GitHubRepoRef; labels?: GitHubIssueLabel[]; assignees?: GitHubUserSummary[]; fetchedAt: number }>;
  issueTemplates(directory: string, repo: string): Promise<GitHubIssueTemplatesResult>;
  checkJobs(directory: string, repo: string, runId: number | null, jobId?: number | null): Promise<{ repo: GitHubRepoRef; runId: number | null; jobs: Array<{ id: number; name: string; status?: string | null; conclusion?: string | null; startedAt?: string | null; completedAt?: string | null; detailsUrl?: string | null; steps: GitHubCheckRunStep[] }>; fetchedAt: number }>;
  checkAnnotations(directory: string, repo: string, checkRunId: number): Promise<{ repo: GitHubRepoRef; checkRunId: number; annotations: Array<{ path?: string | null; startLine?: number | null; endLine?: number | null; level?: string | null; message: string; title?: string | null }>; fetchedAt: number }>;
  checksRerun(directory: string, repo: string, runId: number): Promise<{ ok: boolean; runId: number; fetchedAt: number }>;
  agentContext(directory: string, repo: string, type: GitHubContextType, number: number, options?: { ref?: string; includeDiff?: boolean }): Promise<GitHubContextResult>;
  invalidate(input?: { directory?: string; repo?: string; kind?: 'pulls' | 'issues' | 'checks' | 'repo' | 'all'; number?: number }): Promise<{ ok: boolean; fetchedAt: number }>;
}

export interface PairingTransports {
  local: string | null;
  lan: string | null;
  relayAvailable: boolean;
  tailscale?: { available: boolean; url: string | null; mode: 'private' | 'public' } | null;
}

export interface RemoteClientRecord {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt?: string | null;
  clientKind?: string | null;
  authMethod?: string | null;
  /** Pairing session this client was created from, when authMethod is 'pairing'. */
  pairingId?: string | null;
  deviceName?: string | null;
  devicePlatform?: string | null;
  usesRelay?: boolean;
  /** Transport that carried the device's most recent authenticated request. */
  lastTransport?: 'relay' | 'direct' | null;
}

// A pairing link that has been created but not yet redeemed by a device.
export interface PendingPairingRecord {
  id: string;
  label?: string;
  fingerprint?: string | null;
  expiresAt?: string;
  usesRelay?: boolean;
}

export interface RemoteClientCreateResult {
  client: RemoteClientRecord;
  token: string;
}

export interface RemoteClientRevokeResult {
  revoked: boolean;
  client?: RemoteClientRecord;
}

export interface RemoteClientPurgeRevokedResult {
  purged: number;
}

export interface PairingSessionCreateResult {
  pairing: {
    id: string;
    label?: string;
    fingerprint?: string | null;
    expiresAt?: string;
    secret: string;
  };
  server: {
    label: string;
    // Transport candidates for the pairing-v2 payload. Shape matches
    // PairingEndpointCandidate in `@/lib/connectionPayload` (direct lan/tunnel or
    // relay); left as a structural type here so this contract file stays leaf.
    candidates: Array<Record<string, unknown>>;
  };
}

export interface ClientAuthAPI {
  listClients(): Promise<RemoteClientRecord[]>;
  createClient(input?: { label?: string }): Promise<RemoteClientCreateResult>;
  // Creates a one-time pairing session (pairing v2). `serverUrl` is the
  // externally reachable URL to advertise as the direct candidate (the desktop
  // UI talks to its server over loopback, so it must supply the LAN URL); the
  // server folds in a relay candidate when its relay host is enabled.
  createPairingSession(input?: {
    label?: string;
    allowedClientKinds?: Array<'mobile' | 'desktop'>;
    serverUrl?: string;
    // Per-link transport choice. `includeRelay: true` adds the relay candidate
    // and enables the relay host on demand; `false` omits it; omitted keeps the
    // legacy "relay only if already enabled" behavior. `includeDirect: false`
    // produces a relay-only link (no direct candidate).
    includeRelay?: boolean;
    includeDirect?: boolean;
  }): Promise<PairingSessionCreateResult>;
  purgeRevokedClients(): Promise<RemoteClientPurgeRevokedResult>;
  revokeClient(id: string): Promise<RemoteClientRevokeResult>;
  // Pairing links created but not yet redeemed (the "pending devices" list).
  listPendingPairings(): Promise<PendingPairingRecord[]>;
  cancelPairing(id: string): Promise<{ cancelled: boolean }>;
  // Direct transports the server can be reached on, for the create-device dialog.
  // LAN reflects the server's actual bind, independent of the UI origin.
  // `tailscale` is present when the server's Tailscale mapping is active.
  getPairingTransports(): Promise<PairingTransports>;
}

export interface RuntimeAPIs {
  runtime: RuntimeDescriptor;
  terminal: TerminalAPI;
  git: GitAPI;
  files: FilesAPI;
  settings: SettingsAPI;
  permissions: PermissionsAPI;
  notifications: NotificationsAPI;
  github?: GitHubAPI;
  push?: PushAPI;
  diagnostics?: DiagnosticsAPI;
  clientAuth?: ClientAuthAPI;
  tools: ToolsAPI;
  editor?: EditorAPI;
}
