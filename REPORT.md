# RedisMin — Báo cáo build (đêm 2026-07-16)

App mới nằm ở `/Users/qc-bright/Project/redis_min`. Đã build xong, test xong, bundle `.app` (xem cuối file). Đọc file này xong là nắm được toàn bộ.

## Chạy thử ngay

```sh
cd ~/Project/redis_min
npm run tauri dev        # dev mode
# hoặc mở bundle: src-tauri/target/release/bundle/macos/RedisMin.app
```

Redis local của anh đang chạy sẵn trên `127.0.0.1:6379` (đã PING ok) — mở app, New Connection, bấm Save là vào.

## Đã verify những gì

| Check | Kết quả |
|---|---|
| `npx tsc --noEmit` | 0 lỗi |
| `npm run build` (vite production) | OK |
| `cargo check` + `cargo test` | 3/3 pass |
| Integration test với Redis thật (`cargo test -- --include-ignored`) | PASS — SET/GET/TYPE/HSET/HGETALL/SCAN/DEL + case lỗi (WRONGTYPE) chạy đúng qua đúng code path của backend |
| GUI click-through | **Chưa** — tôi không mở được cửa sổ app để tự click. Sáng anh mở lên vọc là biết ngay. |

## Tính năng (so với Another Redis Desktop Manager)

**Ngang hoặc hơn ARDM:**
1. **Keys browser** — SCAN cursor (không bao giờ dùng KEYS), match pattern, filter theo type, **tree view theo namespace `:`** có gộp folder đơn con (`a:b:` thành một dòng), TTL hiển thị live, load-more phân trang. Right-click: open / copy name / set TTL / rename / delete. **Right-click vào folder: xoá cả namespace** (SCAN + DEL theo batch) — ARDM không có.
2. **Key editor đủ 6 type** — string (Monaco, tự detect JSON + Format), hash, list, set, zset, stream. Thêm/sửa/xoá phần tử, phân trang từng type (HSCAN/SSCAN/LRANGE/ZRANGE/XREVRANGE). List xoá theo index (trick LSET sentinel + LREM). Stream immutable — chỉ thêm/xoá entry, đúng semantics Redis. Có RedisJSON cơ bản (JSON.GET/SET).
3. **Console thật sự ngon** — gõ lệnh bất kỳ, output kiểu redis-cli (`1) ...`, `(integer)`, `(nil)`, `(error)` đỏ), lịch sử ↑↓ lưu localStorage, **Tab-completion ~150 lệnh kèm gợi ý cú pháp arg**, đo ms mỗi lệnh, `SELECT n` đổi db cả app, `clear`/⌘L. FLUSHALL/FLUSHDB/SHUTDOWN... hỏi xác nhận trước khi chạy.
4. **Server Info 5 tab** — Overview (version, uptime, memory + bar maxmemory, ops/sec, hit rate, evicted...), **Clients (kèm CLIENT KILL)**, **Slowlog (kèm reset)**, **Config (CONFIG GET * — double-click để CONFIG SET live)**, Raw INFO. ARDM chỉ có status cơ bản.
5. **Pub/Sub** — subscribe channel + pattern song song, tail realtime (stream từ Rust qua Tauri event), pause/filter, publish ngay trong view.
6. **Monitor** — tail lệnh MONITOR realtime, filter, pause, cap 10k dòng. ARDM không có.
7. **Inspector dock phải** — click key ở browser là thấy preview value (sample nhỏ theo type) + metadata (type, TTL, OBJECT ENCODING, MEMORY USAGE, length) không cần mở tab.
8. **16 databases** ở sidebar kèm số key mỗi db (INFO keyspace), click đổi db toàn app.
9. UX gia đình _min: ⌘K palette (mở key gần đây, đổi db, đổi connection), tab kéo-thả + rename, ⌘1-9, vim mode trong editor, 27+ themes, compact mode, đổi font/size toàn app.

