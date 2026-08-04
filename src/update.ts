// 서버 서명 기반 자동 업데이트 (tauri-plugin-updater).
// 실제 서버가 없으면(check 실패) mock으로 UI 흐름을 시연한다.
// 서버가 준비되면 tauri.conf.json의 updater.endpoints만 유효하면 자동으로 실제 경로가 동작한다.

import type { Update } from "@tauri-apps/plugin-updater";

/** 현재 앱 버전(추후 tauri.conf.json/package.json과 동기화). */
export const CURRENT_VERSION = "0.1.0";

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

const MOCK_INFO: UpdateInfo = {
  flag: "Y",
  currentVersion: CURRENT_VERSION,
  latestVersion: "0.2.0",
  releaseNotes: "• 워크스페이스/다중 컬렉션 개선\n• 시스템 트레이 최소화\n• .bru 컬렉션 Import\n• 여러 버그 수정",
  downloadUrl: "https://github.com/plume/plume/releases/latest",
  mandatory: false,
};

/**
 * 서버(서명된 매니페스트)에서 업데이트를 확인한다.
 * tauri-plugin-updater가 endpoints를 호출해 서명 검증까지 수행.
 * Tauri 런타임이 아니거나 서버가 없으면 mock으로 폴백(UI 시연용).
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const upd = await check(); // Update | null (서명 검증 포함)
    if (!upd) {
      return {
        info: { flag: "N", currentVersion: CURRENT_VERSION, latestVersion: CURRENT_VERSION, releaseNotes: "" },
        update: null,
        mock: false,
      };
    }
    return {
      info: {
        flag: "Y",
        currentVersion: upd.currentVersion,
        latestVersion: upd.version,
        releaseNotes: upd.body ?? "",
        mandatory: false,
      },
      update: upd,
      mock: false,
    };
  } catch {
    // 브라우저 dev · 서버 미가동 등 → mock으로 흐름 시연.
    return { info: MOCK_INFO, update: null, mock: true };
  }
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
