import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Kv } from "../ui/Kv";
import { MiniTabs } from "../ui/MiniTabs";
import { ToolButton } from "../ui/ToolButton";
import { Icon } from "../ui/Icon";
import { JsonView } from "../ui/JsonView";
import { CodeInput } from "../ui/CodeInput";
import { FormRow } from "../ui/FormRow";
import { useApp } from "../store";
import { useActiveConnection } from "../lib/queries";
import { exec, execRaw, keyMeta, pipeline } from "../lib/redis";
import { saveElem, deleteElem } from "../lib/elemOps";
import { formatBytes } from "../lib/format";
import { formatTtl } from "../lib/keyFormat";
import type { Connection } from "../lib/types";

/** small, type-appropriate sample of a key's value for the preview pane */
async function previewValue(conn: Connection, db: number, key: string, type: string): Promise<unknown> {
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

const EDITABLE_TYPES = ["string", "ReJSON-RL", "hash", "list", "set", "zset"];
// ponytail: full value is loaded into the dock editor — cap it, huge keys belong in the key tab
const EDIT_MAX_ITEMS = 5000;

/** the ENTIRE value as an editable string — JSON for collections */
async function loadFullValue(conn: Connection, db: number, key: string, type: string): Promise<string> {
  switch (type) {
    case "string": {
      const v = (await exec<string | null>(conn, db, ["GET", key])) ?? "";
      return looksJson(v) ? tryPretty(v) : v;
    }
    case "ReJSON-RL":
      return tryPretty(await exec<string>(conn, db, ["JSON.GET", key]));
    case "hash": {
      const obj: Record<string, string> = {};
      let cur = "0";
      do {
        const r = await exec<[string, string[]]>(conn, db, ["HSCAN", key, cur, "COUNT", "1000"]);
        cur = r[0];
        const flat = r[1] ?? [];
        for (let i = 0; i + 1 < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
      } while (cur !== "0");
      return JSON.stringify(obj, null, 2);
    }
    case "list":
      return JSON.stringify(await exec<string[]>(conn, db, ["LRANGE", key, "0", "-1"]), null, 2);
    case "set": {
      const members: string[] = [];
      let cur = "0";
      do {
        const r = await exec<[string, string[]]>(conn, db, ["SSCAN", key, cur, "COUNT", "1000"]);
        cur = r[0];
        members.push(...(r[1] ?? []));
      } while (cur !== "0");
      return JSON.stringify(members, null, 2);
    }
    case "zset": {
      const flat = await exec<string[]>(conn, db, ["ZRANGE", key, "0", "-1", "WITHSCORES"]);
      const obj: Record<string, number> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) obj[flat[i]] = Number(flat[i + 1]);
      return JSON.stringify(obj, null, 2);
    }
    default:
      return "";
  }
}

const asStr = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** write the edited draft back — collections are rebuilt atomically (DEL + refill + EXPIRE in one MULTI/EXEC) */
async function saveFullValue(conn: Connection, db: number, key: string, type: string, draft: string): Promise<void> {
  if (type === "string") {
    // preserve TTL across SET (KEEPTTL, redis ≥ 6)
    const r = await execRaw(conn, db, ["SET", key, draft, "KEEPTTL"]);
    if (r.err) await exec(conn, db, ["SET", key, draft]);
    return;
  }
  if (type === "ReJSON-RL") {
    await exec(conn, db, ["JSON.SET", key, "$", draft]);
    return;
  }
  const parsed = JSON.parse(draft);
  const ttl = Number(await exec(conn, db, ["TTL", key]));
  const cmds: string[][] = [["DEL", key]];
  if (type === "hash") {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length) cmds.push(["HSET", key, ...entries.flatMap(([f, v]) => [f, asStr(v)])]);
  } else if (type === "list") {
    const items = (parsed as unknown[]).map(asStr);
    if (items.length) cmds.push(["RPUSH", key, ...items]);
  } else if (type === "set") {
    const items = (parsed as unknown[]).map(asStr);
    if (items.length) cmds.push(["SADD", key, ...items]);
  } else if (type === "zset") {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length) cmds.push(["ZADD", key, ...entries.flatMap(([m, s]) => [String(Number(s)), m])]);
  }
  if (ttl > 0) cmds.push(["EXPIRE", key, String(ttl)]);
  // MULTI/EXEC so DEL + rebuild commit atomically — the Rust pipeline packs all
  // commands into one contiguous write on a single connection, and a queue-time
  // error (OOM, bad arity) EXECABORTs before DEL runs. Replies become
  // OK, QUEUED×n, then EXEC's array; the err scan below covers all of them.
  const rs = await pipeline(conn, db, [["MULTI"], ...cmds, ["EXEC"]]);
  const bad = rs.find((r) => r.err !== undefined);
  if (bad) throw new Error(bad.err);
}

