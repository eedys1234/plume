// AI 코드 분석·생성: 로컬 리포 폴더의 소스를 수집 → 지시문과 함께 LLM에 전달 → 결과 생성.
// 프리셋(OpenAPI 스펙 / API 문서 / 직접 입력) + 지시문 자유 입력. OpenAPI 결과는 컬렉션으로 가져오기.
import { useState } from "react";
import { pickDirectory } from "../dialog";
import { api } from "../ipc";
import { useStore, basename } from "../store";
import { callAI, aiConfigured, loadAi, PROVIDER_LABELS } from "./aiConfig";

const DEFAULT_EXTS = "rs,ts,tsx,js,jsx,py,java,kt,go,rb,php,cs,cpp,c,h,scala,swift,graphql,proto,yaml,yml,sql";

type Preset = "openapi" | "docs" | "custom";
const PRESETS: Record<Preset, { label: string; instruction: string; system: string; kind: "openapi" | "text" }> = {
  openapi: {
    label: "OpenAPI 스펙 생성",
    instruction: "이 코드베이스의 HTTP 엔드포인트(컨트롤러/라우터/핸들러)를 분석해 OpenAPI 3.0 스펙을 YAML로 생성해줘. 각 경로·메서드·경로/쿼리 파라미터·요청 본문/응답 스키마를 최대한 채워줘. YAML 문서만 출력(설명·코드펜스 없이).",
    system: "You are an expert API engineer. Analyze the given source code and output a valid OpenAPI 3.0 specification in YAML. Output ONLY the YAML document — no explanations, no markdown code fences.",
    kind: "openapi",
  },
  docs: {
    label: "API 문서 생성",
    instruction: "이 코드베이스의 주요 API/기능을 설명하는 개발자 문서를 한국어 Markdown으로 작성해줘. 엔드포인트 표와 간단한 사용 예시를 포함해줘.",
    system: "You write clear developer documentation in Korean GitHub-Flavored Markdown based on the given source code.",
    kind: "text",
  },
  custom: {
    label: "직접 입력",
    instruction: "",
    system: "You are a helpful senior engineer. Follow the user's instruction using the provided source code. Answer in Korean.",
    kind: "text",
  },
};

// ```yaml … ``` 같은 코드펜스 제거(모델이 감싸서 줄 때 대비).
function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

// 2단계 분석에서 소규모 리포는 선별 없이 전부 사용하는 임계.
const SMALL_REPO = 25;
const MAX_SELECT = 40; // AI가 선별할 최대 파일 수

