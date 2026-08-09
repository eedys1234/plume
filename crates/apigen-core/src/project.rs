//! 파일 트리 ↔ 단일 OpenAPI 문서 변환 (§4.5).
//!
//! - [`bundle`]: 디스크의 폴더/파일 트리를 walk 해 하나의 `openapiv3::OpenAPI`로 조립.
//! - [`split`] : 단일 문서를 git 친화적 파일 트리로 분해(Import 직후 전개).
//!
//! `$ref`는 파일 상대경로(`components/schemas/User.yaml`)와 표준 JSON Pointer
//! (`#/components/schemas/User`) 둘 다 허용하며, 번들 시 전자를 후자로 정규화한다.

use std::fs;
use std::path::{Path, PathBuf};

use openapiv3::{
    Components, Example, Info, MediaType, OpenAPI, Operation, PathItem, Paths, ReferenceOr,
    RequestBody, Response, Responses, StatusCode,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{CoreError, Result};
use crate::http::Environment;
use crate::model::{
    Diagnostic, ExampleFile, ExampleIn, ExampleTarget, FolderFile, ProjectFile, RequestFile,
};

// ─────────────────────────── 파일 IO 헬퍼 ───────────────────────────

fn read_yaml<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let s = fs::read_to_string(path)
        .map_err(|e| CoreError::Project(format!("{} 읽기 실패: {e}", path.display())))?;
    serde_yaml::from_str(&s).map_err(CoreError::from)
}

fn write_yaml<T: Serialize>(path: &Path, val: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let s = serde_yaml::to_string(val)?;
    fs::write(path, s)?;
    Ok(())
}

/// 하위 디렉토리들을 이름순 정렬해 반환(결정성 확보).
fn sorted_subdirs(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    v.sort();
    Ok(v)
}

/// 특정 확장자 파일들을 이름순 정렬해 반환.
fn sorted_files(dir: &Path, ext: &str) -> Result<Vec<PathBuf>> {
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut v: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some(ext))
        .collect();
    v.sort();
    Ok(v)
}

fn file_stem(path: &Path) -> String {
    path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string()
}

// ─────────────────────────── BUNDLE (트리 → 문서) ───────────────────────────

/// 프로젝트 루트 디렉토리를 하나의 OpenAPI 문서로 번들링한다.
pub fn bundle(root: &Path) -> Result<(OpenAPI, Vec<Diagnostic>)> {
    let mut warnings = Vec::new();

    // 1) project.yaml → 문서 헤더
    let proj: ProjectFile = read_yaml(&root.join("project.yaml"))?;
    let mut spec = OpenAPI {
        openapi: proj.openapi,
        info: proj.info,
        servers: proj.servers,
        paths: Paths::default(),
        components: Some(Components::default()),
        ..Default::default()
    };

    // 1b) 메모(x-comments)·노트(x-notes) 복원 — split이 project.yaml에 보존한 값.
    if !proj.x_comments.is_null() {
        spec.extensions
            .insert("x-comments".to_string(), proj.x_comments);
    }
    if !proj.x_notes.is_null() {
        spec.extensions.insert("x-notes".to_string(), proj.x_notes);
    }

    // 2) components/** → #/components/*
    load_components(root, &mut spec)?;

    // 3) folders/** → paths. 빈 폴더 포함 모든 폴더 경로를 수집해 x-folders로 보존.
    let folders_dir = root.join("folders");
    let mut folder_paths: Vec<String> = Vec::new();
    if folders_dir.is_dir() {
        for child in sorted_subdirs(&folders_dir)? {
            walk_folder(&child, None, &mut spec, &mut warnings, &mut folder_paths)?;
        }
    }
    if !folder_paths.is_empty() {
        folder_paths.sort();
        folder_paths.dedup();
        spec.extensions.insert(
            "x-folders".to_string(),
            Value::Array(folder_paths.into_iter().map(Value::String).collect()),
        );
    }

    // 4) $ref 정규화(파일경로 → JSON Pointer)
    normalize_refs(&mut spec)?;

    Ok((spec, warnings))
}

