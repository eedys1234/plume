//! Git 연동 — 프로젝트 디렉토리에서 `git` CLI를 실행한다.
//!
//! 데스크톱 앱이 로컬 git 저장소(파일 트리 프로젝트)를 다루므로, 상태·스테이징·
//! 커밋·푸시/풀·로그·브랜치를 얇게 감싼다. 인증/원격은 사용자의 git 구성에 의존.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::error::{CoreError, Result};

/// git `Command`를 만든다. **Windows에서는 CREATE_NO_WINDOW**를 지정해
/// git 호출마다 콘솔(Terminal) 창이 뜨는 것을 막는다(성능·UX 문제).
pub(crate) fn git_command() -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn run(root: &Path, args: &[&str]) -> Result<String> {
    let out = git_command()
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| CoreError::Project(format!("git 실행 실패: {e}")))?;
    if !out.status.success() {
        return Err(CoreError::Project(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[derive(Debug, Serialize)]
pub struct FileStatus {
    /// porcelain 2글자 코드(예: " M", "??", "A ").
    pub status: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct Commit {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

/// 시각적 그래프용 커밋(부모·refs 포함).
#[derive(Debug, Serialize)]
pub struct GraphCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub files: Vec<FileStatus>,
    pub ahead: u32,
    pub behind: u32,
}

/// 현재 상태(브랜치 + 변경 파일). git 저장소가 아니면 is_repo=false.
pub fn status(root: &Path) -> Result<GitStatus> {
    if run(root, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(GitStatus { is_repo: false, branch: String::new(), files: vec![], ahead: 0, behind: 0 });
    }
    let branch = run(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();

    let porcelain = run(root, &["status", "--porcelain"])?;
    let files = porcelain
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| FileStatus {
            status: l.get(0..2).unwrap_or("").to_string(),
            path: l.get(3..).unwrap_or("").to_string(),
        })
        .collect();

    // ahead/behind (원격 추적 브랜치가 있을 때만)
    let (ahead, behind) = run(root, &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
        .ok()
        .and_then(|s| {
            let mut it = s.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .unwrap_or((0, 0));

    Ok(GitStatus { is_repo: true, branch, files, ahead: behind, behind: ahead })
    // 주: rev-list --left-right count는 [behind ahead] 순서라 뒤집어 담음.
}

pub fn log(root: &Path, n: usize) -> Result<Vec<Commit>> {
    let out = run(
        root,
        &["log", &format!("-n{n}"), "--pretty=format:%h\x1f%an\x1f%ad\x1f%s", "--date=short"],
    )?;
    Ok(out
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let p: Vec<&str> = l.split('\x1f').collect();
            Commit {
                hash: p.first().unwrap_or(&"").to_string(),
                author: p.get(1).unwrap_or(&"").to_string(),
                date: p.get(2).unwrap_or(&"").to_string(),
                subject: p.get(3).unwrap_or(&"").to_string(),
            }
        })
        .collect())
}

pub fn init(root: &Path) -> Result<String> {
    run(root, &["init"])
}
pub fn stage_all(root: &Path) -> Result<()> {
    run(root, &["add", "-A"]).map(|_| ())
}

/// 개별 파일 스테이징.
pub fn stage(root: &Path, path: &str) -> Result<()> {
    run(root, &["add", "--", path]).map(|_| ())
}
/// 개별 파일 언스테이징(index → worktree).
pub fn unstage(root: &Path, path: &str) -> Result<()> {
    run(root, &["reset", "-q", "HEAD", "--", path]).map(|_| ())
}
/// 변경 되돌리기. untracked면 파일 삭제(clean), 아니면 checkout으로 복원.
pub fn discard(root: &Path, path: &str, untracked: bool) -> Result<()> {
    if untracked {
        run(root, &["clean", "-f", "--", path]).map(|_| ())
    } else {
        run(root, &["checkout", "--", path]).map(|_| ())
    }
}
/// 원격에서 가져오기(병합 없음).
pub fn fetch(root: &Path) -> Result<String> {
    run(root, &["fetch", "--all"])
}
/// 브랜치 삭제(강제).
pub fn delete_branch(root: &Path, name: &str) -> Result<()> {
    run(root, &["branch", "-D", name]).map(|_| ())
}

/// 파일 하나의 diff. staged면 --cached. untracked면 전체 내용을 added로.
pub fn diff_file(root: &Path, path: &str, staged: bool) -> Result<String> {
    if staged {
        return run(root, &["diff", "--cached", "--", path]);
    }
    let d = run(root, &["diff", "--", path])?;
    if !d.trim().is_empty() {
        return Ok(d);
    }
    // untracked 가능성 → --no-index (diff 있으면 exit 1이므로 stdout만 취함)
    let out = git_command()
        .args(["diff", "--no-index", "--", "/dev/null", path])
        .current_dir(root)
        .output()
        .map_err(|e| CoreError::Project(format!("git diff 실패: {e}")))?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
pub fn commit(root: &Path, message: &str) -> Result<String> {
    run(root, &["commit", "-m", message])
}
pub fn push(root: &Path) -> Result<String> {
    run(root, &["push"])
}
pub fn pull(root: &Path) -> Result<String> {
    run(root, &["pull", "--ff-only"])
}

/// git stash 항목.
#[derive(Debug, Serialize)]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
}

/// 변경사항을 stash에 저장. message 비면 기본 메시지.
pub fn stash_save(root: &Path, message: &str, include_untracked: bool) -> Result<String> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("-u");
    }
    if !message.trim().is_empty() {
        args.push("-m");
        args.push(message);
    }
    run(root, &args)
}
/// stash 목록. `stash@{i}: <메시지>` 파싱.
pub fn stash_list(root: &Path) -> Result<Vec<StashEntry>> {
    let out = run(root, &["stash", "list"])?;
    let mut v = vec![];
    for (i, line) in out.lines().enumerate() {
        let msg = line.splitn(2, ": ").nth(1).unwrap_or(line).trim().to_string();
        v.push(StashEntry { index: i, message: msg });
    }
    Ok(v)
}
/// stash 적용 후 삭제(pop).
pub fn stash_pop(root: &Path, index: usize) -> Result<String> {
    run(root, &["stash", "pop", &format!("stash@{{{index}}}")])
}
/// stash 적용(유지).
pub fn stash_apply(root: &Path, index: usize) -> Result<String> {
    run(root, &["stash", "apply", &format!("stash@{{{index}}}")])
}
/// stash 삭제.
pub fn stash_drop(root: &Path, index: usize) -> Result<String> {
    run(root, &["stash", "drop", &format!("stash@{{{index}}}")])
}
pub fn diff(root: &Path) -> Result<String> {
    run(root, &["diff"])
}
/// ASCII 커밋 그래프(모든 브랜치). `git log --graph --oneline --decorate --all`.
pub fn graph(root: &Path, n: usize) -> Result<String> {
    run(root, &["log", "--graph", "--oneline", "--decorate", "--all", &format!("-n{n}")])
}

/// 시각적 그래프용 커밋 데이터: 부모 해시·refs 포함(모든 브랜치, topo 순서).
pub fn graph_data(root: &Path, n: usize) -> Result<Vec<GraphCommit>> {
    // %H 전체해시 · %P 부모(공백구분) · %D refs · %an · %ad · %s
    let out = run(
        root,
        &[
            "log",
            "--all",
            "--topo-order",
            "--date=short",
            &format!("-n{n}"),
            "--pretty=format:%H\x1f%P\x1f%D\x1f%an\x1f%ad\x1f%s",
        ],
    )?;
    Ok(out
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let p: Vec<&str> = l.split('\x1f').collect();
            GraphCommit {
                hash: p.first().unwrap_or(&"").to_string(),
                parents: p
                    .get(1)
                    .map(|s| s.split_whitespace().map(String::from).collect())
                    .unwrap_or_default(),
                refs: p
                    .get(2)
                    .map(|s| s.split(',').map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect())
                    .unwrap_or_default(),
                author: p.get(3).unwrap_or(&"").to_string(),
                date: p.get(4).unwrap_or(&"").to_string(),
                subject: p.get(5).unwrap_or(&"").to_string(),
            }
        })
        .collect())
}
pub fn branches(root: &Path) -> Result<Vec<String>> {
    let out = run(root, &["branch", "--format=%(refname:short)"])?;
    Ok(out.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}
pub fn checkout(root: &Path, branch: &str, create: bool) -> Result<String> {
    if create {
        run(root, &["checkout", "-b", branch])
    } else {
        run(root, &["checkout", branch])
    }
}

// ─────────────────────────── 원격 저장소 ───────────────────────────

/// 원격 목록 (name, url). `git remote -v` 파싱.
pub fn remotes(root: &Path) -> Result<Vec<(String, String)>> {
    let out = run(root, &["remote", "-v"])?;
    let mut map = std::collections::BTreeMap::<String, String>::new();
    for line in out.lines() {
        let mut it = line.split_whitespace();
        if let (Some(name), Some(url)) = (it.next(), it.next()) {
            map.entry(name.to_string()).or_insert_with(|| url.to_string());
        }
    }
    Ok(map.into_iter().collect())
}
pub fn add_remote(root: &Path, name: &str, url: &str) -> Result<()> {
    run(root, &["remote", "add", name, url]).map(|_| ())
}
pub fn remove_remote(root: &Path, name: &str) -> Result<()> {
    run(root, &["remote", "remove", name]).map(|_| ())
}
pub fn set_remote_url(root: &Path, name: &str, url: &str) -> Result<()> {
    run(root, &["remote", "set-url", name, url]).map(|_| ())
}
/// 현재 브랜치를 원격에 upstream 설정하며 push (첫 push).
pub fn push_upstream(root: &Path, remote: &str, branch: &str) -> Result<String> {
    run(root, &["push", "-u", remote, branch])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_repo_reports_not_repo() {
        let dir = tempfile::tempdir().unwrap();
        let st = status(dir.path()).unwrap();
        assert!(!st.is_repo);
    }

    #[test]
    fn stage_unstage_commit_diff_flow() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init(p).unwrap();
        run(p, &["config", "user.email", "t@example.com"]).unwrap();
        run(p, &["config", "user.name", "Tester"]).unwrap();

        std::fs::write(p.join("f.txt"), "line1\n").unwrap();

        // stage → 인덱스에 A
        stage(p, "f.txt").unwrap();
        assert!(status(p).unwrap().files.iter().any(|f| f.path == "f.txt" && f.status.starts_with('A')));

        // unstage → 다시 untracked
        unstage(p, "f.txt").unwrap();
        assert!(status(p).unwrap().files.iter().any(|f| f.path == "f.txt" && f.status.contains('?')));

        // stage + commit → 로그 1개
        stage(p, "f.txt").unwrap();
        commit(p, "init commit").unwrap();
        let lg = log(p, 5).unwrap();
        assert_eq!(lg.len(), 1);
        assert_eq!(lg[0].subject, "init commit");

        // 수정 후 diff에 +line2
        std::fs::write(p.join("f.txt"), "line1\nline2\n").unwrap();
        let d = diff_file(p, "f.txt", false).unwrap();
        assert!(d.contains("+line2"), "diff: {d}");

        // discard → 원복
        discard(p, "f.txt", false).unwrap();
        assert!(status(p).unwrap().files.is_empty(), "discard 후 clean 이어야 함");
    }

    #[test]
    fn stash_save_list_pop_flow() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init(p).unwrap();
        run(p, &["config", "user.email", "t@example.com"]).unwrap();
        run(p, &["config", "user.name", "Tester"]).unwrap();
        std::fs::write(p.join("f.txt"), "v1\n").unwrap();
        stage(p, "f.txt").unwrap();
        commit(p, "c1").unwrap();

        // 변경 후 stash → clean
        std::fs::write(p.join("f.txt"), "v2\n").unwrap();
        stash_save(p, "wip", false).unwrap();
        assert!(status(p).unwrap().files.is_empty(), "stash 후 clean");
        let list = stash_list(p).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].message.contains("wip"));

        // pop → 변경 복원 + stash 비움
        stash_pop(p, 0).unwrap();
        // Windows git의 autocrlf로 \r\n 될 수 있어 줄바꿈 정규화 후 비교.
        assert_eq!(
            std::fs::read_to_string(p.join("f.txt")).unwrap().replace("\r\n", "\n"),
            "v2\n"
        );
        assert!(stash_list(p).unwrap().is_empty(), "pop 후 stash 없음");
    }

    #[test]
    fn init_and_status_detects_untracked() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path()).unwrap();
        std::fs::write(dir.path().join("a.txt"), "hi").unwrap();
        let st = status(dir.path()).unwrap();
        assert!(st.is_repo);
        assert!(st.files.iter().any(|f| f.path == "a.txt" && f.status.contains('?')));
        // 스테이징 후 상태 코드 변화
        stage_all(dir.path()).unwrap();
        let st2 = status(dir.path()).unwrap();
        assert!(st2.files.iter().any(|f| f.path == "a.txt" && f.status.starts_with('A')));
    }
}
