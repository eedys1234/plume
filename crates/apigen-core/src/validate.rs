//! 스펙 검증 (구조 + 시맨틱). UI 배지용 Diagnostic 목록을 낸다.
//!
//! openapiv3의 타입 시스템이 이미 상당 부분(필수 필드 등)을 강제하므로,
//! 여기서는 타입만으로는 못 잡는 시맨틱 규칙을 확인한다.

use std::collections::HashMap;

use openapiv3::{OpenAPI, Operation, PathItem, ReferenceOr};

use crate::model::Diagnostic;

/// 문서를 검증해 진단 목록을 반환.
pub fn validate(spec: &OpenAPI) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    if spec.info.title.trim().is_empty() {
        diags.push(Diagnostic::error("/info/title", "title이 비어 있음"));
    }
    if spec.paths.paths.is_empty() {
        diags.push(Diagnostic::warn("/paths", "정의된 경로가 없음"));
    }

    // operationId 중복 검사 + path 형식 + 응답 존재
    let mut op_ids: HashMap<String, String> = HashMap::new();
    for (path, item) in &spec.paths.paths {
        if !path.starts_with('/') {
            diags.push(Diagnostic::error(format!("/paths/{path}"), "경로는 '/'로 시작해야 함"));
        }
        let ReferenceOr::Item(pi) = item else { continue };
        for (method, op) in methods(pi) {
            let Some(op) = op else { continue };
            let ptr = format!("/paths/{path}/{method}");

            if op.responses.responses.is_empty() && op.responses.default.is_none() {
                diags.push(Diagnostic::warn(&ptr, "응답(responses)이 하나도 없음"));
            }
            if let Some(id) = &op.operation_id {
                if let Some(prev) = op_ids.insert(id.clone(), ptr.clone()) {
                    diags.push(Diagnostic::error(
                        &ptr,
                        format!("operationId '{id}' 중복 (이전: {prev})"),
                    ));
                }
            }
            check_path_params(&ptr, path, op, &mut diags);
        }
    }

    diags
}

/// path에 있는 `{param}`이 parameters에 선언됐는지 확인.
fn check_path_params(ptr: &str, path: &str, op: &Operation, diags: &mut Vec<Diagnostic>) {
    let declared: Vec<String> = op
        .parameters
        .iter()
        .filter_map(|p| match p {
            ReferenceOr::Item(openapiv3::Parameter::Path { parameter_data, .. }) => {
                Some(parameter_data.name.clone())
            }
            _ => None,
        })
        .collect();

    for seg in path.split('/') {
        if let Some(name) = seg.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            if !declared.iter().any(|d| d == name) {
                diags.push(Diagnostic::warn(
                    ptr,
                    format!("경로 파라미터 '{{{name}}}'가 parameters에 선언되지 않음"),
                ));
            }
        }
    }
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
