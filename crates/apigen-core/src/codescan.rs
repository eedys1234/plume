//! 로컬 리포지토리 소스 수집(AI 코드 분석·생성용).
//! 지정 폴더를 재귀 순회하며 코드 파일만 골라 크기 상한까지 하나의 텍스트로 모은다
//! (파일 경로 헤더 포함). LLM 컨텍스트 한계 때문에 상한을 넘으면 잘라내고 truncated 표시.

use crate::CoreError;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

// 순회에서 건너뛸 디렉터리(빌드 산출물·의존성·VCS 등). 숨김 디렉터리(.*)도 전부 건너뛴다.
const IGNORE_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", "bin", "obj",
    "vendor", "coverage", "__pycache__", "venv", "Pods",
];

// 개별 파일 크기 상한(생성된 번들·미니파이 파일 제외).
const MAX_FILE_BYTES: u64 = 400_000;
// 재귀 깊이 상한(심링크 루프 방지).
const MAX_DEPTH: usize = 25;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBundle {
    pub text: String,
    pub file_count: usize,
    pub total_bytes: usize,
    pub truncated: bool,
    pub included: Vec<String>, // 포함된 파일(상대경로)
}

/// `dir` 아래 코드 파일을 모아 하나의 텍스트로. `exts`는 허용 확장자(점 유무 무관).
pub fn collect_source(dir: &Path, max_bytes: usize, exts: &[String]) -> Result<SourceBundle, CoreError> {
    if !dir.is_dir() {
        return Err(CoreError::Project(format!("폴더가 아닙니다: {}", dir.display())));
    }
    let allow: HashSet<String> = exts.iter().map(|e| e.trim().trim_start_matches('.').to_lowercase()).filter(|e| !e.is_empty()).collect();

    let mut files: Vec<PathBuf> = Vec::new();
    walk(dir, &allow, 0, &mut files);
    files.sort();

    let mut out = String::new();
    let mut included = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;

    for f in &files {
        if total >= max_bytes { truncated = true; break; }
        let Ok(content) = std::fs::read_to_string(f) else { continue }; // 바이너리/비-UTF8 무시
        let rel = f.strip_prefix(dir).unwrap_or(f).to_string_lossy().replace('\\', "/");
        let header = format!("\n// ==================== {rel} ====================\n");
        let remaining = max_bytes.saturating_sub(total);
        if header.len() + content.len() + 1 > remaining {
            // 남은 예산만큼만 넣고 종료.
            truncated = true;
            let mut take = remaining.saturating_sub(header.len() + 16).min(content.len());
            while take > 0 && !content.is_char_boundary(take) { take -= 1; }
            if take < 200 { break; } // 너무 적으면 이 파일은 생략
            out.push_str(&header);
            out.push_str(&content[..take]);
            out.push_str("\n… (파일 일부 생략)\n");
            included.push(rel);
            total = max_bytes;
            break;
        }
        out.push_str(&header);
        out.push_str(&content);
        out.push('\n');
        total += header.len() + content.len() + 1;
        included.push(rel);
    }

    Ok(SourceBundle { text: out, file_count: included.len(), total_bytes: total, truncated, included })
}

fn walk(dir: &Path, allow: &HashSet<String>, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH { return; }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if name.starts_with('.') || IGNORE_DIRS.contains(&name.as_str()) { continue; }
            walk(&p, allow, depth + 1, out);
        } else if ft.is_file() {
            if let Ok(md) = e.metadata() { if md.len() > MAX_FILE_BYTES { continue; } }
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
            if allow.contains(&ext) { out.push(p); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn collects_filtered_and_respects_cap() {
        let tmp = std::env::temp_dir().join(format!("plume_scan_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src")).unwrap();
        fs::create_dir_all(tmp.join("node_modules")).unwrap();
        fs::write(tmp.join("src/a.rs"), "fn a() {}\n").unwrap();
        fs::write(tmp.join("src/b.ts"), "export const b = 1;\n").unwrap();
        fs::write(tmp.join("src/skip.png"), "binary").unwrap();          // 확장자 제외
        fs::write(tmp.join("node_modules/dep.js"), "should skip").unwrap(); // 무시 폴더

        let exts = vec!["rs".into(), "ts".into()];
        let b = collect_source(&tmp, 1_000_000, &exts).unwrap();
        assert_eq!(b.file_count, 2, "rs+ts 2개만");
        assert!(b.text.contains("fn a()") && b.text.contains("export const b"));
        assert!(!b.text.contains("should skip"), "node_modules 제외");
        assert!(b.included.iter().any(|p| p == "src/a.rs"));

        // 아주 작은 상한 → truncated
        let small = collect_source(&tmp, 40, &exts).unwrap();
        assert!(small.truncated, "상한 초과 시 truncated");
        let _ = fs::remove_dir_all(&tmp);
    }
}
