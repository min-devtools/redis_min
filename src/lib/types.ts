import type { IconName } from "../ui/Icon";

export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** default logical database selected on connect */
  db: number;
  tls: boolean;
  tlsInsecure?: boolean;
}

/** TYPE reply: string | hash | list | set | zset | stream | ReJSON-RL | … */
export type RedisType = string;

export interface KeyRow {
  key: string;
  type: RedisType;
  /** seconds; -1 = no expiry, -2 = key gone */
  ttl: number;
}

export interface KeyMeta extends KeyRow {
  encoding: string | null;
  /** MEMORY USAGE in bytes (null when unsupported, e.g. old servers) */
  memory: number | null;
  /** type-appropriate length: STRLEN/HLEN/LLEN/SCARD/ZCARD/XLEN */
  length: number | null;
}

/** batched stream event from the backend — items are flushed every ~60ms */
export interface StreamBatch<T> {
  id: string;
  items: T[];
}

export interface PubSubMsg {
  channel: string;
  pattern: string | null;
  payload: string;
  ts: number;
}

/** One console interaction: the command line and its rendered result. */
export interface ConsoleEntry {
  id: number;
  db: number;
  input: string;
  /** result pre-rendered with formatResp at push time (absent when err) */
  out?: string;
  err?: string;
  /** round-trip in ms */
  ms: number;
}

export type TabKind =
  | "welcome"
  | "connection"
  | "keys"
  | "key"
  | "console"
  | "info"
  | "pubsub"
  | "monitor"
  | "settings";

export interface TabDef {
  id: string;
  kind: TabKind;
  title: string;
  icon: IconName;
  iconClass: string;
}

export interface KeyTabState {
  key: string;
  /** open in "create new key" mode */
  create?: boolean;
}
