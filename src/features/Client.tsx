// F4: HTTP API Client. reqwest(Rust)로 실행되므로 CORS 없음.
import { useEffect, useState } from "react";
import { api, type AuthSpec, type BodySpec, type HttpRequestSpec, type HttpResponse } from "../ipc";
import { useStore, type Target } from "../store";
import { CollectionTree, type TreeMenuItem } from "./CollectionTree";

// 활성 환경 선택기(전체 관리는 Environment 탭에서).
function EnvSelect() {
  const { environments, activeEnvId, setActiveEnv, activeEnv } = useStore();
  return (
    <div className="envmgr">
      <h3>Environment</h3>
      <select value={activeEnvId} onChange={(e) => setActiveEnv(e.target.value)} style={{ width: "100%" }}>
        {environments.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      <pre className="envvars">{JSON.stringify(activeEnv()?.variables ?? {}, null, 2)}</pre>
      <div className="hint tiny">변수 편집은 상단 Environment 탭에서</div>
    </div>
  );
}

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];

export function Client() {
  const { activeEnv, copyRequest, copyFolder, addHistory, prefillRequest, setPrefillRequest } = useStore();

  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("{{baseUrl}}/");
  const [headersText, setHeadersText] = useState("");
  const [bodyKind, setBodyKind] = useState<"none" | "json" | "text">("none");
  const [bodyText, setBodyText] = useState("");
  const [authKind, setAuthKind] = useState<"none" | "bearer">("none");
  const [token, setToken] = useState("{{token}}");

  const [resp, setResp] = useState<HttpResponse | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [snippets, setSnippets] = useState<[string, string][]>([]);
  const [snipLang, setSnipLang] = useState("curl");

  function prefill(path: string, m: string) {
    setMethod(m.toUpperCase());
    setUrl(`{{baseUrl}}${path}`);
  }

  function opMenu(t: Target): TreeMenuItem[] {
    if (t.kind === "request")
      return [
        { label: "이 요청으로 Try", run: () => prefill(t.path, t.method) },
        { label: "복사", run: () => copyRequest(t.path, t.method) },
      ];
    if (t.kind === "folder") return [{ label: "복사", run: () => copyFolder(t.path) }];
    return [];
  }

  function parseHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    for (const line of headersText.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return h;
  }

  function buildBody(): BodySpec {
    if (bodyKind === "none") return { kind: "none" };
    if (bodyKind === "json") {
      try {
        return { kind: "json", value: JSON.parse(bodyText || "null") };
      } catch {
        return { kind: "text", value: bodyText };
      }
    }
    return { kind: "text", value: bodyText };
  }

  function buildAuth(): AuthSpec {
    return authKind === "bearer" ? { kind: "bearer", token } : { kind: "none" };
  }

  function buildRequest(): HttpRequestSpec {
    return { method, url, headers: parseHeaders(), query: {}, body: buildBody(), auth: buildAuth() };
  }

  // 요청 값을 폼에 반영(History → Call 열기 등).
  function applyRequest(r: HttpRequestSpec) {
    setMethod(r.method.toUpperCase());
    setUrl(r.url);
    setHeadersText(Object.entries(r.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n"));
    if (r.body.kind === "json") { setBodyKind("json"); setBodyText(JSON.stringify(r.body.value, null, 2)); }
    else if (r.body.kind === "text") { setBodyKind("text"); setBodyText(r.body.value); }
    else setBodyKind("none");
    if (r.auth.kind === "bearer") { setAuthKind("bearer"); setToken(r.auth.token); }
    else setAuthKind("none");
  }

  // History에서 넘어온 프리필 요청을 소비.
  useEffect(() => {
    if (prefillRequest) {
      applyRequest(prefillRequest);
      setPrefillRequest(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillRequest]);

  async function send() {
    setBusy(true);
    setMsg("");
    try {
      const req = buildRequest();
      const r = await api.sendHttpRequest(req, activeEnv());
      setResp(r);
      addHistory({ req, status: r.status, statusText: r.statusText, elapsedMs: r.elapsedMs, sizeBytes: r.sizeBytes });
    } catch (e: any) {
      setMsg(`오류: ${e?.message ?? e}`);
      setResp(null);
    } finally {
      setBusy(false);
    }
  }

  // 요청이 바뀔 때마다 코드 스니펫 자동 생성(디바운스).
  useEffect(() => {
    const t = setTimeout(() => {
      api.codeSnippets(buildRequest(), activeEnv()).then(setSnippets).catch(() => setSnippets([]));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, url, headersText, bodyKind, bodyText, authKind, token]);



  return (
    <div className="client">
      <aside className="nav">
        <EnvSelect />

        <h3>스펙 Operation → Try</h3>
        <div className="hint tiny">요청 클릭=프리필 · 우클릭=Try/복사</div>
        <CollectionTree onSelectRequest={(p, m) => prefill(p, m)} menuFor={opMenu} />
      </aside>

      <section className="detail">
        <div className="reqline">
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input className="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button disabled={busy} onClick={send}>
            {busy ? "…" : "Send"}
          </button>
        </div>

        <label>
          Headers (한 줄에 <code>Key: Value</code>)
          <textarea rows={3} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
        </label>

        <div className="row">
          <label>
            Body
            <select value={bodyKind} onChange={(e) => setBodyKind(e.target.value as any)}>
              <option value="none">none</option>
              <option value="json">json</option>
              <option value="text">text</option>
            </select>
          </label>
          <label>
            Auth
            <select value={authKind} onChange={(e) => setAuthKind(e.target.value as any)}>
              <option value="none">none</option>
              <option value="bearer">bearer</option>
            </select>
          </label>
          {authKind === "bearer" && (
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="token" />
          )}
        </div>
        {bodyKind !== "none" && (
          <textarea rows={6} value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
        )}

        {/* 코드 스니펫 (항상 표시 · 요청 변경 시 자동 갱신) */}
        <div className="snippets">
          <div className="row snipbar">
            <strong>&lt;/&gt; Code</strong>
            {["curl", "javascript", "python", "csharp", "java", "kotlin"].map((lang) => (
              <button key={lang} className={snipLang === lang ? "active" : ""} onClick={() => setSnipLang(lang)}>
                {lang}
              </button>
            ))}
            <button
              onClick={() => navigator.clipboard.writeText(snippets.find(([l]) => l === snipLang)?.[1] ?? "")}
            >
              복사
            </button>
          </div>
          <pre className="code">
            {snippets.find(([l]) => l === snipLang)?.[1] ?? "// 데스크톱 앱에서 코드가 생성됩니다"}
          </pre>
        </div>


        {msg && <p className="err">{msg}</p>}
        {resp && (
          <div className="resp">
            <div className={`respstatus s${Math.floor(resp.status / 100)}`}>
              {resp.status} {resp.statusText} · {resp.elapsedMs}ms · {resp.sizeBytes}B
            </div>
            <pre className="code">
              {resp.bodyJson ? JSON.stringify(resp.bodyJson, null, 2) : resp.bodyText}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}
