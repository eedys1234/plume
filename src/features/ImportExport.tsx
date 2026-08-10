// Import / Export — 별도 모달로 분리.
// Import: 포맷별(OpenAPI JSON/YAML · Bruno Collections · Postman Collections) 업로드 + 결과 통계.
// Export: 대상 컬렉션 선택 → OpenAPI YAML/JSON · Bruno · Postman · Redoc HTML.
import { useState } from "react";
import { api, type Spec } from "../ipc";
import { pickSavePath, pickDirectory, pickOpenFile } from "../dialog";
import { useStore, mergeCollections } from "../store";
import { useShallow } from "zustand/react/shallow";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"];

interface ImportStats {
  title: string;
  requests: number;
  folders: number;
  environments: number;
}

// 스펙에서 요청/폴더 개수 집계.
function statsOf(spec: any, envCount = 0): ImportStats {
  const paths = spec?.paths ?? {};
  let requests = 0;
  const folderSet = new Set<string>();
  for (const p of Object.keys(paths)) {
    for (const m of Object.keys(paths[p] ?? {})) {
      if (!HTTP_METHODS.includes(m)) continue;
      requests++;
      const f = paths[p][m]?.["x-folder"];
      if (typeof f === "string" && f) {
        let acc = "";
        for (const seg of f.split("/").filter(Boolean)) {
          acc = acc ? `${acc}/${seg}` : seg;
          folderSet.add(acc);
        }
      }
    }
  }
  for (const f of spec?.["x-folders"] ?? []) folderSet.add(f);
  return { title: spec?.info?.title ?? "", requests, folders: folderSet.size, environments: envCount };
}

type ImportFmt = "openapi-yaml" | "openapi-json" | "bruno" | "postman";

