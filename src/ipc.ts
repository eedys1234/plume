// Rust 커맨드(src-tauri/src/commands.rs)의 타입 세이프 래퍼.
// Tauri 2는 JS의 camelCase 인자 키를 Rust의 snake_case 파라미터로 자동 매핑한다.
import { invoke } from "@tauri-apps/api/core";

// OAS 3.0 문서. 지금은 느슨한 any. 추후 코어 스키마에서 생성한 타입으로 교체(§4.2).
export type Spec = any;

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  path: string;
  message: string;
}
export interface ProjectPayload {
  spec: Spec;
  warnings: Diagnostic[];
}

export type BodySpec =
  | { kind: "none" }
  | { kind: "json"; value: unknown }
  | { kind: "text"; value: string }
  | { kind: "form"; value: Record<string, string> };

export type AuthSpec =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "apikey"; in: string; name: string; value: string };

export interface HttpRequestSpec {
  method: string;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: BodySpec;
  auth: AuthSpec;
}

export interface Environment {
  id: string;
  name: string;
  variables: Record<string, string>;
  /** Pre/Post 스크립트 전용 변수(요청 치환에는 미사용). */
  scriptVariables?: Record<string, string>;
}

export interface ClientConfig {
  environments: Environment[];
  activeEnvironmentId: string;
}

export interface DeployInput {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  bucket: string;
  key: string;
  distributionId?: string;
  invalidationPath?: string;
  roleArn?: string;
  viewer?: "redoc" | "swagger";
  title?: string;
  spec: Spec;
}

export interface GitFileStatus {
  status: string;
  path: string;
}
export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}
export interface GitGraphCommit {
  hash: string;
  parents: string[];
  refs: string[];
  author: string;
  date: string;
  subject: string;
}
export interface GitStatus {
  isRepo: boolean;
  branch: string;
  files: GitFileStatus[];
  ahead: number;
  behind: number;
}

export interface LoadResult {
  total: number;
  success: number;
  failed: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  rps: number;
  elapsedMs: number;
  statusCounts: [number, number][];
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  bodyText: string;
  bodyJson?: unknown;
  elapsedMs: number;
  sizeBytes: number;
  isBinary: boolean;
  bodyBytes?: number[]; // 바이너리일 때만 원본 바이트
}

