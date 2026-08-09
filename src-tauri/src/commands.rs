//! Tauri IPC 커맨드 — 전부 `apigen-core`로 위임하는 얇은 어댑터.
//!
//! 프론트와는 OpenAPI 문서를 `serde_json::Value`로 주고받는다(프론트가 JSON을 SSOT로 보유).
//! 각 커맨드는 `Result<T, AppError>`를 돌려주고, 실패 시 프론트에서 catch된다.

use std::path::Path;

use apigen_core::http::{Environment, HttpRequest, HttpResponse};
use apigen_core::markdown::{to_markdown, MarkdownOptions};
use apigen_core::model::Diagnostic;
use apigen_core::openapiv3::OpenAPI;
use apigen_core::project::ClientConfig;
use apigen_core::{self as core, AppError, Format};
use serde::Serialize;
use serde_json::Value;

type CmdResult<T> = Result<T, AppError>;

/// Value → OpenAPI (프론트 → 코어).
fn to_spec(v: Value) -> CmdResult<OpenAPI> {
    serde_json::from_value(v).map_err(|e| core::CoreError::from(e).into())
}
/// OpenAPI → Value (코어 → 프론트).
fn from_spec(s: &OpenAPI) -> CmdResult<Value> {
    serde_json::to_value(s).map_err(|e| core::CoreError::from(e).into())
}

fn parse_format(s: Option<&str>) -> Option<Format> {
    match s {
        Some("json") => Some(Format::Json),
        Some("yaml") | Some("yml") => Some(Format::Yaml),
        _ => None, // auto
    }
}

/// 프로젝트 로드/번들 결과 페이로드.
#[derive(Serialize)]
pub struct ProjectPayload {
    pub spec: Value,
    pub warnings: Vec<Diagnostic>,
}

// ─────────────────────────── 연결 확인 ───────────────────────────

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

// ─────────────────────────── 스펙 IO / 검증 ───────────────────────────

#[tauri::command]
pub fn import_spec(text: String, format: Option<String>) -> CmdResult<Value> {
    let spec = core::import_spec(&text, parse_format(format.as_deref()))?;
    from_spec(&spec)
}

#[tauri::command]
pub fn export_spec(spec: Value, format: String) -> CmdResult<String> {
    let spec = to_spec(spec)?;
    let fmt = parse_format(Some(&format)).unwrap_or(Format::Yaml);
    Ok(core::export_spec(&spec, fmt)?)
}

#[tauri::command]
pub fn validate_spec(spec: Value) -> CmdResult<Vec<Diagnostic>> {
    let spec = to_spec(spec)?;
    Ok(core::validate::validate(&spec))
}

// ─────────────────────────── 문서 렌더 ───────────────────────────

#[tauri::command]
pub fn spec_to_markdown(
    spec: Value,
    include_examples: Option<bool>,
    include_schemas: Option<bool>,
) -> CmdResult<String> {
    let spec = to_spec(spec)?;
    let opts = MarkdownOptions {
        include_examples: include_examples.unwrap_or(true),
        include_schemas: include_schemas.unwrap_or(true),
        heading_base_level: 1,
    };
    Ok(to_markdown(&spec, &opts))
}

/// Redoc용 self-contained HTML 생성. standalone 번들은 프론트 리소스에서 주입하므로
/// 여기서는 spec JSON을 안전하게 임베드한 HTML 뼈대를 만든다(§7.2).
#[tauri::command]
pub fn render_redoc_html(spec: Value) -> CmdResult<String> {
    let spec = to_spec(spec)?;
    let json = core::export_spec(&spec, Format::Json)?;
    // </script> 이스케이프로 조기 종료 방지.
    let safe = json.replace("</", "<\\/");
    Ok(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Redoc</title></head>
<body><div id="redoc"></div>
<script>window.__SPEC__ = {safe};</script>
<script src="redoc.standalone.js"></script>
<script>Redoc.init(window.__SPEC__, {{}}, document.getElementById('redoc'));</script>
</body></html>"#
    ))
}