// 모델 응답에서 JSON 배열만 추출해 파싱(설명이 섞여 와도 대비).
function parseJsonArray(s: string): string[] {
  try {
    const a = s.indexOf("["), b = s.lastIndexOf("]");
    if (a === -1 || b === -1 || b < a) return [];
    const arr = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

export function AiCodegenModal({ onClose }: { onClose: () => void }) {
  const projectRoot = useStore((s) => s.projectRoot);
  const [folder, setFolder] = useState(projectRoot ?? "");
  const [exts, setExts] = useState(DEFAULT_EXTS);
  const [maxKb, setMaxKb] = useState(150);
  const [preset, setPreset] = useState<Preset>("openapi");
  const [instruction, setInstruction] = useState(PRESETS.openapi.instruction);
  const [twoStage, setTwoStage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [out, setOut] = useState("");
  const [meta, setMeta] = useState<{ fileCount: number; kb: number; truncated: boolean; included: string[]; note?: string } | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const ai = loadAi();

  const choosePreset = (p: Preset) => { setPreset(p); if (p !== "custom") setInstruction(PRESETS[p].instruction); };

  async function pick() {
    const d = await pickDirectory(folder || projectRoot || undefined);
    if (d) setFolder(d);
  }

  async function run() {
    setErr(""); setOut(""); setMeta(null);
    if (!folder) { setErr("분석할 리포지토리 폴더를 선택하세요."); return; }
    if (!aiConfigured(ai)) { setErr(`${PROVIDER_LABELS[ai.provider]} 설정이 필요합니다 (Settings ▸ AI).`); return; }
    const extList = exts.split(",").map((e) => e.trim()).filter(Boolean);
    const cap = Math.max(10, maxKb) * 1024;
    setBusy(true);
    try {
      let bundle;
      let note = "";
      if (twoStage) {
        // 1단계: 파일 목록 → AI가 관련 파일 선별 → 2단계: 선택 파일만 수집.
        setPhase("파일 목록 수집 중…");
        const all = await api.listSourceFiles(folder, extList);
        if (all.length === 0) { setErr("대상 파일을 찾지 못했습니다. 확장자 목록을 확인하세요."); setBusy(false); return; }
        let selected: string[];
        if (all.length <= SMALL_REPO) {
          selected = all; // 소규모는 선별 불필요
        } else {
          setPhase(`관련 파일 선별 중… (${all.length}개 중)`);
          const selPrompt =
            `작업 지시: ${instruction}\n\n` +
            `아래 파일 목록에서 이 작업에 가장 관련 있는 파일만 골라 JSON 배열로 반환해줘(최대 ${MAX_SELECT}개, 경로는 목록 그대로).\n\n` +
            all.join("\n");
          const selRaw = await callAI(selPrompt, "You select relevant source files for a task. Respond ONLY with a JSON array of file path strings from the given list. No prose.");
          const set = new Set(all);
          selected = parseJsonArray(selRaw).filter((p) => set.has(p)).slice(0, MAX_SELECT);
          if (selected.length === 0) { selected = all; note = "AI 선별 실패 → 전체에서 크기 상한까지 사용. "; } // 폴백
          else note = `AI가 ${all.length}개 중 ${selected.length}개 선별. `;
        }
        setPhase(`선택 파일 수집 중… (${selected.length}개)`);
        bundle = await api.collectFiles(folder, selected, cap);
      } else {
        setPhase("소스 코드 수집 중…");
        bundle = await api.collectSource(folder, cap, extList);
      }
      if (bundle.fileCount === 0) { setErr("대상 파일을 찾지 못했습니다. 확장자 목록을 확인하세요."); setBusy(false); return; }
      setMeta({ fileCount: bundle.fileCount, kb: Math.round(bundle.totalBytes / 1024), truncated: bundle.truncated, included: bundle.included, note });
      setPhase(`AI 생성 중… (파일 ${bundle.fileCount}개${bundle.truncated ? " · 일부 생략" : ""})`);
      const sys = PRESETS[preset].system;
      const prompt =
        `${instruction}\n\n` +
        `=== 프로젝트: ${basename(folder)} · 파일 ${bundle.fileCount}개${bundle.truncated ? " (크기 상한으로 일부 생략)" : ""} ===\n` +
        bundle.text;
      const result = await callAI(prompt, sys);
      setOut(result.trim());
    } catch (e: any) {
      setErr(`${e?.message ?? e}`);
    } finally { setBusy(false); setPhase(""); }
  }

  function copy() {
    navigator.clipboard.writeText(out).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  }

  // mode: "new"=새 컬렉션 / "merge"=활성 컬렉션에 병합
  async function importSpec(mode: "new" | "merge") {
    const st = useStore.getState();
    try {
      const yaml = stripFences(out);
      const spec = await api.importSpec(yaml, "yaml");
      const title = spec?.info?.title || `${basename(folder)} API`;
      if (mode === "new") {
        st.addCollection(title);
        st.setSpec(spec);
        st.showToast(`새 컬렉션으로 가져옴 ✓ (${title})`);
        st.logEvent("AI", `코드 분석 → 새 컬렉션 · ${title}`);
      } else {
        st.mergeSpecIntoActive(spec);
        st.showToast(`활성 컬렉션에 병합됨 ✓`);
        st.logEvent("AI", `코드 분석 → 활성 컬렉션 병합 · ${title}`);
      }
      onClose();
    } catch (e: any) {
      st.showAlert(`${e?.message ?? e}`, { title: "OpenAPI 가져오기 실패", kind: "err" });
    }
  }

  return (
    <div className="modalbg" onClick={onClose}>
      <div className="modal codegenmodal" onClick={(e) => e.stopPropagation()}>
        <div className="iomodalhead">
          <h3>🤖 AI 코드 분석 · 생성</h3>
          <button onClick={onClose}>닫기</button>
        </div>

        <div className="codegenbody">
          <div className="row">
            <label style={{ flex: 1 }}>
              리포지토리 폴더
              <div className="row" style={{ gap: 6 }}>
                <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="분석할 소스 폴더" spellCheck={false} style={{ flex: 1 }} />
                <button onClick={pick}>폴더…</button>
              </div>
            </label>
          </div>

          <div className="row">
            <label style={{ flex: 2 }}>확장자 (쉼표 구분)
              <input value={exts} onChange={(e) => setExts(e.target.value)} spellCheck={false} />
            </label>
            <label style={{ width: 130 }}>최대 크기 (KB)
              <input type="number" min={10} value={maxKb} onChange={(e) => setMaxKb(+e.target.value || 150)} />
            </label>
          </div>

          <div className="reqsubtabs" style={{ marginTop: 4 }}>
            {(Object.keys(PRESETS) as Preset[]).map((p) => (
              <button key={p} className={preset === p ? "st active" : "st"} onClick={() => choosePreset(p)}>{PRESETS[p].label}</button>
            ))}
          </div>

          <label>지시문 (프롬프트)
            <textarea rows={4} value={instruction} onChange={(e) => { setInstruction(e.target.value); if (preset !== "custom") setPreset("custom"); }}
              placeholder="예) 이 코드의 REST 엔드포인트로 OpenAPI 스펙을 만들어줘" />
          </label>

          <label className="row" style={{ gap: 8, alignItems: "center", cursor: "pointer", color: "var(--text-dim)", fontSize: 12 }}>
            <input type="checkbox" checked={twoStage} onChange={(e) => setTwoStage(e.target.checked)} />
            <span>대형 리포 2단계 분석 — 파일 목록을 먼저 AI가 훑어 <b>관련 파일만 선별</b> 후 분석(토큰 절약)</span>
          </label>

          <div className="row" style={{ alignItems: "center", marginTop: 4 }}>
            <button className="active" disabled={busy} onClick={run}>{busy ? (phase || "처리 중…") : "▶ 분석 & 생성"}</button>
            <span className="hint tiny">제공자: {PROVIDER_LABELS[ai.provider]} · {ai.model}</span>
          </div>

          {err && <div className="codegenerr">⚠ {err}</div>}

          {meta && (
            <div className="hint tiny" style={{ marginTop: 6 }}>
              {meta.note}포함 파일 {meta.fileCount}개 · {meta.kb}KB{meta.truncated ? " · ⚠ 크기 상한으로 일부 생략됨(상한을 늘리거나 2단계 분석을 켜보세요)" : ""}
            </div>
          )}

          {out && (
            <div className="codegenout">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <strong>생성 결과</strong>
                <div className="row" style={{ gap: 6 }}>
                  <button onClick={copy}>{copied ? "✓ 복사됨" : "복사"}</button>
                  {PRESETS[preset].kind === "openapi" && <>
                    <button onClick={() => importSpec("merge")} title="현재 활성 컬렉션에 경로/스키마 병합">활성 컬렉션에 병합</button>
                    <button className="active" onClick={() => importSpec("new")}>＋ 새 컬렉션</button>
                  </>}
                </div>
              </div>
              <textarea className="rawedit" readOnly value={out} rows={16} spellCheck={false} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
