use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use redis::aio::MultiplexedConnection;
use serde::Deserialize;
use serde_json::{json, Value as Json};
use tauri::{AppHandle, Emitter, State};

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(6);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct RedisConn {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub tls: bool,
    #[serde(default)]
    pub tls_insecure: bool,
}

fn make_client(conn: &RedisConn, db: i64) -> Result<redis::Client, String> {
    let addr = if conn.tls {
        redis::ConnectionAddr::TcpTls {
            host: conn.host.clone(),
            port: conn.port,
            insecure: conn.tls_insecure,
            tls_params: None,
        }
    } else {
        redis::ConnectionAddr::Tcp(conn.host.clone(), conn.port)
    };
    let info = redis::ConnectionInfo {
        addr,
        redis: redis::RedisConnectionInfo {
            db,
            username: conn.username.clone().filter(|s| !s.is_empty()),
            password: conn.password.clone().filter(|s| !s.is_empty()),
            protocol: redis::ProtocolVersion::RESP2,
        },
    };
    redis::Client::open(info).map_err(|e| e.to_string())
}

/// Cached multiplexed connections keyed by `connId/db` — invalidated when the
/// connection params hash changes or an IO error surfaces.
#[derive(Default)]
struct ConnCache(tokio::sync::Mutex<HashMap<String, (u64, MultiplexedConnection)>>);

/// Live pub/sub + monitor stream tasks, aborted on stop.
#[derive(Default)]
struct Streams(Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>);

fn conn_hash(conn: &RedisConn) -> u64 {
    let mut h = DefaultHasher::new();
    conn.hash(&mut h);
    h.finish()
}

async fn get_conn(
    cache: &ConnCache,
    conn: &RedisConn,
    conn_id: &str,
    db: i64,
) -> Result<MultiplexedConnection, String> {
    let key = format!("{conn_id}/{db}");
    let hash = conn_hash(conn);
    let mut map = cache.0.lock().await;
    if let Some((h, c)) = map.get(&key) {
        if *h == hash {
            return Ok(c.clone());
        }
    }
    let client = make_client(conn, db)?;
    let c = client
        .get_multiplexed_tokio_connection_with_response_timeouts(RESPONSE_TIMEOUT, CONNECT_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    map.insert(key, (hash, c.clone()));
    Ok(c)
}

async fn drop_conn(cache: &ConnCache, conn_id: &str, db: i64) {
    cache.0.lock().await.remove(&format!("{conn_id}/{db}"));
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// RESP → JSON. Bulk strings become lossy UTF-8 strings; maps/sets keep shape.
fn value_to_json(v: redis::Value) -> Json {
    use redis::Value::*;
    match v {
        Nil => Json::Null,
        Int(i) => json!(i),
        BulkString(b) => json!(lossy(&b)),
        SimpleString(s) => json!(s),
        Okay => json!("OK"),
        Array(items) | Set(items) => Json::Array(items.into_iter().map(value_to_json).collect()),
        Map(pairs) => {
            // JSON keys must be strings — stringify non-string RESP keys
            let mut obj = serde_json::Map::new();
            for (k, val) in pairs {
                let key = match value_to_json(k) {
                    Json::String(s) => s,
                    other => other.to_string(),
                };
                obj.insert(key, value_to_json(val));
            }
            Json::Object(obj)
        }
        Double(d) => json!(d),
        Boolean(b) => json!(b),
        VerbatimString { text, .. } => json!(text),
        BigNumber(n) => json!(n.to_string()),
        Attribute { data, .. } => value_to_json(*data),
        other => json!(format!("{other:?}")),
    }
}

fn build_cmd(parts: &[String]) -> redis::Cmd {
    let mut cmd = redis::cmd(&parts[0]);
    for arg in &parts[1..] {
        cmd.arg(arg);
    }
    cmd
}

/// Run one command. `{"ok": value}` on success, `{"err": message}` for Redis
/// errors (so a console can render them inline instead of throwing).
#[tauri::command]
async fn redis_cmd(
    cache: State<'_, ConnCache>,
    conn: RedisConn,
    conn_id: String,
    db: i64,
    cmd: Vec<String>,
) -> Result<Json, String> {
    if cmd.is_empty() {
        return Err("empty command".into());
    }
    let mut c = get_conn(&cache, &conn, &conn_id, db).await?;
    let mut result = build_cmd(&cmd).query_async::<redis::Value>(&mut c).await;
    if result.as_ref().is_err_and(|e| e.is_io_error() || e.is_connection_dropped()) {
        // stale multiplexed conn (server restart, idle timeout) — reconnect once
        drop_conn(&cache, &conn_id, db).await;
        let mut c = get_conn(&cache, &conn, &conn_id, db).await?;
        result = build_cmd(&cmd).query_async::<redis::Value>(&mut c).await;
    }
    match result {
        Ok(v) => Ok(json!({ "ok": value_to_json(v) })),
        Err(e) if e.is_io_error() || e.is_connection_dropped() => Err(e.to_string()),
        Err(e) => Ok(json!({ "err": e.to_string() })),
    }
}

/// Run many commands over one connection, one result per command (errors inline
/// as `{"err": …}` — a failed TYPE probe must not sink the whole page of keys).
#[tauri::command]
async fn redis_pipeline(
    cache: State<'_, ConnCache>,
    conn: RedisConn,
    conn_id: String,
    db: i64,
    cmds: Vec<Vec<String>>,
) -> Result<Vec<Json>, String> {
    let mut c = get_conn(&cache, &conn, &conn_id, db).await?;
    let mut out = Vec::with_capacity(cmds.len());
    for parts in &cmds {
        if parts.is_empty() {
            out.push(json!({ "err": "empty command" }));
            continue;
        }
        // ponytail: sequential awaits on one multiplexed conn, not a true RESP
        // pipeline — swap to redis::pipe() if key pages ever feel slow
        match build_cmd(parts).query_async::<redis::Value>(&mut c).await {
            Ok(v) => out.push(json!({ "ok": value_to_json(v) })),
            Err(e) if e.is_io_error() || e.is_connection_dropped() => return Err(e.to_string()),
            Err(e) => out.push(json!({ "err": e.to_string() })),
        }
    }
    Ok(out)
}

#[tauri::command]
async fn redis_subscribe_start(
    app: AppHandle,
    streams: State<'_, Streams>,
    sub_id: String,
    conn: RedisConn,
    channels: Vec<String>,
    patterns: Vec<String>,
) -> Result<(), String> {
    let client = make_client(&conn, 0)?;
    let mut pubsub = client.get_async_pubsub().await.map_err(|e| e.to_string())?;
    for ch in &channels {
        pubsub.subscribe(ch).await.map_err(|e| e.to_string())?;
    }
    for p in &patterns {
        pubsub.psubscribe(p).await.map_err(|e| e.to_string())?;
    }
    let id = sub_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut stream = pubsub.into_on_message();
        while let Some(msg) = stream.next().await {
            let _ = app.emit(
                "redis-pubsub-message",
                json!({
                    "subId": id,
                    "channel": msg.get_channel_name(),
                    "pattern": msg.get_pattern::<String>().ok(),
                    "payload": lossy(msg.get_payload_bytes()),
                    "ts": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0),
                }),
            );
        }
    });
    streams.0.lock().map_err(|e| e.to_string())?.insert(sub_id, handle);
    Ok(())
}

