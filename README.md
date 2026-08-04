# 🪶 Plume — API Design Studio

Tauri 2 기반 **OpenAPI 3.0 스펙 에디터 · 문서 뷰어 · HTTP 클라이언트**. (구 "API Generator")
GUI로 API 명세서를 작성하고, Markdown/Redoc으로 렌더하고, 그 API를 곧바로 호출한다.
프로젝트는 **git 친화적 파일 트리**(Folder → Request → example 파일)로 저장되고, 단일 `openapi.yaml`로 Export된다.

## 문서
- **[docs/FEATURES.md](docs/FEATURES.md)** — 모든 기능 설명 (사용자용)
- **[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)** — 구현 코드 워크스루 (개발자용)
- [docs/DESIGN.md](docs/DESIGN.md) — 설계(데이터 모델, 커맨드 명세, 로드맵)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 초기 빌드 구조·데이터 흐름
- [docs/RUST-SYNTAX.md](docs/RUST-SYNTAX.md) — 코드에서 쓴 Rust 문법 해설

## 구조
```
crates/apigen-core/   순수 Rust 도메인 코어 (Tauri 무관, 테스트됨)
src-tauri/            Tauri 어댑터 (#[tauri::command] IPC)
src/                  React + TS 프론트 (Builder / Raw / Docs / Client)
```

## 요구 사항
- Rust 1.95+, Node 20+, pnpm 10+
- (데스크톱 구동 시) Tauri 시스템 의존성: Windows는 WebView2 런타임

## 개발
```bash
pnpm install                       # 프론트 의존성
cargo test -p apigen-core          # 코어 로직 테스트 (6 passed)
pnpm build                         # 프론트 프로덕션 빌드 → dist/
pnpm tauri dev                     # 데스크톱 앱 개발 실행 (@tauri-apps/cli)
pnpm tauri build                   # 릴리스 번들
```

> `cargo-tauri` 전역 CLI 없이 `pnpm tauri ...`(로컬 @tauri-apps/cli)로 실행한다.

## 현재 상태
| 레이어 | 상태 |
|--------|------|
| 코어(bundle/split·markdown·http·validate) | ✅ 구현 + 테스트 |
| Tauri 커맨드 11종 | ✅ 컴파일 |
| React UI 4탭 | ✅ 빌드·렌더 |
| 데스크톱 창 실물 구동 | ⏳ 로컬에서 `pnpm tauri dev`로 확인 |

미구현(로드맵): 예시-스키마 검증(jsonschema), 요청 히스토리(SQLite), 파일 다이얼로그, Monaco 로컬 번들, Redoc 오프라인 리소스. 자세한 내용은 [ARCHITECTURE.md §6–7](docs/ARCHITECTURE.md).
