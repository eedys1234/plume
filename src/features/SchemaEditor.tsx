// object 스키마의 properties를 필드 단위로 편집. 재귀적(중첩) 편집 지원:
//  - 필드 타입이 object  → 그 필드의 properties를 하위 SchemaEditor로 펼쳐 편집
//  - 필드 타입이 array   → 항목(items) 타입 선택, 항목이 object면 그 안을 다시 하위 편집
// Request Body / Response 양쪽에서 재사용한다.

import { Fragment } from "react";

const TYPES = ["string", "integer", "number", "boolean", "object", "array"];
const PRIMITIVE = ["string", "integer", "number", "boolean"];

// 예시 문자열을 타입에 맞게 변환.
function coerceExample(raw: string, type?: string): any {
  if (raw === "") return undefined;
  if (type === "integer" || type === "number") { const n = Number(raw); return Number.isNaN(n) ? raw : n; }
  if (type === "boolean") return raw === "true";
  return raw;
}

type Schema = any;

export function SchemaEditor({
  value,
  onChange,
  depth = 0,
}: {
  value: Schema | undefined;
  onChange: (next: Schema) => void;
  depth?: number;
}) {
  // 정규화: object + properties + required 보장.
  const schema: Schema = value ?? {};
  const props: Record<string, any> = schema.properties ?? {};
  const required: string[] = schema.required ?? [];
  const names = Object.keys(props);

  function commit(nextProps: Record<string, any>, nextRequired: string[]) {
    const next: Schema = { ...schema, type: "object", properties: nextProps };
    if (nextRequired.length) next.required = nextRequired;
    else delete next.required;
    onChange(next);
  }

  function addField() {
    let base = "field";
    let i = 1;
    while (props[`${base}${i}`]) i++;
    commit({ ...props, [`${base}${i}`]: { type: "string" } }, required);
  }

  function removeField(name: string) {
    const { [name]: _drop, ...rest } = props;
    commit(rest, required.filter((r) => r !== name));
  }

  function renameField(oldName: string, newName: string) {
    if (!newName || newName === oldName || props[newName]) return;
    // 순서 보존하며 키 교체.
    const rebuilt: Record<string, any> = {};
    for (const k of names) rebuilt[k === oldName ? newName : k] = props[k];
    commit(rebuilt, required.map((r) => (r === oldName ? newName : r)));
  }

  function setField(name: string, patch: any) {
    commit({ ...props, [name]: { ...props[name], ...patch } }, required);
  }

  // 필드의 스키마 전체를 교체(중첩 편집기가 돌려준 하위 스키마 반영).
  function setFieldSchema(name: string, nextSub: any) {
    commit({ ...props, [name]: nextSub }, required);
  }

  function setRequired(name: string, on: boolean) {
    const next = on ? [...new Set([...required, name])] : required.filter((r) => r !== name);
    commit(props, next);
  }

  // 타입 변경 시 object/array 골격을 준비(하위 편집이 바로 가능하도록).
  function changeType(name: string, type: string) {
    const f = { ...props[name], type };
    if (type === "object" && !f.properties) f.properties = {};
    if (type === "array" && !f.items) f.items = { type: "string" };
    if (type !== "object") delete f.properties;
    if (type !== "array") delete f.items;
    setFieldSchema(name, f);
  }

  return (
    <div className={depth > 0 ? "schemaeditor nested" : "schemaeditor"}>
      <table className="fieldtable">
        {depth === 0 && (
          <thead>
            <tr>
              <th>필드명</th>
              <th>타입</th>
              <th title="문서(Markdown)에만 반영 · 예제 미리보기엔 반영 안 됨">예시</th>
              <th>설명</th>
              <th title="required">필수</th>
              <th />
            </tr>
          </thead>
        )}
        <tbody>
          {names.length === 0 && (
            <tr>
              <td colSpan={6} className="hint">필드가 없습니다. 아래 + 필드로 추가하세요.</td>
            </tr>
          )}
          {names.map((name) => {
            const f = props[name] ?? {};
            const isObj = f.type === "object";
            const isArr = f.type === "array";
            const itemIsObj = isArr && f.items?.type === "object";
            return (
              <Fragment key={name}>
                <tr>
                  <td>
                    <input defaultValue={name} onBlur={(e) => renameField(name, e.target.value.trim())} />
                  </td>
                  <td>
                    <select value={f.type ?? "string"} onChange={(e) => changeType(name, e.target.value)}>
                      {TYPES.map((t) => <option key={t}>{t}</option>)}
                    </select>
                  </td>
                  <td>
                    {PRIMITIVE.includes(f.type ?? "string") ? (
                      f.type === "boolean" ? (
                        <select value={f.example === undefined ? "" : String(f.example)} onChange={(e) => setField(name, { example: e.target.value === "" ? undefined : e.target.value === "true" })}>
                          <option value="">—</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          value={f.example ?? ""}
                          placeholder="예시"
                          onChange={(e) => setField(name, { example: coerceExample(e.target.value, f.type) })}
                        />
                      )
                    ) : (
                      <span className="hint tiny">—</span>
                    )}
                  </td>
                  <td>
                    <input
                      value={f.description ?? ""}
                      placeholder="설명"
                      onChange={(e) => setField(name, { description: e.target.value || undefined })}
                    />
                  </td>
                  <td className="c">
                    <input type="checkbox" checked={required.includes(name)} onChange={(e) => setRequired(name, e.target.checked)} />
                  </td>
                  <td className="c">
                    <button className="del" onClick={() => removeField(name)} title="삭제">×</button>
                  </td>
                </tr>

                {/* 중첩: object 필드의 하위 속성 */}
                {isObj && (
                  <tr className="nestrow">
                    <td colSpan={6}>
                      <div className="nestbox">
                        <div className="nesttag">↳ {name} (object)</div>
                        <SchemaEditor
                          value={f}
                          depth={depth + 1}
                          onChange={(sub) => {
                            const merged: any = { ...f, type: "object", properties: sub.properties ?? {} };
                            if (sub.required?.length) merged.required = sub.required; else delete merged.required;
                            setFieldSchema(name, merged);
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                )}

                {/* 중첩: array 필드의 항목(items) */}
                {isArr && (
                  <tr className="nestrow">
                    <td colSpan={6}>
                      <div className="nestbox">
                        <div className="nesttag">
                          ↳ {name}[] 항목 타입
                          <select
                            value={f.items?.type ?? "string"}
                            onChange={(e) => {
                              const t = e.target.value;
                              const it: any = { ...(f.items ?? {}), type: t };
                              if (t === "object" && !it.properties) it.properties = {};
                              if (t !== "object") delete it.properties;
                              setFieldSchema(name, { ...f, items: it });
                            }}
                          >
                            {TYPES.map((t) => <option key={t}>{t}</option>)}
                          </select>
                        </div>
                        {itemIsObj && (
                          <SchemaEditor
                            value={f.items}
                            depth={depth + 1}
                            onChange={(sub) => {
                              const it: any = { ...(f.items ?? {}), type: "object", properties: sub.properties ?? {} };
                              if (sub.required?.length) it.required = sub.required; else delete it.required;
                              setFieldSchema(name, { ...f, items: it });
                            }}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <button onClick={addField}>+ 필드</button>
    </div>
  );
}
