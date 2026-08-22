// 재사용 Collection → Folder → Request 트리 + 우클릭 컨텍스트 메뉴.
// spec 프롭을 주면 그 컬렉션을, 없으면 store의 활성 컬렉션을 렌더한다.
// 여러 컬렉션을 동시에 나열할 땐 Builder가 컬렉션마다 하나씩 렌더한다.
import { memo, useMemo, useState } from "react";
import type { Spec } from "../ipc";
import {
  buildTree,
  listOperations,
  foldersFromOps,
  useStore,
  type FolderNode,
  type Target,
} from "../store";

export interface TreeMenuItem {
  label: string;
  run: () => void;
}

// 이 개수를 넘는 대형 컬렉션은 폴더를 기본 접힘으로 시작한다(초기 렌더 시 요청 행 수백 개를
// 한 번에 그리지 않도록 → 최초 로드 버벅임/응답없음 방지). 작은 컬렉션은 펼친 채 유지.
const BIG_COLLECTION = 60;

// 트리 정렬: 기준(필드) + 방향(오름/내림)을 분리.
export type SortField = "path" | "name" | "folder" | "method";
export type SortDir = "asc" | "desc";
export const SORT_FIELDS: { id: SortField; label: string }[] = [
  { id: "path", label: "경로" },
  { id: "name", label: "요청 이름" },
  { id: "folder", label: "폴더명" },
  { id: "method", label: "메서드" },
];
const METHOD_ORDER = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
const reqName = (e: { op?: any; path: string }) => (e.op?.summary || e.path).toLowerCase();

// 요청 비교(방향 적용 전, 오름차순 기준).
function cmpRequests(a: { path: string; method: string; op?: any }, b: { path: string; method: string; op?: any }, field: SortField) {
  switch (field) {
    case "name": return reqName(a).localeCompare(reqName(b));
    case "method": {
      const d = METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method);
      return d !== 0 ? d : reqName(a).localeCompare(reqName(b));
    }
    // folder 기준일 땐 폴더 순서로 그룹핑되고 폴더 내부는 경로순.
    case "folder":
    case "path":
    default: return a.path.localeCompare(b.path);
  }
}

function sortRequests(reqs: { path: string; method: string; op?: any }[], field: SortField, dir: SortDir) {
  const arr = [...reqs].sort((a, b) => cmpRequests(a, b, field));
  return dir === "desc" ? arr.reverse() : arr;
}

// 트리의 모든 폴더 경로(중첩 포함)를 모은다(기본 접힘 초기화용).
function allFolderPaths(node: FolderNode, acc: Set<string> = new Set()): Set<string> {
  for (const f of node.folders.values()) {
    acc.add(f.path);
    allFolderPaths(f, acc);
  }
  return acc;
}

