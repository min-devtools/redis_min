import { useEffect, useMemo, useRef, useState } from "react";
import { ToolButton } from "../../ui/ToolButton";
import { Badge } from "../../ui/Badge";
import { Icon } from "../../ui/Icon";
import { useApp } from "../../store";
import { useActiveConnection } from "../../lib/queries";
import { DANGEROUS_COMMANDS, execRaw, formatResp, REDIS_COMMANDS, splitArgs } from "../../lib/redis";
import type { ConsoleEntry } from "../../lib/types";

const HISTORY_KEY = "redismin:console-history";
const HISTORY_CAP = 200;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

let entrySeq = 0;

export function ConsoleView({ active }: { active: boolean }) {
  const conn = useActiveConnection();
  const { activeDb, setActiveDb, showToast, openDialog } = useApp();
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [db, setDb] = useState(activeDb);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [histIdx, setHistIdx] = useState(-1);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // console db follows the app-wide selection until the user SELECTs locally
  useEffect(() => setDb(activeDb), [activeDb]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  // focus the prompt when the tab opens — also once conn is ready, since the
  // textarea is disabled until then and focus() no-ops on a disabled element
  useEffect(() => {
    if (active && conn) requestAnimationFrame(() => inputRef.current?.focus());
  }, [active, conn]);

  // auto-grow the prompt with its content (single line → multi-line)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [input]);

  // ⌘↵ — focus the prompt
  const runNonce = useApp((s) => s.runNonce);
  const prevNonce = useRef(runNonce);
  useEffect(() => {
    if (runNonce !== prevNonce.current) {
      prevNonce.current = runNonce;
      if (active) inputRef.current?.focus();
    }
  }, [runNonce, active]);

  const firstToken = input.trimStart();
  const suggestions = useMemo(() => {
    if (!firstToken || firstToken.includes(" ")) return [];
    const q = firstToken.toUpperCase();
    return REDIS_COMMANDS.filter(([name]) => name.startsWith(q) && name !== q).slice(0, 8);
  }, [firstToken]);

  const argHint = useMemo(() => {
    const name = firstToken.split(/\s+/)[0]?.toUpperCase();
    if (!name || !firstToken.includes(" ")) return null;
    const found = REDIS_COMMANDS.find(([n]) => n === name || n.startsWith(`${name}.`));
    return found ? `${found[0]} ${found[1]}` : null;
  }, [firstToken]);

  const pushHistory = (line: string) => {
    setHistory((h) => {
      const next = [line, ...h.filter((x) => x !== line)].slice(0, HISTORY_CAP);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  };

  const run = async (line: string) => {
    if (!conn) {
      showToast("No connection", "Connect to a server to use the console.", "warn");
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) return;
    setHistIdx(-1);
    pushHistory(trimmed);
    setInput("");

    if (/^(clear|cls)$/i.test(trimmed)) {
      setEntries([]);
      return;
    }
    const args = splitArgs(trimmed);
    if (!args || !args.length) {
      setEntries((es) => [...es, { id: ++entrySeq, db, input: trimmed, err: "unbalanced quotes", ms: 0 }]);
      return;
    }
    const name = args[0].toUpperCase();
    if (DANGEROUS_COMMANDS.has(name)) {
      const ok = await openDialog({
        kind: "confirm",
        title: `Run ${name}?`,
        message: `${name} can destroy data or disrupt the server. Run it anyway?`,
        confirmLabel: `Run ${name}`,
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    const started = performance.now();
    try {
      const r = await execRaw(conn, db, args);
      const ms = Math.max(1, Math.round(performance.now() - started));
      setEntries((es) => [...es.slice(-500), { id: ++entrySeq, db, input: trimmed, ok: r.ok, err: r.err, ms }]);
      // SELECT switches the console db locally (each command carries its db)
      if (name === "SELECT" && r.err === undefined) {
        const n = Number(args[1]);
        if (Number.isInteger(n) && n >= 0) {
          setDb(n);
          setActiveDb(n);
        }
      }
    } catch (err) {
      const ms = Math.max(1, Math.round(performance.now() - started));
      setEntries((es) => [...es.slice(-500), { id: ++entrySeq, db, input: trimmed, err: String(err), ms }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const singleLine = !input.includes("\n");

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      if (e.shiftKey) return; // Shift+Enter — newline for multi-line commands
      e.preventDefault();
      if (suggestions.length && suggestIdx > 0) {
        setInput(suggestions[suggestIdx - 1][0] + " ");
        setSuggestIdx(0);
        return;
      }
      void run(input);
      return;
    }
    if (e.key === "Tab" && suggestions.length) {
      e.preventDefault();
      setInput(suggestions[Math.max(0, suggestIdx - 1)][0] + " ");
      setSuggestIdx(0);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (suggestions.length) {
        setSuggestIdx((i) => Math.max(0, i - 1) || suggestions.length);
        return;
      }
      if (!singleLine) return; // let caret move inside a multi-line command
      const next = Math.min(history.length - 1, histIdx + 1);
      if (history[next] !== undefined) {
        setHistIdx(next);
        setInput(history[next]);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (suggestions.length) {
        setSuggestIdx((i) => (i >= suggestions.length ? 0 : i + 1));
        return;
      }
      if (!singleLine) return;
      const next = histIdx - 1;
      setHistIdx(next);
      setInput(next < 0 ? "" : history[next]);
      return;
    }
    if (e.key === "l" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setEntries([]);
    }
  };

  // typing anywhere in the console (not already in the box) jumps to the prompt
  // and keeps the keystroke, so you never have to click the input first
  const sectionKeyDown = (e: React.KeyboardEvent) => {
    if (!conn || busy || e.target === inputRef.current) return;
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      inputRef.current?.focus();
      setInput((v) => v + e.key);
      setSuggestIdx(0);
    }
  };

  return (
    <section
      className={`content ${active ? "active" : ""}`}
      style={{ gridTemplateRows: "38px minmax(0, 1fr) auto", background: "var(--editor-bg)" }}
      onKeyDown={sectionKeyDown}
    >
      <div className="docs-preview-head">
        <strong>Console</strong>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <Badge tone={conn ? "green" : "idle"}>{conn ? `${conn.name} · db${db}` : "no connection"}</Badge>
          <ToolButton iconOnly title="Clear output (⌘L or `clear`)" onClick={() => setEntries([])}>
            <Icon name="eraser" />
          </ToolButton>
        </span>
      </div>

      <div
        ref={scrollRef}
        onMouseUp={() => { if (!window.getSelection()?.toString()) inputRef.current?.focus(); }}
        style={{ minHeight: 0, overflow: "auto", padding: "10px 14px", font: "1rem/1.6 var(--font-mono)" }}
      >
        {entries.length === 0 && (
          <div className="empty-note" style={{ padding: 0 }}>
            Type any Redis command — GET, HGETALL, SCAN, INFO, CONFIG GET *, SELECT 2 … ↑↓ history, Tab completes, `clear` wipes.
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id} style={{ marginBottom: 10, userSelect: "text" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ color: "var(--blue)" }}>db{e.db}&gt;</span>
              <span style={{ color: "var(--text)" }}>{e.input}</span>
              <span style={{ color: "var(--text-3)", fontSize: "0.8462rem", marginLeft: "auto", flex: "none" }}>{e.ms} ms</span>
            </div>
            {e.err !== undefined ? (
              <pre style={{ margin: "2px 0 0", color: "var(--red)", whiteSpace: "pre-wrap" }}>(error) {e.err}</pre>
            ) : (
              <pre style={{ margin: "2px 0 0", color: "var(--editor-fg)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {formatResp(e.ok ?? null)}
              </pre>
            )}
          </div>
        ))}
        {busy && <div style={{ color: "var(--text-3)" }}>…</div>}
      </div>

      <div style={{ borderTop: "1px solid var(--line)", background: "color-mix(in oklab, var(--window), var(--app-bg) 3%)", position: "relative" }}>
        {suggestions.length > 0 && (
          <div
            style={{
              position: "absolute", bottom: "100%", left: 12, right: 12, marginBottom: 6,
              border: "1px solid var(--line-2)", borderRadius: 10, overflow: "hidden",
              background: "var(--pane)", boxShadow: "var(--shadow)", zIndex: 20,
            }}
          >
            {suggestions.map(([name, hint], i) => (
              <div
                key={name}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setInput(name + " ");
                  inputRef.current?.focus();
                }}
                style={{
                  display: "flex", gap: 10, padding: "6px 10px", cursor: "pointer",
                  background: i === suggestIdx - 1 ? "color-mix(in oklab, var(--blue), transparent 82%)" : "transparent",
                  font: "0.9231rem var(--font-mono)",
                }}
              >
                <span style={{ color: "var(--blue)", minWidth: 120 }}>{name}</span>
                <span style={{ color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</span>
              </div>
            ))}
          </div>
        )}
        {argHint && (
          <div style={{ padding: "4px 14px 0", color: "var(--text-3)", font: "0.8462rem var(--font-mono)" }}>{argHint}</div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 12px" }}>
          <span style={{ color: "var(--blue)", font: "1rem var(--font-mono)", flex: "none", paddingTop: 7 }}>db{db}&gt;</span>
          <textarea
            ref={inputRef}
            className="index-search"
            rows={1}
            style={{ fontFamily: "var(--font-mono)", resize: "none", lineHeight: 1.5, padding: "6px 10px", overflow: "hidden", height: "auto" }}
            placeholder={conn ? "Redis command…  (Enter runs · Shift+Enter newline)" : "connect to a server first"}
            value={input}
            disabled={!conn || busy}
            spellCheck={false}
            onChange={(e) => {
              setInput(e.target.value);
              setSuggestIdx(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
    </section>
  );
}
