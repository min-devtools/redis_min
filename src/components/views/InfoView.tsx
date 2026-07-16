import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MiniTabs } from "../../ui/MiniTabs";
import { Metric, Panel, BarLine } from "../../ui/MetricPanel";
import { ToolButton } from "../../ui/ToolButton";
import { Badge } from "../../ui/Badge";
import { Icon } from "../../ui/Icon";
import { Kv } from "../../ui/Kv";
import { useApp } from "../../store";
import { useActiveConnection, useServerInfo } from "../../lib/queries";
import { exec } from "../../lib/redis";
import { formatDocCount } from "../../lib/format";

interface ClientRow {
  id: string;
  addr: string;
  name: string;
  age: string;
  idle: string;
  cmd: string;
  db: string;
}

function parseClientList(raw: string): ClientRow[] {
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const f: Record<string, string> = {};
      for (const part of line.trim().split(" ")) {
        const i = part.indexOf("=");
        if (i > 0) f[part.slice(0, i)] = part.slice(i + 1);
      }
      return {
        id: f.id ?? "?",
        addr: f.addr ?? "?",
        name: f.name ?? "",
        age: f.age ?? "?",
        idle: f.idle ?? "?",
        cmd: f.cmd ?? "?",
        db: f.db ?? "0",
      };
    });
}

interface SlowRow {
  id: number;
  ts: number;
  micros: number;
  cmd: string;
  client: string;
}

