import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "../store";
import { useActiveConnection, useDatabases, useServerInfo } from "../lib/queries";

export function Statusbar() {
  const conn = useActiveConnection();
  const info = useServerInfo();
  const { dbs } = useDatabases();
  const { tabs, activeTabId, activeDb, openTab, setEditingConn } = useApp();

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const statusColor = !conn
    ? "var(--orange)"
    : info.isError
      ? "var(--red)"
      : info.data
        ? "var(--green)"
        : "var(--orange)";

  const mem = info.data?.memory?.used_memory_human;
  const clients = info.data?.clients?.connected_clients;
  const dbKeys = dbs.find((d) => d.db === activeDb)?.keys ?? 0;

  return (
    <footer className="statusbar">
      <div>
        <span
          style={{ cursor: "pointer" }}
          title="Open connection settings"
          onClick={() => {
            setEditingConn(conn?.id ?? null);
            openTab("connection");
          }}
        >
          {conn ? conn.name : "no connection"}
        </span>
        <span style={{ color: statusColor }}>
          {!conn ? "setup required" : info.isError ? "unreachable" : info.data ? "connected" : "connecting…"}
        </span>
      </div>
      <div>
        <span
          style={{ cursor: "pointer" }}
          title="Browse keys (⌘T)"
          onClick={() => openTab("keys")}
        >
          db{activeDb}
        </span>
        <span>{`${dbKeys} keys`}</span>
      </div>
      <div className="right-status">
        <span>{mem ? `mem ${mem}` : ""}</span>
        <span>{clients ? `${clients} clients` : ""}</span>
        <span>{activeTab?.title ?? ""}</span>
        <span>v{__APP_VERSION__}</span>
        <span
          className="credit"
          style={{ cursor: "pointer" }}
          title="Created by @ngthminhdev — open LinkedIn"
          onClick={() => openUrl("https://www.linkedin.com/in/ngthminh-dev/")}
        >
          by @ngthminhdev
        </span>
      </div>
    </footer>
  );
}
