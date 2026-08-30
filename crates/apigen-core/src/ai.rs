//! 멀티 제공자 LLM 연동(로컬 Ollama · OpenAI/ChatGPT · Anthropic/Claude).
//! 프론트에서 provider/base_url/api_key/model + 프롬프트를 넘기면 백엔드(reqwest blocking)가
//! 각 제공자의 채팅 API 형식에 맞춰 호출하고 응답 텍스트만 돌려준다. (웹뷰 CORS 회피)

use crate::CoreError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Deserialize)]
pub struct AiChatArgs {
    pub provider: String,      // "ollama" | "openai" | "anthropic"
    #[serde(default)]
    pub base_url: String,      // 비면 제공자 기본값
    #[serde(default)]
    pub api_key: String,       // ollama는 불필요
    pub model: String,
    #[serde(default)]
    pub system: String,        // 시스템 프롬프트(선택)
    pub prompt: String,        // 사용자 입력
}

fn client() -> Result<reqwest::blocking::Client, CoreError> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| CoreError::Http(format!("HTTP 클라이언트 생성 실패: {e}")))
}

fn trim_base(base: &str, default: &str) -> String {
    let b = if base.trim().is_empty() { default } else { base.trim() };
    b.trim_end_matches('/').to_string()
}

/// 한 번의 채팅 완성. 성공 시 모델의 응답 텍스트를 반환.
pub fn ai_complete(a: AiChatArgs) -> Result<String, CoreError> {
    let c = client()?;
    match a.provider.as_str() {
        "ollama" => {
            let url = format!("{}/api/chat", trim_base(&a.base_url, "http://localhost:11434"));
            let mut messages = Vec::new();
            if !a.system.is_empty() { messages.push(json!({"role":"system","content":a.system})); }
            messages.push(json!({"role":"user","content":a.prompt}));
            let body = json!({"model": a.model, "messages": messages, "stream": false});
            let (status, text) = post(&c, &url, None, &body)?;
            if !status { return Err(CoreError::Http(format!("Ollama 오류: {text}"))); }
            let v: Value = parse(&text, "Ollama")?;
            Ok(v["message"]["content"].as_str().unwrap_or("").to_string())
        }
        "openai" => {
            let url = format!("{}/v1/chat/completions", trim_base(&a.base_url, "https://api.openai.com"));
            let mut messages = Vec::new();
            if !a.system.is_empty() { messages.push(json!({"role":"system","content":a.system})); }
            messages.push(json!({"role":"user","content":a.prompt}));
            let body = json!({"model": a.model, "messages": messages});
            let (status, text) = post(&c, &url, Some(("Authorization", format!("Bearer {}", a.api_key))), &body)?;
            if !status { return Err(CoreError::Http(format!("OpenAI 오류: {text}"))); }
            let v: Value = parse(&text, "OpenAI")?;
            Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
        }
        "anthropic" => {
            let url = format!("{}/v1/messages", trim_base(&a.base_url, "https://api.anthropic.com"));
            let body = json!({
                "model": a.model,
                "max_tokens": 4096,
                "system": a.system,
                "messages": [{"role":"user","content":a.prompt}],
            });
            // Anthropic은 x-api-key + anthropic-version 헤더 사용.
            let resp = c.post(&url)
                .header("x-api-key", a.api_key.as_str())
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .map_err(|e| CoreError::Http(format!("요청 실패: {e}")))?;
            let ok = resp.status().is_success();
            let text = resp.text().map_err(|e| CoreError::Http(format!("응답 읽기 실패: {e}")))?;
            if !ok { return Err(CoreError::Http(format!("Anthropic 오류: {text}"))); }
            let v: Value = parse(&text, "Anthropic")?;
            Ok(v["content"][0]["text"].as_str().unwrap_or("").to_string())
        }
        other => Err(CoreError::Http(format!("알 수 없는 provider: {other}"))),
    }
}

// (성공여부, 본문텍스트) 반환. 헤더 하나(선택) 지정 가능.
fn post(
    c: &reqwest::blocking::Client,
    url: &str,
    auth: Option<(&str, String)>,
    body: &Value,
) -> Result<(bool, String), CoreError> {
    let mut req = c.post(url).json(body);
    if let Some((k, v)) = auth { req = req.header(k, v); }
    let resp = req.send().map_err(|e| CoreError::Http(format!("요청 실패: {e}")))?;
    let ok = resp.status().is_success();
    let text = resp.text().map_err(|e| CoreError::Http(format!("응답 읽기 실패: {e}")))?;
    Ok((ok, text))
}

fn parse(text: &str, who: &str) -> Result<Value, CoreError> {
    serde_json::from_str(text).map_err(|e| CoreError::Http(format!("{who} 응답 파싱 실패: {e} · {text}")))
}
