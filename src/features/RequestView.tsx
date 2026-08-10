// Bruno식 요청 중심 뷰: URL바(method+url+Send) + 서브탭(Params/Body/Headers/Auth/Responses/Docs) + 응답.
// key={activeTab}로 마운트되므로 로컬 상태는 해당 operation에서 새로 초기화된다.
import { useEffect, useRef, useState } from "react";
import { api, type AuthSpec, type HttpRequestSpec, type HttpResponse } from "../ipc";
import { useStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { runScript, type BruApi } from "../script";
import { SchemaEditor } from "./SchemaEditor";
import { ParamsEditor } from "./ParamsEditor";
import { ExamplesEditor } from "./ExamplesEditor";
import { Resizer, usePersistedSize } from "./Resizer";
import { pickSavePath } from "../dialog";

// 응답 헤더에서 저장 파일명/확장자 추정(Content-Disposition → Content-Type 순).
function guessDownload(resp: HttpResponse): { filename: string; ext: string } {
  const h = (name: string) =>
    resp.headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? "";
  const cd = h("content-disposition");
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) {
    let fn = m[1].trim();
    try { fn = decodeURIComponent(fn); } catch { /* 그대로 사용 */ }
    return { filename: fn, ext: (fn.split(".").pop() || "bin").toLowerCase() };
  }
  const ct = h("content-type").toLowerCase();
  const ext =
    ct.includes("spreadsheet") || ct.includes("excel") ? "xlsx"
    : ct.includes("wordprocessing") || ct.includes("msword") ? "docx"
    : ct.includes("presentation") ? "pptx"
    : ct.includes("pdf") ? "pdf"
    : ct.includes("zip") ? "zip"
    : ct.includes("csv") ? "csv"
    : ct.includes("png") ? "png"
    : ct.includes("jpeg") || ct.includes("jpg") ? "jpg"
    : ct.includes("gif") ? "gif"
    : ct.includes("svg") ? "svg"
    : ct.includes("json") ? "json"
    : ct.includes("octet") ? "bin"
    : "bin";
  return { filename: `response.${ext}`, ext };
}

// 다운로드 형식(확장자) 후보. 추정값을 맨 앞에 두고 중복 제거.
const DL_EXTS = ["xlsx", "csv", "pdf", "zip", "docx", "png", "jpg", "svg", "json", "txt", "bin"];

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

const CONTENT_TYPES = [
  "application/json",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
  "application/xml",
];
const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"];
// 표준/자주 쓰는 HTTP 헤더 — 키 입력 자동완성용.
const HTTP_HEADERS = [
  "Accept", "Accept-Charset", "Accept-Encoding", "Accept-Language",
  "Authorization", "Cache-Control", "Connection", "Content-Encoding",
  "Content-Language", "Content-Length", "Content-Type", "Cookie",
  "Date", "ETag", "Expect", "Forwarded", "From", "Host", "If-Match",
  "If-Modified-Since", "If-None-Match", "If-Range", "If-Unmodified-Since",
  "Origin", "Pragma", "Prefer", "Proxy-Authorization", "Range", "Referer",
  "TE", "Trailer", "Transfer-Encoding", "Upgrade", "User-Agent", "Via", "Warning",
  "X-Api-Key", "X-Auth-Token", "X-Correlation-ID", "X-CSRF-Token",
  "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP",
  "X-Request-ID", "X-Requested-With",
];
type Sub = "params" | "body" | "headers" | "auth" | "script" | "responses" | "info" | "code";

// 타입 → 샘플 값 (스키마 필드 추가 시 본문 JSON에 넣을 값).
function sampleForType(type?: string): any {
  switch (type) {
    case "integer":
    case "number": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    default: return "";
  }
}
// 값 → OAS 타입 (본문 JSON에서 스키마 필드 추론).
function inferType(v: any): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "string";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "object") return "object";
  return "string";
}

// JSON 값 → OAS 스키마(재귀). 이전 스키마(prev)의 설명·required는 가능한 한 보존.
function schemaFromValue(v: any, prev?: any): any {
  if (Array.isArray(v)) {
    const first = v[0];
    return {
      type: "array",
      items: first !== undefined ? schemaFromValue(first, prev?.items) : (prev?.items ?? { type: "string" }),
    };
  }
  if (v && typeof v === "object") {
    const prevProps = prev?.properties ?? {};
    const properties: any = {};
    for (const k of Object.keys(v)) properties[k] = schemaFromValue(v[k], prevProps[k]);
    const schema: any = { type: "object", properties };
    const req = (prev?.required ?? []).filter((r: string) => r in v);
    if (req.length) schema.required = req;
    return schema;
  }
  const leaf: any = { type: inferType(v) };
  if (prev?.description) leaf.description = prev.description;
  return leaf;
}

// OAS 스키마 → 예시 값(재귀). 기존 값(cur)이 있으면 유지, 없으면 기본값/타입 샘플.
function sampleFromSchema(s: any, cur?: any): any {
  const t = s?.type;
  if (t === "object" || (s?.properties && !t)) {
    const props = s?.properties ?? {};
    const curObj = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
    const out: any = {};
    for (const k of Object.keys(props)) out[k] = sampleFromSchema(props[k], curObj[k]);
    return out;
  }
  if (t === "array") {
    const itemSchema = s?.items;
    if (Array.isArray(cur) && cur.length) {
      // 기존 항목들을 항목 스키마에 맞춰 재동기화(하위 필드 추가/삭제 반영).
      return itemSchema ? cur.map((c: any) => sampleFromSchema(itemSchema, c)) : cur;
    }
    // 비어 있으면 항목 스키마로 샘플 1개 생성 → 배열/객체 구조가 예시에 보이게.
    return itemSchema ? [sampleFromSchema(itemSchema, undefined)] : [];
  }
  // 주의: 필드별 example(문서용)은 예제 미리보기에 반영하지 않는다(Markdown 전용).
  if (cur !== undefined) return cur;
  return sampleForType(t);
}