export const CollectionTree = memo(function CollectionTree({
  spec: specProp,
  collectionId,
  isActive,
  onSelectCollection,
  selected,
  onSelectRequest,
  menuFor,
  collectionLabel,
  filter,
  sortField = "path",
  sortDir = "asc",
}: {
  spec?: Spec;
  collectionId?: string;
  isActive?: boolean;
  onSelectCollection?: (id: string) => void;
  selected?: { path: string; method: string } | null;
  onSelectRequest: (path: string, method: string, op: any) => void;
  menuFor?: (target: Target) => TreeMenuItem[];
  collectionLabel?: string;
  filter?: string;
  sortField?: SortField;
  sortDir?: SortDir;
}) {
  const storeSpec = useStore((s) => s.spec);
  const activeColId = useStore((s) => s.activeCollectionId);
  const moveRequestTo = useStore((s) => s.moveRequestTo);
  const moveRequestsTo = useStore((s) => s.moveRequestsTo);
  const spec = specProp ?? storeSpec;
  const myColId = collectionId ?? activeColId;
  const ignoredSet = useMemo(() => new Set<string>(spec?.["x-ignored"] ?? []), [spec]);
  const [dragFolder, setDragFolder] = useState<string | null>(null);
  // 멀티 선택(Shift 범위 · Ctrl/⌘ 토글). 키 = `${method} ${path}`. 트리 인스턴스별로 독립.
  const [selKeys, setSelKeys] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const reqKey = (path: string, method: string) => `${method} ${path}`;
  // 드롭 시 요청을 대상 폴더로 이동. 멀티 선택(x-plume-reqs)이 있으면 전부, 없으면 단일.
  function onDropTo(e: React.DragEvent, folder: string) {
    e.preventDefault();
    e.stopPropagation();
    setDragFolder(null);
    const rawMulti = e.dataTransfer.getData("application/x-plume-reqs");
    if (rawMulti) {
      try {
        const d = JSON.parse(rawMulti);
        const items = Array.isArray(d.items) ? d.items : [];
        if (items.length) { moveRequestsTo(d.col, items, myColId, folder); setSelKeys(new Set()); setAnchor(null); }
      } catch { /* 무시 */ }
      return;
    }
    const raw = e.dataTransfer.getData("application/x-plume-req");
    if (!raw) return;
    try {
      const d = JSON.parse(raw);
      if (d.col === myColId && (d.folder ?? "") === folder) return; // 제자리
      moveRequestTo(d.col, d.path, d.method, myColId, folder);
    } catch { /* 무시 */ }
  }
  const q = (filter ?? "").toLowerCase().trim();
  // 대형 컬렉션(수백~수천 요청)에서 매 렌더마다 listOperations/buildTree 재계산을 피한다.
  const ops = useMemo(
    () =>
      listOperations(spec).filter(
        (e) =>
          !q ||
          e.path.toLowerCase().includes(q) ||
          e.method.toLowerCase().includes(q) ||
          (e.op?.summary ?? "").toLowerCase().includes(q) ||
          (e.op?.tags ?? []).some((t: string) => t.toLowerCase().includes(q)) // 태그 키워드 검색
      ),
    [spec, q]
  );
  const tree = useMemo(() => buildTree(ops, q ? [] : foldersFromOps(ops, spec)), [ops, spec, q]);
  // 대형 컬렉션은 폴더를 기본 접힘으로 시작(최초 렌더 비용을 폴더 헤더 수준으로 축소).
  // 트리는 col.id로 키되어 로드 시 리마운트되므로 초기화가 로드된 데이터로 다시 실행된다.
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    ops.length > BIG_COLLECTION ? allFolderPaths(tree) : new Set()
  );
  const [colOpen, setColOpen] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; target: Target } | null>(null);
  const showTree = colOpen || !!q;

  function toggle(path: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }
  function open(e: React.MouseEvent, target: Target) {
    if (!menuFor) return;
    e.preventDefault();
    e.stopPropagation();
    if (menuFor(target).length === 0) return;
    setMenu({ x: e.clientX, y: e.clientY, target });
  }

  // 화면에 보이는 요청들을 렌더 순서(폴더 먼저→요청)대로 평탄화 → Shift 범위 선택 기준.
  const visibleKeys = useMemo(() => {
    const isOpen = (p: string) => (q ? true : !collapsed.has(p));
    const out: string[] = [];
    const walk = (node: FolderNode) => {
      const subs = [...node.folders.values()].sort((a, b) =>
        sortDir === "desc" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)
      );
      for (const f of subs) if (isOpen(f.path)) walk(f);
      for (const r of sortRequests(node.requests, sortField, sortDir)) out.push(reqKey(r.path, r.method));
    };
    walk(tree);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, collapsed, sortField, sortDir, q]);

  // 요청 클릭: 일반=단일 선택+탭 열기 / Shift=범위(누적) / Ctrl·⌘=개별 토글.
  function onRequestClick(e: React.MouseEvent, path: string, method: string, op: any) {
    const key = reqKey(path, method);
    if (e.shiftKey) {
      e.preventDefault();
      const ai = anchor ? visibleKeys.indexOf(anchor) : -1;
      const ki = visibleKeys.indexOf(key);
      if (ai === -1 || ki === -1) {
        setSelKeys((p) => new Set(p).add(key));
      } else {
        const [lo, hi] = ai <= ki ? [ai, ki] : [ki, ai];
        setSelKeys((prev) => { const n = new Set(prev); for (let i = lo; i <= hi; i++) n.add(visibleKeys[i]); return n; });
      }
      setAnchor(key);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelKeys((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
      setAnchor(key);
      return;
    }
    setSelKeys(new Set([key]));
    setAnchor(key);
    onSelectRequest(path, method, op);
  }

  function renderChildren(node: FolderNode, depth: number, ancestorIgnored = false) {
    const subfolders = [...node.folders.values()].sort((a, b) =>
      sortDir === "desc" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)
    );
    const requests = sortRequests(node.requests, sortField, sortDir);
    return (
      <>
        {subfolders.map((f) => {
          const isOpen = q ? true : !collapsed.has(f.path);
          const fIgnored = ancestorIgnored || ignoredSet.has(f.path);
          return (
            <div key={f.path}>
              <div
                className={(dragFolder === f.path ? "treerow folder dropover" : "treerow folder") + (fIgnored ? " ignored" : "")}
                style={{ paddingLeft: depth * 14 }}
                onClick={() => toggle(f.path)}
                onContextMenu={(e) => open(e, { kind: "folder", path: f.path })}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragFolder(f.path); }}
                onDragLeave={() => setDragFolder((cur) => (cur === f.path ? null : cur))}
                onDrop={(e) => onDropTo(e, f.path)}
                title={fIgnored ? "무시된 폴더 (실행에서 제외)" : undefined}
              >
                <span className="caret">{isOpen ? "▾" : "▸"}</span>
                📁 {f.name}{fIgnored ? " 🚫" : ""}
              </div>
              {isOpen && renderChildren(f, depth + 1, fIgnored)}
            </div>
          );
        })}
        {requests.map(({ path, method, op }) => {
          const key = reqKey(path, method);
          const isSel = selKeys.has(key);
          return (
          <div
            key={key}
            draggable
            onDragStart={(e) => {
              // 선택에 포함된 여러 항목을 드래그하면 전부, 아니면 이 항목만.
              if (isSel && selKeys.size > 1) {
                const items = [...selKeys].map((k) => { const i = k.indexOf(" "); return { method: k.slice(0, i), path: k.slice(i + 1) }; });
                e.dataTransfer.setData("application/x-plume-reqs", JSON.stringify({ col: myColId, items }));
              } else {
                e.dataTransfer.setData("application/x-plume-req", JSON.stringify({ col: myColId, path, method, folder: op?.["x-folder"] ?? "" }));
              }
              e.dataTransfer.effectAllowed = "move";
            }}
            className={
              (isActive && selected?.path === path && selected?.method === method
                ? "treerow request sel"
                : "treerow request") + (ancestorIgnored ? " ignored" : "") + (isSel ? " multisel" : "")
            }
            style={{ paddingLeft: depth * 14 + 14 }}
            onClick={(e) => onRequestClick(e, path, method, op)}
            onContextMenu={(e) => open(e, { kind: "request", path, method })}
            title={path}
          >
            <span className={`m m-${method}`}>{method.toUpperCase()}</span>
            <span className="p">{op?.summary || path}</span>
          </div>
          );
        })}
      </>
    );
  }

  return (
    <div className={isActive ? "collectiontree active" : "collectiontree"}>
      <div
        className={
          (isActive ? "treerow collection cur" : "treerow collection") + (dragFolder === "" ? " dropover" : "")
        }
        onClick={() => {
          setColOpen((v) => !v);
          if (collectionId && onSelectCollection) onSelectCollection(collectionId);
        }}
        onContextMenu={(e) => open(e, { kind: "collection" })}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragFolder(""); }}
        onDragLeave={() => setDragFolder((cur) => (cur === "" ? null : cur))}
        onDrop={(e) => onDropTo(e, "")}
        title="클릭=선택/펼치기 · 우클릭=작업 · 요청을 드롭하면 이 컬렉션 루트로 이동"
      >
        <span className="caret">{showTree ? "▾" : "▸"}</span>
        📦 {collectionLabel ?? spec?.info?.title ?? "Collection"}
      </div>
      {showTree && renderChildren(tree, 1)}

      {menu && menuFor && (
        <>
          <div
            className="ctxoverlay"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
          />
          <div className="ctxmenu" style={{ left: menu.x, top: menu.y }}>
            {menuFor(menu.target).map((a) => (
              <div key={a.label} className="ctxitem" onClick={() => { a.run(); setMenu(null); }}>
                {a.label}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
});
