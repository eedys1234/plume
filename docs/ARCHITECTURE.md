# 아키텍처 설명 (as-built)

> 실제로 빌드·테스트된 코드 기준. 설계 의도는 [DESIGN.md](DESIGN.md), 코드 문법 해설은 [RUST-SYNTAX.md](RUST-SYNTAX.md).

---

## 1. 3층 구조 한눈에

```
┌─ React + TS (WebView) ──────────── src/ ────────────────────────────┐
│  App.tsx        4개 탭 셸 + 프로젝트 툴바(New/Open/Export)          │
│  store.ts       Zustand: spec(SSOT) · env · diagnostics             │
│  ipc.ts         invoke() 타입 세이프 래퍼 (커맨드 1:1)              │
│  features/      Builder · Raw · Docs · Client                       │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │  Tauri IPC (invoke, camelCase→snake_case)
┌─ Tauri 어댑터 ───────────── src-tauri/src/ ─────────────────────────┐
│  lib.rs         Builder + invoke_handler![] 커맨드 등록             │
│  commands.rs    #[tauri::command] 11개 — 전부 코어로 위임(얇음)     │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │  일반 Rust 함수 호출 (Value ↔ OpenAPI)
┌─ 순수 도메인 코어 ─── crates/apigen-core/src/ (Tauri 의존 없음) ────┐
│  project.rs   파일트리 ↔ 문서: bundle / split / $ref 정규화         │
│  markdown.rs  문서 → GFM 마크다운                                   │
│  http.rs      reqwest 실행 · {{var}} 치환 (CORS 없음)               │
│  validate.rs  시맨틱 검증 → Diagnostic[]                            │
│  model.rs     온디스크 파일 스키마(serde 구조체) + Diagnostic       │
│  error.rs     CoreError(thiserror) → AppError(직렬화)               │
│  lib.rs       import/export + 재노출 + 통합 테스트                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 왜 코어를 별도 크레이트로 분리했나 (설계에서 추가한 결정)
- **테스트 속도:** `cargo test -p apigen-core`는 Tauri/WebView/Node 없이 4분(최초)·0.1초(증분)에 6개 테스트를 돈다. 도메인 로직을 UI 셸과 분리했기에 가능.
- **재사용:** 동일 코어를 나중에 CLI(`apigen bundle ./proj -o openapi.yaml`)로 그대로 재사용 가능.
- **의존성 격리:** 코어는 `openapiv3/serde/reqwest`만 안다. Tauri는 코어를 모른 채 IPC만 중계. 어댑터(`commands.rs`)가 얇아진다.

---

## 2. 단일 진실 원천(SSOT)과 데이터 흐름

**원칙: OpenAPI 문서 자체가 유일한 모델이다.** 별도 "에디터 모델"이 없다.

- **프론트**에서 SSOT는 `store.ts`의 `spec` (평범한 JS 객체 = OAS JSON).
- **경계**를 넘을 때는 `serde_json::Value`로 직렬화 (`ipc.ts` ↔ `commands.rs`).
- **코어**에서는 `openapiv3::OpenAPI` 강타입으로 승격해 로직 수행 후 다시 `Value`로 낮춘다.

```
편집(Builder/Raw)
   │ updateSpec(draft => …)         structuredClone 후 mutate → 새 참조
   ▼
store.spec (JS 객체, SSOT)
   │ invoke("validate_spec", {spec})  ← 300ms 디바운스 대신 매 변경마다(코어가 빠름)
   ▼
