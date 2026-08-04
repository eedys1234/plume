# Plume 코드베이스에서 사용한 Rust 문법 완전 해설

> 이 프로젝트(코어 `apigen-core` + Tauri 어댑터)에서 **실제로 쓴 Rust 문법·관용구**를 전부, 파일 위치와 함께 설명한다.
> 태그: 🦀 Rust 언어 · 📦 serde · 🔧 openapiv3/reqwest/tauri · 🧪 테스트
> 관련 문서: 설계 [DESIGN.md](DESIGN.md) · 구조 [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 목차
1. 크레이트/모듈 구조와 가시성
2. 에러 처리 (`Result` 별칭 · `?` · thiserror)
3. 소유권·빌림·클론·재빌림
4. 데이터를 품는 enum + 망라 `match` + `let-else`
5. 구조체 · `derive` · `Default` · 업데이트 문법
6. 제네릭과 트레이트 바운드
7. serde 애트리뷰트 총정리
8. 컬렉션과 엔트리 API
9. 이터레이터와 클로저
10. `Option`/`Result` 콤비네이터
11. 문자열 처리
12. 라이프타임
13. `serde_json::Value` 동적 조작
14. 파일시스템·경로
15. 외부 프로세스 실행 (git)
16. HTTP 클라이언트 (reqwest)
17. 손으로 짠 파서 (.bru DSL)
18. enum에 메서드 달기
19. 시간 측정
20. Tauri 매크로
21. 테스트
22. 애트리뷰트·조건부 컴파일

---

## 1. 크레이트/모듈 구조와 가시성
`Cargo.toml`, `crates/apigen-core/src/lib.rs`

**워크스페이스**: 순수 코어와 Tauri 어댑터를 분리한 멀티 크레이트.
```toml
[workspace]
members = ["crates/apigen-core", "src-tauri"]
resolver = "2"
[workspace.dependencies]      # 버전을 한 곳에서 고정 → 하위 크레이트가 .workspace = true 로 상속
serde = { version = "1", features = ["derive"] }
```

**모듈 선언 + 재노출** (`lib.rs`):
```rust
pub mod bru;      // src/bru.rs 를 공개 모듈로
pub mod error;
pub mod git;
// ...
pub use error::{AppError, CoreError, Result};   // 하위 항목을 크레이트 루트로 끌어올림
pub use openapiv3;                               // 의존 크레이트를 통째 재노출
```
- `mod x;` 는 `x.rs`(또는 `x/mod.rs`)를 모듈로 편입.
- `pub use` = **재노출**. 어댑터가 `apigen_core::openapiv3::OpenAPI`를 별도 의존성 없이 쓴다.
- `pub`/`pub(crate)`/기본(private)로 가시성 제어. 함수·구조체·필드마다 개별 지정.

---

## 2. 에러 처리 — `Result` 별칭 · `?` · thiserror 🦀📦
`crates/apigen-core/src/error.rs`

```rust
#[derive(Debug, Error)]                 // thiserror가 Display/Error 트레이트 생성
pub enum CoreError {
    #[error("입출력 오류: {0}")]
    Io(#[from] std::io::Error),         // #[from] → impl From<io::Error> 자동 생성
    #[error("HTTP 오류: {0}")]
    Http(String),
}
pub type Result<T> = std::result::Result<T, CoreError>;   // 타입 별칭
```
- **`?` 연산자**: `let s = fs::read_to_string(p)?;` — 에러면 `From::from`으로 변환해 조기 `return`, 성공이면 값을 꺼냄. 반환 타입이 `Result<T>`(=`Result<T, CoreError>`)라서, `#[from]`이 있는 어떤 하위 에러든 `?` 한 글자로 승격된다.
- **타입 별칭**으로 매번 `, CoreError`를 생략.

**손수 구현하는 변환** (`impl From`):
```rust
impl From<CoreError> for AppError {   // From 구현 → Into 는 공짜
    fn from(e: CoreError) -> Self {
        let code = match &e { CoreError::Io(_) => "io", /* … */ };
        AppError { code: code.into(), message: e.to_string() }
    }
}
```
`From`이 있으면 커맨드에서 `?`/`.into()`로 `CoreError → AppError` 변환이 자동으로 걸린다.

---

## 3. 소유권·빌림·클론·재빌림 🦀
곳곳

- **빌림** `&`/`&mut`: `fn validate(spec: &OpenAPI)` 는 읽기만, `fn walk_folder(spec: &mut OpenAPI, …)` 는 수정.
- **`match &e`**: 참조로 매칭해 `e`를 소비하지 않음 → 아래에서 `e.to_string()` 재사용 가능 (`error.rs`).
- **재빌림** `&*`: `serde_json::to_value(&*spec)` — `&mut OpenAPI`를 `&OpenAPI`로 낮춰 불변 참조만 넘김 (`project.rs::normalize_refs`).
- **`.clone()`**: `map.insert(ex.name.clone(), obj)` — `insert`가 키의 소유권을 가져가므로 복제해 넘기고 원본은 유지 (`project.rs`).
- **역참조 대입** `*spec = …`: `*spec = serde_json::from_value(v)?;` 로 내용 전체 교체.

---

## 4. 데이터를 품는 enum + 망라 `match` + `let-else` 🦀
`http.rs`, `model.rs`, `project.rs`

각 변형이 서로 다른 데이터를 갖는 합타입:
```rust
pub enum AuthSpec {
    None,
    Bearer { token: String },                        // 구조체형 변형
    Basic { username: String, password: String },
    Apikey { location: String, name: String, value: String },
}
```
소비할 땐 **모든 변형을 망라**해야 컴파일된다(빠뜨리면 에러 → 새 인증 추가 시 컴파일러가 강제):
```rust
rb = match &req.auth {
    AuthSpec::None => rb,
    AuthSpec::Bearer { token } => rb.bearer_auth(token),
    AuthSpec::Basic { username, password } => rb.basic_auth(username, Some(password)),
    AuthSpec::Apikey { name, value, .. } => { /* .. 로 나머지 필드 무시 */ }
};   // match는 식이라 결과를 바로 대입
```

**let-else** (Rust 1.65+) — 참조가 아닐 때만 진행, 아니면 발산:
```rust
let ReferenceOr::Item(pi) = entry else {
    warnings.push(Diagnostic::warn(&req.path, "참조된 PathItem엔 붙일 수 없음"));
    return Ok(());           // else는 반드시 return/break/panic 등으로 스코프 이탈
};
// 여기부터 pi는 &mut PathItem 로 확정 — 중첩 없이 평평하게 이어짐
```

---

## 5. 구조체 · `derive` · `Default` · 업데이트 문법 🦀📦
`model.rs`, `git.rs`, `project.rs`

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]   // 매크로로 트레이트 자동 구현
pub struct BruRequest { pub name: String, pub method: String, /* … */ }
```
- **`#[derive(...)]`**: `Debug`(디버그 출력), `Clone`(복제), `PartialEq`(== 비교, 테스트에 필수), `Default`, serde 등.
- **구조체 업데이트 문법** `..Default::default()`:
  ```rust
  let mut spec = OpenAPI {
      openapi: proj.openapi, info: proj.info, servers: proj.servers,
      paths: Paths::default(),
      components: Some(Components::default()),
      ..Default::default()          // 나머지 필드는 기본값
  };
  ```
