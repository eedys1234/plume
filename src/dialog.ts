// 네이티브 폴더 선택. Tauri 런타임이 아니면(브라우저 미리보기 등) null 반환.
export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const res = await open({ directory: true, multiple: false, defaultPath });
    return typeof res === "string" ? res : null;
  } catch {
    return null; // 브라우저/플러그인 미가용
  }
}

// 네이티브 파일 열기(단일). ext 필터 지정. 경로 반환, 취소/비-Tauri면 null.
export async function pickOpenFile(name: string, exts: string[]): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const res = await open({ multiple: false, directory: false, filters: [{ name, extensions: exts }] });
    return typeof res === "string" ? res : null;
  } catch {
    return null;
  }
}

// 네이티브 경고/확인 다이얼로그(OK/취소). true=OK. Tauri 밖이면 window.confirm 폴백.
export async function confirmWarn(message: string, title = "경고"): Promise<boolean> {
  try {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return await confirm(message, { title, kind: "warning" });
  } catch {
    try {
      return window.confirm(message);
    } catch {
      return true; // 다이얼로그 자체가 불가하면 진행(사용자 직접 트리거한 동작이므로)
    }
  }
}

// 네이티브 저장 위치 선택(파일명 포함). ext로 필터 지정. Tauri 런타임이 아니면 null.
// 기본 위치는 사용자 다운로드 폴더 → 그냥 저장하면 다운로드 폴더에, 원하면 다이얼로그에서 변경.
export async function pickSavePath(defaultName: string, ext?: string): Promise<string | null> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const e = ext ?? defaultName.split(".").pop() ?? "txt";
    let defaultPath = defaultName;
    try {
      const { downloadDir, join } = await import("@tauri-apps/api/path");
      defaultPath = await join(await downloadDir(), defaultName);
    } catch { /* 경로 조회 불가 시 파일명만(다이얼로그 기본 위치) */ }
    const res = await save({
      defaultPath,
      filters: [{ name: e.toUpperCase(), extensions: [e] }],
    });
    return typeof res === "string" ? res : null;
  } catch {
    return null;
  }
}
