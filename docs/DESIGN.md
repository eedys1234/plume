# API Generator — 설계 문서 (v0.1)

> Tauri 2 기반 OpenAPI 3.0 스펙 에디터 · 문서 뷰어 · HTTP 클라이언트
> 확정 스택: **Tauri 2.x / React 18 + TypeScript / Rust `openapiv3` (OAS 3.0.x 전용)**

---

## 1. 목표와 범위

### 1.1 제품 한 줄 정의
OpenAPI 3.0 명세서를 **GUI로 작성**하고, **Markdown / Redoc으로 렌더**하며, 작성한 API를 **곧바로 호출(HTTP Client)** 까지 할 수 있는 로컬 데스크톱 앱.

### 1.2 핵심 기능 (요구사항 매핑)

| # | 요구사항 | 구현 축 | 담당 레이어 |
|---|---------|---------|------------|
| F1 | 손쉬운 API 명세서 작성 GUI | 폼 기반 Spec Editor | Frontend + Core(검증) |
| F2 | Markdown 문법으로 보여주고 copy | `spec_to_markdown` command | **Core** 생성 / Frontend 표시·복사 |
| F3 | Redoc 등 문서 툴로 converting | Redoc standalone 번들 렌더 | Frontend (Core는 spec JSON 제공) |
| F4 | HTTP API Client Tool | `reqwest` 기반 요청 실행 | **Core** (No CORS) |
| F5 | example 예시 세세히 기재 | OAS Example Object 편집 | Frontend + Core(직렬화) |
| F6 | OAS 3.0 Import / Export | JSON·YAML 파서 | **Core** |

### 1.3 이번 버전에서 다루지 않는 것 (Non-goals)
- OAS 3.1 / JSON Schema 2020-12 (추후 `oas3`로 확장 여지만 남김)
- 협업 / 실시간 동기화 / 클라우드 저장
- 코드 생성(server/client stub generation) — 로드맵 후반 후보
- 인증 OAuth2 flow 자동 처리(HTTP Client에서 토큰 수동 입력은 지원)

---

## 2. 설계 원칙

1. **도메인 로직은 Rust 코어에 집중한다.** 파싱·검증·직렬화·마크다운 변환·HTTP 호출은 전부 Tauri command. 프론트는 편집 상태(UI state)와 렌더링만 담당.
2. **단일 진실 원천(Single Source of Truth)은 OpenAPI 문서 그 자체.** 별도 "에디터 전용 모델"을 두지 않는다. 프론트는 OAS 3.0 구조를 그대로 미러링한 TS 타입으로 스펙을 들고 있고, 검증/저장 시 Rust로 왕복(round-trip)해 정합성을 보장한다. → 모델 이중화로 인한 동기화 버그 원천 차단.
3. **CORS-free HTTP Client.** 요청은 브라우저 fetch가 아니라 Rust `reqwest`가 실행. 브라우저 기반 클라이언트(Postman 웹 등)의 최대 약점을 제거.
4. **Export는 손실 없이, 결정적으로(deterministic).** 키 순서·들여쓰기가 안정적이어야 git diff·복사 결과가 예측 가능. (Import한 원본과 Export 결과가 의미적으로 동일)
5. **오프라인 완결.** Redoc, 폰트, 아이콘 전부 로컬 번들. 네트워크는 오직 HTTP Client의 사용자 요청에만 사용.

---

## 3. 아키텍처 개요

```
┌──────────────── Frontend (WebView / React + TS) ─────────────────┐
│  Editor Store (Zustand)  ── OAS 3.0 미러 TS 모델(SSOT)            │
│  ┌────────────┬────────────┬────────────┬────────────────────┐   │
│  │ Spec       │ Raw Editor │ Docs View  │ HTTP Client        │   │
│  │ Builder    │ (Monaco    │ (Markdown  │ (Request Builder + │   │
│  │ (폼 GUI)   │  JSON/YAML)│  + Redoc)  │  History)          │   │
│  └────────────┴────────────┴────────────┴────────────────────┘   │
└───────────────────────────────┬──────────────────────────────────┘
                                 │  Tauri IPC (invoke / typed)
┌───────────────────────────────┴──────────────────────────────────┐
│                       Rust Core (src-tauri)                       │
│  spec::   openapiv3 model, import/export(json·yaml), validate     │
│  md::     spec → GitHub-Flavored Markdown 생성기                  │
│  http::   reqwest 요청 실행, 변수 치환, 응답 정규화               │
│  store::  워크스페이스 파일 IO, 요청 히스토리(SQLite/rusqlite)    │
│  examples::  Example Object 검증(스키마 대비)                     │
└───────────────────────────────────────────────────────────────────┘
```

