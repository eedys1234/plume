// History: 모든 활동 이벤트(Builder/Run/Export/Import/Chain/HTTP…) + 보낸 요청 목록.
import { useState } from "react";
import { useStore } from "../store";
import { useShallow } from "zustand/react/shallow";

export function History() {
  const { history, clearHistory, events, clearEvents, setPrefillRequest, setGnb, setBuilderTab } = useStore(
    useShallow((s) => ({
      history: s.history, clearHistory: s.clearHistory, events: s.events, clearEvents: s.clearEvents,
      setPrefillRequest: s.setPrefillRequest, setGnb: s.setGnb, setBuilderTab: s.setBuilderTab,
    }))
  );
  const [tab, setTab] = useState<"events" | "http">("events");

  function openInCall(req: any) {
    setPrefillRequest(req);
    setGnb("builder");
    setBuilderTab("call");
  }

  const kindClass = (k: string) => `evk evk-${k.toLowerCase()}`;

  return (
    <div className="historyview">
      <div className="historybar">
        <div className="histtoggle">
          <button className={tab === "events" ? "active" : ""} onClick={() => setTab("events")}>활동 ({events.length})</button>
          <button className={tab === "http" ? "active" : ""} onClick={() => setTab("http")}>HTTP 호출 ({history.length})</button>
        </div>
        {tab === "events" && events.length > 0 && <button onClick={clearEvents}>비우기</button>}
        {tab === "http" && history.length > 0 && <button onClick={clearHistory}>비우기</button>}
      </div>

      {tab === "events" ? (
        events.length === 0 ? (
          <div className="docempty">
            <div className="docempty-icon">🕘</div>
            <p>아직 기록된 활동이 없습니다</p>
            <p className="hint">요청 편집·저장·Run·Export/Import·Chain 등이 여기에 기록됩니다.</p>
          </div>
        ) : (
          <ul className="eventlist">
            {events.map((e) => (
              <li key={e.id} className="eentry">
                <span className={kindClass(e.kind)}>{e.kind}</span>
                <span className="emsg">{e.message}</span>
                <span className="sum">{new Date(e.at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        )
      ) : history.length === 0 ? (
        <div className="docempty">
          <div className="docempty-icon">🕘</div>
          <p>아직 보낸 요청이 없습니다</p>
          <p className="hint">Call/Chain에서 요청을 보내면 여기에 기록됩니다.</p>
        </div>
      ) : (
        <ul className="historylist">
          {history.map((h) => (
            <li key={h.id} className="hentry" onClick={() => openInCall(h.req)} title="클릭 → Call에서 열기">
              <span className={`m m-${h.req.method.toLowerCase()}`}>{h.req.method}</span>
              <span className="hurl">{h.req.url}</span>
              <span className={`respstatus s${Math.floor(h.status / 100)}`}>{h.status || "-"}</span>
              <span className="sum">
                {h.elapsedMs}ms · {new Date(h.at).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
