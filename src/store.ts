// 앱 전역 상태(SSOT). 스펙 문서 그 자체를 단일 진실 원천으로 보유한다(§2 원칙 2).
import { create } from "zustand";
import { produce, setAutoFreeze } from "immer";
import { api, type Diagnostic, type Environment, type HttpRequestSpec, type Spec } from "./ipc";

// 큰 스펙(수백~수천 요청)에서 매 편집마다 전체 복사를 피하려고 immer 구조적 공유를 쓴다.
// 자동 freeze는 기존 코드의 직접 변이를 크래시로 바꿀 수 있어 끈다(안전 우선).
setAutoFreeze(false);

// LNB(좌측 전역 네비) + Builder 하위 탭.
export type Gnb = "builder" | "environment" | "import" | "git" | "history";
export type BuilderTab = "design" | "call" | "load" | "docs";

/** 호출 히스토리 항목. */
export interface HistoryEntry {
  id: number;
  req: HttpRequestSpec;
  status: number;
  statusText: string;
  elapsedMs: number;
  sizeBytes: number;
  at: number; // Date.now()
}

/** 범용 활동 이벤트(Builder/Run/Export/Import/Chain 등). */
export interface AppEvent {
  id: number;
  kind: string; // "Builder" | "Run" | "Export" | "Import" | "Chain" | "Save" | "HTTP" ...
  message: string;
  at: number;
}

/** API Call Chain: 이름 있는 호출 스텝 목록(시퀀스 다이어그램의 소스). */
export interface ChainStep {
  method: string;
  path: string;
  label?: string; // 표시명(요청 summary 등)
  note?: string;  // 스텝 설명(다이어그램 메시지)
}
export interface Chain {
  id: string;
  name: string;
  steps: ChainStep[];
}

/** 빈 OAS 3.0 문서. */
export function emptySpec(title = "Untitled API"): Spec {
  return {
    openapi: "3.0.3",
    info: { title, version: "0.1.0" },
    paths: {},
    components: { schemas: {} },
  };
}

/** 하나의 컬렉션 = 하나의 OpenAPI 문서. 여러 개를 워크스페이스에 둔다. */
export interface Collection {
  id: string;
  name: string;
  spec: Spec;
}

let _cid = 2;
const newCollectionId = () => `col${_cid++}`;

interface AppState {
  gnb: Gnb;
  builderTab: BuilderTab;

  // 다중 컬렉션
  collections: Collection[];
  activeCollectionId: string;
  spec: Spec; // 활성 컬렉션의 spec 미러(기존 소비자 호환)

  projectDir: string | null;
  diagnostics: Diagnostic[];
  environments: Environment[];
  activeEnvId: string;

  setGnb: (g: Gnb) => void;
  setBuilderTab: (t: BuilderTab) => void;

  // 프로젝트 폴더(상위) 하위에 여러 워크스페이스(서브폴더)를 둔다.
  projectRoot: string | null;              // 한 번 선택하는 상위 폴더
  setProjectRoot: (d: string | null) => void;
  recentRoots: string[];                    // 최근 프로젝트 폴더
  addRecentRoot: (path: string) => void;
  removeRecentRoot: (path: string) => void;
  workspaces: { name: string; path: string }[]; // 현재 root 하위 워크스페이스(디스크)
  setWorkspaces: (w: { name: string; path: string }[]) => void;
  workspaceName: string;                    // 활성 워크스페이스(서브폴더명)
  setWorkspaceName: (n: string) => void;

  // 컬렉션 관리
  addCollection: (name: string) => void;
  setActiveCollection: (id: string) => void;
  moveRequestTo: (srcColId: string, path: string, method: string, dstColId: string, dstFolder: string) => void;
  renameCollection: (id: string, name: string) => void;
  removeCollection: (id: string) => void;
  /** 워크스페이스에서 로드한 컬렉션들로 전체 교체(비면 기본 1개 생성). */
  loadCollections: (cols: { name: string; spec: Spec }[]) => void;