- **`Response { description: String::new(), ..Default::default() }`** — Response는 description이 필수라 Default가 없어서 직접 채움.

---

## 6. 제네릭과 트레이트 바운드 🦀
`project.rs`, `model.rs`, `markdown.rs`

"역직렬화만 되면 어떤 타입 `T`든" 읽는 함수:
```rust
fn read_yaml<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let s = fs::read_to_string(path)?;
    serde_yaml::from_str(&s).map_err(CoreError::from)
}
// 호출부에서 T는 문맥으로 추론:
let proj: ProjectFile = read_yaml(&root.join("project.yaml"))?;   // T = ProjectFile
```
같은 코드가 컴포넌트 6종(schemas/responses/…)에 재사용된다:
```rust
fn load_dir<T: DeserializeOwned>(dir: &Path) -> Result<IndexMap<String, ReferenceOr<T>>> { … }
comp.schemas   = load_dir(&comp_dir.join("schemas"))?;    // T = Schema
comp.responses = load_dir(&comp_dir.join("responses"))?;  // T = Response
```
컴파일러가 타입별로 **단형화(monomorphize)** → 런타임 비용 0.

**인자 위치 `impl Trait`**:
- `impl Into<String>` — `&str`/`String`/`format!` 결과를 모두 받음 (`Diagnostic::warn(path: impl Into<String>, …)`).
- `impl Fn(u8) -> String` — 클로저를 인자로 (`markdown.rs::write_operation(h: &impl Fn(u8) -> String, …)`).

