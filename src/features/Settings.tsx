// Settings: CloudFront(S3) 배포 설정 + AWS 자격증명 입력.
// 자격증명은 기기 로컬(localStorage)에만 저장되며 워크스페이스/깃에 포함되지 않는다.
// 실제 배포 버튼은 Specification(Docs) 탭의 GitHub Pages 버튼 오른쪽에 있다.
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { loadDeploy, saveDeploy, clearCreds, emptyDeploy, type DeploySettings } from "./deployConfig";
import { loadMeta, saveMeta, defaultMeta, type AppMeta } from "../appMeta";
import { COMMANDS, effectiveCombo, comboTokens, setBinding, resetBinding, resetAll, eventToCombo, comboToString } from "../keybindings";
import { api } from "../ipc";
import {
  loadAi, saveAi, type AiSettings, type AiProvider, PROVIDER_LABELS, DEFAULT_MODELS, DEFAULT_BASEURL,
  loadMcp, saveMcp, type McpServerCfg,
} from "./aiConfig";

export function Settings() {
  const { projectDir, showToast } = useStore(
    useShallow((s) => ({ projectDir: s.projectDir, showToast: s.showToast }))
  );
  const [cfg, setCfg] = useState<DeploySettings>(emptyDeploy());
  const [showSecret, setShowSecret] = useState(false);
  const [meta, setMeta] = useState<AppMeta>(defaultMeta());
  const [recId, setRecId] = useState<string | null>(null); // 녹화 중인 command id
  const [bindVer, setBindVer] = useState(0); // 바인딩 변경 후 재렌더용
  const [tab, setTab] = useState<"deploy" | "update" | "ai" | "mcp" | "save" | "keys">("deploy");
  const [brunoCompat, setBrunoCompat] = useState(() => localStorage.getItem("plume.brunoCompat") === "1");
  // AI(LLM) 설정 + MCP 서버
  const [ai, setAi] = useState<AiSettings>(() => loadAi());
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState("");
  const [showAiKey, setShowAiKey] = useState(false);
  const [mcp, setMcp] = useState<McpServerCfg[]>(() => loadMcp());
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [mcpResult, setMcpResult] = useState<Record<string, string>>({});

  // 녹화: recId 설정되면 다음 키 입력을 캡처해 바인딩. Esc=취소.
  useEffect(() => {
    if (!recId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRecId(null); return; }
      const c = eventToCombo(e);
      if (!c) return; // 모디파이어 단독은 대기
      setBinding(recId, comboToString(c));
      setRecId(null);
      setBindVer((v) => v + 1);
    };
    window.addEventListener("keydown", onKey, true); // capture: 전역 디스패처보다 먼저
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recId]);

  // 프로젝트가 바뀌면 해당 프로젝트의 저장값 로드(암호화 파일에서 복호화).
  useEffect(() => {
    let alive = true;
    loadDeploy(projectDir).then((s) => { if (alive) setCfg(s); });
    return () => { alive = false; };
  }, [projectDir]);

  // 앱 메타(버전 + 업데이트 저장소)는 프로젝트와 무관 · 1회 로드.
  useEffect(() => { let alive = true; loadMeta().then((m) => { if (alive) setMeta(m); }); return () => { alive = false; }; }, []);

  // 단축키 충돌 집계 + 카테고리는 바인딩이 바뀔 때만 재계산.
  const kbInfo = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of COMMANDS) { const k = effectiveCombo(c.id); counts[k] = (counts[k] ?? 0) + 1; }
    const cats: string[] = [];
    for (const c of COMMANDS) if (!cats.includes(c.cat)) cats.push(c.cat);
    return { counts, cats };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindVer]);

  const set = (patch: Partial<DeploySettings>) => setCfg((c) => ({ ...c, ...patch }));
  const setM = (patch: Partial<AppMeta>) => setMeta((m) => ({ ...m, ...patch }));
  const save = async () => { await saveDeploy(projectDir, cfg); await saveMeta(meta); showToast("설정 저장됨 ✓"); };
  const clear = async () => { const next = await clearCreds(projectDir); setCfg(next); showToast("자격증명 삭제됨"); };

  const hasCreds = cfg.accessKeyId.trim() && cfg.secretAccessKey.trim();

  // ── AI(LLM) ──
  const setAiF = (patch: Partial<AiSettings>) => setAi((a) => { const n = { ...a, ...patch }; saveAi(n); return n; });
  const changeProvider = (p: AiProvider) => setAiF({ provider: p, model: DEFAULT_MODELS[p], baseUrl: "" });
  async function testAi() {
    setAiBusy(true); setAiMsg("");
    try {
      const out = await api.aiComplete({
        provider: ai.provider, baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model,
        system: "You are a terse assistant.", prompt: "한 단어로만 답하세요: 연결 테스트 성공했으면 'OK'.",
      });
      setAiMsg(`✓ 연결 성공 · 응답: ${out.trim().slice(0, 80) || "(빈 응답)"}`);
    } catch (e: any) {
      setAiMsg(`✗ 실패: ${e?.message ?? e}`);
    } finally { setAiBusy(false); }
  }

  // ── MCP ──
  const setMcpList = (list: McpServerCfg[]) => { setMcp(list); saveMcp(list); };
  const addMcp = () => setMcpList([...mcp, { id: `mcp${Date.now()}`, name: "새 MCP 서버", command: "npx", args: "-y @modelcontextprotocol/server-everything" }]);
  const patchMcp = (id: string, patch: Partial<McpServerCfg>) => setMcpList(mcp.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const removeMcp = (id: string) => { setMcpList(mcp.filter((s) => s.id !== id)); setMcpResult((r) => { const n = { ...r }; delete n[id]; return n; }); };
  async function testMcp(s: McpServerCfg) {
    setMcpBusy(s.id);
    setMcpResult((r) => ({ ...r, [s.id]: "연결 중…" }));
    try {
      const tools = await api.mcpListTools({ command: s.command, args: s.args.trim() ? s.args.trim().split(/\s+/) : [] });
      setMcpResult((r) => ({ ...r, [s.id]: `✓ 도구 ${tools.length}개: ${tools.map((t) => t.name).join(", ") || "(없음)"}` }));
    } catch (e: any) {
      setMcpResult((r) => ({ ...r, [s.id]: `✗ ${e?.message ?? e}` }));
    } finally { setMcpBusy(null); }
  }

  return (
    <div className="settings">
      <div className="settingsinner">
        <h2>⚙ Settings</h2>

        <div className="settingtabs">
          {([["deploy", "☁ 배포"], ["update", "⬆ 업데이트"], ["ai", "🤖 AI"], ["mcp", "🔌 MCP"], ["save", "🗂 저장"], ["keys", "⌨ 단축키"]] as const).map(([id, label]) => (
            <button key={id} className={tab === id ? "stab active" : "stab"} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        {tab === "deploy" && (
        <section className="settingsec">
          <h3>☁ CloudFront 배포</h3>
          <p className="hint tiny">
            문서(Redoc/Swagger) HTML을 S3에 업로드하고 CloudFront를 무효화합니다.
            GitHub Actions의 <code>aws s3 cp</code> + <code>aws cloudfront create-invalidation</code> 흐름과 동일합니다.
            실제 배포 버튼은 <b>Specification</b> 탭의 GitHub Pages 버튼 옆에 있습니다.
          </p>

          <div className="settinggrid">
            <label>
              Region
              <input value={cfg.region} onChange={(e) => set({ region: e.target.value })} placeholder="ap-northeast-2" />
            </label>
            <label>
              S3 Bucket
              <input value={cfg.bucket} onChange={(e) => set({ bucket: e.target.value })} placeholder="my-docs-bucket" />
            </label>
            <label>
              Key Prefix <span className="hint tiny">(기본 경로)</span>
              <input value={cfg.keyPrefix} onChange={(e) => set({ keyPrefix: e.target.value })} placeholder="예: docs/  (비우면 루트)" />
            </label>
            <label>
              CloudFront 배포 ID
              <input value={cfg.distributionId} onChange={(e) => set({ distributionId: e.target.value })} placeholder="E1234ABCDEF (비우면 무효화 생략)" />
            </label>
            <label>
              무효화 경로
              <input value={cfg.invalidationPath} onChange={(e) => set({ invalidationPath: e.target.value })} placeholder="/*" />
            </label>
            <label>
              문서 뷰어
              <select value={cfg.viewer} onChange={(e) => set({ viewer: e.target.value as "redoc" | "swagger" })}>
                <option value="redoc">Redoc</option>
                <option value="swagger">Swagger UI</option>
              </select>
            </label>
          </div>
        </section>
        )}

        {tab === "deploy" && (
        <section className="settingsec">
          <h3>🔑 AWS 자격증명</h3>
          <p className="hint tiny">
            이 기기에만 저장되며 워크스페이스 파일·git에 포함되지 않습니다(GitHub Secrets와 동일 취지).
            IAM 사용자에 <code>s3:PutObject</code> 및 <code>cloudfront:CreateInvalidation</code> 권한이 필요합니다.
          </p>
          <div className="settinggrid">
            <label>
              Access Key ID
              <input value={cfg.accessKeyId} onChange={(e) => set({ accessKeyId: e.target.value })} placeholder="AKIA..." autoComplete="off" spellCheck={false} />
            </label>
            <label>
              Secret Access Key
              <span className="secretwrap">
                <input
                  type={showSecret ? "text" : "password"}
                  value={cfg.secretAccessKey}
                  onChange={(e) => set({ secretAccessKey: e.target.value })}
                  placeholder="••••••••••••••••"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="secrettoggle" onClick={() => setShowSecret((v) => !v)}>{showSecret ? "숨김" : "표시"}</button>
              </span>
            </label>
            <label className="settingwide">
              Session Token <span className="hint tiny">(STS 임시 자격증명일 때만)</span>
              <input value={cfg.sessionToken} onChange={(e) => set({ sessionToken: e.target.value })} placeholder="(선택)" autoComplete="off" spellCheck={false} />
            </label>
            <label className="settingwide">
              IAM Role ARN <span className="hint tiny">(선택 · 지정 시 이 역할을 assume해 임시 자격증명으로 배포)</span>
              <input value={cfg.roleArn} onChange={(e) => set({ roleArn: e.target.value })} placeholder="arn:aws:iam::123456789012:role/deploy-role" autoComplete="off" spellCheck={false} />
            </label>
          </div>
          <p className="hint tiny" style={{ marginTop: 8 }}>
            Role ARN 을 넣으면 위 Access Key 로 <code>sts:AssumeRole</code> 을 호출해 임시 자격증명을 받은 뒤
            그 권한으로 S3 업로드·CloudFront 무효화를 수행합니다(GitHub Actions의 role-to-assume 와 동일).
          </p>
        </section>
        )}

        {tab === "update" && (
        <section className="settingsec">
          <h3>⬆ 업데이트</h3>
          <p className="hint tiny">
            현재 버전 <b>v{meta.version}</b> (설치파일 빌드 시 릴리스 태그로 설정됨). 아래 GitHub 저장소의
            <code> releases/latest</code> 태그와 비교해 업데이트 유무를 확인합니다. 저장소는 버전과 함께 로컬에 관리됩니다.
          </p>
          <div className="settinggrid">
            <label>
              GitHub Owner
              <input value={meta.owner} onChange={(e) => setM({ owner: e.target.value.trim() })} placeholder="eedys1234" autoComplete="off" spellCheck={false} />
            </label>
            <label>
              GitHub Repo
              <input value={meta.repo} onChange={(e) => setM({ repo: e.target.value.trim() })} placeholder="plume" autoComplete="off" spellCheck={false} />
            </label>
          </div>
          <p className="hint tiny" style={{ marginTop: 6 }}>확인 대상: <code>github.com/{meta.owner || "…"}/{meta.repo || "…"}/releases/latest</code></p>
        </section>
        )}

        {tab === "ai" && (
        <section className="settingsec">
          <h3>🤖 AI 연동 (LLM)</h3>
          <p className="hint tiny">
            로컬 <b>Ollama</b> 또는 <b>OpenAI(ChatGPT)</b> · <b>Anthropic(Claude)</b> API에 연결합니다.
            요청은 백엔드에서 호출되어 CORS가 없고, 설정·키는 이 기기(localStorage)에만 저장됩니다.
          </p>
          <div className="settinggrid">
            <label>
              제공자
              <select value={ai.provider} onChange={(e) => changeProvider(e.target.value as AiProvider)}>
                {(["ollama", "openai", "anthropic"] as AiProvider[]).map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
              </select>
            </label>
            <label>
              모델
              <input value={ai.model} onChange={(e) => setAiF({ model: e.target.value })} placeholder={DEFAULT_MODELS[ai.provider]} spellCheck={false} />
            </label>
            <label className="settingwide">
              Base URL <span className="hint tiny">(비우면 기본값: {DEFAULT_BASEURL[ai.provider]})</span>
              <input value={ai.baseUrl} onChange={(e) => setAiF({ baseUrl: e.target.value })} placeholder={DEFAULT_BASEURL[ai.provider]} spellCheck={false} autoComplete="off" />
            </label>
            {ai.provider !== "ollama" && (
              <label className="settingwide">
                API Key
                <span className="secretwrap">
                  <input
                    type={showAiKey ? "text" : "password"}
                    value={ai.apiKey}
                    onChange={(e) => setAiF({ apiKey: e.target.value })}
                    placeholder={ai.provider === "openai" ? "sk-..." : "sk-ant-..."}
                    autoComplete="off" spellCheck={false}
                  />
                  <button type="button" className="secrettoggle" onClick={() => setShowAiKey((v) => !v)}>{showAiKey ? "숨김" : "표시"}</button>
                </span>
              </label>
            )}
          </div>
          <div className="row" style={{ marginTop: 10, alignItems: "center" }}>
            <button className="active" disabled={aiBusy} onClick={testAi}>{aiBusy ? "테스트 중…" : "🔌 연결 테스트"}</button>
            <span className="hint tiny">{aiMsg}</span>
          </div>
          <p className="hint tiny" style={{ marginTop: 8 }}>
            Ollama는 키가 필요 없습니다(<code>ollama serve</code> 실행 후 <code>ollama pull {ai.provider === "ollama" ? ai.model || "llama3.1" : "llama3.1"}</code>).
            설정하면 요청 <b>Info</b> 문서의 <b>✨ AI 초안</b> 버튼 등에서 사용됩니다.
          </p>
        </section>
        )}

        {tab === "mcp" && (
        <section className="settingsec">
          <h3>🔌 MCP 서버 (선택)</h3>
          <p className="hint tiny">
            MCP(Model Context Protocol) 서버에 <b>stdio</b>로 연결해 도구 목록을 확인합니다. 선택 통합이라
            사용하지 않아도 됩니다. 예: <code>npx -y @modelcontextprotocol/server-filesystem /경로</code>.
          </p>
          {mcp.length === 0 && <p className="hint tiny">등록된 MCP 서버가 없습니다.</p>}
          {mcp.map((s) => (
            <div key={s.id} className="mcprow">
              <div className="settinggrid">
                <label>이름<input value={s.name} onChange={(e) => patchMcp(s.id, { name: e.target.value })} /></label>
                <label>Command<input value={s.command} onChange={(e) => patchMcp(s.id, { command: e.target.value })} placeholder="npx" spellCheck={false} /></label>
                <label className="settingwide">Args <span className="hint tiny">(공백 구분)</span>
                  <input value={s.args} onChange={(e) => patchMcp(s.id, { args: e.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem /path" spellCheck={false} autoComplete="off" />
                </label>
              </div>
              <div className="row" style={{ marginTop: 6, alignItems: "center" }}>
                <button className="active" disabled={mcpBusy === s.id} onClick={() => testMcp(s)}>{mcpBusy === s.id ? "연결 중…" : "🔍 연결·도구 확인"}</button>
                <button className="danger" onClick={() => removeMcp(s.id)}>삭제</button>
                <span className="hint tiny" style={{ flex: 1 }}>{mcpResult[s.id] ?? ""}</span>
              </div>
            </div>
          ))}
          <div style={{ marginTop: 10 }}>
            <button onClick={addMcp}>＋ MCP 서버 추가</button>
          </div>
        </section>
        )}

        {tab === "save" && (
        <section className="settingsec">
          <h3>🗂 저장 형식</h3>
          <p className="hint tiny">
            Plume은 워크스페이스를 자체 포맷(<code>collections/</code>)으로 저장합니다. 아래를 켜면
            수동 저장(<b>Ctrl/⌘+S</b>) 시 각 컬렉션을 <b>Bruno</b> 포맷으로도 함께 내보내
            같은 워크스페이스 폴더의 <code>bruno/&lt;컬렉션 이름&gt;/</code> 를 Bruno 앱에서 바로 열 수 있습니다.
          </p>
          <label className="row" style={{ gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={brunoCompat}
              onChange={(e) => {
                const on = e.target.checked;
                setBrunoCompat(on);
                if (on) localStorage.setItem("plume.brunoCompat", "1");
                else localStorage.removeItem("plume.brunoCompat");
                showToast(on ? "Bruno 호환 저장 켜짐 ✓" : "Bruno 호환 저장 꺼짐");
              }}
            />
            <span>Bruno 호환 저장 (<code>bruno/</code> 폴더에 <code>.bru</code> 함께 생성)</span>
          </label>
          <p className="hint tiny" style={{ marginTop: 8 }}>
            자동 저장이 아니라 <b>수동 저장에서만</b> 수행됩니다(대형 컬렉션에서 전량 재작성이 무거워서).
            Bruno에서 열려면 Bruno 앱 → <b>Open Collection</b> → <code>bruno/&lt;이름&gt;</code> 폴더를 선택하세요.
          </p>
        </section>
        )}

        {tab === "keys" && (
        <section className="settingsec">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h3 style={{ margin: 0 }}>⌨ 단축키</h3>
            <button className="secrettoggle" onClick={() => { resetAll(); setBindVer((v) => v + 1); showToast("단축키 기본값으로"); }}>전체 기본값</button>
          </div>
          <p className="hint tiny">
            '변경'을 누르고 원하는 키 조합을 누르세요(Esc=취소). <b>Mod</b> = Windows/Linux는 Ctrl, macOS는 ⌘.
            같은 조합이 겹치면 위 목록에서 먼저 나오는 항목이 우선합니다.
          </p>
          {(() => {
            // 조합 충돌 집계 + 카테고리(바인딩 변경 시에만 재계산).
            const { counts, cats } = kbInfo;
            return cats.map((cat) => (
              <div key={cat} className="kbcat">
                <div className="kbcattitle">{cat}</div>
                {COMMANDS.filter((c) => c.cat === cat).map((c) => {
                  const combo = effectiveCombo(c.id);
                  const conflict = counts[combo] > 1;
                  const rec = recId === c.id;
                  return (
                    <div key={c.id} className="kbrow">
                      <span className="kblabel">{c.label}</span>
                      <span className="kbcombo">
                        {rec ? <span className="kbrec">키를 누르세요…</span>
                          : comboTokens(combo).map((t, i) => <kbd key={i}>{t}</kbd>)}
                        {conflict && !rec && <span className="kbconflict" title="다른 항목과 조합이 겹칩니다">충돌</span>}
                      </span>
                      <button className="kbbtn" onClick={() => setRecId(rec ? null : c.id)}>{rec ? "취소" : "변경"}</button>
                      <button className="kbbtn ghost" title="기본값으로" onClick={() => { resetBinding(c.id); setBindVer((v) => v + 1); }}>기본</button>
                    </div>
                  );
                })}
              </div>
            ));
          })()}
          <p className="hint tiny" style={{ marginTop: 8 }}>단축키는 변경 즉시 적용·저장됩니다(아래 '설정 저장'과 무관).</p>
        </section>
        )}

        {(tab === "deploy" || tab === "update") && (
        <div className="settingbar">
          <button className="active" onClick={save}>설정 저장</button>
          {hasCreds && <button className="danger" onClick={clear}>자격증명 삭제</button>}
          <span className="spacer" />
          <span className="hint tiny">
            {projectDir ? `프로젝트: ${projectDir}` : "워크스페이스 미선택 — 기본 프로필에 저장"}
          </span>
        </div>
        )}
      </div>
    </div>
  );
}