export const api = {
  ping: () => invoke<string>("ping"),

  importSpec: (text: string, format?: "json" | "yaml") =>
    invoke<Spec>("import_spec", { text, format }),
  exportSpec: (spec: Spec, format: "json" | "yaml") =>
    invoke<string>("export_spec", { spec, format }),
  validateSpec: (spec: Spec) => invoke<Diagnostic[]>("validate_spec", { spec }),

  specToMarkdown: (spec: Spec, includeExamples = true, includeSchemas = true) =>
    invoke<string>("spec_to_markdown", { spec, includeExamples, includeSchemas }),
  renderRedocHtml: (spec: Spec) => invoke<string>("render_redoc_html", { spec }),

  sendHttpRequest: (req: HttpRequestSpec, env?: Environment) =>
    invoke<HttpResponse>("send_http_request", { req, env }),

  openProject: (dir: string) => invoke<ProjectPayload>("open_project", { dir }),
  newProject: (dir: string, title: string, version: string) =>
    invoke<ProjectPayload>("new_project", { dir, title, version }),
  splitIntoProject: (dir: string, spec: Spec) =>
    invoke<void>("split_into_project", { dir, spec }),
  exportProject: (dir: string, format: "json" | "yaml") =>
    invoke<string>("export_project", { dir, format }),

  loadClientConfig: (dir: string) => invoke<ClientConfig>("load_client_config", { dir }),
  saveClientConfig: (dir: string, config: ClientConfig) =>
    invoke<void>("save_client_config", { dir, config }),

  // Bruno .bru 호환
  importBru: (text: string) => invoke<HttpRequestSpec>("import_bru", { text }),
  exportBru: (name: string, req: HttpRequestSpec) => invoke<string>("export_bru", { name, req }),
  // 컬렉션 전체를 Bruno .bru 파일 트리로 Export
  exportBruCollection: (dir: string, spec: Spec) =>
    invoke<string>("export_bru_collection", { dir, spec }),
  // Bruno .bru 컬렉션 폴더 → 스펙 + 환경 Import
  importBruCollection: (dir: string) =>
    invoke<{ spec: Spec; environments: Environment[] }>("import_bru_collection", { dir }),
  importBrunoEnvironment: (text: string, id: string) =>
    invoke<Environment>("import_bruno_environment", { text, id }),
  importPostmanCollection: (text: string) =>
    invoke<Spec>("import_postman_collection", { text }),
  importPostmanEnvironment: (text: string, id: string) =>
    invoke<Environment>("import_postman_environment", { text, id }),
  exportPostmanCollection: (spec: Spec) =>
    invoke<string>("export_postman_collection", { spec }),

  // 코드 스니펫 (언어, 코드)[]
  codeSnippets: (req: HttpRequestSpec, env?: Environment) =>
    invoke<[string, string][]>("code_snippets", { req, env }),

  // 부하 테스트
  runLoad: (req: HttpRequestSpec, env: Environment | undefined, iterations: number, concurrency: number) =>
    invoke<LoadResult>("run_load", { req, env, iterations, concurrency }),
  runLoadGroup: (reqs: HttpRequestSpec[], env: Environment | undefined, iterations: number, concurrency: number) =>
    invoke<LoadResult>("run_load_group", { reqs, env, iterations, concurrency }),

  // 문서 공유 (단일 HTML / GitHub Pages)
  writePagesDocs: (dir: string, spec: Spec, viewer: "redoc" | "swagger" = "redoc") =>
    invoke<string>("write_pages_docs", { dir, spec, viewer }),
  exportStandaloneHtml: (dest: string, spec: Spec, viewer: "redoc" | "swagger" = "redoc") =>
    invoke<string>("export_standalone_html", { dest, spec, viewer }),
  publishGithubPages: (dir: string, spec: Spec, message: string, viewer: "redoc" | "swagger" = "redoc") =>
    invoke<string>("publish_github_pages", { dir, spec, message, viewer }),
  deployCloudFront: (input: DeployInput) => invoke<string>("deploy_cloudfront", { input }),
  deployConfigLoad: (project: string) => invoke<string | null>("deploy_config_load", { project }),
  deployConfigSave: (project: string, json: string) => invoke<void>("deploy_config_save", { project, json }),
  appVersion: () => invoke<string>("app_version"),
  appMetaSave: (json: string) => invoke<void>("app_meta_save", { json }),
  appMetaLoad: () => invoke<string | null>("app_meta_load"),

  // Git
  gitStatus: (dir: string) => invoke<GitStatus>("git_status", { dir }),
  gitLog: (dir: string, n: number) => invoke<GitCommit[]>("git_log", { dir, n }),
  gitInit: (dir: string) => invoke<string>("git_init", { dir }),
  gitStageAll: (dir: string) => invoke<void>("git_stage_all", { dir }),
  gitCommit: (dir: string, message: string) => invoke<string>("git_commit", { dir, message }),
  gitPush: (dir: string) => invoke<string>("git_push", { dir }),
  gitPull: (dir: string) => invoke<string>("git_pull", { dir }),
  gitStashSave: (dir: string, message: string, includeUntracked: boolean) =>
    invoke<string>("git_stash_save", { dir, message, includeUntracked }),
  gitStashList: (dir: string) => invoke<{ index: number; message: string }[]>("git_stash_list", { dir }),
  gitStashPop: (dir: string, index: number) => invoke<string>("git_stash_pop", { dir, index }),
  gitStashApply: (dir: string, index: number) => invoke<string>("git_stash_apply", { dir, index }),
  gitStashDrop: (dir: string, index: number) => invoke<string>("git_stash_drop", { dir, index }),
  gitBranches: (dir: string) => invoke<string[]>("git_branches", { dir }),
  gitCheckout: (dir: string, branch: string, create: boolean) =>
    invoke<string>("git_checkout", { dir, branch, create }),
  gitStage: (dir: string, path: string) => invoke<void>("git_stage", { dir, path }),
  gitUnstage: (dir: string, path: string) => invoke<void>("git_unstage", { dir, path }),
  gitDiscard: (dir: string, path: string, untracked: boolean) =>
    invoke<void>("git_discard", { dir, path, untracked }),
  gitFetch: (dir: string) => invoke<string>("git_fetch", { dir }),
  gitDeleteBranch: (dir: string, name: string) => invoke<void>("git_delete_branch", { dir, name }),
  gitDiffFile: (dir: string, path: string, staged: boolean) =>
    invoke<string>("git_diff_file", { dir, path, staged }),
  gitGraph: (dir: string, n: number) => invoke<string>("git_graph", { dir, n }),
  gitGraphData: (dir: string, n: number) => invoke<GitGraphCommit[]>("git_graph_data", { dir, n }),

  // 파일 IO (내보내기 다운로드 · 체인 영속)
  writeTextFile: (path: string, content: string) => invoke<void>("write_text_file", { path, content }),
  writeBytesFile: (path: string, bytes: number[]) => invoke<void>("write_bytes_file", { path, bytes }),
  readTextFile: (path: string) => invoke<string | null>("read_text_file", { path }),
  listWorkspaces: (root: string) => invoke<{ name: string; path: string }[]>("list_workspaces", { root }),
  renameWorkspace: (root: string, oldName: string, newName: string) =>
    invoke<string>("rename_workspace", { root, oldName, newName }),
  deleteWorkspace: (root: string, name: string) => invoke<void>("delete_workspace", { root, name }),
  saveWorkspaceCollections: (wsDir: string, collections: { name: string; spec: Spec }[]) =>
    invoke<void>("save_workspace_collections", { wsDir, collections }),
  loadWorkspaceCollections: (wsDir: string) =>
    invoke<{ name: string; spec: Spec }[]>("load_workspace_collections", { wsDir }),
  gitRemotes: (dir: string) => invoke<[string, string][]>("git_remotes", { dir }),
  gitAddRemote: (dir: string, name: string, url: string) =>
    invoke<void>("git_add_remote", { dir, name, url }),
  gitRemoveRemote: (dir: string, name: string) => invoke<void>("git_remove_remote", { dir, name }),
  gitSetRemoteUrl: (dir: string, name: string, url: string) =>
    invoke<void>("git_set_remote_url", { dir, name, url }),
  gitPushUpstream: (dir: string, remote: string, branch: string) =>
    invoke<string>("git_push_upstream", { dir, remote, branch }),
};
