import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api } from "./ipc";
import { pickDirectory } from "./dialog";
import { LAST_FOLDER_KEY, PROJECT_ROOT_KEY, basename, emptySpec, useStore, type BuilderTab, type Gnb } from "./store";
import { useShallow } from "zustand/react/shallow";
import { useStore as useZustandStore } from "zustand";
import { checkForUpdate, needsUpdate, applyUpdate, CURRENT_VERSION, type UpdateCheck, type UpdateInfo } from "./update";
import { ErrorBoundary } from "./features/ErrorBoundary";
import { Builder } from "./features/Builder";

// 시작 시엔 기본 화면(Builder)만 로드하고, 보조 탭·모달은 처음 열 때 지연 로드한다.
// 특히 ApiCallChain은 무거운 다이어그램 의존성(mermaid·cytoscape·katex ~1MB)을 포함.
const ApiCallChain = lazy(() => import("./features/ApiCallChain").then((m) => ({ default: m.ApiCallChain })));
const Docs = lazy(() => import("./features/Docs").then((m) => ({ default: m.Docs })));
const Load = lazy(() => import("./features/Load").then((m) => ({ default: m.Load })));
const Environments = lazy(() => import("./features/Environments").then((m) => ({ default: m.Environments })));
const ImportPanel = lazy(() => import("./features/ImportExport").then((m) => ({ default: m.ImportPanel })));
const ExportPanel = lazy(() => import("./features/ImportExport").then((m) => ({ default: m.ExportPanel })));
const Git = lazy(() => import("./features/Git").then((m) => ({ default: m.Git })));
const History = lazy(() => import("./features/History").then((m) => ({ default: m.History })));
const Settings = lazy(() => import("./features/Settings").then((m) => ({ default: m.Settings })));

// 워크스페이스 로드/생성은 되돌리기 대상이 아니다. 하지만 히스토리 저장이 500ms 디바운스라
// 즉시 clear()만으론 직후 예약분이 다시 쌓인다 → pause 후 디바운스 창을 넘겨 clear+resume.
function resetUndoHistory() {
  const t = (useStore as any).temporal.getState();
  t.pause();
  t.clear();
  setTimeout(() => {
    const tt = (useStore as any).temporal.getState();
    tt.clear();
    tt.resume();
  }, 600);
}

