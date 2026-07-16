import { ToolButton } from "../../ui/ToolButton";
import { Icon, type IconName } from "../../ui/Icon";
import { useApp } from "../../store";
import { useActiveConnection } from "../../lib/queries";

export function WelcomeView({ active }: { active: boolean }) {
  const conn = useActiveConnection();
  const { openTab, setEditingConn, openKeyTab } = useApp();

  const newConnection = () => {
    setEditingConn(null);
    openTab("connection");
  };

  const actions: { icon: IconName; label: string; desc: string; onClick: () => void }[] = [
    { icon: "key", label: "Browse keys", desc: "SCAN with patterns, tree by namespace, TTLs.", onClick: () => openTab("keys") },
    { icon: "terminal", label: "Console", desc: "Full REPL — any command, history, completion.", onClick: () => openTab("console") },
    { icon: "plus", label: "New key", desc: "String, hash, list, set, zset or stream.", onClick: () => openKeyTab("", true) },
    { icon: "gauge", label: "Server info", desc: "Memory, clients, slowlog, live config.", onClick: () => openTab("info") },
    { icon: "radio", label: "Pub/Sub", desc: "Tail channels and publish messages.", onClick: () => openTab("pubsub") },
    { icon: "activity", label: "Monitor", desc: "Stream every command hitting the server.", onClick: () => openTab("monitor") },
  ];

  return (
    <section className={`content welcome-view ${active ? "active" : ""}`}>
      <div className="welcome-shell">
        <div className="welcome-hero">
          <div className="welcome-copy">
            <div className="welcome-kicker">
              {conn ? `connected · ${conn.name}` : "no active connection"}
            </div>
            <h1 className="welcome-title">RedisMin</h1>
            <p className="welcome-text">
              {conn
                ? "You're connected. Browse keys, edit values, run console commands or watch the server live."
                : "A tiny Redis/Valkey client. Connect to a server to browse keys, edit every data type, and inspect what the server is doing."}
            </p>
            <div className="welcome-actions">
              <ToolButton variant="primary" onClick={conn ? () => openTab("keys") : newConnection}>
                <Icon name={conn ? "key" : "zap"} /> {conn ? "Browse keys" : "New connection"}
              </ToolButton>
              <ToolButton onClick={conn ? newConnection : () => openTab("keys")}>
                <Icon name={conn ? "zap" : "key"} /> {conn ? "Manage connection" : "Browse keys"}
              </ToolButton>
            </div>
          </div>
        </div>

        <div className="welcome-launch">
          {actions.map((a) => (
            <button type="button" className="welcome-card" key={a.label} onClick={a.onClick}>
              <span className="welcome-card-icon"><Icon name={a.icon} size={18} /></span>
              <strong>{a.label}</strong>
              <span className="welcome-card-desc">{a.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