/// components/<kind>/*.yaml 및 securitySchemes.yaml 로드.
fn load_components(root: &Path, spec: &mut OpenAPI) -> Result<()> {
    let comp_dir = root.join("components");
    if !comp_dir.is_dir() {
        return Ok(());
    }
    let comp = spec.components.as_mut().expect("bundle에서 항상 Some으로 초기화");

    // 디렉토리 하나를 IndexMap<String, ReferenceOr<T>>로 읽는 제네릭 헬퍼.
    fn load_dir<T: DeserializeOwned>(
        dir: &Path,
    ) -> Result<indexmap::IndexMap<String, ReferenceOr<T>>> {
        let mut map = indexmap::IndexMap::new();
        for f in sorted_files(dir, "yaml")? {
            let key = file_stem(&f);
            let val: ReferenceOr<T> = read_yaml(&f)?;
            map.insert(key, val);
        }
        Ok(map)
    }

    comp.schemas = load_dir(&comp_dir.join("schemas"))?;
    comp.responses = load_dir(&comp_dir.join("responses"))?;
    comp.parameters = load_dir(&comp_dir.join("parameters"))?;
    comp.examples = load_dir(&comp_dir.join("examples"))?;
    comp.request_bodies = load_dir(&comp_dir.join("requestBodies"))?;
    comp.headers = load_dir(&comp_dir.join("headers"))?;

    // securitySchemes 는 단일 파일에 map 형태로.
    let sec = comp_dir.join("securitySchemes.yaml");
    if sec.is_file() {
        comp.security_schemes = read_yaml(&sec)?;
    }
    Ok(())
}

/// 폴더 하나를 재귀적으로 walk. Request 디렉토리를 만나면 operation을 조립한다.
/// 폴더는 태그와 **독립**이며, 디렉토리 경로가 곧 폴더 경로다.
fn walk_folder(
    dir: &Path,
    parent_path: Option<&str>,
    spec: &mut OpenAPI,
    warnings: &mut Vec<Diagnostic>,
    folder_paths: &mut Vec<String>,
) -> Result<()> {
    let name = file_stem(dir);
    // 폴더 경로 = 디렉토리 구조 그 자체(예: "users", "users/admin").
    let folder_path = match parent_path {
        Some(p) => format!("{p}/{name}"),
        None => name.clone(),
    };
    // 요청이 없어도 폴더 자체를 기록(빈 폴더 영속화).
    folder_paths.push(folder_path.clone());

    for child in sorted_subdirs(dir)? {
        if child.join("request.yaml").is_file() {
            process_request(&child, &folder_path, spec, warnings)?;
        } else {
            // 중첩 폴더
            walk_folder(&child, Some(&folder_path), spec, warnings, folder_paths)?;
        }
    }
    Ok(())
}

/// Request 디렉토리 → Operation 하나를 paths에 삽입하고 examples를 부착한다.
fn process_request(
    dir: &Path,
    folder_path: &str,
    spec: &mut OpenAPI,
    warnings: &mut Vec<Diagnostic>,
) -> Result<()> {
    let req: RequestFile = read_yaml(&dir.join("request.yaml"))?;
    let mut op = req.operation;

    // 폴더는 태그가 아니라 x-folder 확장으로 보존(태그와 독립, 단일 문서에도 남음).
    op.extensions
        .insert("x-folder".to_string(), Value::String(folder_path.to_string()));

    // examples/*.yaml 부착
    for f in sorted_files(&dir.join("examples"), "yaml")? {
        let ex: ExampleFile = read_yaml(&f)?;
        attach_example(&mut op, &ex, warnings, &req.path);
    }

    // paths[path].{method} = op
    let method = req.method.to_lowercase();
    let entry = spec
        .paths
        .paths
        .entry(req.path.clone())
        .or_insert_with(|| ReferenceOr::Item(PathItem::default()));

    let ReferenceOr::Item(pi) = entry else {
        warnings.push(Diagnostic::warn(&req.path, "참조($ref)로 된 PathItem에는 operation을 붙일 수 없어 건너뜀"));
        return Ok(());
    };

    let slot = match method.as_str() {
        "get" => &mut pi.get,
        "post" => &mut pi.post,
        "put" => &mut pi.put,
        "delete" => &mut pi.delete,
        "patch" => &mut pi.patch,
        "head" => &mut pi.head,
        "options" => &mut pi.options,
        "trace" => &mut pi.trace,
        other => {
            warnings.push(Diagnostic::warn(&req.path, format!("알 수 없는 HTTP 메서드: {other}")));
            return Ok(());
        }
    };
    if slot.is_some() {
        warnings.push(Diagnostic::warn(
            format!("{} {}", method, req.path),
            "동일 path+method가 중복 정의되어 덮어씀",
        ));
    }
    *slot = Some(op);
    Ok(())
}