### 3.1 IPC 경계 원칙
- 프론트 ↔ 코어는 **JSON 직렬화된 OpenAPI 문서 전체** 또는 **부분 패치**를 주고받는다.
- 매 키 입력마다 왕복하지 않는다. 프론트가 편집 → **debounce(300ms) 후 `validate_spec`** 로 검증만 왕복. 저장/Export/렌더 시점에 전체 왕복.

---

## 4. 데이터 모델

### 4.1 프로젝트 = git 친화적 파일 트리 (핵심 설계)

앱이 여는 최상위 단위는 **단일 파일이 아니라 디렉토리**다. `Folder → Request → example`을 실제 폴더/파일로 펼쳐, **파일 1개 = 논리 단위 1개**를 지켜 git diff·병합·리뷰를 최소 단위로 만든다. (Bruno의 file-per-request + Redocly의 multi-file `$ref` split을 합친 패턴)

> **온디스크 트리가 편집·git의 SSOT이고, Export는 이 트리를 단일 `openapi.yaml`로 번들링(§4.5)** 해 외부 툴과 호환한다.

#### 온디스크 레이아웃

```
my-service-api/                    # ← 앱이 여는 프로젝트 루트(디렉토리)
├─ project.yaml                    # info(title/version/description), 전역 servers, security 등 문서 헤더
├─ folders/
│  └─ users/                       # Folder  → OAS tag "users"
│     ├─ _folder.yaml              #   폴더 메타: name, description, tag, order, (중첩 시 x-folder)
│     ├─ create-user/              # Request → operation (POST /users)
│     │  ├─ request.yaml           #   operation 정의(method/path/params/requestBody/responses…)
│     │  └─ examples/
│     │     ├─ 201-success.yaml    #   named example 1개 = 파일 1개
│     │     └─ 400-validation.yaml
│     └─ get-user/                 # Request → operation (GET /users/{id})
│        ├─ request.yaml
│        └─ examples/
│           └─ 200-default.yaml
├─ components/                     # 재사용 요소 → OAS #/components/*
│  ├─ schemas/
│  │  ├─ User.yaml
│  │  └─ CreateUserInput.yaml
│  ├─ examples/                    #   재사용 Example Object (#/components/examples)
│  │  └─ SampleUser.yaml
│  ├─ parameters/ · responses/ · headers/
│  └─ securitySchemes.yaml
├─ environments/                   # HTTP Client 전용(스펙 아님) — Export 대상 아님
│  ├─ local.yaml
│  └─ prod.yaml
└─ .apigen/                        # 앱 관리 영역 (git ignore 권장)
   ├─ config.yaml                  #   activeEnvironment, 정렬 옵션 등
   └─ history.db                   #   요청 히스토리(SQLite)
```

#### 각 파일 스키마 (요지)

**`request.yaml`** — Request 디렉토리 1개 = Operation 1개. `path`·`method`는 여기서 선언(폴더 위치와 무관).
```yaml
method: post
path: /users                       # URL 구조는 폴더 구조와 독립
operationId: createUser
summary: Create a user
tags: [users]                      # _folder.yaml에서 자동 상속(오버라이드 가능)
requestBody:
  required: true
  content:
    application/json:
      schema: { $ref: "components/schemas/CreateUserInput.yaml" }
      # examples는 ./examples/*.yaml에서 번들 시 자동 결합
responses:
  "201": { description: Created, content: { application/json: { schema: { $ref: "components/schemas/User.yaml" } } } }
  "400": { $ref: "components/responses/ValidationError.yaml" }
```

**`examples/201-success.yaml`** — 예시 파일은 **어디에 붙는지(target)** 를 스스로 선언한다. 이게 트리→단일문서 번들의 핵심 연결고리.
```yaml
name: success-201                  # named-example 키
target:                            # 이 예시의 부착 지점
  in: response                     # request | response | parameter
  status: "201"                    #   response일 때
  mediaType: application/json
summary: 정상 생성 응답
description: 신규 유저가 생성된 경우
value:                             # 인라인 값 (또는 externalValue: URL)
  id: usr_01H...
  email: geo@colosseum.kr
  createdAt: 2026-07-19T00:00:00Z
```

