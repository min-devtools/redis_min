import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Badge } from "../../ui/Badge";
import { ToolButton } from "../../ui/ToolButton";
import { Icon } from "../../ui/Icon";
import { useApp } from "../../store";
import { useActiveConnection } from "../../lib/queries";
import { exec, streamStop, subscribeStart } from "../../lib/redis";
import type { PubSubMsg } from "../../lib/types";

const MSG_CAP = 5000;

export function PubSubView({ active }: { active: boolean }) {
  const conn = useActiveConnection();
  const { showToast } = useApp();
  const [channels, setChannels] = useState("");
  const [patterns, setPatterns] = useState("");
  const [subId, setSubId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PubSubMsg[]>([]);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [pubChannel, setPubChannel] = useState("");
  const [pubPayload, setPubPayload] = useState("");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const subRef = useRef<string | null>(null);
  subRef.current = subId;

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<PubSubMsg>("redis-pubsub-message", (e) => {
      if (e.payload.subId !== subRef.current || pausedRef.current) return;
      setMessages((ms) => [...ms.slice(-MSG_CAP), e.payload]);
    }).then((u) => (unlisten = u));
    return () => {
      unlisten?.();
      if (subRef.current) void streamStop(subRef.current);
    };
  }, []);

  const start = async () => {
    if (!conn) return;
    const chs = channels.split(",").map((s) => s.trim()).filter(Boolean);
    const pats = patterns.split(",").map((s) => s.trim()).filter(Boolean);
    if (!chs.length && !pats.length) {
      showToast("Nothing to subscribe", "Enter at least one channel or pattern.", "warn");
      return;
    }
    const id = crypto.randomUUID();
    try {
      await subscribeStart(conn, id, chs, pats);
      setSubId(id);
      showToast("Subscribed", [...chs, ...pats].join(", "));
    } catch (err) {
      showToast("Subscribe failed", String(err), "err");
    }
  };

  const stop = async () => {
    if (subId) {
      await streamStop(subId);
      setSubId(null);
      showToast("Unsubscribed", "Stream stopped.");
    }
  };

  const publish = async () => {
    if (!conn || !pubChannel.trim()) return;
    try {
      const n = await exec<number>(conn, 0, ["PUBLISH", pubChannel.trim(), pubPayload]);
      showToast("Published", `${pubChannel.trim()} → ${n} subscriber${n === 1 ? "" : "s"}`);
    } catch (err) {
      showToast("Publish failed", String(err), "err");
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = q
    ? messages.filter((m) => m.channel.toLowerCase().includes(q) || m.payload.toLowerCase().includes(q))
    : messages;

  return (
    <section className={`content ${active ? "active" : ""}`} style={{ gridTemplateRows: "46px 46px minmax(0, 1fr)", background: "var(--window)" }}>
      <div className="index-searchbar" style={{ gridTemplateColumns: "minmax(180px, 1fr) minmax(180px, 1fr) auto auto auto" }}>
        <input
          className="index-search"
          placeholder="Channels: orders, alerts"
          value={channels}
          disabled={!!subId}
          onChange={(e) => setChannels(e.target.value)}
          spellCheck={false}
        />
        <input
          className="index-search"
          placeholder="Patterns: user:* , events.*"
          value={patterns}
          disabled={!!subId}
          onChange={(e) => setPatterns(e.target.value)}
          spellCheck={false}
        />
        {!subId ? (
          <ToolButton variant="primary" disabled={!conn} onClick={() => void start()}>
            <Icon name="radio" /> Subscribe
          </ToolButton>
        ) : (
          <ToolButton onClick={() => void stop()}>
            <Icon name="x" /> Stop
          </ToolButton>
        )}
        <ToolButton title={paused ? "Resume tail" : "Pause tail"} onClick={() => setPaused((v) => !v)}>
          <Icon name={paused ? "play" : "pause"} /> {paused ? "Resume" : "Pause"}
        </ToolButton>
        <Badge tone={subId ? "green" : "idle"}>{subId ? `live · ${messages.length}` : "idle"}</Badge>
      </div>

      <div className="index-searchbar" style={{ gridTemplateColumns: "minmax(140px, 240px) minmax(180px, 1fr) auto minmax(120px, 240px) auto" }}>
        <input className="index-search" placeholder="Publish channel" value={pubChannel} onChange={(e) => setPubChannel(e.target.value)} spellCheck={false} />
        <input
          className="index-search"
          placeholder="Message payload"
          value={pubPayload}
          onChange={(e) => setPubPayload(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void publish()}
          spellCheck={false}
        />
        <ToolButton disabled={!conn || !pubChannel.trim()} onClick={() => void publish()}>
          <Icon name="send" /> Publish
        </ToolButton>
        <input className="index-search" placeholder="Filter tail" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ToolButton iconOnly title="Clear messages" onClick={() => setMessages([])}><Icon name="eraser" /></ToolButton>
      </div>

      <div className="index-table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 110 }}>Time</th>
              <th style={{ width: 200 }}>Channel</th>
              <th style={{ width: 160 }}>Pattern</th>
              <th>Payload</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice().reverse().map((m, i) => (
              <tr key={`${m.ts}-${i}`}>
                <td style={{ fontFamily: "var(--font-mono)" }}>{new Date(m.ts).toLocaleTimeString()}</td>
                <td style={{ fontFamily: "var(--font-mono)", color: "var(--blue)" }}>{m.channel}</td>
                <td style={{ fontFamily: "var(--font-mono)", color: "var(--text-3)" }}>{m.pattern ?? "—"}</td>
                <td style={{ fontFamily: "var(--font-mono)", maxWidth: 560, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.payload}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={4}>
                  {subId ? "Waiting for messages…" : "Subscribe to channels or patterns to tail messages — publishing works without subscribing."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
