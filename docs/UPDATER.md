# Plume 자동 업데이트 (tauri-plugin-updater)

서명된 릴리스 + 매니페스트로 앱이 스스로 새 버전을 감지·다운로드·설치·재시작한다.
서버를 따로 운영하지 않고 **GitHub Releases**만으로 동작한다.

## 구성 요약

```
앱(플러그인)  ──①check──▶  latest.json (릴리스 자산)
              ◀─매니페스트─
앱  ──②download──▶  설치파일(.nsis.zip / .app.tar.gz / .AppImage) + .sig
     ─서명검증(pubkey)→ ③설치 → ④relaunch(재시작)
```

- **공개키(pubkey)**: 앱에 내장(`tauri.conf.json`). 다운로드한 파일의 `.sig`를 이 키로 검증.
- **개인키(private key)**: 릴리스 빌드 시에만 사용. 절대 커밋 금지.

이미 세팅된 것:
- Rust: `tauri-plugin-updater`, `tauri-plugin-process`
- `capabilities/default.json`: `updater:default`, `process:allow-restart`
- `tauri.conf.json`: `bundle.createUpdaterArtifacts:true`, `plugins.updater.{endpoints,pubkey}`
- 프론트: `src/update.ts`(check/downloadAndInstall/relaunch) + 업데이트 모달
- 서명 키페어: `src-tauri/plume-update.key`(비공개, .gitignore) / `.key.pub`(공개)

## 최초 1회 설정

### 1) 엔드포인트의 OWNER/REPO 교체
`src-tauri/tauri.conf.json`:
```json
"endpoints": ["https://github.com/OWNER/REPO/releases/latest/download/latest.json"]
```
→ 실제 GitHub 사용자/저장소로 변경.

### 2) 서명 키를 GitHub Secrets에 등록
저장소 ▸ Settings ▸ Secrets and variables ▸ Actions:
- `TAURI_SIGNING_PRIVATE_KEY` = `src-tauri/plume-update.key` **파일 전체 내용**
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = 키 비밀번호(없으면 빈 값)

> 키가 없거나 새로 만들려면:
> ```bash
> npx @tauri-apps/cli signer generate -w src-tauri/plume-update.key
> ```
> 그리고 출력된 **공개키**(`.key.pub` 내용)를 `tauri.conf.json`의 `plugins.updater.pubkey`에 넣는다.
> ⚠ 개인키/비밀번호를 잃으면 기존 사용자에게 업데이트를 배포할 수 없다. 안전하게 백업.

## 릴리스 배포

```bash
# 1) 버전 올리기: tauri.conf.json "version" + package.json + src/update.ts CURRENT_VERSION
# 2) 태그 푸시
git tag v0.2.0
git push origin v0.2.0
```

→ `.github/workflows/release.yml` 이 3개 OS 빌드 + **서명된 업데이터 아티팩트(.sig)** + **latest.json** 을
Draft 릴리스에 첨부한다. 릴리스 노트 확인 후 **Publish** 하면:

- `https://github.com/OWNER/REPO/releases/latest/download/latest.json` 이 활성화되고
- 기존 사용자의 앱이 시작 시(또는 툴바 버전칩 클릭 시) 새 버전을 감지 → 모달 → **지금 업데이트** → 자동 설치·재시작.

> Draft/Prerelease 상태에서는 `releases/latest/download/` 가 동작하지 않는다. 반드시 Publish.

## 매니페스트(latest.json) 형식

`docs/latest.example.json` 참고. 핵심 필드:

| 필드 | 설명 |
|------|------|
| `version` | 최신 버전(현재 버전보다 높으면 업데이트로 인식) |
| `notes` | 변경 사항(모달에 표시) |
| `pub_date` | ISO8601 발행 시각 |
| `platforms.<key>.url` | 해당 플랫폼 설치파일 URL |
| `platforms.<key>.signature` | 그 파일의 `.sig` 내용(서명) |

플랫폼 키: `windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`.

## 자체 서버로 내려줄 때(선택)
GitHub 대신 자체 서버를 쓰면 `endpoints`를 서버 URL로 바꾸고, 그 서버가 위 형식의 JSON을 반환하면 된다.
경로 변수를 쓰고 싶으면: `https://your.server/update/{{target}}/{{arch}}/{{current_version}}`.

## 프론트 코드 위치
- `src/update.ts` — `checkForUpdate()`(check+서명검증), `applyUpdate()`(downloadAndInstall+relaunch),
  Tauri/서버 미가동 시 mock 폴백.
- `src/App.tsx` — 시작 시 자동 확인, 툴바 버튼/버전칩, `UpdateModal`(진행률 바).