- **YAML 채택 이유:** 주석 허용 + 라인 단위 diff가 JSON보다 git 친화적. (Export는 json/yaml 양쪽 지원)
- `$ref`는 **파일 상대경로**로 표기(로컬 편집용). 번들 시 표준 JSON Pointer(`#/components/...`)로 변환.
- **결정성:** 파일 walk 결과를 `path` → `method` 순으로 정렬해 번들 → 동일 트리는 항상 동일 `openapi.yaml` 산출.

### 4.2 스펙 모델 매핑 (Rust ↔ TS)

- **Rust:** `openapiv3::OpenAPI` 를 그대로 사용. `serde_json`으로 (역)직렬화.
- **TS:** OAS 3.0을 미러링한 타입. 직접 손으로 유지하지 않고, **`openapiv3`의 스키마 또는 공개 OpenAPI 3.0 메타스키마에서 생성**(예: `openapi-typescript` 또는 코어에서 export한 JSON Schema → `json-schema-to-typescript`). 빌드 파이프라인에 넣어 드리프트 방지.
- `$ref`는 `ReferenceOr<T>` (Rust) / `{ $ref: string } | T` (TS)로 표현. 편집 UI는 참조와 인라인을 토글 가능하게.

### 4.3 Example을 어떻게 다루나 (F5 핵심)

OAS 3.0에서 예시가 붙는 위치는 여러 곳이다. 전부 1급으로 편집 지원:

| 위치 | 필드 | 편집 UI |
|------|------|---------|
| Media Type (요청/응답 본문) | `example` (단수) / `examples` (복수, named) | 탭형 named example 에디터 |
| Parameter / Header | `example` / `examples` | 인라인 예시 입력 |
| Schema Object | `example` (스키마 레벨 샘플) | 스키마 편집기 옆 미리보기 |
| Components | `components.examples` (재사용 Example Object) | 재사용 라이브러리 패널 |

- **Example Object 구조:** `{ summary, description, value | externalValue }`.
- **파일 매핑(§4.1):** 각 named example = `examples/<name>.yaml` 파일 1개. `target`(in/status/mediaType)으로 부착 지점 선언 → 번들러가 `content[mt].examples[name]`에 결합.
- **검증 부가기능:** 저장 시 코어가 `example.value`를 해당 media type의 `schema`에 대해 검증(`jsonschema` 크레이트). 스키마 불일치 예시에 경고 배지 표시. → "세세하게 기재"를 신뢰성 있게.

### 4.4 폴더는 태그와 독립된 1급 개념 (x-folder)

> **개정(2026-07-19):** 초기엔 "폴더=태그"로 매핑했으나, 폴더와 태그는 목적이 다르다(폴더=작성자의 조직 구조, 태그=문서 소비자용 그룹). 이제 **폴더는 태그와 완전히 분리**한다.

- **폴더 경로 = 디렉토리 구조 그 자체.** `folders/users/admin/createUser/` → 폴더 `users/admin`.
- **단일 문서에는 `x-folder` 확장으로 보존:** 번들 시 operation에 `x-folder: "users/admin"`(문자열)을 주입한다. 벤더 확장이라 단일 `openapi.yaml`에 남고 외부 툴은 무시한다. **태그는 자동 주입하지 않는다** — 사용자가 별도로 관리.
- **split 시 배치 우선순위:** `x-folder` > 첫 태그 > 첫 path 세그먼트. 파일엔 `x-folder`를 저장하지 않는다(디렉토리 위치로 암시 → 드리프트 방지). 번들 시 위치에서 재생성.
- **왕복:** `nested_folder_roundtrips` 테스트가 `folders/users/admin/...` ↔ `x-folder: "users/admin"` 을 검증(통과).

### 4.4.1 필드 단위 스키마 편집 (Request/Response)

Request Body·Response 본문의 `schema.properties`를 **필드 표**로 편집한다(구현됨: `SchemaEditor`).

| 컬럼 | OAS 매핑 |
|------|---------|
| 이름 | `properties`의 키 |
| 타입 | `properties[k].type` (string/integer/number/boolean/object/array) |
| 설명 | `properties[k].description` |
| 필수 | 부모 스키마의 `required: []` 배열 멤버십 |
| Null | `properties[k].nullable: true` (OAS 3.0) |

