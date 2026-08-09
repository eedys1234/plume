// F2: Markdown 뷰 + Copy / F3: Redoc 렌더 + GitHub Pages 퍼블리시 / Try-it-out.
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../ipc";
import { pickSavePath, confirmWarn } from "../dialog";
import { useStore } from "../store";
import { useShallow } from "zustand/react/shallow";

type View = "markdown" | "redoc" | "swagger";

// origin 원격 URL로 GitHub 저장소 공개 여부를 판단.
// 200=공개, 404=비공개/없음, 그 외/GitHub 아님/네트워크오류=불명.
async function repoVisibility(dir: string): Promise<"public" | "private" | "unknown"> {
  try {
    const remotes = await api.gitRemotes(dir); // [name, url][]
    const url = (remotes.find(([n]) => n === "origin") ?? remotes[0])?.[1];
    if (!url) return "unknown";
    const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (!m) return "unknown"; // GitHub 원격이 아니면 판단 불가
    const [, owner, repo] = m;
    const res = await api.sendHttpRequest({
      method: "GET",
      url: `https://api.github.com/repos/${owner}/${repo}`,
      headers: { "User-Agent": "Plume", Accept: "application/vnd.github+json" },
      query: {},
      body: { kind: "none" },
      auth: { kind: "none" },
    });
    if (res.status === 200) {
      const j = res.bodyJson as any;
      if (j && typeof j.private === "boolean") return j.private ? "private" : "public";
      return "public";
    }
    if (res.status === 404) return "private"; // 미인증 상태의 비공개 저장소는 404로 숨겨짐
    return "unknown";
  } catch {
    return "unknown";
  }
}

function CopyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function Docs() {
  const { spec, projectDir, updateSpec } = useStore(
    useShallow((s) => ({ spec: s.spec, projectDir: s.projectDir, updateSpec: s.updateSpec }))
  );
  const notes = typeof (spec as any)?.["x-notes"] === "string" ? ((spec as any)["x-notes"] as string) : "";
  function setNotes(v: string) {
    updateSpec((d: any) => { if (v.trim()) d["x-notes"] = v; else delete d["x-notes"]; });
  }
  const [view, setView] = useState<View>("markdown");
  const [md, setMd] = useState("");
  const [inclEx, setInclEx] = useState(true);
  const [inclSchema, setInclSchema] = useState(true);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);

  async function copyMd() {
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setMsg("복사 실패");
    }
  }

  useEffect(() => {
    if (view !== "markdown") return;
    api
      .specToMarkdown(spec, inclEx, inclSchema)
      .then((m) => { setMd(m); setMsg(""); })
      .catch(() => setMsg("미리보기는 데스크톱 앱에서 표시됩니다"));
  }, [spec, view, inclEx, inclSchema]);

  const hasPaths = Object.keys(spec?.paths ?? {}).length > 0;

  // Redoc: spec을 임베드한 HTML을 iframe srcdoc으로. (오프라인 배포 시 로컬 번들로 교체)
  const redocDoc = useMemo(() => {
    const json = JSON.stringify(spec).replace(/</g, "\\u003c");
    return `<!doctype html><html><head><meta charset="utf-8"/>
<style>body{margin:0}</style></head><body><div id="redoc"></div>
<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
<script>Redoc.init(${json}, {}, document.getElementById('redoc'));</script>
</body></html>`;
  }, [spec]);

  // Swagger UI: 내장 "Try it out" 제공. (브라우저 fetch라 대상 API의 CORS 필요 — CORS-free 호출은 Call 탭)
  const swaggerDoc = useMemo(() => {
    const json = JSON.stringify(spec).replace(/</g, "\\u003c");
    return `<!doctype html><html><head><meta charset="utf-8"/>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"/>
<style>body{margin:0}</style></head><body><div id="swagger"></div>
<script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ spec: ${json}, dom_id: '#swagger', tryItOutEnabled: true });</script>
</body></html>`;
  }, [spec]);

  const [busy, setBusy] = useState<"" | "html" | "pages">("");

  // 현재 문서 뷰(redoc/swagger)에 맞춰 배포한다.
  const viewer: "redoc" | "swagger" = view === "swagger" ? "swagger" : "redoc";

  // 자체 완결(인라인) 단일 HTML 내보내기 — 어디서든 오프라인으로 열림.
  async function exportHtml() {
    const name = `${(spec?.info?.title || "api-docs").replace(/[^\w.-]+/g, "-")}-${viewer}.html`;
    const dest = await pickSavePath(name, "html");
    if (!dest) return;
    setBusy("html");
    setMsg("");
    try {
      const path = await api.exportStandaloneHtml(dest, spec, viewer);
      setMsg(`저장됨(${viewer}): ${path} — 더블클릭하면 인터넷 없이 열립니다`);
    } catch (e: any) {
      setMsg(`오류: ${e?.message ?? e}`);
    } finally {
      setBusy("");
    }
  }

  // 원클릭 GitHub Pages: Redoc=docs/index.html, Swagger=docs/swagger.html → add·commit·push.
  async function publishPages() {
    if (!projectDir) {
      setMsg("프로젝트를 먼저 열어야 합니다");
      return;
    }
    // 공개 저장소가 아니면 경고 → 확인(OK) 시에만 진행.
    setBusy("pages");
    setMsg("저장소 공개 여부 확인 중…");
    const vis = await repoVisibility(projectDir);
    if (vis !== "public") {
      const warn =
        vis === "private"
          ? "이 저장소는 비공개(private)로 보입니다.\n비공개 저장소의 GitHub Pages는 유료 플랜(Pro/Team/Enterprise)에서만 동작합니다.\n\n그래도 배포(커밋·푸시)를 진행할까요?"
          : "저장소의 공개 여부를 확인하지 못했습니다.\n(원격이 GitHub가 아니거나 네트워크 문제일 수 있습니다.)\n비공개라면 Pages가 노출되지 않을 수 있습니다.\n\n계속 진행할까요?";
      const ok = await confirmWarn(warn, "GitHub Pages 배포 경고");
      if (!ok) {
        setBusy("");
        setMsg("배포 취소됨");
        return;
      }
    }
    setMsg(`${viewer} 배포 중… (docs 생성 → 커밋 → 푸시)`);
    try {
      const log = await api.publishGithubPages(projectDir, spec, `docs: update ${viewer} API docs`, viewer);
      setMsg(log);
    } catch (e: any) {
      setMsg(`배포 실패: ${e?.message ?? e}`);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="docs">
      <div className="docbar">
        <button className={view === "markdown" ? "active" : ""} onClick={() => setView("markdown")}>
          Markdown
        </button>
        <button className={view === "redoc" ? "active" : ""} onClick={() => setView("redoc")}>
          Redoc
        </button>
        <button className={view === "swagger" ? "active" : ""} onClick={() => setView("swagger")}>
          Swagger
        </button>

        {view === "markdown" && (
          <>
            <label className="docopt">
              <input type="checkbox" checked={inclEx} onChange={(e) => setInclEx(e.target.checked)} />
              examples
            </label>
            <label className="docopt">
              <input type="checkbox" checked={inclSchema} onChange={(e) => setInclSchema(e.target.checked)} />
              schemas
            </label>
          </>
        )}
        {(view === "redoc" || view === "swagger") && (
          <>
            <button className="active" disabled={busy === "html"} onClick={exportHtml} title={`${viewer} 번들을 인라인한 자체 완결 .html — 오프라인·어디서든 열림`}>
              {busy === "html" ? "내보내는 중…" : `⬇ 단일 HTML (${viewer})`}
            </button>
            <button disabled={busy === "pages"} onClick={publishPages} title={`docs/${viewer === "swagger" ? "swagger.html" : "index.html"} 생성 → git add·commit·push`}>
              {busy === "pages" ? "배포 중…" : "🚀 GitHub Pages 배포"}
            </button>
          </>
        )}
        <span className="status docpubmsg">{msg}</span>
      </div>

      {/* 문서 노트 — 이 컬렉션(스펙)과 함께 저장·git 공유(x-notes) */}
      <details className="specnotes" open={!!notes}>
        <summary>📝 노트 {notes ? "" : "(비어 있음)"}</summary>
        <textarea
          className="specnotestext"
          rows={4}
          value={notes}
          placeholder="이 API 문서에 대한 메모를 남기세요. 저장 시 컬렉션과 함께 보관되고 git으로 공유됩니다."
          onChange={(e) => setNotes(e.target.value)}
        />
      </details>

      {view === "markdown" &&
        (md ? (
          <div className="split">
            <button
              className={copied ? "copybtn done" : "copybtn"}
              title="Markdown 복사"
              aria-label="Copy Markdown"
              onClick={copyMd}
            >
              {copied ? "✓ 복사됨" : <CopyIcon />}
            </button>
            <div className="mdpreview">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
            </div>
            <pre className="mdsource">{md}</pre>
          </div>
        ) : (
          <div className="docempty">
            <div className="docempty-icon">📄</div>
            <p>{hasPaths ? "문서를 생성하는 중…" : "아직 API가 없습니다"}</p>
            <p className="hint">
              {hasPaths
                ? "미리보기는 데스크톱 앱에서 표시됩니다."
                : "Builder에서 요청을 추가하면 이곳에 Markdown 문서가 생성됩니다."}
            </p>
          </div>
        ))}
      {view === "redoc" && (
        <iframe className="redocframe" title="redoc" srcDoc={redocDoc} sandbox="allow-scripts" />
      )}
      {view === "swagger" && (
        <iframe
          className="redocframe"
          title="swagger"
          srcDoc={swaggerDoc}
          sandbox="allow-scripts allow-forms allow-same-origin"
        />
      )}
    </div>
  );
}
