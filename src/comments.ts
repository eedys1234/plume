// Figma식 메모(코멘트). SSOT 스펙의 루트 `x-comments` 배열에 저장되며,
// 기존 저장/불러오기 흐름(project.yaml round-trip)에 실려 git으로 공유된다.
import type { Spec } from "./ipc";

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string; // ISO
}

export interface Comment {
  id: string;
  path: string; // "/users"
  method: string; // "post"
  field?: string; // 미지정 = 오퍼레이션(이 API) 전체
  author: string;
  body: string;
  createdAt: string; // ISO
  resolved?: boolean;
  replies?: Reply[];
}

export function getComments(spec: Spec): Comment[] {
  const arr = (spec as any)?.["x-comments"];
  return Array.isArray(arr) ? arr : [];
}

export function commentsFor(spec: Spec, path: string, method: string): Comment[] {
  return getComments(spec).filter((c) => c.path === path && c.method === method);
}

const AUTHOR_KEY = "plume:author";
export function authorName(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) || "";
  } catch {
    return "";
  }
}
export function setAuthorName(name: string) {
  try {
    localStorage.setItem(AUTHOR_KEY, name);
  } catch {
    /* 무시 */
  }
}

export function newId(prefix = "c"): string {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

// 메모 대상 후보 필드 경로 수집(datalist 자동완성용).
export function fieldPaths(op: any): string[] {
  const out: string[] = [];
  const walk = (schema: any, prefix: string, depth: number) => {
    if (!schema || depth > 6) return;
    if (schema.type === "array" && schema.items) {
      walk(schema.items, `${prefix}[]`, depth);
      return;
    }
    const props = schema.properties;
    if (props && typeof props === "object") {
      for (const k of Object.keys(props)) {
        const p = prefix ? `${prefix}.${k}` : k;
        out.push(p);
        walk(props[k], p, depth + 1);
      }
    }
  };

  for (const pm of op?.parameters ?? []) {
    if (pm?.name) out.push(`param:${pm.name}`);
  }
  const rb = op?.requestBody?.content;
  if (rb) {
    const mt = Object.keys(rb)[0];
    if (mt) walk(rb[mt]?.schema, "body", 0);
  }
  const resps = op?.responses ?? {};
  for (const code of Object.keys(resps)) {
    const content = resps[code]?.content;
    if (!content) continue;
    const mt = Object.keys(content)[0];
    if (mt) walk(content[mt]?.schema, `response.${code}`, 0);
  }
  return Array.from(new Set(out));
}

// 대상 라벨(사람이 읽기 좋은 형태).
export function targetLabel(field?: string): string {
  if (!field) return "이 API (전체)";
  if (field.startsWith("param:")) return `파라미터 ${field.slice(6)}`;
  return field;
}

export function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