파라미터도 이름·위치(in)·타입·필수·설명을 표로 편집(`ParamsEditor`). path 파라미터는 `required: true` 강제.

### 4.4.2 Environment 영속화

HTTP Client 환경은 스펙과 분리되어 `environments/<id>.yaml`(환경별 1파일) + `.apigen/config.yaml`(활성 환경)에 저장된다(구현됨: `load_client`/`save_client`, 커맨드 `load_client_config`/`save_client_config`). `{{var}}` 참조는 코어 `http::substitute`가 활성 환경 변수로 치환.

### 4.5 번들링 / 라운드트립 (트리 ↔ 단일 문서)

프로젝트의 두 표현을 오가는 게 이 앱의 코어 파이프라인이다.

```
파일 트리(SSOT, git) ──load/bundle──▶ openapiv3::OpenAPI (인메모리) ──export──▶ openapi.yaml/json (단일, 외부 툴용)
      ▲                                      │
      └────────────── save/split ────────────┘   (편집 결과를 다시 트리로 분해 기록)
```

- **`bundle`(트리→문서):** 파일 walk → `$ref` 상대경로를 `#/components/...` JSON Pointer로 재작성 → example 파일들을 target 위치에 결합 → 폴더를 태그로 주입 → `path`·`method` 정렬 → `openapiv3::OpenAPI` 완성.
- **`split`(문서→트리):** Import한 단일 스펙을 태그(또는 첫 path 세그먼트) 기준으로 폴더에, operation을 request로, 각 named example을 파일로 분해. → **외부 `openapi.yaml`을 Import하면 곧바로 git 친화적 트리로 전개.**
- **왕복 불변식(round-trip invariant):** `split(bundle(tree))` 은 원 트리와 의미적으로 동등해야 한다(CI 게이트, §10). 바이트 동일까지는 목표 아님.
- 부분 저장: 한 Request/example만 바뀌면 해당 파일만 다시 쓴다(전체 트리 재작성 금지) → git diff 최소화, 저장 성능.

---

## 5. Tauri Command 명세 (IPC API)

모든 command는 `Result<T, AppError>` 반환. `AppError`는 `{ code, message, details? }`로 직렬화.

### 5.1 스펙 IO / 검증

```rust
// Import: 파일 경로 또는 원문 문자열 → 정규화된 OAS 문서
import_spec(input: SpecInput) -> ImportResult
//   SpecInput = { source: "path"|"text", value: String, format?: "json"|"yaml"|"auto" }
//   ImportResult = { spec: OpenAPI, warnings: Vec<Diagnostic> }

// Export: 문서 → 직렬화 문자열 (결정적 정렬)
export_spec(spec: OpenAPI, format: "json"|"yaml") -> String

// 검증: 구조 + 시맨틱(중복 operationId, 미해결 $ref, 예시-스키마 불일치 등)
validate_spec(spec: OpenAPI) -> Vec<Diagnostic>
//   Diagnostic = { severity: "error"|"warning"|"info", path: String /*JSON Pointer*/, message: String }
```

### 5.2 문서 렌더

```rust
// GitHub-Flavored Markdown 생성 (F2)
spec_to_markdown(spec: OpenAPI, opts: MarkdownOptions) -> String
//   MarkdownOptions = { include_examples: bool, include_schemas: bool, heading_base_level: u8 }

// Redoc용 HTML 문서 생성 (F3) — 로컬 번들 redoc.standalone.js 임베드
render_redoc_html(spec: OpenAPI, theme?: RedocTheme) -> String   // self-contained HTML
```

### 5.3 HTTP 클라이언트 (F4)

```rust
send_http_request(req: HttpRequest, env: Environment) -> HttpResponse
//   HttpRequest  = { method, url /*변수 {{baseUrl}} 포함 가능*/, headers, query, body: BodySpec, auth: AuthSpec }
//   BodySpec     = None | Json(Value) | Form(Map) | Multipart(...) | Raw{content_type, text}
//   AuthSpec     = None | Bearer(token) | Basic{user,pass} | ApiKey{in, name, value}
//   HttpResponse = { status, statusText, headers, body_text, body_json?, elapsed_ms, size_bytes }

// OAS operation → 요청 프리필 (스펙에서 바로 "호출해보기")
operation_to_request(spec: OpenAPI, path: String, method: String) -> HttpRequest
```

- `{{var}}` 치환은 코어에서 수행(활성 Environment 기준). 미해결 변수는 에러 Diagnostic.
- 리다이렉트/타임아웃/TLS 옵션은 요청별 설정.

