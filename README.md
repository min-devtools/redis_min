# RedisMin

Minimal Redis/Valkey desktop client (Tauri + React). Shares the design system
used by ElasticMin, RequestsMin and KafkaMin.

## Features

- Multiple saved connections (auth, ACL users, TLS with optional skip-verify), switch from the sidebar or ⌘K
- Keys: SCAN-based browser (never KEYS), match patterns, type filter, tree view by `:` namespaces, TTL column, load-more paging; rename / duplicate (COPY) / TTL / delete per key, delete a whole namespace from the tree
- Key editor per type: string (Monaco, JSON auto-format), hash, list, set, zset, stream — add/edit/remove elements with paging (HSCAN/SSCAN/LRANGE/ZRANGE/XREVRANGE); basic RedisJSON (JSON.GET/JSON.SET)
- Console: full REPL — any command, redis-cli-style output, ↑↓ history (persisted), Tab completion with arg hints, inline errors, `SELECT` switches db, FLUSH-class commands ask first
- Server info: overview metrics (memory, ops/sec, hit rate, evictions), clients (with CLIENT KILL), slowlog, live config (CONFIG SET on double-click), raw INFO
- Pub/Sub: subscribe channels + patterns, live tail with filter/pause, publish
- Monitor: MONITOR stream with filter/pause (heavy on busy servers — starts only on demand)
- 16 databases in the sidebar with per-db key counts; the whole app follows the selected db

## Development

```sh
npm install
npm run tauri dev
```

Rust backend uses the pure-Rust `redis` crate (tokio + rustls) — no system
dependencies.

```sh
cd src-tauri && cargo test                      # unit tests
cd src-tauri && cargo test -- --include-ignored # + live roundtrip (needs redis on 6379)
```

## Build

```sh
npm run app   # .app bundle
```
