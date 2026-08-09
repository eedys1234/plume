//! # apigen-core
//!
//! Tauri에 의존하지 않는 순수 OpenAPI 3.0 도메인 코어.
//! Tauri 어댑터(src-tauri)와 (추후) CLI가 이 크레이트를 공유한다.
//!
//! 주요 파이프라인:
//! - 파일 트리 ↔ 단일 문서: [`project::bundle`] / [`project::split`]
//! - 문서 → Markdown: [`markdown::to_markdown`]
//! - HTTP 실행: [`http::send`]
//! - 검증: [`validate::validate`]
//! - Import/Export: [`import_spec`] / [`export_spec`]

pub mod bru;
pub mod error;
pub mod git;
pub mod http;
pub mod load;
pub mod markdown;
pub mod model;
pub mod project;
pub mod postman;
pub mod publish;
pub mod snippet;
pub mod validate;

pub use error::{AppError, CoreError, Result};
// 어댑터/CLI가 openapiv3 타입을 별도 의존성 추가 없이 쓸 수 있게 재노출.
pub use openapiv3;

use openapiv3::OpenAPI;

/// 직렬화 포맷.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Json,
    Yaml,
}

/// 원문 문자열을 OpenAPI 문서로 파싱. `Auto`면 JSON을 먼저 시도하고 실패 시 YAML.
pub fn import_spec(text: &str, format: Option<Format>) -> Result<OpenAPI> {
    match format {
        Some(Format::Json) => Ok(serde_json::from_str(text)?),
        Some(Format::Yaml) => Ok(serde_yaml::from_str(text)?),
        None => {
            // auto: 트리밍 후 '{' 로 시작하면 JSON으로 가정.
            if text.trim_start().starts_with('{') {
                Ok(serde_json::from_str(text)?)
            } else {
                Ok(serde_yaml::from_str(text)?)
            }
        }
    }
}