const LNB: { id: Gnb; label: string; icon: string }[] = [
  { id: "builder", label: "Builder", icon: "📦" },
  { id: "environment", label: "Env", icon: "🌐" },
  { id: "git", label: "Git", icon: "⎇" },
  { id: "history", label: "History", icon: "🕘" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

// 프로젝트 폴더별 마지막으로 연 워크스페이스 이름(폴더 재선택 시 자동 복원).
const LAST_WS_KEY = "plume:lastWsByRoot";
function lastWsFor(root: string): string | null {
  try { return (JSON.parse(localStorage.getItem(LAST_WS_KEY) || "{}") as Record<string, string>)[root] ?? null; }
  catch { return null; }
}
function setLastWsFor(root: string, name: string) {
  try {
    const m = JSON.parse(localStorage.getItem(LAST_WS_KEY) || "{}") as Record<string, string>;
    m[root] = name;
    localStorage.setItem(LAST_WS_KEY, JSON.stringify(m));
  } catch {}
}

const BUILDER_TABS: { id: BuilderTab; label: string }[] = [
  { id: "design", label: "Design" },
  { id: "call", label: "API Call Chain" },
  { id: "load", label: "Run" },
  { id: "docs", label: "Specification" },
];

export function App() {
  const {
    gnb, setGnb, builderTab, setBuilderTab,
    diagnostics, projectDir, setProjectDir, projectRoot, setProjectRoot, loadClient,
  } = useStore(
    useShallow((s) => ({
      gnb: s.gnb, setGnb: s.setGnb, builderTab: s.builderTab, setBuilderTab: s.setBuilderTab,
      diagnostics: s.diagnostics, projectDir: s.projectDir, setProjectDir: s.setProjectDir,
      projectRoot: s.projectRoot, setProjectRoot: s.setProjectRoot, loadClient: s.loadClient,
    }))
  );
  const [status, setStatus] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  const [showNewWs, setShowNewWs] = useState(false);
  // 되돌리기/다시하기 가능 여부(zundo temporal 구독).
  const canUndo = useZustandStore((useStore as any).temporal, (s: any) => s.pastStates.length > 0);
  const canRedo = useZustandStore((useStore as any).temporal, (s: any) => s.futureStates.length > 0);
  const [confirmDlg, setConfirmDlg] = useState<{ title: string; message: string; okLabel: string; danger?: boolean; onOk: () => void } | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [showUpdate, setShowUpdate] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState(0);

  // 서버에서 업데이트 확인(서명 검증 포함). manual=true면 사용자가 직접 누른 것.
  async function runUpdateCheck(manual = false) {
    setChecking(true);
    try {
      const chk = await checkForUpdate();
      setUpdate(chk);
      if (needsUpdate(chk.info)) setShowUpdate(true);
      else if (manual) useStore.getState().showToast("최신 버전입니다 ✓");
    } catch (e: any) {
      if (manual) useStore.getState().showToast(`업데이트 확인 실패: ${e?.message ?? e}`, "err");
    } finally {
      setChecking(false);
    }
  }
  // 다운로드+설치(서명검증)→재시작. mock이면 다운로드 페이지 열기.
  async function doApplyUpdate() {
    if (!update) return;
    setUpdating(true);
    setProgress(0);
    useStore.getState().logEvent("Update", `업데이트 시작 · v${update.info.latestVersion}`);
    try {
      await applyUpdate(update, (f) => setProgress(f));
      // 실제 경로는 relaunch로 재시작됨. mock이면 여기 도달.
      if (update.mock) {
        useStore.getState().showToast(`다운로드 페이지를 열었습니다 (v${update.info.latestVersion})`);
        setShowUpdate(false);
      }
    } catch (e: any) {
      useStore.getState().showToast(`업데이트 실패: ${e?.message ?? e}`, "err");
    } finally {
      setUpdating(false);
    }
  }
  // 시작 시 자동 확인 — 우선 비활성화(업데이트 모달 자동 팝업 끔).
  // 다시 켜려면 아래 주석 해제. 툴바 버전칩 클릭 시의 수동 확인은 유지.
  // useEffect(() => { runUpdateCheck(false); }, []);

  useEffect(() => {
    api.ping().then((p) => setStatus(`core: ${p}`)).catch(() => setStatus("core: 연결 실패"));
  }, []);

  // 워크스페이스 저장(수동 Ctrl+S=silent:false, 자동=silent:true). 컬렉션+환경+체인+메타.
  const saveWorkspace = useCallback(async (silent: boolean) => {
    const st = useStore.getState();
    const dir = st.projectDir;
    if (!dir) { if (!silent) st.showToast("워크스페이스를 먼저 여세요", "err"); return; }
    const cols = st.collections.map((c) => ({ name: c.name, spec: c.spec }));
    try {
      await api.saveWorkspaceCollections(dir, cols);
      await st.persistClient(dir);
      await api.writeTextFile(`${dir}/.apigen/chains.json`, JSON.stringify(st.chains, null, 2));
      await api.writeTextFile(`${dir}/.plume/workspace.json`, JSON.stringify({ name: st.workspaceName || basename(dir) }, null, 2));
      if (silent) {
        setStatus(`자동 저장됨 · ${new Date().toLocaleTimeString()}`);
      } else {
        st.showToast(`저장됨 ✓ (컬렉션 ${cols.length})`);
        st.logEvent("Save", `워크스페이스 저장 · ${st.workspaceName} · 컬렉션 ${cols.length}`);
      }
    } catch (err: any) {
      if (silent) setStatus(`자동 저장 실패: ${err?.message ?? err}`);
      else st.showToast(`저장 실패: ${err?.message ?? err}`, "err");
    }
  }, []);

  // 자동 저장: collections/chains 변경 후 2초 뒤 조용히 저장(변경분만 쓰므로 저렴). 데이터 유실 방지.
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsub = useStore.subscribe((state: any, prev: any) => {
      if (state.collections === prev.collections && state.chains === prev.chains) return;
      if (!useStore.getState().projectDir) return;
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => { void saveWorkspace(true); }, 2000);
    });
    return () => { unsub(); if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [saveWorkspace]);

  // Ctrl+S: 워크스페이스의 모든 컬렉션 + 환경 + 체인 저장.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void saveWorkspace(false);
      }
      // 화면 이동: Ctrl+1..5 = Nav / Ctrl+Shift+1..4 = Builder 하위탭. (code로 레이아웃 무관)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && /^Digit[1-5]$/.test(e.code)) {
        e.preventDefault();
        const n = Number(e.code.slice(5));
        const st = useStore.getState();
        if (e.shiftKey) {
          const subs: BuilderTab[] = ["design", "call", "load", "docs"];
          if (n <= 4) { st.setGnb("builder"); st.setBuilderTab(subs[n - 1]); }
        } else {
          const navs: Gnb[] = ["builder", "environment", "git", "history", "settings"];
          st.setGnb(navs[n - 1]);
        }
        return;
      }
      // 단축키 도움말: ? (입력 중이 아닐 때). F1 도 허용.
      const ae = document.activeElement as HTMLElement | null;
      const typing = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable);
      if (!typing && (e.key === "?" || e.key === "F1")) {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }
      if (e.key === "Escape" && showShortcuts) { setShowShortcuts(false); return; }
      // Ctrl+Z 되돌리기 / Ctrl+Shift+Z·Ctrl+Y 다시하기 (스펙·DnD·컬렉션·환경 전부).
      const z = e.key.toLowerCase() === "z";
      const y = e.key.toLowerCase() === "y";
      if ((e.ctrlKey || e.metaKey) && z && !e.shiftKey) {
        e.preventDefault();
        (useStore as any).temporal.getState().undo();
        void useStore.getState().revalidate();
      } else if ((e.ctrlKey || e.metaKey) && ((z && e.shiftKey) || y)) {
        e.preventDefault();
        (useStore as any).temporal.getState().redo();
        void useStore.getState().revalidate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveWorkspace, showShortcuts]);

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warns = diagnostics.filter((d) => d.severity === "warning").length;

  // 프로젝트 폴더(root) 하위 워크스페이스 목록 갱신 후 목록 반환.
  async function refreshWorkspaces(root: string) {
    try {
      const ws = await api.listWorkspaces(root);
      useStore.getState().setWorkspaces(ws);
      return ws;
    } catch { useStore.getState().setWorkspaces([]); return []; }
  }
  // 프로젝트 폴더 지정 → 하위 워크스페이스 목록 로드 + 마지막(또는 첫) 워크스페이스 자동 열기.
  async function openRoot(root: string) {
    const target = root.trim();
    if (!target) return;
    const st = useStore.getState();
    setProjectRoot(target);
    try { localStorage.setItem(PROJECT_ROOT_KEY, target); } catch {}
    st.addRecentRoot(target);
    const ws = await refreshWorkspaces(target);
    if (ws.length > 0) {
      const lastName = lastWsFor(target);
      const pick = ws.find((w) => w.name === lastName) || ws[0];
      openWorkspace(pick.name);
      return;
    }
    // 하위 워크스페이스가 없으면, 폴더 자체가 프로젝트(레거시 flat 또는 collections 직접)인지 확인.
    try {
      const cols = await api.loadWorkspaceCollections(target);
      if (cols.length > 0) {
        // 폴더 자체를 워크스페이스로 열기(기존 저장 데이터 복구).
        useStore.getState().setWorkspaces([{ name: basename(target), path: target }]);
        openWorkspaceAt(target, basename(target));
        return;
      }
    } catch { /* 무시 */ }
    setProjectDir(null); // 진짜 빈 폴더 → 워크스페이스 생성 화면
    setStatus(`프로젝트 폴더: ${target} · 워크스페이스를 만드세요`);
  }
  async function browseRoot() {
    const d = await pickDirectory();
    if (d) openRoot(d);
  }
  // 워크스페이스(하위 폴더 name) 열기.
  async function openWorkspace(name: string, auto = false) {
    const root = useStore.getState().projectRoot;
    if (!root) return;
    openWorkspaceAt(`${root}/${name}`, name, auto);
  }
  // 임의 경로(dir)를 워크스페이스로 열기 → 다중 컬렉션·환경·체인 로드.
  async function openWorkspaceAt(dir: string, name: string, auto = false) {
    const root = useStore.getState().projectRoot;
    const st = useStore.getState();
    setProjectDir(dir);
    st.setWorkspaceName(name);
    try { localStorage.setItem(LAST_FOLDER_KEY, dir); } catch {}
    if (root) setLastWsFor(root, name);
    await loadClient(dir); // 환경 + config
    try {
      const txt = await api.readTextFile(`${dir}/.apigen/chains.json`);
      st.setChains(txt ? JSON.parse(txt) : []);
    } catch { st.setChains([]); }
    try {
      const cols = await api.loadWorkspaceCollections(dir);
      st.loadCollections(cols);
      setStatus(`열림: ${name} · 컬렉션 ${cols.length}`);
    } catch (e: any) {
      if (auto) {
        setProjectDir(null);
        setStatus("워크스페이스를 열 수 없어 초기화됨");
      } else {
        st.loadCollections([]);
        setStatus(`워크스페이스 '${name}' 설정 · Ctrl+S로 저장`);
      }
    }
    // 워크스페이스 로드는 되돌리기 대상이 아님 — 히스토리 초기화(디바운스 예약분까지).
    resetUndoHistory();
  }
  // 새 워크스페이스(서브폴더) 생성 → 기본 컬렉션 1개.
  async function createWorkspace(rawName: string) {
    const root = useStore.getState().projectRoot;
    const name = rawName.trim();
    if (!root || !name) return;
    const dir = `${root}/${name}`;
    const st = useStore.getState();
    setProjectDir(dir);
    st.setWorkspaceName(name);
    try { localStorage.setItem(LAST_FOLDER_KEY, dir); } catch {}
    setLastWsFor(root, name);
    st.setChains([]);
    st.loadCollections([{ name: "New API", spec: emptySpec("New API") }]);
    resetUndoHistory(); // 새 워크스페이스 생성은 되돌리기 대상 아님(이전 워크스페이스로 복귀 방지)
    try {
      await api.writeTextFile(`${dir}/.plume/workspace.json`, JSON.stringify({ name }, null, 2));
      await api.saveWorkspaceCollections(dir, [{ name: "New API", spec: useStore.getState().spec }]);
      await refreshWorkspaces(root);
      setStatus(`새 워크스페이스: ${name}`);
      st.showToast(`워크스페이스 '${name}' 생성됨 ✓`);
      st.logEvent("Workspace", `생성 · ${name}`);
    } catch (e: any) {
      setStatus(`워크스페이스 생성 실패: ${e?.message ?? e}`);
    }
  }

  // 워크스페이스 삭제(폴더 제거) — 앱 테마 확인 모달로 물어본 뒤 실행.
  function deleteWorkspaceHandler(name: string) {
    setConfirmDlg({
      title: "워크스페이스 삭제",
      message: `워크스페이스 '${name}'을(를) 정말 삭제하시겠습니까?\n폴더의 모든 컬렉션·환경·설정이 영구 삭제되며 되돌릴 수 없습니다.`,
      okLabel: "삭제",
      danger: true,
      onOk: () => doDeleteWorkspace(name),
    });
  }
  async function doDeleteWorkspace(name: string) {
    const st = useStore.getState();
    const root = st.projectRoot;
    if (!root) return;
    try {
      await api.deleteWorkspace(root, name);
      const remaining = (await refreshWorkspaces(root)).filter((w) => w.name !== name);
      st.showToast(`워크스페이스 '${name}' 삭제됨`);
      st.logEvent("Workspace", `삭제 · ${name}`);
      if (st.workspaceName === name) {
        if (remaining.length) openWorkspace(remaining[0].name);
        else setProjectDir(null); // 남은 워크스페이스 없음 → 생성 화면
      }
    } catch (e: any) {
      st.showToast(`삭제 실패: ${e?.message ?? e}`, "err");
    }
  }

  // 워크스페이스 이름 변경(폴더 rename). 현재 열린 워크스페이스면 경로·이름을 새 값으로 갱신.
  async function renameWorkspaceHandler(oldName: string, newName: string) {
    const st = useStore.getState();
    const root = st.projectRoot;
    if (!root) return;
    try {
      const newDir = await api.renameWorkspace(root, oldName, newName);
      if (lastWsFor(root) === oldName) setLastWsFor(root, newName);
      if (st.workspaceName === oldName) {
        setProjectDir(newDir);
        st.setWorkspaceName(newName);
        try { localStorage.setItem(LAST_FOLDER_KEY, newDir); } catch {}
      }
      await refreshWorkspaces(root);
      st.showToast(`이름 변경됨: ${newName} ✓`);
      st.logEvent("Workspace", `이름 변경 · ${oldName} → ${newName}`);
    } catch (e: any) {
      st.showToast(`변경 실패: ${e?.message ?? e}`, "err");
    }
  }

  // 시작 시: 저장된 프로젝트 폴더가 있으면 열기(내부에서 마지막 워크스페이스 자동 선택).
  useEffect(() => {
    const root = useStore.getState().projectRoot;
    if (root) openRoot(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">
          <span className="logo">🪶</span> Plume
        </strong>
        {/* 프로젝트 폴더(상위) 선택·변경 버튼 — 항상 표시 */}
        {projectRoot ? (
          <button className="rootbtn" onClick={browseRoot} title={`프로젝트 폴더 변경\n${projectRoot}`}>
            📁 {basename(projectRoot)}
          </button>
        ) : (
          <button className="active" onClick={browseRoot}>📁 프로젝트 폴더 선택</button>
        )}
        {/* 워크스페이스 전환(현재/마지막 워크스페이스명 표시) + 새 워크스페이스 ＋ */}
        <WorkspaceSwitcher onOpenWs={openWorkspace} onNewWs={() => setShowNewWs(true)} onChangeRoot={browseRoot} onRenameWs={renameWorkspaceHandler} onDeleteWs={deleteWorkspaceHandler} />
        {projectRoot && <button className="wsadd" title="새 워크스페이스" onClick={() => setShowNewWs(true)}>＋</button>}
        {projectDir && <button onClick={() => setShowImport(true)}>⬇ Import</button>}
        {projectDir && <button onClick={() => setShowExport(true)}>⬆ Export</button>}
        {projectDir && (
          <>
            <button className="iconbtn" title="되돌리기 (Ctrl+Z)" disabled={!canUndo}
              onClick={() => { (useStore as any).temporal.getState().undo(); void useStore.getState().revalidate(); }}>↶</button>
            <button className="iconbtn" title="다시하기 (Ctrl+Shift+Z)" disabled={!canRedo}
              onClick={() => { (useStore as any).temporal.getState().redo(); void useStore.getState().revalidate(); }}>↷</button>
          </>
        )}
        <span className="spacer" />
        {/* 업데이트: 사용 가능하면 강조 버튼, 아니면 버전칩(클릭=재확인) */}
        {update && needsUpdate(update.info) ? (
          <button className="updatebtn" title={`새 버전 v${update.info.latestVersion} 사용 가능`} onClick={() => setShowUpdate(true)}>
            ⬆ 업데이트 v{update.info.latestVersion}
          </button>
        ) : (
          <button className="verchip" title="업데이트 확인" onClick={() => runUpdateCheck(true)}>
            {checking ? "확인 중…" : `v${CURRENT_VERSION}`}
          </button>
        )}
        <button className="diagbadges" title="진단 로그 보기" onClick={() => setShowDiag((v) => !v)}>
          <span className={errors ? "badge err" : "badge"}>err {errors}</span>
          <span className={warns ? "badge warn" : "badge"}>warn {warns}</span>
        </button>
        <button className="iconbtn" title="단축키 보기 (?)" onClick={() => setShowShortcuts(true)}>⌨</button>
        <span className="status">{status}</span>
      </header>

      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}

      {showDiag && (
        <>
          <div className="ctxoverlay" onClick={() => setShowDiag(false)} />
          <div className="diagpanel">
            <div className="diagpanelhead">
              <strong>Diagnostics ({diagnostics.length})</strong>
              <button className="del" onClick={() => setShowDiag(false)}>×</button>
            </div>
            {diagnostics.length === 0 ? (
              <p className="ok" style={{ padding: 14 }}>문제 없음 ✓</p>
            ) : (
              <ul className="diaglist">
                {diagnostics.map((d, i) => (
                  <li key={i} className={`d ${d.severity}`}>
                    <span className={`diagsev ${d.severity}`}>{d.severity}</span>
                    <div className="diagbody">
                      <code>{d.path}</code>
                      <span className="diagmsg">{d.message}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {!projectDir ? (
        <WorkspaceGate onOpenRoot={openRoot} onBrowseRoot={browseRoot} onOpenWs={openWorkspace} onNewWs={() => setShowNewWs(true)} />
      ) : (
        <div className="body">
          {/* 좌측 LNB 아이콘 레일 */}
          <nav className="lnb">
            {LNB.map((t) => (
              <button
                key={t.id}
                className={gnb === t.id ? "lnbitem active" : "lnbitem"}
                onClick={() => setGnb(t.id)}
                title={t.label}
              >
                <span className="lnbicon">{t.icon}</span>
                <span className="lnblabel">{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="mainarea">
            {/* Builder 하위 탭 */}
            {gnb === "builder" && (
              <nav className="tabs subtabs">
                {BUILDER_TABS.map((t) => (
                  <button
                    key={t.id}
                    className={builderTab === t.id ? "tab active" : "tab"}
                    onClick={() => setBuilderTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>
            )}

            <main className="content">
              <ErrorBoundary key={`${gnb}:${builderTab}`}>
                <Suspense fallback={<div className="hint" style={{ padding: 20 }}>로딩 중…</div>}>
                  {gnb === "builder" && builderTab === "design" && <Builder />}
                  {gnb === "builder" && builderTab === "call" && <ApiCallChain />}
                  {gnb === "builder" && builderTab === "load" && <Load />}
                  {gnb === "builder" && builderTab === "docs" && <Docs />}
                  {gnb === "environment" && <Environments />}
                  {gnb === "git" && <Git />}
                  {gnb === "history" && <History />}
                  {gnb === "settings" && <Settings />}
                </Suspense>
              </ErrorBoundary>
            </main>
          </div>
        </div>
      )}

      <Toast />

      {showImport && (
        <div className="modalbg" onClick={() => setShowImport(false)}>
          <div className="modal iomodal" onClick={(e) => e.stopPropagation()}>
            <div className="iomodalhead">
              <h3>⬇ Import</h3>
              <button onClick={() => setShowImport(false)}>닫기</button>
            </div>
            <Suspense fallback={<div className="hint" style={{ padding: 20 }}>로딩 중…</div>}>
              <ImportPanel />
            </Suspense>
          </div>
        </div>
      )}

      {showExport && (
        <div className="modalbg" onClick={() => setShowExport(false)}>
          <div className="modal iomodal" onClick={(e) => e.stopPropagation()}>
            <div className="iomodalhead">
              <h3>⬆ Export</h3>
              <button onClick={() => setShowExport(false)}>닫기</button>
            </div>
            <Suspense fallback={<div className="hint" style={{ padding: 20 }}>로딩 중…</div>}>
              <ExportPanel />
            </Suspense>
          </div>
        </div>
      )}

      {confirmDlg && (
        <div className="modalbg" onClick={() => setConfirmDlg(null)}>
          <div className="modal confirmmodal" onClick={(e) => e.stopPropagation()}>
            <h3>{confirmDlg.title}</h3>
            <p className="confirmmsg">{confirmDlg.message}</p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12, gap: 8 }}>
              <button onClick={() => setConfirmDlg(null)}>취소</button>
              <button
                className={confirmDlg.danger ? "active danger" : "active"}
                onClick={() => { const ok = confirmDlg.onOk; setConfirmDlg(null); ok(); }}
              >
                {confirmDlg.okLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewWs && (
        <NewWorkspaceModal
          onClose={() => setShowNewWs(false)}
          onCreate={(name) => { setShowNewWs(false); createWorkspace(name); }}
        />
      )}

      {showUpdate && update && (
        <UpdateModal
          info={update.info}
          mock={update.mock}
          updating={updating}
          progress={progress}
          onClose={() => !updating && setShowUpdate(false)}
          onUpdate={doApplyUpdate}
        />
      )}
    </div>
  );
}

// 업데이트 안내 모달(다운로드 진행률 포함).
function UpdateModal({ info, mock, updating, progress, onClose, onUpdate }: {
  info: UpdateInfo;
  mock: boolean;
  updating: boolean;
  progress: number;
  onClose: () => void;
  onUpdate: () => void;
}) {
  return (
    <div className="modalbg" onClick={info.mandatory || updating ? undefined : onClose}>
      <div className="modal updatemodal" onClick={(e) => e.stopPropagation()}>
        <h3>⬆ 업데이트 가능</h3>
        <div className="updateverrow">
          <span className="verchip">현재 v{info.currentVersion}</span>
          <span className="verarrow">→</span>
          <span className="verchip new">최신 v{info.latestVersion}</span>
          {info.mandatory && <span className="badge err">필수</span>}
        </div>
        <div className="sublabel">변경 사항</div>
        <pre className="updatenotes">{info.releaseNotes || "(변경 사항 없음)"}</pre>
        {mock && <div className="hint tiny">⚠ 데모(서버 미연결): 실제 배포 시 서명 검증 후 자동 설치·재시작됩니다. 지금은 다운로드 페이지를 엽니다.</div>}

        {updating ? (
          <div style={{ marginTop: 12 }}>
            <div className="sublabel">{progress >= 1 ? "설치 후 재시작합니다…" : `다운로드 중… ${Math.round(progress * 100)}%`}</div>
            <div className="updateprog"><div className="updateprogbar" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          </div>
        ) : (
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12, gap: 6 }}>
            {!info.mandatory && <button onClick={onClose}>나중에</button>}
            <button className="active" onClick={onUpdate}>{mock ? "다운로드 열기" : "지금 업데이트"}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// 단축키 도움말 모달 — 화면별로 구성. item: [keys, desc, "key"|"mouse"].
type ScItem = [string, string, ("key" | "mouse")?];
const SHORTCUT_GROUPS: { title: string; hint?: string; items: ScItem[] }[] = [
  {
    title: "전역 · 모든 화면",
    items: [
      ["Ctrl+1 ~ 5", "화면 전환: Builder · Env · Git · History · Settings"],
      ["Ctrl+S", "워크스페이스 저장 (변경 시 2초 뒤 자동 저장도 됨)"],
      ["? / F1", "이 단축키 창 열기 · 닫기"],
      ["Esc", "열린 창 · 메뉴 닫기"],
    ],
  },
  {
    title: "Builder · Design (요청 트리)",
    items: [
      ["Ctrl+Shift+1 ~ 4", "하위 탭: Design · API Call Chain · Run · Specification"],
      ["Ctrl+Z", "되돌리기 (편집 · 드래그 · 컬렉션/폴더 조작)"],
      ["Ctrl+Shift+Z / Ctrl+Y", "다시하기"],
      ["우클릭", "트리: 새 폴더 · 새 요청 · 이름변경 · 복사 · 삭제 · 스크립트", "mouse"],
      ["드래그", "요청을 다른 폴더 · 컬렉션으로 이동", "mouse"],
    ],
  },
  {
    title: "Builder · 요청 편집",
    items: [
      ["Enter", "URL 바에서 경로 · 변수 반영", "key"],
      ["우클릭", "요청 탭: 닫기 · 다른 탭 닫기 · 복제", "mouse"],
      ["클릭", "URL의 {{변수}} → 값 편집 · 다른 환경변수 선택", "mouse"],
    ],
  },
  {
    title: "Specification · Settings",
    items: [
      ["버튼", "Specification: 단일 HTML · GitHub Pages · CloudFront 배포", "mouse"],
      ["버튼", "Settings: AWS 자격증명 · 배포 설정(암호화 저장)", "mouse"],
    ],
  },
];

const hangul = /[가-힣]/;
function ScKeys({ keys, mouse }: { keys: string; mouse?: boolean }) {
  return (
    <>
      {keys.split(/\s+/).map((k, i) => {
        if (k === "/" || k === "~" || k === "·") return <span key={i} className="scsep">{k}</span>;
        if (mouse || hangul.test(k)) return <span key={i} className="scmouse">{k}</span>;
        return <kbd key={i}>{k}</kbd>;
      })}
    </>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modalbg" onClick={onClose}>
      <div className="modal shortcutsmodal" onClick={(e) => e.stopPropagation()}>
        <div className="iomodalhead">
          <h3>⌨ 단축키 · 화면별 안내</h3>
          <button onClick={onClose}>닫기</button>
        </div>
        <div className="shortcutsbody">
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g.title} className="scgroup">
              <div className="scgrouptitle">{g.title}</div>
              <table className="sctable">
                <tbody>
                  {g.items.map(([keys, desc, kind], i) => (
                    <tr key={i}>
                      <td className="sckeys"><ScKeys keys={keys} mouse={kind === "mouse"} /></td>
                      <td className="scdesc">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <p className="hint tiny" style={{ margin: "6px 16px 12px" }}>macOS에서는 Ctrl 대신 ⌘(Cmd) 를 사용하세요.</p>
      </div>
    </div>
  );
}

// 새 워크스페이스 생성 모달.
function NewWorkspaceModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const projectRoot = useStore((s) => s.projectRoot);
  const workspaces = useStore((s) => s.workspaces);
  const [name, setName] = useState("");
  const exists = workspaces.some((w) => w.name.toLowerCase() === name.trim().toLowerCase());
  const ok = !!name.trim() && !exists && !/[\\/]/.test(name);
  return (
    <div className="modalbg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>🗂 새 워크스페이스</h3>
        <p className="hint tiny" title={projectRoot ?? ""}>📁 {projectRoot ? basename(projectRoot) : "(프로젝트 폴더 없음)"} 하위에 만듭니다.</p>
        <input
          autoFocus
          value={name}
          placeholder="워크스페이스 이름 (예: staging)"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ok && onCreate(name.trim())}
        />
        {exists && <p className="err" style={{ fontSize: 11 }}>같은 이름의 워크스페이스가 이미 있습니다.</p>}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10, gap: 6 }}>
          <button onClick={onClose}>취소</button>
          <button className="active" disabled={!ok} onClick={() => onCreate(name.trim())}>생성</button>
        </div>
      </div>
    </div>
  );
}

// 게이트: 프로젝트 폴더 선택 → 워크스페이스 선택/생성.
function WorkspaceGate({ onOpenRoot, onBrowseRoot, onOpenWs, onNewWs }: {
  onOpenRoot: (root: string) => void;
  onBrowseRoot: () => void;
  onOpenWs: (name: string) => void;
  onNewWs: () => void;
}) {
  const { projectRoot, workspaces, recentRoots, removeRecentRoot } = useStore(
    useShallow((s) => ({ projectRoot: s.projectRoot, workspaces: s.workspaces, recentRoots: s.recentRoots, removeRecentRoot: s.removeRecentRoot }))
  );

  if (!projectRoot) {
    return (
      <div className="welcome">
        <div className="welcomecard">
          <div className="welcomelogo">🪶</div>
          <h1>Plume</h1>
          <p className="welcometag">API Design Studio</p>
          <p className="welcomedesc">
            먼저 <b>프로젝트 폴더</b>를 선택하세요.<br />
            그 폴더 하위에 여러 <b>워크스페이스</b>를 두고, 각 워크스페이스에 여러 컬렉션을 담습니다.
          </p>
          <button className="active welcomebtn" onClick={onBrowseRoot}>📁 프로젝트 폴더 선택</button>
          {recentRoots.length > 0 && (
            <div className="welcomerecents">
              <div className="sublabel">최근 프로젝트 폴더</div>
              {recentRoots.slice(0, 5).map((p) => (
                <button key={p} className="wsrecentbtn" title={p} onClick={() => onOpenRoot(p)}>📁 {basename(p)}</button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 프로젝트 폴더는 있는데 워크스페이스 미선택.
  return (
    <div className="welcome">
      <div className="welcomecard wide">
        <div className="welcomelogo">🗂</div>
        <h1>워크스페이스 선택</h1>
        <p className="welcometag" title={projectRoot}>📁 {projectRoot}</p>
        <div className="wsgrid">
          {workspaces.map((w) => (
            <button key={w.path} className="wscard" onClick={() => onOpenWs(w.name)}>🗂 {w.name}</button>
          ))}
          <button className="wscard new" onClick={onNewWs}>＋ 새 워크스페이스</button>
        </div>
        {workspaces.length === 0 && <p className="hint" style={{ marginTop: 10 }}>이 폴더엔 워크스페이스가 없습니다. <b>＋ 새 워크스페이스</b>로 만드세요.</p>}
        <div className="row" style={{ marginTop: 14, justifyContent: "center" }}>
          <button onClick={onBrowseRoot}>📁 다른 프로젝트 폴더</button>
        </div>
        {recentRoots.length > 1 && (
          <div className="welcomerecents">
            <div className="sublabel">최근 프로젝트 폴더</div>
            {recentRoots.filter((p) => p !== projectRoot).slice(0, 4).map((p) => (
              <button key={p} className="wsrecentbtn" title={p} onClick={() => onOpenRoot(p)}>
                📁 {basename(p)}
                <span className="del" onClick={(e) => { e.stopPropagation(); removeRecentRoot(p); }}>×</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// 상단 워크스페이스 전환기(현재 프로젝트 폴더 하위 목록에서 전환·생성).
function WorkspaceSwitcher({ onOpenWs, onNewWs, onChangeRoot, onRenameWs, onDeleteWs }: {
  onOpenWs: (name: string) => void;
  onNewWs: () => void;
  onChangeRoot: () => void;
  onRenameWs: (oldName: string, newName: string) => void;
  onDeleteWs: (name: string) => void;
}) {
  const { workspaceName, workspaces, projectRoot } = useStore(
    useShallow((s) => ({ workspaceName: s.workspaceName, workspaces: s.workspaces, projectRoot: s.projectRoot }))
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  if (!projectRoot) return null;
  return (
    <div className="wsswitcher">
      <button className="wsbtn" title="워크스페이스 전환" onClick={() => setOpen((v) => !v)}>
        <span className="wsicon">🗂</span>
        <span className="wsname">{workspaceName || "워크스페이스 선택"}</span>
        <span className="wscaret">▾</span>
      </button>
      {open && (
        <>
          <div className="ctxoverlay" onClick={() => setOpen(false)} />
          <div className="wsmenu">
            <div className="wsmenuhead">워크스페이스 · 📁 {basename(projectRoot)}</div>
            {workspaces.length === 0 && <div className="hint tiny" style={{ padding: "6px 12px" }}>워크스페이스 없음</div>}
            {workspaces.map((w) => (
              <div key={w.path} className={w.name === workspaceName ? "wsitem cur" : "wsitem"}>
                {editing === w.name ? (
                  <input
                    className="wsrename"
                    autoFocus
                    value={editName}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => setEditing(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const nn = editName.trim();
                        setEditing(null);
                        if (nn && nn !== w.name) { onRenameWs(w.name, nn); setOpen(false); }
                      } else if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <>
                    <span
                      className="wsitemname"
                      onClick={() => { setOpen(false); if (w.name !== workspaceName) onOpenWs(w.name); }}
                    >
                      {w.name === workspaceName ? "● " : ""}{w.name}
                    </span>
                    <button
                      className="wsrenamebtn"
                      title="이름 변경"
                      onClick={(e) => { e.stopPropagation(); setEditing(w.name); setEditName(w.name); }}
                    >
                      ✎
                    </button>
                    <button
                      className="wsrenamebtn"
                      title="워크스페이스 삭제"
                      onClick={(e) => { e.stopPropagation(); setOpen(false); onDeleteWs(w.name); }}
                    >
                      🗑
                    </button>
                  </>
                )}
              </div>
            ))}
            <div className="wsmenusep" />
            <div className="wsitem act" onClick={() => { setOpen(false); onNewWs(); }}>＋ 새 워크스페이스</div>
            <div className="wsitem act" onClick={() => { setOpen(false); onChangeRoot(); }}>📁 프로젝트 폴더 변경…</div>
          </div>
        </>
      )}
    </div>
  );
}

// 저장 등 알림 토스트 (2.2초 후 자동 사라짐).
function Toast() {
  const toast = useStore((s) => s.toast);
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(dismiss, 2200);
    return () => clearTimeout(t);
  }, [toast?.at, dismiss]);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} onClick={dismiss}>
      {toast.kind === "ok" ? "✓" : "⚠"} {toast.message}
    </div>
  );
}
