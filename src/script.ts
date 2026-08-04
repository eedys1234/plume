// Pre-request / Post-response 스크립트 실행기 (JavaScript 기반, Bruno 유사).
// WebView의 JS 엔진에서 사용자 스크립트를 실행한다. 주입 객체:
//   bru : 환경변수/런타임변수 get·set          (양쪽)
//   req : 요청 조작(headers/url/body)           (pre)
//   res : 응답 읽기(status/headers/body/time)   (post)
//   console.log/warn/error → 스크립트 콘솔에 표시
//
// 주의: new Function으로 사용자 코드를 실행한다. 스크립트는 사용자 본인 소유(로컬 개발 도구)라는
// 전제이며, Bruno/Postman과 동일한 신뢰 모델이다.

export interface ScriptRun {
  logs: string[];
  error?: string;
}

/** bru: 환경/런타임 변수 접근. */
export interface BruApi {
  getEnvVar: (k: string) => string | undefined;
  setEnvVar: (k: string, v: unknown) => void;
  getVar: (k: string) => string | undefined;
  setVar: (k: string, v: unknown) => void;
}

function fmt(a: unknown[]): string {
  return a
    .map((x) => {
      if (typeof x === "string") return x;
      try {
        return JSON.stringify(x);
      } catch {
        return String(x);
      }
    })
    .join(" ");
}

export function runScript(
  code: string,
  ctx: { bru: BruApi; req?: unknown; res?: unknown }
): ScriptRun {
  if (!code || !code.trim()) return { logs: [] };
  const logs: string[] = [];
  const sandboxConsole = {
    log: (...a: unknown[]) => logs.push(fmt(a)),
    info: (...a: unknown[]) => logs.push(fmt(a)),
    warn: (...a: unknown[]) => logs.push("⚠ " + fmt(a)),
    error: (...a: unknown[]) => logs.push("✖ " + fmt(a)),
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function("bru", "req", "res", "console", `"use strict";\n${code}`);
    fn(ctx.bru, ctx.req, ctx.res, sandboxConsole);
    return { logs };
  } catch (e: any) {
    return { logs, error: String(e?.message ?? e) };
  }
}