commands.rs: to_spec(Value) → OpenAPI → validate() → Vec<Diagnostic> → 프론트 배지
```

파생 뷰(Markdown/Redoc)는 절대 편집하지 않고 `spec`에서 생성만 한다. → 동기화 버그 원천 차단.

---

## 3. 핵심 파이프라인: 파일 트리 ↔ 단일 문서

이 앱의 심장. `project.rs`에 있다.

### bundle (트리 → `OpenAPI`)
```
project.yaml ─────────────► OpenAPI { info, servers }
components/**/*.yaml ──────► #/components/*  (제네릭 load_dir<T>)
folders/**/request.yaml ──► paths[path].{method} = Operation
        examples/*.yaml ──► content[mt].examples[name]  (target으로 부착)
                              │
                              ▼
      normalize_refs: 전체를 JSON Value로 → "$ref" 문자열 재작성 → 역직렬화
```
- **폴더 = x-folder(태그와 독립):** `walk_folder`가 디렉토리 경로를 operation의 `x-folder` 확장으로 주입(중첩은 `users/admin`). 태그는 건드리지 않는다. split은 `x-folder`>첫 태그>첫 path 세그먼트 순으로 배치.
- **`$ref` 정규화 트릭:** openapiv3 트리를 손으로 재귀 순회하지 않는다. `serde_json::to_value`로 통째 낮춘 뒤 `"$ref"` 문자열만 고치고 다시 올린다(`normalize_refs`). 견고하고 20줄.

### split (문서 → 트리)
```
OpenAPI ──► project.yaml + components/**  (파일별 1개)
        ──► 각 operation → folders/<tag>/<opId>/request.yaml
        ──► 각 named example → .../examples/<name>.yaml (target 포함)
```
- 참조는 `#/...` JSON Pointer 그대로 유지 → bundle이 손실 없이 복원.
- 결정성: path·method 정렬, 디렉토리 읽기 정렬(`sorted_subdirs`) → 같은 문서는 항상 같은 트리.

### 왕복 불변식 (테스트로 강제)
`lib.rs`의 `split_bundle_is_stable` 테스트가 `bundle(split(bundle(tree)))` 안정성을 검증한다. 바이트 동일이 아니라 **의미 동일**(serde_json::Value 비교)이 목표.

```
Import 흐름:  import_spec(text) → split_into_project(dir) → open_project(dir)
Export 흐름:  split_into_project(dir, spec) → export_project(dir) → openapi.yaml
```

---

## 4. IPC 경계 상세

| 프론트 (`ipc.ts`) | Tauri (`commands.rs`) | 코어 |
|---|---|---|
| `api.importSpec(text, fmt)` | `import_spec` | `core::import_spec` |
| `api.exportSpec(spec, fmt)` | `export_spec` | `core::export_spec` |
| `api.validateSpec(spec)` | `validate_spec` | `validate::validate` |
| `api.specToMarkdown(...)` | `spec_to_markdown` | `markdown::to_markdown` |
| `api.renderRedocHtml(spec)` | `render_redoc_html` | (HTML 조립) |
| `api.sendHttpRequest(req,env)` | `send_http_request` | `http::send` |
| `api.openProject(dir)` | `open_project` | `project::bundle` |
| `api.newProject(...)` | `new_project` | `project::split`+`bundle` |
| `api.splitIntoProject(...)` | `split_into_project` | `project::split` |
| `api.exportProject(...)` | `export_project` | `bundle`+`export_spec` |

**규약 3가지:**
1. **인자 키 변환:** JS `includeExamples` → Rust `include_examples` (Tauri 자동 camel↔snake).
2. **에러:** 코어 `CoreError` → `AppError { code, message }`(직렬화) → 프론트 `catch (e) { e.message }`.
3. **문서 형태:** 경계는 항상 `Value`. 강타입 승격/강하는 `to_spec`/`from_spec` 헬퍼가 담당.

---

## 5. HTTP 클라이언트가 CORS를 피하는 이유

`http.rs`는 `reqwest::blocking`을 쓴다. 요청은 **브라우저가 아니라 Rust 프로세스**가 보낸다.
- 브라우저 fetch였다면 대상 API의 CORS 헤더에 막힌다(Postman 웹의 고질병).
- Tauri는 non-async 커맨드를 별도 스레드에서 실행하므로 `blocking` reqwest를 그대로 써도 async 런타임을 막지 않는다.
- `{{baseUrl}}`, `{{token}}` 치환은 코어의 `substitute()`가 활성 Environment 변수로 수행하고, **미해결 변수는 요청 전에 에러**로 만든다.

---

## 6. 빌드·검증 상태

| 레이어 | 명령 | 결과 |
|---|---|---|
| 코어 | `cargo test -p apigen-core` | **8 passed** (왕복·예시부착·중첩폴더·환경설정·마크다운·검증·치환) |
| 어댑터 | `cargo check -p api-generator` | **Finished** (전체 Tauri 스택 컴파일) |
| 프론트 | `pnpm build` (tsc + vite) | **built** (295 modules, dist 생성) |
| UI 렌더 | vite preview + 브라우저 | 4탭·폼·배지 정상 렌더 확인 |

### 아직 남은 것(정직하게)
- **실제 데스크톱 창 구동**(`pnpm tauri dev`)은 이 환경에서 미실행. 어댑터 컴파일까지는 검증됨.
- **Monaco**: v1은 textarea. 오프라인 로컬 번들 통합이 업그레이드 포인트.
- **Redoc**: 미리보기는 CDN iframe. 완전 오프라인엔 `redoc.standalone.js` 로컬 리소스 필요.
- **파일 다이얼로그**: 지금은 경로 입력. `tauri-plugin-dialog` 도입 예정.
- **예시-스키마 검증**(`jsonschema`), **히스토리 SQLite**: 설계엔 있으나 미구현(로드맵 P3/P5).

---

## 7. 다음에 손댈 지점 (파일 단위)

- 파라미터/요청본문 스키마 편집 UI 강화 → `features/Builder.tsx`
- 예시 저장 시 스키마 검증 배지 → `crates/apigen-core/src/examples.rs`(신설) + `validate.rs`
- 부분 저장(`save_request`/`save_example`) 커맨드 → `commands.rs` + `project.rs`
- 요청 히스토리 → `crates/apigen-core/src/store.rs`(신설, rusqlite)
