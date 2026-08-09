// F1: Bruno식 요청 중심 Builder.
// 좌: CollectionTree(우클릭 메뉴) / 우: 브레드크럼 + 요청 탭(multi-open) + RequestView.
import { useEffect, useState } from "react";
import { api } from "../ipc";
import { tabKey, useStore, type Target } from "../store";
import { useShallow } from "zustand/react/shallow";
import { CollectionTree, type TreeMenuItem } from "./CollectionTree";
import { RequestView } from "./RequestView";
import { Resizer, usePersistedSize } from "./Resizer";

const METHODS = ["get", "post", "put", "delete", "patch"];
const ALL_METHODS = ["get", "post", "put", "delete", "patch", "head", "options", "trace"];

type Dialog =
  | { kind: "newCollection" }
  | { kind: "newFolder"; parent: string }
  | { kind: "newRequest"; folder: string }
  | { kind: "renameFolder"; path: string; current: string }
  | { kind: "renameCollection"; current: string }
  | { kind: "renameRequest"; path: string; method: string; current: string }
  | { kind: "changeRequestPath"; path: string; method: string };

function remap(f: string, oldP: string, newP: string): string {
  if (f === oldP) return newP;
  if (f.startsWith(oldP + "/")) return newP + f.slice(oldP.length);
  return f;
}