/// 예시를 operation의 requestBody/response 해당 media type에 붙인다.
fn attach_example(op: &mut Operation, ex: &ExampleFile, warnings: &mut Vec<Diagnostic>, path: &str) {
    let mt = ex.target.media_type.clone().unwrap_or_else(|| "application/json".to_string());
    let example_obj = ReferenceOr::Item(Example {
        summary: ex.summary.clone(),
        description: ex.description.clone(),
        value: ex.value.clone(),
        external_value: ex.external_value.clone(),
        extensions: Default::default(),
    });

    match ex.target.location {
        ExampleIn::Request => {
            let rb = op
                .request_body
                .get_or_insert_with(|| ReferenceOr::Item(RequestBody::default()));
            if let ReferenceOr::Item(body) = rb {
                body.content.entry(mt).or_default().examples.insert(ex.name.clone(), example_obj);
            } else {
                warnings.push(Diagnostic::warn(path, "참조된 requestBody에는 예시를 붙일 수 없음"));
            }
        }
        ExampleIn::Response => {
            let status = ex.target.status.clone().unwrap_or_else(|| "200".to_string());
            let resp_ref = response_slot(&mut op.responses, &status);
            if let ReferenceOr::Item(resp) = resp_ref {
                resp.content.entry(mt).or_default().examples.insert(ex.name.clone(), example_obj);
            } else {
                warnings.push(Diagnostic::warn(path, "참조된 response에는 예시를 붙일 수 없음"));
            }
        }
    }
}

/// 주어진 상태코드 문자열에 해당하는 Response 슬롯을 가져오거나 새로 만든다.
fn response_slot<'a>(responses: &'a mut Responses, status: &str) -> &'a mut ReferenceOr<Response> {
    if status.eq_ignore_ascii_case("default") {
        return responses
            .default
            .get_or_insert_with(|| ReferenceOr::Item(empty_response()));
    }
    let code = parse_status(status);
    responses
        .responses
        .entry(code)
        .or_insert_with(|| ReferenceOr::Item(empty_response()))
}

fn empty_response() -> Response {
    Response { description: String::new(), ..Default::default() }
}

/// "200" → Code(200), "2XX" → Range(2).
fn parse_status(s: &str) -> StatusCode {
    let up = s.to_uppercase();
    if up.ends_with("XX") {
        if let Some(d) = up.chars().next().and_then(|c| c.to_digit(10)) {
            return StatusCode::Range(d as u16);
        }
    }
    match s.parse::<u16>() {
        Ok(n) => StatusCode::Code(n),
        Err(_) => StatusCode::Code(200),
    }
}

// ─────────────────────────── $ref 정규화 ───────────────────────────

/// 문서 전체를 JSON으로 직렬화 → 모든 `$ref` 문자열을 정규화 → 다시 역직렬화.
/// openapiv3 트리를 손으로 재귀 순회하는 것보다 견고하고 간결하다.
fn normalize_refs(spec: &mut OpenAPI) -> Result<()> {
    let mut v = serde_json::to_value(&*spec)?;
    rewrite_refs(&mut v);
    *spec = serde_json::from_value(v)?;
    Ok(())
}

fn rewrite_refs(v: &mut Value) {
    match v {
        Value::Object(map) => {
            if let Some(Value::String(r)) = map.get_mut("$ref") {
                *r = normalize_ref(r);
            }
            for (_k, val) in map.iter_mut() {
                rewrite_refs(val);
            }
        }
        Value::Array(arr) => arr.iter_mut().for_each(rewrite_refs),
        _ => {}
    }
}

