import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import { useDatabases } from "../lib/queries";
import { Icon, type IconName } from "../ui/Icon";

interface Command {
  icon: IconName;
  label: string;
  kbd?: string;
  action: () => void;
}

export function CommandPalette() {
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { dbs } = useDatabases();
  const app = useApp();

  useEffect(() => {
    if (app.commandOpen) {
      setInput("");
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [app.commandOpen]);

  const commands = useMemo<Command[]>(() => {
    const base: Command[] = [
      { icon: "key", label: "Browse keys", kbd: "⌘T", action: () => app.openTab("keys") },
      { icon: "terminal", label: "Open console", kbd: "⌘E", action: () => app.openTab("console") },
      { icon: "plus", label: "New key", kbd: "⌘N", action: () => app.openKeyTab("", true) },
      { icon: "gauge", label: "Server info", kbd: "⌘I", action: () => app.openTab("info") },
      { icon: "radio", label: "Pub/Sub", kbd: "⌘U", action: () => app.openTab("pubsub") },
      { icon: "activity", label: "Monitor", action: () => app.openTab("monitor") },
      { icon: "plug", label: "New Redis connection", action: () => { app.setEditingConn(null); app.openTab("connection"); } },
      { icon: "panel-left", label: "Toggle left sidebar", kbd: "⌘B", action: () => app.toggleLeft() },
      { icon: "panel-right", label: "Toggle right inspector", kbd: "⌘R", action: () => app.toggleRight() },
      { icon: "settings", label: "Open Settings", kbd: "⌘,", action: () => app.openTab("settings") },
      { icon: "moon", label: "Toggle theme", action: () => app.toggleTheme() },
      { icon: "rows", label: "Toggle compact density", action: () => app.toggleCompact() },
    ];
    for (const c of app.connections) {
      base.push({
        icon: "plug",
        label: `Switch connection: ${c.name}`,
        action: () => app.setActiveConn(c.id),
      });
    }
    for (const d of dbs) {
      if (d.keys === 0 && d.db > 3) continue;
      base.push({
        icon: "database",
        label: `Switch database: db${d.db} (${d.keys} keys)`,
        action: () => {
          app.setActiveDb(d.db);
          app.openTab("keys");
        },
      });
    }
    for (const k of app.keyRecency.slice(0, 20)) {
      base.push({
        icon: "braces",
        label: `Open key: ${k}`,
        action: () => app.openKeyTab(k),
      });
    }
    return base;
  }, [app, dbs]);

  const filtered = useMemo(() => {
    const q = input.trim().toLowerCase();
    return (q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands).slice(0, 12);
  }, [commands, input]);

  if (!app.commandOpen) return null;

  const runCommand = (cmd: Command) => {
    app.setCommandOpen(false);
    cmd.action();
  };

  return (
    <div
      className="command"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) app.setCommandOpen(false);
      }}
    >
      <div className="palette">
        <input
          ref={inputRef}
          value={input}
          placeholder="Run command, open key, switch database..."
          onChange={(e) => {
            setInput(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(filtered.length - 1, c + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            }
            if (e.key === "Enter" && filtered[cursor]) runCommand(filtered[cursor]);
            if (e.key === "Escape") app.setCommandOpen(false);
          }}
        />
        <div className="cmd-list">
          {filtered.map((cmd, i) => (
            <div
              key={cmd.label}
              className={`cmd ${i === cursor ? "active" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => runCommand(cmd)}
            >
              <Icon name={cmd.icon} size={15} />
              <span>{cmd.label}</span>
              {cmd.kbd ? <span className="kbd">{cmd.kbd}</span> : <span />}
            </div>
          ))}
          {filtered.length === 0 && <div className="empty-note">No matching commands.</div>}
        </div>
      </div>
    </div>
  );
}