/** shape check for the collection JSON drafts — what saveFullValue expects */
function draftValid(type: string, draft: string): boolean {
  if (type === "string") return true;
  try {
    const p = JSON.parse(draft);
    if (type === "list" || type === "set") return Array.isArray(p);
    if (type === "hash") return !!p && typeof p === "object" && !Array.isArray(p);
    if (type === "zset")
      return !!p && typeof p === "object" && !Array.isArray(p) && Object.values(p).every((v) => Number.isFinite(Number(v)));
    return true; // ReJSON — any valid JSON
  } catch {
    return false;
  }
}

export function Inspector() {
  const [pane, setPane] = useState("value");
  const [draft, setDraft] = useState("");
  const [original, setOriginal] = useState("");
  const { selectedKey, showToast, activeDb, selectKey, elemEditor, setElemEditor, bumpElemMutate } = useApp(
    useShallow((s) => ({
      selectedKey: s.selectedKey, showToast: s.showToast, activeDb: s.activeDb, selectKey: s.selectKey,
      elemEditor: s.elemEditor, setElemEditor: s.setElemEditor, bumpElemMutate: s.bumpElemMutate,
    })),
  );
  const conn = useActiveConnection();
  const queryClient = useQueryClient();

  // a key tab opened an element editor — bring the Edit pane forward
  useEffect(() => {
    if (elemEditor) setPane("edit");
  }, [elemEditor]);

  // selecting another key drops a stale element editor
  useEffect(() => {
    if (elemEditor && selectedKey && selectedKey.key !== elemEditor.key) setElemEditor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey?.key]);

  const type = selectedKey?.type ?? "none";
  const editable = EDITABLE_TYPES.includes(type);
  const tooLarge = (selectedKey?.length ?? 0) > EDIT_MAX_ITEMS && type !== "string" && type !== "ReJSON-RL";

  const preview = useQuery({
    queryKey: ["key-preview", conn?.id, activeDb, selectedKey?.key, selectedKey?.type],
    queryFn: () => previewValue(conn!, activeDb, selectedKey!.key, selectedKey!.type),
    enabled: !!conn && !!selectedKey && pane === "value",
    staleTime: 5_000,
  });

  const full = useQuery({
    queryKey: ["key-full", conn?.id, activeDb, selectedKey?.key, selectedKey?.type],
    queryFn: () => loadFullValue(conn!, activeDb, selectedKey!.key, selectedKey!.type),
    enabled: !!conn && !!selectedKey && pane === "edit" && editable && !tooLarge,
    // never refetch behind the editor's back — a dirty draft would be clobbered
    staleTime: Infinity,
  });

  // reload the editor when another key is selected or the full value arrives
  useEffect(() => {
    setDraft(full.data ?? "");
    setOriginal(full.data ?? "");
  }, [full.data, selectedKey?.key]);

  const dirty = draft !== original;
  const valid = !selectedKey || draftValid(type, draft);

  const save = async () => {
    if (!conn || !selectedKey || !dirty || !valid) return;
    try {
      await saveFullValue(conn, activeDb, selectedKey.key, type, draft);
      setOriginal(draft);
      queryClient.setQueryData(["key-full", conn.id, activeDb, selectedKey.key, selectedKey.type], draft);
      showToast("Saved", selectedKey.key);
      selectKey(await keyMeta(conn, activeDb, selectedKey.key));
      void queryClient.invalidateQueries({ queryKey: ["key-preview"] });
      void queryClient.invalidateQueries({ queryKey: ["server-info"] });
    } catch (err) {
      showToast("Save failed", String(err), "err");
    }
  };

  const afterElemMutate = () => {
    bumpElemMutate();
    void queryClient.invalidateQueries({ queryKey: ["key-preview"] });
    void queryClient.invalidateQueries({ queryKey: ["key-full"] });
    void queryClient.invalidateQueries({ queryKey: ["server-info"] });
  };

  const saveElemDraft = async () => {
    if (!conn || !elemEditor) return;
    try {
      await saveElem(conn, activeDb, elemEditor);
      setElemEditor(null);
      afterElemMutate();
      showToast("Saved", elemEditor.key);
    } catch (err) {
      showToast("Save failed", String(err), "err");
    }
  };

  const removeElemDraft = async () => {
    if (!conn || !elemEditor) return;
    try {
      await deleteElem(conn, activeDb, elemEditor.key, elemEditor.type, elemEditor.origA ?? elemEditor.a);
      setElemEditor(null);
      afterElemMutate();
      showToast("Removed", `${elemEditor.origA ?? elemEditor.a} · ${elemEditor.key}`);
    } catch (err) {
      showToast("Remove failed", String(err), "err");
    }
  };

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
          { id: "edit", label: "Edit" },
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
              {preview.data !== undefined && <JsonView className="create-preview json-tree" value={preview.data ?? null} />}
              <div className="seg" style={{ padding: "8px 12px", gap: 8 }}>
                <ToolButton onClick={() => setPane("edit")}>
                  <Icon name="braces" /> Edit value
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
      {pane === "edit" && elemEditor && (
        <div className="inspector-edit elem">
          <div className="inspector-elem-head">
            <strong>
              {elemEditor.mode === "new"
                ? `Add ${elemEditor.type === "hash" ? "field" : elemEditor.type === "stream" ? "entry" : "item"}`
                : "Edit"}
            </strong>
            <ToolButton iconOnly title="Close" onClick={() => setElemEditor(null)}><Icon name="x" /></ToolButton>
          </div>
          <div className="inspector-elem-body">
            {elemEditor.type === "hash" && (
              <FormRow label="Field">
                <input value={elemEditor.a} spellCheck={false} onChange={(e) => setElemEditor({ ...elemEditor, a: e.target.value })} />
              </FormRow>
            )}
            {elemEditor.type === "zset" && (
              <>
                <FormRow label="Member">
                  <input value={elemEditor.a} spellCheck={false} onChange={(e) => setElemEditor({ ...elemEditor, a: e.target.value })} />
                </FormRow>
                <FormRow label="Score">
                  <input value={elemEditor.b} onChange={(e) => setElemEditor({ ...elemEditor, b: e.target.value })} />
                </FormRow>
              </>
            )}
            {elemEditor.type === "list" && elemEditor.mode === "new" && (
              <FormRow label="Push to">
                <select value={elemEditor.a} onChange={(e) => setElemEditor({ ...elemEditor, a: e.target.value })}>
                  <option value="tail">tail (RPUSH)</option>
                  <option value="head">head (LPUSH)</option>
                </select>
              </FormRow>
            )}
            {elemEditor.type === "stream" && elemEditor.mode === "new" && (
              <FormRow label="Entry ID">
                <input value={elemEditor.a} placeholder="* (auto)" spellCheck={false} onChange={(e) => setElemEditor({ ...elemEditor, a: e.target.value })} />
              </FormRow>
            )}
            {elemEditor.type !== "zset" && (
              <div className="inspector-editor-host">
                <CodeInput
                  value={elemEditor.type === "set" ? elemEditor.a : elemEditor.b}
                  onChange={(v) => setElemEditor(elemEditor.type === "set" ? { ...elemEditor, a: v } : { ...elemEditor, b: v })}
                  height="100%"
                  language={elemEditor.type === "stream" || looksJson(elemEditor.type === "set" ? elemEditor.a : elemEditor.b) ? "json" : "plaintext"}
                />
              </div>
            )}
            {elemEditor.type === "stream" && elemEditor.mode === "edit" && (
              <div className="empty-note">Stream entries are immutable — delete and re-add to change one.</div>
            )}
          </div>
          <div className="inspector-edit-foot">
            <span />
            <span className="seg" style={{ display: "inline-flex", gap: 8 }}>
              {elemEditor.mode === "edit" && elemEditor.type !== "stream" && (
                <ToolButton variant="danger" onClick={() => void removeElemDraft()}>
                  <Icon name="trash" /> Remove
                </ToolButton>
              )}
              {elemEditor.mode === "edit" && elemEditor.type === "stream" && (
                <ToolButton variant="danger" onClick={() => void removeElemDraft()}>
                  <Icon name="trash" /> Delete entry
                </ToolButton>
              )}
              {(elemEditor.mode === "new" || elemEditor.type !== "stream") && (
                <ToolButton variant="primary" onClick={() => void saveElemDraft()}>
                  <Icon name="save" /> Save
                </ToolButton>
              )}
            </span>
          </div>
        </div>
      )}
      {pane === "edit" && !elemEditor && (
        <div className="inspector-edit">
          {!selectedKey && <div className="empty-note">Browse keys and click a row — the value is editable right here.</div>}
          {selectedKey && !editable && (
            <div className="empty-note">
              {type === "stream" ? "Stream entries are immutable — use the key editor to add or delete entries." : `Unsupported type "${type}".`}
            </div>
          )}
          {selectedKey && editable && tooLarge && (
            <div className="empty-note">{selectedKey.length} items — too large to edit here, open the key editor instead.</div>
          )}
          {selectedKey && editable && !tooLarge && (
            <div className="inspector-editor-host">
              {full.isLoading ? (
                <div className="empty-note">Loading value…</div>
              ) : (
                <CodeInput
                  value={draft}
                  onChange={setDraft}
                  height="100%"
                  language={type === "string" && !looksJson(draft) ? "plaintext" : "json"}
                />
              )}
            </div>
          )}
          <div className="inspector-edit-foot">
            <span className={dirty ? "dirty" : "saved"}>
              {!selectedKey || !editable || tooLarge ? "" : dirty ? (valid ? "Modified" : "Invalid JSON") : "Saved"}
            </span>
            <span className="seg" style={{ display: "inline-flex", gap: 8 }}>
              <ToolButton title="Discard changes" disabled={!dirty} onClick={() => setDraft(original)}>
                <Icon name="refresh" /> Reset
              </ToolButton>
              <ToolButton variant="primary" disabled={!dirty || !valid || !selectedKey} onClick={() => void save()}>
                <Icon name="save" /> Save
              </ToolButton>
            </span>
          </div>
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
