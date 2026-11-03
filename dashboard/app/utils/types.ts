// API shapes returned by /api (server/crates/api).

export type Role = 'admin' | 'member' | 'viewer'

export interface MeProject {
  id: number
  slug: string
  name: string
  role: Role
}

export interface Me {
  id: number
  email: string
  name: string | null
  is_superadmin: boolean
  csrf: string
  projects: MeProject[]
}

export interface Project {
  id: number
  slug: string
  name: string
  public_key: string
  dsn: string
  allowed_origins: string[]
  asset_base_url: string | null
  asset_rewrite_from: string[]
  retention_days: number
  remote_config: Record<string, unknown>
  fingerprint_rules: { pattern: string, replace?: string }[]
  telegram: Record<string, unknown> | null
  created_at: number
  role: Role | null
  upload_token?: string
}

export type IssueStatus = 'unresolved' | 'resolved' | 'ignored'

export interface Issue {
  id: number
  project_id: number
  level: 'error' | 'warning'
  source: string
  type: string | null
  title: string
  culprit: string | null
  status: IssueStatus
  first_seen: number
  last_seen: number
  first_release: string | null
  last_release: string | null
  platforms: string[]
  times_seen: number
  users_seen: number
  symbolicated: boolean
  resolved_in_release: string | null
  ignore_until: number | null
}

export interface OrigFrame {
  file: string
  line: number
  col: number
  function?: string
  pre?: string[]
  context?: string
  post?: string[]
}

export interface Frame {
  function?: string
  url?: string
  line: number
  col: number
  path?: string
  in_app: boolean
  orig?: OrigFrame
}

export interface Breadcrumb {
  ts: number
  cat: string
  msg: string
  data?: Record<string, unknown>
}

export interface EventPayload {
  message: string
  type?: string
  stack?: string
  frames: Frame[]
  tags: Record<string, unknown>
  ctx?: Record<string, Record<string, unknown>>
  breadcrumbs: Breadcrumb[]
  user?: { id?: string, email?: string }
  browser_ver?: string
}

export interface IssueEvent {
  id: string
  ts: number
  session_id: string | null
  level: string | null
  release: string | null
  environment: string | null
  platform: string | null
  url: string | null
  user_id: string | null
  browser: string | null
  os: string | null
  app_version: string | null
  payload: EventPayload
}

export interface IssueDetail extends Issue {
  platform_split: Record<string, number>
  latest_event: IssueEvent | null
  can_change_status: boolean
}

export interface SessionRow {
  id: string
  project_id: number
  started_at: number
  last_at: number
  ended: boolean
  duration_ms: number
  entry_url: string | null
  user_id: string | null
  user_email: string | null
  release: string | null
  environment: string | null
  platform: string
  app_version: string | null
  device_model: string | null
  os_version: string | null
  webview_version: string | null
  browser: string | null
  browser_ver: string | null
  os: string | null
  vw: number | null
  vh: number | null
  lang: string | null
  error_count: number
  warn_count: number
  click_count: number
  ws_disconnects: number
  segments: number
  bytes: number
  has_gap: boolean
  file_day: string
}

export interface SessionDetail extends SessionRow {
  errors: { id: string, ts: number, level: string | null, issue_id: number, title: string, status: string }[]
  asset_base_url: string | null
  asset_rewrite_from: string[]
  project_slug: string
  can_view_sensitive: boolean
}
