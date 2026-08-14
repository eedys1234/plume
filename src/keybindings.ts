// 커스터마이징 가능한 단축키 시스템.
// - 각 command 는 기본 조합(default combo)을 가지며, 사용자가 재매핑할 수 있다(로컬 저장).
// - 조합은 "Mod+Shift+1" 형태 문자열. Mod = Ctrl(Win/Linux) 또는 ⌘(mac) — 크로스플랫폼.
// - key 는 e.code 기반 정규화(레이아웃 무관): Digit1→"1", KeyS→"S", Comma→",", Tab/Enter/Esc/F1…

export interface Command {
  id: string;
  cat: string;   // 그룹(표시용)
  label: string;
  def: string;   // 기본 조합
}

// 기본 매핑. (nav.settings 기본 = Mod+, — macOS의 ⌘, 관례)
export const COMMANDS: Command[] = [
  { id: "nav.builder", cat: "화면 이동", label: "Builder 로 이동", def: "Mod+1" },
  { id: "nav.env", cat: "화면 이동", label: "Env 로 이동", def: "Mod+2" },
  { id: "nav.git", cat: "화면 이동", label: "Git 으로 이동", def: "Mod+3" },
  { id: "nav.history", cat: "화면 이동", label: "History 로 이동", def: "Mod+4" },
  { id: "nav.settings", cat: "화면 이동", label: "Settings 로 이동", def: "Mod+," },

  { id: "sub.design", cat: "Builder 하위 탭", label: "Design", def: "Mod+Shift+1" },
  { id: "sub.call", cat: "Builder 하위 탭", label: "API Call Chain", def: "Mod+Shift+2" },
  { id: "sub.load", cat: "Builder 하위 탭", label: "Run", def: "Mod+Shift+3" },
  { id: "sub.docs", cat: "Builder 하위 탭", label: "Specification", def: "Mod+Shift+4" },

  { id: "save", cat: "편집", label: "저장", def: "Mod+S" },
  { id: "undo", cat: "편집", label: "되돌리기", def: "Mod+Z" },
  { id: "redo", cat: "편집", label: "다시하기", def: "Mod+Shift+Z" },

  { id: "tab.next", cat: "요청 탭", label: "다음 요청 탭", def: "Ctrl+Tab" },
  { id: "tab.prev", cat: "요청 탭", label: "이전 요청 탭", def: "Ctrl+Shift+Tab" },
  { id: "tab.close", cat: "요청 탭", label: "요청 탭 닫기", def: "Ctrl+W" },

  { id: "request.send", cat: "요청", label: "현재 요청 실행(Send)", def: "Mod+Enter" },

  { id: "help", cat: "도움말", label: "단축키 도움말", def: "F1" },
];

export interface Combo { mod: boolean; shift: boolean; alt: boolean; ctrl: boolean; key: string; }

const CODE_MAP: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
  Space: "Space", Tab: "Tab", Enter: "Enter", Escape: "Esc", Backspace: "Backspace", Delete: "Del",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};
function codeToKey(code: string): string {
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  return CODE_MAP[code] ?? code;
}

const MOD_KEYS = ["Control", "Shift", "Alt", "Meta", "OS"];

/** KeyboardEvent → Combo. 모디파이어 단독 키는 null. */
export function eventToCombo(e: KeyboardEvent): Combo | null {
  if (MOD_KEYS.includes(e.key)) return null;
  return { mod: e.ctrlKey || e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, key: codeToKey(e.code) };
}

/** Combo → 저장/매칭용 문자열. 특별히 'Ctrl' 명시 조합은 Ctrl 유지(예: Ctrl+Tab). */
export function comboToString(c: Combo, preferCtrl = false): string {
  const p: string[] = [];
  if (preferCtrl && c.ctrl && !c.mod) p.push("Ctrl");
  else if (c.mod) p.push("Mod");
  else if (c.ctrl) p.push("Ctrl");
  if (c.alt) p.push("Alt");
  if (c.shift) p.push("Shift");
  p.push(c.key);
  return p.join("+");
}

/** 이벤트가 조합 문자열과 일치하는지. "Ctrl+..." 는 Ctrl 필수, "Mod+..." 는 Ctrl 또는 Meta. */
export function matchEvent(e: KeyboardEvent, comboStr: string): boolean {
  const c = eventToCombo(e);
  if (!c) return false;
  const parts = comboStr.split("+");
  const key = parts[parts.length - 1];
  const wantMod = parts.includes("Mod");
  const wantCtrl = parts.includes("Ctrl");
  const wantShift = parts.includes("Shift");
  const wantAlt = parts.includes("Alt");
  if (c.key.toUpperCase() !== key.toUpperCase()) return false;
  if (c.shift !== wantShift) return false;
  if (c.alt !== wantAlt) return false;
  if (wantMod) { if (!(c.ctrl || (e as any).metaKey)) return false; }
  else if (wantCtrl) { if (!c.ctrl) return false; }
  else { if (c.mod) return false; } // 모디파이어 없어야
  return true;
}

// ─────────────────────────── 저장(로컬) ───────────────────────────
const LS_KEY = "plume:keybindings";
let _overrides: Record<string, string> | null = null;

export function loadOverrides(): Record<string, string> {
  if (_overrides) return _overrides;
  try { _overrides = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { _overrides = {}; }
  return _overrides!;
}
export function saveOverrides(o: Record<string, string>): void {
  _overrides = o;
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch { /* 무시 */ }
}
/** command id → 실제 적용 조합(오버라이드 우선, 없으면 기본). */
export function effectiveCombo(id: string): string {
  const ov = loadOverrides();
  const cmd = COMMANDS.find((c) => c.id === id);
  return ov[id] ?? cmd?.def ?? "";
}
export function setBinding(id: string, comboStr: string): void {
  const o = { ...loadOverrides() };
  const def = COMMANDS.find((c) => c.id === id)?.def;
  if (comboStr === def) delete o[id]; else o[id] = comboStr;
  saveOverrides(o);
}
export function resetBinding(id: string): void {
  const o = { ...loadOverrides() };
  delete o[id];
  saveOverrides(o);
}
export function resetAll(): void { saveOverrides({}); }

/** 특정 command 의 현재 조합과 이벤트가 일치하는지(오버라이드 반영). */
export function isCommand(e: KeyboardEvent, id: string): boolean {
  return matchEvent(e, effectiveCombo(id));
}

/** 이벤트에 매칭되는 command id(첫 일치). App 디스패처용. */
export function commandForEvent(e: KeyboardEvent): string | null {
  for (const c of COMMANDS) {
    if (matchEvent(e, effectiveCombo(c.id))) return c.id;
  }
  return null;
}

// ─────────────────────────── 표시 ───────────────────────────
export const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");
/** 조합 문자열을 사람이 읽는 토큰 배열로(OS 별 기호). */
export function comboTokens(comboStr: string): string[] {
  return comboStr.split("+").map((t) => {
    if (t === "Mod") return IS_MAC ? "⌘" : "Ctrl";
    if (t === "Ctrl") return IS_MAC ? "⌃" : "Ctrl";
    if (t === "Shift") return IS_MAC ? "⇧" : "Shift";
    if (t === "Alt") return IS_MAC ? "⌥" : "Alt";
    return t;
  });
}