  setSpec: (s: Spec) => void;
  /** 활성 컬렉션 스펙을 갱신하고 백그라운드로 검증까지 돌린다. */
  updateSpec: (fn: (draft: Spec) => void) => void;
  revalidate: () => Promise<void>;

  setProjectDir: (d: string | null) => void;
  setEnvironments: (e: Environment[]) => void;
  setActiveEnv: (id: string) => void;
  activeEnv: () => Environment | undefined;

  // 환경 편집
  addEnvironment: () => void;
  removeEnvironment: (id: string) => void;
  renameEnvironment: (id: string, name: string) => void;
  setVariable: (envId: string, key: string, value: string) => void;
  removeVariable: (envId: string, key: string) => void;
  setScriptVariable: (envId: string, key: string, value: string) => void;
  removeScriptVariable: (envId: string, key: string) => void;

  // 스크립트 런타임 변수(bru.getVar/setVar, 비영속)
  runtimeVars: Record<string, string>;
  setRuntimeVar: (key: string, value: string) => void;

  // 토스트 알림
  toast: { message: string; kind: "ok" | "err"; at: number } | null;
  showToast: (message: string, kind?: "ok" | "err") => void;
  dismissToast: () => void;

  // 호출 히스토리 + Call 프리필
  history: HistoryEntry[];
  addHistory: (e: Omit<HistoryEntry, "id" | "at">) => void;
  clearHistory: () => void;
  prefillRequest: HttpRequestSpec | null;
  setPrefillRequest: (r: HttpRequestSpec | null) => void;

  // 범용 활동 이벤트 로그(모든 탭의 주요 동작)
  events: AppEvent[];
  logEvent: (kind: string, message: string) => void;
  clearEvents: () => void;

  // API Call Chain (호출 스텝 목록)
  chains: Chain[];
  setChains: (c: Chain[]) => void;

  // 프로젝트와의 영속화
  loadClient: (dir: string) => Promise<void>;
  persistClient: (dir: string) => Promise<void>;

  // 클립보드(복사/붙여넣기)
  clipboard: Clip;
  copyRequest: (path: string, method: string) => void;
  copyFolder: (folderPath: string) => void;
  pasteInto: (targetFolder: string) => void;

  // 요청 탭 (Bruno식 multi-open)
  openTabs: { path: string; method: string }[];
  activeTab: string | null; // `${method} ${path}`
  openTab: (path: string, method: string) => void;
  closeTab: (path: string, method: string) => void;
  setActiveTab: (key: string) => void;
  closeAllTabs: () => void;
  closeOtherTabs: (key: string) => void;
  closeTabsToSide: (key: string, side: "left" | "right") => void;
}

export const tabKey = (path: string, method: string) => `${method} ${path}`;

const _initialCol: Collection = { id: "col1", name: "My API", spec: emptySpec("My API") };

/** 마지막으로 연 작업 폴더(localStorage, 앱 재시작에도 유지). */
export const LAST_FOLDER_KEY = "plume:lastFolder";
function lastFolder(): string | null {
  try { return localStorage.getItem(LAST_FOLDER_KEY); } catch { return null; }
}