---

## 7. serde 애트리뷰트 총정리 📦
`model.rs`, `http.rs`, `git.rs`, `project.rs`

```rust
#[derive(Serialize, Deserialize)]
pub struct ExampleFile {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,                     // 없으면 기본값, None이면 출력에서 생략
    #[serde(rename = "externalValue", default, skip_serializing_if = "Option::is_none")]
    pub external_value: Option<String>,              // JSON 키는 externalValue
}
```
| 애트리뷰트 | 뜻 |
|---|---|
| `#[serde(default)]` | 입력에 없으면 `Default` 값 |
| `skip_serializing_if = "Option::is_none"` | `None`이면 필드 자체를 출력 생략 → 깔끔·결정적 |
| `rename = "..."` / `rename_all = "camelCase"\|"lowercase"` | Rust snake_case ↔ 파일/JS camelCase 흡수 |
| `#[serde(flatten)]` | 하위 구조체 필드를 같은 레벨로 펼침 |
| `#[serde(tag = "kind")]` | 내부 태그 enum |
| `#[default]` | enum의 기본 변형 지정(파생 `Default`와 함께) |

**flatten** — 우리 필드 + 라이브러리 타입을 한 문서에:
```rust
pub struct RequestFile {
    pub method: String, pub path: String,
    #[serde(flatten)] pub operation: openapiv3::Operation,   // Operation 필드가 같은 레벨로
}
```
**내부 태그 enum** — TS 판별 유니온과 형태 일치:
```rust
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BodySpec {
    #[default] None,
    Json { value: serde_json::Value },   // → { "kind": "json", "value": … }
}
```

---

## 8. 컬렉션과 엔트리 API 🦀🔧
`project.rs`, `http.rs`, `validate.rs`

- **`IndexMap`**(순서 보존, openapiv3가 사용), **`BTreeMap`**(정렬, http 헤더/변수), **`HashMap`**(validate의 중복검사), **`BTreeSet`**(split의 폴더 집합).

**"없으면 만들기" upsert**:
```rust
op.request_body
    .get_or_insert_with(|| ReferenceOr::Item(RequestBody::default()));   // Option: None이면 채우고 &mut 반환
body.content
    .entry(mt).or_default()          // IndexMap: 없으면 MediaType::default() 삽입
    .examples.insert(name, obj);
responses.responses
    .entry(code).or_insert_with(|| ReferenceOr::Item(empty_response()));  // 클로저 버전은 필요할 때만 생성
```
- `entry(k).or_insert_with(f)` / `.or_default()` — 표준 upsert.
- `shift_remove(&name)` — IndexMap에서 **순서 보존하며** 제거 (`project.rs::drain_media`).
- `map.values()` / `.keys()` / `.iter_mut()` 순회.

---

## 9. 이터레이터와 클로저 🦀
`markdown.rs`, `validate.rs`, `http.rs`, `bru.rs`

명령형 루프 대신 어댑터 체인:
```rust
let params: Vec<&Parameter> = op.parameters.iter()
    .filter_map(|p| match p {                 // 걸러내며 동시에 변환
        ReferenceOr::Item(p) => Some(p),
        _ => None,
    })
    .collect();                               // 소비하며 Vec로 수집(타입으로 무엇을 모을지 추론)
```
- `filter_map` = `filter` + `map` 한 번에.
- `collect::<Vec<_>>()` — 터보피시로 수집 타입 지정, `_`는 원소 추론.
- 문자열 조립: `op.tags.iter().map(|t| format!("`{t}`")).collect::<Vec<_>>().join(", ")`.
- **함수를 클로저 자리에**: `arr.iter_mut().for_each(rewrite_refs)` = `|x| rewrite_refs(x)` 축약.
- `.filter(Boolean)` 대응 Rust: `.filter(|f| …)`, `.any(|t| t == tag)`.

