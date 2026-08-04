# 🪶 Plume — 구현 설명서 (코드 워크스루)

> 구현된 코드를 모듈 단위로 설명한다. 기능 관점은 [FEATURES.md](FEATURES.md), Rust 문법 해설은 [RUST-SYNTAX.md](RUST-SYNTAX.md), 설계 배경은 [DESIGN.md](DESIGN.md).

---

## 1. 3층 구조

```
crates/apigen-core/   순수 Rust 도메인 코어 (Tauri 무관, 테스트됨)
src-tauri/            Tauri 어댑터 — #[tauri::command] 얇은 IPC 중계
src/                  React + TS 프론트 (Zustand SSOT)
```

**원칙**: 도메인 로직은 전부 코어에. 어댑터는 `Value ↔ OpenAPI` 변환 후 코어 호출만. 프론트는 UI 상태와 렌더만.
**SSOT**: OpenAPI 문서 그 자체. 프론트는 JS 객체(`spec`), 경계는 `serde_json::Value`, 코어는 `openapiv3::OpenAPI` 강타입.

---

## 2. 코어 모듈 (`crates/apigen-core/src/`)

| 모듈 | 책임 | 핵심 |
|------|------|------|
| `error.rs` | 에러 타입 | `CoreError`(thiserror `#[from]`) → `AppError`(직렬화). `Result<T>` 별칭 |
| `model.rs` | 온디스크 파일 스키마 | `ProjectFile`·`FolderFile`·`RequestFile`(flatten Operation)·`ExampleFile`(target). `Diagnostic` |
| `project.rs` | **파일트리 ↔ 문서** | `bundle`/`split`, `$ref` 정규화, 폴더=x-folder, 빈폴더=x-folders, 환경 IO(ClientConfig) |
| `markdown.rs` | 문서 → GFM | `to_markdown` 순수함수(정렬 고정 → 결정적) |
| `http.rs` | HTTP 실행 | `reqwest::blocking`, `{{var}}` 치환, `BodySpec`/`AuthSpec`/`Environment` (No CORS) |
| `validate.rs` | 시맨틱 검증 | operationId 중복·응답 없음·경로파라미터 미선언 → `Vec<Diagnostic>` |
| `bru.rs` | **Bruno `.bru` 코덱** | 블록 파서(중괄호 깊이)·시리얼라이저, HttpRequest 브릿지, 컬렉션 export |
| `snippet.rs` | 코드 스니펫 | curl/javascript/python/csharp/java/kotlin, `{{var}}` 치환 |
| `publish.rs` | GitHub Pages | `docs/index.html`(Redoc) 생성 + `git_publish` |
| `git.rs` | **Git** | status/log/graph/stage/unstage/commit/push/pull/branch/**remote** (git CLI 래핑) |
| `load.rs` | **부하 테스트** | `run_load`/`run_load_group`(스레드풀 라운드로빈, p50/p95/p99/rps) |
| `lib.rs` | 엔트리 | 모듈·재노출·`import_spec`/`export_spec`·통합 테스트 |

### 2.1 핵심 파이프라인 — `project.rs`
```
파일트리(SSOT, git) ──bundle──▶ openapiv3::OpenAPI ──export──▶ openapi.yaml
      ▲                              │
      └──────── split ───────────────┘
```
- **bundle**: `project.yaml` → 헤더, `components/**` → `#/components/*`(제네릭 `load_dir<T>`), `folders/**` walk → operation(폴더를 `x-folder` 확장으로 주입, 빈 폴더는 `x-folders` 루트 배열로), examples 파일을 `target`에 결합. 마지막에 **`$ref` 정규화**(`serde_json::Value`로 낮춰 문자열만 재작성).
- **split**: 태그/first-path로 폴더 배치, operation→request.yaml, named example→개별 파일, 폴더 마커 `_folder.yaml`.
- **불변식**: `split(bundle(tree)) ≈ tree`(의미 동등) — `lib.rs` 테스트로 강제.

### 2.2 `bru.rs` — Bruno 호환
- `parse_blocks`: `name { ... }` 블록을 **중괄호 깊이 추적**으로 파싱(body:json 내부 `{}` 안전).
- `BruRequest ↔ HttpRequest` 브릿지, `export_collection`으로 `bruno.json` + 폴더별 `.bru` 생성.

### 2.3 `load.rs` — 부하 테스트
- `run_load_group`: `concurrency`개 스레드가 `AtomicUsize` 카운터로 작업을 나눠 `send`(reqwest blocking), `Mutex`로 지연 수집. `run_load`는 단일요청 래퍼. 라운드로빈으로 여러 요청 분산.
- percentile = `round(p*(n-1))` 인덱스.

---

## 3. Tauri 어댑터 (`src-tauri/src/`)

- `commands.rs`: **`#[tauri::command]` ~40개** — 전부 코어 위임. `to_spec`(Value→OpenAPI)/`from_spec` 헬퍼. `Result<T, AppError>` 반환(Err는 JS로 reject).
- `lib.rs`: `tauri::Builder` + `.plugin(tauri_plugin_dialog::init())` + `generate_handler![...]` + `generate_context!`.
- 커맨드 그룹: 스펙 IO/검증 · 마크다운/Redoc · HTTP · 프로젝트(bundle/split) · 환경 · **.bru** · 스니펫 · **부하(run_load, run_load_group)** · GitHub Pages · **Git(status/log/graph/stage/unstage/discard/commit/push/pull/fetch/branch/checkout/remote×4/push_upstream)**.
- 규약: JS camelCase 인자 → Rust snake_case 자동 매핑. 동기 커맨드는 별도 스레드 → `reqwest::blocking`·`Command` 안전.

---

## 4. 프론트엔드 (`src/`)

### 4.1 상태·유틸
- **`store.ts`** (Zustand SSOT): `collections[]`+`activeCollectionId`(spec는 활성 미러) · `gnb`/`builderTab` 내비 · `openTabs`/`activeTab`(요청 탭) · `environments`/`activeEnvId` · `clipboard`(복사/붙여넣기) · `runtimeVars`(스크립트) · `history`+`prefillRequest` · `diagnostics`.
  - 유틸: `buildTree`(x-folder→중첩 트리) · `specFolders`(x-folders∪operation) · `opFolder` · `listOperations` · `tabKey`.
  - `updateSpec(fn)`: structuredClone→mutate→set + `revalidate`(백그라운드 `validate_spec`).
- **`ipc.ts`**: `invoke` 타입 세이프 래퍼(커맨드 1:1) + 타입(Spec/Diagnostic/HttpRequestSpec/GitStatus/LoadResult 등).
- **`dialog.ts`**: `pickDirectory`(tauri-plugin-dialog 동적 import, 브라우저선 null).
- **`script.ts`**: `runScript`(`new Function`으로 bru/req/res/console 주입, WebView 실행).

### 4.2 컴포넌트 (`src/features/`)
| 파일 | 역할 |
|------|------|
| `App.tsx` | 툴바 · 좌측 LNB · Builder 하위탭 · Import/Export·진단 모달 |
| `Builder.tsx` | 좌 CollectionTree / 우 브레드크럼+요청탭+RequestView. 트리 변이(생성/이름변경/삭제/복사붙여넣기)·컨텍스트 메뉴·다이얼로그 |
| `RequestView.tsx` | URL바+Send + 서브탭(Params/Body/Headers/Auth/Script/Responses/Docs) + 응답. Pre/Post 스크립트 실행 |
| `CollectionTree.tsx` | 재사용 트리 + 우클릭 메뉴(`menuFor` 주입) + `filter`(검색) |
| `SchemaEditor` / `ParamsEditor` / `ExamplesEditor` | 필드표 / 파라미터표 / named example 편집 |
| `Client.tsx` | HTTP 클라이언트(Send·자동 코드스니펫·History 기록) |
| `Load.tsx` | 부하 테스트(단일/폴더/커스텀 체크리스트) |
| `Docs.tsx` | Markdown(복사 아이콘)/Redoc/Swagger + GitHub Pages |
| `Environments.tsx` | 환경·변수 편집 |
| `ImportExport.tsx` | 2-카드 Import/Export 모달 |
| `Git.tsx` | Sourcetree식 Git(브랜치·원격·스테이징·diff·커밋·로그/그래프) |
| `History.tsx` | 호출 기록 목록 → Call 프리필 |

### 4.3 주요 데이터 흐름
```
편집  Builder/RequestView → updateSpec → store.spec(활성 컬렉션) → revalidate(validate_spec) → err/warn 배지
호출  Call/RequestView → build HttpRequest → invoke(send_http_request) → reqwest(No CORS) → 응답 + History
저장  splitIntoProject(spec) → 파일트리 → export_project → openapi.yaml
Git   Git 탭 → invoke(git_*) → git CLI(작업 폴더)
```

---

## 5. 테스트 & 빌드

- 코어 **`cargo test -p apigen-core`**: bundle/split 왕복·예시부착·중첩폴더·빈폴더·환경·마크다운·검증·`.bru` 왕복·스니펫·부하 percentile·git(init/status/stage/unstage/commit/diff/discard) 등 **20+개**.
- 어댑터 **`cargo check -p api-generator`**: 전체 Tauri 스택 + dialog 플러그인 컴파일.
- 프론트 **`pnpm build`**(tsc + vite): 타입·번들.
- CI **`.github/workflows/release.yml`**: 태그 push → 3-OS 설치파일.

## 6. 다음에 손댈 지점
- 다중 컬렉션 **온디스크 워크스페이스** 저장/로드(현재 인메모리).
- named example UI ↔ 스펙 동기화 강화, `x-codeSamples` 주입(Redoc 코드 표시).
- 요청 히스토리 **SQLite 영속화**(현재 세션 인메모리), 예시-스키마 검증(`jsonschema`).
- Monaco/Redoc/Swagger **오프라인 로컬 번들**(현재 CDN).
