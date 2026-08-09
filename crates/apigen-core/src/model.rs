//! 온디스크 파일 트리(§4.1)를 표현하는 serde 구조체들과 공용 진단(Diagnostic) 타입.
//!
//! 핵심 아이디어: 각 파일은 openapiv3의 조각을 거의 그대로 담는다.
//! `#[serde(flatten)]`으로 우리 메타(method/path/target 등)와 openapiv3 타입을
//! 한 YAML 문서 안에 평평하게 합친다.

use serde::{Deserialize, Serialize};

/// 검증/번들 과정에서 수집되는 문제 메시지. JSON Pointer 경로로 UI가 위치를 매핑한다.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: Severity,
    /// 문제 위치. 번들 문서 기준 JSON Pointer(예: `/paths/~1users/post`) 또는 파일 경로.
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

impl Diagnostic {
    pub fn warn(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self { severity: Severity::Warning, path: path.into(), message: message.into() }
    }
    pub fn error(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self { severity: Severity::Error, path: path.into(), message: message.into() }
    }
    pub fn info(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self { severity: Severity::Info, path: path.into(), message: message.into() }
    }
}

// ─────────────────────────── 파일별 스키마 ───────────────────────────

/// `project.yaml` — 문서 헤더(정보/서버/전역 보안).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFile {
    /// OAS 버전. 기본 "3.0.3".
    #[serde(default = "default_openapi_version")]
    pub openapi: String,
    pub info: openapiv3::Info,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub servers: Vec<openapiv3::Server>,
    /// Figma식 메모(코멘트) 목록. 루트 `x-comments`로 왕복하며 git으로 공유된다.
    #[serde(
        default,
        rename = "x-comments",
        skip_serializing_if = "serde_json::Value::is_null"
    )]
    pub x_comments: serde_json::Value,
    /// Specification 화면 자유 노트(문자열). 루트 `x-notes`로 왕복.
    #[serde(
        default,
        rename = "x-notes",
        skip_serializing_if = "serde_json::Value::is_null"
    )]
    pub x_notes: serde_json::Value,
    /// 컬렉션 레벨 Pre/Post 스크립트 + 폴더별 스크립트(공통 요청 로직).
    #[serde(default, rename = "x-pre-request-script", skip_serializing_if = "serde_json::Value::is_null")]
    pub x_pre_request_script: serde_json::Value,
    #[serde(default, rename = "x-post-response-script", skip_serializing_if = "serde_json::Value::is_null")]
    pub x_post_response_script: serde_json::Value,
    #[serde(default, rename = "x-folder-scripts", skip_serializing_if = "serde_json::Value::is_null")]
    pub x_folder_scripts: serde_json::Value,
}

fn default_openapi_version() -> String {
    "3.0.3".to_string()
}

/// `folders/<name>/_folder.yaml` — 폴더(=태그) 메타.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FolderFile {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// 이 폴더가 대응하는 OAS 태그. 없으면 디렉토리 이름을 태그로 쓴다.
    #[serde(default)]
    pub tag: Option<String>,
    /// UI 표시 순서.
    #[serde(default)]
    pub order: Option<i64>,
}

/// `folders/.../<request>/request.yaml` — Operation 하나.
/// method/path는 우리 필드, 나머지는 openapiv3::Operation을 flatten으로 흡수한다.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestFile {
    pub method: String,
    pub path: String,
    #[serde(flatten)]
    pub operation: openapiv3::Operation,
}

/// `.../examples/<name>.yaml` — named example 하나 + 부착 지점(target).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExampleFile {
    /// named-example 키.
    pub name: String,
    pub target: ExampleTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 인라인 예시 값.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    /// 외부 참조 예시.
    #[serde(rename = "externalValue", default, skip_serializing_if = "Option::is_none")]
    pub external_value: Option<String>,
}

/// 예시가 붙는 위치.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExampleTarget {
    #[serde(rename = "in")]
    pub location: ExampleIn,
    /// `response`일 때 상태코드(예: "200", "default").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// media type(예: "application/json"). 없으면 application/json 가정.
    #[serde(rename = "mediaType", default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExampleIn {
    Request,
    Response,
}
