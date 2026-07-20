import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Badge } from "../../ui/Badge";
import { ToolButton } from "../../ui/ToolButton";
import { Icon } from "../../ui/Icon";
import { useApp } from "../../store";
import { useActiveConnection } from "../../lib/queries";
import { monitorStart, streamStop } from "../../lib/redis";
import type { StreamBatch } from "../../lib/types";

const LINE_CAP = 10_000;
// ponytail: tail-render 1000 of the 10k buffer — virtualize if the full buffer ever needs to be visible
const TAIL_RENDER = 1_000;

export function MonitorView({ active }: { active: boolean }) {
  const conn = useActiveConnection();
  const showToast = useApp((s) => s.showToast);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const idRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<StreamBatch<string>>("redis-monitor-batch", (e) => {
      if (e.payload.id !== idRef.current) return;
      setLines((ls) => [...ls, ...e.payload.items].slice(-LINE_CAP));
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // The backend stream only runs while the tab is visible and unpaused. MONITOR
  // is heavy on the server and the tail is lossy anyway (10k cap), so a hidden
  // or paused tab stops the stream instead of burning CPU invisibly; showing
  // the tab starts a fresh one.
  useEffect(() => {
    if (!running || paused || !active || !conn) return;
    const id = crypto.randomUUID();
    idRef.current = id;
    let stale = false;
    monitorStart(conn, id)
      .then(() => {
        // stopped before the backend registered — close the orphan stream
        if (stale) void streamStop(id);
      })
      .catch((err) => {
        if (!stale) {
          setRunning(false);
          showToast("Monitor failed", String(err), "err");
        }
      });
    return () => {
      stale = true;
      idRef.current = null;
      void streamStop(id);
    };
  }, [running, paused, active, conn, showToast]);

  useEffect(() => {
    if (!paused) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines, paused]);

  const start = () => {
    if (!conn) return;
    setRunning(true);
    showToast("Monitor started", "Every command hitting the server streams here. Heavy on busy servers.", "warn");
  };

  const stop = () => {
    setRunning(false);
    showToast("Monitor stopped", "");
  };

  const q = filter.trim().toLowerCase();
  const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  const tail = shown.slice(-TAIL_RENDER);

  return (
    <section className={`content ${active ? "active" : ""}`} style={{ gridTemplateRows: "46px minmax(0, 1fr)", background: "var(--editor-bg)" }}>
      <div className="index-searchbar" style={{ gridTemplateColumns: "auto auto minmax(180px, 1fr) auto auto" }}>
        {!running ? (
          <ToolButton variant="primary" disabled={!conn} onClick={start}>
            <Icon name="play" /> Start MONITOR
          </ToolButton>
        ) : (
          <ToolButton onClick={stop}>
            <Icon name="x" /> Stop
          </ToolButton>
        )}
        <ToolButton title={paused ? "Resume tail" : "Pause tail"} onClick={() => setPaused((v) => !v)}>
          <Icon name={paused ? "play" : "pause"} /> {paused ? "Resume" : "Pause"}
        </ToolButton>
        <input className="index-search" placeholder="Filter lines — GET, user:*, 127.0.0.1" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ToolButton iconOnly title="Clear" onClick={() => setLines([])}><Icon name="eraser" /></ToolButton>
        <Badge tone={running ? "green" : "idle"}>{running ? `live · ${lines.length}` : "idle"}</Badge>
      </div>
      <div ref={scrollRef} style={{ minHeight: 0, overflow: "auto", padding: "10px 14px", font: "0.9231rem/1.55 var(--font-mono)", userSelect: "text" }}>
        {shown.length === 0 && (
          <div className="empty-note" style={{ padding: 0 }}>
            {running ? "Waiting for commands…" : "MONITOR streams every command the server executes — useful for debugging, costly under load."}
          </div>
        )}
        {shown.length > TAIL_RENDER && (
          <div style={{ color: "var(--text-3)" }}>… {shown.length - TAIL_RENDER} older lines buffered (select-all copies only what is shown)</div>
        )}
        {tail.map((l, i) => (
          <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--editor-fg)" }}>{l}</div>
        ))}
      </div>
    </section>
  );
}
