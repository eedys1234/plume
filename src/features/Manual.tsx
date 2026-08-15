// 앱 내장 사용자 매뉴얼. 툴바 📖 버튼으로 열리는 모달(좌측 목차 + 우측 내용).
import { useRef } from "react";
import { COMMANDS, effectiveCombo, comboTokens } from "../keybindings";

type Block =
  | { p: string }
  | { list: string[] }
  | { steps: string[] }
  | { tip: string }
  | { warn: string }
  | { sub: string };

interface Section { id: string; icon: string; title: string; blocks: Block[]; }

const SECTIONS: Section[] = [
  {
    id: "start", icon: "🚀", title: "시작하기",
    blocks: [
      { p: "Plume은 OpenAPI 3.0 기반의 API 설계·문서·테스트 데스크톱 도구입니다. 요청을 트리로 관리하고, 실제로 호출하고, 문서·배포까지 한 곳에서 처리합니다." },
      { sub: "프로젝트 폴더와 워크스페이스" },
      { steps: [
        "상단 '📁 프로젝트 폴더 선택'으로 작업할 상위 폴더를 지정합니다.",
        "그 폴더 안의 각 하위 폴더가 '워크스페이스'가 됩니다. 상단 워크스페이스 전환기로 오가고, ＋로 새로 만듭니다.",
        "워크스페이스 = 여러 컬렉션 + 환경변수 + 체인 묶음. 파일로 저장되어 git으로 버전 관리할 수 있습니다.",
      ] },
      { tip: "변경은 2초 뒤 자동 저장됩니다. 수동 저장은 Ctrl/⌘+S." },
    ],
  },
  {
    id: "tree", icon: "📦", title: "컬렉션 · 요청 트리",
    blocks: [
      { p: "좌측 트리에 컬렉션 → 폴더 → 요청이 계층으로 표시됩니다. 여러 컬렉션을 동시에 열 수 있습니다." },
      { list: [
        "요청 클릭 = 탭으로 열기. 폴더 클릭 = 접기/펼치기.",
        "우클릭: 새 폴더·요청 · 이름변경 · 복사 · 삭제 · Pre/Post 스크립트 정의.",
        "드래그: 요청을 다른 폴더·컬렉션으로 이동.",
        "검색창: 경로·메서드·요약·태그로 필터.",
        "정렬: 기준(경로 / 요청 이름 / 폴더명 / 메서드) + 오름/내림 아이콘.",
      ] },
      { tip: "요청이 아주 많은 컬렉션은 최초 로드 시 폴더가 접힌 채 열립니다(빠른 로딩)." },
    ],
  },
  {
    id: "request", icon: "🔗", title: "요청 만들기 · 보내기",
    blocks: [
      { p: "요청 탭 상단의 URL 바에서 메서드와 경로를 정하고, 아래 서브탭에서 상세를 채운 뒤 Send로 실제 호출합니다." },
      { sub: "URL과 변수" },
      { list: [
        "URL에 {{변수}}를 쓰면 환경변수/런타임변수로 치환됩니다(예: {{baseUrl}}/users).",
        "URL의 {{변수}}를 클릭하면 값 편집 + 다른 환경변수로 교체할 수 있습니다.",
      ] },
      { sub: "서브탭" },
      { list: [
        "Params/Headers: 키·값·필수 여부 편집.",
        "Auth: None / Basic / Bearer / API Key (요청에 저장).",
        "Body: Content-Type + 스키마↔JSON 자동 동기화(필드 추가/삭제 반영).",
        "Responses: 상태코드별 응답 스키마·예시.",
        "Script: Pre-request / Post-response JS(아래 스크립트 참고).",
        "Tests: 응답 검증(아래 테스트 참고).",
        "Snippet: curl · JS · Python · C# · Java · Kotlin 코드 생성.",
      ] },
      { sub: "응답" },
      { list: [
        "우측 응답 패널에 Response(본문) / Headers / Timeline / (Tests) 탭.",
        "본문은 Pretty ↔ Raw 토글, 상태·시간·크기 표시, 파일 다운로드 지원.",
      ] },
    ],
  },
  {
    id: "script", icon: "🧪", title: "스크립트 · 테스트",
    blocks: [
      { p: "요청 전후에 JS를 실행해 변수를 만들거나 응답을 검증할 수 있습니다(Bruno/Postman 유사)." },
      { sub: "Pre / Post 스크립트 (Script 탭)" },
      { list: [
        "bru.setEnvVar('token', res.body.token) — 응답에서 토큰을 뽑아 환경변수로 저장.",
        "req.setHeader('X-Time', String(Date.now())) — 요청 전 헤더 주입.",
        "컬렉션/폴더 레벨 스크립트도 우클릭으로 정의(공통 처리).",
      ] },
      { sub: "Tests 탭 (응답 검증)" },
      { list: [
        "test('상태 200', () => { expect(res.status).toBe(200); }) 형태로 작성.",
        "matcher: toBe · toEqual · toBeTruthy · toContain · toHaveLength · toBeGreaterThan · toMatch · .not 등.",
        "Send 후 우측 응답 Tests 탭에 통과/실패가 표시됩니다.",
      ] },
    ],
  },
  {
    id: "env", icon: "🌐", title: "환경변수 (Env)",
    blocks: [
      { p: "환경(예: local, dev, prod)별로 변수를 관리합니다. 활성 환경의 값으로 {{변수}}가 치환됩니다." },
      { list: [
        "요청용 변수 / 스크립트용 변수 탭으로 구분.",
        "Bruno · Postman 환경변수 import 지원.",
        "환경 우클릭으로 삭제, 아이콘으로 새 환경·가져오기.",
      ] },
      { tip: "환경 변경은 프로젝트가 열려 있으면 자동 저장됩니다." },
    ],
  },
  {
    id: "chain", icon: "⛓", title: "API Call Chain",
    blocks: [
      { p: "여러 요청을 순서대로 실행하고, 그 흐름을 시퀀스 다이어그램으로 표현합니다." },
      { steps: [
        "＋로 체인 생성 → 좌측 트리에서 요청을 클릭해 스텝으로 추가.",
        "▶ 실행: 각 스텝을 순차 호출. Post-response 스크립트로 변수를 다음 스텝에 전달(로그인→토큰→인증).",
        "스텝별 상태·시간 배지 표시, '실패 시 중단' 옵션.",
      ] },
      { list: [
        "시퀀스 다이어그램은 .mermaid / .svg / .png 로 내보내기.",
        "다이어그램 주체(요청측/응답측) 명칭을 체인별로 변경 가능.",
      ] },
    ],
  },
  {
    id: "run", icon: "⚡", title: "Run (부하 실행)",
    blocks: [
      { p: "단일 요청 · 폴더 · 선택한 요청들을 반복(iterations)·동시성(concurrency)으로 실행해 응답 통계를 봅니다." },
    ],
  },
  {
    id: "docs", icon: "📖", title: "Specification (문서 · 배포)",
    blocks: [
      { p: "컬렉션을 Markdown · Redoc · Swagger 문서로 보고, 파일로 내보내거나 웹에 배포합니다." },
      { list: [
        "대상: 특정 컬렉션 또는 '전체(모든 컬렉션 병합)'.",
        "내보내기: OpenAPI YAML/JSON · Postman · Bruno · 단일 HTML.",
        "배포: 🚀 GitHub Pages / ☁ CloudFront(S3) — 버튼 하나로.",
      ] },
      { tip: "CloudFront 배포 설정은 Settings에서(자격증명은 암호화 로컬 저장)." },
    ],
  },
  {
    id: "git", icon: "⎇", title: "Git",
    blocks: [
      { p: "작업 폴더를 git으로 관리합니다(Sourcetree 유사)." },
      { list: [
        "스테이지/언스테이지(파일별) · diff · 커밋 · 히스토리/그래프.",
        "브랜치 전환·생성, 원격 연결·push/pull/fetch.",
        "Stash: 변경사항 임시 저장/복원.",
        "Worktree: 브랜치별 체크아웃을 목록/추가/제거하고 '열기'로 앱에서 바로 전환.",
      ] },
    ],
  },
  {
    id: "history", icon: "🕘", title: "History",
    blocks: [
      { p: "이벤트 로그와 HTTP 요청 히스토리를 확인합니다. 과거 요청을 다시 열어 재사용할 수 있습니다." },
    ],
  },
  {
    id: "settings", icon: "⚙", title: "Settings",
    blocks: [
      { list: [
        "☁ CloudFront 배포: region · 버킷 · 배포 ID · 무효화 경로 · 뷰어.",
        "🔑 AWS 자격증명: Access Key/Secret · Session Token · IAM Role ARN(AssumeRole). 앱 설정 폴더에 암호화 저장(git·워크스페이스에 미포함).",
        "⬆ 업데이트: 앱 버전 표시 + GitHub 저장소(owner/repo) 기반 최신 태그 확인. 저장소는 유동 변경 가능.",
        "⌨ 단축키: 항목별 재매핑(변경/기본/전체 기본값), 충돌 표시.",
      ] },
    ],
  },
  {
    id: "misc", icon: "💾", title: "자동 저장 · 되돌리기",
    blocks: [
      { list: [
        "자동 저장: 변경 2초 뒤 워크스페이스에 저장(데이터 유실 방지). 변경분만 기록.",
        "되돌리기/다시하기: 편집 · 드래그 · 컬렉션/폴더 조작 · 환경변수까지. 워크스페이스 전환은 히스토리 제외.",
      ] },
    ],
  },
];

