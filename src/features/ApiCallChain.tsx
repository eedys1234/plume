// API Call Chain: 호출 스텝 목록을 만들고(컬렉션에서 가져오기 포함), 저장/불러오기,
// 머메이드 시퀀스 다이어그램 미리보기 + .svg/.png 다운로드.
import { useEffect, useState } from "react";
import mermaid from "mermaid";
import { api } from "../ipc";
import { pickSavePath } from "../dialog";
import { listOperations, useStore, type Chain } from "../store";
import { useShallow } from "zustand/react/shallow";
import { CollectionTree } from "./CollectionTree";

mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });
let _mid = 0;

const clean = (s: string) => (s || "").replace(/[\n\r;:]+/g, " ").trim();

function chainToMermaid(chain: Chain): string {
  const lines = ["sequenceDiagram", "  participant U as Client", "  participant S as API"];
  if (chain.steps.length === 0) lines.push("  note over U,S: 스텝을 추가하세요");
  chain.steps.forEach((st, i) => {
    const msg = `${st.method.toUpperCase()} ${clean(st.path)}${st.note ? " · " + clean(st.note) : ""}`;
    lines.push(`  U->>S: ${i + 1}. ${msg}`);
    lines.push(`  S-->>U: ${st.label ? clean(st.label) : "response"}`);
  });
  return lines.join("\n");
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
  const { spec, collections, chains, setChains, projectDir, logEvent } = useStore(
    useShallow((s) => ({ spec: s.spec, collections: s.collections, chains: s.chains, setChains: s.setChains, projectDir: s.projectDir, logEvent: s.logEvent }))
  );
  const [activeId, setActiveId] = useState<string>(chains[0]?.id ?? "");
  const [svg, setSvg] = useState("");
  const [msg, setMsg] = useState("");
  const chainsPath = projectDir ? `${projectDir}/.apigen/chains.json` : null;
  const active = chains.find((c) => c.id === activeId) ?? null;
  // 체인은 App(loadFolder)에서 프로젝트 열 때 store로 로드되고 Ctrl+S/💾로 저장된다.

  // 활성 체인이 없고 체인이 있으면 첫 체인 자동 선택.
  useEffect(() => {
    if (!activeId && chains.length) setActiveId(chains[0].id);
  }, [chains, activeId]);

  // 다이어그램 렌더.
  useEffect(() => {
    if (!active) { setSvg(""); return; }
    let alive = true;
    mermaid.render(`chain_${_mid++}`, chainToMermaid(active))
      .then(({ svg }) => alive && setSvg(svg))
      .catch((e) => setMsg(`다이어그램 오류: ${e?.message ?? e}`));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, JSON.stringify(active?.steps)]);

  function updateChain(fn: (c: Chain) => void) {
    setChains(chains.map((c) => { if (c.id !== activeId) return c; const n = structuredClone(c); fn(n); return n; }));
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

  async function saveChains() {
    if (!chainsPath) { setMsg("프로젝트 폴더를 먼저 여세요"); return; }
    try {
      await api.writeTextFile(chainsPath, JSON.stringify(chains, null, 2));
      setMsg("✓ 체인 저장: .apigen/chains.json");
      logEvent("Chain", `체인 저장 (${chains.length}개)`);
    } catch (e: any) { setMsg(`저장 실패: ${e?.message ?? e}`); }
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
    } catch (e: any) { setMsg(`PNG 실패: ${e?.message ?? e}`); }
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
