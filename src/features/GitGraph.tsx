// 시각적 Git 그래프 — 커밋 부모 관계로 레인(열)을 배정하고 SVG로 노드·엣지를 그린다.
import { useMemo } from "react";
import { type GitGraphCommit } from "../ipc";

const LANE_COLORS = ["#7c86ff", "#34d399", "#fbbf24", "#f87171", "#60a5fa", "#a78bfa", "#f472b6", "#22d3ee"];
const ROW = 30; // 행 높이(px) — 오른쪽 텍스트 행과 1:1
const GAP = 16; // 레인 간격
const PADX = 14;
const R = 4.5; // 노드 반지름

type GNode = {
  col: number; row: number; hash: string; refs: string[];
  subject: string; author: string; date: string; color: string;
};
type GEdge = { fromCol: number; fromRow: number; toCol: number; toRow: number; color: string };

const colorFor = (col: number) => LANE_COLORS[col % LANE_COLORS.length];

// 커밋 목록(최신→과거) → 노드 열 배정 + 부모 엣지.
function layout(commits: GitGraphCommit[]) {
  const nodes: GNode[] = [];
  const lanes: (string | null)[] = []; // 각 레인이 다음으로 기다리는 커밋 해시
  let maxLanes = 1;

  commits.forEach((c, row) => {
    // 이 커밋을 기다리던 레인들(분기/합류)
    const incoming: number[] = [];
    lanes.forEach((h, idx) => { if (h === c.hash) incoming.push(idx); });

    let col: number;
    if (incoming.length > 0) {
      col = incoming[0];
    } else {
      col = lanes.indexOf(null);
      if (col < 0) { col = lanes.length; lanes.push(null); }
    }
    // 나로 합류한 나머지 레인은 비운다(엣지는 부모 기준으로 따로 계산).
    incoming.slice(1).forEach((idx) => (lanes[idx] = null));
    lanes[col] = null;

    // 부모 배정: 첫 부모는 내 레인 유지, 나머지는 새 레인.
    if (c.parents.length > 0) {
      lanes[col] = c.parents[0];
      for (let k = 1; k < c.parents.length; k++) {
        const p = c.parents[k];
        let slot = lanes.indexOf(p);
        if (slot < 0) {
          slot = lanes.indexOf(null);
          if (slot < 0) { slot = lanes.length; lanes.push(null); }
          lanes[slot] = p;
        }
      }
    }

    nodes.push({
      col, row, hash: c.hash, refs: c.refs,
      subject: c.subject, author: c.author, date: c.date, color: colorFor(col),
    });
    maxLanes = Math.max(maxLanes, lanes.length);
  });

  // 엣지: 자식 노드 → 각 부모 노드(로드 범위 안).
  const byHash = new Map<string, GNode>();
  nodes.forEach((n) => byHash.set(n.hash, n));
  const edges: GEdge[] = [];
  commits.forEach((c, row) => {
    const child = nodes[row];
    c.parents.forEach((ph) => {
      const parent = byHash.get(ph);
      if (!parent) return;
      edges.push({
        fromCol: child.col, fromRow: child.row,
        toCol: parent.col, toRow: parent.row,
        color: colorFor(Math.max(child.col, parent.col)),
      });
    });
  });

  return { nodes, edges, maxLanes };
}

export function GitGraph({ commits }: { commits: GitGraphCommit[] }) {
  const { nodes, edges, maxLanes } = useMemo(() => layout(commits), [commits]);
  if (commits.length === 0) return <p className="hint" style={{ padding: 10 }}>커밋 없음</p>;

  const svgW = PADX * 2 + (maxLanes - 1) * GAP;
  const height = nodes.length * ROW;
  const x = (col: number) => PADX + col * GAP;
  const y = (row: number) => row * ROW + ROW / 2;

  return (
    <div className="ggraph">
      <svg className="ggraph-svg" width={svgW} height={height} style={{ flex: `0 0 ${svgW}px` }}>
        {edges.map((e, i) => {
          const x1 = x(e.fromCol), y1 = y(e.fromRow), x2 = x(e.toCol), y2 = y(e.toRow);
          const d =
            e.fromCol === e.toCol
              ? `M${x1},${y1} L${x2},${y2}`
              : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
          return <path key={i} d={d} stroke={e.color} strokeWidth={1.6} fill="none" opacity={0.85} />;
        })}
        {nodes.map((n, i) => (
          <circle key={i} cx={x(n.col)} cy={y(n.row)} r={R} fill={n.color} stroke="var(--bg)" strokeWidth={1.6} />
        ))}
      </svg>
      <div className="ggraph-rows">
        {nodes.map((n, i) => (
          <div key={i} className="ggrow" style={{ height: ROW }}>
            {n.refs.map((r, ri) => {
              const isHead = r.includes("HEAD");
              const label = r.replace("HEAD -> ", "");
              return <span key={ri} className={isHead ? "gref head" : r.startsWith("tag:") ? "gref tag" : "gref"}>{label}</span>;
            })}
            <span className="gsub" title={n.subject}>{n.subject}</span>
            <code className="ghash" style={{ color: n.color }}>{n.hash.slice(0, 7)}</code>
            <span className="gmeta">{n.author} · {n.date}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
