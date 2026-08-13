// 앱 메타: 버전 + 업데이트 확인용 GitHub 저장소(owner/repo)를 함께 관리한다.
// 기기 로컬 파일(앱 설정 디렉터리 appmeta.json)에 저장·로드하며, Settings에서 유동적으로 변경 가능.
// 비-Tauri(브라우저 dev)에서는 localStorage 폴백.
import { api } from "./ipc";
import pkg from "../package.json";

export interface AppMeta {
  version: string; // 표시용(빌드=릴리스 태그로 동기화). 시작 시 실제 설치 버전으로 갱신.
  owner: string;   // 업데이트 확인 GitHub owner
  repo: string;    // 업데이트 확인 GitHub repo
}

export const defaultMeta = (): AppMeta => ({
  version: (pkg as any).version ?? "0.0.0",
  owner: "eedys1234",
  repo: "plume",
});

const LS_KEY = "plume:appmeta";

export async function loadMeta(): Promise<AppMeta> {
  try {
    const raw = await api.appMetaLoad();
    if (raw) return { ...defaultMeta(), ...JSON.parse(raw) };
  } catch {
    // 브라우저 dev 폴백.
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return { ...defaultMeta(), ...JSON.parse(raw) };
    } catch { /* 무시 */ }
  }
  return defaultMeta();
}

export async function saveMeta(m: AppMeta): Promise<void> {
  const json = JSON.stringify(m);
  try {
    await api.appMetaSave(json);
  } catch {
    try { localStorage.setItem(LS_KEY, json); } catch { /* 무시 */ }
  }
}
