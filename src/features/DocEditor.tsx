// 요청 문서(Info) 에디터 — 게시판식 Markdown 작성 + Rich Text(미리보기) 토글.
// 툴바 버튼은 선택 영역에 Markdown 서식을 넣는다(굵게·제목·목록·링크·표·코드…).
// 내용은 op.description(OpenAPI의 CommonMark 필드)에 저장 → Specification 문서에도 그대로 반영.
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const TABLE_TMPL = "\n| 헤더 1 | 헤더 2 |\n| --- | --- |\n| 셀 | 셀 |\n";
const CODEBLOCK_TMPL = "\n```\n코드\n```\n";

export function DocEditor({ value, onChange, placeholder, aiDraft }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** 제공되면 툴바에 "✨ AI 초안" 버튼이 뜨고, 반환한 Markdown으로 내용을 채운다. */
  aiDraft?: () => Promise<string>;
}) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  async function runAi() {
    if (!aiDraft) return;
    setAiBusy(true); setAiErr("");
    try {
      const md = (await aiDraft()).trim();
      if (md) { onChange(md); setMode("preview"); }
      else setAiErr("빈 응답을 받았습니다.");
    } catch (e: any) {
      setAiErr(e?.message ?? String(e));
    } finally { setAiBusy(false); }
  }

  const restore = (start: number, end: number) =>
    requestAnimationFrame(() => { const ta = ref.current; if (!ta) return; ta.focus(); ta.selectionStart = start; ta.selectionEnd = end; });

  // 선택 텍스트를 prefix/suffix로 감싸기(없으면 placeholder 삽입).
  function wrap(prefix: string, suffix: string, ph: string) {
    const ta = ref.current; if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = value.slice(s, e) || ph;
    onChange(value.slice(0, s) + prefix + sel + suffix + value.slice(e));
    restore(s + prefix.length, s + prefix.length + sel.length);
  }
  // 선택된 각 줄 앞에 prefix(제목·목록·인용).
  function linePrefix(prefix: string) {
    const ta = ref.current; if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const block = value.slice(lineStart, e);
    const replaced = block.length ? block.split("\n").map((l) => prefix + l).join("\n") : prefix;
    onChange(value.slice(0, lineStart) + replaced + value.slice(e));
    restore(lineStart, lineStart + replaced.length);
  }
  // 커서 위치에 블록 삽입(표·코드블록).
  function insert(text: string) {
    const ta = ref.current; if (!ta) return;
    const s = ta.selectionStart;
    onChange(value.slice(0, s) + text + value.slice(s));
    restore(s + text.length, s + text.length);
  }

  return (
    <div className="doceditor">
      <div className="doctoolbar">
        <button type="button" title="제목 (H2)" onClick={() => linePrefix("## ")}><b>H</b></button>
        <button type="button" title="굵게" onClick={() => wrap("**", "**", "굵게")}><b>B</b></button>
        <button type="button" title="기울임" style={{ fontStyle: "italic" }} onClick={() => wrap("*", "*", "기울임")}>I</button>
        <button type="button" title="취소선" style={{ textDecoration: "line-through" }} onClick={() => wrap("~~", "~~", "취소선")}>S</button>
        <button type="button" title="인라인 코드" onClick={() => wrap("`", "`", "code")}>{"<>"}</button>
        <span className="docsep" />
        <button type="button" title="글머리 목록" onClick={() => linePrefix("- ")}>•</button>
        <button type="button" title="번호 목록" onClick={() => linePrefix("1. ")}>1.</button>
        <button type="button" title="인용" onClick={() => linePrefix("> ")}>❝</button>
        <span className="docsep" />
        <button type="button" title="링크" onClick={() => wrap("[", "](https://)", "링크")}>🔗</button>
        <button type="button" title="표" onClick={() => insert(TABLE_TMPL)}>▦</button>
        <button type="button" title="코드 블록" onClick={() => insert(CODEBLOCK_TMPL)}>{"{ }"}</button>
        {aiDraft && (
          <button type="button" className="docai" title="AI로 문서 초안 작성" disabled={aiBusy} onClick={runAi}>
            {aiBusy ? "생성 중…" : "✨ AI 초안"}
          </button>
        )}
        <span className="spacer" />
        <div className="docmodetoggle">
          <button type="button" className={mode === "write" ? "active" : ""} onClick={() => setMode("write")}>Markdown</button>
          <button type="button" className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>Rich Text</button>
        </div>
      </div>
      {aiErr && <div className="docaierr">⚠ {aiErr}</div>}
      {mode === "write" ? (
        <textarea
          ref={ref}
          className="docedit"
          rows={14}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "이 요청에 대한 설명·사용법을 Markdown으로 작성하세요. 상단 버튼으로 서식을 넣을 수 있습니다."}
        />
      ) : (
        <div className="mdpreview docpreview">
          {value.trim()
            ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
            : <p className="hint tiny">내용이 없습니다 · Markdown 탭에서 작성하세요.</p>}
        </div>
      )}
    </div>
  );
}
