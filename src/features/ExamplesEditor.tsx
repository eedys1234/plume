// named example 편집기 (OAS content[mt].examples). 요청 본문·응답 양쪽에서 재사용.
// 예시 이름 칩 + 선택 예시의 summary/value(JSON) 편집. F5 "예시를 세세하게 기재".
import { useState } from "react";

export function ExamplesEditor({
  examples,
  onChange,
}: {
  examples: Record<string, any> | undefined;
  onChange: (next: Record<string, any>) => void;
}) {
  const map = examples ?? {};
  const names = Object.keys(map);
  const [sel, setSel] = useState<string | null>(names[0] ?? null);
  const active = sel && map[sel] ? sel : names[0] ?? null;
  const cur = active ? map[active] : null;

  function add() {
    let i = names.length + 1;
    while (map[`example${i}`]) i++;
    const name = `example${i}`;
    onChange({ ...map, [name]: { value: {} } });
    setSel(name);
  }
  function remove(name: string) {
    const { [name]: _d, ...rest } = map;
    onChange(rest);
    setSel(Object.keys(rest)[0] ?? null);
  }
  function rename(oldN: string, raw: string) {
    const newN = raw.trim();
    if (!newN || newN === oldN || map[newN]) return;
    const rebuilt: Record<string, any> = {};
    for (const k of names) rebuilt[k === oldN ? newN : k] = map[k];
    onChange(rebuilt);
    setSel(newN);
  }
  const patch = (name: string, p: any) => onChange({ ...map, [name]: { ...map[name], ...p } });

  return (
    <div className="examplesed">
      <div className="exnames">
        {names.map((n) => (
          <button key={n} className={n === active ? "exchip active" : "exchip"} onClick={() => setSel(n)}>
            {n}
          </button>
        ))}
        <button className="exchip add" onClick={add}>＋ 예시</button>
      </div>
      {names.length === 0 && <p className="hint tiny">등록된 예시가 없습니다.</p>}
      {cur && active && (
        <div className="exdetail">
          <div className="row">
            <label style={{ flex: 1 }}>
              이름
              <input defaultValue={active} key={active} onBlur={(e) => rename(active, e.target.value)} />
            </label>
            <button className="del" title="예시 삭제" onClick={() => remove(active)} style={{ alignSelf: "flex-end" }}>
              ×
            </button>
          </div>
          <label>
            summary
            <input value={cur.summary ?? ""} onChange={(e) => patch(active, { summary: e.target.value || undefined })} />
          </label>
          <div className="sublabel">value (JSON)</div>
          <ExampleValue key={active} value={cur.value} onChange={(v) => patch(active, { value: v })} />
        </div>
      )}
    </div>
  );
}

function ExampleValue({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const [text, setText] = useState(value !== undefined ? JSON.stringify(value, null, 2) : "");
  const [err, setErr] = useState(false);
  return (
    <>
      <textarea
        rows={7}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setErr(false);
          } catch {
            setErr(true);
          }
        }}
      />
      {err && <p className="err tiny">유효한 JSON이 아니라 저장되지 않았습니다.</p>}
    </>
  );
}
