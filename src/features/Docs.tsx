// F2: Markdown 뷰 + Copy / F3: Redoc 렌더 + GitHub Pages 퍼블리시 / Try-it-out.
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../ipc";
import { pickSavePath, confirmWarn } from "../dialog";
import { useStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { loadDeploy, type DeploySettings } from "./deployConfig";

type View = "markdown" | "redoc" | "swagger";

type Note = { id: string; body: string; createdAt: string };
function newNoteId(): string {
  try {
    return `n_${crypto.randomUUID()}`;
  } catch {
    return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

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

// 모든 컬렉션 path를 합친 "전체 문서" 스펙.
function mergeSpecs(cols: { name: string; spec: any }[]): any {
  const paths: any = {};
  const folders = new Set<string>();
  for (const c of cols) {
    const cs = c.spec ?? {};
    for (const p of Object.keys(cs.paths ?? {})) paths[p] = { ...(paths[p] ?? {}), ...cs.paths[p] };
    for (const f of cs["x-folders"] ?? []) folders.add(f);
  }
  return { openapi: "3.0.3", info: { title: "전체 API 문서", version: "1.0.0" }, paths, "x-folders": [...folders] };
}

export function Docs() {
  const { spec, projectDir, updateSpec, collections, activeCollectionId } = useStore(
    useShallow((s) => ({
      spec: s.spec, projectDir: s.projectDir, updateSpec: s.updateSpec,
      collections: s.collections, activeCollectionId: s.activeCollectionId,
    }))
  );
  // 문서 대상: 특정 컬렉션 또는 "전체(모든 컬렉션 병합)".
  const [docSource, setDocSource] = useState<string>(activeCollectionId || "all");
  // 매 렌더 mergeSpecs로 새 객체를 만들면 아래 마크다운 IPC·redoc/swagger 직렬화가 매번 재실행된다.
  // → 참조를 안정화(대상/컬렉션이 바뀔 때만 재계산).
  const docSpec: any = useMemo(
    () =>
      docSource === "all"
        ? mergeSpecs(collections)
        : collections.find((c) => c.id === docSource)?.spec ?? spec,
    [docSource, collections, spec]
  );
  // 노트: [{id, body, createdAt}] 배열. 과거 문자열 형식은 단일 노트로 이관.
  const rawNotes = (spec as any)?.["x-notes"];
  const notes: Note[] = Array.isArray(rawNotes)
    ? (rawNotes as Note[])
    : typeof rawNotes === "string" && rawNotes.trim()
      ? [{ id: "legacy", body: rawNotes, createdAt: "" }]
      : [];
  const [noteDraft, setNoteDraft] = useState("");
  function addNote() {
    const body = noteDraft.trim();
    if (!body) return;
    const note: Note = { id: newNoteId(), body, createdAt: new Date().toISOString() };
    updateSpec((d: any) => {
      const cur: Note[] = Array.isArray(d["x-notes"])
        ? d["x-notes"]
        : typeof d["x-notes"] === "string" && d["x-notes"].trim()
          ? [{ id: "legacy", body: d["x-notes"], createdAt: "" }]
          : [];
      d["x-notes"] = [...cur, note];
    });
    setNoteDraft("");
  }
  function delNote(id: string) {
    updateSpec((d: any) => {
      if (Array.isArray(d["x-notes"])) {
        d["x-notes"] = d["x-notes"].filter((n: Note) => n.id !== id);
        if (d["x-notes"].length === 0) delete d["x-notes"];
      } else {
        delete d["x-notes"]; // 레거시 문자열 삭제
      }
    });
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
      .specToMarkdown(docSpec, inclEx, inclSchema)
      .then((m) => { setMd(m); setMsg(""); })
      .catch(() => setMsg("미리보기는 데스크톱 앱에서 표시됩니다"));
  }, [docSpec, view, inclEx, inclSchema]);

  const hasPaths = Object.keys(docSpec?.paths ?? {}).length > 0;

  // Redoc: spec을 임베드한 HTML을 iframe srcdoc으로. (오프라인 배포 시 로컬 번들로 교체)
  const redocDoc = useMemo(() => {
    const json = JSON.stringify(docSpec).replace(/</g, "\\u003c");
    return `<!doctype html><html><head><meta charset="utf-8"/>
<style>body{margin:0}</style></head><body><div id="redoc"></div>
<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
<script>Redoc.init(${json}, {}, document.getElementById('redoc'));</script>
</body></html>`;
  }, [docSpec]);

  // Swagger UI: 내장 "Try it out" 제공. (브라우저 fetch라 대상 API의 CORS 필요 — CORS-free 호출은 Call 탭)
  const swaggerDoc = useMemo(() => {
    const json = JSON.stringify(docSpec).replace(/</g, "\\u003c");
    return `<!doctype html><html><head><meta charset="utf-8"/>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"/>
<style>body{margin:0}</style></head><body><div id="swagger"></div>
<script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ spec: ${json}, dom_id: '#swagger', tryItOutEnabled: true });</script>
</body></html>`;
  }, [docSpec]);

  const [busy, setBusy] = useState<"" | "html" | "pages" | "cf">("");
  const showAlert = useStore((s) => s.showAlert);
  const [cfModal, setCfModal] = useState<DeploySettings | null>(null); // CF 배포 모달(설정 스냅샷)
  const [cfPath, setCfPath] = useState("index.html");

  // 현재 문서 뷰(redoc/swagger)에 맞춰 배포한다.
  const viewer: "redoc" | "swagger" = view === "swagger" ? "swagger" : "redoc";

  // 자체 완결(인라인) 단일 HTML 내보내기 — 어디서든 오프라인으로 열림.
  async function exportHtml() {
    const name = `${(docSpec?.info?.title || "api-docs").replace(/[^\w.-]+/g, "-")}-${viewer}.html`;
    const dest = await pickSavePath(name, "html");
    if (!dest) return;
    setBusy("html");
    setMsg("");
    try {
      const path = await api.exportStandaloneHtml(dest, docSpec, viewer);
      setMsg(`저장됨(${viewer}): ${path} — 더블클릭하면 인터넷 없이 열립니다`);
    } catch (e: any) {
      showAlert(`${e?.message ?? e}`, { title: "단일 HTML 내보내기 실패", kind: "err" });
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
      const log = await api.publishGithubPages(projectDir, docSpec, `docs: update ${viewer} API docs`, viewer);
      setMsg("");
      showAlert(log, { title: "GitHub Pages 배포 완료", kind: "ok" });
    } catch (e: any) {
      setMsg("");
      showAlert(`${e?.message ?? e}`, { title: "GitHub Pages 배포 실패", kind: "err" });
    } finally {
      setBusy("");
    }
  }

  // 프리픽스 + 경로 → 최종 S3 키(양끝 슬래시 정리).
  function joinKey(prefix: string, path: string): string {
    return [prefix.replace(/^\/+|\/+$/g, ""), path.replace(/^\/+/, "")].filter(Boolean).join("/") || "index.html";
  }

  // ☁ CloudFront 배포: 자격증명 확인(없으면 오류 모달) → 있으면 경로 입력 모달 오픈.
  async function deployCf() {
    const d = await loadDeploy(projectDir);
    if (!d.accessKeyId.trim() || !d.secretAccessKey.trim() || !d.bucket.trim()) {
      showAlert("Settings ▸ 배포 탭에서 AWS 자격증명(Access Key/Secret)과 S3 버킷을 먼저 입력·저장하세요.", { title: "배포 설정 필요", kind: "err" });
      return;
    }
    setCfPath("index.html");
    setCfModal(d);
  }

  // 실제 배포 실행. 결과·오류는 전역 모달로 표시.
  async function runCfDeploy() {
    const d = cfModal;
    if (!d) return;
    const key = joinKey(d.keyPrefix, cfPath);
    setBusy("cf");
    try {
      const log = await api.deployCloudFront({
        accessKeyId: d.accessKeyId,
        secretAccessKey: d.secretAccessKey,
        sessionToken: d.sessionToken || undefined,
        region: d.region,
        bucket: d.bucket,
        key,
        distributionId: d.distributionId,
        invalidationPath: d.invalidationPath,
        roleArn: d.roleArn || undefined,
        viewer,
        spec: docSpec,
      });
      setCfModal(null);
      showAlert(log, { title: "CloudFront 배포 완료", kind: "ok" });
      useStore.getState().logEvent("Export", `CloudFront 배포 · s3://${d.bucket}/${key}`);
    } catch (e: any) {
      showAlert(`배포에 실패했습니다.\n\ns3://${d.bucket}/${key}\n\n${e?.message ?? e}`, { title: "CloudFront 배포 실패", kind: "err" });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="docs">
      <div className="docbar">
        <select value={docSource} onChange={(e) => setDocSource(e.target.value)} title="문서 대상 컬렉션">
          <option value="all">전체 (모든 컬렉션)</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
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
            <button disabled={busy === "cf"} onClick={deployCf} title="Settings의 AWS 설정으로 S3 업로드 + CloudFront 무효화">
              {busy === "cf" ? "배포 중…" : "☁ CloudFront 배포"}
            </button>
          </>
        )}
        <span className="status docpubmsg">{msg}</span>
      </div>

      {/* 문서 노트 — 이 컬렉션(스펙)과 함께 저장·git 공유(x-notes) */}
      <details className="specnotes" open={notes.length > 0}>
        <summary>📝 노트 {notes.length ? `(${notes.length})` : "(비어 있음)"}</summary>
        <div className="notelist">
          {notes.map((n) => (
            <div key={n.id} className="noteitem">
              <div className="notemeta">
                <span className="notetime">{n.createdAt ? new Date(n.createdAt).toLocaleString() : "(이전 노트)"}</span>
                <button className="del" title="노트 삭제" onClick={() => delNote(n.id)}>×</button>
              </div>
              <div className="notebody">{n.body}</div>
            </div>
          ))}
          {notes.length === 0 && <p className="hint tiny">아직 노트가 없습니다. 아래에 추가하세요.</p>}
          <div className="noteadd">
            <textarea
              rows={2}
              value={noteDraft}
              placeholder="노트를 입력하고 Ctrl+Enter로 추가 (등록 시각이 함께 기록됩니다)"
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) addNote(); }}
            />
            <button disabled={!noteDraft.trim()} onClick={addNote}>＋ 노트 추가</button>
          </div>
        </div>
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

      {cfModal && (
        <div className="modalbg" onClick={() => busy !== "cf" && setCfModal(null)}>
          <div className="modal cfmodal" onClick={(e) => e.stopPropagation()}>
            <div className="iomodalhead">
              <h3>☁ CloudFront 배포</h3>
              <button disabled={busy === "cf"} onClick={() => setCfModal(null)}>닫기</button>
            </div>
            <div className="cfbody">
              <p className="hint tiny">
                {viewer} 문서를 S3에 업로드하고 CloudFront를 무효화합니다. 프리픽스(설정)는 고정, 아래에 뒤 경로를 입력하세요.
              </p>
              <label className="cffield">
                Key Prefix <span className="hint tiny">(Settings)</span>
                <input value={cfModal.keyPrefix || "(루트)"} readOnly disabled />
              </label>
              <label className="cffield">
                경로 <span className="hint tiny">(프리픽스 뒤 · 파일명 포함)</span>
                <input autoFocus value={cfPath} onChange={(e) => setCfPath(e.target.value)} placeholder="index.html" onKeyDown={(e) => { if (e.key === "Enter" && busy !== "cf") runCfDeploy(); }} />
              </label>
              <div className="cfpreview">
                업로드 대상: <code>s3://{cfModal.bucket}/{joinKey(cfModal.keyPrefix, cfPath)}</code>
              </div>
              <div className="cfpreview">
                무효화: <code>{cfModal.distributionId ? `${cfModal.distributionId} · ${cfModal.invalidationPath || "/*"}` : "(배포 ID 없음 → 생략)"}</code>
              </div>
            </div>
            <div className="alertbar">
              <button disabled={busy === "cf"} onClick={() => setCfModal(null)}>취소</button>
              <button className="active" disabled={busy === "cf"} onClick={runCfDeploy}>{busy === "cf" ? "배포 중…" : "배포"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
