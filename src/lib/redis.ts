import { invoke } from "@tauri-apps/api/core";
import type { Connection, KeyMeta, KeyRow } from "./types";

const wire = (conn: Connection) => ({
  host: conn.host,
  port: conn.port,
  username: conn.username ?? null,
  password: conn.password ?? null,
  tls: conn.tls,
  tlsInsecure: conn.tlsInsecure ?? false,
});

/** Backend reply envelope: redis errors come back inline, not as rejections. */
export interface RespResult {
  ok?: unknown;
  err?: string;
}

/** Run one command; redis errors are returned in the envelope. */
export const execRaw = (conn: Connection, db: number, cmd: string[]) =>
  invoke<RespResult>("redis_cmd", { conn: wire(conn), connId: conn.id, db, cmd });

/** Run one command; throw on redis errors — for UI actions where an error is exceptional. */
export async function exec<T = unknown>(conn: Connection, db: number, cmd: string[]): Promise<T> {
  const r = await execRaw(conn, db, cmd);
  if (r.err !== undefined) throw new Error(r.err);
  return r.ok as T;
}

/** Run many commands on one connection; one envelope per command. */
export const pipeline = (conn: Connection, db: number, cmds: string[][]) =>
  invoke<RespResult[]>("redis_pipeline", { conn: wire(conn), connId: conn.id, db, cmds });

// ---------------------------------------------------------------------------
// streams (pub/sub, monitor)

export const subscribeStart = (conn: Connection, subId: string, channels: string[], patterns: string[]) =>
  invoke<void>("redis_subscribe_start", { conn: wire(conn), subId, channels, patterns });

export const monitorStart = (conn: Connection, monitorId: string) =>
  invoke<void>("redis_monitor_start", { conn: wire(conn), monitorId });

export const streamStop = (streamId: string) => invoke<void>("redis_stream_stop", { streamId });

// ---------------------------------------------------------------------------
// keys

export interface ScanPage {
  cursor: string;
  keys: string[];
}

export async function scanKeys(
  conn: Connection,
  db: number,
  cursor: string,
  pattern: string,
  count: number,
  type?: string,
): Promise<ScanPage> {
  const cmd = ["SCAN", cursor, "MATCH", pattern || "*", "COUNT", String(count)];
  if (type) cmd.push("TYPE", type);
  const r = await exec<[string, string[]]>(conn, db, cmd);
  return { cursor: r[0], keys: r[1] ?? [] };
}

/** TYPE + TTL for a page of keys, two probes per key over one connection. */
export async function annotateKeys(conn: Connection, db: number, keys: string[]): Promise<KeyRow[]> {
  if (!keys.length) return [];
  const cmds = keys.flatMap((k) => [["TYPE", k], ["TTL", k]]);
  const rs = await pipeline(conn, db, cmds);
  return keys.map((key, i) => ({
    key,
    type: String(rs[i * 2]?.ok ?? "none"),
    ttl: Number(rs[i * 2 + 1]?.ok ?? -2),
  }));
}

const LENGTH_CMD: Record<string, string> = {
  string: "STRLEN",
  hash: "HLEN",
  list: "LLEN",
  set: "SCARD",
  zset: "ZCARD",
  stream: "XLEN",
};

export async function keyMeta(conn: Connection, db: number, key: string): Promise<KeyMeta> {
  const head = await pipeline(conn, db, [
    ["TYPE", key],
    ["TTL", key],
    ["OBJECT", "ENCODING", key],
    ["MEMORY", "USAGE", key, "SAMPLES", "0"],
  ]);
  const type = String(head[0]?.ok ?? "none");
  const lenCmd = LENGTH_CMD[type];
  let length: number | null = null;
  if (lenCmd) {
    const r = await execRaw(conn, db, [lenCmd, key]);
    if (r.ok !== undefined) length = Number(r.ok);
  }
  return {
    key,
    type,
    ttl: Number(head[1]?.ok ?? -2),
    encoding: head[2]?.ok != null ? String(head[2].ok) : null,
    memory: head[3]?.ok != null ? Number(head[3].ok) : null,
    length,
  };
}

// ---------------------------------------------------------------------------
// INFO parsing

export type InfoSections = Record<string, Record<string, string>>;