export function Builder() {
  const {
    spec, updateSpec, diagnostics, clipboard, copyRequest, copyFolder, pasteInto,
    collections, activeCollectionId, setActiveCollection, addCollection, removeCollection,
    environments, activeEnvId, setActiveEnv,
    openTabs, activeTab, openTab, closeTab, setActiveTab, projectDir, logEvent,
  } = useStore(
    useShallow((s) => ({
      spec: s.spec, updateSpec: s.updateSpec, diagnostics: s.diagnostics, clipboard: s.clipboard,
      copyRequest: s.copyRequest, copyFolder: s.copyFolder, pasteInto: s.pasteInto,
      collections: s.collections, activeCollectionId: s.activeCollectionId, setActiveCollection: s.setActiveCollection,
      addCollection: s.addCollection, removeCollection: s.removeCollection,
      environments: s.environments, activeEnvId: s.activeEnvId, setActiveEnv: s.setActiveEnv,
      openTabs: s.openTabs, activeTab: s.activeTab, openTab: s.openTab, closeTab: s.closeTab,
      setActiveTab: s.setActiveTab, projectDir: s.projectDir, logEvent: s.logEvent,
    }))
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [branch, setBranch] = useState("");
  const [search, setSearch] = useState("");
  const [navMenu, setNavMenu] = useState<{ x: number; y: number } | null>(null);
  const [showEnv, setShowEnv] = useState(false);
  const activeEnv = environments.find((e) => e.id === activeEnvId);
  const [navW, setNavW] = usePersistedSize("plume:builderNavW", 280, 180, 620);

  // 브레드크럼용 git 브랜치(있으면).
  useEffect(() => {
    if (!projectDir) return setBranch("");
    api.gitStatus(projectDir).then((s) => setBranch(s.isRepo ? s.branch : "")).catch(() => setBranch(""));
  }, [projectDir]);

  // ── 변이 ──
  function createFolder(parent: string, name: string) {
    const path = parent ? `${parent}/${name}` : name;
    updateSpec((d) => { d["x-folders"] = [...new Set([...(d["x-folders"] ?? []), path])].sort(); });
    logEvent("Builder", `폴더 생성 · ${path}`);
  }
  function createRequest(folder: string, method: string, path: string, summary?: string) {
    updateSpec((d) => {
      d.paths ??= {}; d.paths[path] ??= {};
      const op: any = { summary: summary || undefined, responses: { "200": { description: "OK" } } };
      if (folder) op["x-folder"] = folder;
      d.paths[path][method] = op;
    });
    openTab(path, method);
    logEvent("Builder", `요청 생성 · ${method.toUpperCase()} ${path}`);
  }
  function renameFolder(oldPath: string, newName: string) {
    const parts = oldPath.split("/"); parts[parts.length - 1] = newName;
    const newPath = parts.join("/");
    if (newPath === oldPath || !newName) return;
    updateSpec((d) => {
      d["x-folders"] = [...new Set((d["x-folders"] ?? []).map((f: string) => remap(f, oldPath, newPath)))].sort();
      for (const p of Object.keys(d.paths ?? {})) for (const m of Object.keys(d.paths[p])) {
        if (!ALL_METHODS.includes(m)) continue;
        const op = d.paths[p][m];
        if (op?.["x-folder"]) op["x-folder"] = remap(op["x-folder"], oldPath, newPath);
      }
    });
  }
  function deleteFolder(path: string) {
    if (!confirm(`폴더 '${path}' 와 그 안의 모든 요청을 삭제할까요?`)) return;
    updateSpec((d) => {
      d["x-folders"] = (d["x-folders"] ?? []).filter((f: string) => f !== path && !f.startsWith(path + "/"));
      for (const p of Object.keys(d.paths ?? {})) {
        for (const m of Object.keys(d.paths[p])) {
          if (!ALL_METHODS.includes(m)) continue;
          const f = d.paths[p][m]?.["x-folder"] ?? "";
          if (f === path || f.startsWith(path + "/")) delete d.paths[p][m];
        }
        if (Object.keys(d.paths[p]).length === 0) delete d.paths[p];
      }
    });
  }
  function deleteRequest(path: string, method: string) {
    updateSpec((d) => {
      if (d.paths?.[path]) { delete d.paths[path][method]; if (Object.keys(d.paths[path]).length === 0) delete d.paths[path]; }
    });
    closeTab(path, method);
    logEvent("Builder", `요청 삭제 · ${method.toUpperCase()} ${path}`);
  }
  function renameCollection(name: string) {
    if (!name.trim()) return;
    updateSpec((d) => { d.info ??= {}; d.info.title = name.trim(); });
  }
  // 요청 이름(summary) 변경 — 호출 URL(path)과 무관.
  function setRequestName(path: string, method: string, name: string) {
    updateSpec((d) => { const op = d.paths?.[path]?.[method]; if (op) op.summary = name.trim() || undefined; });
  }
  // 요청 경로/메서드 변경(요청을 새 위치로 이동).
  function moveRequest(oldPath: string, oldMethod: string, newMethod: string, newPath: string) {
    const nm = newMethod.toLowerCase();
    if (!newPath.trim() || (oldPath === newPath && oldMethod === nm)) return;
    updateSpec((d) => {
      const op = d.paths?.[oldPath]?.[oldMethod];
      if (!op) return;
      delete d.paths[oldPath][oldMethod];
      if (Object.keys(d.paths[oldPath]).length === 0) delete d.paths[oldPath];
      d.paths[newPath] ??= {};
      d.paths[newPath][nm] = op;
    });
    closeTab(oldPath, oldMethod);
    openTab(newPath, nm);
  }

  // 컬렉션 id를 받아 그 컬렉션을 활성화한 뒤 동작하도록 메뉴를 구성.
  function menuFor(colId: string, t: Target): TreeMenuItem[] {
    const cspec = collections.find((c) => c.id === colId)?.spec;
    const sel = () => setActiveCollection(colId); // 쓰기 전 대상 컬렉션 활성화
    if (t.kind === "collection") {
      const items: TreeMenuItem[] = [
        { label: "📦 ＋ 새 컬렉션", run: () => setDialog({ kind: "newCollection" }) },
        { label: "＋ 새 폴더", run: () => { sel(); setDialog({ kind: "newFolder", parent: "" }); } },
        { label: "＋ 새 요청", run: () => { sel(); setDialog({ kind: "newRequest", folder: "" }); } },
        { label: "이름 변경", run: () => { sel(); setDialog({ kind: "renameCollection", current: cspec?.info?.title ?? "" }); } },
      ];
      if (collections.length > 1) items.push({ label: "🗑 이 컬렉션 삭제", run: () => confirm("이 컬렉션을 삭제할까요?") && removeCollection(colId) });
      if (clipboard) items.push({ label: "📋 붙여넣기", run: () => { sel(); pasteInto(""); } });
      return items;
    }
    if (t.kind === "folder") {
      const items: TreeMenuItem[] = [
        { label: "＋ 새 하위 폴더", run: () => { sel(); setDialog({ kind: "newFolder", parent: t.path }); } },
        { label: "＋ 새 요청", run: () => { sel(); setDialog({ kind: "newRequest", folder: t.path }); } },
        { label: "복사", run: () => { sel(); copyFolder(t.path); } },
      ];
      if (clipboard) items.push({ label: "📋 붙여넣기", run: () => { sel(); pasteInto(t.path); } });
      items.push({ label: "이름 변경", run: () => { sel(); setDialog({ kind: "renameFolder", path: t.path, current: t.path.split("/").pop() ?? "" }); } });
      items.push({ label: "삭제", run: () => { sel(); deleteFolder(t.path); } });
      return items;
    }
    return [
      { label: "열기", run: () => { sel(); openTab(t.path, t.method); } },
      { label: "이름 변경", run: () => { sel(); setDialog({ kind: "renameRequest", path: t.path, method: t.method, current: cspec?.paths?.[t.path]?.[t.method]?.summary ?? "" }); } },
      { label: "경로/메서드 변경", run: () => { sel(); setDialog({ kind: "changeRequestPath", path: t.path, method: t.method }); } },
      { label: "복사", run: () => { sel(); copyRequest(t.path, t.method); } },
      { label: "삭제", run: () => { sel(); deleteRequest(t.path, t.method); } },
    ];
  }

  const active = openTabs.find((t) => tabKey(t.path, t.method) === activeTab);
  const activeSel = active ? { path: active.path, method: active.method } : null;

  return (
    <div className="builder">
      <aside className="nav" style={{ width: navW, flex: "none" }}>
        <div className="apisearch">
          <span className="si">🔍</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="API 검색 (경로·메서드·요약)"
          />
          {search && <button className="clear" onClick={() => setSearch("")}>×</button>}
        </div>
        {/* 여러 컬렉션 동시 표시 · 빈 곳 우클릭 → 새 컬렉션 */}
        <div
          className="collections"
          onContextMenu={(e) => { e.preventDefault(); setNavMenu({ x: e.clientX, y: e.clientY }); }}
        >
          {collections.map((col) => (
            <CollectionTree
              key={col.id}
              spec={col.spec}
              collectionId={col.id}
              isActive={col.id === activeCollectionId}
              collectionLabel={col.name}
              selected={activeSel}
              onSelectCollection={(id) => setActiveCollection(id)}
              onSelectRequest={(p, m) => { setActiveCollection(col.id); openTab(p, m); }}
              menuFor={(t) => menuFor(col.id, t)}
              filter={search}
            />
          ))}
          <div className="navfill" />
        </div>

        {navMenu && (
          <>
            <div className="ctxoverlay" onClick={() => setNavMenu(null)} onContextMenu={(e) => { e.preventDefault(); setNavMenu(null); }} />
            <div className="ctxmenu" style={{ left: navMenu.x, top: navMenu.y }}>
              <div className="ctxitem" onClick={() => { setDialog({ kind: "newCollection" }); setNavMenu(null); }}>📦 ＋ 새 컬렉션</div>
              {clipboard && <div className="ctxitem" onClick={() => { pasteInto(""); setNavMenu(null); }}>📋 붙여넣기</div>}
            </div>
          </>
        )}
      </aside>

      <Resizer axis="x" onDelta={(d) => setNavW((w) => w + d)} />

      <section className="reqmain">
        {/* 브레드크럼 바 */}
        <div className="breadcrumb">
          <span className="crumb-col">📦
            <select value={activeCollectionId} onChange={(e) => setActiveCollection(e.target.value)}>
              {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button title="새 컬렉션" onClick={() => addCollection("New API")}>＋</button>
            {collections.length > 1 && <button title="컬렉션 삭제" onClick={() => confirm("이 컬렉션 삭제?") && removeCollection(activeCollectionId)}>🗑</button>}
          </span>
          {branch && <span className="crumb-branch">⑂ {branch}</span>}
          <span className="spacer" />
          <span className="crumb-env">🌐
            <select value={activeEnvId} onChange={(e) => setActiveEnv(e.target.value)}>
              {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <button className="envinfo" title="환경변수 값 보기" onClick={() => setShowEnv((v) => !v)}>ⓘ</button>
            {showEnv && (
              <>
                <div className="ctxoverlay" onClick={() => setShowEnv(false)} />
                <div className="envpop">
                  <div className="envpophead">
                    <strong>🌐 {activeEnv?.name ?? "환경"}</strong>
                    <button className="del" onClick={() => setShowEnv(false)}>×</button>
                  </div>
                  {activeEnv && Object.keys(activeEnv.variables ?? {}).length > 0 ? (
                    <table className="envpoptable">
                      <tbody>
                        {Object.entries(activeEnv.variables).map(([k, val]) => (
                          <tr key={k}>
                            <td className="envk">{k}</td>
                            <td className="envv">{val === "" ? <span className="hint tiny">(빈 값)</span> : String(val)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="hint tiny" style={{ padding: "10px 12px" }}>변수가 없습니다. Env 탭에서 추가하세요.</p>
                  )}
                </div>
              </>
            )}
          </span>
        </div>

        {/* 요청 탭 */}
        <div className="reqtabs">
          {openTabs.map((t) => {
            const k = tabKey(t.path, t.method);
            return (
              <div key={k} className={k === activeTab ? "reqtab active" : "reqtab"} onClick={() => setActiveTab(k)} title={t.path}>
                <span className={`m m-${t.method}`}>{t.method.toUpperCase()}</span>
                <span className="tpath">{spec?.paths?.[t.path]?.[t.method]?.summary || t.path}</span>
                <span className="tclose" onClick={(e) => { e.stopPropagation(); closeTab(t.path, t.method); }}>×</span>
              </div>
            );
          })}
          {openTabs.length === 0 && <span className="hint tiny" style={{ padding: "8px 12px" }}>트리에서 요청을 클릭해 탭으로 여세요</span>}
        </div>

        {/* 활성 요청 뷰 */}
        <div className="reqcontent">
          {active ? (
            <RequestView key={activeTab} path={active.path} method={active.method} />
          ) : (
            <div className="reqview">
              <p className="hint">좌측 트리에서 요청을 선택하거나 우클릭으로 새로 만드세요.</p>
              {diagnostics.length > 0 && (
                <>
                  <h3>Diagnostics</h3>
                  <ul className="diags">
                    {diagnostics.map((d, i) => (
                      <li key={i} className={`d ${d.severity}`}><code>{d.path}</code> — {d.message}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      {dialog && (
        <TreeDialog
          dialog={dialog}
          onClose={() => setDialog(null)}
          onFolder={createFolder}
          onRequest={createRequest}
          onRename={renameFolder}
          onRenameCollection={renameCollection}
          onSetRequestName={setRequestName}
          onMoveRequest={moveRequest}
          onNewCollection={(nm) => addCollection(nm)}
        />
      )}
    </div>
  );
}

function TreeDialog({
  dialog, onClose, onFolder, onRequest, onRename, onRenameCollection, onSetRequestName, onMoveRequest, onNewCollection,
}: {
  dialog: Dialog;
  onClose: () => void;
  onFolder: (parent: string, name: string) => void;
  onRequest: (folder: string, method: string, path: string, summary?: string) => void;
  onRename: (path: string, newName: string) => void;
  onRenameCollection: (name: string) => void;
  onSetRequestName: (path: string, method: string, name: string) => void;
  onMoveRequest: (oldPath: string, oldMethod: string, newMethod: string, newPath: string) => void;
  onNewCollection: (name: string) => void;
}) {
  const nameForms = dialog.kind === "renameFolder" || dialog.kind === "renameCollection" || dialog.kind === "renameRequest" || dialog.kind === "newCollection";
  const changePath = dialog.kind === "changeRequestPath";
  const [name, setName] = useState(nameForms && "current" in dialog ? (dialog as any).current : "");
  const [method, setMethod] = useState(changePath ? dialog.method : "get");
  const [path, setPath] = useState(changePath ? dialog.path : "/");
  const [summary, setSummary] = useState("");

  function confirmDlg() {
    if (dialog.kind === "newCollection" && name.trim()) onNewCollection(name.trim());
    else if (dialog.kind === "newFolder" && name.trim()) onFolder(dialog.parent, name.trim());
    else if (dialog.kind === "renameFolder" && name.trim()) onRename(dialog.path, name.trim());
    else if (dialog.kind === "renameCollection" && name.trim()) onRenameCollection(name.trim());
    else if (dialog.kind === "renameRequest") onSetRequestName(dialog.path, dialog.method, name);
    else if (dialog.kind === "newRequest" && path.trim()) onRequest(dialog.folder, method, path.trim(), summary);
    else if (changePath && path.trim()) onMoveRequest(dialog.path, dialog.method, method, path.trim());
    onClose();
  }
  const title =
    dialog.kind === "newCollection" ? "📦 새 컬렉션"
    : dialog.kind === "newFolder" ? `새 폴더 · 위치: ${dialog.parent || "(루트)"}`
    : dialog.kind === "renameFolder" ? "폴더 이름 변경"
    : dialog.kind === "renameCollection" ? "컬렉션 이름 변경"
    : dialog.kind === "renameRequest" ? "요청 이름 변경 (표시명)"
    : dialog.kind === "changeRequestPath" ? "요청 경로/메서드 변경 (호출 URL)"
    : `새 요청 · 폴더: ${dialog.folder || "(루트)"}`;

  const methodPathForm = dialog.kind === "newRequest" || changePath;
  const placeholder =
    dialog.kind === "newCollection" ? "컬렉션 이름 (예: Users API)"
    : dialog.kind === "renameCollection" ? "컬렉션 이름"
    : dialog.kind === "renameRequest" ? "요청 이름 (예: 테스트 계정 로그인)"
    : "폴더 이름";

  return (
    <div className="modalbg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {methodPathForm ? (
          <>
            <div className="row">
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}
              </select>
              <input autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path"
                onKeyDown={(e) => e.key === "Enter" && confirmDlg()} style={{ flex: 1 }} />
            </div>
            {dialog.kind === "newRequest" && (
              <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="요청 이름 (선택)" />
            )}
          </>
        ) : (
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder={placeholder}
            onKeyDown={(e) => e.key === "Enter" && confirmDlg()} />
        )}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <button onClick={onClose}>취소</button>
          <button className="active" onClick={confirmDlg}>확인</button>
        </div>
      </div>
    </div>
  );
}