**ARDM có mà RedisMin chưa có (chủ động bỏ):**
- Cluster / Sentinel / SSH tunnel — connect node đơn thôi. (Ghi rõ trong UI. Cần thì làm sau: redis crate có `cluster-async`.)
- Import/export RDB, memory analysis chart. Console + `MEMORY USAGE` cover được phần lớn.
- Binary-safe keys/values: giá trị binary hiển thị lossy UTF-8 (đủ cho dev thường ngày).

## Kiến trúc

- **Backend Rust siêu mỏng (~350 dòng), 6 command:**
  - `redis_cmd` — executor tổng quát: nhận `Vec<String>`, trả RESP→JSON. **Một command này chạy cả console lẫn 90% UI.**
  - `redis_pipeline` — nhiều lệnh trên 1 connection (annotate TYPE+TTL cho cả trang keys), lỗi trả inline từng lệnh.
  - `redis_subscribe_start` / `redis_monitor_start` / `redis_stream_stop` — stream qua Tauri events, abort theo id.
  - `list_fonts` — giống các app kia.
  - Connection cache: MultiplexedConnection theo `connId/db`, tự reconnect 1 lần khi đứt (server restart).
  - Lỗi Redis (WRONGTYPE...) trả về `{err}` để console in inline; lỗi IO mới reject.
- **Crate `redis` thuần Rust** (tokio + rustls) — không cần cmake/openssl như KafkaMin.
- **Frontend**: copy nguyên shell KafkaMin (titlebar/sidebar/tabs/inspector/statusbar/palette/dialog/toast + 6 file CSS design system, `themes.ts` giữ nguyên). Logic domain mới nằm ở `lib/redis.ts` (wrapper + tokenizer quote kiểu redis-cli + parse INFO + render RESP), `store.ts` (tab model: key tabs giống messages tabs), 9 views.
- Persist: connections trong `redismin.json` (tauri store), session/tabs/theme/history trong localStorage namespace `redismin:`.

## Khảo sát 2 app anh yêu cầu đọc (để đối chiếu)

- **ElasticMin**: 13 loại tab (query/quick-query/docs/indexes/cluster/mapping...), backend 3 command (`es_request` proxy + `ai_chat` + `list_fonts`), TanStack Query, **AI chat trong Inspector** (sinh ES query từ mapping), Monaco + vim, diff modal khi save doc.
- **RequestsMin**: đa giao thức HTTP/gRPC/WS, collections lưu file `~/RequestsMin/` (git-friendly, secrets tách riêng khỏi folder sync), import curl/Postman/OpenAPI, GitHub sync bằng PAT, backend Rust chia module + có cargo test.
- **Điểm chung tôi đã theo đúng ở RedisMin**: shell layout + 6 file CSS + themes.ts y hệt, zustand `useApp` cùng shape action, `openDialog` promise thay window.prompt, localStorage `<app>:`, invoke wrappers tập trung 1 file, `Result<T,String>` mọi command, menu macOS giữ ⌘W cho webview.
- **Gợi ý follow-up cho đồng bộ gia đình**: (1) AI chat trong Inspector như ElasticMin — sinh lệnh Redis từ mô tả; (2) KafkaMin đang thiếu `themeContract.ts` mới? không — RedisMin dùng bản KafkaMin, ok; (3) cân nhắc đổi logo (hiện đang tạm dùng logo của KafkaMin ở `src/assets/logo.png` — anh thay PNG rồi chạy `./bundle-macos.sh` là icon mới).

## Việc còn mở (nếu muốn hết ga tiếp)

1. Logo riêng cho RedisMin (đang mượn logo KafkaMin).
2. Cluster mode (`cluster-async`), SSH tunnel.
3. TTL countdown tự giảm trong bảng keys (hiện đúng tại thời điểm scan).
4. Memory analysis (top key theo MEMORY USAGE qua SCAN sample).
5. AI chat sinh lệnh (đồng bộ với ElasticMin).

`ponytail:` comments trong code đánh dấu 2 shortcut có chủ đích: pipeline backend đang chạy tuần tự trên 1 connection (đủ nhanh; đổi sang `redis::pipe()` nếu trang keys chậm), và một số cap hiển thị.

— Claude, build qua đêm theo yêu cầu. Chưa commit gì cả (theo rule), working tree để nguyên cho anh xem.
