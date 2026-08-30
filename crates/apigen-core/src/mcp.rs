//! MCP(Model Context Protocol) 연결 — 선택(옵션) 통합.
//! stdio 전송으로 MCP 서버 프로세스를 띄우고 JSON-RPC 핸드셰이크(initialize → tools/list)를
//! 수행해 노출된 도구 목록을 가져온다. "연결 가능/도구 확인" 용도. (agent 루프는 별도 확장)
//!
//! 응답이 없을 때 커맨드가 영원히 멈추지 않도록 핸드셰이크를 워커 스레드에서 돌리고
//! 메인은 recv_timeout으로 대기, 초과 시 자식 프로세스를 kill 한다.

use crate::CoreError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Debug, Deserialize)]
pub struct McpServer {
    #[serde(default = "default_transport")]
    pub transport: String,      // 현재 "stdio"만 지원
    #[serde(default)]
    pub command: String,        // 실행 파일(예: "npx")
    #[serde(default)]
    pub args: Vec<String>,      // 인자(예: ["-y","@modelcontextprotocol/server-filesystem","/path"])
    #[serde(default)]
    pub env: Vec<(String, String)>, // 추가 환경변수
}
fn default_transport() -> String { "stdio".into() }

#[derive(Debug, Serialize)]
pub struct McpTool {
    pub name: String,
    pub description: String,
}

/// MCP 서버에 연결해 도구 목록을 반환. (기본 15초 타임아웃)
pub fn list_tools(s: McpServer) -> Result<Vec<McpTool>, CoreError> {
    if s.transport != "stdio" {
        return Err(CoreError::Http(format!("현재는 stdio 전송만 지원합니다(요청: {})", s.transport)));
    }
    if s.command.trim().is_empty() {
        return Err(CoreError::Http("실행할 command 가 비어 있습니다".into()));
    }

    let mut cmd = Command::new(&s.command);
    cmd.args(&s.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &s.env { cmd.env(k, v); }

    let mut child = cmd
        .spawn()
        .map_err(|e| CoreError::Http(format!("MCP 서버 실행 실패({}): {e}", s.command)))?;

    let mut stdin = child.stdin.take().ok_or_else(|| CoreError::Http("stdin 열기 실패".into()))?;
    let stdout = child.stdout.take().ok_or_else(|| CoreError::Http("stdout 열기 실패".into()))?;

    let (tx, rx) = mpsc::channel::<Result<Vec<McpTool>, CoreError>>();
    // 핸드셰이크는 워커 스레드에서(블로킹 read가 커맨드를 멈추지 않도록).
    std::thread::spawn(move || {
        let _ = tx.send(handshake(&mut stdin, stdout));
    });

    let out = match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(res) => res,
        Err(_) => Err(CoreError::Http("MCP 서버 응답 시간 초과(15초)".into())),
    };
    let _ = child.kill(); // 성공/실패/타임아웃 모두 정리
    let _ = child.wait();
    out
}

fn handshake(stdin: &mut std::process::ChildStdin, stdout: std::process::ChildStdout) -> Result<Vec<McpTool>, CoreError> {
    let mut reader = BufReader::new(stdout);

    // 1) initialize
    send(stdin, &json!({
        "jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2024-11-05",
            "capabilities":{},
            "clientInfo":{"name":"Plume","version":"0.1"}
        }
    }))?;
    let _init = read_response(&mut reader, 1)?;

    // 2) initialized 알림
    send(stdin, &json!({"jsonrpc":"2.0","method":"notifications/initialized"}))?;

    // 3) tools/list
    send(stdin, &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))?;
    let resp = read_response(&mut reader, 2)?;

    let tools = resp["result"]["tools"].as_array().cloned().unwrap_or_default();
    Ok(tools.iter().map(|t| McpTool {
        name: t["name"].as_str().unwrap_or("").to_string(),
        description: t["description"].as_str().unwrap_or("").to_string(),
    }).collect())
}

fn send(stdin: &mut std::process::ChildStdin, v: &Value) -> Result<(), CoreError> {
    let line = serde_json::to_string(v)?;
    stdin.write_all(line.as_bytes()).map_err(CoreError::Io)?;
    stdin.write_all(b"\n").map_err(CoreError::Io)?;
    stdin.flush().map_err(CoreError::Io)?;
    Ok(())
}

// id가 일치하는 JSON-RPC 응답을 만날 때까지 줄 단위로 읽는다(알림·다른 id는 건너뜀).
fn read_response(reader: &mut impl BufRead, id: i64) -> Result<Value, CoreError> {
    let mut line = String::new();
    for _ in 0..10_000 {
        line.clear();
        let n = reader.read_line(&mut line).map_err(CoreError::Io)?;
        if n == 0 { return Err(CoreError::Http("MCP 서버가 응답 전에 종료됨".into())); }
        let t = line.trim();
        if t.is_empty() { continue; }
        let Ok(v) = serde_json::from_str::<Value>(t) else { continue }; // 로그 등 비-JSON 줄 무시
        if v.get("id").and_then(|x| x.as_i64()) == Some(id) {
            if let Some(err) = v.get("error") {
                return Err(CoreError::Http(format!("MCP 오류: {err}")));
            }
            return Ok(v);
        }
    }
    Err(CoreError::Http("MCP 응답을 찾지 못했습니다".into()))
}
