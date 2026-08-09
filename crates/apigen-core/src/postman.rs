//! Postman Collection v2.1 코덱 — import(컬렉션·환경) / export(컬렉션).
//!
//! Postman 구조: `info` + `item[]`(폴더는 자체 `item[]`을 가진 트리). 요청은 `request`
//! (method/url/header/body). 여기서는 우리 내부 스펙(OpenAPI 3.0 유사 JSON Value)과
//! Environment로 왕복한다. 폴더는 `x-folder`, 빈 폴더는 `x-folders`로 보존.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::bru::url_to_path;
use crate::error::Result;
use crate::http::Environment;

// ─────────────────────────── Import ───────────────────────────

/// Postman Collection(JSON) → 내부 스펙 Value.
pub fn import_collection(text: &str) -> Result<Value> {
    let root: Value = serde_json::from_str(text)?;

    let name = root
        .get("info")
        .and_then(|i| i.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("Postman Import")
        .to_string();

    let mut paths: Map<String, Value> = Map::new();
    let mut folders: BTreeSet<String> = BTreeSet::new();
    if let Some(items) = root.get("item").and_then(|i| i.as_array()) {
        walk_items(items, "", &mut paths, &mut folders);
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
    Ok(spec)
}

fn walk_items(items: &[Value], folder: &str, paths: &mut Map<String, Value>, folders: &mut BTreeSet<String>) {
    for it in items {
        // 폴더(자식 item 보유)
        if let Some(sub) = it.get("item").and_then(|v| v.as_array()) {
            let fname = it.get("name").and_then(|n| n.as_str()).unwrap_or("folder");
            let fpath = if folder.is_empty() { fname.to_string() } else { format!("{folder}/{fname}") };
            let mut acc = String::new();
            for seg in fpath.split('/').filter(|s| !s.is_empty()) {
                acc = if acc.is_empty() { seg.to_string() } else { format!("{acc}/{seg}") };
                folders.insert(acc.clone());
            }
            walk_items(sub, &fpath, paths, folders);
            continue;
        }
        // 요청
        let Some(req) = it.get("request") else { continue };
        let name = it.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
        let method = req
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or("GET")
            .to_lowercase();
        let url = postman_url_raw(req.get("url"));
        if url.trim().is_empty() {
            continue;
        }
        let path = url_to_path(&url);

        // 파라미터: 헤더 + 쿼리
        let mut params: Vec<Value> = vec![];
        if let Some(hs) = req.get("header").and_then(|h| h.as_array()) {
            for h in hs {
                if h.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false) {
                    continue;
                }
                let k = h.get("key").and_then(|v| v.as_str()).unwrap_or("");
                let v = h.get("value").and_then(|v| v.as_str()).unwrap_or("");
                if !k.is_empty() {
                    params.push(json!({"name": k, "in": "header", "schema": {"type": "string"}, "example": v}));
                }
            }
        }
        if let Some(q) = req.get("url").and_then(|u| u.get("query")).and_then(|q| q.as_array()) {
            for it in q {
                if it.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false) {
                    continue;
                }
                let k = it.get("key").and_then(|v| v.as_str()).unwrap_or("");
                let v = it.get("value").and_then(|v| v.as_str()).unwrap_or("");
                if !k.is_empty() {
                    params.push(json!({"name": k, "in": "query", "schema": {"type": "string"}, "example": v}));
                }
            }
        }

        let mut op = json!({"summary": name, "responses": {"200": {"description": "OK"}}});
        if !params.is_empty() {
            op["parameters"] = Value::Array(params);
        }

        // 본문
        if let Some(body) = req.get("body") {
            let mode = body.get("mode").and_then(|m| m.as_str()).unwrap_or("");
            match mode {
                "raw" => {
                    let raw = body.get("raw").and_then(|r| r.as_str()).unwrap_or("");
                    if !raw.trim().is_empty() {
                        match serde_json::from_str::<Value>(raw) {
                            Ok(j) => op["requestBody"] = json!({"content": {"application/json": {"example": j}}}),
                            Err(_) => op["requestBody"] = json!({"content": {"text/plain": {"example": raw}}}),
                        }
                    }
                }
                "urlencoded" => {
                    let mut o = Map::new();
                    if let Some(arr) = body.get("urlencoded").and_then(|u| u.as_array()) {
                        for kv in arr {
                            let k = kv.get("key").and_then(|v| v.as_str()).unwrap_or("");
                            let v = kv.get("value").and_then(|v| v.as_str()).unwrap_or("");
                            if !k.is_empty() {
                                o.insert(k.to_string(), Value::String(v.to_string()));
                            }
                        }
                    }
                    if !o.is_empty() {
                        op["requestBody"] = json!({"content": {"application/x-www-form-urlencoded": {"example": Value::Object(o)}}});
                    }
                }
                _ => {}
            }
        }

        if !folder.is_empty() {
            op["x-folder"] = Value::String(folder.to_string());
        }

        // 충돌 방지: 같은 path+method면 접미사.
        let mut final_path = path.clone();
        let mut n = 2;
        while paths.get(&final_path).and_then(|m| m.get(method.as_str())).is_some() {
            final_path = format!("{path}-{n}");
            n += 1;
        }
        let entry = paths.entry(final_path).or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(m) = entry {
            m.insert(method.clone(), op);
        }
    }
}

