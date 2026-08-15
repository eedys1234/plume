// 부하 테스트 탭. 단일 요청 · 폴더 그룹 · 커스텀 선택(여러 폴더의 요청 체크) 3가지 모드.
import { useMemo, useState } from "react";
import { api, type BodySpec, type HttpRequestSpec, type LoadResult } from "../ipc";
import { listOperations, opFolder, specFolders, tabKey, useStore } from "../store";
import { useShallow } from "zustand/react/shallow";

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];

// operation → HTTP 요청(부하용). {{baseUrl}}+path, 헤더 파라미터, 요청 본문 예시.
function opToRequest(path: string, method: string, op: any): HttpRequestSpec {
  const ex = op?.requestBody?.content?.["application/json"]?.example;
  const body: BodySpec = ex !== undefined ? { kind: "json", value: ex } : { kind: "none" };
  const headers: Record<string, string> = {};
  (op?.parameters ?? []).filter((p: any) => p?.in === "header").forEach((p: any) => {
    if (p.name) headers[p.name] = p.example ?? "";
  });
  return { method: method.toUpperCase(), url: `{{baseUrl}}${path}`, headers, query: {}, body, auth: { kind: "none" } };
}

export function Load() {
  const { activeEnv, spec, logEvent } = useStore(
    useShallow((s) => ({ activeEnv: s.activeEnv, spec: s.spec, logEvent: s.logEvent }))
  );
  const showAlert = useStore((s) => s.showAlert);
  const [mode, setMode] = useState<"single" | "folder" | "custom">("single");
  const [folder, setFolder] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 단일
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("{{baseUrl}}/");
  const [headersText, setHeadersText] = useState("");
  const [bodyText, setBodyText] = useState("");
  // 설정
  const [iter, setIter] = useState(100);
  const [conc, setConc] = useState(10);
  const [result, setResult] = useState<LoadResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // 전체 스펙 순회는 무겁다(수천 오퍼레이션) → spec이 바뀔 때만 계산(입력창 타이핑엔 재계산 X).
  const allOps = useMemo(() => listOperations(spec), [spec]);
  const folders = useMemo(() => specFolders(spec), [spec]);

  function parseHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    for (const line of headersText.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return h;
  }
  function buildSingle(): HttpRequestSpec {
    let body: BodySpec = { kind: "none" };
    if (bodyText.trim()) {
      try { body = { kind: "json", value: JSON.parse(bodyText) }; }
      catch { body = { kind: "text", value: bodyText }; }
    }
    return { method, url, headers: parseHeaders(), query: {}, body, auth: { kind: "none" } };
  }

  const folderReqs = useMemo(
    () => allOps
      .filter(({ op }) => { const f = opFolder(op); return f === folder || f.startsWith(folder + "/"); })
      .map(({ path, method, op }) => opToRequest(path, method, op)),
    [allOps, folder]
  );
  const customReqs = useMemo(
    () => allOps
      .filter(({ path, method }) => selected.has(tabKey(path, method)))
      .map(({ path, method, op }) => opToRequest(path, method, op)),
    [allOps, selected]
  );

  const toggle = (key: string) =>
    setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // 커스텀 체크리스트: 폴더별 그룹.
  const byFolder = useMemo(() => {
    const m: Record<string, typeof allOps> = {};
    for (const e of allOps) (m[opFolder(e.op) || "(루트)"] ??= []).push(e);
    return m;
  }, [allOps]);

  async function run() {
    const reqs = mode === "single" ? [buildSingle()] : mode === "folder" ? folderReqs : customReqs;
    if (reqs.length === 0) return setMsg("대상 요청이 없습니다");
    setBusy(true);
    setMsg("");
    try {
      const r = reqs.length === 1
        ? await api.runLoad(reqs[0], activeEnv(), iter, conc)
        : await api.runLoadGroup(reqs, activeEnv(), iter, conc);
      setResult(r);
      logEvent("Run", `부하 ${mode} · ${reqs.length}요청×${iter} · ${r.rps.toFixed(0)}rps · 성공 ${r.success}/${r.total}`);
    } catch (e: any) {
      showAlert(`${e?.message ?? e}`, { title: "실행 실패", kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="loadview">
      <div className="row loadmodebar">
        <button className={mode === "single" ? "active" : ""} onClick={() => setMode("single")}>단일 요청</button>
        <button className={mode === "folder" ? "active" : ""} onClick={() => setMode("folder")}>폴더 그룹</button>
        <button className={mode === "custom" ? "active" : ""} onClick={() => setMode("custom")}>커스텀 선택</button>
        <button className="active send" disabled={busy} onClick={run} style={{ marginLeft: "auto" }}>
          {busy ? "실행 중…" : "▶ Run Load"}
        </button>
      </div>

      {mode === "single" && (
        <div className="loadsingle">
          <div className="reqline">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => <option key={m}>{m}</option>)}
            </select>
            <input className="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <label>Headers (한 줄에 <code>Key: Value</code>)
            <textarea rows={2} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
          </label>
          <label>Body (JSON, 선택)
            <textarea rows={4} value={bodyText} onChange={(e) => setBodyText(e.target.value)} placeholder='{ "key": "value" }' />
          </label>
        </div>
      )}

      {mode === "folder" && (
        <div className="loadgroup">
          <label>그룹(폴더) 선택
            <select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">(루트)</option>
              {folders.filter(Boolean).map((f) => <option key={f} value={f}>📁 {f}</option>)}
            </select>
          </label>
          <div className="sublabel">이 폴더의 요청 {folderReqs.length}개를 라운드로빈으로 실행</div>
          <div className="checklist">
            {folderReqs.map((r, i) => (
              <div key={i} className="clitem"><span className={`m m-${r.method.toLowerCase()}`}>{r.method}</span><span className="p">{r.url}</span></div>
            ))}
          </div>
        </div>
      )}

      {mode === "custom" && (
        <div className="loadcustom">
          <div className="row" style={{ alignItems: "center" }}>
            <span className="hint tiny">여러 폴더의 요청을 체크해 그룹으로 실행 · 선택 {selected.size}개</span>
            <button onClick={() => setSelected(new Set(allOps.map((e) => tabKey(e.path, e.method))))}>전체 선택</button>
            <button onClick={() => setSelected(new Set())}>해제</button>
          </div>
          <div className="checklist">
            {allOps.length === 0 && <div className="hint tiny">Design에서 요청을 먼저 만드세요.</div>}
            {Object.entries(byFolder).map(([f, ops]) => (
              <div key={f} className="clgroup">
                <div className="clfolder">📁 {f}</div>
                {ops.map((e) => {
                  const key = tabKey(e.path, e.method);
                  return (
                    <label key={key} className="clitem check">
                      <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                      <span className={`m m-${e.method}`}>{e.method.toUpperCase()}</span>
                      <span className="p">{e.path}</span>
                      {e.op?.summary && <span className="sum">{e.op.summary}</span>}
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      <fieldset className="loadbox">
        <legend>⚡ 부하 설정</legend>
        <div className="row">
          <label>요청 수<input type="number" min={1} value={iter} onChange={(e) => setIter(+e.target.value || 1)} style={{ width: 100 }} /></label>
          <label>동시성 (가상 사용자)<input type="number" min={1} max={64} value={conc} onChange={(e) => setConc(+e.target.value || 1)} style={{ width: 80 }} /></label>
        </div>
        <div className="hint tiny">동시성 최대 64 · reqwest 실행이라 CORS 없음 · 여러 요청은 라운드로빈</div>
      </fieldset>

      {msg && <p className="err">{msg}</p>}

      {result && (
        <div className="loadresult">
          <div className="loadstats">
            <div className="lstat"><span>총 요청</span><b>{result.total}</b></div>
            <div className="lstat ok"><span>성공</span><b>{result.success}</b></div>
            <div className="lstat err"><span>실패</span><b>{result.failed}</b></div>
            <div className="lstat"><span>RPS</span><b>{result.rps.toFixed(1)}</b></div>
            <div className="lstat"><span>총시간</span><b>{result.elapsedMs}ms</b></div>
            <div className="lstat"><span>avg</span><b>{result.avgMs.toFixed(0)}ms</b></div>
            <div className="lstat"><span>min</span><b>{result.minMs}ms</b></div>
            <div className="lstat"><span>p50</span><b>{result.p50Ms}ms</b></div>
            <div className="lstat"><span>p95</span><b>{result.p95Ms}ms</b></div>
            <div className="lstat"><span>p99</span><b>{result.p99Ms}ms</b></div>
            <div className="lstat"><span>max</span><b>{result.maxMs}ms</b></div>
          </div>
          <div className="hint tiny" style={{ marginTop: 8 }}>
            상태코드: {result.statusCounts.map(([c, n]) => `${c}×${n}`).join(" · ") || "-"}
          </div>
        </div>
      )}
    </div>
  );
}