export function parseInfo(raw: string): InfoSections {
  const out: InfoSections = {};
  let section = "other";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("#")) {
      section = line.slice(1).trim().toLowerCase();
      out[section] ??= {};
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    (out[section] ??= {})[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** keyspace section: db0 → "keys=12,expires=0,avg_ttl=0" → { db: 0, keys: 12, expires: 0 } */
export function parseKeyspace(info: InfoSections): { db: number; keys: number; expires: number }[] {
  const ks = info.keyspace ?? {};
  return Object.entries(ks)
    .filter(([k]) => /^db\d+$/.test(k))
    .map(([k, v]) => {
      const fields = Object.fromEntries(v.split(",").map((p) => p.split("=") as [string, string]));
      return { db: Number(k.slice(2)), keys: Number(fields.keys ?? 0), expires: Number(fields.expires ?? 0) };
    })
    .sort((a, b) => a.db - b.db);
}

// ---------------------------------------------------------------------------
// console command line tokenizer — redis-cli quoting rules (double/single
// quotes, backslash escapes inside double quotes)

export function splitArgs(input: string): string[] | null {
  const args: string[] = [];
  let i = 0;
  const s = input.trim();
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let arg = "";
    if (s[i] === '"') {
      i++;
      let closed = false;
      while (i < s.length) {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[i + 1];
          arg += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
          i += 2;
          continue;
        }
        if (s[i] === '"') {
          closed = true;
          i++;
          break;
        }
        arg += s[i++];
      }
      if (!closed) return null; // unterminated quote
      args.push(arg);
    } else if (s[i] === "'") {
      i++;
      let closed = false;
      while (i < s.length) {
        if (s[i] === "'") {
          closed = true;
          i++;
          break;
        }
        arg += s[i++];
      }
      if (!closed) return null;
      args.push(arg);
    } else {
      while (i < s.length && !/\s/.test(s[i])) arg += s[i++];
      args.push(arg);
    }
  }
  return args;
}

