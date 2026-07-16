import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Kv } from "../ui/Kv";
import { MiniTabs } from "../ui/MiniTabs";
import { ToolButton } from "../ui/ToolButton";
import { Icon } from "../ui/Icon";
import { JsonView } from "../ui/JsonView";
import { useApp } from "../store";
import { useActiveConnection } from "../lib/queries";
import { exec } from "../lib/redis";
import { formatBytes } from "../lib/format";
import { formatTtl } from "../lib/keyFormat";

/** small, type-appropriate sample of a key's value for the preview pane */
async function previewValue(conn: any, db: number, key: string, type: string): Promise<unknown> {
  switch (type) {
    case "string": {
      const v = await exec<string | null>(conn, db, ["GETRANGE", key, "0", "9999"]);
      try {
        return JSON.parse(v ?? "");
      } catch {
        return v;
      }
    }
    case "hash": {
      const r = await exec<[string, string[]]>(conn, db, ["HSCAN", key, "0", "COUNT", "60"]);
      const flat = r[1] ?? [];
      const obj: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
      return obj;
    }
    case "list":
      return exec(conn, db, ["LRANGE", key, "0", "49"]);
    case "set": {
      const r = await exec<[string, string[]]>(conn, db, ["SSCAN", key, "0", "COUNT", "60"]);
      return r[1] ?? [];
    }
    case "zset":
      return exec(conn, db, ["ZRANGE", key, "0", "49", "WITHSCORES"]);
    case "stream":
      return exec(conn, db, ["XREVRANGE", key, "+", "-", "COUNT", "20"]);
    case "ReJSON-RL":
      try {
        return JSON.parse(await exec<string>(conn, db, ["JSON.GET", key]));
      } catch {
        return null;
      }
    default:
      return null;
  }
}

export function Inspector() {
  const [pane, setPane] = useState("value");
  const { selectedKey, showToast, activeDb, openKeyTab } = useApp();
  const conn = useActiveConnection();

  const preview = useQuery({
    queryKey: ["key-preview", conn?.id, activeDb, selectedKey?.key, selectedKey?.type],
    queryFn: () => previewValue(conn!, activeDb, selectedKey!.key, selectedKey!.type),
    enabled: !!conn && !!selectedKey,
    staleTime: 5_000,
  });

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <div className="doc-title">
          <strong>{selectedKey ? selectedKey.key : "no key"}</strong>
          <span>
            {selectedKey
              ? `${selectedKey.type} · db${activeDb} · ${formatTtl(selectedKey.ttl)}`
              : "select a key to inspect"}
          </span>
        </div>
      </div>
      <MiniTabs
        tabs={[
          { id: "value", label: "Value" },
          { id: "meta", label: "Metadata" },
        ]}
        active={pane}
        onChange={setPane}
      />
      {pane === "value" && (
        <div className="inspector-scroll">
          {!selectedKey && <div className="empty-note">Browse keys and click a row — a value preview shows here.</div>}
          {selectedKey && (
            <>
              {preview.isLoading && <div className="empty-note">Loading preview…</div>}
              {preview.data !== undefined &&
                (typeof preview.data === "string" ? (
                  // plain (non-JSON) string — show as text, a JSON tree here reads wrong
                  <pre className="inspector-text">{preview.data}</pre>
                ) : (
                  <JsonView className="create-preview json-tree" value={preview.data ?? null} />
                ))}
              <div className="seg" style={{ padding: "8px 12px", gap: 8 }}>
                <ToolButton onClick={() => openKeyTab(selectedKey.key)}>
                  <Icon name="braces" /> Open editor
                </ToolButton>
                <ToolButton
                  onClick={async () => {
                    await writeText(selectedKey.key);
                    showToast("Copied", "Key name copied to clipboard.");
                  }}
                >
                  <Icon name="copy" /> Copy name
                </ToolButton>
              </div>
            </>
          )}
        </div>
      )}
      {pane === "meta" && (
        <div className="inspector-scroll">
          {!selectedKey && <div className="empty-note">No key selected.</div>}
          {selectedKey && (
            <div className="panel">
              <h3>Metadata</h3>
              <Kv label="key">{selectedKey.key}</Kv>
              <Kv label="type">{selectedKey.type}</Kv>
              <Kv label="ttl">{formatTtl(selectedKey.ttl)}</Kv>
              <Kv label="encoding">{selectedKey.encoding ?? "—"}</Kv>
              <Kv label="memory">{selectedKey.memory != null ? formatBytes(selectedKey.memory) : "—"}</Kv>
              <Kv label="length">{selectedKey.length ?? "—"}</Kv>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
