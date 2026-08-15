// Settings: CloudFront(S3) 배포 설정 + AWS 자격증명 입력.
// 자격증명은 기기 로컬(localStorage)에만 저장되며 워크스페이스/깃에 포함되지 않는다.
// 실제 배포 버튼은 Specification(Docs) 탭의 GitHub Pages 버튼 오른쪽에 있다.
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { loadDeploy, saveDeploy, clearCreds, emptyDeploy, type DeploySettings } from "./deployConfig";
import { loadMeta, saveMeta, defaultMeta, type AppMeta } from "../appMeta";
import { COMMANDS, effectiveCombo, comboTokens, setBinding, resetBinding, resetAll, eventToCombo, comboToString } from "../keybindings";

export function Settings() {
  const { projectDir, showToast } = useStore(
    useShallow((s) => ({ projectDir: s.projectDir, showToast: s.showToast }))
  );
  const [cfg, setCfg] = useState<DeploySettings>(emptyDeploy());
  const [showSecret, setShowSecret] = useState(false);
  const [meta, setMeta] = useState<AppMeta>(defaultMeta());
  const [recId, setRecId] = useState<string | null>(null); // 녹화 중인 command id
  const [bindVer, setBindVer] = useState(0); // 바인딩 변경 후 재렌더용
  const [tab, setTab] = useState<"deploy" | "update" | "keys">("deploy");

  // 녹화: recId 설정되면 다음 키 입력을 캡처해 바인딩. Esc=취소.
  useEffect(() => {
    if (!recId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRecId(null); return; }
      const c = eventToCombo(e);
      if (!c) return; // 모디파이어 단독은 대기
      setBinding(recId, comboToString(c));
      setRecId(null);
      setBindVer((v) => v + 1);
    };
    window.addEventListener("keydown", onKey, true); // capture: 전역 디스패처보다 먼저
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recId]);

  // 프로젝트가 바뀌면 해당 프로젝트의 저장값 로드(암호화 파일에서 복호화).
  useEffect(() => {
    let alive = true;
    loadDeploy(projectDir).then((s) => { if (alive) setCfg(s); });
    return () => { alive = false; };
  }, [projectDir]);

  // 앱 메타(버전 + 업데이트 저장소)는 프로젝트와 무관 · 1회 로드.
  useEffect(() => { let alive = true; loadMeta().then((m) => { if (alive) setMeta(m); }); return () => { alive = false; }; }, []);

  // 단축키 충돌 집계 + 카테고리는 바인딩이 바뀔 때만 재계산.
  const kbInfo = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of COMMANDS) { const k = effectiveCombo(c.id); counts[k] = (counts[k] ?? 0) + 1; }
    const cats: string[] = [];
    for (const c of COMMANDS) if (!cats.includes(c.cat)) cats.push(c.cat);
    return { counts, cats };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindVer]);

  const set = (patch: Partial<DeploySettings>) => setCfg((c) => ({ ...c, ...patch }));
  const setM = (patch: Partial<AppMeta>) => setMeta((m) => ({ ...m, ...patch }));
  const save = async () => { await saveDeploy(projectDir, cfg); await saveMeta(meta); showToast("설정 저장됨 ✓"); };
  const clear = async () => { const next = await clearCreds(projectDir); setCfg(next); showToast("자격증명 삭제됨"); };

  const hasCreds = cfg.accessKeyId.trim() && cfg.secretAccessKey.trim();

  return (
    <div className="settings">
      <div className="settingsinner">
        <h2>⚙ Settings</h2>

        <div className="settingtabs">
          {([["deploy", "☁ 배포"], ["update", "⬆ 업데이트"], ["keys", "⌨ 단축키"]] as const).map(([id, label]) => (
            <button key={id} className={tab === id ? "stab active" : "stab"} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        {tab === "deploy" && (
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
        )}

        {tab === "deploy" && (
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
            <label className="settingwide">
              IAM Role ARN <span className="hint tiny">(선택 · 지정 시 이 역할을 assume해 임시 자격증명으로 배포)</span>
              <input value={cfg.roleArn} onChange={(e) => set({ roleArn: e.target.value })} placeholder="arn:aws:iam::123456789012:role/deploy-role" autoComplete="off" spellCheck={false} />
            </label>
          </div>
          <p className="hint tiny" style={{ marginTop: 8 }}>
            Role ARN 을 넣으면 위 Access Key 로 <code>sts:AssumeRole</code> 을 호출해 임시 자격증명을 받은 뒤
            그 권한으로 S3 업로드·CloudFront 무효화를 수행합니다(GitHub Actions의 role-to-assume 와 동일).
          </p>
        </section>
        )}

        {tab === "update" && (
        <section className="settingsec">
          <h3>⬆ 업데이트</h3>
          <p className="hint tiny">
            현재 버전 <b>v{meta.version}</b> (설치파일 빌드 시 릴리스 태그로 설정됨). 아래 GitHub 저장소의
            <code> releases/latest</code> 태그와 비교해 업데이트 유무를 확인합니다. 저장소는 버전과 함께 로컬에 관리됩니다.
          </p>
          <div className="settinggrid">
            <label>
              GitHub Owner
              <input value={meta.owner} onChange={(e) => setM({ owner: e.target.value.trim() })} placeholder="eedys1234" autoComplete="off" spellCheck={false} />
            </label>
            <label>
              GitHub Repo
              <input value={meta.repo} onChange={(e) => setM({ repo: e.target.value.trim() })} placeholder="plume" autoComplete="off" spellCheck={false} />
            </label>
          </div>
          <p className="hint tiny" style={{ marginTop: 6 }}>확인 대상: <code>github.com/{meta.owner || "…"}/{meta.repo || "…"}/releases/latest</code></p>
        </section>
        )}

        {tab === "keys" && (
        <section className="settingsec">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h3 style={{ margin: 0 }}>⌨ 단축키</h3>
            <button className="secrettoggle" onClick={() => { resetAll(); setBindVer((v) => v + 1); showToast("단축키 기본값으로"); }}>전체 기본값</button>
          </div>
          <p className="hint tiny">
            '변경'을 누르고 원하는 키 조합을 누르세요(Esc=취소). <b>Mod</b> = Windows/Linux는 Ctrl, macOS는 ⌘.
            같은 조합이 겹치면 위 목록에서 먼저 나오는 항목이 우선합니다.
          </p>
          {(() => {
            // 조합 충돌 집계 + 카테고리(바인딩 변경 시에만 재계산).
            const { counts, cats } = kbInfo;
            return cats.map((cat) => (
              <div key={cat} className="kbcat">
                <div className="kbcattitle">{cat}</div>
                {COMMANDS.filter((c) => c.cat === cat).map((c) => {
                  const combo = effectiveCombo(c.id);
                  const conflict = counts[combo] > 1;
                  const rec = recId === c.id;
                  return (
                    <div key={c.id} className="kbrow">
                      <span className="kblabel">{c.label}</span>
                      <span className="kbcombo">
                        {rec ? <span className="kbrec">키를 누르세요…</span>
                          : comboTokens(combo).map((t, i) => <kbd key={i}>{t}</kbd>)}
                        {conflict && !rec && <span className="kbconflict" title="다른 항목과 조합이 겹칩니다">충돌</span>}
                      </span>
                      <button className="kbbtn" onClick={() => setRecId(rec ? null : c.id)}>{rec ? "취소" : "변경"}</button>
                      <button className="kbbtn ghost" title="기본값으로" onClick={() => { resetBinding(c.id); setBindVer((v) => v + 1); }}>기본</button>
                    </div>
                  );
                })}
              </div>
            ));
          })()}
          <p className="hint tiny" style={{ marginTop: 8 }}>단축키는 변경 즉시 적용·저장됩니다(아래 '설정 저장'과 무관).</p>
        </section>
        )}

        {tab !== "keys" && (
        <div className="settingbar">
          <button className="active" onClick={save}>설정 저장</button>
          {hasCreds && <button className="danger" onClick={clear}>자격증명 삭제</button>}
          <span className="spacer" />
          <span className="hint tiny">
            {projectDir ? `프로젝트: ${projectDir}` : "워크스페이스 미선택 — 기본 프로필에 저장"}
          </span>
        </div>
        )}
      </div>
    </div>
  );
}
