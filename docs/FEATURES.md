# 🪶 Plume — 기능 설명서

> Tauri 2 데스크톱 **API 설계 스튜디오**. OpenAPI 3.0 스펙을 GUI로 작성하고, 호출·부하테스트·문서화하며, git과 Bruno 호환 파일로 관리한다.
> 개발자용 코드 설명은 [IMPLEMENTATION.md](IMPLEMENTATION.md), 설계 배경은 [DESIGN.md](DESIGN.md).

---

## 0. 전체 구조 (내비게이션)

```
┌ 툴바: 🪶 Plume · 📁 폴더 열기 · 작업폴더 경로 · ⇅ Import/Export · [err N][warn N]
├ 좌측 LNB ────┬ 메인 영역 ───────────────────────────────────────────
│ 📦 Builder   │  (Builder일 때) 하위탭: Design · Call · Load · Docs
│ 🌐 Env       │
│ ⎇ Git        │
│ 🕘 History    │
└──────────────┴───────────────────────────────────────────────────────
```

- **작업 폴더**: 📁 폴더 열기(네이티브 다이얼로그)로 지정. Plume 프로젝트면 로드, 아니어도 작업 폴더로 설정(git·저장 대상).
- **err/warn 배지**: 현재 스펙의 검증 진단 개수. **클릭하면 진단 패널**이 열려 어디서(JSON Pointer) 무슨 문제인지 목록으로 보여준다.

---

## 1. Builder — 스펙 작성 (핵심)

Bruno식 **요청 중심** 화면. 좌측 컬렉션 트리, 우측 요청 탭 + 편집기.

### 1.1 Collection 트리 (좌측)
- **다중 컬렉션**: 상단 드롭다운으로 컬렉션 전환/추가(＋)/삭제(🗑). 컬렉션 = OpenAPI 문서 1개.
- **트리 구조**: `📦 컬렉션 → 📁 폴더(중첩) → 요청(메서드+경로)`. 폴더 접기/펼치기.
- **API 검색**: 🔍 검색창으로 경로·메서드·요약 필터(검색 중 폴더 자동 펼침).
- **우클릭 컨텍스트 메뉴**:
  - 컬렉션: 새 폴더 · 새 요청 · **이름 변경** · 붙여넣기
  - 폴더: 새 하위 폴더 · 새 요청 · 복사 · 붙여넣기 · **이름 변경** · 삭제
  - 요청: 열기 · **이름 변경**(메서드·경로 이동) · 복사 · 삭제
- **복사/붙여넣기**: 요청·폴더를 복사해 다른 위치에 붙여넣기(경로 충돌 시 `-copy`).

### 1.2 요청 탭 (multi-open)
- 트리에서 요청을 클릭하면 **탭으로 열림**(여러 개 동시). 탭 전환·닫기.

### 1.3 요청 편집 (RequestView)
URL 바(메서드 배지 + `{{baseUrl}}/path` + **Send**) + 서브탭:

| 서브탭 | 내용 |
|--------|------|
| **Params** | query/path 파라미터 (이름·위치·타입·필수·설명) |
| **Body** | Content-Type 선택 + JSON 본문(Send 페이로드 겸 예시) + 필드 스키마 + **named examples** |
| **Headers** | 요청 헤더 key-value (필수 여부 포함) |
| **Auth** | None / Bearer / Basic (Send에 적용, `{{token}}` 환경변수 사용 가능) |
| **Script** | **Pre-request / Post-response 자바스크립트** (아래 1.4) |
| **Responses** | 상태코드별 응답 — 빠른추가 버튼(200/201/400/401/403/404/409/500 등) + 설명 + 필드 스키마 + **named examples** |
| **Docs** | summary · description · tags · 폴더(x-folder) |

**필드 편집**은 표로: 이름 · 타입(string/integer/number/boolean/object/array) · 설명 · **필수**(required) · **nullable**.
**named examples**는 예시를 여러 개(이름별) — 요청 본문·응답 상태코드마다 등록 가능.

### 1.4 Pre/Post 스크립트 (JavaScript)
Bruno/Postman처럼 요청에 스크립트를 붙인다.
- **Pre-request**: 요청 전 실행. `req.setHeader(k,v)`, `bru.setEnvVar(k,v)` 등으로 요청·변수 조작.
- **Post-response**: 응답 후 실행. `res.status/body/headers` 읽고 `bru.setEnvVar('token', res.body.token)`로 **토큰 저장** 등.
- **Script Console**에 `console.log` 출력 표시.
- 주입 객체: `bru`(환경/런타임 변수), `req`(pre), `res`(post), `console`.

