// AI(LLM) 제공자 설정 + MCP 서버 목록. 기기 로컬(localStorage)에만 저장.
// 제공자: Ollama(로컬) · OpenAI(ChatGPT) · Anthropic(Claude).
import { api } from "../ipc";

export type AiProvider = "ollama" | "openai" | "anthropic";

export interface AiSettings {
  provider: AiProvider;
  baseUrl: string;   // 비면 제공자 기본값
  apiKey: string;    // ollama는 불필요
  model: string;
}

export interface McpServerCfg {
  id: string;
  name: string;
  command: string;      // 예: "npx"
  args: string;         // 공백 구분 문자열(저장은 문자열, 호출 시 분해)
}

const AI_KEY = "plume.ai";
const MCP_KEY = "plume.mcp";

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  ollama: "Ollama (로컬)",
  openai: "OpenAI (ChatGPT)",
  anthropic: "Anthropic (Claude)",
};

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  ollama: "llama3.1",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-latest",
};

export const DEFAULT_BASEURL: Record<AiProvider, string> = {
  ollama: "http://localhost:11434",
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};

export function loadAi(): AiSettings {
  try {
    const s = JSON.parse(localStorage.getItem(AI_KEY) || "{}");
    const provider: AiProvider = s.provider === "openai" || s.provider === "anthropic" ? s.provider : "ollama";
    return {
      provider,
      baseUrl: typeof s.baseUrl === "string" ? s.baseUrl : "",
      apiKey: typeof s.apiKey === "string" ? s.apiKey : "",
      model: typeof s.model === "string" && s.model ? s.model : DEFAULT_MODELS[provider],
    };
  } catch {
    return { provider: "ollama", baseUrl: "", apiKey: "", model: DEFAULT_MODELS.ollama };
  }
}

export function saveAi(s: AiSettings) {
  try { localStorage.setItem(AI_KEY, JSON.stringify(s)); } catch { /* 무시 */ }
}

export function aiConfigured(s = loadAi()): boolean {
  if (!s.model.trim()) return false;
  if (s.provider === "ollama") return true;           // 키 불필요
  return !!s.apiKey.trim();                             // OpenAI/Anthropic는 키 필요
}

/** 현재 설정으로 LLM 호출. 미설정 시 안내 에러를 던진다. */
export async function callAI(prompt: string, system = ""): Promise<string> {
  const s = loadAi();
  if (!aiConfigured(s)) {
    throw new Error(`${PROVIDER_LABELS[s.provider]} 설정이 필요합니다 (Settings ▸ AI). ${s.provider !== "ollama" ? "API 키를 입력하세요." : "모델명을 확인하세요."}`);
  }
  return api.aiComplete({ provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, system, prompt });
}

// ── MCP ──
export function loadMcp(): McpServerCfg[] {
  try { const a = JSON.parse(localStorage.getItem(MCP_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
export function saveMcp(list: McpServerCfg[]) {
  try { localStorage.setItem(MCP_KEY, JSON.stringify(list)); } catch { /* 무시 */ }
}