### 5.4 프로젝트(파일 트리) / 번들 / 히스토리

```rust
// 프로젝트 = 디렉토리. load는 트리를 walk해 인메모리 문서로 bundle (§4.5)
open_project(dir: String)   -> Project
//   Project = { root: String, spec: OpenAPI, folders: FolderTree, client: ClientConfig, warnings: Vec<Diagnostic> }
new_project(dir: String, info: InfoInit) -> Project   // project.yaml + 빈 스켈레톤 트리 생성

// 부분 저장: 바뀐 노드만 파일로 재작성 (전체 트리 재작성 금지, git diff 최소)
save_request(dir: String, req: RequestNode) -> ()      // folders/.../request.yaml
save_example(dir: String, ex: ExampleFile) -> ()       // .../examples/<name>.yaml
save_component(dir: String, c: ComponentFile) -> ()    // components/**/*.yaml
delete_node(dir: String, node_path: String) -> ()      // 파일/디렉토리 제거

// 트리 ↔ 단일 문서 (§4.5)
bundle_project(dir: String) -> BundleResult            //   트리 → OpenAPI (+ warnings)
//   BundleResult = { spec: OpenAPI, warnings: Vec<Diagnostic> }
split_into_project(dir: String, spec: OpenAPI) -> ()   //   Import한 단일 스펙 → git 친화 트리로 분해

// Export: 번들된 문서를 단일 파일 문자열로 (결정적)
export_spec(spec: OpenAPI, format: "json"|"yaml") -> String

record_history(entry: HistoryEntry) -> ()          // 요청/응답 요약 저장 (.apigen/history.db)
list_history(filter: HistoryFilter) -> Vec<HistoryEntry>
```

> Import(외부 `openapi.yaml`) 흐름: `import_spec`(§5.1) → `split_into_project` → `open_project`.
> `export_spec`은 인메모리 문서를 받으므로 `bundle_project` 결과를 그대로 넘긴다.

---

## 6. 화면 / UX 흐름

### 6.1 레이아웃
좌측 **네비게이터**(Info / Servers / Paths / Components / Examples 트리) + 중앙 **에디터** + 우측 **미리보기/도구** 3-pane. 상단 탭으로 4개 주 모드 전환:

1. **Builder** — 폼 기반 스펙 작성 (F1)
   - Path/Operation 추가 → Method, Summary, Parameters, RequestBody, Responses, Examples를 폼으로.
   - 각 필드 옆 실시간 검증 배지(코어 `validate_spec` 결과의 JSON Pointer로 매핑).
2. **Raw** — Monaco로 JSON/YAML 직접 편집. Builder와 양방향 동기화(파싱 성공 시 반영, 실패 시 에러 gutter).
3. **Docs** — 좌: Markdown 뷰(+ 전체/섹션 Copy 버튼) / 우: Redoc 렌더 토글 (F2, F3).
4. **Client** — Request Builder + 응답 뷰어 + Environment 셀렉터 + 히스토리 (F4). Docs/Builder의 operation에서 "Try it" → 프리필.

### 6.2 핵심 상호작용
- **Builder ↔ Raw ↔ Docs는 동일 SSOT를 본다.** 한 곳 수정 → 즉시 반영.
- Markdown/Redoc은 파생(derived) 뷰 — 편집 불가, 복사/내보내기만.
- 저장되지 않은 변경은 상단 dirty 표시. 종료 시 확인.

---

## 7. 기능별 상세 설계

### 7.1 Markdown 생성기 (F2)
- Rust 측 순수 함수. 섹션 구성:
  `# {info.title}` → 개요/버전/설명 → Servers 표 → 태그별 그룹 → 각 Operation
  (`### {METHOD} {path}` / 설명 / Path·Query·Header params 표 / Request Body(스키마 요약 + 예시 코드블록) / Responses 표(status·설명·예시) ) → Components/Schemas 부록.