/// `components/schemas/User.yaml` → `#/components/schemas/User`.
/// 이미 `#/...` JSON Pointer면 그대로 둔다.
fn normalize_ref(s: &str) -> String {
    if s.starts_with('#') {
        return s.to_string();
    }
    if let Some(idx) = s.find("components/") {
        let tail = &s[idx..];
        let tail = tail
            .trim_end_matches(".yaml")
            .trim_end_matches(".yml")
            .trim_end_matches(".json");
        return format!("#/{tail}");
    }
    s.to_string()
}

// ─────────────────────────── SPLIT (문서 → 트리) ───────────────────────────

/// 단일 OpenAPI 문서를 git 친화적 파일 트리로 분해해 `root`에 기록한다.
/// 참조는 표준 `#/...` JSON Pointer 그대로 유지하므로 bundle이 손실 없이 복원한다.
pub fn split(root: &Path, spec: &OpenAPI) -> Result<()> {
    fs::create_dir_all(root)?;

    // 0) 삭제된 요청·폴더·컴포넌트가 디스크에 남아 되살아나지 않도록,
    //    split이 관리하는 디렉터리(folders/·components/)를 먼저 비운다.
    //    environments/·.apigen/·docs/·bruno/·.git 등 그 외 파일은 건드리지 않는다.
    let _ = fs::remove_dir_all(root.join("folders"));
    let _ = fs::remove_dir_all(root.join("components"));

    // 1) project.yaml
    let proj = ProjectFile {
        openapi: spec.openapi.clone(),
        info: spec.info.clone(),
        servers: spec.servers.clone(),
        // 메모·노트는 루트 확장에서 그대로 옮겨 project.yaml에 보존.
        x_comments: spec
            .extensions
            .get("x-comments")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        x_notes: spec
            .extensions
            .get("x-notes")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    };
    write_yaml(&root.join("project.yaml"), &proj)?;

    // 2) components/**
    if let Some(comp) = &spec.components {
        write_component_dir(&root.join("components/schemas"), &comp.schemas)?;
        write_component_dir(&root.join("components/responses"), &comp.responses)?;
        write_component_dir(&root.join("components/parameters"), &comp.parameters)?;
        write_component_dir(&root.join("components/examples"), &comp.examples)?;
        write_component_dir(&root.join("components/requestBodies"), &comp.request_bodies)?;
        write_component_dir(&root.join("components/headers"), &comp.headers)?;
        if !comp.security_schemes.is_empty() {
            write_yaml(&root.join("components/securitySchemes.yaml"), &comp.security_schemes)?;
        }
    }

    // 3) paths → folders/<tag>/<request>/
    // path·method 정렬로 결정적 출력.
    let mut path_keys: Vec<&String> = spec.paths.paths.keys().collect();
    path_keys.sort();
    for path in path_keys {
        let ReferenceOr::Item(pi) = &spec.paths.paths[path] else { continue };
        for (method, op) in operations(pi) {
            let Some(op) = op else { continue };
            write_request(root, path, method, op)?;
        }
    }

    // 4) 폴더 마커: 빈 폴더(요청 없음)도 디스크에 남기고 git이 추적하도록 _folder.yaml 기록.
    write_folder_markers(root, spec)?;
    Ok(())
}