// ─────────────────────────── HTTP 클라이언트 ───────────────────────────

#[tauri::command]
pub fn send_http_request(req: HttpRequest, env: Option<Environment>) -> CmdResult<HttpResponse> {
    // 동기(blocking) reqwest. Tauri는 non-async 커맨드를 별도 스레드에서 실행하므로 안전.
    let env = env.unwrap_or_default();
    Ok(core::http::send(&req, &env)?)
}

// ─────────────────────────── 프로젝트(파일 트리) ───────────────────────────

#[tauri::command]
pub fn open_project(dir: String) -> CmdResult<ProjectPayload> {
    let (spec, warnings) = core::project::bundle(Path::new(&dir))?;
    Ok(ProjectPayload { spec: from_spec(&spec)?, warnings })
}

#[tauri::command]
pub fn new_project(dir: String, title: String, version: String) -> CmdResult<ProjectPayload> {
    let info = core::project::new_info(&title, &version);
    let spec = OpenAPI {
        openapi: "3.0.3".to_string(),
        info,
        ..Default::default()
    };
    core::project::split(Path::new(&dir), &spec)?;
    let (spec, warnings) = core::project::bundle(Path::new(&dir))?;
    Ok(ProjectPayload { spec: from_spec(&spec)?, warnings })
}

/// Import한 단일 스펙을 git 친화 트리로 분해.
#[tauri::command]
pub fn split_into_project(dir: String, spec: Value) -> CmdResult<()> {
    let spec = to_spec(spec)?;
    core::project::split(Path::new(&dir), &spec)?;
    Ok(())
}

/// 트리 → 번들 문서를 단일 파일 문자열로 Export.
#[tauri::command]
pub fn export_project(dir: String, format: String) -> CmdResult<String> {
    let (spec, _) = core::project::bundle(Path::new(&dir))?;
    let fmt = parse_format(Some(&format)).unwrap_or(Format::Yaml);
    Ok(core::export_spec(&spec, fmt)?)
}

// ─────────────────────────── HTTP Client 환경 ───────────────────────────

#[tauri::command]
pub fn load_client_config(dir: String) -> CmdResult<ClientConfig> {
    Ok(core::project::load_client(Path::new(&dir))?)
}

#[tauri::command]
pub fn save_client_config(dir: String, config: ClientConfig) -> CmdResult<()> {
    core::project::save_client(Path::new(&dir), &config)?;
    Ok(())
}

// ─────────────────────────── Bruno .bru 호환 ───────────────────────────

/// `.bru` 원문 → HTTP 클라이언트 요청(Try-it-out에서 실행 가능).
#[tauri::command]
pub fn import_bru(text: String) -> CmdResult<HttpRequest> {
    let bru = core::bru::BruRequest::parse(&text);
    Ok(core::bru::bru_to_http(&bru))
}

/// HTTP 요청 → `.bru` 원문(Bruno에서 열림).
#[tauri::command]
pub fn export_bru(name: String, req: HttpRequest) -> CmdResult<String> {
    Ok(core::bru::http_to_bru(&name, Some(1), &req).serialize())
}

/// 컬렉션(스펙) 전체 → Bruno .bru 파일 트리(<dir>/bruno/). 생성 경로 반환.
#[tauri::command]
pub fn export_bru_collection(dir: String, spec: Value) -> CmdResult<String> {
    let spec = to_spec(spec)?;
    let base = core::bru::export_collection(Path::new(&dir), &spec)?;
    Ok(base.to_string_lossy().to_string())
}

/// Bruno .bru 컬렉션 폴더 → OpenAPI 스펙 + 환경(Plume 컬렉션 생성용).
#[tauri::command]
pub fn import_bru_collection(dir: String) -> CmdResult<core::bru::BruImport> {
    Ok(core::bru::import_collection(Path::new(&dir))?)
}

// ─────────────────────────── 부하 테스트 ───────────────────────────