/// 문서를 결정적 문자열로 직렬화.
pub fn export_spec(spec: &OpenAPI, format: Format) -> Result<String> {
    match format {
        Format::Json => Ok(serde_json::to_string_pretty(spec)?),
        Format::Yaml => Ok(serde_yaml::to_string(spec)?),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::{to_markdown, MarkdownOptions};
    use crate::project::{bundle, split};
    use std::fs;

    /// 최소 스펙 하나를 코드로 구성.
    fn sample_spec() -> OpenAPI {
        let yaml = r#"
openapi: 3.0.3
info:
  title: Sample API
  version: 1.0.0
paths:
  /users:
    post:
      operationId: createUser
      tags: [users]
      summary: Create a user
      requestBody:
        required: true
        content:
          application/json:
            examples:
              ok:
                summary: 정상 입력
                value:
                  email: geo@colosseum.kr
      responses:
        "201":
          description: Created
          content:
            application/json:
              examples:
                created:
                  value:
                    id: usr_1
components:
  schemas:
    User:
      type: object
      properties:
        id:
          type: string
"#;
        import_spec(yaml, Some(Format::Yaml)).expect("샘플 스펙 파싱")
    }

    #[test]
    fn import_export_roundtrip() {
        let spec = sample_spec();
        let json = export_spec(&spec, Format::Json).unwrap();
        let back = import_spec(&json, Some(Format::Json)).unwrap();
        assert_eq!(
            serde_json::to_value(&spec).unwrap(),
            serde_json::to_value(&back).unwrap()
        );
    }

    #[test]
    fn split_bundle_is_stable() {
        // split → bundle 을 두 번 돌려도 동일 문서가 나오는지(트리 왕복 불변식).
        let spec1 = sample_spec();
        let dir = tempfile::tempdir().unwrap();
        split(dir.path(), &spec1).unwrap();

        // 트리가 실제로 파일로 펼쳐졌는지 확인
        assert!(dir.path().join("project.yaml").is_file());
        assert!(dir.path().join("components/schemas/User.yaml").is_file());
        let req = dir.path().join("folders/users/createUser/request.yaml");
        assert!(req.is_file(), "request.yaml 이 생성되어야 함");
        // 예시가 별도 파일로 분리됐는지
        let ex_dir = dir.path().join("folders/users/createUser/examples");
        assert!(ex_dir.is_dir());
        assert!(fs::read_dir(&ex_dir).unwrap().count() >= 2, "요청/응답 예시 2개가 파일로 분리");

        let (bundled, warnings) = bundle(dir.path()).unwrap();
        assert!(warnings.is_empty(), "경고 없어야: {warnings:?}");

        // 다시 split → bundle → 첫 bundle과 동일(의미)해야 한다.
        let dir2 = tempfile::tempdir().unwrap();
        split(dir2.path(), &bundled).unwrap();
        let (bundled2, _) = bundle(dir2.path()).unwrap();

        assert_eq!(
            serde_json::to_value(&bundled).unwrap(),
            serde_json::to_value(&bundled2).unwrap(),
            "split∘bundle 은 안정적이어야 함"
        );
    }

    #[test]
    fn save_then_open_preserves_everything() {
        // 앱 흐름 재현: 저장(split) → 폴더 열기(bundle) → 요청 이름·폴더·예시 복원 확인.
        let dir = tempfile::tempdir().unwrap();
        split(dir.path(), &sample_spec()).unwrap(); // Ctrl+S / Export 상당
        // 파일이 실제로 디스크에 있어야 함
        assert!(dir.path().join("project.yaml").is_file());
        assert!(dir.path().join("folders/users/createUser/request.yaml").is_file());

        let (spec, warnings) = bundle(dir.path()).unwrap(); // 폴더 열기 상당
        assert!(warnings.is_empty());
        let post = spec.paths.paths["/users"].as_item().unwrap().post.as_ref().unwrap();
        // 요청 이름(summary)
        assert_eq!(post.summary.as_deref(), Some("Create a user"));
        // 폴더(x-folder)
        assert_eq!(post.extensions.get("x-folder").and_then(|v| v.as_str()), Some("users"));
        // 요청 본문 예시 + 응답 예시
        let rb = post.request_body.as_ref().unwrap().as_item().unwrap();
        assert!(rb.content["application/json"].examples.contains_key("ok"));
        let resp = post.responses.responses.values().next().unwrap().as_item().unwrap();
        assert!(!resp.content["application/json"].examples.is_empty());
    }

    #[test]
    fn bundle_attaches_example_and_folder() {
        let dir = tempfile::tempdir().unwrap();
        split(dir.path(), &sample_spec()).unwrap();
        let (spec, _) = bundle(dir.path()).unwrap();

        let post = spec.paths.paths["/users"].as_item().unwrap().post.as_ref().unwrap();
        // 폴더는 x-folder 확장으로 보존(태그와 독립)
        assert_eq!(
            post.extensions.get("x-folder").and_then(|v| v.as_str()),
            Some("users"),
            "x-folder 확장이 폴더 경로를 보존해야 함"
        );
        // 사용자가 준 태그는 그대로 유지
        assert!(post.tags.contains(&"users".to_string()));
        // 응답 예시 복원
        let resp = post.responses.responses.values().next().unwrap().as_item().unwrap();
        let media = resp.content.get("application/json").unwrap();
        assert!(!media.examples.is_empty(), "응답 예시가 복원되어야 함");
    }

    #[test]
    fn nested_folder_roundtrips() {
        // x-folder 중첩 경로가 디렉토리 구조로 왕복되는지.
        let mut spec = sample_spec();
        let openapiv3::ReferenceOr::Item(pi) = spec.paths.paths.get_mut("/users").unwrap() else {
            panic!("PathItem 이어야 함");
        };
        pi.post
            .as_mut()
            .unwrap()
            .extensions
            .insert("x-folder".into(), serde_json::json!("users/admin"));

        let dir = tempfile::tempdir().unwrap();
        split(dir.path(), &spec).unwrap();
        assert!(
            dir.path().join("folders/users/admin/createUser/request.yaml").is_file(),
            "중첩 폴더 디렉토리가 생성되어야 함"
        );
        let (back, _) = bundle(dir.path()).unwrap();
        let p = back.paths.paths["/users"].as_item().unwrap().post.as_ref().unwrap();
        assert_eq!(p.extensions.get("x-folder").and_then(|v| v.as_str()), Some("users/admin"));
    }

    #[test]
    fn empty_folder_persists_via_x_folders() {
        // 요청 없는 빈 폴더가 x-folders로 왕복 보존되는지.
        let mut spec = sample_spec();
        spec.extensions.insert("x-folders".into(), serde_json::json!(["archive/2026"]));

        let dir = tempfile::tempdir().unwrap();
        split(dir.path(), &spec).unwrap();
        // 빈 폴더(및 상위)가 _folder.yaml 마커로 디스크에 남아야 함
        assert!(dir.path().join("folders/archive/_folder.yaml").is_file());
        assert!(dir.path().join("folders/archive/2026/_folder.yaml").is_file());

        let (back, _) = bundle(dir.path()).unwrap();
        let names: Vec<String> = back
            .extensions
            .get("x-folders")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        assert!(names.contains(&"archive".to_string()), "빈 폴더 보존: {names:?}");
        assert!(names.contains(&"archive/2026".to_string()), "중첩 빈 폴더 보존: {names:?}");
        assert!(names.contains(&"users".to_string()), "요청 있는 폴더도 포함: {names:?}");
    }

    #[test]
    fn client_config_roundtrips() {
        use crate::http::Environment;
        use crate::project::{load_client, save_client, ClientConfig};
        use std::collections::BTreeMap;

        let dir = tempfile::tempdir().unwrap();
        let mut vars = BTreeMap::new();
        vars.insert("baseUrl".to_string(), "http://localhost:8080".to_string());
        let cfg = ClientConfig {
            environments: vec![Environment { id: "local".into(), name: "Local".into(), variables: vars }],
            active_environment_id: "local".into(),
        };
        save_client(dir.path(), &cfg).unwrap();
        assert!(dir.path().join("environments/local.yaml").is_file());
        assert!(dir.path().join(".apigen/config.yaml").is_file());

        let loaded = load_client(dir.path()).unwrap();
        assert_eq!(loaded.active_environment_id, "local");
        assert_eq!(loaded.environments.len(), 1);
        assert_eq!(loaded.environments[0].variables.get("baseUrl").unwrap(), "http://localhost:8080");
    }

    #[test]
    fn split_removes_deleted_requests_and_folders() {
        let dir = tempfile::tempdir().unwrap();
        // 요청 2개(+폴더) 저장.
        let two = r#"
openapi: 3.0.3
info: { title: T, version: "1" }
x-folders: ["users", "temp"]
paths:
  /a:
    get: { summary: A, x-folder: users, responses: { "200": { description: ok } } }
  /b:
    get: { summary: B, x-folder: temp, responses: { "200": { description: ok } } }
"#;
        split(dir.path(), &import_spec(two, Some(Format::Yaml)).unwrap()).unwrap();

        // /b와 temp 폴더를 삭제한 상태로 다시 저장(삭제 시뮬레이션).
        let one = r#"
openapi: 3.0.3
info: { title: T, version: "1" }
x-folders: ["users"]
paths:
  /a:
    get: { summary: A, x-folder: users, responses: { "200": { description: ok } } }
"#;
        split(dir.path(), &import_spec(one, Some(Format::Yaml)).unwrap()).unwrap();

        // 다시 열면 삭제된 /b가 되살아나면 안 된다.
        let (bundled, _) = bundle(dir.path()).unwrap();
        assert!(bundled.paths.paths.contains_key("/a"), "/a는 남아야");
        assert!(!bundled.paths.paths.contains_key("/b"), "삭제된 /b가 되살아나면 안 됨");
        // temp 폴더 마커도 사라져야.
        assert!(!dir.path().join("folders/temp").exists(), "삭제된 폴더 디렉터리가 남으면 안 됨");
    }

    #[test]
    fn workspace_multi_collection_roundtrip() {
        // save_workspace_collections / load_workspace_collections 의 코어 로직(collections/<이름>/) 재현.
        let ws = tempfile::tempdir().unwrap();
        let base = ws.path().join("collections");

        let a = import_spec(
            "openapi: 3.0.3\ninfo: { title: A, version: \"1\" }\npaths:\n  /a:\n    get: { summary: ga, responses: { \"200\": { description: ok } } }\n",
            Some(Format::Yaml),
        ).unwrap();
        let b = import_spec(
            "openapi: 3.0.3\ninfo: { title: B, version: \"1\" }\nx-folders: [grp]\npaths:\n  /b:\n    post: { summary: pb, x-folder: grp, responses: { \"200\": { description: ok } } }\n  /root:\n    get: { summary: r, responses: { \"200\": { description: ok } } }\n",
            Some(Format::Yaml),
        ).unwrap();

        // 저장
        split(&base.join("A"), &a).unwrap();
        split(&base.join("B"), &b).unwrap();

        // 불러오기: collections/* 를 bundle
        let mut dirs: Vec<_> = std::fs::read_dir(&base).unwrap().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        let mut names = vec![];
        let mut total = 0;
        for p in &dirs {
            let (spec, _w) = bundle(p).unwrap();
            names.push(p.file_name().unwrap().to_string_lossy().to_string());
            total += spec.paths.paths.len();
        }
        assert_eq!(names, vec!["A", "B"], "두 컬렉션 디렉터리가 로드돼야");
        assert_eq!(total, 3, "A의 /a + B의 /b,/root 모두 로드돼야 (저장한 요청 유실 없음)");
    }

    #[test]
    fn comments_survive_split_bundle() {
        // 루트 x-comments(메모)가 split→bundle 왕복에서 보존되는지.
        let spec = import_spec(
            "openapi: 3.0.3\ninfo: { title: C, version: \"1\" }\npaths:\n  /c:\n    get: { summary: gc, responses: { \"200\": { description: ok } } }\n",
            Some(Format::Yaml),
        ).unwrap();
        let mut spec = spec;
        spec.extensions.insert(
            "x-comments".to_string(),
            serde_json::json!([{
                "id": "c_1", "path": "/c", "method": "get",
                "author": "geo", "body": "확인 필요", "createdAt": "2026-01-01T00:00:00Z"
            }]),
        );

        let dir = tempfile::tempdir().unwrap();
        split(dir.path(), &spec).unwrap();
        let (loaded, _w) = bundle(dir.path()).unwrap();

        let cm = loaded.extensions.get("x-comments").expect("x-comments 보존돼야");
        assert_eq!(cm[0]["body"], serde_json::json!("확인 필요"));
        assert_eq!(cm[0]["path"], serde_json::json!("/c"));
    }

    #[test]
    fn notes_survive_split_bundle() {
        // 루트 x-notes(Specification 노트)가 split→bundle 왕복에서 보존되는지.
        let mut spec = import_spec(
            "openapi: 3.0.3\ninfo: { title: N, version: \"1\" }\npaths:\n  /n:\n    get: { responses: { \"200\": { description: ok } } }\n",
            Some(Format::Yaml),
        ).unwrap();
        spec.extensions.insert("x-notes".to_string(), serde_json::json!("배포 전 확인 메모"));

        let dir = tempfile::tempdir().unwrap();
        split(dir.path(), &spec).unwrap();
        let (loaded, _w) = bundle(dir.path()).unwrap();

        assert_eq!(loaded.extensions.get("x-notes"), Some(&serde_json::json!("배포 전 확인 메모")));
    }

    #[test]
    fn markdown_contains_endpoint() {
        let md = to_markdown(&sample_spec(), &MarkdownOptions::default());
        assert!(md.contains("# Sample API"));
        assert!(md.contains("`post` `/users`")); // 메서드는 있는 그대로(대소문자 보존)
        assert!(md.contains("Create a user"));
        // 정보 섹션이 상위 Docs MD에 모여야 한다.
        assert!(md.contains("#### Request Body"));
        assert!(md.contains("*(필수)*"));
        assert!(md.contains("#### Responses"));
    }

    #[test]
    fn markdown_renders_nested_fields_and_per_status_responses() {
        let yaml = r#"
openapi: 3.0.3
info: { title: T, version: "1" }
paths:
  /order:
    post:
      summary: 주문
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [user]
              properties:
                user:
                  type: object
                  properties:
                    name: { type: string, description: 이름 }
                    tags: { type: array, items: { type: string } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
        "400":
          description: Bad Request
          content:
            application/json:
              schema:
                type: object
                properties:
                  message: { type: string }
"#;
        let spec = import_spec(yaml, Some(Format::Yaml)).unwrap();
        let md = to_markdown(&spec, &MarkdownOptions::default());
        // 중첩 필드가 들여쓰기 트리(└)로, 타입은 첫 글자 대문자.
        assert!(md.contains("`user`"), "top object field");
        assert!(md.contains("└"), "nested field tree indent");
        assert!(md.contains("`name`"), "nested field present");
        assert!(md.contains("Array&lt;String&gt;"), "array item type label capitalized");
        // 헤더/순서: 필드명 · 필드설명 · 타입 · 필수
        assert!(md.contains("| 필드명 | 필드설명 | 타입 | 필수 |"), "field table header/order");
        // 상태코드별 응답 본문 섹션.
        assert!(md.contains("##### `200`"), "200 response section");
        assert!(md.contains("##### `400`"), "400 response section");
        assert!(md.contains("`message`"), "400 response field");
    }

    #[test]
    fn validate_flags_duplicate_operation_id() {
        let yaml = r#"
openapi: 3.0.3
info: { title: T, version: "1" }
paths:
  /a:
    get: { operationId: dup, responses: { "200": { description: ok } } }
  /b:
    get: { operationId: dup, responses: { "200": { description: ok } } }
"#;
        let spec = import_spec(yaml, Some(Format::Yaml)).unwrap();
        let diags = validate::validate(&spec);
        assert!(diags.iter().any(|d| d.message.contains("operationId 'dup' 중복")));
    }
}
