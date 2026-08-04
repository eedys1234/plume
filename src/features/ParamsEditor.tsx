// operation.parameters 편집: 이름 · 위치(in) · 타입 · 필수 · 설명.
// path 파라미터는 OAS 규칙상 required=true 여야 하며, UI가 이를 강제한다.

// header는 전용 Headers 편집기에서 관리하므로 여기선 제외.
const INS = ["query", "path", "cookie"];
const TYPES = ["string", "integer", "number", "boolean"];

type Param = any;

export function ParamsEditor({
  value,
  onChange,
}: {
  value: Param[] | undefined;
  onChange: (next: Param[]) => void;
}) {
  const params: Param[] = value ?? [];

  function set(i: number, patch: any) {
    onChange(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }
  function setType(i: number, type: string) {
    onChange(params.map((p, j) => (j === i ? { ...p, schema: { ...(p.schema ?? {}), type } } : p)));
  }
  function add() {
    onChange([...params, { name: "param", in: "query", required: false, schema: { type: "string" } }]);
  }
  function remove(i: number) {
    onChange(params.filter((_, j) => j !== i));
  }

  return (
    <div className="schemaeditor">
      <table className="fieldtable">
        <thead>
          <tr>
            <th>필드명</th>
            <th>위치</th>
            <th>타입</th>
            <th title="문서(Markdown)·호출 값에 사용">예시</th>
            <th>설명</th>
            <th>필수</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {params.length === 0 && (
            <tr>
              <td colSpan={7} className="hint">
                파라미터 없음
              </td>
            </tr>
          )}
          {params.map((p, i) => (
            <tr key={i}>
              <td>
                <input value={p.name ?? ""} onChange={(e) => set(i, { name: e.target.value })} />
              </td>
              <td>
                <select
                  value={p.in ?? "query"}
                  onChange={(e) => {
                    const loc = e.target.value;
                    // path면 required 강제.
                    set(i, { in: loc, required: loc === "path" ? true : p.required });
                  }}
                >
                  {INS.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </td>
              <td>
                <select value={p.schema?.type ?? "string"} onChange={(e) => setType(i, e.target.value)}>
                  {TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  value={p.example ?? ""}
                  placeholder="예시"
                  onChange={(e) => set(i, { example: e.target.value || undefined })}
                />
              </td>
              <td>
                <input
                  value={p.description ?? ""}
                  placeholder="설명"
                  onChange={(e) => set(i, { description: e.target.value || undefined })}
                />
              </td>
              <td className="c">
                <input
                  type="checkbox"
                  checked={!!p.required}
                  disabled={p.in === "path"}
                  onChange={(e) => set(i, { required: e.target.checked })}
                />
              </td>
              <td className="c">
                <button className="del" onClick={() => remove(i)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={add}>+ 파라미터</button>
    </div>
  );
}
