//! OpenAPI 문서 → GitHub-Flavored Markdown 생성 (F2).
//!
//! 순수 함수: 같은 입력·옵션이면 항상 같은 문자열(태그/경로/메서드 정렬 고정)을 낸다.
//! → 복사·git diff가 안정적.

use openapiv3::{OpenAPI, Operation, Parameter, ParameterData, PathItem, ReferenceOr, StatusCode};
use std::fmt::Write;

/// 마크다운 생성 옵션.
#[derive(Debug, Clone)]
pub struct MarkdownOptions {
    pub include_examples: bool,
    pub include_schemas: bool,
    /// 최상위 제목 레벨(1이면 `#`부터).
    pub heading_base_level: u8,
}

impl Default for MarkdownOptions {
    fn default() -> Self {
        Self { include_examples: true, include_schemas: true, heading_base_level: 1 }
    }
}

/// 문서를 마크다운 문자열로 변환.
pub fn to_markdown(spec: &OpenAPI, opts: &MarkdownOptions) -> String {
    let mut out = String::new();
    let h = |lvl: u8| "#".repeat((opts.heading_base_level + lvl - 1) as usize);

    // ── 헤더
    let _ = writeln!(out, "{} {}", h(1), spec.info.title);
    let _ = writeln!(out, "\n> 버전 `{}` · OpenAPI `{}`\n", spec.info.version, spec.openapi);
    if let Some(desc) = &spec.info.description {
        let _ = writeln!(out, "{desc}\n");
    }

    // ── 서버
    if !spec.servers.is_empty() {
        let _ = writeln!(out, "{} Servers\n", h(2));
        let _ = writeln!(out, "| URL | 설명 |");
        let _ = writeln!(out, "|-----|------|");
        for s in &spec.servers {
            let _ = writeln!(out, "| `{}` | {} |", s.url, s.description.clone().unwrap_or_default());
        }
        out.push('\n');
    }

    // ── Operation (path·method 정렬)
    let mut paths: Vec<&String> = spec.paths.paths.keys().collect();
    paths.sort();
    let _ = writeln!(out, "{} Endpoints\n", h(2));
    for path in paths {
        let ReferenceOr::Item(pi) = &spec.paths.paths[path] else { continue };
        for (method, op) in methods(pi) {
            let Some(op) = op else { continue };
            write_operation(&mut out, &h, path, method, op, opts);
        }
    }

    // ── 스키마 부록
    if opts.include_schemas {
        if let Some(comp) = &spec.components {
            if !comp.schemas.is_empty() {
                let _ = writeln!(out, "{} Schemas\n", h(2));
                let mut names: Vec<&String> = comp.schemas.keys().collect();
                names.sort();
                for name in names {
                    let _ = writeln!(out, "{} `{}`\n", h(3), name);
                    let json = serde_json::to_string_pretty(&comp.schemas[name]).unwrap_or_default();
                    let _ = writeln!(out, "```json\n{json}\n```\n");
                }
            }
        }
    }

    out
}