---

## 10. `Option`/`Result` 콤비네이터 🦀
곳곳

```rust
let folder = op.extensions.get("x-folder")     // Option<&Value>
    .and_then(|v| v.as_str())                  // Option<&str> (as_str가 None일 수 있음)
    .map(|s| s.to_string())                    // Option<String>
    .or_else(|| op.tags.first().cloned())      // None이면 대안
    .unwrap_or_else(|| first_segment(path));   // 그래도 None이면 계산해서 채움
```
| 콤비네이터 | 뜻 |
|---|---|
| `map` / `and_then` | 값 변환 / 평탄화 변환(Option 반환) |
| `unwrap_or` / `unwrap_or_else` / `unwrap_or_default` | 기본값(값/클로저/Default) |
| `or_else` | None일 때 대안 Option |
| `map_err(CoreError::from)` | Err 타입 변환 (함수를 그대로 넘김) |
| `.ok()` | `Result<T,E>` → `Option<T>` (`git.rs`의 ahead/behind) |
| `.as_deref()` | `Option<String>` → `Option<&str>` (`parse_format(format.as_deref())`) |
| `.filter(\|s\| !s.is_empty())` | 조건 불만족이면 None |

---

## 11. 문자열 처리 🦀
`bru.rs`, `project.rs`, `validate.rs`, `git.rs`