/// operation의 x-folder ∪ 루트 x-folders를 모아, 각 폴더(및 모든 상위 경로)에
/// `_folder.yaml`을 쓴다. → 빈 폴더 영속화 + git 추적.
fn write_folder_markers(root: &Path, spec: &OpenAPI) -> Result<()> {
    use std::collections::BTreeSet;
    let mut folders: BTreeSet<String> = BTreeSet::new();

    let add_with_prefixes = |set: &mut BTreeSet<String>, path: &str| {
        let mut acc = String::new();
        for seg in path.split('/').filter(|s| !s.is_empty()) {
            acc = if acc.is_empty() { seg.to_string() } else { format!("{acc}/{seg}") };
            set.insert(acc.clone());
        }
    };

    // operation들의 x-folder
    for item in spec.paths.paths.values() {
        if let ReferenceOr::Item(pi) = item {
            for (_m, op) in operations(pi) {
                if let Some(op) = op {
                    if let Some(f) = op.extensions.get("x-folder").and_then(|v| v.as_str()) {
                        add_with_prefixes(&mut folders, f);
                    }
                }
            }
        }
    }
    // 루트 x-folders(빈 폴더 포함)
    if let Some(Value::Array(arr)) = spec.extensions.get("x-folders") {
        for v in arr {
            if let Some(s) = v.as_str() {
                add_with_prefixes(&mut folders, s);
            }
        }
    }

    for folder in &folders {
        let mut dir = root.join("folders");
        for seg in folder.split('/').filter(|s| !s.is_empty()) {
            dir = dir.join(sanitize(seg));
        }
        let name = folder.rsplit('/').next().unwrap_or(folder).to_string();
        write_yaml(&dir.join("_folder.yaml"), &FolderFile { name: Some(name), ..Default::default() })?;
    }
    Ok(())
}

fn write_component_dir<T: Serialize>(
    dir: &Path,
    map: &indexmap::IndexMap<String, ReferenceOr<T>>,
) -> Result<()> {
    for (name, val) in map {
        write_yaml(&dir.join(format!("{name}.yaml")), val)?;
    }
    Ok(())
}

/// PathItem의 (method, Operation) 목록을 고정 순서로 반환.
fn operations(pi: &PathItem) -> Vec<(&'static str, Option<&Operation>)> {
    vec![
        ("get", pi.get.as_ref()),
        ("post", pi.post.as_ref()),
        ("put", pi.put.as_ref()),
        ("delete", pi.delete.as_ref()),
        ("patch", pi.patch.as_ref()),
        ("head", pi.head.as_ref()),
        ("options", pi.options.as_ref()),
        ("trace", pi.trace.as_ref()),
    ]
}

fn write_request(root: &Path, path: &str, method: &str, op: &Operation) -> Result<()> {
    // 폴더 결정 우선순위: x-folder 확장 > 첫 태그 > 첫 path 세그먼트.
    let folder = op
        .extensions
        .get("x-folder")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| op.tags.first().cloned())
        .unwrap_or_else(|| first_segment(path));

    let req_name = op
        .operation_id
        .clone()
        .unwrap_or_else(|| format!("{method}_{}", slug(path)));

    // 중첩 폴더 경로("users/admin")를 세그먼트별 sanitize 해 디렉토리로 구성.
    let mut req_dir = root.join("folders");
    for seg in folder.split('/').filter(|s| !s.is_empty()) {
        req_dir = req_dir.join(sanitize(seg));
    }
    req_dir = req_dir.join(sanitize(&req_name));

    // 예시를 별도 파일로 뽑아내고, x-folder는 위치로 암시되므로 파일엔 저장하지 않는다.
    let mut op = op.clone();
    op.extensions.shift_remove("x-folder");
    let example_files = extract_examples(&mut op);

    let req_file = RequestFile { method: method.to_string(), path: path.to_string(), operation: op };
    write_yaml(&req_dir.join("request.yaml"), &req_file)?;

    for ex in example_files {
        write_yaml(&req_dir.join("examples").join(format!("{}.yaml", sanitize(&ex.name))), &ex)?;
    }
    Ok(())
}

/// operation의 requestBody/response에서 named example을 뽑아 ExampleFile 목록으로 만들고
/// operation 쪽 examples는 비운다(번들 시 파일에서 다시 결합).
fn extract_examples(op: &mut Operation) -> Vec<ExampleFile> {
    let mut out = Vec::new();

    // requestBody
    if let Some(ReferenceOr::Item(body)) = op.request_body.as_mut() {
        for (mt, media) in body.content.iter_mut() {
            drain_media(media, ExampleIn::Request, None, mt, &mut out);
        }
    }
    // responses
    let mut resp_targets: Vec<(Option<String>, &mut ReferenceOr<Response>)> = Vec::new();
    if let Some(def) = op.responses.default.as_mut() {
        resp_targets.push((Some("default".to_string()), def));
    }
    for (code, r) in op.responses.responses.iter_mut() {
        resp_targets.push((Some(status_string(code)), r));
    }
    for (status, r) in resp_targets {
        if let ReferenceOr::Item(resp) = r {
            for (mt, media) in resp.content.iter_mut() {
                drain_media(media, ExampleIn::Response, status.clone(), mt, &mut out);
            }
        }
    }
    out
}

