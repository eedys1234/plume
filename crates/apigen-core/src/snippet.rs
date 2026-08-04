//! 코드 스니펫 생성 (curl / fetch / httpie).
//!
//! HttpRequest + Environment를 받아 `{{var}}`를 치환한 **구체 요청**으로 스니펫을 만든다.
//! 이 결과는 (a) Client/Try-it-out UI에 표시하고, (b) OpenAPI `x-codeSamples` 확장으로
//! 주입하면 Redoc이 그대로 렌더한다.

use std::collections::BTreeMap;

use crate::http::{substitute, AuthSpec, BodySpec, Environment, HttpRequest};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Curl,
    Javascript,
    Python,
    Csharp,
    Java,
    Kotlin,
}

impl Lang {
    pub fn label(self) -> &'static str {
        match self {
            Lang::Curl => "curl",
            Lang::Javascript => "javascript",
            Lang::Python => "python",
            Lang::Csharp => "csharp",
            Lang::Java => "java",
            Lang::Kotlin => "kotlin",
        }
    }
    pub fn parse(s: &str) -> Option<Lang> {
        match s {
            "curl" => Some(Lang::Curl),
            "javascript" => Some(Lang::Javascript),
            "python" => Some(Lang::Python),
            "csharp" => Some(Lang::Csharp),
            "java" => Some(Lang::Java),
            "kotlin" => Some(Lang::Kotlin),
            _ => None,
        }
    }
}

/// 치환 완료된 요청 표현.
struct Resolved {
    method: String,
    url: String, // 쿼리 포함
    headers: Vec<(String, String)>,
    body: Option<String>,
    basic: Option<(String, String)>, // Basic 인증(스니펫별로 다르게 표현)
}

fn sub(s: &str, vars: &BTreeMap<String, String>) -> String {
    substitute(s, vars).0
}

fn resolve(req: &HttpRequest, env: &Environment) -> Resolved {
    let vars = &env.variables;
    let mut url = sub(&req.url, vars);

    // 쿼리 스트링
    let q: Vec<String> = req
        .query
        .iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(&sub(v, vars))))
        .collect();
    if !q.is_empty() {
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str(&q.join("&"));
    }

    let mut headers: Vec<(String, String)> =
        req.headers.iter().map(|(k, v)| (k.clone(), sub(v, vars))).collect();
    let mut basic = None;

    match &req.auth {
        AuthSpec::None => {}
        AuthSpec::Bearer { token } => {
            headers.push(("Authorization".into(), format!("Bearer {}", sub(token, vars))));
        }
        AuthSpec::Basic { username, password } => {
            basic = Some((sub(username, vars), sub(password, vars)));
        }
        AuthSpec::Apikey { location, name, value } => {
            if location == "query" {
                url.push(if url.contains('?') { '&' } else { '?' });
                url.push_str(&format!("{}={}", enc(name), enc(&sub(value, vars))));
            } else {
                headers.push((name.clone(), sub(value, vars)));
            }
        }
    }

    let body = match &req.body {
        BodySpec::None => None,
        BodySpec::Json { value } => Some(serde_json::to_string(value).unwrap_or_default()),
        BodySpec::Text { value } => Some(sub(value, vars)),
        BodySpec::Form { value } => {
            Some(value.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&"))
        }
    };

    Resolved { method: req.method.to_uppercase(), url, headers, body, basic }
}

/// 최소 percent-encoding(스니펫 표시용).
fn enc(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '&' => "%26".to_string(),
            '#' => "%23".to_string(),
            _ => c.to_string(),
        })
        .collect()
}

/// 지정 언어로 스니펫 생성.
pub fn generate(req: &HttpRequest, env: &Environment, lang: Lang) -> String {
    let r = resolve(req, env);
    match lang {
        Lang::Curl => curl(&r),
        Lang::Javascript => fetch(&r),
        Lang::Python => python(&r),
        Lang::Csharp => csharp(&r),
        Lang::Java => java(&r),
        Lang::Kotlin => kotlin(&r),
    }
}

