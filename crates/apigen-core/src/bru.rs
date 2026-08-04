//! Bruno `.bru` DSL 코덱 — 파서/시리얼라이저 + 요청·환경 매핑.
//!
//! "기본 틀 = Bruno" 요구에 따라, 프로젝트를 실제 Bruno 컬렉션으로 읽고 쓰기 위한 기반.
//! `.bru`는 블록 기반 DSL이다:  `name[:subtype] { ... }`.
//! - dictionary 블록(meta/headers/params:*/auth:*): `key: value` 라인들
//! - text 블록(body:json/body:text/docs): 원문 그대로
//!
//! Bruno는 API 클라이언트라 스키마/필수/nullable 개념이 없다 → 그 OpenAPI 고유 정보는
//! 상위 계층에서 사이드카로 보관하고, 여기서는 요청의 클라이언트 측면만 왕복한다.

use std::collections::BTreeMap;

use crate::http::{AuthSpec, BodySpec, Environment, HttpRequest};

/// 파싱된 원시 블록. `inner`는 중괄호 사이 원문.
#[derive(Debug, Clone, PartialEq)]
pub struct BruBlock {
    pub name: String,
    pub inner: String,
}

/// `.bru` 텍스트 → 블록 목록. 중괄호 깊이를 세어 body:json 내부의 `{}`도 안전 처리.
pub fn parse_blocks(input: &str) -> Vec<BruBlock> {
    let chars: Vec<char> = input.chars().collect();
    let n = chars.len();
    let mut i = 0;
    let mut blocks = Vec::new();

    while i < n {
        while i < n && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= n {
            break;
        }
        // 블록 이름: 공백 또는 '{' 전까지
        let start = i;
        while i < n && !chars[i].is_whitespace() && chars[i] != '{' {
            i += 1;
        }
        let name: String = chars[start..i].iter().collect();

        while i < n && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= n || chars[i] != '{' {
            break; // 형식 오류 → 중단
        }
        i += 1; // '{'

        let inner_start = i;
        let mut depth = 1;
        while i < n {
            match chars[i] {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        let inner: String = chars[inner_start..i].iter().collect();
        if i < n {
            i += 1; // '}'
        }
        if !name.is_empty() {
            blocks.push(BruBlock { name, inner });
        }
    }
    blocks
}

/// dictionary 블록 파싱: 각 라인을 첫 `:`에서 key/value로.
fn parse_dict(inner: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in inner.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(idx) = t.find(':') {
            out.push((t[..idx].trim().to_string(), t[idx + 1..].trim().to_string()));
        }
    }
    out
}

/// text 블록의 공통 들여쓰기 제거(앞뒤 빈 줄도 정리).
fn dedent(inner: &str) -> String {
    let mut lines: Vec<&str> = inner.lines().collect();
    while lines.first().map_or(false, |l| l.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().map_or(false, |l| l.trim().is_empty()) {
        lines.pop();
    }
    let min_indent = lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|l| if l.len() >= min_indent { &l[min_indent..] } else { *l })
        .collect::<Vec<_>>()
        .join("\n")
}

// ── 블록 inner 생성기(2-space 들여쓰기) ──
fn dict_inner(pairs: &[(String, String)]) -> String {
    let mut s = String::from("\n");
    for (k, v) in pairs {
        s.push_str(&format!("  {k}: {v}\n"));
    }
    s
}
fn text_inner(content: &str) -> String {
    let indented = content
        .lines()
        .map(|l| if l.is_empty() { String::new() } else { format!("  {l}") })
        .collect::<Vec<_>>()
        .join("\n");
    format!("\n{indented}\n")
}

fn serialize_blocks(blocks: &[BruBlock]) -> String {
    let mut out = String::new();
    for b in blocks {
        out.push_str(&format!("{} {{{}}}\n\n", b.name, b.inner));
    }
    out
}

// ─────────────────────────── 요청 모델 ───────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum BruAuth {
    None,
    Bearer(String),
    Basic { username: String, password: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum BruBody {
    None,
    Json(String),
    Text(String),
    Form(Vec<(String, String)>),
}

/// Bruno 요청 하나(`.bru` 파일 1개).
#[derive(Debug, Clone, PartialEq)]
pub struct BruRequest {
    pub name: String,
    pub seq: Option<i64>,
    pub method: String,
    pub url: String,
    pub query: Vec<(String, String)>,
    pub path_params: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub auth: BruAuth,
    pub body: BruBody,
}

impl BruRequest {
    /// `.bru` 원문 → BruRequest.
    pub fn parse(input: &str) -> Self {
        let blocks = parse_blocks(input);
        let mut req = BruRequest {
            name: String::new(),
            seq: None,
            method: "get".into(),
            url: String::new(),
            query: vec![],
            path_params: vec![],
            headers: vec![],
            auth: BruAuth::None,
            body: BruBody::None,
        };
        let mut body_kind = "none".to_string();
        let mut auth_kind = "none".to_string();

        for b in &blocks {
            match b.name.as_str() {
                "meta" => {
                    for (k, v) in parse_dict(&b.inner) {
                        match k.as_str() {
                            "name" => req.name = v,
                            "seq" => req.seq = v.parse().ok(),
                            _ => {}
                        }
                    }
                }
                m @ ("get" | "post" | "put" | "delete" | "patch" | "head" | "options") => {
                    req.method = m.to_string();
                    for (k, v) in parse_dict(&b.inner) {
                        match k.as_str() {
                            "url" => req.url = v,
                            "body" => body_kind = v,
                            "auth" => auth_kind = v,
                            _ => {}
                        }
                    }
                }
                "params:query" => req.query = parse_dict(&b.inner),
                "params:path" => req.path_params = parse_dict(&b.inner),
                "headers" => req.headers = parse_dict(&b.inner),
                "auth:bearer" => {
                    for (k, v) in parse_dict(&b.inner) {
                        if k == "token" {
                            req.auth = BruAuth::Bearer(v);
                        }
                    }
                }
                "auth:basic" => {
                    let d: BTreeMap<_, _> = parse_dict(&b.inner).into_iter().collect();
                    req.auth = BruAuth::Basic {
                        username: d.get("username").cloned().unwrap_or_default(),
                        password: d.get("password").cloned().unwrap_or_default(),
                    };
                }
                "body:json" => req.body = BruBody::Json(dedent(&b.inner)),
                "body:text" => req.body = BruBody::Text(dedent(&b.inner)),
                "body:form-urlencoded" => req.body = BruBody::Form(parse_dict(&b.inner)),
                _ => {}
            }
        }

        // 명시 body/auth 블록이 없을 때 method 블록의 kind로 보정(정보용).
        let _ = (body_kind, auth_kind);
        req
    }

    /// BruRequest → 블록 목록.
    pub fn to_blocks(&self) -> Vec<BruBlock> {
        let mut blocks = Vec::new();

        // meta
        let mut meta = vec![("name".into(), self.name.clone()), ("type".into(), "http".into())];
        if let Some(seq) = self.seq {
            meta.push(("seq".into(), seq.to_string()));
        }
        blocks.push(BruBlock { name: "meta".into(), inner: dict_inner(&meta) });

        // method
        let body_kind = match &self.body {
            BruBody::None => "none",
            BruBody::Json(_) => "json",
            BruBody::Text(_) => "text",
            BruBody::Form(_) => "form-urlencoded",
        };
        let auth_kind = match &self.auth {
            BruAuth::None => "none",
            BruAuth::Bearer(_) => "bearer",
            BruAuth::Basic { .. } => "basic",
        };
        let method_dict = vec![
            ("url".into(), self.url.clone()),
            ("body".into(), body_kind.into()),
            ("auth".into(), auth_kind.into()),
        ];
        blocks.push(BruBlock { name: self.method.clone(), inner: dict_inner(&method_dict) });

        if !self.query.is_empty() {
            blocks.push(BruBlock { name: "params:query".into(), inner: dict_inner(&self.query) });
        }
        if !self.path_params.is_empty() {
            blocks.push(BruBlock { name: "params:path".into(), inner: dict_inner(&self.path_params) });
        }
        if !self.headers.is_empty() {
            blocks.push(BruBlock { name: "headers".into(), inner: dict_inner(&self.headers) });
        }
        match &self.auth {
            BruAuth::Bearer(t) => blocks.push(BruBlock {
                name: "auth:bearer".into(),
                inner: dict_inner(&[("token".into(), t.clone())]),
            }),
            BruAuth::Basic { username, password } => blocks.push(BruBlock {
                name: "auth:basic".into(),
                inner: dict_inner(&[
                    ("username".into(), username.clone()),
                    ("password".into(), password.clone()),
                ]),
            }),
            BruAuth::None => {}
        }
        match &self.body {
            BruBody::Json(s) => {
                blocks.push(BruBlock { name: "body:json".into(), inner: text_inner(s) })
            }
            BruBody::Text(s) => {
                blocks.push(BruBlock { name: "body:text".into(), inner: text_inner(s) })
            }
            BruBody::Form(kv) => {
                blocks.push(BruBlock { name: "body:form-urlencoded".into(), inner: dict_inner(kv) })
            }
            BruBody::None => {}
        }
        blocks
    }

    /// BruRequest → `.bru` 원문.
    pub fn serialize(&self) -> String {
        serialize_blocks(&self.to_blocks())
    }
}

// ─────────────────────────── HttpRequest 매핑 ───────────────────────────

/// Bruno 요청 → 우리 HTTP 클라이언트 요청(Try-it-out에서 실행).
pub fn bru_to_http(req: &BruRequest) -> HttpRequest {
    let body = match &req.body {
        BruBody::None => BodySpec::None,
        BruBody::Json(s) => match serde_json::from_str(s) {
            Ok(v) => BodySpec::Json { value: v },
            Err(_) => BodySpec::Text { value: s.clone() },
        },
        BruBody::Text(s) => BodySpec::Text { value: s.clone() },
        BruBody::Form(kv) => BodySpec::Form { value: kv.iter().cloned().collect() },
    };
    let auth = match &req.auth {
        BruAuth::None => AuthSpec::None,
        BruAuth::Bearer(t) => AuthSpec::Bearer { token: t.clone() },
        BruAuth::Basic { username, password } => {
            AuthSpec::Basic { username: username.clone(), password: password.clone() }
        }
    };
    HttpRequest {
        method: req.method.to_uppercase(),
        url: req.url.clone(),
        headers: req.headers.iter().cloned().collect(),
        query: req.query.iter().cloned().collect(),
        body,
        auth,
    }
}

/// 우리 HTTP 요청 → Bruno 요청(.bru로 저장).
pub fn http_to_bru(name: &str, seq: Option<i64>, req: &HttpRequest) -> BruRequest {
    let body = match &req.body {
        BodySpec::None => BruBody::None,
        BodySpec::Json { value } => {
            BruBody::Json(serde_json::to_string_pretty(value).unwrap_or_default())
        }
        BodySpec::Text { value } => BruBody::Text(value.clone()),
        BodySpec::Form { value } => BruBody::Form(value.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
    };
    let auth = match &req.auth {
        AuthSpec::None => BruAuth::None,
        AuthSpec::Bearer { token } => BruAuth::Bearer(token.clone()),
        AuthSpec::Basic { username, password } => {
            BruAuth::Basic { username: username.clone(), password: password.clone() }
        }
        AuthSpec::Apikey { name, value, .. } => {
            // .bru 표준 apikey 매핑은 생략 — 헤더로 강등.
            let mut headers: Vec<(String, String)> = req.headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            headers.push((name.clone(), value.clone()));
            return BruRequest {
                name: name.clone(),
                seq,
                method: req.method.to_lowercase(),
                url: req.url.clone(),
                query: req.query.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                path_params: vec![],
                headers,
                auth: BruAuth::None,
                body,
            };
        }
    };
    BruRequest {
        name: name.to_string(),
        seq,
        method: req.method.to_lowercase(),
        url: req.url.clone(),
        query: req.query.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        path_params: vec![],
        headers: req.headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        auth,
        body,
    }
}

// ─────────────────────────── 환경(.bru) ───────────────────────────

/// `environments/<Name>.bru`의 `vars { }` 블록을 Environment로.
pub fn parse_env(input: &str, id: &str, name: &str) -> Environment {
    let mut variables = BTreeMap::new();
    for b in parse_blocks(input) {
        if b.name == "vars" {
            for (k, v) in parse_dict(&b.inner) {
                variables.insert(k, v);
            }
        }
    }
    Environment { id: id.to_string(), name: name.to_string(), variables }
}

/// Environment → `vars { }` 블록 원문.
pub fn serialize_env(env: &Environment) -> String {
    let pairs: Vec<(String, String)> = env.variables.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    serialize_blocks(&[BruBlock { name: "vars".into(), inner: dict_inner(&pairs) }])
}

// ─────────────────────────── 컬렉션 → .bru 파일 트리 Export ───────────────────────────

use std::fs;
use std::path::{Path, PathBuf};

use openapiv3::{OpenAPI, Operation, Parameter, PathItem, ReferenceOr};

use crate::error::Result;

fn param_example(pd: &openapiv3::ParameterData) -> String {
    match &pd.example {
        Some(v) => v.as_str().map(String::from).unwrap_or_else(|| v.to_string()),
        None => String::new(),
    }
}

fn media_json_example(mt: &openapiv3::MediaType) -> Option<String> {
    if let Some(v) = &mt.example {
        return serde_json::to_string_pretty(v).ok();
    }
    for ex in mt.examples.values() {
        if let ReferenceOr::Item(e) = ex {
            if let Some(v) = &e.value {
                return serde_json::to_string_pretty(v).ok();
            }
        }
    }
    None
}

/// OpenAPI Operation → Bruno 요청.
pub fn operation_to_bru(name: &str, seq: i64, path: &str, method: &str, op: &Operation) -> BruRequest {
    let mut headers = Vec::new();
    let mut query = Vec::new();
    for p in &op.parameters {
        if let ReferenceOr::Item(param) = p {
            match param {
                Parameter::Header { parameter_data, .. } => {
                    headers.push((parameter_data.name.clone(), param_example(parameter_data)));
                }
                Parameter::Query { parameter_data, .. } => {
                    query.push((parameter_data.name.clone(), param_example(parameter_data)));
                }
                _ => {}
            }
        }
    }
    let body = op
        .request_body
        .as_ref()
        .and_then(|rb| match rb {
            ReferenceOr::Item(b) => b.content.get("application/json").and_then(media_json_example),
            _ => None,
        })
        .map(BruBody::Json)
        .unwrap_or(BruBody::None);

    BruRequest {
        name: name.to_string(),
        seq: Some(seq),
        method: method.to_lowercase(),
        url: format!("{{{{baseUrl}}}}{path}"),
        query,
        path_params: vec![],
        headers,
        auth: BruAuth::None,
        body,
    }
}

fn bru_methods(pi: &PathItem) -> Vec<(&'static str, Option<&Operation>)> {
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

fn bru_sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// 스펙 전체를 Bruno 컬렉션(`<root>/bruno/`)으로 Export. bruno.json + 폴더별 `.bru`.
pub fn export_collection(root: &Path, spec: &OpenAPI) -> Result<PathBuf> {
    let base = root.join("bruno");
    fs::create_dir_all(&base)?;

    let bruno = serde_json::json!({
        "version": "1",
        "name": spec.info.title,
        "type": "collection",
        "ignore": ["node_modules", ".git"],
    });
    fs::write(base.join("bruno.json"), serde_json::to_string_pretty(&bruno)?)?;

    // 환경은 spec에 없으므로 기본 하나 생성.
    let env_dir = base.join("environments");
    fs::create_dir_all(&env_dir)?;
    let mut default_env = std::collections::BTreeMap::new();
    default_env.insert("baseUrl".to_string(), "http://localhost:8080".to_string());
    let env = Environment { id: "Local".into(), name: "Local".into(), variables: default_env };
    fs::write(env_dir.join("Local.bru"), serialize_env(&env))?;

    let mut seq = 1i64;
    let mut paths: Vec<&String> = spec.paths.paths.keys().collect();
    paths.sort();
    for path in paths {
        let ReferenceOr::Item(pi) = &spec.paths.paths[path] else { continue };
        for (method, opo) in bru_methods(pi) {
            let Some(op) = opo else { continue };
            let folder = op.extensions.get("x-folder").and_then(|v| v.as_str()).unwrap_or("");
            let name = op
                .operation_id
                .clone()
                .unwrap_or_else(|| format!("{method}_{}", bru_sanitize(path)));
            let mut dir = base.clone();
            for s in folder.split('/').filter(|s| !s.is_empty()) {
                dir = dir.join(bru_sanitize(s));
            }
            fs::create_dir_all(&dir)?;
            let bru = operation_to_bru(&name, seq, path, method, op);
            fs::write(dir.join(format!("{}.bru", bru_sanitize(&name))), bru.serialize())?;
            seq += 1;
        }
    }
    Ok(base)
}

// ─────────────────────────── Import: Bruno 컬렉션 → OpenAPI ───────────────────────────

/// `.bru` 컬렉션 폴더를 해석한 결과(스펙 + 환경).
#[derive(Debug, serde::Serialize)]
pub struct BruImport {
    pub spec: serde_json::Value,
    pub environments: Vec<Environment>,
}

/// URL에서 경로만 추출. `{{baseUrl}}/x`→`/x`, `http://host/x?q`→`/x`.
fn url_to_path(url: &str) -> String {
    let u = url.trim();
    let after = if let Some(idx) = u.rfind("}}") {
        u[idx + 2..].to_string()
    } else if let Some(pos) = u.find("://") {
        let rest = &u[pos + 3..];
        match rest.find('/') {
            Some(s) => rest[s..].to_string(),
            None => "/".to_string(),
        }
    } else {
        u.to_string()
    };
    let path = after.split('?').next().unwrap_or(&after).trim();
    if path.is_empty() {
        "/".to_string()
    } else if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

/// 하위 폴더까지 `.bru` 요청 파일을 수집(environments/·메타파일 제외).
fn collect_bru_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let p = entry?.path();
        if p.is_dir() {
            if p.file_name().map(|n| n == "environments").unwrap_or(false) {
                continue; // 환경은 따로 처리
            }
            collect_bru_files(&p, out)?;
        } else if p.extension().map(|e| e.eq_ignore_ascii_case("bru")).unwrap_or(false) {
            let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if fname == "collection.bru" || fname == "folder.bru" {
                continue; // Bruno 메타 파일은 건너뜀
            }
            out.push(p);
        }
    }
    Ok(())
}

/// Bruno 컬렉션 폴더(`bruno.json`+`.bru` 트리)를 OpenAPI 스펙 + 환경으로 해석한다.
/// 폴더 구조 → `x-folder`, 요청 URL → path/method, 헤더·쿼리·본문 예시를 보존한다.
pub fn import_collection(root: &Path) -> Result<BruImport> {
    use std::collections::BTreeSet;
    use serde_json::{json, Map, Value};

    // 컬렉션 이름: bruno.json의 name > 폴더명.
    let name = fs::read_to_string(root.join("bruno.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
        .unwrap_or_else(|| {
            root.file_name().and_then(|n| n.to_str()).unwrap_or("Imported API").to_string()
        });

    let mut files = Vec::new();
    collect_bru_files(root, &mut files)?;
    files.sort();

    let mut paths: Map<String, Value> = Map::new();
    let mut folders: BTreeSet<String> = BTreeSet::new();

    for file in &files {
        let text = fs::read_to_string(file)?;
        let req = BruRequest::parse(&text);
        if req.url.trim().is_empty() {
            continue;
        }
        let path = url_to_path(&req.url);
        let method = if req.method.trim().is_empty() { "get".into() } else { req.method.to_lowercase() };

        // 파일 부모 폴더(root 기준 상대) → x-folder.
        let rel = file
            .parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .map(|p| {
                p.components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_default();

        // parameters(헤더/쿼리)
        let mut params: Vec<Value> = vec![];
        for (k, v) in &req.headers {
            params.push(json!({"name": k, "in": "header", "schema": {"type": "string"}, "example": v}));
        }
        for (k, v) in &req.query {
            params.push(json!({"name": k, "in": "query", "schema": {"type": "string"}, "example": v}));
        }

        let mut op = json!({"summary": req.name, "responses": {"200": {"description": "OK"}}});
        if !params.is_empty() {
            op["parameters"] = Value::Array(params);
        }
        match &req.body {
            BruBody::Json(s) => {
                let ex = serde_json::from_str::<Value>(s).unwrap_or_else(|_| Value::String(s.clone()));
                op["requestBody"] = json!({"content": {"application/json": {"example": ex}}});
            }
            BruBody::Text(s) => {
                op["requestBody"] = json!({"content": {"text/plain": {"example": s}}});
            }
            BruBody::Form(pairs) => {
                let mut o = Map::new();
                for (k, v) in pairs {
                    o.insert(k.clone(), Value::String(v.clone()));
                }
                op["requestBody"] = json!({"content": {"application/x-www-form-urlencoded": {"example": Value::Object(o)}}});
            }
            BruBody::None => {}
        }
        if !rel.is_empty() {
            op["x-folder"] = Value::String(rel.clone());
            let mut acc = String::new();
            for seg in rel.split('/').filter(|s| !s.is_empty()) {
                acc = if acc.is_empty() { seg.to_string() } else { format!("{acc}/{seg}") };
                folders.insert(acc.clone());
            }
        }

        let entry = paths.entry(path).or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(m) = entry {
            m.insert(method, op);
        }
    }

    // 환경: <root>/environments/*.bru
    let mut environments = vec![];
    let env_dir = root.join("environments");
    if env_dir.is_dir() {
        let mut env_files: Vec<PathBuf> = fs::read_dir(&env_dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|e| e.eq_ignore_ascii_case("bru")).unwrap_or(false))
            .collect();
        env_files.sort();
        for p in env_files {
            let text = fs::read_to_string(&p)?;
            let id = p.file_stem().and_then(|n| n.to_str()).unwrap_or("env").to_string();
            environments.push(parse_env(&text, &id, &id));
        }
    }

    let mut spec = json!({
        "openapi": "3.0.3",
        "info": { "title": name, "version": "1.0.0" },
        "paths": Value::Object(paths),
        "components": { "schemas": {} },
    });
    if !folders.is_empty() {
        spec["x-folders"] = Value::Array(folders.into_iter().map(Value::String).collect());
    }

    Ok(BruImport { spec, environments })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> BruRequest {
        BruRequest {
            name: "Create User".into(),
            seq: Some(1),
            method: "post".into(),
            url: "{{baseUrl}}/users".into(),
            query: vec![("page".into(), "1".into())],
            path_params: vec![],
            headers: vec![("Accept".into(), "application/json".into())],
            auth: BruAuth::Bearer("{{token}}".into()),
            body: BruBody::Json("{\n  \"email\": \"geo@colosseum.kr\"\n}".into()),
        }
    }

    #[test]
    fn import_collection_reads_exported_tree() {
        use openapiv3::OpenAPI;
        let dir = tempfile::tempdir().unwrap();
        // 스펙 → .bru 트리 export.
        let yaml = r#"
openapi: 3.0.3
info: { title: My Bruno, version: "1" }
paths:
  /user/login:
    post:
      summary: 로그인
      x-folder: 인증
      requestBody:
        content:
          application/json:
            example: { email: a@b.c }
      responses: { "200": { description: OK } }
  /ping:
    get: { summary: Ping, responses: { "200": { description: OK } } }
"#;
        let spec: OpenAPI = serde_yaml::from_str(yaml).unwrap();
        let base = export_collection(dir.path(), &spec).unwrap();

        // 다시 .bru 컬렉션 → 스펙으로 import.
        let imported = import_collection(&base).unwrap();
        let paths = imported.spec.get("paths").unwrap().as_object().unwrap();
        assert!(paths.contains_key("/user/login"), "경로 복원");
        assert!(paths.contains_key("/ping"), "루트 경로 복원");
        // 메서드·폴더·본문 예시 보존
        let login = &paths["/user/login"]["post"];
        assert_eq!(login["x-folder"], "인증");
        assert_eq!(login["requestBody"]["content"]["application/json"]["example"]["email"], "a@b.c");
        assert_eq!(imported.spec["info"]["title"], "My Bruno");
        // 환경(Local.bru) 로드
        assert!(imported.environments.iter().any(|e| e.variables.contains_key("baseUrl")));
    }

    #[test]
    fn request_roundtrips_through_bru_text() {
        let req = sample();
        let text = req.serialize();
        // Bruno 표준 블록이 나오는지 표면 검증
        assert!(text.contains("meta {"));
        assert!(text.contains("post {"));
        assert!(text.contains("body:json {"));
        // 왕복: 구조 동등
        let back = BruRequest::parse(&text);
        assert_eq!(req, back);
    }

    #[test]
    fn parses_real_bru_snippet() {
        let text = r#"
meta {
  name: Get User
  type: http
  seq: 2
}

get {
  url: {{baseUrl}}/users/{{id}}
  body: none
  auth: none
}

params:path {
  id: 1
}

headers {
  Accept: application/json
}
"#;
        let req = BruRequest::parse(text);
        assert_eq!(req.name, "Get User");
        assert_eq!(req.method, "get");
        assert_eq!(req.url, "{{baseUrl}}/users/{{id}}");
        assert_eq!(req.path_params, vec![("id".to_string(), "1".to_string())]);
        assert_eq!(req.headers, vec![("Accept".to_string(), "application/json".to_string())]);
    }

    #[test]
    fn http_bru_bridge() {
        let http = bru_to_http(&sample());
        assert_eq!(http.method, "POST");
        assert!(matches!(http.auth, AuthSpec::Bearer { .. }));
        assert!(matches!(http.body, BodySpec::Json { .. }));

        let back = http_to_bru("Create User", Some(1), &http);
        assert_eq!(back.method, "post");
        assert!(matches!(back.auth, BruAuth::Bearer(_)));
    }

    #[test]
    fn exports_bru_collection() {
        let yaml = r#"
openapi: 3.0.3
info: { title: Sample, version: "1" }
paths:
  /users:
    post:
      operationId: createUser
      x-folder: users
      requestBody:
        content:
          application/json:
            example: { email: geo@colosseum.kr }
      responses: { "201": { description: Created } }
"#;
        let spec: openapiv3::OpenAPI = serde_yaml::from_str(yaml).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let base = export_collection(dir.path(), &spec).unwrap();
        assert!(base.join("bruno.json").is_file());
        assert!(base.join("environments/Local.bru").is_file());
        assert!(base.join("users/createUser.bru").is_file());
        let bru = std::fs::read_to_string(base.join("users/createUser.bru")).unwrap();
        assert!(bru.contains("post {"));
        assert!(bru.contains("{{baseUrl}}/users"));
        assert!(bru.contains("body:json {"));
    }

    #[test]
    fn env_roundtrips() {
        let mut vars = BTreeMap::new();
        vars.insert("baseUrl".to_string(), "http://localhost:8080".to_string());
        let env = Environment { id: "local".into(), name: "Local".into(), variables: vars };
        let text = serialize_env(&env);
        assert!(text.contains("vars {"));
        let back = parse_env(&text, "local", "Local");
        assert_eq!(back.variables.get("baseUrl").unwrap(), "http://localhost:8080");
    }
}
