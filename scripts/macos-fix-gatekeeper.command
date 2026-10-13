#!/bin/bash
#
# Plume — macOS Gatekeeper("손상되었습니다 / is damaged") 해제 도우미
#
# 공증(notarization) 전의 ad-hoc 서명 앱을 다운로드하면 macOS가 격리(quarantine)
# 속성을 붙여 "Plume.app is damaged and can't be opened" 경고가 뜹니다.
# 이 스크립트는 그 격리 속성만 제거해 앱을 정상 실행할 수 있게 합니다. (1회만 하면 됨)
#
# 사용법(둘 중 하나):
#   • Finder: 이 파일을 "우클릭 → 열기 → 열기"  (최초 1회 경고 허용)
#   • 터미널: bash macos-fix-gatekeeper.command
#
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

echo "──────────────────────────────────────────────"
echo " Plume · macOS Gatekeeper 해제 도우미"
echo "──────────────────────────────────────────────"

# Plume.app 후보 경로(가까운 순으로 탐색).
CANDIDATES=(
  "$DIR/Plume.app"
  "/Applications/Plume.app"
  "$HOME/Applications/Plume.app"
  "$HOME/Downloads/Plume.app"
  "$HOME/Desktop/Plume.app"
)

APP=""
for c in "${CANDIDATES[@]}"; do
  if [ -d "$c" ]; then APP="$c"; break; fi
done

if [ -z "$APP" ]; then
  echo "❌ Plume.app 을 찾지 못했습니다."
  echo "   DMG 안의 Plume.app 을 'Applications' 폴더(또는 이 스크립트와 같은 폴더)로"
  echo "   옮긴 뒤 다시 실행하세요."
  read -r -p "엔터를 누르면 창이 닫힙니다… " _ || true
  exit 1
fi

echo "🔎 대상: $APP"
echo "🧹 격리(quarantine) 속성을 제거합니다…"

xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
xattr -cr "$APP" 2>/dev/null || true

# 남아 있으면 관리자 권한으로 한 번 더 시도.
if xattr -p com.apple.quarantine "$APP" >/dev/null 2>&1; then
  echo "🔐 일부 속성이 남아 관리자 권한으로 재시도합니다(암호 입력창이 뜰 수 있어요)…"
  sudo xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
fi

if xattr -p com.apple.quarantine "$APP" >/dev/null 2>&1; then
  echo "⚠️  아직 속성이 남아 있습니다. 터미널에서 아래를 직접 실행해 보세요:"
  echo "     sudo xattr -dr com.apple.quarantine \"$APP\""
else
  echo "✅ 완료! 이제 Plume.app 을 더블클릭으로 바로 열 수 있습니다."
fi

read -r -p "엔터를 누르면 창이 닫힙니다… " _ || true
