// Settings: CloudFront(S3) 배포 설정 + AWS 자격증명 입력.
// 자격증명은 기기 로컬(localStorage)에만 저장되며 워크스페이스/깃에 포함되지 않는다.
// 실제 배포 버튼은 Specification(Docs) 탭의 GitHub Pages 버튼 오른쪽에 있다.
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { loadDeploy, saveDeploy, clearCreds, emptyDeploy, type DeploySettings } from "./deployConfig";

export function Settings() {
  const { projectDir, showToast } = useStore(
    useShallow((s) => ({ projectDir: s.projectDir, showToast: s.showToast }))
  );
  const [cfg, setCfg] = useState<DeploySettings>(emptyDeploy());
  const [showSecret, setShowSecret] = useState(false);

  // 프로젝트가 바뀌면 해당 프로젝트의 저장값 로드(암호화 파일에서 복호화).
  useEffect(() => {
    let alive = true;
    loadDeploy(projectDir).then((s) => { if (alive) setCfg(s); });
    return () => { alive = false; };
  }, [projectDir]);

  const set = (patch: Partial<DeploySettings>) => setCfg((c) => ({ ...c, ...patch }));
  const save = async () => { await saveDeploy(projectDir, cfg); showToast("배포 설정 저장됨 ✓"); };
  const clear = async () => { const next = await clearCreds(projectDir); setCfg(next); showToast("자격증명 삭제됨"); };

  const hasCreds = cfg.accessKeyId.trim() && cfg.secretAccessKey.trim();

  return (
    <div className="settings">
      <div className="settingsinner">
        <h2>⚙ Settings</h2>

        <section className="settingsec">
          <h3>☁ CloudFront 배포</h3>
          <p className="hint tiny">
            문서(Redoc/Swagger) HTML을 S3에 업로드하고 CloudFront를 무효화합니다.
            GitHub Actions의 <code>aws s3 cp</code> + <code>aws cloudfront create-invalidation</code> 흐름과 동일합니다.
            실제 배포 버튼은 <b>Specification</b> 탭의 GitHub Pages 버튼 옆에 있습니다.
          </p>

          <div className="settinggrid">
            <label>
              Region
              <input value={cfg.region} onChange={(e) => set({ region: e.target.value })} placeholder="ap-northeast-2" />
            </label>
            <label>
              S3 Bucket
              <input value={cfg.bucket} onChange={(e) => set({ bucket: e.target.value })} placeholder="my-docs-bucket" />
            </label>
            <label>
              오브젝트 Key
              <input value={cfg.key} onChange={(e) => set({ key: e.target.value })} placeholder="index.html" />
            </label>
            <label>
              CloudFront 배포 ID
              <input value={cfg.distributionId} onChange={(e) => set({ distributionId: e.target.value })} placeholder="E1234ABCDEF (비우면 무효화 생략)" />
            </label>
            <label>
              무효화 경로
              <input value={cfg.invalidationPath} onChange={(e) => set({ invalidationPath: e.target.value })} placeholder="/*" />
            </label>
            <label>
              문서 뷰어
              <select value={cfg.viewer} onChange={(e) => set({ viewer: e.target.value as "redoc" | "swagger" })}>
                <option value="redoc">Redoc</option>
                <option value="swagger">Swagger UI</option>
              </select>
            </label>
          </div>
        </section>

        <section className="settingsec">
          <h3>🔑 AWS 자격증명</h3>
          <p className="hint tiny">
            이 기기에만 저장되며 워크스페이스 파일·git에 포함되지 않습니다(GitHub Secrets와 동일 취지).
            IAM 사용자에 <code>s3:PutObject</code> 및 <code>cloudfront:CreateInvalidation</code> 권한이 필요합니다.
          </p>
          <div className="settinggrid">
            <label>
              Access Key ID
              <input value={cfg.accessKeyId} onChange={(e) => set({ accessKeyId: e.target.value })} placeholder="AKIA..." autoComplete="off" spellCheck={false} />
            </label>
            <label>
              Secret Access Key
              <span className="secretwrap">
                <input
                  type={showSecret ? "text" : "password"}
                  value={cfg.secretAccessKey}
                  onChange={(e) => set({ secretAccessKey: e.target.value })}
                  placeholder="••••••••••••••••"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="secrettoggle" onClick={() => setShowSecret((v) => !v)}>{showSecret ? "숨김" : "표시"}</button>
              </span>
            </label>
            <label className="settingwide">
              Session Token <span className="hint tiny">(STS 임시 자격증명일 때만)</span>
              <input value={cfg.sessionToken} onChange={(e) => set({ sessionToken: e.target.value })} placeholder="(선택)" autoComplete="off" spellCheck={false} />
            </label>
          </div>
        </section>

        <div className="settingbar">
          <button className="active" onClick={save}>설정 저장</button>
          {hasCreds && <button className="danger" onClick={clear}>자격증명 삭제</button>}
          <span className="spacer" />
          <span className="hint tiny">
            {projectDir ? `프로젝트: ${projectDir}` : "워크스페이스 미선택 — 기본 프로필에 저장"}
          </span>
        </div>
      </div>
    </div>
  );
}
