import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useQueryClient } from "@tanstack/react-query";
import { ToolButton } from "../../ui/ToolButton";
import { FormRow } from "../../ui/FormRow";
import { StatusDot, type DotTone } from "../../ui/StatusDot";
import { Icon } from "../../ui/Icon";
import { JsonView } from "../../ui/JsonView";
import { useApp } from "../../store";
import { exec, parseInfo, parseKeyspace } from "../../lib/redis";
import type { Connection } from "../../lib/types";

type CheckState = "idle" | "pending" | "ok" | "fail";

const CHECKS: { key: string; label: string; code: string }[] = [
  { key: "ping", label: "Server reachable", code: "PING" },
  { key: "info", label: "Server info", code: "INFO server" },
  { key: "keyspace", label: "Keyspace listing", code: "INFO keyspace" },
];

const toneFor: Record<CheckState, DotTone> = { idle: "idle", pending: "orange", ok: "green", fail: "red" };

function draftFrom(conn: Connection | null): Connection {
  return (
    conn ?? {
      id: crypto.randomUUID(),
      name: "local-redis",
      host: "127.0.0.1",
      port: 6379,
      username: "",
      password: "",
      db: 0,
      tls: false,
      tlsInsecure: false,
    }
  );
}

export function ConnectionView({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const { connections, editingConnId, saveConnection, setActiveConn, openTab, closeTab, setEditingConn, showToast } =
    useApp(useShallow((s) => ({
      connections: s.connections, editingConnId: s.editingConnId, saveConnection: s.saveConnection,
      setActiveConn: s.setActiveConn, openTab: s.openTab, closeTab: s.closeTab,
      setEditingConn: s.setEditingConn, showToast: s.showToast,
    })));
  const editing = useMemo(
    () => connections.find((c) => c.id === editingConnId) ?? null,
    [connections, editingConnId],
  );
  const [draft, setDraft] = useState<Connection>(() => draftFrom(editing));
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [preview, setPreview] = useState<unknown>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setDraft(draftFrom(editing));
    setChecks({});
    setPreview(null);
  }, [editingConnId, editing]);

  const patch = (p: Partial<Connection>) => setDraft((d) => ({ ...d, ...p }));

  const runHandshake = async (): Promise<boolean> => {
    setTesting(true);
    setChecks({ ping: "pending", info: "pending", keyspace: "pending" });
    setPreview(null);
    let ok = true;
    const mark = (key: string, state: CheckState) => setChecks((c) => ({ ...c, [key]: state }));
    try {
      await exec(draft, draft.db, ["PING"]);
      mark("ping", "ok");
      const info = parseInfo(await exec<string>(draft, draft.db, ["INFO"]));
      mark("info", "ok");
      const keyspace = parseKeyspace(info);
      mark("keyspace", "ok");
      setPreview({
        server: `${info.server?.redis_version ? `redis ${info.server.redis_version}` : "unknown"} · ${info.server?.redis_mode ?? "?"} mode`,
        os: info.server?.os,
        memory: info.memory?.used_memory_human,
        clients: Number(info.clients?.connected_clients ?? 0),
        databases: keyspace.length
          ? Object.fromEntries(keyspace.map((d) => [`db${d.db}`, `${d.keys} keys`]))
          : "empty",
        next: "browse keys",
      });
    } catch (err) {
      setChecks((c) => {
        const next = { ...c };
        for (const k of Object.keys(next)) if (next[k] === "pending") next[k] = "fail";
        return next;
      });
      setPreview({ error: String(err) });
      ok = false;
    } finally {
      setTesting(false);
    }
    return ok;
  };

  const save = () => {
    saveConnection(draft);
    setActiveConn(draft.id);
    void queryClient.invalidateQueries();
    showToast("Connection saved", `${draft.name} is now the active connection.`, "ok");
    setEditingConn(null);
    closeTab("connection");
    openTab("keys");
  };

  return (
    <section className={`content connection-view ${active ? "active" : ""}`}>
      <div className="create-head">
        <div>
          <div className="create-kicker">Connection setup</div>
          <strong>{editing ? `Edit connection · ${editing.name}` : "New Redis/Valkey connection"}</strong>
        </div>
        <div className="seg">
          <ToolButton disabled={testing} onClick={() => void runHandshake()}>
            <Icon name="zap" /> {testing ? "Testing…" : "Test connection"}
          </ToolButton>
          <ToolButton variant="primary" onClick={save}>
            <Icon name="save" /> Save connection
          </ToolButton>
        </div>
      </div>
      <div className="create-layout">
        <div className="create-card">
          <h3>Server and authentication</h3>
          <div className="create-form">
            <FormRow label="Name">
              <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
            </FormRow>
            <FormRow label="Host">
              <input value={draft.host} placeholder="127.0.0.1" spellCheck={false} onChange={(e) => patch({ host: e.target.value })} />
            </FormRow>
            <FormRow label="Port">
              <input
                type="number"
                value={draft.port}
                min={1}
                max={65535}
                onChange={(e) => patch({ port: Math.max(1, Math.min(65535, Number(e.target.value) || 6379)) })}
              />
            </FormRow>
            <FormRow label="Username">
              <input value={draft.username ?? ""} placeholder="(ACL user — empty for default)" onChange={(e) => patch({ username: e.target.value })} />
            </FormRow>
            <FormRow label="Password">
              <input type="password" value={draft.password ?? ""} placeholder="(requirepass / ACL password)" onChange={(e) => patch({ password: e.target.value })} />
            </FormRow>
            <FormRow label="Database">
              <input
                type="number"
                min={0}
                value={draft.db}
                onChange={(e) => patch({ db: Math.max(0, Number(e.target.value) || 0) })}
              />
            </FormRow>
            <FormRow label="TLS">
              <select
                value={draft.tls ? (draft.tlsInsecure ? "insecure" : "on") : "off"}
                onChange={(e) => {
                  const v = e.target.value;
                  patch({ tls: v !== "off", tlsInsecure: v === "insecure" });
                }}
              >
                <option value="off">Off</option>
                <option value="on">TLS (verify certificate)</option>
                <option value="insecure">TLS (skip verification)</option>
              </select>
            </FormRow>
            <div className="connection-note">
              <strong>Valkey / Redis-compatible servers work out of the box</strong>
              <span>
                Valkey, KeyDB, Dragonfly and managed Redis (ElastiCache, Upstash, Redis Cloud) all
                speak RESP — point host/port here and everything works. Cluster mode is not
                supported yet; connect to a single node.
              </span>
            </div>
          </div>
        </div>
        <div className="create-card">
          <h3>Handshake checks</h3>
          <div className="create-form">
            {CHECKS.map((c) => (
              <div className="check-row" key={c.key}>
                <StatusDot tone={toneFor[checks[c.key] ?? "idle"]} />
                <strong>{c.label}</strong>
                <code>{c.code}</code>
              </div>
            ))}
            {preview != null ? (
              <JsonView className="create-preview json-tree" value={preview} />
            ) : (
              <pre className="create-preview">Run “Test connection” to check the server.</pre>
            )}
            <div className="seg">
              <ToolButton onClick={() => openTab("keys")}>Browse keys</ToolButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