fn drain_media(
    media: &mut MediaType,
    location: ExampleIn,
    status: Option<String>,
    mt: &str,
    out: &mut Vec<ExampleFile>,
) {
    let names: Vec<String> = media.examples.keys().cloned().collect();
    for name in names {
        if let Some(ReferenceOr::Item(ex)) = media.examples.shift_remove(&name) {
            out.push(ExampleFile {
                name,
                target: ExampleTarget {
                    location,
                    status: status.clone(),
                    media_type: Some(mt.to_string()),
                },
                summary: ex.summary,
                description: ex.description,
                value: ex.value,
                external_value: ex.external_value,
            });
        }
    }
}

fn status_string(code: &StatusCode) -> String {
    match code {
        StatusCode::Code(n) => n.to_string(),
        StatusCode::Range(r) => format!("{r}XX"),
    }
}

fn first_segment(path: &str) -> String {
    path.trim_start_matches('/').split('/').next().filter(|s| !s.is_empty()).unwrap_or("default").to_string()
}

fn slug(path: &str) -> String {
    path.trim_matches('/')
        .replace(['/', '{', '}'], "_")
        .replace(' ', "_")
}

/// 파일명으로 안전하게 만드는 최소 정규화(트리 밖 경로/구분자 차단).
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

// ─────────────────────────── Info 편의 생성자 ───────────────────────────

/// 새 프로젝트용 최소 Info.
pub fn new_info(title: &str, version: &str) -> Info {
    Info {
        title: title.to_string(),
        version: version.to_string(),
        ..Default::default()
    }
}

// ─────────────────────────── HTTP Client 환경 영속화 ───────────────────────────

/// 프로젝트의 HTTP Client 설정(환경 목록 + 활성 환경). 스펙과 분리되어 Export 대상 아님.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClientConfig {
    #[serde(default)]
    pub environments: Vec<Environment>,
    #[serde(default, rename = "activeEnvironmentId")]
    pub active_environment_id: String,
}

/// `.apigen/config.yaml` 스키마(활성 환경 등 앱 관리 상태).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AppConfig {
    #[serde(default, rename = "activeEnvironmentId")]
    active_environment_id: String,
}

/// `environments/*.yaml`(환경별 1파일) + `.apigen/config.yaml`(활성 환경)을 읽는다.
pub fn load_client(root: &Path) -> Result<ClientConfig> {
    let mut environments = Vec::new();
    for f in sorted_files(&root.join("environments"), "yaml")? {
        environments.push(read_yaml::<Environment>(&f)?);
    }

    let cfg_path = root.join(".apigen").join("config.yaml");
    let active = if cfg_path.is_file() {
        read_yaml::<AppConfig>(&cfg_path)?.active_environment_id
    } else {
        environments.first().map(|e| e.id.clone()).unwrap_or_default()
    };

    Ok(ClientConfig { environments, active_environment_id: active })
}

/// 환경을 파일별로 저장하고 활성 환경을 `.apigen/config.yaml`에 기록한다.
pub fn save_client(root: &Path, cfg: &ClientConfig) -> Result<()> {
    let env_dir = root.join("environments");
    for env in &cfg.environments {
        let id = if env.id.is_empty() { "default" } else { env.id.as_str() };
        write_yaml(&env_dir.join(format!("{}.yaml", sanitize(id))), env)?;
    }
    let app = AppConfig { active_environment_id: cfg.active_environment_id.clone() };
    write_yaml(&root.join(".apigen").join("config.yaml"), &app)?;
    Ok(())
}
