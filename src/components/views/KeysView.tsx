import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Badge } from "../../ui/Badge";
import { ToolButton } from "../../ui/ToolButton";
import { Icon } from "../../ui/Icon";
import { SortTh } from "../../ui/SortTh";
import { useSortedRows } from "../../lib/useSort";
import { ContextMenu } from "../../ui/ContextMenu";
import { useApp } from "../../store";
import { useActiveConnection, useDatabases } from "../../lib/queries";
import { annotateKeys, exec, keyMeta, scanKeys } from "../../lib/redis";
import { buildKeyTree, formatTtl, typeTone } from "../../lib/keyFormat";
import { formatDocCount } from "../../lib/format";
import type { KeyRow } from "../../lib/types";

const PAGE_COUNT = 100;
const TYPES = ["", "string", "hash", "list", "set", "zset", "stream"];

export function KeysView({ active }: { active: boolean }) {
  const conn = useActiveConnection();
  const { dbs } = useDatabases();
  const queryClient = useQueryClient();
  const {
    activeDb, openKeyTab, selectKey, selectedKey, showToast, openDialog, bumpKeyRecency,
  } = useApp();

  const [pattern, setPattern] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [tree, setTree] = useState(true);
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null); // null = not started, "0" = done
  const [scanning, setScanning] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; key?: string; prefix?: string; count?: number } | null>(null);
  const scanSeq = useRef(0);

  const dbTotal = dbs.find((d) => d.db === activeDb)?.keys ?? 0;

  const runScan = async (reset: boolean, all = false) => {
    if (!conn || scanning) return;
    const seq = ++scanSeq.current;
    setScanning(true);
    try {
      let cur = reset ? "0" : cursor ?? "0";
      if (reset) setRows([]);
      const seen = new Set(reset ? [] : rows.map((r) => r.key));
      // keep scanning until we gather a page worth of keys or the cursor wraps;
      // append each SCAN batch to the table as it arrives (progressive paging)
      let fetched = 0;
      do {
        const page = await scanKeys(conn, activeDb, cur, pattern, PAGE_COUNT, typeFilter || undefined);
        cur = page.cursor;
        if (page.keys.length) {
          const annotated = await annotateKeys(conn, activeDb, page.keys);
          if (seq !== scanSeq.current) return; // superseded by a newer scan
          const fresh = annotated.filter((r) => !seen.has(r.key));
          fresh.forEach((r) => seen.add(r.key));
          if (fresh.length) setRows((prev) => [...prev, ...fresh]);
          fetched += page.keys.length;
        }
        setCursor(cur);
      } while (cur !== "0" && (all || fetched < PAGE_COUNT));
    } catch (err) {
      if (seq === scanSeq.current) showToast("Scan failed", String(err), "err");
    } finally {
      if (seq === scanSeq.current) setScanning(false);
    }
  };

  // first page on mount / connection / db switch; re-scan on pattern or type change (debounced)
  useEffect(() => {
    if (!conn) return;
    setRows([]);
    setCursor(null);
    const t = window.setTimeout(() => void runScan(true), pattern ? 250 : 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id, activeDb, pattern, typeFilter]);

  // ⌘↵ / titlebar play — rescan when this tab is active
  const runNonce = useApp((s) => s.runNonce);
  const prevNonce = useRef(runNonce);
  useEffect(() => {
    if (runNonce !== prevNonce.current) {
      prevNonce.current = runNonce;
      if (active && !scanning) {
        void queryClient.invalidateQueries({ queryKey: ["server-info"] });
        void runScan(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runNonce, active]);

  const { sorted, sort, cycleSort } = useSortedRows<KeyRow>(rows, (r, col) =>
    col === "key" ? r.key : col === "type" ? r.type : r.ttl,
  );

  const treeNodes = useMemo(
    () => (tree ? buildKeyTree(rows.map((r) => r.key), ":", collapsed) : []),
    [tree, rows, collapsed],
  );
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  const pick = async (key: string) => {
    if (!conn) return;
    try {
      selectKey(await keyMeta(conn, activeDb, key));
    } catch (err) {
      showToast("Inspect failed", String(err), "err");
    }
  };

  const open = (key: string) => {
    bumpKeyRecency(key);
    openKeyTab(key);
  };

  const removeKey = async (key: string) => {
    if (!conn) return;
    const ok = await openDialog({
      kind: "confirm",
      title: `Delete key "${key}"`,
      message: "The key and its value are removed from the server.",
      confirmLabel: "Delete key",
      danger: true,
    });
    if (!ok) return;
    try {
      await exec(conn, activeDb, ["DEL", key]);
      setRows((rs) => rs.filter((r) => r.key !== key));
      if (selectedKey?.key === key) selectKey(null);
      showToast("Key deleted", key);
      void queryClient.invalidateQueries({ queryKey: ["server-info"] });
    } catch (err) {
      showToast("Delete failed", String(err), "err");
    }
  };

  /** delete every key under a namespace prefix — SCAN + DEL in batches */
  const removePrefix = async (prefix: string) => {
    if (!conn) return;
    const ok = await openDialog({
      kind: "confirm",
      title: `Delete namespace "${prefix}*"`,
      message: "Every key matching this prefix is scanned and deleted. This cannot be undone.",
      confirmLabel: "Delete all",
      danger: true,
    });
    if (!ok) return;
    try {
      let cur = "0";
      let deleted = 0;
      do {
        const page = await scanKeys(conn, activeDb, cur, `${prefix}*`, 1000);
        cur = page.cursor;
        if (page.keys.length) {
          await exec(conn, activeDb, ["DEL", ...page.keys]);
          deleted += page.keys.length;
        }
      } while (cur !== "0");
      setRows((rs) => rs.filter((r) => !r.key.startsWith(prefix)));
      showToast("Namespace deleted", `${deleted} keys removed under ${prefix}*`);
      void queryClient.invalidateQueries({ queryKey: ["server-info"] });
    } catch (err) {
      showToast("Delete failed", String(err), "err");
    }
  };

  const editTtl = async (key: string) => {
    if (!conn) return;
    const v = await openDialog({
      kind: "prompt",
      title: `TTL for "${key}"`,
      message: "Seconds until expiry — empty or -1 removes the expiry (PERSIST).",
      defaultValue: String(rowByKey.get(key)?.ttl ?? ""),
      confirmLabel: "Apply",
    });
    if (v === null) return;
    try {
      const n = Number(v.trim());
      if (v.trim() === "" || n < 0) await exec(conn, activeDb, ["PERSIST", key]);
      else await exec(conn, activeDb, ["EXPIRE", key, String(Math.floor(n))]);
      const meta = await annotateKeys(conn, activeDb, [key]);
      setRows((rs) => rs.map((r) => (r.key === key ? meta[0] : r)));
      showToast("TTL updated", key);
    } catch (err) {
      showToast("TTL failed", String(err), "err");
    }
  };

  const renameKey = async (key: string) => {
    if (!conn) return;
    const v = await openDialog({
      kind: "prompt",
      title: `Rename "${key}"`,
      defaultValue: key,
      confirmLabel: "Rename",
    });
    if (!v || v === key) return;
    try {
      await exec(conn, activeDb, ["RENAME", key, v]);
      void runScan(true);
      showToast("Renamed", `${key} → ${v}`);
    } catch (err) {
      showToast("Rename failed", String(err), "err");
    }
  };

  const renderRow = (r: KeyRow, depth = 0, label?: string) => (
    <tr
      key={r.key}
      className={selectedKey?.key === r.key ? "selected" : ""}
      onClick={() => void pick(r.key)}
      onDoubleClick={() => open(r.key)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, key: r.key });
      }}
      title="Double-click to open editor · right-click for menu"
    >
      <td style={{ paddingLeft: depth ? 12 + depth * 18 : undefined, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 520, fontFamily: "var(--font-mono)" }}>
        {label ?? r.key}
      </td>
      <td><Badge tone={typeTone(r.type)}>{r.type}</Badge></td>
      <td style={{ color: r.ttl >= 0 ? "var(--orange)" : "var(--text-3)", fontFamily: "var(--font-mono)" }}>
        {formatTtl(r.ttl)}
      </td>
    </tr>
  );

  return (
    <section className={`content indexes-view ${active ? "active" : ""}`}>
      <div className="index-searchbar" style={{ position: "relative", gridTemplateColumns: "minmax(240px, 420px) auto auto auto 1fr auto" }}>
        <input
          className="index-search"
          placeholder="Match pattern — user:* , *session* , order:*:items"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          spellCheck={false}
        />
        <select className="index-search" style={{ width: 110 }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          {TYPES.map((t) => <option key={t} value={t}>{t || "all types"}</option>)}
        </select>
        <ToolButton title={tree ? "Flat list" : "Group by : namespaces"} onClick={() => setTree((v) => !v)}>
          <Icon name={tree ? "list" : "folder"} /> {tree ? "flat" : "tree"}
        </ToolButton>
        <ToolButton disabled={!conn} onClick={() => openKeyTab("", true)}>
          <Icon name="plus" /> New key
        </ToolButton>
        <span />
        <Badge>
          {conn
            ? scanning
              ? "scanning…"
              : `${rows.length}${cursor && cursor !== "0" ? "+" : ""} / ${formatDocCount(dbTotal)} keys`
            : "no connection"}
        </Badge>
        <div className={`req-progress ${scanning ? "on" : ""}`}><span /></div>
      </div>
      <div className="index-table-wrap">
        {!conn && <div className="empty-note">Connect to a server to browse keys.</div>}
        {conn && (
          <table>
            <thead>
              <tr>
                <SortTh col="key" sort={sort} onSort={cycleSort}>Key</SortTh>
                <SortTh col="type" sort={sort} onSort={cycleSort} style={{ width: 110 }}>Type</SortTh>
                <SortTh col="ttl" sort={sort} onSort={cycleSort} style={{ width: 140 }}>TTL</SortTh>
              </tr>
            </thead>
            <tbody>
              {tree
                ? treeNodes.map((n) =>
                    n.isLeaf ? (
                      rowByKey.get(n.path) ? renderRow(rowByKey.get(n.path)!, n.depth, n.label) : null
                    ) : (
                      <tr
                        key={`dir:${n.path}`}
                        onClick={() =>
                          setCollapsed((c) => {
                            const next = new Set(c);
                            if (next.has(n.path)) next.delete(n.path);
                            else next.add(n.path);
                            return next;
                          })
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setMenu({ x: e.clientX, y: e.clientY, prefix: n.path, count: n.count });
                        }}
                        style={{ cursor: "pointer" }}
                        title="Click to fold/unfold · right-click for namespace actions"
                      >
                        <td style={{ paddingLeft: 12 + n.depth * 18, color: "var(--text-2)" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                            <Icon name={collapsed.has(n.path) ? "folder" : "folder-open"} size={13} className="soft-orange" />
                            <span style={{ fontFamily: "var(--font-mono)" }}>{n.label}</span>
                          </span>
                        </td>
                        <td colSpan={2} style={{ color: "var(--text-3)" }}>{n.count} keys</td>
                      </tr>
                    ),
                  )
                : (sorted ?? []).map((r) => renderRow(r))}
              {rows.length === 0 && !scanning && (
                <tr><td colSpan={3}>No keys{pattern ? " match the pattern" : " in this database"}.</td></tr>
              )}
            </tbody>
          </table>
        )}
        {conn && cursor && cursor !== "0" && (
          <div style={{ padding: 10, display: "flex", justifyContent: "center", gap: 8 }}>
            <ToolButton disabled={scanning} onClick={() => void runScan(false)}>
              <Icon name="download" /> {scanning ? "Scanning…" : `Load more (${rows.length} loaded)`}
            </ToolButton>
            <ToolButton disabled={scanning} onClick={() => void runScan(false, true)}>
              <Icon name="download" /> Load all
            </ToolButton>
          </div>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            menu.key
              ? [
                  { icon: "braces", label: "Open editor", strong: true, onClick: () => open(menu.key!) },
                  { icon: "copy", label: "Copy key name", onClick: async () => {
                      await writeText(menu.key!);
                      showToast("Copied", "Key name copied to clipboard.");
                    } },
                  { icon: "timer", label: "Set TTL…", onClick: () => void editTtl(menu.key!) },
                  { icon: "pencil", label: "Rename…", onClick: () => void renameKey(menu.key!) },
                  { icon: "trash", label: "Delete key", onClick: () => void removeKey(menu.key!) },
                ]
              : [
                  { icon: "search", label: `Scan "${menu.prefix}*"`, strong: true, onClick: () => setPattern(`${menu.prefix}*`) },
                  { icon: "trash", label: `Delete ${menu.count} keys…`, onClick: () => void removePrefix(menu.prefix!) },
                ]
          }
        />
      )}
    </section>
  );
}