- 예시는 언어 힌트 붙인 fenced code block(```json)으로. `include_examples` 옵션으로 on/off.
- 결정적 출력(태그·경로·메서드 정렬 규칙 고정) → 복사·diff 안정.
- 프론트: 생성 결과를 `react-markdown`(GFM plugin)로 프리뷰 + "Copy Markdown"(clipboard) / "Copy as HTML" 버튼.

### 7.2 Redoc 변환 (F3)
- `redoc` standalone 번들(`redoc.standalone.js`)을 앱 리소스로 로컬 포함.
- `render_redoc_html`이 `<redoc spec='...'>` + 인라인 번들로 **self-contained HTML** 생성 → `<iframe srcdoc>` 또는 별도 WebView 창에 표시.
- "Export as HTML" → 단일 HTML 파일 저장(오프라인 공유용).
- 확장 여지: 같은 자리에 Swagger UI / Scalar 렌더러를 선택지로(같은 spec JSON 소비).

### 7.3 HTTP Client (F4)
- `reqwest`(rustls) 사용 → 시스템 CA + CORS 없음.
- Request Builder: Method·URL·Params·Headers·Body(json/form/multipart/raw)·Auth 탭.
- Environment 변수 `{{baseUrl}}`, `{{token}}` 치환. Environment는 프로젝트 `environments/*.yaml`에 저장(활성 env는 `.apigen/config.yaml`). 시크릿 토큰은 커밋 제외를 권장(env 파일 분리 또는 `.gitignore` 가이드).
- 응답 뷰어: Pretty(JSON 트리)/Raw/Headers/시간·크기. 상태코드 색상.
- **스펙 연동:** Builder/Docs의 operation → `operation_to_request`로 프리필(경로 파라미터·예시 body 자동 삽입). 명세와 실호출의 일치를 즉석 확인.
- 히스토리: SQLite에 요청/응답 요약 저장, 재실행.

### 7.4 Example 편집 (F5)
- 4.3 표의 각 위치에 named example 탭 에디터.
- `value`(inline) / `externalValue`(URL) 전환.
- Components의 재사용 Example을 `$ref`로 연결하는 picker.
- 저장 시 스키마 검증 배지(7 참조).

### 7.5 Import/Export (F6) — 파일 트리 왕복
- **Import:** 파일 드롭/붙여넣기 → auto-detect(json/yaml) → `import_spec` → **`split_into_project`로 git 친화 트리 전개**(§4.5) → `open_project`.
- **Export:** `bundle_project`(트리→문서) → `export_spec`로 단일 `openapi.json`/`openapi.yaml` 저장. 결정적 직렬화.
- **저장(편집 중):** 바뀐 노드만 해당 파일에 기록(`save_request`/`save_example`/…) → git diff 최소.
- **왕복 불변식 테스트를 CI 필수 게이트로**(§4.5, §10): `split(bundle(tree)) ≈ tree`, `bundle(split(spec)) ≈ spec`(의미 동등).

---

## 8. 프로젝트 디렉토리 구조 (예정)

```
api-generator/
├─ docs/
│  └─ DESIGN.md                 ← (이 문서)
├─ src/                         ← React + TS 프론트
│  ├─ main.tsx
│  ├─ store/           (Zustand: spec SSOT, client env)
│  ├─ ipc/             (typed invoke 래퍼)
│  ├─ features/
│  │  ├─ builder/      (폼 기반 스펙 에디터)
│  │  ├─ raw/          (Monaco)
│  │  ├─ docs/         (markdown + redoc)
│  │  └─ client/       (http client)
│  └─ types/           (생성된 OAS 3.0 TS 타입)
├─ src-tauri/                   ← Rust 코어
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  └─ src/
│     ├─ lib.rs
│     ├─ commands/    (import/export/validate/markdown/redoc/http/project)
│     ├─ spec/        (openapiv3 wrap, 결정적 직렬화)
│     ├─ project/     (파일 트리 walk, bundle/split, $ref 경로 재작성 §4.5)
│     ├─ md/          (markdown 생성기)
│     ├─ http/        (reqwest 실행, 변수 치환)
│     ├─ examples/    (스키마 대비 예시 검증)
│     └─ store/       (project.yaml IO, rusqlite history)
├─ package.json
└─ vite.config.ts
```

---

## 9. 의존성 (초안)

### 9.1 Rust (`src-tauri/Cargo.toml`)
| crate | 용도 |
|-------|------|
| `tauri` (2.x) | 앱 셸, IPC |
| `openapiv3` | OAS 3.0 모델/직렬화 |
| `serde`, `serde_json` | JSON |
| `serde_yaml` (또는 `serde_yml`) | YAML import/export |
| `reqwest` (rustls-tls) | HTTP Client |
| `jsonschema` | 예시-스키마 검증 |
| `rusqlite` (bundled) | 요청 히스토리 |
| `thiserror` | `AppError` |
| `tokio` | 비동기 런타임(reqwest) |

### 9.2 Frontend (`package.json`)
| pkg | 용도 |
|-----|------|
| `react`, `react-dom` | UI |
| `@tauri-apps/api` | invoke |
| `zustand` | 상태(SSOT) |
| `monaco-editor` / `@monaco-editor/react` | Raw 편집 |
| `react-markdown` + `remark-gfm` | Markdown 프리뷰 |
| `redoc` (standalone 번들) | Redoc 렌더 |
| `react-hook-form` + `zod` | 폼 |
| `vite` | 번들러 |

> 버전 핀·라이선스 확인은 스캐폴딩 단계에서 실제 최신 안정 버전으로 고정(특히 `serde_yaml` 유지보수 상태, `openapiv3` 최신).

---

## 10. 개발 로드맵 (단계별 마일스톤)

| Phase | 목표 | 완료 기준(DoD) |
|-------|------|----------------|
| **P0. 스캐폴딩** | Tauri2 + React/TS + Rust 코어 골격, `ping` command 왕복 | 앱이 뜨고 IPC 왕복 확인 |
| **P1. 파일 트리 + Import/Export (F6)** | `bundle`/`split`/`import_spec`/`export_spec`/`validate_spec` + Raw(Monaco) 뷰 | 샘플 스펙 **split→bundle 왕복** 및 트리 IO 테스트 통과 |
| **P2. Builder (F1)** | 폼 기반 Folder/Request/Param/Response 편집, 부분 저장, SSOT 양방향 | Petstore를 GUI만으로 트리에 재현 |
| **P3. Examples (F5)** | 4.3 위치별 example 파일 편집 + 스키마 검증 배지 | 예시 불일치 경고 동작, 파일 1개=예시 1개 |
| **P4. Docs (F2, F3)** | `spec_to_markdown` + Copy, Redoc 렌더/Export | 마크다운·Redoc 산출물 확인 |
| **P5. HTTP Client (F4)** | `send_http_request`, Environment, operation 프리필, 히스토리 | Petstore 라이브 호출 성공 |
| **P6. 다듬기** | 에러 UX, 결정적 export 고정, 패키징(win/mac) | 릴리스 빌드 산출 |

각 Phase는 독립 검증 가능하도록 vertical slice로 진행.

---

## 11. 리스크 / 열린 질문

1. **`serde_yaml` 유지보수 중단 이슈** — 대체(`serde_yml`, `yaml-rust2`) 중 하나로 스캐폴딩 시 확정.
2. **`openapiv3` 결정적 직렬화** — `IndexMap` 순서 보존은 되나, Import 원본과 100% 바이트 동일은 보장 못 함(의미 동일까지만 목표). 라운드트립 테스트로 시맨틱 동등성 검증.
3. **Builder ↔ Raw 동기화 충돌** — Raw가 파싱 불가 상태일 때 Builder 편집 잠금 정책 필요.
4. **`$ref` 편집 UX** — 컴포넌트 참조/인라인 토글, 순환 참조 방지. 파일 상대경로 `$ref` ↔ JSON Pointer 재작성(§4.5) 정확성.
5. **Redoc 번들 라이선스/용량** — standalone 번들 크기(수 MB) 앱에 포함, 라이선스(MIT) 확인.
6. **예시 검증 성능** — 대형 스펙에서 전체 example 검증은 debounce + 대상 한정으로.
7. **폴더↔태그 왕복(§4.4)** — 중첩 폴더의 `x-folder` 확장 보존, 태그 없는 operation의 폴더 배치 기본 규칙(첫 path 세그먼트) 확정.
8. **파일명 충돌/정규화** — Request·example 이름 → 안전한 파일명(slug) 규칙, 대소문자 무시 FS(Windows/macOS)에서의 충돌, 트리 밖 경로 참조 차단.
9. **동시 편집 / 외부 git 변경** — 앱 사용 중 사용자가 git으로 파일을 바꿨을 때 리로드/감지 정책.

---

## 12. 다음 액션

이 문서 리뷰 후:
- 열린 질문(§11) 중 **YAML 크레이트 선택**만 확정하면 **P0 스캐폴딩** 착수 가능.
- 스캐폴딩은 `create-tauri-app`(React+TS 템플릿) → Rust 의존성 추가 → `ping` 왕복 순으로 진행.