#[tauri::command]
pub fn run_load(
    req: HttpRequest,
    env: Option<Environment>,
    iterations: usize,
    concurrency: usize,
) -> CmdResult<core::load::LoadResult> {
    let env = env.unwrap_or_default();
    let opts = core::load::LoadOptions { iterations, concurrency };
    Ok(core::load::run_load(&req, &env, &opts)?)
}

/// 그룹(여러 요청) 부하 테스트.
#[tauri::command]
pub fn run_load_group(
    reqs: Vec<HttpRequest>,
    env: Option<Environment>,
    iterations: usize,
    concurrency: usize,
) -> CmdResult<core::load::LoadResult> {
    let env = env.unwrap_or_default();
    let opts = core::load::LoadOptions { iterations, concurrency };
    Ok(core::load::run_load_group(&reqs, &env, &opts)?)
}

// ─────────────────────────── 코드 스니펫 ───────────────────────────

/// 요청 → (언어, 코드) 목록. env 변수 치환 반영.
#[tauri::command]
pub fn code_snippets(req: HttpRequest, env: Option<Environment>) -> CmdResult<Vec<(String, String)>> {
    let env = env.unwrap_or_default();
    Ok(core::snippet::all(&req, &env))
}

// ─────────────────────────── GitHub Pages 퍼블리시 ───────────────────────────

/// Redoc 문서를 <dir>/docs/index.html 에 기록. 생성 경로 반환.
#[tauri::command]
pub fn write_pages_docs(dir: String, spec: Value, viewer: Option<String>) -> CmdResult<String> {
    let spec = to_spec(spec)?;
    let title = spec.info.title.clone();
    let json = core::export_spec(&spec, Format::Json)?;
    let v = core::publish::Viewer::parse(viewer.as_deref().unwrap_or("redoc"));
    let path = core::publish::write_pages_html(Path::new(&dir), &json, &title, v)?;
    Ok(path.to_string_lossy().to_string())
}

/// 자체 완결(인라인) 문서 HTML을 지정 경로에 내보낸다(viewer=redoc|swagger). 오프라인으로 열림.
#[tauri::command]
pub fn export_standalone_html(dest: String, spec: Value, viewer: Option<String>) -> CmdResult<String> {
    let spec = to_spec(spec)?;
    let title = spec.info.title.clone();
    let json = core::export_spec(&spec, Format::Json)?;
    let v = core::publish::Viewer::parse(viewer.as_deref().unwrap_or("redoc"));
    let path = core::publish::write_standalone_html(Path::new(&dest), &json, &title, v)?;
    Ok(path.to_string_lossy().to_string())
}

/// 원클릭 GitHub Pages: docs 문서 생성 → add·commit·push (viewer=redoc|swagger).
#[tauri::command]
pub fn publish_github_pages(dir: String, spec: Value, message: String, viewer: Option<String>) -> CmdResult<String> {
    let spec = to_spec(spec)?;
    let title = spec.info.title.clone();
    let json = core::export_spec(&spec, Format::Json)?;
    let v = core::publish::Viewer::parse(viewer.as_deref().unwrap_or("redoc"));
    Ok(core::publish::publish_pages(Path::new(&dir), &json, &title, &message, v)?)
}

// ─────────────────────────── 파일 IO (다운로드·체인 영속) ───────────────────────────

/// 임의 텍스트 파일 쓰기(내보내기 다운로드·체인 저장 등). 상위 폴더 자동 생성.
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> CmdResult<()> {
    if let Some(parent) = Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, content).map_err(|e| core::CoreError::Project(format!("파일 쓰기 실패: {e}")))?;
    Ok(())
}

/// 바이너리 파일 쓰기(PNG 다운로드 등). 프론트에서 Uint8Array→number[]로 전달.
#[tauri::command]
pub fn write_bytes_file(path: String, bytes: Vec<u8>) -> CmdResult<()> {
    if let Some(parent) = Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, bytes).map_err(|e| core::CoreError::Project(format!("파일 쓰기 실패: {e}")))?;
    Ok(())
}

/// 워크스페이스 정보(프로젝트 폴더 하위 서브폴더).
#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub name: String,
    pub path: String,
}

