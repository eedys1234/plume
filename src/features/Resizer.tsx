// 드래그 리사이저 — 포인터 드래그 델타를 부모에 전달한다.
// axis="x": 좌우(세로 손잡이), axis="y": 상하(가로 손잡이).
import { useRef } from "react";

export function Resizer({ axis, onDelta }: { axis: "x" | "y"; onDelta: (delta: number) => void }) {
  const last = useRef(0);
  function down(e: React.PointerEvent) {
    e.preventDefault();
    last.current = axis === "x" ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const cur = axis === "x" ? ev.clientX : ev.clientY;
      onDelta(cur - last.current);
      last.current = cur;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  return <div className={`resizer resizer-${axis}`} onPointerDown={down} />;
}

// 크기를 localStorage에 유지하며 clamp하는 훅.
// 세터는 값 또는 (현재값)=>새값 형태를 모두 받는다(드래그 누적을 위해 함수형 필수).
import { useState } from "react";
export function usePersistedSize(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return v && !Number.isNaN(v) ? Math.min(max, Math.max(min, v)) : initial;
    } catch {
      return initial;
    }
  });
  const update = (next: number | ((cur: number) => number)) => {
    setSize((cur) => {
      const raw = typeof next === "function" ? next(cur) : next;
      const clamped = Math.min(max, Math.max(min, raw));
      try { localStorage.setItem(key, String(clamped)); } catch {}
      return clamped;
    });
  };
  return [size, update] as const;
}
