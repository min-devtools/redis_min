import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
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
  { kind: "console", icon: "terminal", iconClass: "soft-green", label: "Console", meta: "⌘⇧C" },
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
    setConnections, saveConnection, openDialog,
    tabs, activeTabId, openTab, activeDb, setActiveDb, showToast,
    openKeyTab, keyRecency,
  } = useApp(useShallow((s) => ({
    connections: s.connections, activeConnId: s.activeConnId, setActiveConn: s.setActiveConn,
    deleteConnection: s.deleteConnection, setEditingConn: s.setEditingConn, setConnections: s.setConnections,
    saveConnection: s.saveConnection, openDialog: s.openDialog,
    tabs: s.tabs, activeTabId: s.activeTabId, openTab: s.openTab, activeDb: s.activeDb,
    setActiveDb: s.setActiveDb, showToast: s.showToast, openKeyTab: s.openKeyTab, keyRecency: s.keyRecency,
  })));
  // drag-reorder state for the Connections group — pattern matches TabsBar / requests_min
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null);

  const activeKind = tabs.find((t) => t.id === activeTabId)?.kind;
  const q = filter.trim().toLowerCase();

  const reorderConn = (from: string, beforeId: string | null) => {
    if (from === beforeId) return;
    const dragged = connections.find((c) => c.id === from);
    if (!dragged) return;
    const rest = connections.filter((c) => c.id !== from);
    const idx = beforeId ? rest.findIndex((c) => c.id === beforeId) : -1;
    setConnections(idx < 0 ? [...rest, dragged] : [...rest.slice(0, idx), dragged, ...rest.slice(idx)]);
  };
  const draggedConnId = (event: React.DragEvent) =>
    event.dataTransfer.getData("application/x-redismin-conn") || dragId;

  // show every db (Redis has 16 by default) — user wants the full list, empty or not
  const shownDbs = dbs;
  const recentKeys = (q ? keyRecency.filter((k) => k.toLowerCase().includes(q)) : keyRecency).slice(0, 6);

  // ⌘E / ⌘D / ⌘⌫ on the active connection — see design-systems/SHORTCUTS.md
  const editConn = (id: string) => {
    setEditingConn(id);
    openTab("connection");
  };
  const duplicateConn = (id: string) => {
    const c = connections.find((x) => x.id === id);
    if (!c) return;
    const copy = { ...c, id: crypto.randomUUID(), name: `${c.name} copy` };
    saveConnection(copy);
    showToast("Connection duplicated", copy.name);
  };
  const removeConn = async (id: string) => {
    const c = connections.find((x) => x.id === id);
    const ok = await openDialog({
      kind: "confirm",
      title: "Remove connection?",
      message: `"${c?.name ?? id}" and its stored credentials will be deleted.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (ok === null) return;
    deleteConnection(id);
    showToast("Connection removed", "Saved connection deleted from this workspace.");
  };

  // WebKit (Tauri macOS) doesn't focus rows on click, so per-node onKeyDown won't fire.
  // Listen globally and act on the active connection; stay out of inputs and open dialogs.
  useEffect(() => {
    if (!activeConnId) return;
    const onKey = (event: KeyboardEvent) => {
      if (useApp.getState().dialog) return;
      const el = document.activeElement as HTMLElement | null;
      const editable = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (editable) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "d") { event.preventDefault(); duplicateConn(activeConnId); }
      else if (key === "e") { event.preventDefault(); editConn(activeConnId); }
      // ⌘⌫ only — a plain Backspace outside inputs is too easy to hit by accident
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); void removeConn(activeConnId); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnId, connections]);

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
        { icon: "pencil", label: "Edit connection", kbd: "⌘E", onClick: () => editConn(connMenu.id) },
        { icon: "copy", label: "Duplicate", kbd: "⌘D", onClick: () => duplicateConn(connMenu.id) },
        { icon: "trash", label: "Remove", kbd: "⌘⌫", onClick: () => void removeConn(connMenu.id) },
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
              draggable
              className={`nav-item ${c.id === activeConnId ? "active" : ""} ${dragId === c.id ? "dragging" : ""} ${dropTarget?.id === c.id && dragId && dragId !== c.id ? (dropTarget.before ? "drop-before" : "drop-after") : ""}`}
              onClick={() => {
                setActiveConn(c.id);
                void queryClient.invalidateQueries();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setConnMenu({ x: e.clientX, y: e.clientY, id: c.id });
              }}
              onDragStart={(e) => {
                setDragId(c.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("application/x-redismin-conn", c.id);
              }}
              onDragEnd={() => { setDragId(null); setDropTarget(null); }}
              onDragOver={(e) => {
                if (!dragId || dragId === c.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = e.currentTarget.getBoundingClientRect();
                setDropTarget({ id: c.id, before: e.clientY < rect.top + rect.height / 2 });
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDropTarget((t) => (t?.id === c.id ? null : t));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = draggedConnId(e);
                if (id && id !== c.id) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const before = e.clientY < rect.top + rect.height / 2;
                  const nextId = before
                    ? c.id
                    : connections[connections.findIndex((cc) => cc.id === c.id) + 1]?.id ?? null;
                  reorderConn(id, nextId);
                }
                setDragId(null);
                setDropTarget(null);
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
