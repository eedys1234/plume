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

// ─────────────────────────── 응답 테스트(assertion) ───────────────────────────

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}
export interface TestRun {
  results: TestResult[];
  logs: string[];
  error?: string; // 스크립트 자체가 던진(테스트 밖) 오류
}

function jsonSafe(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
function deepEqual(a: unknown, b: unknown): boolean {
  return jsonSafe(a) === jsonSafe(b);
}

/**
 * 응답 테스트 스크립트 실행. 주입: bru, res, test(name, fn), expect(actual), assert(cond, msg), console.
 * Bruno/Postman 유사 API로 응답을 검증하고 결과(통과/실패)를 모은다.
 */
export function runTests(code: string, ctx: { bru: BruApi; res: unknown }): TestRun {
  if (!code || !code.trim()) return { results: [], logs: [] };
  const results: TestResult[] = [];
  const logs: string[] = [];
  const sandboxConsole = {
    log: (...a: unknown[]) => logs.push(fmt(a)),
    info: (...a: unknown[]) => logs.push(fmt(a)),
    warn: (...a: unknown[]) => logs.push("⚠ " + fmt(a)),
    error: (...a: unknown[]) => logs.push("✖ " + fmt(a)),
  };

  const expect = (actual: any) => {
    const check = (pass: boolean, msg: string) => { if (!pass) throw new Error(msg); };
    const build = (neg: boolean) => {
      const ok = (pass: boolean, msg: string) => check(neg ? !pass : pass, (neg ? "NOT: " : "") + msg);
      return {
        toBe: (e: any) => ok(actual === e, `expected ${jsonSafe(actual)} to be ${jsonSafe(e)}`),
        toEqual: (e: any) => ok(deepEqual(actual, e), `expected ${jsonSafe(actual)} to equal ${jsonSafe(e)}`),
        toBeTruthy: () => ok(!!actual, `expected ${jsonSafe(actual)} to be truthy`),
        toBeFalsy: () => ok(!actual, `expected ${jsonSafe(actual)} to be falsy`),
        toBeDefined: () => ok(actual !== undefined, `expected value to be defined`),
        toBeUndefined: () => ok(actual === undefined, `expected value to be undefined`),
        toBeNull: () => ok(actual === null, `expected ${jsonSafe(actual)} to be null`),
        toContain: (e: any) => ok(
          typeof actual === "string" ? actual.includes(e) : Array.isArray(actual) && actual.includes(e),
          `expected ${jsonSafe(actual)} to contain ${jsonSafe(e)}`
        ),
        toHaveLength: (e: number) => ok((actual?.length ?? -1) === e, `expected length ${actual?.length} to be ${e}`),
        toBeGreaterThan: (e: number) => ok(actual > e, `expected ${jsonSafe(actual)} > ${jsonSafe(e)}`),
        toBeGreaterThanOrEqual: (e: number) => ok(actual >= e, `expected ${jsonSafe(actual)} >= ${jsonSafe(e)}`),
        toBeLessThan: (e: number) => ok(actual < e, `expected ${jsonSafe(actual)} < ${jsonSafe(e)}`),
        toBeLessThanOrEqual: (e: number) => ok(actual <= e, `expected ${jsonSafe(actual)} <= ${jsonSafe(e)}`),
        toMatch: (re: string | RegExp) => ok(new RegExp(re).test(String(actual)), `expected ${jsonSafe(actual)} to match ${re}`),
      };
    };
    const m: any = build(false);
    m.not = build(true);
    return m;
  };

  const test = (name: string, fn: () => void) => {
    try { fn(); results.push({ name: String(name), passed: true }); }
    catch (e: any) { results.push({ name: String(name), passed: false, error: String(e?.message ?? e) }); }
  };
  const assert = (cond: unknown, msg?: string) => {
    if (!cond) throw new Error(msg || "assertion failed");
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function("bru", "res", "expect", "test", "assert", "console", `"use strict";\n${code}`);
    fn(ctx.bru, ctx.res, expect, test, assert, sandboxConsole);
    return { results, logs };
  } catch (e: any) {
    return { results, logs, error: String(e?.message ?? e) };
  }
}