export function InfoView({ active }: { active: boolean }) {
  const [pane, setPane] = useState("overview");
  const [configFilter, setConfigFilter] = useState("");
  const conn = useActiveConnection();
  const info = useServerInfo();
  const queryClient = useQueryClient();
  const { showToast, openDialog } = useApp();

  const clients = useQuery({
    queryKey: ["client-list", conn?.id],
    queryFn: async () => parseClientList(await exec<string>(conn!, 0, ["CLIENT", "LIST"])),
    enabled: !!conn && active && pane === "clients",
    refetchInterval: 5_000,
  });

  const slowlog = useQuery({
    queryKey: ["slowlog", conn?.id],
    queryFn: async () => {
      const raw = await exec<[number, number, number, string[], string, string][]>(conn!, 0, ["SLOWLOG", "GET", "128"]);
      return (raw ?? []).map((e): SlowRow => ({
        id: Number(e[0]),
        ts: Number(e[1]),
        micros: Number(e[2]),
        cmd: (e[3] ?? []).join(" "),
        client: String(e[4] ?? ""),
      }));
    },
    enabled: !!conn && active && pane === "slowlog",
    refetchInterval: 10_000,
  });

  const config = useQuery({
    queryKey: ["config-all", conn?.id],
    queryFn: async () => {
      const flat = await exec<string[]>(conn!, 0, ["CONFIG", "GET", "*"]);
      const rows: [string, string][] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) rows.push([flat[i], flat[i + 1]]);
      return rows.sort((a, b) => a[0].localeCompare(b[0]));
    },
    enabled: !!conn && active && pane === "config",
    staleTime: 30_000,
  });

  const i = info.data;
  const num = (section: string, field: string) => Number(i?.[section]?.[field] ?? 0);
  const str = (section: string, field: string) => i?.[section]?.[field] ?? "—";

  const hitRate = useMemo(() => {
    const hits = num("stats", "keyspace_hits");
    const misses = num("stats", "keyspace_misses");
    return hits + misses ? Math.round((hits / (hits + misses)) * 100) : null;
  }, [i]);

  const memUsed = num("memory", "used_memory");
  const memMax = num("memory", "maxmemory");

  const editConfig = async (param: string, value: string) => {
    if (!conn) return;
    const v = await openDialog({
      kind: "prompt",
      title: `CONFIG SET ${param}`,
      message: "Applied live on the server (not persisted to redis.conf unless CONFIG REWRITE).",
      defaultValue: value,
      confirmLabel: "Set",
    });
    if (v === null || v === value) return;
    try {
      await exec(conn, 0, ["CONFIG", "SET", param, v]);
      void queryClient.invalidateQueries({ queryKey: ["config-all"] });
      showToast("Config set", `${param} = ${v}`);
    } catch (err) {
      showToast("Config failed", String(err), "err");
    }
  };

  const killClient = async (row: ClientRow) => {
    if (!conn) return;
    const ok = await openDialog({
      kind: "confirm",
      title: `Kill client #${row.id}`,
      message: `${row.addr} · ${row.cmd} — the connection is closed server-side.`,
      confirmLabel: "Kill",
      danger: true,
    });
    if (!ok) return;
    try {
      await exec(conn, 0, ["CLIENT", "KILL", "ID", row.id]);
      void queryClient.invalidateQueries({ queryKey: ["client-list"] });
      showToast("Client killed", row.addr);
    } catch (err) {
      showToast("Kill failed", String(err), "err");
    }
  };

  const q = configFilter.trim().toLowerCase();
  const configRows = (config.data ?? []).filter(([k, v]) => !q || k.includes(q) || v.toLowerCase().includes(q));

  return (
    <section className={`content ${active ? "active" : ""}`} style={{ gridTemplateRows: "auto minmax(0, 1fr)", background: "var(--window)" }}>
      <div style={{ borderBottom: "1px solid var(--line)", background: "color-mix(in oklab, var(--window), var(--app-bg) 3%)" }}>
        <MiniTabs
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "clients", label: "Clients" },
            { id: "slowlog", label: "Slowlog" },
            { id: "config", label: "Config" },
            { id: "raw", label: "Raw INFO" },
          ]}
          active={pane}
          onChange={setPane}
        />
      </div>

      {!conn && <div className="empty-note" style={{ padding: 20 }}>Connect to a server to inspect it.</div>}

      {conn && pane === "overview" && (
        <div className="cluster-main">
          <div className="dense-grid">
            <Metric label="Redis version" value={str("server", "redis_version")} />
            <Metric label="Mode" value={str("server", "redis_mode")} />
            <Metric label="Uptime" value={`${Math.floor(num("server", "uptime_in_seconds") / 86400)}d ${Math.floor((num("server", "uptime_in_seconds") % 86400) / 3600)}h`} />
            <Metric label="Connected clients" value={formatDocCount(num("clients", "connected_clients"))} />
            <Metric label="Memory used" value={str("memory", "used_memory_human")} color="var(--blue)" />
            <Metric label="Memory peak" value={str("memory", "used_memory_peak_human")} />
            <Metric label="Ops / sec" value={formatDocCount(num("stats", "instantaneous_ops_per_sec"))} color="var(--green)" />
            <Metric label="Hit rate" value={hitRate == null ? "—" : `${hitRate}%`} color={hitRate != null && hitRate < 80 ? "var(--orange)" : undefined} />
            <Metric label="Total commands" value={formatDocCount(num("stats", "total_commands_processed"))} />
            <Metric label="Expired keys" value={formatDocCount(num("stats", "expired_keys"))} />
            <Metric label="Evicted keys" value={formatDocCount(num("stats", "evicted_keys"))} color={num("stats", "evicted_keys") > 0 ? "var(--red)" : undefined} />
            <Metric label="Role" value={str("replication", "role")} />
          </div>
          <Panel title="Memory">
            <BarLine
              label="used / max"
              percent={memMax ? (memUsed / memMax) * 100 : 0}
              value={memMax ? `${str("memory", "used_memory_human")} / ${str("memory", "maxmemory_human")}` : `${str("memory", "used_memory_human")} (no maxmemory)`}
              color={memMax && memUsed / memMax > 0.85 ? "var(--red)" : "var(--blue)"}
            />
            <Kv label="fragmentation">{str("memory", "mem_fragmentation_ratio")}</Kv>
            <Kv label="allocator">{str("memory", "mem_allocator")}</Kv>
            <Kv label="eviction policy">{str("memory", "maxmemory_policy")}</Kv>
          </Panel>
          <Panel title="Persistence" style={{ marginTop: 14 }}>
            <Kv label="RDB last save">{num("persistence", "rdb_last_save_time") ? new Date(num("persistence", "rdb_last_save_time") * 1000).toLocaleString() : "—"}</Kv>
            <Kv label="RDB changes since">{formatDocCount(num("persistence", "rdb_changes_since_last_save"))}</Kv>
            <Kv label="AOF enabled">{str("persistence", "aof_enabled") === "1" ? "yes" : "no"}</Kv>
            <Kv label="loading">{str("persistence", "loading") === "1" ? "yes" : "no"}</Kv>
          </Panel>
        </div>
      )}

      {conn && pane === "clients" && (
        <div className="index-table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>ID</th>
                <th>Address</th>
                <th>Name</th>
                <th style={{ width: 60 }}>db</th>
                <th style={{ width: 80 }}>Age (s)</th>
                <th style={{ width: 80 }}>Idle (s)</th>
                <th>Last cmd</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {(clients.data ?? []).map((c) => (
                <tr key={c.id}>
                  <td>{c.id}</td>
                  <td style={{ fontFamily: "var(--font-mono)" }}>{c.addr}</td>
                  <td>{c.name || "—"}</td>
                  <td>{c.db}</td>
                  <td>{c.age}</td>
                  <td>{c.idle}</td>
                  <td style={{ fontFamily: "var(--font-mono)" }}>{c.cmd}</td>
                  <td>
                    <span className="th-remove" title="CLIENT KILL" onClick={() => void killClient(c)}>×</span>
                  </td>
                </tr>
              ))}
              {clients.data?.length === 0 && <tr><td colSpan={8}>No clients.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {conn && pane === "slowlog" && (
        <div className="index-table-wrap">
          <div className="index-searchbar" style={{ gridTemplateColumns: "1fr auto auto" }}>
            <span style={{ color: "var(--text-3)" }}>Commands slower than the `slowlog-log-slower-than` threshold (µs).</span>
            <Badge>{slowlog.data?.length ?? 0} entries</Badge>
            <ToolButton
              onClick={async () => {
                if (!conn) return;
                await exec(conn, 0, ["SLOWLOG", "RESET"]);
                void queryClient.invalidateQueries({ queryKey: ["slowlog"] });
                showToast("Slowlog reset", "");
              }}
            >
              <Icon name="eraser" /> Reset
            </ToolButton>
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>ID</th>
                <th style={{ width: 180 }}>When</th>
                <th style={{ width: 110 }}>Duration</th>
                <th>Command</th>
                <th style={{ width: 170 }}>Client</th>
              </tr>
            </thead>
            <tbody>
              {(slowlog.data ?? []).map((s) => (
                <tr key={s.id}>
                  <td>{s.id}</td>
                  <td>{new Date(s.ts * 1000).toLocaleString()}</td>
                  <td style={{ color: s.micros > 100_000 ? "var(--red)" : "var(--orange)", fontFamily: "var(--font-mono)" }}>
                    {s.micros >= 1000 ? `${(s.micros / 1000).toFixed(1)} ms` : `${s.micros} µs`}
                  </td>
                  <td style={{ fontFamily: "var(--font-mono)", maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.cmd}</td>
                  <td style={{ fontFamily: "var(--font-mono)" }}>{s.client}</td>
                </tr>
              ))}
              {slowlog.data?.length === 0 && <tr><td colSpan={5}>Slowlog is empty — nothing slow. 🎉</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {conn && pane === "config" && (
        <div className="index-table-wrap">
          <div className="index-searchbar" style={{ gridTemplateColumns: "minmax(240px, 420px) 1fr auto" }}>
            <input className="index-search" placeholder="Filter parameters" value={configFilter} onChange={(e) => setConfigFilter(e.target.value)} />
            <span />
            <Badge>{configRows.length} params</Badge>
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 320 }}>Parameter</th>
                <th>Value</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {configRows.map(([k, v]) => (
                <tr key={k} onDoubleClick={() => void editConfig(k, v)} title="Double-click to CONFIG SET">
                  <td style={{ fontFamily: "var(--font-mono)" }}>{k}</td>
                  <td style={{ fontFamily: "var(--font-mono)", maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v || "—"}</td>
                  <td>
                    <span className="th-remove" title="Edit" onClick={() => void editConfig(k, v)}>✎</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {conn && pane === "raw" && (
        <div className="cluster-main">
          {Object.entries(info.data ?? {}).map(([section, fields]) => (
            <Panel key={section} title={section} style={{ marginBottom: 14 }}>
              {Object.entries(fields).map(([k, v]) => (
                <Kv key={k} label={k}>{v}</Kv>
              ))}
            </Panel>
          ))}
        </div>
      )}
    </section>
  );
}
