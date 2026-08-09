// Import/Export: OpenAPI 스펙 가져오기(+.bru 생성) / 내보내기(확장자별 다운로드 GUI + 미리보기).
import { useState } from "react";
import { api } from "../ipc";
import { pickSavePath, pickDirectory } from "../dialog";
import { useStore } from "../store";
import { useShallow } from "zustand/react/shallow";

export function ImportExport() {
  const { spec, setSpec, addCollection, activeCollectionId, collections, projectDir, logEvent, environments, setEnvironments } = useStore(
    useShallow((s) => ({
      spec: s.spec, setSpec: s.setSpec, addCollection: s.addCollection, activeCollectionId: s.activeCollectionId,
      collections: s.collections, projectDir: s.projectDir, logEvent: s.logEvent, environments: s.environments, setEnvironments: s.setEnvironments,
    }))
  );
  const [text, setText] = useState("");
  const [fmt, setFmt] = useState<"json" | "yaml">("yaml");
  const [alsoBru, setAlsoBru] = useState(true);
  const [msg, setMsg] = useState("");
  const [preview, setPreview] = useState("");

  const activeName = collections.find((c) => c.id === activeCollectionId)?.name ?? "";

  async function importInto(asNew: boolean) {
    if (!text.trim()) return setMsg("가져올 스펙을 붙여넣으세요");
    try {
      const imported = await api.importSpec(text, fmt);
      if (asNew) addCollection(imported?.info?.title || "Imported API");
      setSpec(imported);
      let extra = "";
      // #9: 가져올 때 .bru 파일도 생성(프로젝트 폴더가 있을 때).
      if (alsoBru && projectDir) {
        try {
          const p = await api.exportBruCollection(projectDir, imported);
          extra = ` · .bru 생성: ${p}`;
        } catch (e: any) {
          extra = ` · (.bru 생성 실패: ${e?.message ?? e})`;
        }
      }
      const label = asNew ? "새 컬렉션으로 가져옴" : `'${activeName}'에 가져옴`;
      setMsg(`✓ ${label}${extra}`);
      logEvent("Import", `${label} · ${imported?.info?.title ?? ""}${alsoBru && projectDir ? " (+.bru)" : ""}`);
    } catch (e: any) {
      setMsg(`파싱 오류: ${e?.message ?? e}`);
    }
  }

  // Bruno .bru 컬렉션 폴더 → 새 Plume 컬렉션 + 환경.
  async function importBru() {
    const dir = await pickDirectory();
    if (!dir) return;
    try {
      const { spec: imported, environments: envs } = await api.importBruCollection(dir);
      const count = Object.keys(imported?.paths ?? {}).length;
      if (count === 0) return setMsg("가져올 .bru 요청을 찾지 못했습니다 (bruno.json이 있는 폴더를 선택하세요)");
      addCollection(imported?.info?.title || "Bruno Import");
      setSpec(imported);
      if (envs && envs.length) {
        const ids = new Set(environments.map((e) => e.id));
        setEnvironments([...environments, ...envs.filter((e) => !ids.has(e.id))]);
      }
      setMsg(`✓ Bruno 컬렉션 가져옴: 경로 ${count}개${envs?.length ? ` · 환경 ${envs.length}` : ""}`);
      logEvent("Import", `Bruno .bru 컬렉션 · ${imported?.info?.title ?? ""} (${count} paths)`);
    } catch (e: any) {
      setMsg(`Bruno 가져오기 실패: ${e?.message ?? e}`);
    }
  }

  // 확장자별 다운로드(네이티브 저장 다이얼로그 → 파일 쓰기).
  async function download(kind: "yaml" | "json" | "html") {
    try {
      const title = (spec?.info?.title || "openapi").replace(/[^\w.-]+/g, "-");
      if (kind === "html") {
        const dest = await pickSavePath(`${title}.html`, "html");
        if (!dest) return;
        const p = await api.exportStandaloneHtml(dest, spec);
        setMsg(`✓ Redoc HTML 저장: ${p}`);
        logEvent("Export", `Redoc HTML · ${p}`);
        return;
      }
      const out = await api.exportSpec(spec, kind);
      setPreview(out);
      const dest = await pickSavePath(`${title}.${kind}`, kind === "yaml" ? "yaml" : "json");
      if (!dest) return; // 취소해도 미리보기는 남음
      await api.writeTextFile(dest, out);
      setMsg(`✓ ${kind.toUpperCase()} 저장: ${dest}`);
      logEvent("Export", `openapi.${kind} · ${dest}`);
    } catch (e: any) {
      setMsg(`오류: ${e?.message ?? e}`);
    }
  }

  async function exportBru() {
    if (!projectDir) return setMsg("프로젝트 폴더를 먼저 여세요");
    try {
      const p = await api.exportBruCollection(projectDir, spec);
      setMsg(`✓ .bru 컬렉션 생성: ${p}`);
      logEvent("Export", `.bru 컬렉션 · ${p}`);
    } catch (e: any) {
      setMsg(`오류: ${e?.message ?? e}`);
    }
  }

  async function preview_(f: "yaml" | "json") {
    try {
      setPreview(await api.exportSpec(spec, f));
    } catch (e: any) {
      setMsg(`오류: ${e?.message ?? e}`);
    }
  }

  return (
    <div className="impexp">
      <div className="impexpgrid">
        {/* Import 카드 */}
        <div className="iocard">
          <div className="iocardhead">
            <h4>⬇ Import</h4>
            <select value={fmt} onChange={(e) => setFmt(e.target.value as any)}>
              <option value="yaml">YAML</option>
              <option value="json">JSON</option>
            </select>
          </div>
          <p className="hint tiny">OpenAPI 3.0 문서를 붙여넣어 가져옵니다.</p>
          <textarea
            className="rawedit"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="openapi.json / openapi.yaml 내용을 붙여넣으세요…"
          />
          <label className="docopt" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={alsoBru} onChange={(e) => setAlsoBru(e.target.checked)} />
            가져올 때 .bru 파일도 생성 {(!projectDir) && "(폴더 필요)"}
          </label>
          <div className="iocardfoot">
            <button onClick={() => importInto(false)}>활성 컬렉션에</button>
            <button className="active" onClick={() => importInto(true)}>새 컬렉션으로</button>
          </div>
          <div className="sublabel" style={{ marginTop: 10 }}>또는 Bruno 컬렉션 폴더에서</div>
          <button onClick={importBru} title="bruno.json + .bru 트리가 있는 폴더 선택 → 새 컬렉션 생성">
            🐶 Bruno .bru 컬렉션 가져오기 (폴더)
          </button>
        </div>

        {/* Export 카드 */}
        <div className="iocard">
          <div className="iocardhead">
            <h4>⬆ Export / Download</h4>
            <span className="hint tiny">현재: {activeName}</span>
          </div>
          <div className="exportbtns">
            <button onClick={() => download("yaml")}><b>openapi.yaml</b><span>다운로드</span></button>
            <button onClick={() => download("json")}><b>openapi.json</b><span>다운로드</span></button>
            <button onClick={exportBru}><b>.bru 컬렉션</b><span>프로젝트에 생성</span></button>
            <button onClick={() => download("html")}><b>Redoc HTML</b><span>단일 파일 다운로드</span></button>
          </div>
          <div className="sublabel">
            미리보기
            <button className="mini" onClick={() => preview_("yaml")}>YAML</button>
            <button className="mini" onClick={() => preview_("json")}>JSON</button>
          </div>
          <textarea className="rawedit" spellCheck={false} readOnly value={preview} placeholder="미리보기 버튼을 누르거나 다운로드하면 여기에 표시됩니다." />
        </div>
      </div>
      <div className="iostatus">{msg}</div>
    </div>
  );
}
