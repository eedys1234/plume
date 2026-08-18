// 하단 광고 배너 슬롯(전체 폭 · 중앙 정렬). 접기/펼치기 지원(설정 localStorage).
//
// 실제 광고를 넣으려면 아래 AD 상수만 바꾸면 됩니다:
//   { kind: "placeholder" }                        개발용 자리표시(기본)
//   { kind: "image", src, href, alt }              하우스/제휴 배너(이미지 링크)
//   { kind: "iframe", src, height }                자체 호스팅 광고 페이지(예: 내 웹사이트의 광고 유닛)
//
// ⚠ Google AdSense를 데스크톱 앱 웹뷰에 직접 삽입하는 것은 AdSense 정책 위반이며
//   (승인된 웹사이트에서만 게재 가능), 앱 오리진(tauri://localhost)에는 광고가 서빙되지 않습니다.
//   합법적으로 쓰려면: 내 도메인에 AdSense 유닛을 올린 페이지를 만들고 그 URL을
//   { kind: "iframe", src: "https://내도메인/ads.html" } 로 임베드하세요.
//   (이 경우에도 iframe·앱 임베드에 대한 AdSense 약관을 반드시 확인하세요.)
import { useState } from "react";

type AdConfig =
  | { kind: "placeholder" }
  | { kind: "image"; src: string; href: string; alt?: string }
  | { kind: "iframe"; src: string; height?: number };

// 여기만 바꾸면 실제 광고가 표시됩니다.
const AD: AdConfig = { kind: "placeholder" };

export function AdBanner() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("plume.adCollapsed") === "1");
  const toggle = () =>
    setCollapsed((c) => {
      const n = !c;
      if (n) localStorage.setItem("plume.adCollapsed", "1");
      else localStorage.removeItem("plume.adCollapsed");
      return n;
    });

  return (
    <footer className={collapsed ? "adbar collapsed" : "adbar"}>
      <span className="adlabel">광고</span>
      {!collapsed && (
        <div className="adslot">
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
