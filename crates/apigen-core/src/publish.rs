//! Redoc 문서 공유 (자체 완결 HTML / GitHub Pages).
//!
//! 두 가지 공유 경로:
//! 1. **단일 HTML 내보내기** — Redoc JS를 **인라인**한 완전 자립형 `.html` 1개.
//!    인터넷 없이 어디서든 열리고, 파일 전송·정적 호스트 업로드만으로 공유된다.
//! 2. **GitHub Pages** — 같은 인라인 HTML을 `<root>/docs/index.html`로 쓰고
//!    (선택) git add/commit/push까지 한 번에 → `https://<user>.github.io/<repo>/`.
//!
//! Redoc 번들은 빌드 시 바이너리에 임베드(`include_str!`)되므로 CDN·네트워크에
//! 의존하지 않는다(오프라인·사내망 차단 환경에서도 안전).

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{CoreError, Result};

/// 앱에 동봉된 Redoc standalone 번들(오프라인 인라인용).
const REDOC_JS: &str = include_str!("../assets/redoc.standalone.js");
/// 앱에 동봉된 Swagger UI 번들·CSS(오프라인 인라인용).
const SWAGGER_JS: &str = include_str!("../assets/swagger-ui-bundle.js");
const SWAGGER_CSS: &str = include_str!("../assets/swagger-ui.css");

/// Redoc 문서 HTML을 생성한다.
/// `inline=true`면 번들 JS를 통째로 인라인(오프라인·자립형),
/// `inline=false`면 CDN `<script src>`만 참조(경량, 온라인 필요).
pub fn render_redoc_html(spec_json: &str, title: &str, inline: bool) -> String {
    // `</script>` 조기 종료 방지(스펙 JSON·번들 양쪽).
    let safe_spec = spec_json.replace("</", "<\\/");
    let title = html_escape(title);
    let script = if inline {
        format!("<script>{}</script>", REDOC_JS.replace("</script", "<\\/script"))
    } else {
        "<script src=\"https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js\"></script>".to_string()
    };
    format!(
        r#"<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>{title}</title>
  <style>body{{margin:0}}</style>
</head>
<body>
  <div id="redoc"></div>
  <script>window.__SPEC__ = {safe_spec};</script>
  {script}
  <script>Redoc.init(window.__SPEC__, {{}}, document.getElementById('redoc'));</script>
</body>
</html>"#
    )
}

/// Swagger UI 문서 HTML을 생성한다(인라인=오프라인 자립형, 아니면 CDN).
pub fn render_swagger_html(spec_json: &str, title: &str, inline: bool) -> String {
    let safe_spec = spec_json.replace("</", "<\\/");
    let title = html_escape(title);
    let (css, js) = if inline {
        (
            format!("<style>{SWAGGER_CSS}</style>"),
            format!("<script>{}</script>", SWAGGER_JS.replace("</script", "<\\/script")),
        )
    } else {
        (
            "<link rel=\"stylesheet\" href=\"https://unpkg.com/swagger-ui-dist/swagger-ui.css\"/>".to_string(),
            "<script src=\"https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js\"></script>".to_string(),
        )
    };
    format!(
        r#"<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>{title}</title>
  {css}
  <style>body{{margin:0}}</style>
</head>
<body>
  <div id="swagger"></div>
  <script>window.__SPEC__ = {safe_spec};</script>
  {js}
  <script>window.ui = SwaggerUIBundle({{ spec: window.__SPEC__, dom_id: '#swagger', tryItOutEnabled: true }});</script>
</body>
</html>"#
    )
}

/// 문서 뷰어 종류.
#[derive(Clone, Copy)]
pub enum Viewer {
    Redoc,
    Swagger,
}
impl Viewer {
    pub fn parse(s: &str) -> Self {
        if s.eq_ignore_ascii_case("swagger") { Viewer::Swagger } else { Viewer::Redoc }
    }
    fn name(self) -> &'static str {
        match self { Viewer::Redoc => "Redoc", Viewer::Swagger => "Swagger" }
    }
    /// GitHub Pages 파일명(둘을 함께 배포할 수 있게 분리).
    fn pages_file(self) -> &'static str {
        match self { Viewer::Redoc => "index.html", Viewer::Swagger => "swagger.html" }
    }
    fn render(self, spec_json: &str, title: &str, inline: bool) -> String {
        match self {
            Viewer::Redoc => render_redoc_html(spec_json, title, inline),
            Viewer::Swagger => render_swagger_html(spec_json, title, inline),
        }
    }
}

/// 자체 완결(인라인) 문서 HTML을 지정 경로에 쓴다. `.html`로 보정. 생성 경로 반환.
pub fn write_standalone_html(dest: &Path, spec_json: &str, title: &str, viewer: Viewer) -> Result<PathBuf> {
    let html = viewer.render(spec_json, title, true);
    let path = if dest.extension().map(|e| e.eq_ignore_ascii_case("html")).unwrap_or(false) {
        dest.to_path_buf()
    } else {
        dest.with_extension("html")
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, html)?;
    Ok(path)
}