/// 지원 언어 전부 생성.
pub fn all(req: &HttpRequest, env: &Environment) -> Vec<(String, String)> {
    [Lang::Curl, Lang::Javascript, Lang::Python, Lang::Csharp, Lang::Java, Lang::Kotlin]
        .into_iter()
        .map(|l| (l.label().to_string(), generate(req, env, l)))
        .collect()
}

fn curl(r: &Resolved) -> String {
    let mut s = format!("curl -X {} '{}'", r.method, r.url);
    for (k, v) in &r.headers {
        s.push_str(&format!(" \\\n  -H '{k}: {v}'"));
    }
    if let Some((u, p)) = &r.basic {
        s.push_str(&format!(" \\\n  -u '{u}:{p}'"));
    }
    if let Some(b) = &r.body {
        s.push_str(&format!(" \\\n  -d '{}'", b.replace('\'', "'\\''")));
    }
    s
}

fn fetch(r: &Resolved) -> String {
    let mut headers = r.headers.clone();
    if let Some((u, p)) = &r.basic {
        headers.push(("Authorization".into(), format!("Basic ' + btoa('{u}:{p}') + '")));
    }
    let hdr = headers
        .iter()
        .map(|(k, v)| format!("    \"{k}\": \"{v}\"", ))
        .collect::<Vec<_>>()
        .join(",\n");
    let mut init = format!("  method: \"{}\"", r.method);
    if !hdr.is_empty() {
        init.push_str(&format!(",\n  headers: {{\n{hdr}\n  }}"));
    }
    if let Some(b) = &r.body {
        init.push_str(&format!(",\n  body: {}", js_string(b)));
    }
    format!("await fetch(\"{}\", {{\n{init}\n}});", r.url)
}

/// Java 11+ java.net.http.HttpClient.
fn java(r: &Resolved) -> String {
    let mut s = String::from("HttpClient client = HttpClient.newHttpClient();\n");
    s.push_str("HttpRequest request = HttpRequest.newBuilder()\n");
    s.push_str(&format!("    .uri(URI.create(\"{}\"))\n", r.url));
    for (k, v) in &r.headers {
        s.push_str(&format!("    .header(\"{}\", \"{}\")\n", k, jstr_inner(v)));
    }
    if let Some((u, p)) = &r.basic {
        s.push_str(&format!(
            "    .header(\"Authorization\", \"Basic \" + Base64.getEncoder().encodeToString(\"{u}:{p}\".getBytes()))\n"
        ));
    }
    match &r.body {
        Some(b) => s.push_str(&format!(
            "    .method(\"{}\", HttpRequest.BodyPublishers.ofString(\"{}\"))\n",
            r.method,
            jstr_inner(b)
        )),
        None => s.push_str(&format!("    .method(\"{}\", HttpRequest.BodyPublishers.noBody())\n", r.method)),
    }
    s.push_str("    .build();\n");
    s.push_str("HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());\n");
    s.push_str("System.out.println(response.body());");
    s
}

/// Kotlin + OkHttp.
fn kotlin(r: &Resolved) -> String {
    let mut s = String::from("val client = OkHttpClient()\n");
    let has_body = r.body.is_some();
    if let Some(b) = &r.body {
        s.push_str(&format!("val body = \"{}\".toRequestBody(\"application/json\".toMediaType())\n", jstr_inner(b)));
    }
    s.push_str("val request = Request.Builder()\n");
    s.push_str(&format!("    .url(\"{}\")\n", r.url));
    for (k, v) in &r.headers {
        s.push_str(&format!("    .header(\"{}\", \"{}\")\n", k, jstr_inner(v)));
    }
    if let Some((u, p)) = &r.basic {
        s.push_str(&format!("    .header(\"Authorization\", Credentials.basic(\"{u}\", \"{p}\"))\n"));
    }
    s.push_str(&format!("    .method(\"{}\", {})\n", r.method, if has_body { "body" } else { "null" }));
    s.push_str("    .build()\n");
    s.push_str("client.newCall(request).execute().use { println(it.body?.string()) }");
    s
}