---

## 2. Call — HTTP 클라이언트

요청을 직접 호출(Try). **`reqwest`(Rust)로 실행되어 CORS 제약이 없다** (브라우저 fetch 대비 강점).

- 메서드·URL·헤더·바디·인증 지정 → **Send** → 응답(상태/시간/크기/본문 pretty JSON).
- **코드 스니펫**: 요청을 **curl · javascript · python · csharp · java · kotlin** 코드로 자동 생성(요청 변경 시 실시간). 복사 버튼.
- 트리에서 요청 클릭 시 URL 프리필. History에서 재실행.

---

## 3. Load — 부하 테스트

동시성 부하 테스트(Postman/k6 유사). **3가지 모드**:
- **단일 요청**: 하나의 요청을 반복.
- **폴더 그룹**: 선택한 폴더의 모든 요청을 라운드로빈.
- **커스텀 선택**: 여러 폴더에 흩어진 요청을 **체크박스로 골라** 그룹 구성.

설정: 요청 수 · 동시성(가상 사용자, 최대 64). 결과 통계:
**총/성공/실패 · RPS · 총시간 · avg/min/max · p50/p95/p99 · 상태코드 분포**.

---

## 4. Docs — 문서화

세 가지 뷰:
- **Markdown**: GFM 문서(examples/schemas 옵션) — 우측 상단 📋 아이콘으로 복사.
- **Redoc**: 렌더 + **GitHub Pages 생성**(`docs/index.html`).
- **Swagger**: Swagger UI 임베드 — **내장 "Try it out"** 으로 실행(브라우저 fetch라 대상 API의 CORS 필요; CORS-free는 Call 탭).

---

## 5. Environment — 환경 변수

- 좌측 환경 목록(🌐, 변수 개수) + ＋ 새 환경.
- 우측 변수 표(Key/Value) 편집. `{{baseUrl}}`, `{{token}}` 처럼 URL·헤더·바디에서 참조.
- **프로젝트에 저장**(`environments/*.yaml` + 활성 환경).

---

## 6. Import / Export (툴바 ⇅)

모달로 열리는 2-카드:
- **Import**: OpenAPI 3.0(JSON/YAML) 붙여넣기 → 활성 컬렉션에 / 새 컬렉션으로.
- **Export**: `openapi.yaml`·`openapi.json`(클립보드) · **.bru 컬렉션**(Bruno 파일 트리) · **Redoc HTML**.

---

## 7. Git — Sourcetree 스타일

작업 폴더의 git 저장소를 다룬다.
- **상태 바**: ⎇ 브랜치 · ahead/behind · Fetch · Pull · Push · 새로고침.
- **Branches**: 목록(현재 강조), 클릭=체크아웃, ＋ 새 브랜치, × 삭제.
- **Remotes**: 원격 목록(name+URL), **연결**(remote add), ↑(push -u), × 제거.
- **변경 사항**: **Unstaged / Staged 분리** — 파일별 stage(+)/unstage(−)/discard(⨯), 클릭 시 **diff 뷰**(색상). Stage All.
- **Commit**: 스테이지된 것만 커밋.
- **History**: **로그**(해시·제목·작성자·날짜) / **그래프**(ASCII 커밋 그래프) 토글.
- git 저장소 아니면 `git init` 버튼.

---

## 8. History — 호출 기록

- Call에서 보낸 요청을 **최신순 기록**(메서드·URL·상태·시간).
- 항목 클릭 → **Call 탭에서 프리필**. 비우기.

---

## 9. 파일 형식 (git 친화)

프로젝트 = 디렉토리(파일 1개 = 논리 단위 1개):
```
project.yaml                     # info / servers
folders/<폴더>/<요청>/request.yaml
        └ examples/<name>.yaml   # 예시 1개 = 파일 1개
components/{schemas,responses,...}/*.yaml
environments/*.yaml
.apigen/config.yaml              # 활성 환경 등
```
- **폴더는 태그와 독립**(operation의 `x-folder` 확장, 빈 폴더는 `x-folders`로 영속화).
- Export 시 단일 `openapi.yaml`로 번들. Import 시 트리로 전개(split).

---

## 10. 배포

```bash
pnpm install && pnpm tauri dev      # 개발 실행
pnpm tauri build                    # 설치파일 (src-tauri/target/release/bundle/)
git tag v0.1.0 && git push --tags   # GitHub Actions → 3-OS 설치파일 릴리스
```
