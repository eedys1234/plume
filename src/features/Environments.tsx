// Environment 탭: 환경 목록(좌) + 변수 편집(우). {{key}}로 참조.
import { useState } from "react";
import { useStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { api } from "../ipc";
import { pickOpenFile } from "../dialog";

export function Environments() {
  const {
    environments, activeEnvId, setActiveEnv, setEnvironments,
    addEnvironment, removeEnvironment, renameEnvironment,
    setVariable, removeVariable, projectDir, persistClient,
  } = useStore(
    useShallow((s) => ({
      environments: s.environments, activeEnvId: s.activeEnvId, setActiveEnv: s.setActiveEnv, setEnvironments: s.setEnvironments,
      addEnvironment: s.addEnvironment, removeEnvironment: s.removeEnvironment, renameEnvironment: s.renameEnvironment,
      setVariable: s.setVariable, removeVariable: s.removeVariable, projectDir: s.projectDir, persistClient: s.persistClient,
    }))
  );
  const env = environments.find((e) => e.id === activeEnvId);
  const [nk, setNk] = useState("");
  const [nv, setNv] = useState("");
  const [msg, setMsg] = useState("");

  async function save() {
    if (!projectDir) {
      setMsg("프로젝트를 먼저 열어야 저장됩니다");
      return;
    }
    try {
      await persistClient(projectDir);
      setMsg("environments/ 에 저장됨 ✓");
    } catch (e: any) {
      setMsg(`오류: ${e?.message ?? e}`);
    }
  }

  // Bruno(.yml/.bru) 또는 Postman(.json) 환경 파일 → 환경 추가.
  async function importEnv() {
    const path = await pickOpenFile("환경 파일 (Bruno/Postman)", ["json", "yml", "yaml", "bru"]);
    if (!path) return;
    try {
      const text = await api.readTextFile(path);
      if (!text) return setMsg("파일을 읽지 못했습니다");
      const base = (path.split(/[\\/]/).pop() || "env").replace(/\.(json|ya?ml|bru)$/i, "") || "imported";
      const existing = new Set(useStore.getState().environments.map((e) => e.id));
      let uid = base, n = 2;
      while (existing.has(uid)) uid = `${base}-${n++}`;
      const isJson = /\.json$/i.test(path);
      const env = isJson
        ? await api.importPostmanEnvironment(text, uid)
        : await api.importBrunoEnvironment(text, uid);
      setEnvironments([...useStore.getState().environments, env]);
      setActiveEnv(env.id);
      if (projectDir) { try { await persistClient(projectDir); } catch { /* 저장 실패 무시 */ } }
      setMsg(`✓ 환경 가져옴: ${env.name} (${Object.keys(env.variables).length} vars · ${isJson ? "Postman" : "Bruno"})`);
    } catch (e: any) {
      setMsg(`가져오기 실패: ${e?.message ?? e}`);
    }
  }

  return (
    <div className="builder">
      {/* 좌: 환경 목록 */}
      <aside className="nav">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Environments</h3>
          <div className="row" style={{ gap: 4 }}>
            <button onClick={importEnv} title="Bruno(.yml/.bru) / Postman(.json) 환경 가져오기">⬇ 가져오기</button>
            <button onClick={addEnvironment}>＋ 새 환경</button>
          </div>
        </div>
        <ul className="oplist">
          {environments.map((e) => (
            <li
              key={e.id}
              className={activeEnvId === e.id ? "op sel" : "op"}
              onClick={() => setActiveEnv(e.id)}
            >
              🌐 <span className="p">{e.name}</span>
              <span className="sum">{Object.keys(e.variables).length} vars</span>
            </li>
          ))}
        </ul>
      </aside>

      {/* 우: 변수 편집 */}
      <section className="detail">
        {/* 상단 우측 저장 바 */}
        <div className="envsavebar">
          <span className="status">{msg}</span>
          <button className="active" onClick={save}>💾 프로젝트에 저장</button>
        </div>
        {!env ? (
          <p className="hint">환경을 선택하거나 새로 추가하세요.</p>
        ) : (
          <>
            <div className="row">
              <label style={{ flex: 1 }}>
                이름
                <input value={env.name} onChange={(e) => renameEnvironment(env.id, e.target.value)} />
              </label>
              {environments.length > 1 && (
                <button onClick={() => removeEnvironment(env.id)} style={{ alignSelf: "flex-end" }}>
                  환경 삭제
                </button>
              )}
            </div>

            <h3>변수 (참조: {"{{key}}"})</h3>
            <table className="fieldtable">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {Object.entries(env.variables).map(([k, v]) => (
                  <tr key={k}>
                    <td>
                      <code>{k}</code>
                    </td>
                    <td>
                      <input value={v} onChange={(e) => setVariable(env.id, k, e.target.value)} />
                    </td>
                    <td className="c">
                      <button className="del" onClick={() => removeVariable(env.id, k)}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 6 }}>
              <input value={nk} onChange={(e) => setNk(e.target.value)} placeholder="key" style={{ width: 140 }} />
              <input value={nv} onChange={(e) => setNv(e.target.value)} placeholder="value" style={{ flex: 1 }} />
              <button
                onClick={() => {
                  if (nk.trim()) {
                    setVariable(env.id, nk.trim(), nv);
                    setNk("");
                    setNv("");
                  }
                }}
              >
                ＋ 변수
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
