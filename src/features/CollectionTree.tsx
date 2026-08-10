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
}) {
  const storeSpec = useStore((s) => s.spec);
  const activeColId = useStore((s) => s.activeCollectionId);
  const moveRequestTo = useStore((s) => s.moveRequestTo);
  const spec = specProp ?? storeSpec;
  const myColId = collectionId ?? activeColId;
  const [dragFolder, setDragFolder] = useState<string | null>(null);
  // 드롭 시 요청을 대상 폴더로 이동.
  function onDropTo(e: React.DragEvent, folder: string) {
    e.preventDefault();
    e.stopPropagation();
    setDragFolder(null);
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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

  function renderChildren(node: FolderNode, depth: number) {
    const subfolders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    return (
      <>
        {subfolders.map((f) => {
          const isOpen = q ? true : !collapsed.has(f.path);
          return (
            <div key={f.path}>
              <div
                className={dragFolder === f.path ? "treerow folder dropover" : "treerow folder"}
                style={{ paddingLeft: depth * 14 }}
                onClick={() => toggle(f.path)}
                onContextMenu={(e) => open(e, { kind: "folder", path: f.path })}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragFolder(f.path); }}
                onDragLeave={() => setDragFolder((cur) => (cur === f.path ? null : cur))}
                onDrop={(e) => onDropTo(e, f.path)}
              >
                <span className="caret">{isOpen ? "▾" : "▸"}</span>
                📁 {f.name}
              </div>
              {isOpen && renderChildren(f, depth + 1)}
            </div>
          );
        })}
        {node.requests.map(({ path, method, op }) => (
          <div
            key={`${method} ${path}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(
                "application/x-plume-req",
                JSON.stringify({ col: myColId, path, method, folder: op?.["x-folder"] ?? "" })
              );
              e.dataTransfer.effectAllowed = "move";
            }}
            className={
              isActive && selected?.path === path && selected?.method === method
                ? "treerow request sel"
                : "treerow request"
            }
            style={{ paddingLeft: depth * 14 + 14 }}
            onClick={() => onSelectRequest(path, method, op)}
            onContextMenu={(e) => open(e, { kind: "request", path, method })}
            title={path}
          >
            <span className={`m m-${method}`}>{method.toUpperCase()}</span>
            <span className="p">{op?.summary || path}</span>
          </div>
        ))}
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
