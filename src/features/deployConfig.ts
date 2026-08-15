// CloudFront(S3) 배포 설정 — 데스크톱 앱 설정 디렉터리에 **암호화**되어 저장된다(Rust: AES-256-GCM,
// 키는 OS 키체인). 워크스페이스 파일·git에는 포함되지 않는다(GitHub Secrets와 동일 취지).
// 비-Tauri(브라우저 dev)에서는 localStorage로 폴백한다.
// Settings 탭과 Docs(Specification)의 배포 버튼이 이 값을 공유한다.
import { api } from "../ipc";

export interface DeploySettings {
  region: string;
  bucket: string;
  key: string;        // (레거시) 단일 키. 이제 keyPrefix + 배포 시 입력 경로로 조합.
  keyPrefix: string;  // 기본 경로 프리픽스(예: docs/). 배포 모달에서 뒤 경로를 덧붙임.
  distributionId: string;
  invalidationPath: string;
  viewer: "redoc" | "swagger";
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  roleArn: string;
}

export const emptyDeploy = (): DeploySettings => ({
  region: "ap-northeast-2",
  bucket: "",
  key: "index.html",
  keyPrefix: "",
  distributionId: "",
  invalidationPath: "/*",
  viewer: "redoc",
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  roleArn: "",
});

const projectKey = (projectDir: string | null) => projectDir ?? "_default";
const legacyLsKey = (projectDir: string | null) => `plume:deploy:${projectKey(projectDir)}`;

export async function loadDeploy(projectDir: string | null): Promise<DeploySettings> {
  try {
    const raw = await api.deployConfigLoad(projectKey(projectDir));
    if (raw) return { ...emptyDeploy(), ...JSON.parse(raw) };
    // 암호화 파일 없음 → 레거시 localStorage가 있으면 파일로 1회 이관.
    const legacy = localStorage.getItem(legacyLsKey(projectDir));
    if (legacy) {
      const s = { ...emptyDeploy(), ...JSON.parse(legacy) };
      await saveDeploy(projectDir, s);
      try { localStorage.removeItem(legacyLsKey(projectDir)); } catch { /* 무시 */ }
      return s;
    }
  } catch {
    // 비-Tauri(브라우저 dev): localStorage 폴백.
    try {
      const raw = localStorage.getItem(legacyLsKey(projectDir));
      if (raw) return { ...emptyDeploy(), ...JSON.parse(raw) };
    } catch { /* 무시 */ }
  }
  return emptyDeploy();
}

export async function saveDeploy(projectDir: string | null, s: DeploySettings): Promise<void> {
  try {
    await api.deployConfigSave(projectKey(projectDir), JSON.stringify(s));
  } catch {
    try { localStorage.setItem(legacyLsKey(projectDir), JSON.stringify(s)); } catch { /* 무시 */ }
  }
}

/** 자격증명만 지운다(배포 설정은 유지). */
export async function clearCreds(projectDir: string | null): Promise<DeploySettings> {
  const cur = await loadDeploy(projectDir);
  const next = { ...cur, accessKeyId: "", secretAccessKey: "", sessionToken: "" };
  await saveDeploy(projectDir, next);
  return next;
}
