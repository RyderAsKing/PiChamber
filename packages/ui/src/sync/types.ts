import type {
  Agent,
  Command,
  Config,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  VcsInfo,
} from "@/lib/chat/types"

export type FileDiff = {
  file?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
  [key: string]: unknown
}

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

/** Per-directory store state */
export type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider: ProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  sessionListSource?: "empty" | "persisted" | "live" | "authoritative"
  sessionRevision?: number
  sessionEventRevision?: Record<string, number>
  sessionDeletedRevision?: Record<string, number>
  session_status: Record<string, SessionStatus>
  session_diff: Record<string, FileDiff[]>
  todo: Record<string, Todo[]>
  permission: Record<string, PermissionRequest[]>
  question: Record<string, QuestionRequest[]>
  mcp: Record<string, McpStatus>
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

/** Global store state */
export type GlobalState = {
  ready: boolean
  error?: InitError
  path: Path
  projects: Project[]
  providers: ProviderListResponse
  providerAuth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
  sessionTodo: Record<string, Todo[]>
}

type InitError = {
  type: "init"
  message: string
}

export type DirState = {
  lastAccessAt: number
}

/**
 * Directories touched within this window are never overflow-eviction victims.
 *
 * Sidebar rows call `ensureChild` during render but only take their pin in an
 * effect after commit. Without a grace window, expanding a project with more
 * worktrees than `MAX_DIR_STORES` evicted directories that were actively
 * rendering, which recreated them, which issued another bootstrap request, in
 * an endless loop (issue #1472). The limit is therefore a soft target: a burst
 * of live directories overflows briefly rather than thrashing, and the cache is
 * bounded by idle-time eviction instead.
 */

export const INITIAL_STATE: State = {
  project: "",
  projectMeta: undefined,
  icon: undefined,
  provider: { all: [], connected: [], default: {} },
  config: {},
  path: { state: "", config: "", worktree: "", directory: "", home: "" },
  status: "loading",
  agent: [],
  command: [],
  session: [],
  sessionTotal: 0,
  sessionListSource: "empty",
  sessionRevision: 0,
  sessionEventRevision: {},
  sessionDeletedRevision: {},
  session_status: {},
  session_diff: {},
  todo: {},
  permission: {},
  question: {},
  mcp: {},
  lsp: [],
  vcs: undefined,
  limit: 5,
  message: {},
  part: {},
}
