// 서버 서명 기반 자동 업데이트 (tauri-plugin-updater).
// 실제 서버가 없으면(check 실패) mock으로 UI 흐름을 시연한다.
// 서버가 준비되면 tauri.conf.json의 updater.endpoints만 유효하면 자동으로 실제 경로가 동작한다.

import type { Update } from "@tauri-apps/plugin-updater";
import { api } from "./ipc";
import pkg from "../package.json";
import { loadMeta } from "./appMeta";

/** 현재 앱 버전. 빌드 시 package.json(=릴리스 태그로 동기화)에서 시작해, 런타임에 실제 설치 버전으로 갱신. */
export let CURRENT_VERSION: string = (pkg as any).version ?? "0.0.0";

/** 실제 설치된 앱 버전을 조회해 CURRENT_VERSION을 갱신한다(Tauri 아니면 package.json 값 유지). */
export async function resolveAppVersion(): Promise<string> {
  try {
    const v = await api.appVersion();
    if (v) CURRENT_VERSION = v;
  } catch { /* 브라우저 dev: package.json 값 유지 */ }
  return CURRENT_VERSION;
}

/** 버전 비교(semver-lite): a<b → 음수. */
function cmpVer(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** GitHub releases/latest 태그를 조회해 업데이트 유무를 판단(서명 없이도 동작). */
async function checkGithubTag(owner: string, repo: string, current: string): Promise<UpdateInfo | null> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return null;
  const j: any = await res.json();
  const latest = String(j.tag_name ?? "").replace(/^v/, "");
  if (!latest) return null;
  return {
    flag: cmpVer(current, latest) < 0 ? "Y" : "N",
    currentVersion: current,
    latestVersion: latest,
    releaseNotes: j.body ?? "",
    downloadUrl: j.html_url,
    mandatory: false,
  };
}

export interface UpdateInfo {
  flag: "Y" | "N";        // 업데이트 필요 여부(Y=있음)
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string;
  downloadUrl?: string;   // mock/수동 폴백용
  mandatory?: boolean;
}

export interface UpdateCheck {
  info: UpdateInfo;
  /** 실제 Tauri Update 객체(있으면 downloadAndInstall 가능). mock이면 null. */
  update: Update | null;
  mock: boolean;          // 서버 미가동 등으로 mock 폴백했는지
}

/**
 * 업데이트 확인(모두 GitHub 릴리스 태그 기반):
 *  1) 서명된 tauri-plugin-updater(latest.json) → 있으면 자동 다운로드·설치 가능.
 *  2) 없거나 미설정이면 GitHub releases/latest 태그를 조회해 버전 비교(수동 설치 폴백).
 *  3) 둘 다 실패(오프라인 등)면 '최신'으로 간주.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = await resolveAppVersion();
  const meta = await loadMeta(); // owner/repo (유동 변경 가능 · 로컬 파일/Settings)
  // 1) 서명된 자동 업데이트(가능하면 최우선).
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const upd = await check(); // Update | null (서명 검증 포함)
    if (upd) {
      return {
        info: {
          flag: "Y",
          currentVersion: upd.currentVersion,
          latestVersion: upd.version,
          releaseNotes: upd.body ?? "",
          downloadUrl: `https://github.com/${meta.owner}/${meta.repo}/releases/latest`,
          mandatory: false,
        },
        update: upd,
        mock: false,
      };
    }
  } catch { /* updater 미설정/네트워크 → 태그 확인으로 폴백 */ }

  // 2) GitHub 태그 기반 확인(서명 없이도 동작 · 수동 설치 폴백).
  try {
    const info = await checkGithubTag(meta.owner, meta.repo, current);
    if (info) return { info, update: null, mock: false };
  } catch { /* 네트워크 실패 등 */ }

  // 3) 확인 불가 → 최신으로 간주.
  return {
    info: { flag: "N", currentVersion: current, latestVersion: current, releaseNotes: "" },
    update: null,
    mock: false,
  };
}

/** 업데이트가 실제로 필요한지(플래그 Y + 버전 다름). */
export function needsUpdate(info: UpdateInfo): boolean {
  return info.flag === "Y" && info.latestVersion !== info.currentVersion;
}

/**
 * 업데이트 적용:
 *  - 실제 Update가 있으면 다운로드+설치(서명검증) 후 앱 재시작(relaunch).
 *  - mock이면 다운로드 페이지를 연다(실제 인스톨러 연동 전 폴백).
 * onProgress는 실제 다운로드 진행률(0~1)을 전달.
 */
export async function applyUpdate(
  check: UpdateCheck,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  if (check.update) {
    let total = 0;
    let received = 0;
    await check.update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          break;
        case "Progress":
          received += event.data.chunkLength;
          if (total > 0 && onProgress) onProgress(Math.min(1, received / total));
          break;
        case "Finished":
          if (onProgress) onProgress(1);
          break;
      }
    });
    // 설치 완료 → 새 버전으로 재시작.
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } else {
    // mock 폴백: 다운로드 페이지 열기(실제 자동설치는 서버+서명 릴리스 필요).
    try { window.open(check.info.downloadUrl ?? "", "_blank"); } catch { /* noop */ }
  }
}