// ─────────────────────────── Import ───────────────────────────
export function ImportPanel() {
  const { setSpec, addCollection, activeCollectionId, collections, projectDir, logEvent, environments, setEnvironments } = useStore(
    useShallow((s) => ({
      setSpec: s.setSpec, addCollection: s.addCollection, activeCollectionId: s.activeCollectionId,
      collections: s.collections, projectDir: s.projectDir, logEvent: s.logEvent, environments: s.environments, setEnvironments: s.setEnvironments,
    }))
  );
  const [fmt, setFmt] = useState<ImportFmt>("openapi-yaml");
  const [text, setText] = useState("");
  const [alsoBru, setAlsoBru] = useState(false);
  const [pending, setPending] = useState<{ spec: Spec; envs: any[]; stats: ImportStats } | null>(null);
  const [msg, setMsg] = useState("");

  const activeName = collections.find((c) => c.id === activeCollectionId)?.name ?? "";
  const pasteFmt: boolean = fmt === "openapi-yaml" || fmt === "openapi-json" || fmt === "postman";

  async function loadFile() {
    const exts = fmt === "openapi-yaml" ? ["yaml", "yml"] : fmt === "openapi-json" ? ["json"] : ["json"];
    const path = await pickOpenFile("가져올 파일", exts);
    if (!path) return;
    const t = await api.readTextFile(path);
    if (t == null) return setMsg("파일을 읽지 못했습니다");
    setText(t);
    await parseText(t);
  }

  async function parseText(raw?: string) {
    const src = (raw ?? text).trim();
    if (!src) return setMsg("가져올 내용을 붙여넣거나 파일을 선택하세요");
    setMsg("");
    try {
      let spec: Spec;
      if (fmt === "postman") {
        spec = await api.importPostmanCollection(src);
      } else {
        spec = await api.importSpec(src, fmt === "openapi-json" ? "json" : "yaml");
      }
      setPending({ spec, envs: [], stats: statsOf(spec, 0) });
      setMsg("✓ 분석 완료 — 오른쪽 결과 확인 후 가져오기");
    } catch (e: any) {
      setPending(null);
      setMsg(`파싱 오류: ${e?.message ?? e}`);
    }
  }

  async function loadBrunoFolder() {
    const dir = await pickDirectory();
    if (!dir) return;
    try {
      const { spec, environments: envs } = await api.importBruCollection(dir);
      const st = statsOf(spec, envs?.length ?? 0);
      if (st.requests === 0) return setMsg("가져올 요청을 찾지 못했습니다 (Bruno 컬렉션 폴더를 선택하세요)");
      setPending({ spec, envs: envs ?? [], stats: st });
      setMsg("✓ Bruno 컬렉션 분석 완료 — 오른쪽 결과 확인 후 가져오기");
    } catch (e: any) {
      setMsg(`Bruno 가져오기 실패: ${e?.message ?? e}`);
    }
  }

  async function apply(asNew: boolean) {
    if (!pending) return setMsg("먼저 파일/내용을 분석하세요");
    const { spec, envs, stats } = pending;
    if (asNew) addCollection(stats.title || "Imported API");
    setSpec(spec);
    if (envs.length) {
      const ids = new Set(environments.map((e) => e.id));
      setEnvironments([...environments, ...envs.filter((e) => !ids.has(e.id))]);
    }
    let extra = "";
    if (alsoBru && projectDir) {
      try {
        const p = await api.exportBruCollection(projectDir, spec);
        extra = ` · .bru 생성: ${p}`;
      } catch (e: any) {
        extra = ` · (.bru 생성 실패: ${e?.message ?? e})`;
      }
    }
    const label = asNew ? "새 컬렉션으로 가져옴" : `'${activeName}'에 가져옴`;
    setMsg(`✓ ${label} (요청 ${stats.requests} · 폴더 ${stats.folders}${stats.environments ? ` · 환경 ${stats.environments}` : ""})${extra}`);
    logEvent("Import", `${label} · ${stats.title} (${stats.requests} req)`);
    setPending(null);
    setText("");
  }

  return (
    <div className="impexp">
      <div className="impexpgrid">
        {/* 좌: 업로드 */}
        <div className="iocard">
          <div className="iocardhead">
            <h4>⬇ Import</h4>
            <select value={fmt} onChange={(e) => { setFmt(e.target.value as ImportFmt); setPending(null); }}>
              <option value="openapi-yaml">OpenAPI YAML</option>
              <option value="openapi-json">OpenAPI JSON</option>
              <option value="bruno">Bruno Collections</option>
              <option value="postman">Postman Collections</option>
            </select>
          </div>

          {fmt === "bruno" ? (
            <>
              <p className="hint tiny">Bruno 컬렉션 폴더(.bru / YAML 요청 트리)를 선택합니다.</p>
              <button className="active" onClick={loadBrunoFolder}>🐶 Bruno 컬렉션 폴더 선택…</button>
            </>
          ) : (
            <>
              <div className="row" style={{ gap: 6 }}>
                <button onClick={loadFile}>📄 파일 선택…</button>
                <button onClick={() => parseText()}>분석</button>
              </div>
              <textarea
                className="rawedit"
                spellCheck={false}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={fmt === "postman" ? "Postman collection JSON 붙여넣기 또는 파일 선택…" : "openapi.json / openapi.yaml 내용 붙여넣기 또는 파일 선택…"}
              />
            </>
          )}

          <label className="docopt" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={alsoBru} onChange={(e) => setAlsoBru(e.target.checked)} />
            가져올 때 .bru 파일도 생성 {!projectDir && "(폴더 필요)"}
          </label>
          <div className="iocardfoot">
            <button disabled={!pending} onClick={() => apply(false)}>활성 컬렉션에</button>
            <button className="active" disabled={!pending} onClick={() => apply(true)}>새 컬렉션으로</button>
          </div>
        </div>

        {/* 우: 결과 */}
        <div className="iocard">
          <div className="iocardhead"><h4>결과</h4></div>
          {pending ? (
            <div className="importresult">
              <div className="statrow"><span>컬렉션</span><b>{pending.stats.title || "(제목 없음)"}</b></div>
              <div className="statrow"><span>요청</span><b>{pending.stats.requests}</b></div>
              <div className="statrow"><span>폴더</span><b>{pending.stats.folders}</b></div>
              <div className="statrow"><span>환경</span><b>{pending.stats.environments}</b></div>
              <p className="hint tiny" style={{ marginTop: 8 }}>아래 버튼으로 가져오면 반영됩니다.</p>
            </div>
          ) : (
            <p className="hint">파일을 선택하거나 내용을 붙여넣고 <b>분석</b>하면 요청·폴더·환경 개수가 여기 표시됩니다.</p>
          )}
        </div>
      </div>
      <div className="iostatus">{msg}</div>
    </div>
  );
}