fn write_operation(
    out: &mut String,
    h: &impl Fn(u8) -> String,
    path: &str,
    method: &str,
    op: &Operation,
    opts: &MarkdownOptions,
) {
    // 메서드·경로는 있는 그대로(대소문자 보존). 강제 대문자 하지 않음.
    let _ = writeln!(out, "{} `{}` `{}`\n", h(3), method, path);
    if let Some(summary) = &op.summary {
        let _ = writeln!(out, "**{summary}**\n");
    }
    if let Some(desc) = &op.description {
        let _ = writeln!(out, "{desc}\n");
    }
    if !op.tags.is_empty() {
        let _ = writeln!(out, "태그: {}\n", op.tags.iter().map(|t| format!("`{t}`")).collect::<Vec<_>>().join(", "));
    }

    // 파라미터 — 헤더는 별도 섹션으로 분리.
    let all: Vec<&Parameter> = op
        .parameters
        .iter()
        .filter_map(|p| match p {
            ReferenceOr::Item(p) => Some(p),
            _ => None,
        })
        .collect();
    let non_header: Vec<&&Parameter> = all.iter().filter(|p| !matches!(p, Parameter::Header { .. })).collect();
    let header_params: Vec<&&Parameter> = all.iter().filter(|p| matches!(p, Parameter::Header { .. })).collect();

    if !non_header.is_empty() {
        let _ = writeln!(out, "{} Parameters\n", h(4));
        let _ = writeln!(out, "| 필드명 | 필드설명 | 타입 | 필수 |");
        let _ = writeln!(out, "|------|------|------|:---:|");
        for p in &non_header {
            let (_loc, data) = param_info(p);
            let _ = writeln!(
                out,
                "| `{}` | {} | {} | {} |",
                data.name,
                data.description.clone().unwrap_or_default().replace('\n', " "),
                param_type_str(p),
                if data.required { "✅" } else { "❌" }
            );
        }
        out.push('\n');
    }

    if !header_params.is_empty() {
        let _ = writeln!(out, "{} Headers\n", h(4));
        let _ = writeln!(out, "| 필드명 | 필드설명 | 타입 | 필수 |");
        let _ = writeln!(out, "|------|------|------|:---:|");
        for p in &header_params {
            let (_loc, data) = param_info(p);
            let _ = writeln!(
                out,
                "| `{}` | {} | {} | {} |",
                data.name,
                data.description.clone().unwrap_or_default().replace('\n', " "),
                param_type_str(p),
                if data.required { "✅" } else { "❌" }
            );
        }
        out.push('\n');
    }

    // 인증(Auth) — 스펙에 security가 있으면.
    if let Some(sec) = &op.security {
        if !sec.is_empty() {
            let _ = writeln!(out, "{} Auth\n", h(4));
            for req in sec {
                if req.is_empty() {
                    let _ = writeln!(out, "- (공개 / 인증 없음)");
                } else {
                    for (name, scopes) in req {
                        if scopes.is_empty() {
                            let _ = writeln!(out, "- `{name}`");
                        } else {
                            let _ = writeln!(out, "- `{name}` (scopes: {})", scopes.join(", "));
                        }
                    }
                }
            }
            out.push('\n');
        }
    }

    // Request Body — 필드 표 + 예시.
    if let Some(ReferenceOr::Item(body)) = &op.request_body {
        let _ = writeln!(out, "{} Request Body{}\n", h(4), if body.required { " *(필수)*" } else { "" });
        for (mt, media) in &body.content {
            if let Some(schema) = &media.schema {
                write_schema_fields(out, mt, schema, false); // 요청 = 필수
            }
            if opts.include_examples {
                if let Some(code) = media_example(media) {
                    let _ = writeln!(out, "예시 (`{mt}`):\n");
                    let _ = writeln!(out, "```json\n{code}\n```\n");
                }
            }
        }
    }

    // Responses 표 + 예시
    let _ = writeln!(out, "{} Responses\n", h(4));
    let _ = writeln!(out, "| 상태 | 설명 |");
    let _ = writeln!(out, "|------|------|");
    if let Some(ReferenceOr::Item(def)) = &op.responses.default {
        let _ = writeln!(out, "| default | {} |", def.description.replace('\n', " "));
    }
    for (code, r) in &op.responses.responses {
        if let ReferenceOr::Item(resp) = r {
            let _ = writeln!(out, "| {} | {} |", status_str(code), resp.description.replace('\n', " "));
        }
    }
    out.push('\n');

    // 상태코드별 응답 본문(필드 표 + 예시).
    for (code, r) in &op.responses.responses {
        if let ReferenceOr::Item(resp) = r {
            if resp.content.is_empty() {
                continue;
            }
            let _ = writeln!(out, "{} `{}` {}\n", h(5), status_str(code), resp.description.replace('\n', " "));
            for (mt, media) in &resp.content {
                if let Some(schema) = &media.schema {
                    write_schema_fields(out, mt, schema, true); // 응답 = Null(빈배열) 여부
                }
                if opts.include_examples {
                    if let Some(ex) = media_example(media) {
                        let _ = writeln!(out, "예시 (`{mt}`):\n");
                        let _ = writeln!(out, "```json\n{ex}\n```\n");
                    }
                }
            }
        }
    }
    let _ = writeln!(out, "---\n");
}

/// 스키마(object)의 속성을 필드 표로. 중첩(object/array<object>)이면 들여쓰기 트리로 재귀 렌더.
/// schema를 serde_json Value로 낮춰 안정적으로 읽는다.
fn write_schema_fields(out: &mut String, label: &str, schema: &ReferenceOr<openapiv3::Schema>, is_response: bool) {
    let v = serde_json::to_value(schema).unwrap_or_default();
    let mut rows: Vec<Field> = Vec::new();
    collect_fields(&v, "", true, &mut rows);
    if rows.is_empty() {
        return;
    }
    // 요청은 "필수"(required), 응답은 "Null(빈배열)"(required 아니면 null 가능).
    let last_col = if is_response { "Null(빈배열)" } else { "필수" };
    let _ = writeln!(out, "본문 필드 (`{label}`):\n");
    let _ = writeln!(out, "| 필드명 | 필드설명 | 타입 | {last_col} |");
    let _ = writeln!(out, "|------|------|------|:---:|");
    for f in rows {
        // 응답: null 가능 여부 = !required. 요청: 필수 여부 = required.
        let mark = if is_response {
            if f.req { "❌" } else { "✅" }
        } else if f.req { "✅" } else { "❌" };
        let _ = writeln!(
            out,
            "| {}`{}` | {} | {} | {} |",
            f.prefix, f.name, f.desc, f.ty, mark
        );
    }
    out.push('\n');
}