/// 파일/폴더 이름 정리(경로 구분자·특수문자 → _).
fn safe_name(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    if t.is_empty() { "collection".into() } else { t }
}

#[derive(serde::Deserialize)]
pub struct CollectionIn {
    pub name: String,
    pub spec: Value,
}
#[derive(Serialize)]
pub struct CollectionOut {
    pub name: String,
    pub spec: Value,
}

/// 워크스페이스의 모든 컬렉션을 `<ws>/collections/<이름>/`에 저장(삭제된 컬렉션 정리 포함).
#[tauri::command]
pub fn save_workspace_collections(ws_dir: String, collections: Vec<CollectionIn>) -> CmdResult<()> {
    let base = Path::new(&ws_dir).join("collections");
    let _ = std::fs::remove_dir_all(&base); // stale 컬렉션 제거 후 재작성
    for c in collections {
        let spec = to_spec(c.spec)?;
        let dir = base.join(safe_name(&c.name));
        core::project::split(&dir, &spec)?;
    }
    Ok(())
}

/// 워크스페이스의 컬렉션들을 로드. `collections/` 없으면 레거시(ws 루트 자체 = 컬렉션 1개)로 대응.
#[tauri::command]
pub fn load_workspace_collections(ws_dir: String) -> CmdResult<Vec<CollectionOut>> {
    let base = Path::new(&ws_dir).join("collections");
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&base) {
        let mut dirs: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for p in dirs {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("collection").to_string();
            let (spec, _w) = core::project::bundle(&p)?;
            out.push(CollectionOut { name, spec: from_spec(&spec)? });
        }
    }
    // 레거시: collections/ 없고 ws 루트에 folders/가 있으면 그걸 컬렉션 하나로.
    if out.is_empty() && Path::new(&ws_dir).join("folders").is_dir() {
        let (spec, _w) = core::project::bundle(Path::new(&ws_dir))?;
        let name = spec.info.title.clone();
        out.push(CollectionOut { name, spec: from_spec(&spec)? });
    }
    Ok(out)
}

/// 프로젝트 폴더(root) 하위에서 워크스페이스(서브폴더)를 나열한다.
/// project.yaml / .plume/workspace.json / folders/ 중 하나라도 있으면 워크스페이스로 인정.
#[tauri::command]
pub fn list_workspaces(root: String) -> CmdResult<Vec<WorkspaceInfo>> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if name.is_empty() || name.starts_with('.') {
                continue; // 숨김/메타 폴더 제외
            }
            let is_ws = p.join("project.yaml").is_file()
                || p.join(".plume").join("workspace.json").is_file()
                || p.join("folders").is_dir();
            if is_ws {
                out.push(WorkspaceInfo { name, path: p.to_string_lossy().to_string() });
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// 워크스페이스 폴더 이름 변경: `<root>/<old>` → `<root>/<new>` + `.plume/workspace.json` 갱신.
/// 폴더명이 곧 워크스페이스 식별자이므로 폴더 자체를 rename 한다.
#[tauri::command]
pub fn rename_workspace(root: String, old_name: String, new_name: String) -> CmdResult<String> {
    let new = new_name.trim();
    if new.is_empty() || new.contains('/') || new.contains('\\') || new.contains("..") {
        return Err(core::CoreError::Project("올바르지 않은 워크스페이스 이름".into()).into());
    }
    let root_p = Path::new(&root);
    let from = root_p.join(&old_name);
    let to = root_p.join(new);
    if !from.is_dir() {
        return Err(core::CoreError::Project("원본 워크스페이스를 찾을 수 없습니다".into()).into());
    }
    if new != old_name {
        if to.exists() {
            return Err(core::CoreError::Project("같은 이름의 워크스페이스가 이미 있습니다".into()).into());
        }
        std::fs::rename(&from, &to)
            .map_err(|e| core::CoreError::Project(format!("이름 변경 실패: {e}")))?;
    }
    // 표시명 일치를 위해 workspace.json 갱신.
    let plume = to.join(".plume");
    let _ = std::fs::create_dir_all(&plume);
    let _ = std::fs::write(
        plume.join("workspace.json"),
        serde_json::to_string_pretty(&serde_json::json!({ "name": new })).unwrap_or_default(),
    );
    Ok(to.to_string_lossy().to_string())
}

/// 텍스트 파일 읽기. 없으면 None(체인 로드 등에서 최초 실행 대응).
#[tauri::command]
pub fn read_text_file(path: String) -> CmdResult<Option<String>> {
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(core::CoreError::Project(format!("파일 읽기 실패: {e}")).into()),
    }
}