// ─────────────────────────── Export ───────────────────────────
export function ExportPanel() {
  const { collections, activeCollectionId, projectDir, logEvent } = useStore(
    useShallow((s) => ({
      collections: s.collections, activeCollectionId: s.activeCollectionId, projectDir: s.projectDir, logEvent: s.logEvent,
    }))
  );
  const [colId, setColId] = useState<string>(activeCollectionId);
  const [preview, setPreview] = useState("");
  const [msg, setMsg] = useState("");

  // colId === "all" 이면 모든 컬렉션을 하나로 병합해 Export.
  const isAll = colId === "all";
  const col = collections.find((c) => c.id === colId) ?? collections.find((c) => c.id === activeCollectionId);
  const spec = isAll ? mergeCollections(collections, "전체 API") : col?.spec;
  const title = isAll
    ? "all-collections"
    : (spec?.info?.title || "openapi").replace(/[^\w.-]+/g, "-");

  async function downloadOpenapi(kind: "yaml" | "json") {
    if (!spec) return;
    try {
      const out = await api.exportSpec(spec, kind);
      setPreview(out);
      const dest = await pickSavePath(`${title}.${kind}`, kind);
      if (!dest) return;
      await api.writeTextFile(dest, out);
      setMsg(`✓ OpenAPI ${kind.toUpperCase()} 저장: ${dest}`);
      logEvent("Export", `openapi.${kind} · ${dest}`);
    } catch (e: any) {
      setMsg(`오류: ${e?.message ?? e}`);
    }
  }

  async function downloadPostman() {
    if (!spec) return;
    try {
      const out = await api.exportPostmanCollection(spec);
      setPreview(out);
      const dest = await pickSavePath(`${title}.postman_collection.json`, "json");
      if (!dest) return;
      await api.writeTextFile(dest, out);
      setMsg(`✓ Postman 컬렉션 저장: ${dest}`);
      logEvent("Export", `postman · ${dest}`);
    } catch (e: any) {
      setMsg(`오류: ${e?.message ?? e}`);
    }
  }

  async function exportBruno() {
    if (!projectDir) return setMsg("프로젝트 폴더를 먼저 여세요");
    if (!spec) return;
    try {
      const p = await api.exportBruCollection(projectDir, spec);
      setMsg(`✓ Bruno(.bru) 컬렉션 생성: ${p}`);
      logEvent("Export", `.bru 컬렉션 · ${p}`);
    } catch (e: any) {
      setMsg(`오류: ${e?.message ?? e}`);
    }
  }

  async function downloadHtml() {
    if (!spec) return;
    try {
      const dest = await pickSavePath(`${title}.html`, "html");
      if (!dest) return;
      const p = await api.exportStandaloneHtml(dest, spec);
      setMsg(`✓ Redoc HTML 저장: ${p}`);
      logEvent("Export", `Redoc HTML · ${p}`);
    } catch (e: any) {
      setMsg(`오류: ${e?.message ?? e}`);
    }
  }

  return (
    <div className="impexp">
      <div className="impexpgrid">
        <div className="iocard">
          <div className="iocardhead">
            <h4>⬆ Export</h4>
            <select value={colId} onChange={(e) => setColId(e.target.value)} title="내보낼 컬렉션">
              <option value="all">전체 (모든 컬렉션)</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <p className="hint tiny">
            {isAll
              ? `전체 ${collections.length}개 컬렉션을 하나로 병합해 내보냅니다.`
              : "대상 컬렉션을 선택하고 형식을 고르세요."}
          </p>
          <div className="exportbtns">
            <button onClick={() => downloadOpenapi("yaml")}><b>OpenAPI YAML</b><span>다운로드</span></button>
            <button onClick={() => downloadOpenapi("json")}><b>OpenAPI JSON</b><span>다운로드</span></button>
            <button onClick={downloadPostman}><b>Postman Collections</b><span>다운로드</span></button>
            <button onClick={exportBruno}><b>Bruno Collections</b><span>프로젝트에 생성</span></button>
            <button onClick={downloadHtml}><b>Redoc HTML</b><span>단일 파일 다운로드</span></button>
          </div>
        </div>

        <div className="iocard">
          <div className="iocardhead">
            <h4>미리보기</h4>
            <span className="hint tiny">{isAll ? `전체 (${collections.length}개 컬렉션)` : col?.name ?? ""}</span>
          </div>
          <textarea className="rawedit" spellCheck={false} readOnly value={preview} placeholder="다운로드하면 내용이 여기에 표시됩니다." />
        </div>
      </div>
      <div className="iostatus">{msg}</div>
    </div>
  );
}