#[tauri::command]
async fn redis_monitor_start(
    app: AppHandle,
    streams: State<'_, Streams>,
    monitor_id: String,
    conn: RedisConn,
) -> Result<(), String> {
    let client = make_client(&conn, 0)?;
    let mut monitor = client.get_async_monitor().await.map_err(|e| e.to_string())?;
    monitor.monitor().await.map_err(|e| e.to_string())?;
    let id = monitor_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut stream = monitor.into_on_message::<String>();
        while let Some(line) = stream.next().await {
            let _ = app.emit("redis-monitor-line", json!({ "monitorId": id, "line": line }));
        }
    });
    streams.0.lock().map_err(|e| e.to_string())?.insert(monitor_id, handle);
    Ok(())
}

/// Stop a pub/sub or monitor stream by id.
#[tauri::command]
fn redis_stream_stop(streams: State<'_, Streams>, stream_id: String) -> Result<(), String> {
    if let Some(handle) = streams.0.lock().map_err(|e| e.to_string())?.remove(&stream_id) {
        handle.abort();
    }
    Ok(())
}

/// List installed font family names (macOS: NSFontManager via JXA — no extra crates).
#[tauri::command]
async fn list_fonts() -> Result<Vec<String>, String> {
    let out = std::process::Command::new("osascript")
        .args([
            "-l",
            "JavaScript",
            "-e",
            r#"ObjC.import("AppKit"); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies))"#,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let json = String::from_utf8_lossy(&out.stdout);
    let mut fonts: Vec<String> = serde_json::from_str(json.trim()).map_err(|e| e.to_string())?;
    fonts.retain(|f| !f.starts_with('.')); // hidden system families
    fonts.sort();
    Ok(fonts)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ConnCache::default())
        .manage(Streams::default())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            redis_cmd,
            redis_pipeline,
            redis_subscribe_start,
            redis_monitor_start,
            redis_stream_stop,
            list_fonts
        ])
        .setup(|app| {
            // Custom menu without File > Close Window so ⌘W reaches the webview
            // (used to close the active workspace tab). Edit menu kept for copy/paste.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
                let handle = app.handle();
                let app_menu = Submenu::with_items(
                    handle,
                    "RedisMin",
                    true,
                    &[
                        &PredefinedMenuItem::about(handle, None, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::hide(handle, None)?,
                        &PredefinedMenuItem::hide_others(handle, None)?,
                        &PredefinedMenuItem::show_all(handle, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::quit(handle, None)?,
                    ],
                )?;
                let edit = Submenu::with_items(
                    handle,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(handle, None)?,
                        &PredefinedMenuItem::redo(handle, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::cut(handle, None)?,
                        &PredefinedMenuItem::copy(handle, None)?,
                        &PredefinedMenuItem::paste(handle, None)?,
                        &PredefinedMenuItem::select_all(handle, None)?,
                    ],
                )?;
                let window = Submenu::with_items(
                    handle,
                    "Window",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(handle, None)?,
                        &PredefinedMenuItem::maximize(handle, None)?,
                        &PredefinedMenuItem::fullscreen(handle, None)?,
                    ],
                )?;
                let menu = Menu::with_items(handle, &[&app_menu, &edit, &window])?;
                app.set_menu(menu)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use redis::Value;

    #[test]
    fn resp_values_convert_to_json() {
        assert_eq!(value_to_json(Value::Nil), Json::Null);
        assert_eq!(value_to_json(Value::Int(7)), json!(7));
        assert_eq!(value_to_json(Value::Okay), json!("OK"));
        assert_eq!(
            value_to_json(Value::BulkString(b"hello".to_vec())),
            json!("hello")
        );
        assert_eq!(
            value_to_json(Value::Array(vec![
                Value::BulkString(b"a".to_vec()),
                Value::Int(1),
                Value::Nil,
            ])),
            json!(["a", 1, null])
        );
        assert_eq!(
            value_to_json(Value::Map(vec![(
                Value::BulkString(b"k".to_vec()),
                Value::Int(2)
            )])),
            json!({ "k": 2 })
        );
    }

    #[test]
    fn invalid_utf8_is_lossy_not_fatal() {
        let v = value_to_json(Value::BulkString(vec![0xff, 0xfe, b'x']));
        assert!(v.as_str().unwrap().ends_with('x'));
    }

    /// End-to-end against a local server: `cargo test -- --ignored` (needs redis on 6379).
    #[tokio::test]
    #[ignore]
    async fn live_roundtrip_against_local_redis() {
        let conn = RedisConn {
            host: "127.0.0.1".into(),
            port: 6379,
            username: None,
            password: None,
            tls: false,
            tls_insecure: false,
        };
        let cache = ConnCache::default();
        let run = |cmd: Vec<&str>| {
            let conn = conn.clone();
            let cache = &cache;
            let cmd: Vec<String> = cmd.into_iter().map(String::from).collect();
            async move {
                let mut c = get_conn(cache, &conn, "test", 0).await.unwrap();
                let v = build_cmd(&cmd).query_async::<redis::Value>(&mut c).await;
                v.map(value_to_json).map_err(|e| e.to_string())
            }
        };
        let key = "__redismin_test__";
        assert_eq!(run(vec!["SET", key, "hello"]).await.unwrap(), json!("OK"));
        assert_eq!(run(vec!["GET", key]).await.unwrap(), json!("hello"));
        assert_eq!(run(vec!["TYPE", key]).await.unwrap(), json!("string"));
        run(vec!["HSET", "__redismin_test_h__", "f", "v"]).await.unwrap();
        assert_eq!(
            run(vec!["HGETALL", "__redismin_test_h__"]).await.unwrap(),
            json!(["f", "v"]) // RESP2 flat pairs
        );
        // scan sees the key
        let scan = run(vec!["SCAN", "0", "MATCH", "__redismin_test*", "COUNT", "100"]).await.unwrap();
        assert!(scan[1].as_array().unwrap().iter().any(|k| k == key));
        // redis-level errors are values, not panics
        let mut c = get_conn(&cache, &conn, "test", 0).await.unwrap();
        let err = build_cmd(&["LPUSH".into(), key.into(), "x".into()])
            .query_async::<redis::Value>(&mut c)
            .await;
        assert!(err.is_err());
        assert_eq!(run(vec!["DEL", key, "__redismin_test_h__"]).await.unwrap(), json!(2));
    }
}