/// GitHub Pages용 인라인 문서 HTML을 `<root>/docs/`에 쓴다(Redoc=index.html, Swagger=swagger.html).
pub fn write_pages_html(root: &Path, spec_json: &str, title: &str, viewer: Viewer) -> Result<PathBuf> {
    let docs = root.join("docs");
    std::fs::create_dir_all(&docs)?;
    let path = docs.join(viewer.pages_file());
    std::fs::write(&path, viewer.render(spec_json, title, true))?;
    Ok(path)
}

/// 원클릭 배포: docs 파일 생성 → git add·commit·push 를 한 번에.
/// 리포·리모트·인증 구성이 전제. 각 단계 결과를 사람이 읽을 요약으로 반환.
pub fn publish_pages(root: &Path, spec_json: &str, title: &str, message: &str, viewer: Viewer) -> Result<String> {
    let path = write_pages_html(root, spec_json, title, viewer)?;
    let file = viewer.pages_file();
    let mut log = format!("{} 문서 docs/{} 생성 ({} bytes)\n", viewer.name(), file, std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0));

    run(root, &["add", "docs"])?;
    log.push_str("git add docs ✓\n");

    match run(root, &["commit", "-m", message]) {
        Ok(_) => log.push_str("git commit ✓\n"),
        Err(_) => log.push_str("git commit: 변경 없음(스킵)\n"),
    }

    let push = run(root, &["push"])?;
    log.push_str("git push ✓\n");
    if !push.trim().is_empty() {
        log.push_str(push.trim());
        log.push('\n');
    }
    let url_tail = if matches!(viewer, Viewer::Swagger) { "swagger.html" } else { "" };
    log.push_str(&format!("→ Settings ▸ Pages(‘docs’)가 켜져 있으면 https://<user>.github.io/<repo>/{url_tail} 에 노출됩니다."));
    Ok(log)
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn run(root: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| CoreError::Project(format!("git 실행 실패: {e}")))?;
    if !out.status.success() {
        return Err(CoreError::Project(format!(
            "git {:?} 실패: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_html_is_self_contained() {
        let html = render_redoc_html(r#"{"openapi":"3.0.3"}"#, "My API", true);
        assert!(html.contains("Redoc.init"));
        // 인라인이므로 외부 스크립트 로드(<script src>)가 없어야 한다.
        // (번들 내부 문자열로 cdn.redoc.ly가 등장할 수는 있으므로 src= 태그로 검사.)
        assert!(!html.contains("src=\"https://cdn.redoc.ly"), "should not load CDN script when inlined");
        // 번들 코드가 실제로 들어있어야 한다(파일 크기가 큼).
        assert!(html.len() > 500_000, "inlined bundle should make the file large");
        assert!(html.contains("<title>My API</title>"));
    }

    #[test]
    fn cdn_html_is_light() {
        let html = render_redoc_html(r#"{"openapi":"3.0.3"}"#, "T", false);
        assert!(html.contains("cdn.redoc.ly"));
        assert!(html.len() < 10_000);
    }

    #[test]
    fn swagger_html_is_self_contained() {
        let html = render_swagger_html(r#"{"openapi":"3.0.3"}"#, "My API", true);
        assert!(html.contains("SwaggerUIBundle"));
        assert!(!html.contains("src=\"https://unpkg.com"), "no CDN script when inlined");
        assert!(html.len() > 1_000_000, "inlined swagger bundle+css is large");
    }

    #[test]
    fn writes_standalone_and_pages() {
        let dir = tempfile::tempdir().unwrap();
        let p1 = write_standalone_html(&dir.path().join("api-docs"), r#"{"openapi":"3.0.3"}"#, "T", Viewer::Redoc).unwrap();
        assert_eq!(p1.extension().unwrap(), "html");
        assert!(p1.is_file());

        let p2 = write_pages_html(dir.path(), r#"{"openapi":"3.0.3"}"#, "T", Viewer::Redoc).unwrap();
        assert!(p2.ends_with("docs/index.html") || p2.ends_with("docs\\index.html"));
        assert!(std::fs::read_to_string(&p2).unwrap().contains("Redoc.init"));

        // Swagger는 swagger.html로 별도 배포.
        let p3 = write_pages_html(dir.path(), r#"{"openapi":"3.0.3"}"#, "T", Viewer::Swagger).unwrap();
        assert!(p3.ends_with("docs/swagger.html") || p3.ends_with("docs\\swagger.html"));
        assert!(std::fs::read_to_string(&p3).unwrap().contains("SwaggerUIBundle"));
    }
}