export function RequestView({ path, method }: { path: string; method: string }) {
  const { spec, updateSpec, environments, activeEnvId, setVariable, runtimeVars, setRuntimeVar, openTab, closeTab } = useStore(
    useShallow((s) => ({
      spec: s.spec, updateSpec: s.updateSpec, environments: s.environments, activeEnvId: s.activeEnvId,
      setVariable: s.setVariable, runtimeVars: s.runtimeVars, setRuntimeVar: s.setRuntimeVar, openTab: s.openTab, closeTab: s.closeTab,
    }))
  );
  // environments를 직접 구독하고 활성 환경은 로컬 파생 → 환경변수 변경이 즉시 재렌더에 반영.
  const activeEnv = () => environments.find((e) => e.id === activeEnvId);
  const op = spec.paths?.[path]?.[method];
  const edit = (fn: (o: any) => void) => updateSpec((d) => fn(d.paths[path][method]));

  // URL 바에서 메서드 변경 → operation을 새 메서드로 이동하고 탭 갱신.
  function changeMethod(newMethod: string) {
    const nm = newMethod.toLowerCase();
    if (nm === method) return;
    if (spec.paths?.[path]?.[nm]) return; // 같은 경로에 이미 있는 메서드면 무시(덮어쓰기 방지)
    updateSpec((d) => {
      const o = d.paths?.[path]?.[method];
      if (!o) return;
      delete d.paths[path][method];
      d.paths[path][nm] = o;
    });
    closeTab(path, method);
    openTab(path, nm);
  }

  // URL 바 편집 → 엔드포인트(경로) 반영. 대소문자 그대로 보존.
  function changePath(newPath: string) {
    const np = newPath.trim();
    if (!np.startsWith("/") || np === path) return;
    if (spec.paths?.[np]?.[method]) return; // 같은 경로+메서드 이미 존재 → 덮어쓰기 방지
    updateSpec((d) => {
      const o = d.paths?.[path]?.[method];
      if (!o) return;
      delete d.paths[path][method];
      if (Object.keys(d.paths[path]).length === 0) delete d.paths[path];
      d.paths[np] ??= {};
      d.paths[np][method] = o;
    });
    closeTab(path, method);
    openTab(np, method);
  }
  // sendUrl에서 경로만 추출({{var}} 뒤 또는 host 뒤, ? 앞). 없으면 null.
  function extractPath(url: string): string | null {
    let p = url;
    const vi = p.lastIndexOf("}}");
    if (vi >= 0) p = p.slice(vi + 2);
    else {
      const m = p.match(/^[a-z]+:\/\/[^/]+(\/.*)$/i);
      if (m) p = m[1];
    }
    p = p.split("?")[0].split("#")[0];
    return p.startsWith("/") ? p : null;
  }
  // URL 입력 blur 시: 전체 URL(베이스 변수 포함)을 오퍼레이션에 저장 + 경로 동기화.
  // → {{baseUrl}}→{{coloAppServerUrl}} 같은 변경이 재마운트 후에도 유지된다.
  function syncPathFromUrl() {
    const np = extractPath(sendUrl);
    const defaultUrl = `{{baseUrl}}${np ?? path}`;
    // 기본 템플릿과 다르면 x-send-url로 보존, 같으면 제거(깔끔 유지). op와 함께 이동됨.
    edit((o) => {
      if (sendUrl && sendUrl !== defaultUrl) o["x-send-url"] = sendUrl;
      else delete o["x-send-url"];
    });
    if (np && np !== path) changePath(np);
  }

  const mt0 = Object.keys(op?.requestBody?.content ?? {})[0] || "application/json";
  const [bodyMt, setBodyMt] = useState(mt0);
  const example0 = op?.requestBody?.content?.[mt0]?.example;
  const [bodyText, setBodyText] = useState(example0 !== undefined ? JSON.stringify(example0, null, 2) : "");
  const [sub, setSub] = useState<Sub>("params");
  const [sendUrl, setSendUrl] = useState<string>(op?.["x-send-url"] ?? `{{baseUrl}}${path}`);
  // auth는 op의 x-auth에 저장·복원되어 재마운트/저장 후에도 유지된다.
  const [auth, setAuth] = useState<{
    kind: "none" | "bearer" | "basic" | "apikey";
    token: string; username: string; password: string;
    apiKeyName: string; apiKeyValue: string; apiKeyIn: "header" | "query";
  }>(() => ({
    kind: "none", token: "{{token}}", username: "", password: "",
    apiKeyName: "", apiKeyValue: "", apiKeyIn: "header",
    ...(op?.["x-auth"] ?? {}),
  }));
  // auth 변경 시 op에 저장(none이면 제거).
  function updateAuth(next: typeof auth) {
    setAuth(next);
    edit((o: any) => {
      if (next.kind === "none") delete o["x-auth"];
      else o["x-auth"] = next;
    });
  }
  const [resp, setResp] = useState<HttpResponse | null>(null);
  const [dlExt, setDlExt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [scriptLogs, setScriptLogs] = useState<string[]>([]);
  const [openVar, setOpenVar] = useState<string | null>(null);
  const [respTab, setRespTab] = useState<"body" | "headers" | "timeline">("body");
  const [snippets, setSnippets] = useState<[string, string][]>([]);
  const [snipLang, setSnipLang] = useState("curl");
  const [snipCopied, setSnipCopied] = useState(false);
  const [newTag, setNewTag] = useState("");
  const urlInputRef = useRef<HTMLInputElement>(null);
  const urlHlRef = useRef<HTMLDivElement>(null);
  const [respW, setRespW] = usePersistedSize("plume:respW", 560, 320, 1100);

  // op가 없어도 훅 호출 수가 일정해야 하므로 params/headers·스니펫 이펙트를 가드보다 위에 둔다.
  const params = (op?.parameters ?? []).filter((p: any) => p?.in !== "header");
  const headers = (op?.parameters ?? []).filter((p: any) => p?.in === "header");

  // Code 서브탭이 열려 있고 요청이 바뀌면 스니펫 재생성(디바운스).
  useEffect(() => {
    if (!op || sub !== "code") return;
    const t = setTimeout(() => {
      api.codeSnippets(reqSpec(), activeEnv()).then(setSnippets).catch(() => setSnippets([]));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, op, method, sendUrl, bodyText, JSON.stringify(headers), JSON.stringify(params), auth]);

  if (!op) return <div className="reqview"><p className="hint">요청을 찾을 수 없습니다.</p></div>;

  // URL 안의 {{변수}} 해석/토큰화 (하이라이팅·클릭용).
  const envVars = activeEnv()?.variables ?? {};
  const resolveVar = (name: string): { value: string | undefined; from: "runtime" | "env" | null } => {
    if (name in runtimeVars) return { value: runtimeVars[name], from: "runtime" };
    if (name in envVars) return { value: envVars[name], from: "env" };
    return { value: undefined, from: null };
  };
  const urlSegments = (u: string): { text: string; name?: string }[] => {
    const parts: { text: string; name?: string }[] = [];
    const re = /\{\{\s*([\w.-]+)\s*\}\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(u))) {
      if (m.index > last) parts.push({ text: u.slice(last, m.index) });
      parts.push({ text: m[0], name: m[1] });
      last = m.index + m[0].length;
    }
    if (last < u.length) parts.push({ text: u.slice(last) });
    return parts;
  };
  const syncScroll = () => {
    if (urlHlRef.current && urlInputRef.current) urlHlRef.current.scrollLeft = urlInputRef.current.scrollLeft;
  };

  // 본문 JSON 편집 → example 저장 + (object면) 스키마 필드 동기화(추가/수정/삭제).
  function setBody(text: string) {
    setBodyText(text);
    let obj: any;
    try { obj = text.trim() ? JSON.parse(text) : undefined; } catch { return; } // 유효 JSON 아니면 sync 안 함
    edit((o) => {
      o.requestBody ??= { content: {} }; o.requestBody.content ??= {}; o.requestBody.content[bodyMt] ??= {};
      const mt = o.requestBody.content[bodyMt];
      mt.example = obj;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        mt.schema = schemaFromValue(obj, mt.schema); // 중첩까지 재귀 반영
      }
    });
  }

  // 필드 스키마 편집 → schema 저장 + 본문 JSON 동기화(필드 추가는 샘플값, 삭제는 키 제거, 기존값 유지).
  function applySchema(schema: any) {
    let cur: any = {};
    try { cur = bodyText.trim() ? JSON.parse(bodyText) : {}; } catch { cur = {}; }
    if (typeof cur !== "object" || Array.isArray(cur) || cur === null) cur = {};
    const nextExample: any = sampleFromSchema(schema, cur); // 중첩까지 재귀 생성
    edit((o) => {
      o.requestBody ??= { content: {} }; o.requestBody.content ??= {}; o.requestBody.content[bodyMt] ??= {};
      o.requestBody.content[bodyMt].schema = schema;
      o.requestBody.content[bodyMt].example = nextExample;
    });
    setBodyText(JSON.stringify(nextExample, null, 2));
  }

  // 코드 스니펫용 요청 스펙(스크립트 미적용).
  function reqSpec(): HttpRequestSpec {
    const h: Record<string, string> = {};
    headers.forEach((p: any) => p.name && (h[p.name] = p.example ?? ""));
    const q: Record<string, string> = {};
    params.filter((p: any) => p?.in === "query").forEach((p: any) => p.name && (q[p.name] = p.example ?? ""));
    let bodyVal: any;
    if (bodyText.trim()) { try { bodyVal = JSON.parse(bodyText); } catch { bodyVal = bodyText; } }
    const body: any =
      bodyVal == null ? { kind: "none" }
      : typeof bodyVal === "string" ? { kind: "text", value: bodyVal }
      : { kind: "json", value: bodyVal };
    const authSpec: AuthSpec =
      auth.kind === "bearer" ? { kind: "bearer", token: auth.token }
      : auth.kind === "basic" ? { kind: "basic", username: auth.username, password: auth.password }
      : auth.kind === "apikey" ? { kind: "apikey", in: auth.apiKeyIn, name: auth.apiKeyName, value: auth.apiKeyValue }
      : { kind: "none" };
    return { method: method.toUpperCase(), url: sendUrl, headers: h, query: q, body, auth: authSpec };
  }

  // 컬렉션·폴더·요청 스크립트를 실행 순서대로 모은다.
  // pre: 컬렉션 → 폴더(부모→자식) → 요청 / post: 요청 → 폴더(자식→부모) → 컬렉션.
  function gatherScripts(): { pres: string[]; posts: string[] } {
    const pres: string[] = [];
    const posts: string[] = [];
    const fs: any = (spec as any)?.["x-folder-scripts"] ?? {};
    const folder = op?.["x-folder"];
    const chain: string[] = [];
    if (typeof folder === "string" && folder) {
      let acc = "";
      for (const seg of folder.split("/").filter(Boolean)) { acc = acc ? `${acc}/${seg}` : seg; chain.push(acc); }
    }
    if ((spec as any)?.["x-pre-request-script"]) pres.push((spec as any)["x-pre-request-script"]);
    for (const f of chain) if (fs[f]?.pre) pres.push(fs[f].pre);
    if (op?.["x-pre-request-script"]) pres.push(op["x-pre-request-script"]);
    if (op?.["x-post-response-script"]) posts.push(op["x-post-response-script"]);
    for (const f of [...chain].reverse()) if (fs[f]?.post) posts.push(fs[f].post);
    if ((spec as any)?.["x-post-response-script"]) posts.push((spec as any)["x-post-response-script"]);
    return { pres, posts };
  }

  async function send() {
    setBusy(true);
    setMsg("");
    const logs: string[] = [];
    try {
      // bru: 환경/런타임 변수 접근 (스크립트에서 사용)
      const bru: BruApi = {
        getEnvVar: (k) => { const e = activeEnv(); return e?.variables[k] ?? e?.scriptVariables?.[k]; },
        setEnvVar: (k, v) => setVariable(activeEnvId, k, String(v)),
        getVar: (k) => runtimeVars[k],
        setVar: (k, v) => setRuntimeVar(k, String(v)),
      };

      // 요청 컨텍스트 (pre-script가 수정 가능)
      const h: Record<string, string> = {};
      headers.forEach((p: any) => p.name && (h[p.name] = p.example ?? ""));
      const q: Record<string, string> = {};
      params.filter((p: any) => p?.in === "query").forEach((p: any) => p.name && (q[p.name] = p.example ?? ""));
      let bodyVal: any = undefined;
      if (bodyText.trim()) {
        try { bodyVal = JSON.parse(bodyText); } catch { bodyVal = bodyText; }
      }
      const reqCtx: any = {
        method: method.toUpperCase(), url: sendUrl, headers: h, query: q, body: bodyVal,
        setHeader: (k: string, v: unknown) => (reqCtx.headers[k] = String(v)),
        setUrl: (u: string) => (reqCtx.url = u),
        setBody: (b: unknown) => (reqCtx.body = b),
      };

      // Pre-request Script: 컬렉션 → 폴더(부모→자식) → 요청 순.
      const { pres, posts } = gatherScripts();
      for (const pre of pres) {
        const r = runScript(pre, { bru, req: reqCtx });
        logs.push(...r.logs);
        if (r.error) logs.push("✖ pre-script: " + r.error);
      }

      const body: any =
        reqCtx.body == null ? { kind: "none" }
        : typeof reqCtx.body === "string" ? { kind: "text", value: reqCtx.body }
        : { kind: "json", value: reqCtx.body };
      const authSpec: AuthSpec =
        auth.kind === "bearer" ? { kind: "bearer", token: auth.token }
        : auth.kind === "basic" ? { kind: "basic", username: auth.username, password: auth.password }
        : auth.kind === "apikey" ? { kind: "apikey", in: auth.apiKeyIn, name: auth.apiKeyName, value: auth.apiKeyValue }
        : { kind: "none" };

      const r = await api.sendHttpRequest(
        { method: reqCtx.method, url: reqCtx.url, headers: reqCtx.headers, query: reqCtx.query, body, auth: authSpec },
        activeEnv()
      );
      setResp(r);
      setDlExt(guessDownload(r).ext); // 응답마다 추정 확장자로 초기화

      // Post-response Script: 요청 → 폴더(자식→부모) → 컬렉션 순.
      if (posts.length) {
        const resCtx = {
          status: r.status,
          statusText: r.statusText,
          headers: Object.fromEntries(r.headers),
          body: r.bodyJson ?? r.bodyText,
          responseTime: r.elapsedMs,
        };
        for (const post of posts) {
          const rr = runScript(post, { bru, res: resCtx });
          logs.push(...rr.logs);
          if (rr.error) logs.push("✖ post-script: " + rr.error);
        }
      }
      setScriptLogs(logs);
    } catch (e: any) {
      setMsg(`오류: ${e?.message ?? e}`);
      setResp(null);
      setScriptLogs(logs);
    } finally {
      setBusy(false);
    }
  }

  // 응답 본문을 파일로 저장. 바이너리면 원본 바이트, 텍스트면 UTF-8 인코딩.
  async function downloadResponse(ext: string) {
    if (!resp) return;
    const base = (op.summary || op.operationId || "response").replace(/[^\w.-]+/g, "-");
    const dest = await pickSavePath(`${base}.${ext}`, ext);
    if (!dest) return; // 취소 또는 브라우저 미리보기(비-Tauri)
    const bytes =
      resp.isBinary && resp.bodyBytes
        ? resp.bodyBytes
        : Array.from(new TextEncoder().encode(resp.bodyText));
    try {
      await api.writeBytesFile(dest, bytes);
      setMsg(`저장됨: ${dest}`);
    } catch (e: any) {
      setMsg(`저장 실패: ${e?.message ?? e}`);
    }
  }

  const dot = (on: boolean) => (on ? <span className="dot">•</span> : null);

  return (
    <div className="reqview">
      {/* 요청 이름 (summary) — 호출 URL과 별개 */}
      <div className="reqname">
        <input
          value={op.summary ?? ""}
          placeholder="요청 이름 (예: 테스트 계정 로그인)"
          onChange={(e) => edit((o) => (o.summary = e.target.value || undefined))}
        />
      </div>

      {/* URL 바 */}
      <div className="urlbar">
        <select className={`m-select m-${method}`} value={method} onChange={(e) => changeMethod(e.target.value)} title="메서드 변경">
          {HTTP_METHODS.map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}
        </select>
        <div className="urlfield">
          <div className="urlhl" ref={urlHlRef} aria-hidden="true">
            {urlSegments(sendUrl).map((s, i) =>
              s.name ? (
                <span
                  key={i}
                  className={`uvar ${resolveVar(s.name).value !== undefined ? "ok" : "missing"}`}
                  title={resolveVar(s.name).value !== undefined ? `${s.name} = ${resolveVar(s.name).value || "(빈 값)"}` : `${s.name} — 미정의`}
                  onClick={() => setOpenVar(openVar === s.name ? null : s.name!)}
                >
                  {s.text}
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              )
            )}
          </div>
          <input
            className="url"
            ref={urlInputRef}
            value={sendUrl}
            spellCheck={false}
            onChange={(e) => setSendUrl(e.target.value)}
            onBlur={syncPathFromUrl}
            onKeyDown={(e) => { if (e.key === "Enter") syncPathFromUrl(); }}
            onScroll={syncScroll}
          />
          {openVar && (
            <>
            <div className="ctxoverlay" onClick={() => setOpenVar(null)} />
            <div className="varpop">
              <div className="varpophead">
                <code>{`{{${openVar}}}`}</code>
                <button className="del" onClick={() => setOpenVar(null)}>×</button>
              </div>
              {resolveVar(openVar).from === "runtime" ? (
                <p className="tiny" style={{ margin: "6px 2px" }}>
                  런타임 변수(스크립트): <b>{String(runtimeVars[openVar])}</b>
                </p>
              ) : (
                <label className="varedit">
                  값 · 환경 {activeEnv()?.name ?? "(없음)"}
                  <input
                    autoFocus
                    value={envVars[openVar] ?? ""}
                    placeholder={envVars[openVar] === undefined ? "미정의 — 값을 입력하면 환경에 추가됩니다" : "(빈 값)"}
                    onChange={(e) => setVariable(activeEnvId, openVar!, e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && setOpenVar(null)}
                  />
                </label>
              )}
            </div>
            </>
          )}
        </div>
        <button className="active send" disabled={busy} onClick={send}>{busy ? "…" : "Send"}</button>
      </div>

      {/* 좌(요청 탭+본문) / 우(응답) 가로 분할 */}
      <div className="reqsplit">
      <div className="reqpane">
      {/* 서브탭 */}
      <div className="reqsubtabs">
        {(["info", "params", "headers", "auth", "body", "responses", "script", "code"] as Sub[]).map((s) => (
          <button key={s} className={sub === s ? "st active" : "st"} onClick={() => setSub(s)}>
            {s === "info" ? "Info" : s === "code" ? "Snippet" : s[0].toUpperCase() + s.slice(1)}
            {s === "params" && dot(params.length > 0)}
            {s === "body" && dot(!!op.requestBody)}
            {s === "headers" && dot(headers.length > 0)}
            {s === "auth" && dot(auth.kind !== "none")}
            {s === "script" && dot(!!op["x-pre-request-script"] || !!op["x-post-response-script"])}
            {s === "responses" && dot(Object.keys(op.responses ?? {}).length > 0)}
          </button>
        ))}
      </div>

      <div className="subbody">
        {sub === "params" && (
          <ParamsEditor
            value={params}
            onChange={(next) => edit((o) => (o.parameters = [...headers, ...next]))}
          />
        )}
        {sub === "headers" && (
          <HeadersEditor value={op.parameters} onChange={(nh) => edit((o) => (o.parameters = [...params, ...nh]))} />
        )}
        {sub === "body" && (
          <div>
            <div className="row">
              <label style={{ flex: 1 }}>
                Content-Type
                <select value={bodyMt} onChange={(e) => setBodyMt(e.target.value)}>
                  {CONTENT_TYPES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
            </div>

            <div className="sublabel">본문 필드 (스키마 ↔ 아래 JSON 자동 동기화)</div>
            <SchemaEditor value={op.requestBody?.content?.[bodyMt]?.schema} onChange={applySchema} />

            <div className="sublabel">본문 JSON (Send 페이로드 · OAS example)</div>
            <textarea rows={10} value={bodyText} onChange={(e) => setBody(e.target.value)} placeholder='{ "key": "value" }' />

            <details>
              <summary>명세 예시 (named examples)</summary>
              <ExamplesEditor
                examples={op.requestBody?.content?.[bodyMt]?.examples}
                onChange={(next) => edit((o) => {
                  o.requestBody ??= { content: {} }; o.requestBody.content ??= {};
                  o.requestBody.content[bodyMt] ??= {};
                  if (Object.keys(next).length) o.requestBody.content[bodyMt].examples = next;
                  else delete o.requestBody.content[bodyMt].examples;
                })}
              />
            </details>
          </div>
        )}
        {sub === "auth" && (
          <div className="authbox">
            <label style={{ maxWidth: 240 }}>
              방식
              <select value={auth.kind} onChange={(e) => updateAuth({ ...auth, kind: e.target.value as any })}>
                <option value="none">None</option>
                <option value="basic">Basic Auth</option>
                <option value="bearer">Bearer Token</option>
                <option value="apikey">API Key</option>
              </select>
            </label>
            {auth.kind === "bearer" && (
              <label>Token<input value={auth.token} onChange={(e) => updateAuth({ ...auth, token: e.target.value })} /></label>
            )}
            {auth.kind === "basic" && (
              <div className="row">
                <label style={{ flex: 1 }}>Username<input value={auth.username} onChange={(e) => updateAuth({ ...auth, username: e.target.value })} /></label>
                <label style={{ flex: 1 }}>Password<input type="password" value={auth.password} onChange={(e) => updateAuth({ ...auth, password: e.target.value })} /></label>
              </div>
            )}
            {auth.kind === "apikey" && (
              <>
                <div className="row">
                  <label style={{ flex: 1 }}>Key<input value={auth.apiKeyName} placeholder="예: X-API-Key" onChange={(e) => updateAuth({ ...auth, apiKeyName: e.target.value })} /></label>
                  <label style={{ flex: 1 }}>Value<input value={auth.apiKeyValue} placeholder="예: {{apiKey}}" onChange={(e) => updateAuth({ ...auth, apiKeyValue: e.target.value })} /></label>
                </div>
                <label style={{ maxWidth: 160 }}>Add To
                  <select value={auth.apiKeyIn} onChange={(e) => updateAuth({ ...auth, apiKeyIn: e.target.value as "header" | "query" })}>
                    <option value="header">Header</option>
                    <option value="query">Query Param</option>
                  </select>
                </label>
              </>
            )}
            <p className="hint tiny">인증은 요청 Send에 적용되고 이 요청에 저장됩니다({"{{token}}"} 등 환경변수 사용 가능).</p>
          </div>
        )}
        {sub === "script" && (
          <div>
            <div className="sublabel">Pre-request Script · JS (bru, req, console)</div>
            <textarea
              rows={6} className="scriptedit"
              value={op["x-pre-request-script"] ?? ""}
              onChange={(e) => edit((o) => { const v = e.target.value; if (v) o["x-pre-request-script"] = v; else delete o["x-pre-request-script"]; })}
              placeholder={"// 요청 전 실행\n// 예) req.setHeader('X-Time', String(Date.now()))\n//     bru.setEnvVar('nonce', Math.random())"}
            />
            <div className="sublabel">Post-response Script · JS (bru, res, console)</div>
            <textarea
              rows={6} className="scriptedit"
              value={op["x-post-response-script"] ?? ""}
              onChange={(e) => edit((o) => { const v = e.target.value; if (v) o["x-post-response-script"] = v; else delete o["x-post-response-script"]; })}
              placeholder={"// 응답 후 실행\n// 예) bru.setEnvVar('token', res.body.token)\n//     if (res.status !== 200) console.error('실패', res.status)"}
            />
            <div className="sublabel">Script Console</div>
            <pre className="code scriptlog">{scriptLogs.length ? scriptLogs.join("\n") : "(Send 시 스크립트 로그가 여기 표시)"}</pre>
          </div>
        )}
        {sub === "responses" && <ResponsesEditor path={path} method={method} />}
        {sub === "info" && (
          <div>
            <label>summary<input value={op.summary ?? ""} onChange={(e) => edit((o) => (o.summary = e.target.value))} /></label>
            <label>description<textarea rows={3} value={op.description ?? ""} onChange={(e) => edit((o) => (o.description = e.target.value))} /></label>
            <div className="sublabel">tags (검색 키워드로도 사용됨)</div>
            <div className="tagsbox">
              {(op.tags ?? []).map((t: string, i: number) => (
                <span key={i} className="tagchip">
                  {t}
                  <button className="tagx" title="태그 제거" onClick={() => edit((o) => (o.tags = (o.tags ?? []).filter((_: string, j: number) => j !== i)))}>×</button>
                </span>
              ))}
              {(op.tags ?? []).length === 0 && <span className="hint tiny">태그 없음</span>}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <input
                value={newTag}
                placeholder="태그 추가 후 Enter"
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTag.trim()) {
                    const t = newTag.trim();
                    edit((o) => { const cur = o.tags ?? []; if (!cur.includes(t)) o.tags = [...cur, t]; });
                    setNewTag("");
                  }
                }}
                style={{ flex: 1 }}
              />
              <button
                disabled={!newTag.trim()}
                onClick={() => {
                  const t = newTag.trim();
                  edit((o) => { const cur = o.tags ?? []; if (!cur.includes(t)) o.tags = [...cur, t]; });
                  setNewTag("");
                }}
              >
                ＋ 태그
              </button>
            </div>
          </div>
        )}
        {sub === "code" && (
          <div className="snippets">
            <div className="row snipbar">
              {["curl", "javascript", "python", "csharp", "java", "kotlin"].map((lang) => (
                <button key={lang} className={snipLang === lang ? "active" : ""} onClick={() => setSnipLang(lang)}>
                  {lang}
                </button>
              ))}
            </div>
            <div className="codewrap">
              <button
                className="codecopybtn"
                title="복사"
                onClick={() => {
                  navigator.clipboard.writeText(snippets.find(([l]) => l === snipLang)?.[1] ?? "");
                  setSnipCopied(true);
                  setTimeout(() => setSnipCopied(false), 1200);
                }}
              >
                {snipCopied ? "✓" : <CopyIcon />}
              </button>
              <pre className="code">
                {snippets.find(([l]) => l === snipLang)?.[1] ?? "// 요청 정보를 채우면 코드가 생성됩니다 (데스크톱 앱)"}
              </pre>
            </div>
          </div>
        )}
      </div>

      </div>{/* /.reqpane */}

      <Resizer axis="x" onDelta={(d) => setRespW((w) => w - d)} />

      {/* 응답 — 우측 패널(탭: Response/Headers/Timeline) · 너비 조절 가능 */}
      <div className="resppane" style={{ width: respW, flex: "none" }}>
        <div className="resptabbar">
          <button className={respTab === "body" ? "rt active" : "rt"} onClick={() => setRespTab("body")}>Response</button>
          <button className={respTab === "headers" ? "rt active" : "rt"} onClick={() => setRespTab("headers")}>
            Headers{resp && resp.headers.length > 0 && <span className="hcount">{resp.headers.length}</span>}
          </button>
          <button className={respTab === "timeline" ? "rt active" : "rt"} onClick={() => setRespTab("timeline")}>Timeline</button>
          <span className="spacer" />
          {resp && (
            <>
              <span className={`respstatus s${Math.floor(resp.status / 100)}`}>{resp.status} {resp.statusText}</span>
              <span className="status">{resp.elapsedMs}ms · {resp.sizeBytes}B</span>
              {resp.isBinary && <span className="binbadge">bin</span>}
              <span className="respdl">
                <select value={dlExt} title="다운로드 형식(확장자)" onChange={(e) => setDlExt(e.target.value)}>
                  {[...new Set([dlExt, ...DL_EXTS].filter(Boolean))].map((x) => (
                    <option key={x} value={x}>.{x}</option>
                  ))}
                </select>
                <button title="응답 다운로드" onClick={() => downloadResponse(dlExt || "bin")}>⬇</button>
              </span>
            </>
          )}
        </div>

        <div className="resptabbody">
          {msg && <p className="err" style={{ margin: "10px 16px" }}>{msg}</p>}
          {!resp && !msg && (
            <div className="respempty">아직 응답이 없습니다 · <b>Send</b> 를 눌러 요청을 실행하세요</div>
          )}
          {resp && respTab === "body" && (
            <pre className="code respbody">{resp.bodyJson ? JSON.stringify(resp.bodyJson, null, 2) : resp.bodyText}</pre>
          )}
          {resp && respTab === "headers" && (
            resp.headers.length > 0 ? (
              <table className="respheadtable">
                <tbody>
                  {resp.headers.map(([k, v], i) => (
                    <tr key={i}><td className="hk">{k}</td><td className="hv">{v}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="respempty">응답 헤더가 없습니다</div>
          )}
          {resp && respTab === "timeline" && (
            <div className="timeline">
              <div className="tlrow"><span>Request</span><code>{method.toUpperCase()} {sendUrl}</code></div>
              <div className="tlrow"><span>Status</span><span>{resp.status} {resp.statusText}</span></div>
              <div className="tlrow"><span>Time</span><span>{resp.elapsedMs} ms</span></div>
              <div className="tlrow"><span>Size</span><span>{resp.sizeBytes} B</span></div>
              {scriptLogs.length > 0 && (
                <>
                  <div className="sublabel" style={{ marginTop: 10 }}>Script Console</div>
                  <pre className="code scriptlog">{scriptLogs.join("\n")}</pre>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      </div>{/* /.reqsplit */}
    </div>
  );
}

// HTTP 헤더 Key 커스텀 자동완성(네이티브 datalist 대신 테마 드롭다운).
function HeaderKeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const q = (value ?? "").toLowerCase();
  const matches = HTTP_HEADERS.filter((h) => h.toLowerCase().includes(q) && h.toLowerCase() !== q).slice(0, 8);
  return (
    <div className="hdrkey">
      <input
        value={value ?? ""}
        placeholder="헤더 키"
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      {open && matches.length > 0 && (
        <div className="hdrkeylist">
          {matches.map((h) => (
            <div key={h} className="hdrkeyitem" onMouseDown={(e) => { e.preventDefault(); onChange(h); setOpen(false); }}>{h}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function HeadersEditor({ value, onChange }: { value: any[] | undefined; onChange: (nh: any[]) => void }) {
  const headers = (value ?? []).filter((p: any) => p?.in === "header");
  const set = (i: number, patch: any) => onChange(headers.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const add = () => onChange([...headers, { name: "X-Custom-Header", in: "header", schema: { type: "string" }, example: "" }]);
  const remove = (i: number) => onChange(headers.filter((_, j) => j !== i));
  return (
    <div className="schemaeditor">
      <table className="fieldtable">
        <thead><tr><th>Key</th><th>Value</th><th>필수</th><th /></tr></thead>
        <tbody>
          {headers.length === 0 && <tr><td colSpan={4} className="hint">헤더 없음</td></tr>}
          {headers.map((h, i) => (
            <tr key={i}>
              <td><HeaderKeyInput value={h.name ?? ""} onChange={(v) => set(i, { name: v })} /></td>
              <td><input value={h.example ?? ""} onChange={(e) => set(i, { example: e.target.value || undefined })} /></td>
              <td className="c"><input type="checkbox" checked={!!h.required} onChange={(e) => set(i, { required: e.target.checked })} /></td>
              <td className="c"><button className="del" onClick={() => remove(i)}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={add}>＋ Header</button>
    </div>
  );
}

const COMMON_STATUS: [string, string][] = [
  ["200", "OK"],
  ["201", "Created"],
  ["204", "No Content"],
  ["400", "Bad Request"],
  ["401", "Unauthorized"],
  ["403", "Forbidden"],
  ["404", "Not Found"],
  ["409", "Conflict"],
  ["422", "Unprocessable Entity"],
  ["500", "Internal Server Error"],
];

const MT_JSON = "application/json";

function ResponsesEditor({ path, method }: { path: string; method: string }) {
  const { spec, updateSpec } = useStore(useShallow((s) => ({ spec: s.spec, updateSpec: s.updateSpec })));
  const op = spec.paths[path][method];
  const edit = (fn: (o: any) => void) => updateSpec((d) => fn(d.paths[path][method]));
  const statuses = Object.keys(op.responses ?? {});
  const [active, setActive] = useState<string>(statuses[0] ?? "");
  const [customCode, setCustomCode] = useState("");
  const cur = statuses.includes(active) ? active : (statuses[0] ?? "");
  const [exText, setExText] = useState("");

  // 활성 상태 바뀌면 예시 텍스트 로드.
  useEffect(() => {
    const ex = op.responses?.[cur]?.content?.[MT_JSON]?.example;
    setExText(ex !== undefined ? JSON.stringify(ex, null, 2) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, path, method]);

  function addStatus(code: string, desc = "") {
    edit((o) => { o.responses ??= {}; if (!o.responses[code]) o.responses[code] = { description: desc }; });
    setActive(code);
  }
  function delStatus(code: string) {
    if (!confirm(`응답 '${code}' 을(를) 삭제할까요?`)) return;
    edit((o) => { delete o.responses[code]; });
  }
  // 예시 JSON 편집 → example 저장 + 스키마 재귀 동기화.
  function setExample(text: string) {
    setExText(text);
    let obj: any;
    try { obj = text.trim() ? JSON.parse(text) : undefined; } catch { return; }
    edit((o) => {
      const r = (o.responses[cur] ??= { description: "" });
      r.content ??= {}; r.content[MT_JSON] ??= {};
      r.content[MT_JSON].example = obj;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        r.content[MT_JSON].schema = schemaFromValue(obj, r.content[MT_JSON].schema);
      }
    });
  }
  // 스키마 필드 편집 → schema 저장 + 예시 재귀 생성(기존 값 유지).
  function applySchema(schema: any) {
    let curVal: any = {};
    try { curVal = exText.trim() ? JSON.parse(exText) : {}; } catch { curVal = {}; }
    if (typeof curVal !== "object" || Array.isArray(curVal) || curVal === null) curVal = {};
    const nextEx = sampleFromSchema(schema, curVal);
    edit((o) => {
      const r = (o.responses[cur] ??= { description: "" });
      r.content ??= {}; r.content[MT_JSON] ??= {};
      r.content[MT_JSON].schema = schema;
      r.content[MT_JSON].example = nextEx;
    });
    setExText(JSON.stringify(nextEx, null, 2));
  }

  return (
    <div className="respeditor">
      {/* 상태 탭 */}
      <div className="statustabs">
        {statuses.map((st) => (
          <button key={st} className={st === cur ? `stab s${st[0]} active` : `stab s${st[0]}`} onClick={() => setActive(st)}>
            {st}
            <span className="stabx" title="이 응답 삭제" onClick={(e) => { e.stopPropagation(); delStatus(st); }}>×</span>
          </button>
        ))}
        {statuses.length === 0 && <span className="hint tiny">아직 응답이 없습니다. 아래에서 추가하세요.</span>}
      </div>

      {/* 빠른 추가(미등록만) + 커스텀 코드 */}
      <div className="statusadd">
        {COMMON_STATUS.filter(([c]) => !op.responses?.[c]).map(([code, desc]) => (
          <button key={code} className="sqbtn" title={desc} onClick={() => addStatus(code, desc)}>＋ {code}</button>
        ))}
        <input
          className="customcode"
          value={customCode}
          onChange={(e) => setCustomCode(e.target.value)}
          placeholder="커스텀 (예: 418)"
          onKeyDown={(e) => { if (e.key === "Enter" && /^\d{3}$/.test(customCode)) { addStatus(customCode); setCustomCode(""); } }}
        />
        <button disabled={!/^\d{3}$/.test(customCode)} onClick={() => { addStatus(customCode); setCustomCode(""); }}>＋ 커스텀</button>
      </div>

      {/* 활성 상태 내용 */}
      {cur && op.responses?.[cur] && (
        <div className="statusbody">
          <label>description
            <input value={op.responses[cur].description ?? ""} onChange={(e) => edit((o) => (o.responses[cur].description = e.target.value))} />
          </label>
          <div className="sublabel">응답 필드 (스키마 ↔ 아래 예시 자동 동기화)</div>
          <SchemaEditor value={op.responses[cur]?.content?.[MT_JSON]?.schema} onChange={applySchema} />
          <div className="sublabel">응답 예시 (상태당 1개)</div>
          <textarea rows={8} value={exText} onChange={(e) => setExample(e.target.value)} placeholder='{ "id": "usr_1" }' />
        </div>
      )}
    </div>
  );
}
