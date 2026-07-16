import { exec } from "./redis";
import type { Connection } from "./types";

/** element editor state — lives in the store so KeysView opens it and the right-dock inspector renders it */
export interface ElemEditor {
  key: string;
  type: string;
  /** "edit" targets an existing element, "new" appends */
  mode: "edit" | "new";
  /** hash: field · list: index · set/zset: member · stream: entry id */
  a: string;
  /** hash: value · list: value · zset: score · stream: fields as JSON */
  b: string;
  /** original `a` for renames (set members, hash fields) */
  origA?: string;
}

/** write one collection element — throws a string message for user-facing validation errors */
export async function saveElem(conn: Connection, db: number, ed: ElemEditor): Promise<void> {
  const { key, type, mode, a, b, origA } = ed;
  if (type === "hash") {
    if (!a.trim()) throw new Error("Field required — enter a field name.");
    if (mode === "edit" && origA !== undefined && origA !== a) await exec(conn, db, ["HDEL", key, origA]);
    await exec(conn, db, ["HSET", key, a, b]);
  } else if (type === "list") {
    if (mode === "edit") await exec(conn, db, ["LSET", key, a, b]);
    else await exec(conn, db, [a === "head" ? "LPUSH" : "RPUSH", key, b]);
  } else if (type === "set") {
    if (mode === "edit" && origA !== undefined && origA !== a) await exec(conn, db, ["SREM", key, origA]);
    await exec(conn, db, ["SADD", key, a || b]);
  } else if (type === "zset") {
    const score = Number(b);
    if (!Number.isFinite(score)) throw new Error("Score required — enter a numeric score.");
    if (mode === "edit" && origA !== undefined && origA !== a) await exec(conn, db, ["ZREM", key, origA]);
    await exec(conn, db, ["ZADD", key, String(score), a]);
  } else if (type === "stream") {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(b);
    } catch {
      throw new Error("Invalid JSON — stream entries are added from a JSON object of fields.");
    }
    const args = Object.entries(obj).flatMap(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
    if (!args.length) throw new Error("Empty entry — add at least one field.");
    await exec(conn, db, ["XADD", key, a.trim() || "*", ...args]);
  }
}

/** remove one collection element by its `a` identifier */
export async function deleteElem(conn: Connection, db: number, key: string, type: string, a: string): Promise<void> {
  if (type === "hash") await exec(conn, db, ["HDEL", key, a]);
  else if (type === "set") await exec(conn, db, ["SREM", key, a]);
  else if (type === "zset") await exec(conn, db, ["ZREM", key, a]);
  else if (type === "stream") await exec(conn, db, ["XDEL", key, a]);
  else if (type === "list") {
    // LSET sentinel + LREM — the standard remove-by-index trick
    const sentinel = "__redismin_deleted__";
    await exec(conn, db, ["LSET", key, a, sentinel]);
    await exec(conn, db, ["LREM", key, "1", sentinel]);
  }
}