/// Python + requests.
fn python(r: &Resolved) -> String {
    let hdrs = r
        .headers
        .iter()
        .map(|(k, v)| format!("\"{}\": \"{}\"", k, py_esc(v)))
        .collect::<Vec<_>>()
        .join(", ");
    let mut s = String::from("import requests\n\n");
    s.push_str("response = requests.request(\n");
    s.push_str(&format!("    \"{}\", \"{}\",\n", r.method, r.url));
    s.push_str(&format!("    headers={{{hdrs}}},\n"));
    if let Some((u, p)) = &r.basic {
        s.push_str(&format!("    auth=(\"{u}\", \"{p}\"),\n"));
    }
    if let Some(b) = &r.body {
        // 삼중따옴표로 JSON 본문의 큰따옴표 충돌 회피.
        s.push_str(&format!("    data='''{}''',\n", b));
    }
    s.push_str(")\nprint(response.status_code)\nprint(response.text)");
    s
}

/// C# HttpClient.
fn csharp(r: &Resolved) -> String {
    let mut s = String::from("using var client = new HttpClient();\n");
    s.push_str(&format!(
        "var request = new HttpRequestMessage(new HttpMethod(\"{}\"), \"{}\");\n",
        r.method, r.url
    ));
    for (k, v) in &r.headers {
        s.push_str(&format!("request.Headers.TryAddWithoutValidation(\"{}\", \"{}\");\n", k, jstr_inner(v)));
    }
    if let Some((u, p)) = &r.basic {
        s.push_str(&format!(
            "request.Headers.Authorization = new AuthenticationHeaderValue(\"Basic\", Convert.ToBase64String(Encoding.UTF8.GetBytes(\"{u}:{p}\")));\n"
        ));
    }
    if let Some(b) = &r.body {
        s.push_str(&format!(
            "request.Content = new StringContent(\"{}\", Encoding.UTF8, \"application/json\");\n",
            jstr_inner(b)
        ));
    }
    s.push_str("var response = await client.SendAsync(request);\n");
    s.push_str("Console.WriteLine((int)response.StatusCode);\n");
    s.push_str("Console.WriteLine(await response.Content.ReadAsStringAsync());");
    s
}

fn py_esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Java/Kotlin/C# 문자열 리터럴 내부 이스케이프.
fn jstr_inner(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

fn js_string(s: &str) -> String {
    format!("`{}`", s.replace('`', "\\`"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> HttpRequest {
        let mut headers = BTreeMap::new();
        headers.insert("Accept".into(), "application/json".into());
        HttpRequest {
            method: "post".into(),
            url: "{{baseUrl}}/users".into(),
            headers,
            query: BTreeMap::new(),
            body: BodySpec::Json { value: serde_json::json!({"email": "geo@colosseum.kr"}) },
            auth: AuthSpec::Bearer { token: "{{token}}".into() },
        }
    }
    fn env() -> Environment {
        let mut v = BTreeMap::new();
        v.insert("baseUrl".into(), "https://api.example.com".into());
        v.insert("token".into(), "SECRET".into());
        Environment { id: "e".into(), name: "E".into(), variables: v }
    }

    #[test]
    fn curl_has_substituted_url_and_auth() {
        let s = generate(&req(), &env(), Lang::Curl);
        assert!(s.contains("curl -X POST 'https://api.example.com/users'"));
        assert!(s.contains("-H 'Authorization: Bearer SECRET'"));
        assert!(s.contains("email"));
    }

    #[test]
    fn generates_all_langs() {
        let all = all(&req(), &env());
        let langs: Vec<&str> = all.iter().map(|(l, _)| l.as_str()).collect();
        assert_eq!(langs, vec!["curl", "javascript", "python", "csharp", "java", "kotlin"]);
        assert!(all.iter().find(|(l, _)| l == "python").unwrap().1.contains("import requests"));
        assert!(all.iter().find(|(l, _)| l == "csharp").unwrap().1.contains("HttpClient"));
        assert!(all.iter().find(|(l, _)| l == "kotlin").unwrap().1.contains("OkHttpClient"));
    }
}
