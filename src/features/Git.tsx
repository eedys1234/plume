// Git 탭 (Sourcetree 스타일): 브랜치 · 스테이지/언스테이지 분리 · 파일별 스테이징 · diff · 커밋 · 히스토리.
import { useEffect, useState } from "react";
import { api, type GitCommit, type GitFileStatus, type GitGraphCommit, type GitStatus } from "../ipc";
import { useStore } from "../store";
import { GitGraph } from "./GitGraph";
import { Resizer, usePersistedSize } from "./Resizer";

const isUntracked = (f: GitFileStatus) => f.status === "??";

export function Git() {
  // Git은 상단 "📁 폴더 열기"로 지정한 작업 폴더(projectDir)를 그대로 사용한다.
  const projectDir = useStore((s) => s.projectDir);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [remotes, setRemotes] = useState<[string, string][]>([]);
  const [rName, setRName] = useState("origin");
  const [rUrl, setRUrl] = useState("");
  const [histView, setHistView] = useState<"log" | "graph">("log");
  const [graphData, setGraphData] = useState<GitGraphCommit[]>([]);
  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [stashes, setStashes] = useState<{ index: number; message: string }[]>([]);
  const [stashMsg, setStashMsg] = useState("");
  const [histH, setHistH] = usePersistedSize("plume:gitHistH", 175, 90, 600);

  async function refresh() {
    if (!projectDir) return;
    try {
      const s = await api.gitStatus(projectDir);
      setStatus(s);
      if (s.isRepo) {
        setLog(await api.gitLog(projectDir, 30));
        setBranches(await api.gitBranches(projectDir));
        setRemotes(await api.gitRemotes(projectDir));
        setGraphData(await api.gitGraphData(projectDir, 80));
        setStashes(await api.gitStashList(projectDir));
      }
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    }
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir]);

  async function act(fn: () => Promise<string | void>, label: string, keepSel = true) {
    if (!projectDir) return;
    setBusy(true);
    setMsg("");
    try {
      const out = await fn();
      setMsg(`${label} ✓${out ? " · " + out.slice(0, 70) : ""}`);
      await refresh();
      if (!keepSel) {
        setSel(null);
        setDiff("");
      }
    } catch (e: any) {
      setMsg(`${label} 오류: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  async function selectFile(f: GitFileStatus, staged: boolean) {
    setSel({ path: f.path, staged });
    if (!projectDir) return;
    try {
      setDiff(await api.gitDiffFile(projectDir, f.path, staged));
    } catch (e: any) {
      setDiff(`(diff 불가) ${e?.message ?? e}`);
    }
  }

  if (!projectDir) {
    return (
      <div className="gitpanel">
        <div className="gitopen">
          <p className="hint">
            상단의 <b>📁 폴더 열기</b>로 작업 폴더를 지정하면 그 폴더의 Git 상태가 여기 표시됩니다.
          </p>
        </div>
      </div>
    );
  }
  if (status && !status.isRepo) {
    return (
      <div className="gitpanel">
        <div className="gitopen">
          <p className="hint">
            작업 폴더 <code>{projectDir}</code> 는 아직 git 저장소가 아닙니다.
          </p>
          <button className="active" onClick={() => act(() => api.gitInit(projectDir), "git init")}>
            git init
          </button>
          <span className="status">{msg}</span>
        </div>
      </div>
    );
  }

  const files = status?.files ?? [];
  const staged = files.filter((f) => f.status[0] !== " " && f.status[0] !== "?");
  const unstaged = files.filter((f) => f.status[1] !== " " || isUntracked(f));

  return (
    <div className="gitpanel">
      {/* 상단 액션바 */}
      <div className="gitbar">
        <span className="badge">⎇ {status?.branch || "-"}</span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="badge warn">↑{status.ahead} ↓{status.behind}</span>
        )}
        <code className="gitdir" title={projectDir}>{projectDir}</code>
        <button disabled={busy} onClick={() => act(() => api.gitFetch(projectDir), "fetch")}>Fetch</button>
        <button disabled={busy} onClick={() => act(() => api.gitPull(projectDir), "pull")}>Pull</button>
        <button disabled={busy} onClick={() => act(() => api.gitPush(projectDir), "push")}>Push</button>
        <button disabled={busy} onClick={refresh}>새로고침</button>
        <span className="status">{msg}</span>
      </div>

      <div className="gitmain">
        {/* 원격 + 브랜치 패널 (Remotes를 위로 이동) */}
        <div className="gitbranches">
          <h3>Stash</h3>
          <div className="row" style={{ marginBottom: 4 }}>
            <input
              value={stashMsg}
              onChange={(e) => setStashMsg(e.target.value)}
              placeholder="메시지(선택)"
              style={{ flex: 1, minWidth: 0 }}
              onKeyDown={(e) => {
                if (e.key === "Enter") act(() => api.gitStashSave(projectDir, stashMsg.trim(), true), "stash").then(() => setStashMsg(""));
              }}
            />
            <button
              disabled={busy}
              title="변경사항을 stash에 저장(추적 안 된 파일 포함)"
              onClick={() => act(() => api.gitStashSave(projectDir, stashMsg.trim(), true), "stash").then(() => setStashMsg(""))}
            >
              Stash
            </button>
          </div>
          <ul className="gitfiles">
            {stashes.length === 0 && <li className="hint tiny">stash 없음</li>}
            {stashes.map((s) => (
              <li key={s.index} className="remote">
                <div className="rinfo">
                  <b>{`stash@{${s.index}}`}</b>
                  <code className="rurl" title={s.message}>{s.message}</code>
                </div>
                <button className="mini" title="적용 후 삭제(pop)" disabled={busy} onClick={() => act(() => api.gitStashPop(projectDir, s.index), "stash pop", false)}>불러오기</button>
                <button className="mini" title="적용(유지)" disabled={busy} onClick={() => act(() => api.gitStashApply(projectDir, s.index), "stash apply", false)}>적용</button>
                <button className="del" title="삭제" onClick={() => confirm(`stash@{${s.index}} 삭제?`) && act(() => api.gitStashDrop(projectDir, s.index), "stash drop")}>×</button>
              </li>
            ))}
          </ul>

          <h3 style={{ marginTop: 14 }}>Remotes</h3>
          <ul className="gitfiles">
            {remotes.length === 0 && <li className="hint tiny">원격 없음</li>}
            {remotes.map(([name, url]) => (
              <li key={name} className="remote">
                <div className="rinfo">
                  <b>{name}</b>
                  <code className="rurl" title={url}>{url}</code>
                </div>
                <button
                  className="mini"
                  title="이 원격으로 push (-u)"
                  disabled={busy}
                  onClick={() => status && act(() => api.gitPushUpstream(projectDir, name, status.branch), `push→${name}`)}
                >
                  ↑
                </button>
                <button className="del" title="원격 제거" onClick={() => confirm(`원격 '${name}' 제거?`) && act(() => api.gitRemoveRemote(projectDir, name), "remove remote")}>×</button>
              </li>
            ))}
          </ul>
          <input value={rName} onChange={(e) => setRName(e.target.value)} placeholder="이름 (origin)" style={{ width: "100%", marginBottom: 4 }} />
          <div className="row">
            <input value={rUrl} onChange={(e) => setRUrl(e.target.value)} placeholder="https://github.com/user/repo.git" style={{ flex: 1, minWidth: 0 }} />
            <button
              disabled={!rName.trim() || !rUrl.trim()}
              onClick={() => act(() => api.gitAddRemote(projectDir, rName.trim(), rUrl.trim()), "add remote").then(() => setRUrl(""))}
            >
              연결
            </button>
          </div>

          <h3 style={{ marginTop: 14 }}>Branches</h3>
          <ul className="gitfiles">
            {branches.map((b) => (
              <li key={b} className={b === status?.branch ? "branch cur" : "branch"}>
                <span className="bname" onClick={() => b !== status?.branch && act(() => api.gitCheckout(projectDir, b, false), `checkout ${b}`, false)}>
                  {b === status?.branch ? "● " : "○ "}{b}
                </span>
                {b !== status?.branch && (
                  <button className="del" title="브랜치 삭제" onClick={() => confirm(`'${b}' 삭제?`) && act(() => api.gitDeleteBranch(projectDir, b), `delete ${b}`)}>×</button>
                )}
              </li>
            ))}
          </ul>
          <div className="row" style={{ marginTop: 8 }}>
            <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} placeholder="새 브랜치" style={{ flex: 1, minWidth: 0 }} />
            <button
              disabled={!newBranch.trim()}
              onClick={() => act(() => api.gitCheckout(projectDir, newBranch.trim(), true), `create ${newBranch}`, false).then(() => setNewBranch(""))}
            >
              ＋
            </button>
          </div>
        </div>

        {/* 변경 사항(스테이지/언스테이지) */}
        <div className="gitchanges">
          <div className="changesec">
            <h3>
              Unstaged ({unstaged.length})
              {unstaged.length > 0 && (
                <button className="mini" onClick={() => act(() => api.gitStageAll(projectDir), "stage all")}>모두 +</button>
              )}
            </h3>
            <ul className="gitfiles">
              {unstaged.length === 0 && <li className="hint">없음</li>}
              {unstaged.map((f) => (
                <li key={"u" + f.path} className={sel?.path === f.path && !sel?.staged ? "gfile sel" : "gfile"}>
                  <code className={`gstat ${isUntracked(f) ? "new" : ""}`}>{isUntracked(f) ? "??" : f.status[1] === " " ? " M" : " " + f.status[1]}</code>
                  <span className="fpath" onClick={() => selectFile(f, false)}>{f.path}</span>
                  <button className="mini" title="stage" onClick={() => act(() => api.gitStage(projectDir, f.path), "stage")}>+</button>
                  <button className="del" title="discard" onClick={() => confirm(`'${f.path}' 변경을 버릴까요?`) && act(() => api.gitDiscard(projectDir, f.path, isUntracked(f)), "discard", false)}>⨯</button>
                </li>
              ))}
            </ul>
          </div>

          <div className="changesec">
            <h3>Staged ({staged.length})</h3>
            <ul className="gitfiles">
              {staged.length === 0 && <li className="hint">없음</li>}
              {staged.map((f) => (
                <li key={"s" + f.path} className={sel?.path === f.path && sel?.staged ? "gfile sel" : "gfile"}>
                  <code className="gstat staged">{f.status[0]}</code>
                  <span className="fpath" onClick={() => selectFile(f, true)}>{f.path}</span>
                  <button className="mini" title="unstage" onClick={() => act(() => api.gitUnstage(projectDir, f.path), "unstage")}>−</button>
                </li>
              ))}
            </ul>
          </div>

          <div className="commitbox">
            <input
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder={`${staged.length}개 스테이지됨 · 커밋 메시지`}
              onKeyDown={(e) => e.key === "Enter" && commitMsg.trim() && act(() => api.gitCommit(projectDir, commitMsg), "commit", false).then(() => setCommitMsg(""))}
            />
            <button
              className="active"
              disabled={busy || !commitMsg.trim() || staged.length === 0}
              onClick={() => act(() => api.gitCommit(projectDir, commitMsg), "commit", false).then(() => setCommitMsg(""))}
            >
              Commit
            </button>
          </div>
        </div>

        {/* diff 뷰 */}
        <div className="gitdiff">
          <h3>{sel ? `${sel.staged ? "Staged" : "Unstaged"} · ${sel.path}` : "Diff"}</h3>
          {!sel ? (
            <p className="hint">파일을 선택하면 변경 내용을 표시합니다.</p>
          ) : (
            <DiffView text={diff} />
          )}
        </div>
      </div>

      {/* 히스토리 (로그 / 그래프) — 상단 손잡이로 높이 조절 */}
      <Resizer axis="y" onDelta={(d) => setHistH((h) => h - d)} />
      <div className="githistory" style={{ height: histH, flex: "none" }}>
        <div className="histhead">
          <h3>History</h3>
          <div className="histtoggle">
            <button className={histView === "log" ? "active" : ""} onClick={() => setHistView("log")}>로그</button>
            <button className={histView === "graph" ? "active" : ""} onClick={() => setHistView("graph")}>그래프</button>
          </div>
        </div>
        {histView === "log" ? (
          <ul className="gitfiles">
            {log.length === 0 && <li className="hint">커밋 없음</li>}
            {log.map((c) => (
              <li key={c.hash}>
                <code className="chash">{c.hash}</code>
                <span className="csub">{c.subject}</span>
                <span className="sum">{c.author} · {c.date}</span>
              </li>
            ))}
          </ul>
        ) : (
          <GitGraph commits={graphData} />
        )}
      </div>
    </div>
  );
}

function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <p className="hint">변경 없음 (또는 바이너리)</p>;
  return (
    <pre className="diffview">
      {text.split("\n").map((line, i) => {
        let cls = "dl";
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "dl add";
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "dl del";
        else if (line.startsWith("@@")) cls = "dl hunk";
        else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")) cls = "dl meta";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
