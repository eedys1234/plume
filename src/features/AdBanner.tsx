// 하단 광고 배너 슬롯(전체 폭 · 중앙 정렬). 접기/펼치기 지원(설정 localStorage).
//
// 기본은 "하우스 광고"(내 제품/저장소/후원 홍보) 모드입니다. 아래 HOUSE_ADS 배열만 편집하면
// 됩니다. 여러 개를 넣으면 앱을 열 때마다 순서대로 번갈아 표시됩니다.
//
// 다른 형태로 바꾸려면 AD 상수를 교체하세요:
//   { kind: "house" }                              하우스 광고 카드(기본)
//   { kind: "placeholder" }                        개발용 자리표시
//   { kind: "image", src, href, alt }              제휴/이미지 배너(이미지 링크)
//   { kind: "iframe", src, height }                자체 호스팅 광고 페이지 임베드
//
// ⚠ Google AdSense 등 웹 광고 네트워크를 앱 웹뷰에 직접 삽입하는 것은 정책 위반이며
//   앱 오리진(tauri://localhost)엔 서빙되지 않습니다. 자체 도메인 페이지를 iframe 으로 임베드하세요.
import { useState } from "react";

interface HouseAd { emoji: string; title: string; text: string; cta: string; href: string; }

// ── 하우스 광고 목록: 여기만 편집하면 됩니다 ─────────────────────────────
const HOUSE_ADS: HouseAd[] = [
  {
    emoji: "⭐",
    title: "Plume이 도움이 되셨나요?",
    text: "GitHub에서 스타를 눌러 개발을 응원해 주세요.",
    cta: "GitHub에서 ★",
    href: "https://github.com/eedys1234/plume",
  },
  // 예시(주석 해제해 사용): 내 다른 제품/서비스 홍보
  // { emoji: "🚀", title: "Plume Pro 준비 중", text: "팀 협업·클라우드 동기화 기능을 먼저 받아보세요.", cta: "알림 신청", href: "https://example.com/pro" },
  // { emoji: "☕", title: "개발을 응원해 주세요", text: "후원은 지속적인 업데이트에 큰 힘이 됩니다.", cta: "후원하기", href: "https://buymeacoffee.com/…" },
];
// ────────────────────────────────────────────────────────────────────

type AdConfig =
  | { kind: "house" }
  | { kind: "placeholder" }
  | { kind: "image"; src: string; href: string; alt?: string }
  | { kind: "iframe"; src: string; height?: number };

// 여기만 바꾸면 광고 형태가 전환됩니다.
const AD: AdConfig = { kind: "house" };

// 앱 실행마다 하우스 광고를 순환(로컬 카운터). Math.random 없이 결정적으로.
function pickHouseAd(): HouseAd | null {
  if (HOUSE_ADS.length === 0) return null;
  const n = Number(localStorage.getItem("plume.adRot") || "0");
  localStorage.setItem("plume.adRot", String((n + 1) % 1_000_000));
  return HOUSE_ADS[n % HOUSE_ADS.length];
}

export function AdBanner() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("plume.adCollapsed") === "1");
  const [ad] = useState(pickHouseAd); // 마운트 시 한 번 선택(렌더마다 바뀌지 않도록)
  const toggle = () =>
    setCollapsed((c) => {
      const n = !c;
      if (n) localStorage.setItem("plume.adCollapsed", "1");
      else localStorage.removeItem("plume.adCollapsed");
      return n;
    });
  const openLink = (href: string) => { try { window.open(href, "_blank"); } catch { /* noop */ } };

  return (
    <footer className={collapsed ? "adbar collapsed" : "adbar"}>
      <span className="adlabel">광고</span>
      {!collapsed && (
        <div className="adslot">
          {AD.kind === "house" && ad && (
            <div className="housead" onClick={() => openLink(ad.href)} role="link" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") openLink(ad.href); }}>
              <span className="haemoji">{ad.emoji}</span>
              <div className="hatext">
                <b>{ad.title}</b>
                <span>{ad.text}</span>
              </div>
              <button className="hacta" onClick={(e) => { e.stopPropagation(); openLink(ad.href); }}>{ad.cta}</button>
            </div>
          )}
          {AD.kind === "placeholder" && (
            <div className="adplaceholder">여기에 광고 배너가 표시됩니다 · 728×90 / 반응형</div>
          )}
          {AD.kind === "image" && (
            <a href={AD.href} target="_blank" rel="noreferrer noopener">
              <img src={AD.src} alt={AD.alt ?? "advertisement"} />
            </a>
          )}
          {AD.kind === "iframe" && (
            <iframe
              src={AD.src}
              title="advertisement"
              style={{ height: AD.height ?? 90, width: "100%", maxWidth: 970, border: 0 }}
              sandbox="allow-scripts allow-same-origin allow-popups"
            />
          )}
        </div>
      )}
      <button className="adcollapse" onClick={toggle} title={collapsed ? "광고 펼치기" : "광고 접기"}>
        {collapsed ? "▲" : "▼"}
      </button>
    </footer>
  );
}
