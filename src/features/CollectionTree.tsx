// 재사용 Collection → Folder → Request 트리 + 우클릭 컨텍스트 메뉴.
// spec 프롭을 주면 그 컬렉션을, 없으면 store의 활성 컬렉션을 렌더한다.
// 여러 컬렉션을 동시에 나열할 땐 Builder가 컬렉션마다 하나씩 렌더한다.
import { useState } from "react";
import type { Spec } from "../ipc";
import {
  buildTree,
  listOperations,
  specFolders,
  useStore,
  type FolderNode,
  type Target,
} from "../store";

export interface TreeMenuItem {
  label: string;
  run: () => void;
}

export function CollectionTree({
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
  const spec = specProp ?? storeSpec;
  const q = (filter ?? "").toLowerCase().trim();
  const ops = listOperations(spec).filter(
    (e) =>
      !q ||
      e.path.toLowerCase().includes(q) ||
      e.method.toLowerCase().includes(q) ||
      (e.op?.summary ?? "").toLowerCase().includes(q) ||
      (e.op?.tags ?? []).some((t: string) => t.toLowerCase().includes(q)) // 태그 키워드 검색
  );
  const tree = buildTree(ops, q ? [] : specFolders(spec));
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
                className="treerow folder"
                style={{ paddingLeft: depth * 14 }}
                onClick={() => toggle(f.path)}
                onContextMenu={(e) => open(e, { kind: "folder", path: f.path })}
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
        className={isActive ? "treerow collection cur" : "treerow collection"}
        onClick={() => {
          setColOpen((v) => !v);
          if (collectionId && onSelectCollection) onSelectCollection(collectionId);
        }}
        onContextMenu={(e) => open(e, { kind: "collection" })}
        title="클릭=선택/펼치기 · 우클릭=작업"
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
}
