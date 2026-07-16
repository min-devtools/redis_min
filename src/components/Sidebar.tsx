import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "../ui/Badge";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { useApp } from "../store";
import { useActiveConnection, useDatabases, useServerInfo } from "../lib/queries";
import { formatDocCount } from "../lib/format";
import type { TabKind } from "../lib/types";
import { Icon, type IconName } from "../ui/Icon";

const WORKSPACE_NAV: { kind: TabKind; icon: IconName; iconClass: string; label: string; meta?: string }[] = [
  { kind: "welcome", icon: "sparkles", iconClass: "soft-blue", label: "Welcome" },
  { kind: "keys", icon: "key", iconClass: "soft-orange", label: "Keys", meta: "⌘T" },
  { kind: "console", icon: "terminal", iconClass: "soft-green", label: "Console", meta: "⌘E" },
  { kind: "info", icon: "gauge", iconClass: "soft-green", label: "Server Info", meta: "⌘I" },
  { kind: "pubsub", icon: "radio", iconClass: "soft-orange", label: "Pub/Sub", meta: "⌘U" },
  { kind: "monitor", icon: "activity", iconClass: "soft-blue", label: "Monitor" },
  { kind: "settings", icon: "settings", iconClass: "soft-orange", label: "Settings", meta: "⌘," },
];

export function Sidebar() {
  const [filter, setFilter] = useState("");
  const [connMenu, setConnMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [keyMenu, setKeyMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const conn = useActiveConnection();
  const info = useServerInfo();
  const { dbs } = useDatabases();
  const queryClient = useQueryClient();
  const {
    connections, activeConnId, setActiveConn, deleteConnection, setEditingConn,
    tabs, activeTabId, openTab, activeDb, setActiveDb, showToast,
    openKeyTab, keyRecency,
  } = useApp();

  const activeKind = tabs.find((t) => t.id === activeTabId)?.kind;
  const q = filter.trim().toLowerCase();

  // show every db (Redis has 16 by default) — user wants the full list, empty or not
  const shownDbs = dbs;
  const recentKeys = (q ? keyRecency.filter((k) => k.toLowerCase().includes(q)) : keyRecency).slice(0, 6);

  const connMenuItems: ContextMenuItem[] = connMenu
    ? [
        {
          icon: "plug",
          label: "Connect",
          strong: true,
          onClick: () => {
            setActiveConn(connMenu.id);
            void queryClient.invalidateQueries();
          },
        },
        {
          icon: "pencil",
          label: "Edit connection",
          onClick: () => {
            setEditingConn(connMenu.id);
            openTab("connection");
          },
        },
        {
          icon: "trash",
          label: "Remove",
          onClick: () => {
            deleteConnection(connMenu.id);
            showToast("Connection removed", "Saved connection deleted from this workspace.");
          },
        },
      ]
    : [];

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <input
          className="side-search"
          placeholder="Search keys, databases"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="side-scroll">
        <div className="group">
          <div className="group-title"><span>Connections</span><span>{connections.length ? "saved" : ""}</span></div>
          <div
            className={`nav-item ${activeKind === "connection" ? "active" : ""}`}
            onClick={() => {
              setEditingConn(null);
              openTab("connection");
            }}
          >
            <Icon name="plus" className="soft-blue" /><span>New Connection</span><Badge>setup</Badge>
          </div>
          {connections.map((c) => (
            <div
              key={c.id}
              className={`nav-item ${c.id === activeConnId ? "active" : ""}`}
              onClick={() => {
                setActiveConn(c.id);
                void queryClient.invalidateQueries();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setConnMenu({ x: e.clientX, y: e.clientY, id: c.id });
              }}
            >
              <Icon name="status" className={c.id === activeConnId ? "soft-green" : undefined} />
              <span>{c.name}</span>
              <Badge tone={c.id === activeConnId ? (info.isError ? "red" : info.data ? "green" : "idle") : "idle"}>
                {c.id === activeConnId ? (info.isError ? "error" : info.data ? "up" : "connecting…") : "idle"}
              </Badge>
            </div>
          ))}
        </div>

        <div className="group">
          <div className="group-title"><span>Workspace</span><span /></div>
          {WORKSPACE_NAV.map((item) => (
            <div
              key={item.kind}
              className={`nav-item ${activeKind === item.kind ? "active" : ""}`}
              onClick={() => openTab(item.kind)}
            >
              <Icon name={item.icon} className={item.iconClass} />
              <span>{item.label}</span>
              <span>
                {item.meta?.startsWith("⌘") ? <span className="kbd">{item.meta}</span> : item.meta ?? ""}
              </span>
            </div>
          ))}
        </div>

        <div className="group">
          <div className="group-title">
            <span>Databases</span>
            <span>{info.data ? `${dbs.reduce((n, d) => n + d.keys, 0)} keys` : conn ? "…" : ""}</span>
          </div>
          {!conn && <div className="empty-note">Connect to a server to list databases.</div>}
          {conn &&
            shownDbs.map((d) => (
              <div
                key={d.db}
                className={`index-item ${d.db === activeDb ? "active" : ""}`}
                onClick={() => {
                  setActiveDb(d.db);
                  void queryClient.invalidateQueries({ queryKey: ["keys"] });
                }}
                onDoubleClick={() => {
                  setActiveDb(d.db);
                  openTab("keys");
                }}
                title="Double-click to browse keys"
              >
                <span className="index-dot" />
                <span>db{d.db}</span>
                <span>{formatDocCount(d.keys)}</span>
              </div>
            ))}
        </div>

        {conn && keyRecency.length > 0 && (
          <div className="group">
            <div className="group-title"><span>Recent keys</span><span /></div>
            {recentKeys.map((k) => (
              <div
                key={k}
                className="index-item"
                onClick={() => openKeyTab(k)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setKeyMenu({ x: e.clientX, y: e.clientY, key: k });
                }}
                title={k}
              >
                <span className="index-dot" />
                <span>{k}</span>
                <span />
              </div>
            ))}
          </div>
        )}
      </div>
      {connMenu && (
        <ContextMenu x={connMenu.x} y={connMenu.y} items={connMenuItems} onClose={() => setConnMenu(null)} />
      )}
      {keyMenu && (
        <ContextMenu
          x={keyMenu.x}
          y={keyMenu.y}
          onClose={() => setKeyMenu(null)}
          items={[
            { icon: "braces", label: "Open key", strong: true, onClick: () => openKeyTab(keyMenu.key) },
            { icon: "key", label: "Browse all keys", onClick: () => openTab("keys") },
          ]}
        />
      )}
    </aside>
  );
}