export const PROJECT_ROOT_KEY = "plume:projectRoot";
const RECENT_ROOTS_KEY = "plume:recentRoots";
function projectRootInit(): string | null {
  try { return localStorage.getItem(PROJECT_ROOT_KEY); } catch { return null; }
}
function loadRecentRoots(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_ROOTS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
/** 경로에서 마지막 폴더명. */
export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

// 키 입력마다 검증 IPC가 폭주하지 않도록 revalidate를 디바운스한다.
let _revalidateTimer: ReturnType<typeof setTimeout> | null = null;

// 환경 변경 시 프로젝트가 열려 있으면 디스크에 자동 저장(디바운스).
// → "환경변수를 만들었는데 저장이 안 된다"를 방지(명시적 버튼/Ctrl+S 없이도 유지).
let _envPersistTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleEnvPersist(get: () => AppState) {
  if (_envPersistTimer) clearTimeout(_envPersistTimer);
  _envPersistTimer = setTimeout(() => {
    _envPersistTimer = null;
    const dir = get().projectDir;
    if (dir) void get().persistClient(dir);
  }, 500);
}

export const useStore = create<AppState>((set, get) => ({
  gnb: "builder",
  builderTab: "design",

  collections: [_initialCol],
  activeCollectionId: _initialCol.id,
  spec: _initialCol.spec,

  projectDir: lastFolder(),
  diagnostics: [],
  environments: [{ id: "local", name: "Local", variables: {} }],
  activeEnvId: "local",

  setGnb: (g) => set({ gnb: g }),
  setBuilderTab: (t) => set({ builderTab: t }),

  projectRoot: projectRootInit(),
  setProjectRoot: (d) => set({ projectRoot: d }),
  recentRoots: loadRecentRoots(),
  addRecentRoot: (path) =>
    set((s) => {
      const list = [path, ...s.recentRoots.filter((p) => p !== path)].slice(0, 8);
      try { localStorage.setItem(RECENT_ROOTS_KEY, JSON.stringify(list)); } catch {}
      return { recentRoots: list };
    }),
  removeRecentRoot: (path) =>
    set((s) => {
      const list = s.recentRoots.filter((p) => p !== path);
      try { localStorage.setItem(RECENT_ROOTS_KEY, JSON.stringify(list)); } catch {}
      return { recentRoots: list };
    }),
  workspaces: [],
  setWorkspaces: (w) => set({ workspaces: w }),
  workspaceName: "",
  setWorkspaceName: (n) => set({ workspaceName: n }),

  addCollection: (name) => {
    const spec = emptySpec(name || "New API");
    const col: Collection = { id: newCollectionId(), name: name || "New API", spec };
    set((s) => ({ collections: [...s.collections, col], activeCollectionId: col.id, spec }));
    void get().revalidate();
  },
  setActiveCollection: (id) => {
    const c = get().collections.find((c) => c.id === id);
    if (c) {
      set({ activeCollectionId: id, spec: c.spec });
      void get().revalidate();
    }
  },
  renameCollection: (id, name) =>
    set((s) => ({
      collections: s.collections.map((c) => (c.id === id ? { ...c, name } : c)),
    })),
  // 드래그앤드랍: 요청을 대상 폴더(또는 다른 컬렉션의 폴더)로 이동.
  moveRequestTo: (srcColId, path, method, dstColId, dstFolder) => {
    set((s) => {
      const cols = s.collections.map((c) => ({ ...c }));
      const src = cols.find((c) => c.id === srcColId);
      const dst = cols.find((c) => c.id === dstColId);
      if (!src || !dst) return {};
      const srcSpec: any = structuredClone(src.spec);
      const op = srcSpec?.paths?.[path]?.[method];
      if (!op) return {};
      if (srcColId === dstColId) {
        if (dstFolder) op["x-folder"] = dstFolder; else delete op["x-folder"];
        src.spec = srcSpec;
      } else {
        delete srcSpec.paths[path][method];
        if (Object.keys(srcSpec.paths[path]).length === 0) delete srcSpec.paths[path];
        src.spec = srcSpec;
        const dstSpec: any = structuredClone(dst.spec);
        dstSpec.paths ??= {};
        dstSpec.paths[path] ??= {};
        const moved = structuredClone(op);
        if (dstFolder) moved["x-folder"] = dstFolder; else delete moved["x-folder"];
        dstSpec.paths[path][method] = moved;
        dst.spec = dstSpec;
      }
      const active = cols.find((c) => c.id === s.activeCollectionId);
      return { collections: cols, spec: active ? active.spec : s.spec };
    });
    void get().revalidate();
  },
  loadCollections: (cols) => {
    const list: Collection[] =
      cols.length === 0
        ? [{ id: newCollectionId(), name: "New API", spec: emptySpec("New API") }]
        : cols.map((c) => ({ id: newCollectionId(), name: c.name, spec: c.spec }));
    set({ collections: list, activeCollectionId: list[0].id, spec: list[0].spec });
    void get().revalidate();
  },
  removeCollection: (id) => {
    const rest = get().collections.filter((c) => c.id !== id);
    if (rest.length === 0) return; // 최소 1개 유지
    const active = get().activeCollectionId === id ? rest[0] : get().collections.find((c) => c.id === get().activeCollectionId)!;
    set({ collections: rest, activeCollectionId: active.id, spec: active.spec });
    void get().revalidate();
  },

  setSpec: (s2) => {
    const id = get().activeCollectionId;
    set((s) => ({
      spec: s2,
      collections: s.collections.map((c) => (c.id === id ? { ...c, spec: s2, name: s2?.info?.title ?? c.name } : c)),
    }));
    void get().revalidate();
  },
  updateSpec: (fn) => {
    // immer: 바뀐 경로만 새로 만들고 나머지는 참조 공유 → 대형 스펙에서 O(전체) 복사 제거.
    // (Spec=any 라 immer 오버로드가 커리로 잡히는 걸 캐스팅으로 방지)
    const next = produce(get().spec, (draft: Spec) => { fn(draft); }) as Spec;
    const id = get().activeCollectionId;
    set((s) => ({
      spec: next,
      collections: s.collections.map((c) => (c.id === id ? { ...c, spec: next, name: next?.info?.title ?? c.name } : c)),
    }));
    // 타이핑 폭주 시 매번 Rust 검증 IPC를 보내지 않도록 400ms 디바운스.
    if (_revalidateTimer) clearTimeout(_revalidateTimer);
    _revalidateTimer = setTimeout(() => { _revalidateTimer = null; void get().revalidate(); }, 400);
  },
  revalidate: async () => {
    try {
      const diags = await api.validateSpec(get().spec);
      set({ diagnostics: diags });
    } catch {
      /* 파싱 불가 등은 무시(에디터가 별도 표시) */
    }
  },

  setProjectDir: (d) => set({ projectDir: d }),
  setEnvironments: (e) => set({ environments: e }),
  setActiveEnv: (id) => set({ activeEnvId: id }),
  activeEnv: () => get().environments.find((e) => e.id === get().activeEnvId),

  addEnvironment: () => {
    const n = get().environments.length + 1;
    const id = `env${n}`;
    set({
      environments: [...get().environments, { id, name: `Env ${n}`, variables: {} }],
      activeEnvId: id,
    });
    scheduleEnvPersist(get);
  },
  removeEnvironment: (id) => {
    const rest = get().environments.filter((e) => e.id !== id);
    set({ environments: rest, activeEnvId: rest[0]?.id ?? "" });
    scheduleEnvPersist(get);
  },
  renameEnvironment: (id, name) => {
    set({ environments: get().environments.map((e) => (e.id === id ? { ...e, name } : e)) });
    scheduleEnvPersist(get);
  },
  setVariable: (envId, key, value) => {
    set({
      environments: get().environments.map((e) =>
        e.id === envId ? { ...e, variables: { ...e.variables, [key]: value } } : e
      ),
    });
    scheduleEnvPersist(get);
  },
  removeVariable: (envId, key) => {
    set({
      environments: get().environments.map((e) => {
        if (e.id !== envId) return e;
        const { [key]: _drop, ...rest } = e.variables;
        return { ...e, variables: rest };
      }),
    });
    scheduleEnvPersist(get);
  },
  // 스크립트 전용 변수(scriptVariables) — 요청 치환엔 미사용.
  setScriptVariable: (envId, key, value) => {
    set({
      environments: get().environments.map((e) =>
        e.id === envId ? { ...e, scriptVariables: { ...(e.scriptVariables ?? {}), [key]: value } } : e
      ),
    });
    scheduleEnvPersist(get);
  },
  removeScriptVariable: (envId, key) => {
    set({
      environments: get().environments.map((e) => {
        if (e.id !== envId) return e;
        const { [key]: _drop, ...rest } = e.scriptVariables ?? {};
        return { ...e, scriptVariables: rest };
      }),
    });
    scheduleEnvPersist(get);
  },

  runtimeVars: {},
  setRuntimeVar: (key, value) => set((s) => ({ runtimeVars: { ...s.runtimeVars, [key]: value } })),

  toast: null,
  showToast: (message, kind = "ok") => set({ toast: { message, kind, at: Date.now() } }),
  dismissToast: () => set({ toast: null }),

  history: [],
  addHistory: (e) =>
    set((s) => ({
      history: [{ ...e, id: (s.history[0]?.id ?? 0) + 1, at: Date.now() }, ...s.history].slice(0, 200),
      events: [
        { id: (s.events[0]?.id ?? 0) + 1, kind: "HTTP", message: `${e.req.method} ${e.req.url} → ${e.status} ${e.statusText}`, at: Date.now() },
        ...s.events,
      ].slice(0, 300),
    })),
  clearHistory: () => set({ history: [] }),
  prefillRequest: null,
  setPrefillRequest: (r) => set({ prefillRequest: r }),

  events: [],
  logEvent: (kind, message) =>
    set((s) => ({
      events: [{ id: (s.events[0]?.id ?? 0) + 1, kind, message, at: Date.now() }, ...s.events].slice(0, 300),
    })),
  clearEvents: () => set({ events: [] }),

  chains: [],
  setChains: (c) => set({ chains: c }),

  loadClient: async (dir) => {
    try {
      const cfg = await api.loadClientConfig(dir);
      if (cfg.environments.length > 0) {
        set({
          environments: cfg.environments,
          activeEnvId: cfg.activeEnvironmentId || cfg.environments[0].id,
        });
      }
    } catch {
      /* 환경 파일이 아직 없으면 기본값 유지 */
    }
  },
  persistClient: async (dir) => {
    await api.saveClientConfig(dir, {
      environments: get().environments,
      activeEnvironmentId: get().activeEnvId,
    });
  },

  openTabs: [],
  activeTab: null,
  openTab: (path, method) => {
    const key = tabKey(path, method);
    const exists = get().openTabs.some((t) => tabKey(t.path, t.method) === key);
    set((s) => ({
      openTabs: exists ? s.openTabs : [...s.openTabs, { path, method }],
      activeTab: key,
    }));
  },
  closeTab: (path, method) => {
    const key = tabKey(path, method);
    const tabs = get().openTabs.filter((t) => tabKey(t.path, t.method) !== key);
    let active = get().activeTab;
    if (active === key) {
      const last = tabs[tabs.length - 1];
      active = last ? tabKey(last.path, last.method) : null;
    }
    set({ openTabs: tabs, activeTab: active });
  },
  setActiveTab: (key) => set({ activeTab: key }),
  // 탭 닫기 변형(우클릭 메뉴).
  closeAllTabs: () => set({ openTabs: [], activeTab: null }),
  closeOtherTabs: (key) =>
    set((s) => {
      const keep = s.openTabs.find((t) => tabKey(t.path, t.method) === key);
      return { openTabs: keep ? [keep] : [], activeTab: keep ? key : null };
    }),
  closeTabsToSide: (key, side) =>
    set((s) => {
      const idx = s.openTabs.findIndex((t) => tabKey(t.path, t.method) === key);
      if (idx < 0) return {};
      const tabs = side === "left" ? s.openTabs.slice(idx) : s.openTabs.slice(0, idx + 1);
      const active = tabs.some((t) => tabKey(t.path, t.method) === s.activeTab) ? s.activeTab : key;
      return { openTabs: tabs, activeTab: active };
    }),

  clipboard: null,
  copyRequest: (path, method) => {
    const op = get().spec?.paths?.[path]?.[method];
    if (op) set({ clipboard: { kind: "request", path, method, op: structuredClone(op) } });
  },
  copyFolder: (folderPath) => {
    const requests = listOperations(get().spec)
      .filter(({ op }) => {
        const f = opFolder(op);
        return f === folderPath || f.startsWith(folderPath + "/");
      })
      .map(({ path, method, op }) => ({ path, method, op: structuredClone(op) }));
    set({ clipboard: { kind: "folder", base: folderPath, requests } });
  },
  pasteInto: (targetFolder) => {
    const clip = get().clipboard;
    if (!clip) return;
    get().updateSpec((d) => {
      d.paths ??= {};
      const exists = (p: string, m: string) => !!d.paths[p]?.[m];
      const uniquePath = (p: string, m: string) => {
        if (!exists(p, m)) return p;
        let i = 1;
        while (exists(`${p}-copy${i > 1 ? i : ""}`, m)) i++;
        return `${p}-copy${i > 1 ? i : ""}`;
      };
      const addFolder = (f: string) => {
        if (!f) return;
        d["x-folders"] = [...new Set([...(d["x-folders"] ?? []), f])].sort();
      };

      if (clip.kind === "request") {
        const op = structuredClone(clip.op);
        if (targetFolder) op["x-folder"] = targetFolder;
        else delete op["x-folder"];
        const np = uniquePath(clip.path, clip.method);
        d.paths[np] ??= {};
        d.paths[np][clip.method] = op;
        addFolder(targetFolder);
      } else {
        // 폴더 통째 복사: base 폴더명 아래로 재배치.
        const name = clip.base.split("/").pop() || clip.base;
        const newBase = targetFolder ? `${targetFolder}/${name}` : name;
        addFolder(newBase);
        for (const r of clip.requests) {
          const op = structuredClone(r.op);
          const oldF: string = r.op["x-folder"] ?? "";
          const remapped =
            oldF === clip.base
              ? newBase
              : oldF.startsWith(clip.base + "/")
              ? newBase + oldF.slice(clip.base.length)
              : newBase;
          op["x-folder"] = remapped;
          addFolder(remapped);
          const np = uniquePath(r.path, r.method);
          d.paths[np] ??= {};
          d.paths[np][r.method] = op;
        }
      }
    });
  },
}));

/** operation의 폴더 경로(x-folder). 없으면 빈 문자열(루트). */
export function opFolder(op: any): string {
  return (op?.["x-folder"] as string) ?? "";
}

/** 스펙 루트에 영속화된 폴더 목록(x-folders) + operation 폴더의 합집합. */
export function specFolders(spec: Spec): string[] {
  const set = new Set<string>();
  const persisted: string[] = spec?.["x-folders"] ?? [];
  for (const f of persisted) if (f) set.add(f);
  for (const { op } of listOperations(spec)) {
    const f = opFolder(op);
    if (f) set.add(f);
  }
  return [...set].sort();
}

// ─────────────────────────── 트리 ───────────────────────────

export type OpEntry = { path: string; method: string; op: any };
export interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  requests: OpEntry[];
}