// ─────────────────────────── Git ───────────────────────────

#[tauri::command]
pub fn git_status(dir: String) -> CmdResult<core::git::GitStatus> {
    Ok(core::git::status(Path::new(&dir))?)
}
#[tauri::command]
pub fn git_log(dir: String, n: usize) -> CmdResult<Vec<core::git::Commit>> {
    Ok(core::git::log(Path::new(&dir), n)?)
}
#[tauri::command]
pub fn git_init(dir: String) -> CmdResult<String> {
    Ok(core::git::init(Path::new(&dir))?)
}
#[tauri::command]
pub fn git_stage_all(dir: String) -> CmdResult<()> {
    core::git::stage_all(Path::new(&dir))?;
    Ok(())
}
#[tauri::command]
pub fn git_commit(dir: String, message: String) -> CmdResult<String> {
    Ok(core::git::commit(Path::new(&dir), &message)?)
}
#[tauri::command]
pub fn git_push(dir: String) -> CmdResult<String> {
    Ok(core::git::push(Path::new(&dir))?)
}
#[tauri::command]
pub fn git_pull(dir: String) -> CmdResult<String> {
    Ok(core::git::pull(Path::new(&dir))?)
}
#[tauri::command]
pub fn git_branches(dir: String) -> CmdResult<Vec<String>> {
    Ok(core::git::branches(Path::new(&dir))?)
}
#[tauri::command]
pub fn git_checkout(dir: String, branch: String, create: bool) -> CmdResult<String> {
    Ok(core::git::checkout(Path::new(&dir), &branch, create)?)
}
#[tauri::command]
pub fn git_stage(dir: String, path: String) -> CmdResult<()> {
    core::git::stage(Path::new(&dir), &path)?;
    Ok(())
}
#[tauri::command]
pub fn git_unstage(dir: String, path: String) -> CmdResult<()> {
    core::git::unstage(Path::new(&dir), &path)?;
    Ok(())
}
#[tauri::command]
pub fn git_discard(dir: String, path: String, untracked: bool) -> CmdResult<()> {
    core::git::discard(Path::new(&dir), &path, untracked)?;
    Ok(())
}
#[tauri::command]
pub fn git_fetch(dir: String) -> CmdResult<String> {
    Ok(core::git::fetch(Path::new(&dir))?)
}
#[tauri::command]
pub fn git_delete_branch(dir: String, name: String) -> CmdResult<()> {
    core::git::delete_branch(Path::new(&dir), &name)?;
    Ok(())
}
#[tauri::command]
pub fn git_diff_file(dir: String, path: String, staged: bool) -> CmdResult<String> {
    Ok(core::git::diff_file(Path::new(&dir), &path, staged)?)
}
#[tauri::command]
pub fn git_graph(dir: String, n: usize) -> CmdResult<String> {
    Ok(core::git::graph(Path::new(&dir), n)?)
}
#[tauri::command]
pub fn git_graph_data(dir: String, n: usize) -> CmdResult<Vec<core::git::GraphCommit>> {
    Ok(core::git::graph_data(Path::new(&dir), n)?)
}
#[tauri::command]
pub fn git_remotes(dir: String) -> CmdResult<Vec<(String, String)>> {
    Ok(core::git::remotes(Path::new(&dir))?)
}
#[tauri::command]
pub fn git_add_remote(dir: String, name: String, url: String) -> CmdResult<()> {
    core::git::add_remote(Path::new(&dir), &name, &url)?;
    Ok(())
}
#[tauri::command]
pub fn git_remove_remote(dir: String, name: String) -> CmdResult<()> {
    core::git::remove_remote(Path::new(&dir), &name)?;
    Ok(())
}
#[tauri::command]
pub fn git_set_remote_url(dir: String, name: String, url: String) -> CmdResult<()> {
    core::git::set_remote_url(Path::new(&dir), &name, &url)?;
    Ok(())
}
#[tauri::command]
pub fn git_push_upstream(dir: String, remote: String, branch: String) -> CmdResult<String> {
    Ok(core::git::push_upstream(Path::new(&dir), &remote, &branch)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 실제 커맨드로 저장→불러오기 왕복(다중 컬렉션·폴더·대소문자 경로 보존 확인).
    #[test]
    fn save_load_workspace_collections_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_string_lossy().to_string();

        let spec_a = serde_json::json!({
            "openapi": "3.0.3", "info": { "title": "Users API", "version": "1" },
            "paths": { "/user/Login": { "post": {
                "summary": "login", "x-folder": "auth",
                "responses": { "200": { "description": "ok" } }
            }}}
        });
        let spec_b = serde_json::json!({
            "openapi": "3.0.3", "info": { "title": "Billing", "version": "1" },
            "paths": { "/pay": { "get": { "summary": "pay",
                "responses": { "200": { "description": "ok" } } }}}
        });

        save_workspace_collections(ws.clone(), vec![
            CollectionIn { name: "Users API".into(), spec: spec_a },
            CollectionIn { name: "Billing".into(), spec: spec_b },
        ]).unwrap();

        let loaded = load_workspace_collections(ws).unwrap();
        assert_eq!(loaded.len(), 2, "두 컬렉션이 로드돼야");

        let total: usize = loaded.iter()
            .map(|c| c.spec.get("paths").and_then(|p| p.as_object()).map(|o| o.len()).unwrap_or(0))
            .sum();
        assert_eq!(total, 2, "저장한 요청이 모두 로드돼야(유실 없음)");

        // 대소문자 경로 보존
        let has_login = loaded.iter().any(|c|
            c.spec.get("paths").and_then(|p| p.get("/user/Login")).is_some());
        assert!(has_login, "대소문자 경로 /user/Login 보존");
    }

    // 환경변수 저장(persistClient)→컬렉션 저장(Ctrl+S)→환경 로드(loadClient) 왕복.
    // "환경변수가 저장 안 된다" 버그 리포트 검증.
    #[test]
    fn environment_vars_persist_through_collection_save() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_string_lossy().to_string();

        let mut vars = std::collections::BTreeMap::new();
        vars.insert("baseUrl".to_string(), "http://x".to_string());
        vars.insert("token".to_string(), "abc".to_string());
        let cfg = ClientConfig {
            environments: vec![Environment { id: "local".into(), name: "Local".into(), variables: vars }],
            active_environment_id: "local".into(),
        };
        // 1) 환경 저장
        save_client_config(ws.clone(), cfg).unwrap();
        // 2) 그 사이 컬렉션 저장(환경 폴더를 지우면 안 됨)
        let spec = serde_json::json!({
            "openapi": "3.0.3", "info": { "title": "A", "version": "1" },
            "paths": { "/a": { "get": { "responses": { "200": { "description": "ok" } } } } }
        });
        save_workspace_collections(ws.clone(), vec![CollectionIn { name: "A".into(), spec }]).unwrap();
        // 3) 다시 로드 → 변수 보존
        let loaded = load_client_config(ws).unwrap();
        assert_eq!(loaded.environments.len(), 1, "환경 1개 로드돼야");
        assert_eq!(loaded.active_environment_id, "local");
        let env = &loaded.environments[0];
        assert_eq!(env.variables.get("baseUrl").map(String::as_str), Some("http://x"));
        assert_eq!(env.variables.get("token").map(String::as_str), Some("abc"));
    }
}