/** Render a RESP-as-JSON value the way redis-cli does (numbered lists, quoted strings). */
export function formatResp(v: unknown, indent = ""): string {
  if (v === null || v === undefined) return `${indent}(nil)`;
  if (typeof v === "number") return `${indent}(integer) ${v}`;
  if (typeof v === "boolean") return `${indent}${v ? "(true)" : "(false)"}`;
  if (typeof v === "string") return `${indent}"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (Array.isArray(v)) {
    if (!v.length) return `${indent}(empty array)`;
    const pad = `${indent}   `;
    return v
      .map((item, i) => {
        const line = formatResp(item, "");
        const label = `${indent}${i + 1}) `;
        return label + line.split("\n").join(`\n${pad}`);
      })
      .join("\n");
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) return `${indent}(empty hash)`;
    return entries.map(([k, val]) => `${indent}${k} => ${formatResp(val, "")}`).join("\n");
  }
  return `${indent}${String(v)}`;
}

// ---------------------------------------------------------------------------
// command reference for console autocomplete (name + arg hint)

export const REDIS_COMMANDS: [string, string][] = [
  ["GET", "key"],
  ["SET", "key value [EX sec|PX ms] [NX|XX] [KEEPTTL]"],
  ["SETNX", "key value"],
  ["SETEX", "key seconds value"],
  ["GETSET", "key value"],
  ["GETRANGE", "key start end"],
  ["INCR", "key"],
  ["INCRBY", "key increment"],
  ["INCRBYFLOAT", "key increment"],
  ["DECR", "key"],
  ["DECRBY", "key decrement"],
  ["APPEND", "key value"],
  ["STRLEN", "key"],
  ["MGET", "key [key ...]"],
  ["MSET", "key value [key value ...]"],
  ["DEL", "key [key ...]"],
  ["UNLINK", "key [key ...]"],
  ["EXISTS", "key [key ...]"],
  ["EXPIRE", "key seconds [NX|XX|GT|LT]"],
  ["PEXPIRE", "key ms"],
  ["EXPIREAT", "key unix-seconds"],
  ["PERSIST", "key"],
  ["TTL", "key"],
  ["PTTL", "key"],
  ["TYPE", "key"],
  ["RENAME", "key newkey"],
  ["RENAMENX", "key newkey"],
  ["COPY", "src dst [DB n] [REPLACE]"],
  ["DUMP", "key"],
  ["KEYS", "pattern (blocks server — prefer SCAN)"],
  ["SCAN", "cursor [MATCH pat] [COUNT n] [TYPE t]"],
  ["RANDOMKEY", ""],
  ["TOUCH", "key [key ...]"],
  ["OBJECT", "ENCODING|FREQ|IDLETIME|REFCOUNT key"],
  ["MEMORY", "USAGE key [SAMPLES n] | STATS | DOCTOR"],
  ["HGET", "key field"],
  ["HSET", "key field value [field value ...]"],
  ["HSETNX", "key field value"],
  ["HDEL", "key field [field ...]"],
  ["HGETALL", "key"],
  ["HKEYS", "key"],
  ["HVALS", "key"],
  ["HLEN", "key"],
  ["HEXISTS", "key field"],
  ["HINCRBY", "key field increment"],
  ["HRANDFIELD", "key [count [WITHVALUES]]"],
  ["HSCAN", "key cursor [MATCH pat] [COUNT n]"],
  ["LPUSH", "key element [element ...]"],
  ["RPUSH", "key element [element ...]"],
  ["LPOP", "key [count]"],
  ["RPOP", "key [count]"],
  ["LRANGE", "key start stop"],
  ["LLEN", "key"],
  ["LINDEX", "key index"],
  ["LSET", "key index element"],
  ["LINSERT", "key BEFORE|AFTER pivot element"],
  ["LREM", "key count element"],
  ["LTRIM", "key start stop"],
  ["LMOVE", "src dst LEFT|RIGHT LEFT|RIGHT"],
  ["SADD", "key member [member ...]"],
  ["SREM", "key member [member ...]"],
  ["SMEMBERS", "key"],
  ["SCARD", "key"],
  ["SISMEMBER", "key member"],
  ["SRANDMEMBER", "key [count]"],
  ["SPOP", "key [count]"],
  ["SMOVE", "src dst member"],
  ["SUNION", "key [key ...]"],
  ["SINTER", "key [key ...]"],
  ["SDIFF", "key [key ...]"],
  ["SSCAN", "key cursor [MATCH pat] [COUNT n]"],
  ["ZADD", "key [NX|XX] [GT|LT] [CH] score member ..."],
  ["ZREM", "key member [member ...]"],
  ["ZSCORE", "key member"],
  ["ZINCRBY", "key increment member"],
  ["ZCARD", "key"],
  ["ZCOUNT", "key min max"],
  ["ZRANGE", "key start stop [REV] [WITHSCORES]"],
  ["ZRANGEBYSCORE", "key min max [WITHSCORES] [LIMIT off n]"],
  ["ZRANK", "key member"],
  ["ZREVRANK", "key member"],
  ["ZPOPMIN", "key [count]"],
  ["ZPOPMAX", "key [count]"],
  ["ZSCAN", "key cursor [MATCH pat] [COUNT n]"],
  ["XADD", "key [MAXLEN n] id|* field value ..."],
  ["XLEN", "key"],
  ["XRANGE", "key start end [COUNT n]"],
  ["XREVRANGE", "key end start [COUNT n]"],
  ["XREAD", "[COUNT n] [BLOCK ms] STREAMS key id"],
  ["XDEL", "key id [id ...]"],
  ["XTRIM", "key MAXLEN|MINID [~] threshold"],
  ["XINFO", "STREAM|GROUPS|CONSUMERS key"],
  ["XGROUP", "CREATE key group id"],
  ["PFADD", "key [element ...]"],
  ["PFCOUNT", "key [key ...]"],
  ["PFMERGE", "dst [src ...]"],
  ["SETBIT", "key offset value"],
  ["GETBIT", "key offset"],
  ["BITCOUNT", "key [start end]"],
  ["GEOADD", "key lon lat member ..."],
  ["GEODIST", "key m1 m2 [unit]"],
  ["GEOSEARCH", "key FROMMEMBER m BYRADIUS r unit ASC"],
  ["SUBSCRIBE", "channel [channel ...]"],
  ["PSUBSCRIBE", "pattern [pattern ...]"],
  ["PUBLISH", "channel message"],
  ["PUBSUB", "CHANNELS [pat] | NUMSUB | NUMPAT"],
  ["MULTI", ""],
  ["EXEC", ""],
  ["DISCARD", ""],
  ["WATCH", "key [key ...]"],
  ["EVAL", "script numkeys [key ...] [arg ...]"],
  ["EVALSHA", "sha1 numkeys [key ...] [arg ...]"],
  ["SCRIPT", "LOAD|EXISTS|FLUSH"],
  ["FUNCTION", "LIST|LOAD|DUMP|STATS"],
  ["SELECT", "index"],
  ["DBSIZE", ""],
  ["FLUSHDB", "[ASYNC|SYNC] — deletes every key in this db"],
  ["FLUSHALL", "[ASYNC|SYNC] — deletes every key in every db"],
  ["SWAPDB", "index1 index2"],
  ["MOVE", "key db"],
  ["PING", "[message]"],
  ["ECHO", "message"],
  ["AUTH", "[username] password"],
  ["HELLO", "[protover]"],
  ["INFO", "[section]"],
  ["CLIENT", "LIST|INFO|GETNAME|SETNAME|KILL|NO-EVICT"],
  ["COMMAND", "COUNT|DOCS|INFO"],
  ["CONFIG", "GET pattern | SET param value | REWRITE"],
  ["SLOWLOG", "GET [n] | LEN | RESET"],
  ["ACL", "LIST|CAT|WHOAMI|GETUSER"],
  ["LATENCY", "HISTORY|LATEST|RESET|DOCTOR"],
  ["DEBUG", "SLEEP|OBJECT|JMAP"],
  ["LOLWUT", "[VERSION n]"],
  ["WAIT", "numreplicas timeout"],
  ["FAILOVER", "[ABORT]"],
  ["REPLICAOF", "host port | NO ONE"],
  ["LASTSAVE", ""],
  ["BGSAVE", "[SCHEDULE]"],
  ["BGREWRITEAOF", ""],
  ["SAVE", ""],
  ["SHUTDOWN", "[NOSAVE|SAVE]"],
  ["CLUSTER", "INFO|NODES|SLOTS|SHARDS"],
  ["JSON.GET", "key [path]"],
  ["JSON.SET", "key path value"],
  ["JSON.DEL", "key [path]"],
  ["JSON.TYPE", "key [path]"],
];

/** Commands that destroy data broadly — console asks before running these. */
export const DANGEROUS_COMMANDS = new Set(["FLUSHALL", "FLUSHDB", "SHUTDOWN", "FAILOVER", "REPLICAOF", "DEBUG"]);