- **`String` vs `&str`**: 소유 vs 빌린 문자열. `.to_string()`/`.into()`로 승격, `&s`로 강등.
- **`format!`** + **raw 문자열** `r#"…"#` (이스케이프 없이 `"`·`\` 포함):
  ```rust
  format!(r#"<script>window.__SPEC__ = {safe};</script>"#)   // publish.rs
  ```
- **슬라이스 메서드**(할당 없음): `trim_end_matches(".yaml")`, `strip_prefix('{')`, `strip_suffix('}')`, `find("components/")`, `split('/')`, `rsplit('/').next()`.
- **제어문자로 split** — 로그 파싱: `--pretty=format:%h\x1f%an\x1f%ad\x1f%s` 를 `l.split('\x1f')`로 분해 (`git.rs`).
- **`String::from_utf8_lossy(&bytes)`** — 프로세스 stdout(바이트)을 문자열로 (`git.rs`).
- **char 단위 처리**: `s.chars().map(|c| …).collect()` 로 파일명 정규화 (`sanitize`).

---

## 12. 라이프타임 🦀
`project.rs`

인자가 둘이라 반환 참조가 어느 쪽에 묶이는지 모호할 때 명시:
```rust
fn response_slot<'a>(responses: &'a mut Responses, status: &str)
    -> &'a mut ReferenceOr<Response> {          // 반환은 responses의 수명 'a에 묶임
    responses.responses.entry(code)
        .or_insert_with(|| ReferenceOr::Item(empty_response()))
}
```
대부분은 생략(elision)되지만, 여기선 `status`가 아니라 `responses`에 묶임을 컴파일러에 알려야 한다.

---

## 13. `serde_json::Value` 동적 조작 🦀📦
`project.rs::normalize_refs` — 이 프로젝트에서 가장 영리한 트릭

openapiv3의 방대한 중첩 타입을 손으로 순회하지 않고, **JSON으로 낮춰서** `$ref`만 고친다:
```rust
fn normalize_refs(spec: &mut OpenAPI) -> Result<()> {
    let mut v = serde_json::to_value(&*spec)?;   // 강타입 → 동적 Value
    rewrite_refs(&mut v);                          // 재귀 순회하며 "$ref" 치환
    *spec = serde_json::from_value(v)?;            // 다시 강타입으로
    Ok(())
}
fn rewrite_refs(v: &mut Value) {
    match v {
        Value::Object(map) => {
            if let Some(Value::String(r)) = map.get_mut("$ref") { *r = normalize_ref(r); }
            for (_k, val) in map.iter_mut() { rewrite_refs(val); }   // 자식으로 재귀
        }
        Value::Array(arr) => arr.iter_mut().for_each(rewrite_refs),
        _ => {}                                     // 스칼라는 그대로
    }
}
```
`serde_json::json!({...})` 매크로로 값 리터럴도 만든다 (`bru.rs::export_collection`의 bruno.json).

---

## 14. 파일시스템·경로 🦀
`project.rs`, `publish.rs`, `bru.rs`

```rust
use std::path::{Path, PathBuf};
let mut dir = root.join("folders");
for seg in folder.split('/').filter(|s| !s.is_empty()) {
    dir = dir.join(sanitize(seg));            // PathBuf 누적 조립
}
fs::create_dir_all(&dir)?;                    // 상위까지 생성
fs::write(dir.join("request.yaml"), s)?;      // 쓰기
let content = fs::read_to_string(&path)?;     // 읽기
```
- **결정적 순회**: `read_dir`는 순서 미보장 → 정렬해서 씀:
  ```rust
  let mut v: Vec<PathBuf> = fs::read_dir(dir)?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
  v.sort();
  ```
- `path.file_stem()`, `path.extension().and_then(|s| s.to_str())`, `path.is_file()`/`is_dir()`.

---

## 15. 외부 프로세스 실행 (git) 🦀🔧
`git.rs`, `publish.rs`

```rust
use std::process::Command;
fn run(root: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)                    // 작업 디렉토리 지정
        .output()                             // 실행하고 stdout/stderr/exit 캡처
        .map_err(|e| CoreError::Project(format!("git 실행 실패: {e}")))?;
    if !out.status.success() {                // 종료 코드 확인
        return Err(CoreError::Project(format!(
            "git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
```
- `--no-index` diff처럼 **종료 코드 1도 정상**인 경우는 `output()`을 직접 받아 `stdout`만 취한다 (`diff_file`).

---

## 16. HTTP 클라이언트 (reqwest) 🔧
`http.rs`

**blocking** API로 코어를 동기 함수로 유지(브라우저 fetch가 아니라 Rust가 실행 → CORS 없음):
```rust
let client = reqwest::blocking::Client::builder()
    .timeout(Duration::from_secs(30))
    .build()?;
let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())?;  // "POST" → Method
let mut rb = client.request(method, &url);   // 빌더 패턴
rb = rb.query(&query).header(k, val).json(value);   // 체이닝
let resp = rb.send()?;
let status = resp.status();                  // reqwest::StatusCode
let text = resp.text()?;
```
`{{var}}` 치환은 직접 스캔한 함수 `substitute`가 담당(문자열 인덱싱 + `find("{{")`).

---

## 17. 손으로 짠 파서 (.bru DSL) 🦀
`bru.rs::parse_blocks` — 상태 기계 + 중괄호 깊이 계산

```rust
let chars: Vec<char> = input.chars().collect();   // 유니코드 안전 인덱싱을 위해 Vec<char>
let mut i = 0;
while i < n {
    while i < n && chars[i].is_whitespace() { i += 1; }   // 공백 스킵
    // 이름 읽기 …
    i += 1; // '{' 소비
    let mut depth = 1;
    while i < n {                                 // body:json 내부의 {}까지 안전 처리
        match chars[i] { '{' => depth += 1, '}' => { depth -= 1; if depth == 0 { break; } }, _ => {} }
        i += 1;
    }
}
```
- `Vec<char>` 인덱싱으로 바이트 경계 문제 회피.
- `String` 누적 빌드(`push_str`, `format!`), `lines()`로 라인 순회, 공통 들여쓰기 제거(`dedent`).

---

## 18. enum에 메서드 달기 🦀
`snippet.rs`

```rust
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lang { Curl, Fetch, Httpie }
impl Lang {
    pub fn label(self) -> &'static str {          // self by value (Copy라 가능)
        match self { Lang::Curl => "curl", Lang::Fetch => "fetch", Lang::Httpie => "httpie" }
    }
    pub fn parse(s: &str) -> Option<Lang> { … }    // 연관 함수(생성자류)
}
```
- `impl Enum { … }`로 메서드/연관 함수 정의.
- `Copy` 파생 → `self`를 값으로 받아도 소비되지 않음.
- `&'static str` — 프로그램 수명 내내 사는 문자열 리터럴.

---

## 19. 시간 측정 🦀
`http.rs`

```rust
let started = Instant::now();
let resp = rb.send()?;
let elapsed_ms = started.elapsed().as_millis();   // u128 밀리초
```

---

## 20. Tauri 매크로 🔧
`src-tauri/src/commands.rs`, `lib.rs`, `main.rs`

```rust
#[tauri::command]                                  // JS invoke로 호출 가능한 커맨드로 등록
pub fn spec_to_markdown(spec: Value, include_examples: Option<bool>)
    -> Result<String, AppError> { … }              // Err는 직렬화되어 JS로 reject
```
```rust
tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![       // 커맨드 목록 → IPC 라우터
        commands::ping, commands::git_status, /* …35개 */
    ])
    .run(tauri::generate_context!())                // tauri.conf.json + 아이콘 임베드
    .expect("실행 오류");
```
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]  // 릴리스에서 콘솔창 숨김
#[cfg_attr(mobile, tauri::mobile_entry_point)]                      // 조건부 애트리뷰트
```
- `#[tauri::command]`가 인자 역직렬화·결과 직렬화 글루 생성. JS의 camelCase 키(`includeExamples`)를 Rust snake_case 파라미터로 자동 매핑.
- 반환이 `Result<T, E>`면 `Err`는 `Promise.reject` → `AppError: Serialize` 필수.
- 동기 커맨드는 Tauri가 별도 스레드에서 실행 → `reqwest::blocking`·`Command`가 async 런타임을 막지 않음.

---

## 21. 테스트 🧪
`lib.rs`, `bru.rs`, `git.rs`, `snippet.rs`, `http.rs`, `publish.rs`

```rust
#[cfg(test)]                     // 테스트 빌드에서만 컴파일
mod tests {
    use super::*;               // 상위 모듈(private 포함) 가져오기
    #[test]
    fn split_bundle_is_stable() {
        let dir = tempfile::tempdir().unwrap();      // dev-dependency: 임시 디렉토리
        split(dir.path(), &spec).unwrap();
        let (bundled, _) = bundle(dir.path()).unwrap();
        assert_eq!(                                   // 의미 동등성 비교
            serde_json::to_value(&bundled).unwrap(),
            serde_json::to_value(&bundled2).unwrap(),
        );
    }
}
```
- `#[cfg(test)] mod tests` + `#[test]` 함수. `use super::*`로 private까지 접근.
- `assert!`, `assert_eq!(a, b, "메시지 {x}")`.
- **바이트가 아니라 의미 비교**: 두 스펙을 `serde_json::Value`로 낮춰 비교(키 순서 무관).
- git 흐름 테스트는 실제 `git`을 임시 저장소에서 돌려 stage→unstage→commit→diff→discard 전 과정 검증(`git.rs`).

---

## 22. 애트리뷰트·조건부 컴파일 🦀
- `#[derive(...)]` — 트레이트 자동 구현.
- `#[serde(...)]` — 직렬화 제어(§7).
- `#[cfg(test)]` / `#[cfg_attr(cond, attr)]` — 조건부 컴파일/애트리뷰트.
- `#[error("…")]`(thiserror), `#[from]`, `#[default]`, `#[tauri::command]` 등 라이브러리 파생 매크로 애트리뷰트.

---

## 부록 — 이 스타일이 이 앱에 맞은 이유
- **`Result` + `?` + `#[from]`**: 파일 IO·JSON·YAML·HTTP·git 에러가 한 타입으로 모여, 각 함수는 성공 경로만 서술.
- **`enum` + 망라 `match`**: 인증/본문/예시위치/스니펫언어/상태코드처럼 "정해진 몇 가지"를 타입으로 고정 → 누락을 컴파일러가 잡음.
- **serde 애트리뷰트**: 파일 포맷·IPC 계약을 선언적으로 → 파서를 직접 안 짬(단, `.bru`는 DSL이라 손으로 파싱, §17).
- **제네릭 + `Value` 트릭**: openapiv3의 큰 타입 트리를 손 순회 없이 `$ref` 정규화·컴포넌트 로딩.
- **얇은 어댑터**: 도메인은 순수 코어, Tauri는 `#[tauri::command]`로 중계만.

더 깊게 볼 지점(예: `Cow`로 클론 줄이기, `async` 커맨드 전환, trait object vs 제네릭)은 짚어주면 이어서 설명한다.