/// 필드 표 한 행. prefix는 중첩 트리 접두(├─ └─ │).
struct Field {
    prefix: String,
    name: String,
    ty: String,
    req: bool,
    desc: String,
}

/// object 스키마의 properties를 트리 접두를 붙여 필드 행으로 평탄화(재귀).
/// is_root면 최상위 필드(접두 없음), 그 하위부터 ├─/└─/│ 로 트리를 그린다.
fn collect_fields(v: &serde_json::Value, prefix: &str, is_root: bool, rows: &mut Vec<Field>) {
    let Some(props) = v.get("properties").and_then(|p| p.as_object()) else { return };
    let required: Vec<&str> = v
        .get("required")
        .and_then(|r| r.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    let n = props.len();
    for (i, (name, ps)) in props.iter().enumerate() {
        let is_last = i + 1 == n;
        // 표시 접두: 최상위는 없음, 하위는 마지막이면 └─ 아니면 ├─.
        let display_prefix = if is_root {
            String::new()
        } else if is_last {
            format!("{prefix}└─\u{00A0}")
        } else {
            format!("{prefix}├─\u{00A0}")
        };
        // 자식 이어짐 접두: 마지막이면 공백, 아니면 │.
        let child_prefix = if is_root {
            String::new()
        } else if is_last {
            format!("{prefix}\u{00A0}\u{00A0}\u{00A0}")
        } else {
            format!("{prefix}│\u{00A0}\u{00A0}")
        };

        let ty = type_label(ps);
        let req = required.contains(&name.as_str());
        let desc = ps.get("description").and_then(|d| d.as_str()).unwrap_or("").replace('\n', " ");
        rows.push(Field { prefix: display_prefix, name: name.clone(), ty, req, desc });

        // 중첩 재귀: object → properties, array<object> → items.properties
        if is_object(ps) {
            collect_fields(ps, &child_prefix, false, rows);
        } else if ps.get("type").and_then(|t| t.as_str()) == Some("array") {
            if let Some(items) = ps.get("items") {
                if is_object(items) {
                    collect_fields(items, &child_prefix, false, rows);
                }
            }
        }
    }
}

fn is_object(v: &serde_json::Value) -> bool {
    v.get("type").and_then(|t| t.as_str()) == Some("object")
        || (v.get("type").is_none() && v.get("properties").is_some())
}

/// 첫 글자 대문자(string→String).
fn cap_first(s: &str) -> String {
    let mut ch = s.chars();
    match ch.next() {
        Some(f) => f.to_uppercase().collect::<String>() + ch.as_str(),
        None => String::new(),
    }
}

/// 필드 타입 라벨(첫 글자 대문자): array는 `Array<Items타입>`으로 표기.
fn type_label(v: &serde_json::Value) -> String {
    match v.get("type").and_then(|t| t.as_str()) {
        Some("array") => {
            let inner = v
                .get("items")
                .map(|it| {
                    it.get("type")
                        .and_then(|t| t.as_str())
                        .map(String::from)
                        .unwrap_or_else(|| if it.get("properties").is_some() { "object".into() } else { "any".into() })
                })
                .unwrap_or_else(|| "any".into());
            format!("Array&lt;{}&gt;", cap_first(&inner))
        }
        Some(t) => cap_first(t),
        None => if v.get("properties").is_some() { "Object".into() } else { "-".into() },
    }
}

/// media type에서 대표 예시 하나를 pretty JSON으로. `example` 우선, 없으면 `examples`의 첫 값.
fn media_example(media: &openapiv3::MediaType) -> Option<String> {
    if let Some(v) = &media.example {
        return serde_json::to_string_pretty(v).ok();
    }
    for (_name, ex) in &media.examples {
        if let ReferenceOr::Item(e) = ex {
            if let Some(v) = &e.value {
                return serde_json::to_string_pretty(v).ok();
            }
        }
    }
    None
}

fn methods(pi: &PathItem) -> Vec<(&'static str, Option<&Operation>)> {
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

fn param_info(p: &Parameter) -> (&'static str, &ParameterData) {
    match p {
        Parameter::Query { parameter_data, .. } => ("query", parameter_data),
        Parameter::Header { parameter_data, .. } => ("header", parameter_data),
        Parameter::Path { parameter_data, .. } => ("path", parameter_data),
        Parameter::Cookie { parameter_data, .. } => ("cookie", parameter_data),
    }
}

/// 파라미터 타입(스키마 type, 첫 글자 대문자).
fn param_type_str(p: &Parameter) -> String {
    let v = serde_json::to_value(p).unwrap_or_default();
    let t = v.get("schema").and_then(|s| s.get("type")).and_then(|t| t.as_str()).unwrap_or("string");
    cap_first(t)
}

fn status_str(code: &StatusCode) -> String {
    match code {
        StatusCode::Code(n) => n.to_string(),
        StatusCode::Range(r) => format!("{r}XX"),
    }
}
