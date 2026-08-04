//! HTTP API Client (F4) — `reqwest` blocking 기반.
//!
//! 브라우저 fetch가 아니라 Rust가 요청을 실행하므로 **CORS 제약이 없다.**
//! `{{var}}` 치환은 활성 Environment 변수로 코어에서 수행한다.

use std::collections::BTreeMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

/// HTTP Client 환경(변수 묶음). baseUrl/token 등을 담는다.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Environment {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
}

/// 한 번의 HTTP 요청 명세.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRequest {
    pub method: String,
    /// `{{baseUrl}}/users` 처럼 변수 포함 가능.
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    #[serde(default)]
    pub body: BodySpec,
    #[serde(default)]
    pub auth: AuthSpec,
}

/// 요청 본문. serde 내부 태그(`kind`)로 프론트와 형태를 맞춘다.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BodySpec {
    #[default]
    None,
    Json { value: serde_json::Value },
    Text { value: String },
    Form { value: BTreeMap<String, String> },
}

/// 인증 방식.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AuthSpec {
    #[default]
    None,
    Bearer { token: String },
    Basic { username: String, password: String },
    Apikey {
        #[serde(rename = "in")]
        location: String, // "header" | "query"
        name: String,
        value: String,
    },
}

/// 응답 결과(프론트로 그대로 직렬화).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_json: Option<serde_json::Value>,
    pub elapsed_ms: u128,
    pub size_bytes: usize,
}

/// `{{var}}`를 치환하고, 해결되지 않은 변수명 목록을 함께 반환.
pub fn substitute(input: &str, vars: &BTreeMap<String, String>) -> (String, Vec<String>) {
    let mut out = String::with_capacity(input.len());
    let mut unresolved = Vec::new();
    let mut rest = input;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        rest = &rest[start + 2..];
        if let Some(end) = rest.find("}}") {
            let name = rest[..end].trim();
            match vars.get(name) {
                Some(v) => out.push_str(v),
                None => {
                    unresolved.push(name.to_string());
                    out.push_str("{{");
                    out.push_str(name);
                    out.push_str("}}");
                }
            }
            rest = &rest[end + 2..];
        } else {
            out.push_str("{{");
        }
    }
    out.push_str(rest);
    (out, unresolved)
}

/// 요청을 실행한다. 미해결 변수가 있으면 에러.
pub fn send(req: &HttpRequest, env: &Environment) -> Result<HttpResponse> {
    let vars = &env.variables;

    let (url, mut unresolved) = substitute(&req.url, vars);
    if !unresolved.is_empty() {
        return Err(CoreError::Http(format!("미해결 변수: {}", unresolved.join(", "))));
    }

    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|e| CoreError::Http(format!("잘못된 메서드: {e}")))?;

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| CoreError::Http(e.to_string()))?;

    let mut rb = client.request(method, &url);

    // query
    let query: Vec<(String, String)> = req
        .query
        .iter()
        .map(|(k, v)| {
            let (val, u) = substitute(v, vars);
            unresolved.extend(u);
            (k.clone(), val)
        })
        .collect();
    if !query.is_empty() {
        rb = rb.query(&query);
    }

    // headers
    for (k, v) in &req.headers {
        let (val, u) = substitute(v, vars);
        unresolved.extend(u);
        rb = rb.header(k, val);
    }

    // auth
    rb = match &req.auth {
        AuthSpec::None => rb,
        AuthSpec::Bearer { token } => {
            let (t, u) = substitute(token, vars);
            unresolved.extend(u);
            rb.bearer_auth(t)
        }
        AuthSpec::Basic { username, password } => rb.basic_auth(username, Some(password)),
        AuthSpec::Apikey { location, name, value } => {
            let (v, u) = substitute(value, vars);
            unresolved.extend(u);
            if location == "query" {
                rb.query(&[(name, v)])
            } else {
                rb.header(name.as_str(), v)
            }
        }
    };

    // body
    rb = match &req.body {
        BodySpec::None => rb,
        BodySpec::Json { value } => rb.json(value),
        BodySpec::Text { value } => {
            let (t, u) = substitute(value, vars);
            unresolved.extend(u);
            rb.body(t)
        }
        BodySpec::Form { value } => rb.form(value),
    };

    if !unresolved.is_empty() {
        return Err(CoreError::Http(format!("미해결 변수: {}", unresolved.join(", "))));
    }

    let started = Instant::now();
    let resp = rb.send().map_err(|e| CoreError::Http(e.to_string()))?;
    let status = resp.status();

    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let body_text = resp.text().map_err(|e| CoreError::Http(e.to_string()))?;
    let elapsed_ms = started.elapsed().as_millis();
    let body_json = serde_json::from_str(&body_text).ok();

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        size_bytes: body_text.len(),
        headers,
        body_text,
        body_json,
        elapsed_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitutes_vars() {
        let mut vars = BTreeMap::new();
        vars.insert("baseUrl".to_string(), "http://x".to_string());
        let (out, un) = substitute("{{baseUrl}}/u/{{id}}", &vars);
        assert_eq!(out, "http://x/u/{{id}}");
        assert_eq!(un, vec!["id".to_string()]);
    }
}
