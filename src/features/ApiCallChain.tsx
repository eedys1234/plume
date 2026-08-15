// API Call Chain: 호출 스텝 목록을 만들고(컬렉션에서 가져오기 포함), 저장/불러오기,
// 머메이드 시퀀스 다이어그램 미리보기 + .svg/.png 다운로드.
import { useEffect, useMemo, useState } from "react";
import mermaid from "mermaid";
import { api, type AuthSpec, type HttpRequestSpec } from "../ipc";
import { pickSavePath } from "../dialog";
import { listOperations, useStore, type Chain } from "../store";
import { useShallow } from "zustand/react/shallow";
import { runScript, type BruApi } from "../script";
import { CollectionTree } from "./CollectionTree";

mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });
let _mid = 0;

const clean = (s: string) => (s || "").replace(/[\n\r;:]+/g, " ").trim();

function chainToMermaid(chain: Chain): string {
  const client = clean(chain.clientLabel || "") || "Client";
  const server = clean(chain.serverLabel || "") || "API";
  const lines = ["sequenceDiagram", `  participant U as ${client}`, `  participant S as ${server}`];
  if (chain.steps.length === 0) lines.push("  note over U,S: 스텝을 추가하세요");
  chain.steps.forEach((st, i) => {
    const msg = `${st.method.toUpperCase()} ${clean(st.path)}${st.note ? " · " + clean(st.note) : ""}`;
    lines.push(`  U->>S: ${i + 1}. ${msg}`);
    lines.push(`  S-->>U: ${st.label ? clean(st.label) : "response"}`);
  });
  return lines.join("\n");
}

// 스텝 실행 결과.
interface StepResult {
  status?: number;
  statusText?: string;
  ms?: number;
  ok?: boolean;
  error?: string;
  logs?: string[];
}

function svgSize(svg: string): { w: number; h: number } {
  const vb = svg.match(/viewBox="([\d.\s-]+)"/);
  if (vb) {
    const p = vb[1].split(/\s+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] };
  }
  return { w: 900, h: 520 };
}