/** 우클릭 컨텍스트 메뉴의 대상 노드. */
export type Target =
  | { kind: "collection" }
  | { kind: "folder"; path: string }
  | { kind: "request"; path: string; method: string };

/** operation들의 x-folder 경로 + 추가 폴더를 중첩 트리로 조립. */
export function buildTree(ops: OpEntry[], extraFolders: string[]): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: new Map(), requests: [] };
  const ensure = (fpath: string): FolderNode => {
    if (!fpath) return root;
    let cur = root;
    let acc = "";
    for (const seg of fpath.split("/").filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!cur.folders.has(seg)) {
        cur.folders.set(seg, { name: seg, path: acc, folders: new Map(), requests: [] });
      }
      cur = cur.folders.get(seg)!;
    }
    return cur;
  };
  for (const f of extraFolders) ensure(f);
  for (const e of ops) ensure(opFolder(e.op)).requests.push(e);
  return root;
}

// ─────────────────────────── 클립보드(복사/붙여넣기) ───────────────────────────

export type Clip =
  | { kind: "request"; path: string; method: string; op: any }
  | { kind: "folder"; base: string; requests: OpEntry[] }
  | null;

/** spec.paths를 (path, method, operation) 평면 목록으로 펼친다. */
export function listOperations(spec: Spec): { path: string; method: string; op: any }[] {
  const out: { path: string; method: string; op: any }[] = [];
  const methods = ["get", "post", "put", "delete", "patch", "head", "options", "trace"];
  const paths = spec?.paths ?? {};
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!item) continue;
    for (const m of methods) {
      if (item[m]) out.push({ path, method: m, op: item[m] });
    }
  }
  return out;
}