/// Postman url(문자열 또는 {raw,...}) → raw 문자열.
fn postman_url_raw(url: Option<&Value>) -> String {
    match url {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o
            .get("raw")
            .and_then(|r| r.as_str())
            .map(String::from)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// Postman Environment(JSON, `values:[{key,value,enabled}]`) → Environment.
pub fn import_environment(text: &str, id: &str) -> Result<Environment> {
    let root: Value = serde_json::from_str(text)?;
    let name = root
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or(id)
        .to_string();
    let mut variables = BTreeMap::new();
    if let Some(vals) = root.get("values").and_then(|v| v.as_array()) {
        for v in vals {
            if v.get("enabled").and_then(|e| e.as_bool()) == Some(false) {
                continue;
            }
            let k = v.get("key").and_then(|k| k.as_str()).unwrap_or("");
            let val = v.get("value").and_then(|v| v.as_str()).unwrap_or("");
            if !k.is_empty() {
                variables.insert(k.to_string(), val.to_string());
            }
        }
    }
    Ok(Environment { id: id.to_string(), name, variables })
}

// ─────────────────────────── Export ───────────────────────────

/// 내부 스펙 Value → Postman Collection(JSON Value). x-folder로 폴더 트리를 구성.
pub fn export_collection(spec: &Value) -> Value {
    let title = spec
        .get("info")
        .and_then(|i| i.get("title"))
        .and_then(|t| t.as_str())
        .unwrap_or("API")
        .to_string();

    // 폴더 경로 → item 배열(가변). "" = 루트.
    let mut tree: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    tree.insert(String::new(), vec![]);

    if let Some(paths) = spec.get("paths").and_then(|p| p.as_object()) {
        for (path, methods) in paths {
            let Some(mobj) = methods.as_object() else { continue };
            for (method, op) in mobj {
                if !is_http_method(method) {
                    continue;
                }
                let folder = op.get("x-folder").and_then(|f| f.as_str()).unwrap_or("").to_string();
                let name = op
                    .get("summary")
                    .and_then(|s| s.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .unwrap_or_else(|| format!("{} {}", method.to_uppercase(), path));
                let item = build_postman_request(&name, method, path, op);
                tree.entry(folder).or_default().push(item);
            }
        }
    }

    let root_items = assemble_tree(&tree);
    json!({
        "info": {
            "name": title,
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
        },
        "item": root_items
    })
}

fn is_http_method(m: &str) -> bool {
    matches!(m, "get" | "post" | "put" | "delete" | "patch" | "head" | "options")
}

fn build_postman_request(name: &str, method: &str, path: &str, op: &Value) -> Value {
    let raw = format!("{{{{baseUrl}}}}{path}");
    let mut header = vec![];
    let mut query = vec![];
    if let Some(params) = op.get("parameters").and_then(|p| p.as_array()) {
        for p in params {
            let loc = p.get("in").and_then(|i| i.as_str()).unwrap_or("");
            let pname = p.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let example = p.get("example").and_then(|e| e.as_str()).unwrap_or("");
            if pname.is_empty() {
                continue;
            }
            if loc == "header" {
                header.push(json!({"key": pname, "value": example}));
            } else if loc == "query" {
                query.push(json!({"key": pname, "value": example}));
            }
        }
    }

    let mut request = json!({
        "method": method.to_uppercase(),
        "header": header,
        "url": {
            "raw": raw,
            "host": ["{{baseUrl}}"],
            "path": path.trim_start_matches('/').split('/').filter(|s| !s.is_empty()).collect::<Vec<_>>(),
        }
    });
    if !query.is_empty() {
        request["url"]["query"] = Value::Array(query);
    }

    // requestBody example → raw json 본문.
    if let Some(content) = op.get("requestBody").and_then(|b| b.get("content")).and_then(|c| c.as_object()) {
        if let Some(jsonmt) = content.get("application/json").and_then(|m| m.get("example")) {
            request["body"] = json!({
                "mode": "raw",
                "raw": serde_json::to_string_pretty(jsonmt).unwrap_or_default(),
                "options": { "raw": { "language": "json" } }
            });
        }
    }

    json!({ "name": name, "request": request })
}

/// 폴더 트리(경로→items)를 Postman 중첩 item 배열로 조립.
fn assemble_tree(tree: &BTreeMap<String, Vec<Value>>) -> Vec<Value> {
    // 각 폴더의 직속 하위 폴더 이름을 모은다.
    fn children_of<'a>(tree: &'a BTreeMap<String, Vec<Value>>, prefix: &str) -> BTreeSet<String> {
        let mut set = BTreeSet::new();
        for key in tree.keys() {
            if key.is_empty() {
                continue;
            }
            let (parent, child) = match key.rfind('/') {
                Some(i) => (key[..i].to_string(), key[i + 1..].to_string()),
                None => (String::new(), key.clone()),
            };
            if parent == prefix {
                set.insert(child);
            }
        }
        set
    }
    fn build(tree: &BTreeMap<String, Vec<Value>>, prefix: &str) -> Vec<Value> {
        let mut out: Vec<Value> = vec![];
        // 하위 폴더
        for child in children_of(tree, prefix) {
            let child_path = if prefix.is_empty() { child.clone() } else { format!("{prefix}/{child}") };
            let sub = build(tree, &child_path);
            out.push(json!({ "name": child, "item": sub }));
        }
        // 이 폴더 직속 요청
        if let Some(items) = tree.get(prefix) {
            out.extend(items.iter().cloned());
        }
        out
    }
    build(tree, "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postman_collection_roundtrip() {
        let pm = r#"{
          "info": { "name": "My PM", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
          "item": [
            { "name": "Auth", "item": [
              { "name": "login", "request": {
                  "method": "POST",
                  "header": [{ "key": "Content-Type", "value": "application/json" }],
                  "url": { "raw": "{{baseUrl}}/login" },
                  "body": { "mode": "raw", "raw": "{\"id\":\"a\"}" }
              }}
            ]},
            { "name": "ping", "request": { "method": "GET", "url": "{{baseUrl}}/ping" } }
          ]
        }"#;
        let spec = import_collection(pm).unwrap();
        let paths = spec.get("paths").and_then(|p| p.as_object()).unwrap();
        assert_eq!(paths.len(), 2, "/login, /ping");
        let login = paths.get("/login").and_then(|p| p.get("post")).unwrap();
        assert_eq!(login.get("x-folder").and_then(|f| f.as_str()), Some("Auth"));
        assert!(login.get("requestBody").is_some());

        // export 왕복
        let back = export_collection(&spec);
        let items = back.get("item").and_then(|i| i.as_array()).unwrap();
        // Auth 폴더 + ping 루트 요청
        let has_auth = items.iter().any(|i| i.get("name").and_then(|n| n.as_str()) == Some("Auth") && i.get("item").is_some());
        assert!(has_auth, "Auth 폴더 보존");
    }

    #[test]
    fn postman_environment_import() {
        let env = r#"{ "name": "dev", "values": [
          { "key": "baseUrl", "value": "http://x", "enabled": true },
          { "key": "off", "value": "y", "enabled": false }
        ]}"#;
        let e = import_environment(env, "dev").unwrap();
        assert_eq!(e.name, "dev");
        assert_eq!(e.variables.get("baseUrl").map(String::as_str), Some("http://x"));
        assert!(!e.variables.contains_key("off"), "enabled=false 제외");
    }
}
