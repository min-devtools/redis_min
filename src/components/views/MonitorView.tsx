import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Badge } from "../../ui/Badge";
import { ToolButton } from "../../ui/ToolButton";
import { Icon } from "../../ui/Icon";
import { useApp } from "../../store";
import { useActiveConnection } from "../../lib/queries";
import { monitorStart, streamStop } from "../../lib/redis";
import type { MonitorEvent } from "../../lib/types";

const LINE_CAP = 10_000;

export function MonitorView({ active }: { active: boolean }) {
  const conn = useActiveConnection();
  const { showToast } = useApp();
  const [monitorId, setMonitorId] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const idRef = useRef<string | null>(null);
  idRef.current = monitorId;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<MonitorEvent>("redis-monitor-line", (e) => {
      if (e.payload.monitorId !== idRef.current || pausedRef.current) return;
      setLines((ls) => [...ls.slice(-LINE_CAP), e.payload.line]);
    }).then((u) => (unlisten = u));
    return () => {
      unlisten?.();
      if (idRef.current) void streamStop(idRef.current);
    };
  }, []);

  useEffect(() => {
    if (!paused) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines, paused]);

  const start = async () => {
    if (!conn) return;
    const id = crypto.randomUUID();
    try {
      await monitorStart(conn, id);
      setMonitorId(id);
      showToast("Monitor started", "Every command hitting the server streams here. Heavy on busy servers.", "warn");
    } catch (err) {
      showToast("Monitor failed", String(err), "err");
    }
  };

  const stop = async () => {
    if (monitorId) {
      await streamStop(monitorId);
      setMonitorId(null);
      showToast("Monitor stopped", "");
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;

  return (
    <section className={`content ${active ? "active" : ""}`} style={{ gridTemplateRows: "46px minmax(0, 1fr)", background: "var(--editor-bg)" }}>
      <div className="index-searchbar" style={{ gridTemplateColumns: "auto auto minmax(180px, 1fr) auto auto" }}>
        {!monitorId ? (
          <ToolButton variant="primary" disabled={!conn} onClick={() => void start()}>
            <Icon name="play" /> Start MONITOR
          </ToolButton>
        ) : (
          <ToolButton onClick={() => void stop()}>
            <Icon name="x" /> Stop
          </ToolButton>
        )}
        <ToolButton title={paused ? "Resume tail" : "Pause tail"} onClick={() => setPaused((v) => !v)}>
          <Icon name={paused ? "play" : "pause"} /> {paused ? "Resume" : "Pause"}
        </ToolButton>
        <input className="index-search" placeholder="Filter lines — GET, user:*, 127.0.0.1" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ToolButton iconOnly title="Clear" onClick={() => setLines([])}><Icon name="eraser" /></ToolButton>
        <Badge tone={monitorId ? "green" : "idle"}>{monitorId ? `live · ${lines.length}` : "idle"}</Badge>
      </div>
      <div ref={scrollRef} style={{ minHeight: 0, overflow: "auto", padding: "10px 14px", font: "0.9231rem/1.55 var(--font-mono)", userSelect: "text" }}>
        {shown.length === 0 && (
          <div className="empty-note" style={{ padding: 0 }}>
            {monitorId ? "Waiting for commands…" : "MONITOR streams every command the server executes — useful for debugging, costly under load."}
          </div>
        )}
        {shown.map((l, i) => (
          <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--editor-fg)" }}>{l}</div>
        ))}
      </div>
    </section>
  );
}