function KbdRow() {
  // 현재 바인딩(커스텀 반영)을 그대로 보여줌.
  return (
    <table className="sctable" style={{ marginTop: 4 }}>
      <tbody>
        {COMMANDS.map((c) => (
          <tr key={c.id}>
            <td className="sckeys">{comboTokens(effectiveCombo(c.id)).map((t, i) => <kbd key={i}>{t}</kbd>)}</td>
            <td className="scdesc">{c.label}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderBlock(b: Block, i: number) {
  if ("p" in b) return <p key={i} className="manp">{b.p}</p>;
  if ("sub" in b) return <h4 key={i} className="mansub">{b.sub}</h4>;
  if ("tip" in b) return <div key={i} className="mannote tip">💡 {b.tip}</div>;
  if ("warn" in b) return <div key={i} className="mannote warn">⚠️ {b.warn}</div>;
  if ("list" in b) return <ul key={i} className="manlist">{b.list.map((x, j) => <li key={j}>{x}</li>)}</ul>;
  if ("steps" in b) return <ol key={i} className="mansteps">{b.steps.map((x, j) => <li key={j}>{x}</li>)}</ol>;
  return null;
}

export function ManualModal({ onClose }: { onClose: () => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const go = (id: string) => {
    bodyRef.current?.querySelector(`#man-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className="modalbg" onClick={onClose}>
      <div className="modal manualmodal" onClick={(e) => e.stopPropagation()}>
        <div className="iomodalhead">
          <h3>📖 Plume 사용 매뉴얼</h3>
          <button onClick={onClose}>닫기</button>
        </div>
        <div className="manualwrap">
          <nav className="manualnav">
            {SECTIONS.map((s) => (
              <button key={s.id} onClick={() => go(s.id)}><span className="mnicon">{s.icon}</span>{s.title}</button>
            ))}
            <button onClick={() => go("shortcuts")}><span className="mnicon">⌨</span>단축키</button>
          </nav>
          <div className="manualbody" ref={bodyRef}>
            {SECTIONS.map((s) => (
              <section key={s.id} id={`man-${s.id}`} className="mansec">
                <h3 className="mansectitle">{s.icon} {s.title}</h3>
                {s.blocks.map(renderBlock)}
              </section>
            ))}
            <section id="man-shortcuts" className="mansec">
              <h3 className="mansectitle">⌨ 단축키</h3>
              <p className="manp">Settings ▸ 단축키에서 자유롭게 바꿀 수 있습니다. 현재 매핑:</p>
              <KbdRow />
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
