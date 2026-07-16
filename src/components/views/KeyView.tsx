import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Badge } from "../../ui/Badge";
import { ToolButton } from "../../ui/ToolButton";
import { Icon } from "../../ui/Icon";
import { CodeInput } from "../../ui/CodeInput";
import { FormRow } from "../../ui/FormRow";
import { useApp } from "../../store";
import { useActiveConnection } from "../../lib/queries";
import { exec, execRaw, keyMeta } from "../../lib/redis";
import { deleteElem } from "../../lib/elemOps";
import { formatTtl, typeTone } from "../../lib/keyFormat";
import { formatBytes } from "../../lib/format";
import type { KeyMeta } from "../../lib/types";

const PAGE = 200;

/** one row of a collection value — semantics depend on the key type */
interface Elem {
  /** hash: field · list: index · set/zset: member · stream: entry id */
  a: string;
  /** hash: value · list: value · zset: score · stream: fields as JSON */
  b: string;
}

const looksJson = (s: string) => {
  const t = s.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
};

const tryPretty = (s: string) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

const CREATE_TYPES = ["string", "hash", "list", "set", "zset", "stream"];

export function KeyView({ tabId, active }: { tabId: string; active: boolean }) {
  const conn = useActiveConnection();
  const queryClient = useQueryClient();
  const {
    keyTabs, activeDb, showToast, openDialog, closeTab, setKeyTabKey, selectKey, bumpKeyRecency,
    elemEditor, setElemEditor, elemMutateNonce,
  } = useApp();
  const tabState = keyTabs[tabId];
  const key = tabState?.key ?? "";
  const createMode = !!tabState?.create;

  const [meta, setMeta] = useState<KeyMeta | null>(null);
  const [loading, setLoading] = useState(false);

  // string value editing
  const [strValue, setStrValue] = useState("");
  const [strSaved, setStrSaved] = useState("");

  // collection elements + paging
  const [elems, setElems] = useState<Elem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null); // HSCAN/SSCAN cursor, list start index, stream boundary id
  const [filter, setFilter] = useState("");

  // create-mode draft
  const [draft, setDraft] = useState({ name: "", type: "string", ttl: "", a: "", b: "" });

  const type = meta?.type ?? "none";

  const loadMeta = useCallback(async () => {
    if (!conn || !key) return null;
    const m = await keyMeta(conn, activeDb, key);
    setMeta(m);
    selectKey(m);
    return m;
  }, [conn, key, activeDb, selectKey]);

  const loadPage = useCallback(
    async (m: KeyMeta, reset: boolean) => {
      if (!conn) return;
      const t = m.type;
      const prev = reset ? [] : elems;
      if (t === "string") {
        const v = (await exec<string | null>(conn, activeDb, ["GET", key])) ?? "";
        const pretty = looksJson(v) ? tryPretty(v) : v;
        setStrValue(pretty);
        setStrSaved(pretty);
        return;
      }
      if (t === "ReJSON-RL") {
        const v = await exec<string>(conn, activeDb, ["JSON.GET", key]);
        const pretty = tryPretty(v);
        setStrValue(pretty);
        setStrSaved(pretty);
        return;
      }
      if (t === "hash") {
        const cur = reset ? "0" : cursor ?? "0";
        const r = await exec<[string, string[]]>(conn, activeDb, ["HSCAN", key, cur, "COUNT", String(PAGE)]);
        const flat = r[1] ?? [];
        const page: Elem[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) page.push({ a: flat[i], b: flat[i + 1] });
        setElems([...prev, ...page]);
        setCursor(r[0]);
        return;
      }
      if (t === "set") {
        const cur = reset ? "0" : cursor ?? "0";
        const r = await exec<[string, string[]]>(conn, activeDb, ["SSCAN", key, cur, "COUNT", String(PAGE)]);
        setElems([...prev, ...(r[1] ?? []).map((m2) => ({ a: m2, b: "" }))]);
        setCursor(r[0]);
        return;
      }
      if (t === "list") {
        const start = reset ? 0 : Number(cursor ?? 0);
        const r = await exec<string[]>(conn, activeDb, ["LRANGE", key, String(start), String(start + PAGE - 1)]);
        setElems([...prev, ...r.map((v, i) => ({ a: String(start + i), b: v }))]);
        setCursor(r.length < PAGE ? "0" : String(start + r.length));
        return;
      }
      if (t === "zset") {
        const start = reset ? 0 : Number(cursor ?? 0);
        const r = await exec<string[]>(conn, activeDb, ["ZRANGE", key, String(start), String(start + PAGE - 1), "WITHSCORES"]);
        const page: Elem[] = [];
        for (let i = 0; i + 1 < r.length; i += 2) page.push({ a: r[i], b: r[i + 1] });
        setElems([...prev, ...page]);
        setCursor(r.length / 2 < PAGE ? "0" : String(start + r.length / 2));
        return;
      }
      if (t === "stream") {
        const end = reset ? "+" : cursor && cursor !== "0" ? `(${cursor}` : "+";
        const r = await exec<[string, string[]][]>(conn, activeDb, ["XREVRANGE", key, end, "-", "COUNT", String(PAGE)]);
        const page: Elem[] = (r ?? []).map(([id, flat]) => {
          const obj: Record<string, string> = {};
          for (let i = 0; i + 1 < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
          return { a: id, b: JSON.stringify(obj) };
        });
        setElems([...prev, ...page]);
        setCursor(page.length < PAGE ? "0" : page[page.length - 1]?.a ?? "0");
        return;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conn, key, activeDb, cursor, elems],
  );

  const reload = useCallback(async () => {
    if (!conn || !key || createMode) return;
    setLoading(true);
    try {
      const m = await loadMeta();
      if (m) {
        setElems([]);
        setCursor(null);
        await loadPage(m, true);
      }
    } catch (err) {
      showToast("Load failed", String(err), "err");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, key, createMode, activeDb]);

  useEffect(() => {
    void reload();
    if (key) bumpKeyRecency(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id, key, activeDb]);

  // ⌘↵ — reload when active
  const runNonce = useApp((s) => s.runNonce);
  const prevNonce = useRef(runNonce);
  useEffect(() => {
    if (runNonce !== prevNonce.current) {
      prevNonce.current = runNonce;
      if (active) void reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runNonce, active]);

  // the inspector saved/removed an element of this key — refresh the element list
  const prevElemNonce = useRef(elemMutateNonce);
  useEffect(() => {
    if (elemMutateNonce !== prevElemNonce.current) {
      prevElemNonce.current = elemMutateNonce;
      void reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elemMutateNonce]);

  const afterMutate = async () => {
    await reload();
    void queryClient.invalidateQueries({ queryKey: ["server-info"] });
  };

  // ---------------------------------------------------------------- actions

  const saveString = async () => {
    if (!conn) return;
    try {
      if (type === "ReJSON-RL") {
        await exec(conn, activeDb, ["JSON.SET", key, "$", strValue]);
      } else {
        // preserve TTL across SET (KEEPTTL, redis ≥ 6)
        const r = await execRaw(conn, activeDb, ["SET", key, strValue, "KEEPTTL"]);
        if (r.err) await exec(conn, activeDb, ["SET", key, strValue]);
      }
      setStrSaved(strValue);
      showToast("Saved", key);
      void loadMeta();
    } catch (err) {
      showToast("Save failed", String(err), "err");
    }
  };

  const removeElem = async (el: Elem) => {
    if (!conn) return;
    try {
      await deleteElem(conn, activeDb, key, type, el.a);
      if (elemEditor?.key === key && elemEditor.origA === el.a) setElemEditor(null);
      await afterMutate();
      showToast("Removed", `${el.a} · ${key}`);
    } catch (err) {
      showToast("Remove failed", String(err), "err");
    }
  };

  const editTtl = async () => {
    if (!conn || !meta) return;
    const v = await openDialog({
      kind: "prompt",
      title: `TTL for "${key}"`,
      message: "Seconds until expiry — empty or -1 removes the expiry (PERSIST).",
      defaultValue: meta.ttl >= 0 ? String(meta.ttl) : "",
      confirmLabel: "Apply",
    });
    if (v === null) return;
    try {
      const n = Number(v.trim());
      if (v.trim() === "" || n < 0) await exec(conn, activeDb, ["PERSIST", key]);
      else await exec(conn, activeDb, ["EXPIRE", key, String(Math.floor(n))]);
      void loadMeta();
      showToast("TTL updated", key);
    } catch (err) {
      showToast("TTL failed", String(err), "err");
    }
  };

  const renameKey = async () => {
    if (!conn) return;
    const v = await openDialog({ kind: "prompt", title: `Rename "${key}"`, defaultValue: key, confirmLabel: "Rename" });
    if (!v || v === key) return;
    try {
      await exec(conn, activeDb, ["RENAME", key, v]);
      setKeyTabKey(tabId, v);
      showToast("Renamed", `${key} → ${v}`);
    } catch (err) {
      showToast("Rename failed", String(err), "err");
    }
  };

  const duplicateKey = async () => {
    if (!conn) return;
    const v = await openDialog({ kind: "prompt", title: `Duplicate "${key}"`, defaultValue: `${key}:copy`, confirmLabel: "Duplicate" });
    if (!v || v === key) return;
    try {
      await exec(conn, activeDb, ["COPY", key, v]);
      showToast("Duplicated", `${key} → ${v}`);
      void queryClient.invalidateQueries({ queryKey: ["server-info"] });
    } catch (err) {
      showToast("Duplicate failed", String(err), "err");
    }
  };

  const deleteKey = async () => {
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
      selectKey(null);
      showToast("Key deleted", key);
      void queryClient.invalidateQueries({ queryKey: ["server-info"] });
      closeTab(tabId);
    } catch (err) {
      showToast("Delete failed", String(err), "err");
    }
  };

  const copyValue = async () => {
    if (!conn || !meta) return;
    try {
      let text: string;
      if (type === "string" || type === "ReJSON-RL") text = strValue;
      else if (type === "hash") text = JSON.stringify(Object.fromEntries(elems.map((e) => [e.a, e.b])), null, 2);
      else if (type === "zset") text = JSON.stringify(elems.map((e) => ({ member: e.a, score: Number(e.b) })), null, 2);
      else if (type === "stream") text = JSON.stringify(elems.map((e) => ({ id: e.a, fields: JSON.parse(e.b) })), null, 2);
      else text = JSON.stringify(elems.map((e) => (type === "list" ? e.b : e.a)), null, 2);
      await writeText(text);
      showToast("Copied", "Loaded value copied as JSON.");
    } catch (err) {
      showToast("Copy failed", String(err), "err");
    }
  };

  const createKey = async () => {
    if (!conn) return;
    const name = draft.name.trim();
    if (!name) return showToast("Name required", "Enter a key name.", "warn");
    try {
      const exists = await exec<number>(conn, activeDb, ["EXISTS", name]);
      if (exists) return showToast("Key exists", "Pick another name or open the existing key.", "warn");
      if (draft.type === "string") await exec(conn, activeDb, ["SET", name, draft.b]);
      else if (draft.type === "hash") await exec(conn, activeDb, ["HSET", name, draft.a || "field", draft.b]);
      else if (draft.type === "list") await exec(conn, activeDb, ["RPUSH", name, draft.b]);
      else if (draft.type === "set") await exec(conn, activeDb, ["SADD", name, draft.b || draft.a || "member"]);
      else if (draft.type === "zset") await exec(conn, activeDb, ["ZADD", name, String(Number(draft.b) || 0), draft.a || "member"]);
      else if (draft.type === "stream") {
        let obj: Record<string, unknown> = {};
        try {
          obj = draft.b ? JSON.parse(draft.b) : { created: "1" };
        } catch {
          return showToast("Invalid JSON", "Stream entries are added from a JSON object.", "warn");
        }
        const args = Object.entries(obj).flatMap(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
        await exec(conn, activeDb, ["XADD", name, "*", ...args]);
      }
      const ttl = Number(draft.ttl);
      if (draft.ttl.trim() && ttl > 0) await exec(conn, activeDb, ["EXPIRE", name, String(Math.floor(ttl))]);
      setKeyTabKey(tabId, name);
      showToast("Key created", name);
      void queryClient.invalidateQueries({ queryKey: ["server-info"] });
    } catch (err) {
      showToast("Create failed", String(err), "err");
    }
  };

  // ---------------------------------------------------------------- render

  if (createMode) {
    return (
      <section className={`content connection-view ${active ? "active" : ""}`}>
        <div className="create-head">
          <div>
            <div className="create-kicker">New key · db{activeDb}</div>
            <strong>Create a Redis key</strong>
          </div>
          <div className="seg">
            <ToolButton variant="primary" disabled={!conn} onClick={() => void createKey()}>
              <Icon name="check" /> Create key
            </ToolButton>
          </div>
        </div>
        <div className="create-layout" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <div className="create-card">
            <h3>Key</h3>
            <div className="create-form">
              <FormRow label="Name">
                <input value={draft.name} placeholder="user:1000:profile" spellCheck={false}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </FormRow>
              <FormRow label="Type">
                <select value={draft.type} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}>
                  {CREATE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </FormRow>
              <FormRow label="TTL (s)">
                <input value={draft.ttl} placeholder="no expiry" onChange={(e) => setDraft((d) => ({ ...d, ttl: e.target.value }))} />
              </FormRow>
              {draft.type === "hash" && (
                <FormRow label="Field">
                  <input value={draft.a} placeholder="field name" onChange={(e) => setDraft((d) => ({ ...d, a: e.target.value }))} />
                </FormRow>
              )}
              {draft.type === "zset" && (
                <>
                  <FormRow label="Member">
                    <input value={draft.a} onChange={(e) => setDraft((d) => ({ ...d, a: e.target.value }))} />
                  </FormRow>
                  <FormRow label="Score">
                    <input value={draft.b} placeholder="0" onChange={(e) => setDraft((d) => ({ ...d, b: e.target.value }))} />
                  </FormRow>
                </>
              )}
              {draft.type !== "zset" && (
                <div>
                  <div style={{ color: "var(--text-3)", fontSize: "0.8462rem", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 7 }}>
                    {draft.type === "stream" ? "First entry (JSON object)" : draft.type === "hash" ? "Field value" : "Value"}
                  </div>
                  <CodeInput
                    value={draft.b}
                    onChange={(v) => setDraft((d) => ({ ...d, b: v }))}
                    height={180}
                    language={looksJson(draft.b) || draft.type === "stream" ? "json" : "plaintext"}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  const q = filter.trim().toLowerCase();
  const shownElems = q ? elems.filter((e) => e.a.toLowerCase().includes(q) || e.b.toLowerCase().includes(q)) : elems;
  const isCollection = ["hash", "list", "set", "zset", "stream"].includes(type);

  const elemCols =
    type === "hash" ? ["Field", "Value"] :
    type === "list" ? ["#", "Value"] :
    type === "zset" ? ["Member", "Score"] :
    type === "stream" ? ["Entry ID", "Fields"] : ["Member", ""];

  return (
    <section className={`content indexes-view ${active ? "active" : ""}`} style={{ gridTemplateRows: "54px minmax(0, 1fr)" }}>
      <div className="create-head">
        <div className="doc-title">
          <strong style={{ fontFamily: "var(--font-mono)" }}>{key}</strong>
          <span>
            {meta
              ? `${formatTtl(meta.ttl)} · ${meta.encoding ?? "?"} · ${meta.memory != null ? formatBytes(meta.memory) : "?"} · ${meta.length ?? "?"} ${type === "string" ? "chars" : "items"}`
              : loading ? "loading…" : "unknown key"}
          </span>
        </div>
        <div className="seg" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Badge tone={typeTone(type)}>{type}</Badge>
          <ToolButton iconOnly title="Reload (⌘↵)" onClick={() => void reload()}><Icon name="refresh" /></ToolButton>
          <ToolButton iconOnly title="Edit TTL" onClick={() => void editTtl()}><Icon name="timer" /></ToolButton>
          <ToolButton iconOnly title="Rename key" onClick={() => void renameKey()}><Icon name="pencil" /></ToolButton>
          <ToolButton iconOnly title="Duplicate key (COPY)" onClick={() => void duplicateKey()}><Icon name="copy" /></ToolButton>
          <ToolButton iconOnly title="Copy loaded value as JSON" onClick={() => void copyValue()}><Icon name="docs" /></ToolButton>
          <ToolButton iconOnly title="Delete key" onClick={() => void deleteKey()}><Icon name="trash" /></ToolButton>
        </div>
      </div>

      {(type === "string" || type === "ReJSON-RL") && (
        <div className="editor-pane" style={{ gridTemplateRows: "1fr 26px", borderBottom: 0 }}>
          <div className="editor-host">
            <CodeInput
              value={strValue}
              onChange={setStrValue}
              height="100%"
              language={type === "ReJSON-RL" || looksJson(strValue) ? "json" : "plaintext"}
            />
          </div>
          <div className="editor-foot">
            <span className={strValue !== strSaved ? "dirty" : "saved"} style={{ color: strValue !== strSaved ? "var(--orange)" : "var(--green)" }}>
              {strValue !== strSaved ? "modified" : "saved"}
            </span>
            <span style={{ display: "inline-flex", gap: 8 }}>
              <ToolButton onClick={() => setStrValue(tryPretty(strValue))}><Icon name="braces" /> Format</ToolButton>
              <ToolButton variant="primary" disabled={strValue === strSaved} onClick={() => void saveString()}>
                <Icon name="save" /> Save
              </ToolButton>
            </span>
          </div>
        </div>
      )}

      {isCollection && (
        <div className="docs-split" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <div className="docs-left" style={{ display: "grid", gridTemplateRows: "44px minmax(0, 1fr) auto" }}>
            <div className="index-searchbar" style={{ gridTemplateColumns: "minmax(180px, 1fr) auto auto" }}>
              <input className="index-search" placeholder="Filter loaded items" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <ToolButton onClick={() => setElemEditor({ key, type, mode: "new", a: type === "list" ? "tail" : "", b: type === "stream" ? "{\n  \n}" : "" })}>
                <Icon name="plus" /> Add
              </ToolButton>
              <Badge>{`${shownElems.length}${cursor && cursor !== "0" ? "+" : ""} / ${meta?.length ?? "?"}`}</Badge>
            </div>
            <div className="index-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={type === "list" ? { width: 70 } : undefined}>{elemCols[0]}</th>
                    {elemCols[1] && <th>{elemCols[1]}</th>}
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {shownElems.map((el, i) => (
                    <tr
                      key={`${el.a}-${i}`}
                      className={elemEditor?.key === key && elemEditor.mode === "edit" && elemEditor.origA === el.a ? "selected" : ""}
                      onClick={() =>
                        setElemEditor({
                          key,
                          type,
                          mode: "edit",
                          a: el.a,
                          b: type === "set" ? el.a : looksJson(el.b) ? tryPretty(el.b) : el.b,
                          origA: el.a,
                        })
                      }
                    >
                      <td style={{ fontFamily: "var(--font-mono)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{el.a}</td>
                      {elemCols[1] && (
                        <td style={{ fontFamily: "var(--font-mono)", maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {type === "set" ? "" : el.b.slice(0, 300)}
                        </td>
                      )}
                      <td>
                        <span
                          className="th-remove"
                          title="Remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeElem(el);
                          }}
                        >
                          ×
                        </span>
                      </td>
                    </tr>
                  ))}
                  {shownElems.length === 0 && !loading && (
                    <tr><td colSpan={3}>Empty{q ? " (filter active)" : ""}.</td></tr>
                  )}
                </tbody>
              </table>
              {cursor && cursor !== "0" && (
                <div style={{ padding: 10, display: "flex", justifyContent: "center" }}>
                  <ToolButton onClick={() => meta && void loadPage(meta, false)}>
                    <Icon name="download" /> Load more ({elems.length} loaded)
                  </ToolButton>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {!isCollection && type !== "string" && type !== "ReJSON-RL" && !loading && (
        <div className="empty-note" style={{ padding: 20 }}>
          {meta ? `Unsupported type "${type}" — use the console for this key.` : "Key not found — it may have expired."}
        </div>
      )}
    </section>
  );
}