export function ApiCallChain() {
  const { spec, collections, chains, setChains, projectDir, logEvent, environments, activeEnvId, setVariable, runtimeVars, setRuntimeVar } = useStore(
    useShallow((s) => ({
      spec: s.spec, collections: s.collections, chains: s.chains, setChains: s.setChains, projectDir: s.projectDir, logEvent: s.logEvent,
      environments: s.environments, activeEnvId: s.activeEnvId, setVariable: s.setVariable, runtimeVars: s.runtimeVars, setRuntimeVar: s.setRuntimeVar,
    }))
  );
  const activeEnv = () => environments.find((e) => e.id === activeEnvId);
  const showAlert = useStore((s) => s.showAlert);
  const [activeId, setActiveId] = useState<string>(chains[0]?.id ?? "");
  const [svg, setSvg] = useState("");
  const [msg, setMsg] = useState("");
  const [running, setRunning] = useState(false);
  const [stopOnError, setStopOnError] = useState(true);
  const [results, setResults] = useState<Record<number, StepResult>>({});
  const chainsPath = projectDir ? `${projectDir}/.apigen/chains.json` : null;
  const active = chains.find((c) => c.id === activeId) ?? null;
  // 체인은 App(loadFolder)에서 프로젝트 열 때 store로 로드되고 Ctrl+S/💾로 저장된다.

  // 활성 체인이 없고 체인이 있으면 첫 체인 자동 선택.
  useEffect(() => {
    if (!activeId && chains.length) setActiveId(chains[0].id);
  }, [chains, activeId]);

  // mermaid 소스는 active(변경 시 새 참조)에서만 재계산 → 매 렌더 JSON.stringify 제거.
  const mermaidSrc = useMemo(() => (active ? chainToMermaid(active) : ""), [active]);
  // 다이어그램 렌더.
  useEffect(() => {
    if (!mermaidSrc) { setSvg(""); return; }
    let alive = true;
    mermaid.render(`chain_${_mid++}`, mermaidSrc)
      .then(({ svg }) => alive && setSvg(svg))
      .catch((e) => setMsg(`다이어그램 오류: ${e?.message ?? e}`));
    return () => { alive = false; };
  }, [mermaidSrc]);

  function updateChain(fn: (c: Chain) => void) {
    // 매 키입력마다 체인 전체를 structuredClone 하지 않고, 체인 + steps만 얕게 복사(steps는 평면 객체).
    setChains(chains.map((c) => {
      if (c.id !== activeId) return c;
      const n: Chain = { ...c, steps: c.steps.map((s) => ({ ...s })) };
      fn(n);
      return n;
    }));
  }
  function newChain() {
    const id = `chain${Date.now()}`;
    const c: Chain = { id, name: `Chain ${chains.length + 1}`, steps: [] };
    setChains([...chains, c]);
    setActiveId(id);
    logEvent("Chain", `체인 생성 · ${c.name}`);
  }
  function deleteChain(id: string) {
    if (!confirm("이 체인을 삭제할까요?")) return;
    const rest = chains.filter((c) => c.id !== id);
    setChains(rest);
    if (activeId === id) setActiveId(rest[0]?.id ?? "");
  }
  function addStep(path: string, method: string, label?: string, colName?: string) {
    if (!active) { setMsg("먼저 체인을 만들거나 선택하세요"); return; }
    // 여러 컬렉션에서 추가할 수 있으므로 라벨에 컬렉션명을 접두로 붙여 구분.
    const full = colName && colName !== spec?.info?.title ? `[${colName}] ${label ?? ""}`.trim() : label;
    updateChain((c) => c.steps.push({ method, path, label: full }));
  }
  function importAll() {
    if (!active) { setMsg("먼저 체인을 만들거나 선택하세요"); return; }
    const ops = listOperations(spec);
    updateChain((c) => ops.forEach(({ path, method, op }) => c.steps.push({ method, path, label: op?.summary })));
    logEvent("Chain", `컬렉션 전체를 스텝으로 (${ops.length})`);
  }
  function moveStep(i: number, dir: -1 | 1) {
    const j = i + dir;
    updateChain((c) => { if (j < 0 || j >= c.steps.length) return; [c.steps[i], c.steps[j]] = [c.steps[j], c.steps[i]]; });
  }

  // path+method 에 해당하는 operation 을 모든 컬렉션에서 찾는다(스텝은 여러 컬렉션 출처 가능).
  function opForStep(path: string, method: string): any {
    for (const c of collections) { const o = c.spec?.paths?.[path]?.[method.toLowerCase()]; if (o) return o; }
    return spec?.paths?.[path]?.[method.toLowerCase()];
  }
  // operation → 실행용 요청 스펙(RequestView 와 동일 규칙: x-send-url·헤더·쿼리·본문 example·x-auth).
  function buildReq(op: any, path: string, method: string): HttpRequestSpec {
    const headers: Record<string, string> = {};
    (op?.parameters ?? []).filter((p: any) => p?.in === "header").forEach((p: any) => p.name && (headers[p.name] = p.example ?? ""));
    const query: Record<string, string> = {};
    (op?.parameters ?? []).filter((p: any) => p?.in === "query").forEach((p: any) => p.name && (query[p.name] = p.example ?? ""));
    const mt = Object.keys(op?.requestBody?.content ?? {})[0] || "application/json";
    const ex = op?.requestBody?.content?.[mt]?.example;
    const body: any = ex == null ? { kind: "none" } : typeof ex === "string" ? { kind: "text", value: ex } : { kind: "json", value: ex };
    const a = op?.["x-auth"];
    const auth: AuthSpec =
      a?.kind === "bearer" ? { kind: "bearer", token: a.token }
      : a?.kind === "basic" ? { kind: "basic", username: a.username, password: a.password }
      : a?.kind === "apikey" ? { kind: "apikey", in: a.apiKeyIn, name: a.apiKeyName, value: a.apiKeyValue }
      : { kind: "none" };
    return { method: method.toUpperCase(), url: op?.["x-send-url"] || `{{baseUrl}}${path}`, headers, query, body, auth };
  }

  // 체인 실행: 각 스텝을 순차 HTTP 호출. 활성 환경 + 런타임변수로 해석하고,
  // op의 post-response 스크립트로 변수(토큰 등)를 다음 스텝에 넘긴다(bru.setEnvVar/setVar).
  async function runChain() {
    if (!active || running) return;
    if (!active.steps.length) { setMsg("실행할 스텝이 없습니다"); return; }
    setRunning(true); setResults({}); setMsg("실행 중…");
    // 런타임 변수는 실행 동안 로컬 누적(스크립트가 갱신) + 스토어에도 반영.
    const runtime: Record<string, string> = { ...runtimeVars };
    const bru: BruApi = {
      getEnvVar: (k) => { const e = activeEnv(); return e?.variables[k] ?? e?.scriptVariables?.[k]; },
      setEnvVar: (k, v) => setVariable(activeEnvId, k, String(v)),
      getVar: (k) => runtime[k],
      setVar: (k, v) => { runtime[k] = String(v); setRuntimeVar(k, String(v)); },
    };
    let okCount = 0;
    for (let i = 0; i < active.steps.length; i++) {
      const stp = active.steps[i];
      const op = opForStep(stp.path, stp.method);
      const logs: string[] = [];
      if (!op) { setResults((r) => ({ ...r, [i]: { error: "operation 을 찾을 수 없음" } })); if (stopOnError) break; else continue; }
      try {
        const req = buildReq(op, stp.path, stp.method);
        // pre-request script(op 수준)
        const reqCtx: any = { method: req.method, url: req.url, headers: req.headers, query: req.query, body: (req.body as any).value,
          setHeader: (k: string, v: unknown) => (reqCtx.headers[k] = String(v)), setUrl: (u: string) => (reqCtx.url = u), setBody: (b: unknown) => (reqCtx.body = b) };
        if (op["x-pre-request-script"]) { const rr = runScript(op["x-pre-request-script"], { bru, req: reqCtx }); logs.push(...rr.logs); if (rr.error) logs.push("✖ pre: " + rr.error); }
        // 활성 환경 + 런타임변수 병합해 {{변수}} 해석.
        const e = activeEnv();
        const env = e ? { ...e, variables: { ...e.variables, ...runtime } } : { id: "_", name: "_", variables: { ...runtime } } as any;
        const sendBody: any = reqCtx.body == null ? { kind: "none" } : typeof reqCtx.body === "string" ? { kind: "text", value: reqCtx.body } : { kind: "json", value: reqCtx.body };
        const r = await api.sendHttpRequest({ method: reqCtx.method, url: reqCtx.url, headers: reqCtx.headers, query: reqCtx.query, body: sendBody, auth: req.auth }, env);
        const ok = r.status >= 200 && r.status < 400;
        // post-response script(op 수준) — 변수 추출/전달.
        if (op["x-post-response-script"]) {
          const resCtx = { status: r.status, statusText: r.statusText, headers: Object.fromEntries(r.headers), body: r.bodyJson ?? r.bodyText, responseTime: r.elapsedMs };
          const rr = runScript(op["x-post-response-script"], { bru, res: resCtx }); logs.push(...rr.logs); if (rr.error) logs.push("✖ post: " + rr.error);
        }
        setResults((rs) => ({ ...rs, [i]: { status: r.status, statusText: r.statusText, ms: r.elapsedMs, ok, logs } }));
        if (ok) okCount++;
        else if (stopOnError) { setMsg(`스텝 ${i + 1}에서 실패(${r.status}) — 중단`); break; }
      } catch (err: any) {
        setResults((rs) => ({ ...rs, [i]: { error: String(err?.message ?? err), logs } }));
        if (stopOnError) { setMsg(`스텝 ${i + 1} 오류 — 중단`); break; }
      }
    }
    setRunning(false);
    setMsg((m) => (m === "실행 중…" ? `실행 완료 · 성공 ${okCount}/${active.steps.length}` : m));
    logEvent("Chain", `체인 실행 · ${active.name} (성공 ${okCount}/${active.steps.length})`);
  }

  async function saveChains() {
    if (!chainsPath) { setMsg("프로젝트 폴더를 먼저 여세요"); return; }
    try {
      await api.writeTextFile(chainsPath, JSON.stringify(chains, null, 2));
      setMsg("✓ 체인 저장: .apigen/chains.json");
      logEvent("Chain", `체인 저장 (${chains.length}개)`);
    } catch (e: any) { showAlert(`${e?.message ?? e}`, { title: "체인 저장 실패", kind: "err" }); }
  }

  async function downloadMermaid() {
    if (!active) return;
    const dest = await pickSavePath(`${active.name}.mermaid`, "mermaid");
    if (!dest) return;
    await api.writeTextFile(dest, chainToMermaid(active));
    setMsg(`✓ .mermaid 저장: ${dest}`);
    logEvent("Export", `체인 mermaid · ${dest}`);
  }
  async function downloadSvg() {
    if (!svg) return;
    const dest = await pickSavePath(`${active?.name ?? "chain"}.svg`, "svg");
    if (!dest) return;
    await api.writeTextFile(dest, svg);
    setMsg(`✓ SVG 저장: ${dest}`);
    logEvent("Export", `체인 다이어그램 SVG · ${dest}`);
  }
  async function downloadPng() {
    if (!svg) return;
    const dest = await pickSavePath(`${active?.name ?? "chain"}.png`, "png");
    if (!dest) return;
    try {
      const { w, h } = svgSize(svg);
      const sized = svg
        .replace(/\swidth="[^"]*"/, "")
        .replace(/\sheight="[^"]*"/, "")
        .replace(/style="[^"]*"/, "")
        .replace(/<svg /, `<svg width="${w}" height="${h}" `);
      const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = w * scale; canvas.height = h * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#0f1420"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/png"));
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      await api.writeBytesFile(dest, bytes);
      setMsg(`✓ PNG 저장: ${dest}`);
      logEvent("Export", `체인 다이어그램 PNG · ${dest}`);
    } catch (e: any) { showAlert(`${e?.message ?? e}`, { title: "PNG 내보내기 실패", kind: "err" }); }
  }

  return (
    <div className="chainview">
      {/* 1) 체인 목록 */}
      <aside className="chaincol chains">
        <div className="chaincolhead">
          <h3>Chains</h3>
          <div className="row" style={{ gap: 4 }}>
            <button onClick={newChain} title="새 체인">＋</button>
            <button onClick={saveChains} title="프로젝트에 저장">💾</button>
          </div>
        </div>
        <ul className="oplist">
          {chains.length === 0 && <li className="hint tiny">＋ 로 새 체인</li>}
          {chains.map((c) => (
            <li key={c.id} className={activeId === c.id ? "op sel" : "op"} onClick={() => setActiveId(c.id)}>
              🔗 <span className="p">{c.name}</span>
              <span className="sum">{c.steps.length}</span>
              <button className="del" onClick={(e) => { e.stopPropagation(); deleteChain(c.id); }}>×</button>
            </li>
          ))}
        </ul>
      </aside>

      {/* 2) 컬렉션 → 스텝 (모든 컬렉션에서 선택 가능) */}
      <aside className="chaincol coltree">
        <div className="chaincolhead"><h3>컬렉션 → 스텝</h3></div>
        <div className="hint tiny">요청 클릭 = 스텝 추가 · 여러 컬렉션에서 선택 가능</div>
        <button onClick={importAll} style={{ margin: "6px 0", width: "100%" }}>활성 컬렉션 전체를 스텝으로</button>
        {collections.map((col) => (
          <div key={col.id} className="chaincoltree">
            <div className="chaincolname">📦 {col.name}</div>
            <CollectionTree
              spec={col.spec}
              collectionId={col.id}
              onSelectRequest={(p, m, op) => addStep(p, m, op?.summary, col.name)}
            />
          </div>
        ))}
      </aside>

      {/* 3) 호출 스텝(큼직하게) */}
      <section className="chaincol steps">
        {!active ? (
          <p className="hint">체인을 선택하거나 새로 만드세요.</p>
        ) : (
          <>
            <input className="chainname" value={active.name} onChange={(e) => updateChain((c) => (c.name = e.target.value))} />

            {/* 실행 바 */}
            <div className="chainrun">
              <button className="active runbtn" disabled={running || active.steps.length === 0} onClick={runChain}>
                {running ? "실행 중…" : "▶ 실행"}
              </button>
              <label className="chainopt"><input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} /> 실패 시 중단</label>
              <span className="hint tiny">활성 환경: {activeEnv()?.name ?? "(없음)"} · post-script로 변수 전달</span>
            </div>

            {/* 시퀀스 다이어그램 주체 명칭(체인별) */}
            <div className="chainactors">
              <label>요청측<input value={active.clientLabel ?? ""} placeholder="Client" onChange={(e) => updateChain((c) => (c.clientLabel = e.target.value || undefined))} /></label>
              <span className="arrow">→</span>
              <label>응답측<input value={active.serverLabel ?? ""} placeholder="API" onChange={(e) => updateChain((c) => (c.serverLabel = e.target.value || undefined))} /></label>
            </div>

            <div className="sublabel">호출 스텝 ({active.steps.length})</div>
            <ol className="chainsteps">
              {active.steps.length === 0 && <li className="hint tiny">왼쪽 트리에서 요청을 클릭해 스텝을 추가하세요.</li>}
              {active.steps.map((st, i) => (
                <li key={i} className="chainstep">
                  <span className="stepno">{i + 1}</span>
                  <span className={`m m-${st.method.toLowerCase()}`}>{st.method.toUpperCase()}</span>
                  <span className="steppath" title={st.path}>{st.path}</span>
                  <input
                    className="stepnote"
                    value={st.note ?? ""}
                    placeholder="설명(선택)"
                    onChange={(e) => updateChain((c) => (c.steps[i].note = e.target.value || undefined))}
                  />
                  {results[i] && (
                    results[i].error
                      ? <span className="stepres err" title={results[i].error}>✖ {results[i].error!.slice(0, 20)}</span>
                      : <span className={`stepres s${Math.floor((results[i].status ?? 0) / 100)}`} title={(results[i].logs ?? []).join("\n") || undefined}>
                          {results[i].status} · {results[i].ms}ms{(results[i].logs?.length ?? 0) > 0 ? " 📝" : ""}
                        </span>
                  )}
                  <button className="mini" title="위로" disabled={i === 0} onClick={() => moveStep(i, -1)}>↑</button>
                  <button className="mini" title="아래로" disabled={i === active.steps.length - 1} onClick={() => moveStep(i, 1)}>↓</button>
                  <button className="del" title="제거" onClick={() => updateChain((c) => c.steps.splice(i, 1))}>×</button>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      {/* 4) 머메이드 다이어그램 */}
      <section className="chaincol diagram">
        <div className="chaincolhead">
          <h3>시퀀스 다이어그램</h3>
          <div className="row" style={{ gap: 4 }}>
            <button onClick={downloadMermaid} disabled={!active} title="Mermaid 소스">.mermaid</button>
            <button onClick={downloadSvg} disabled={!svg} title="SVG">.svg</button>
            <button onClick={downloadPng} disabled={!svg} title="PNG">.png</button>
          </div>
        </div>
        <div className="status">{msg}</div>
        <div className="mermaidbox" dangerouslySetInnerHTML={{ __html: svg || "<div class='hint'>스텝을 추가하면 다이어그램이 표시됩니다.</div>" }} />
      </section>
    </div>
  );
}
