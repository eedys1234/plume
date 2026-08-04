//! 코어 전역 에러 타입.
//!
//! `thiserror`로 각 실패 원인을 하나의 열거형(`CoreError`)으로 모으고,
//! `?` 연산자가 하위 라이브러리 에러(std::io, serde 등)를 자동 변환하도록
//! `#[from]`을 붙였다. Tauri 경계로 넘길 때는 `AppError`(직렬화 가능)로 바꾼다.

use serde::Serialize;
use thiserror::Error;

/// 코어 내부에서 쓰는 에러. `#[from]` 덕분에 `foo()?`가 자동으로 이 타입으로 승격된다.
#[derive(Debug, Error)]
pub enum CoreError {
    #[error("입출력 오류: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON 파싱 오류: {0}")]
    Json(#[from] serde_json::Error),

    #[error("YAML 파싱 오류: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("HTTP 오류: {0}")]
    Http(String),

    #[error("스펙 오류: {0}")]
    Spec(String),

    #[error("프로젝트 구조 오류: {0}")]
    Project(String),
}

/// 코어 함수의 표준 반환 타입. `Result<T, CoreError>`의 축약.
pub type Result<T> = std::result::Result<T, CoreError>;

/// Tauri IPC로 프론트에 넘길 직렬화 가능한 에러 형태.
/// `CoreError`는 내부 타입(std::io::Error 등)을 품고 있어 직렬화가 안 되므로 이 형태로 변환한다.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl From<CoreError> for AppError {
    fn from(e: CoreError) -> Self {
        // 변형 이름을 안정적인 code로, Display 구현을 message로 사용.
        let code = match &e {
            CoreError::Io(_) => "io",
            CoreError::Json(_) => "json",
            CoreError::Yaml(_) => "yaml",
            CoreError::Http(_) => "http",
            CoreError::Spec(_) => "spec",
            CoreError::Project(_) => "project",
        };
        AppError { code: code.to_string(), message: e.to_string() }
    }
}
