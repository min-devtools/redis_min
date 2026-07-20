import { create } from "zustand";
import { isThemeId, themeBase } from "./lib/themes";
import { clampFontSize, DEFAULT_FONT_SIZE } from "./lib/fontScale";
import type { Connection, KeyMeta, KeyTabState, TabDef, TabKind } from "./lib/types";
import { connTabId, pickConnTab, pruneConnTabs } from "./lib/tabs";
import type { ElemEditor } from "./lib/elemOps";

const TAB_META: Record<TabKind, { title: string; icon: TabDef["icon"]; iconClass: string }> = {
  welcome: { title: "Welcome", icon: "sparkles", iconClass: "soft-blue" },
  connection: { title: "New Connection", icon: "plug", iconClass: "soft-blue" },
  keys: { title: "Keys", icon: "key", iconClass: "soft-orange" },
  key: { title: "Key", icon: "braces", iconClass: "soft-blue" },
  console: { title: "Console", icon: "terminal", iconClass: "soft-green" },
  info: { title: "Server Info", icon: "gauge", iconClass: "soft-green" },
  pubsub: { title: "Pub/Sub", icon: "radio", iconClass: "soft-orange" },
  monitor: { title: "Monitor", icon: "activity", iconClass: "soft-red" },
  settings: { title: "Settings", icon: "settings", iconClass: "soft-orange" },
};

/**
 * Kinds that belong to the app rather than to a server: one instance total, no connection.
 * Every other kind is bound to a connection at creation and is a singleton *per connection*,
 * so "Keys on prod" and "Keys on local" are two separate tabs that never swap servers.
 */
const GLOBAL_KINDS: ReadonlySet<TabKind> = new Set<TabKind>(["welcome", "connection", "settings"]);

/** the tab a connection opens into when you pick it in the sidebar and nothing of its is open yet */
const DEFAULT_CONN_KIND: TabKind = "keys";

function keyTabTitle(key: string): string {
  return key || "New Key";
}

/** Restore last session's open tabs from localStorage (values are not persisted). */
function loadSession(): {
  tabs: TabDef[];
  activeTabId: string;
  keyTabs: Record<string, KeyTabState>;
  keyTabCounter: number;
  activeDb: number;
} | null {
  try {
    const raw = localStorage.getItem("redismin:session");
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!Array.isArray(s.tabs) || s.tabs.length === 0) return null;
    const keyTabs: Record<string, KeyTabState> = {};
    for (const [id, kt] of Object.entries<any>(s.keyTabs ?? {})) {
      keyTabs[id] = { key: typeof kt.key === "string" ? kt.key : "", create: !!kt.create };
    }
    const tabs: TabDef[] = s.tabs
      // connection-bound tabs from a session written before tabs carried connId have no
      // server to belong to — drop them rather than resurrect them pointing at nothing
      .filter((t: TabDef) => TAB_META[t.kind] && (t.kind !== "key" || keyTabs[t.id]) && (GLOBAL_KINDS.has(t.kind) || t.connId))
      .map((t: TabDef) => ({
        ...t,
        icon: TAB_META[t.kind].icon,
        iconClass: TAB_META[t.kind].iconClass,
        title: t.kind === "key" ? keyTabTitle(keyTabs[t.id].key) : t.title,
      }));
    if (!tabs.length) return null;
    return {
      tabs,
      activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs[0].id,
      keyTabs,
      keyTabCounter: Number(s.keyTabCounter) || 0,
      activeDb: Number(s.activeDb) || 0,
    };
  } catch {
    return null;
  }
}

const session = loadSession();

export interface ToastMsg {
  title: string;
  body: string;
  kind?: "ok" | "warn" | "err";
}

export interface DialogRequest {
  kind: "prompt" | "confirm";
  title: string;
  message?: string;
  defaultValue?: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface AppState {
  connections: Connection[];
  /**
   * Connection last brought into focus. NOT the source of truth for which server a view
   * talks to — that is the active tab's own `connId` (see the `activeConnId` selector).
   * This only keeps the sidebar highlight and status badge on the last real connection
   * while a global tab (Settings, Welcome) is in front.
   */
  lastConnId: string | null;
  /** logical redis database index in use across keys/console views */
  activeDb: number;

  tabs: TabDef[];
  activeTabId: string;
  keyTabs: Record<string, KeyTabState>;
  keyTabCounter: number;

  /** key names, most-recently-opened first — drives sidebar "recent keys" */
  keyRecency: string[];
  /** key selected in a Keys tab — its metadata shows in the right-dock inspector */
  selectedKey: KeyMeta | null;
  /** collection element being edited — opened from a key tab, rendered in the right-dock inspector */
  elemEditor: ElemEditor | null;
  /** bumped after the inspector mutates an element — key tabs reload their element list */
  elemMutateNonce: number;
  /** connection being edited in the Connection tab (null = new draft) */
  editingConnId: string | null;

  theme: string;
  compact: boolean;
  vimMode: boolean;
  uiFontSize: number;
  uiFont: string;
  editorFont: string;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  commandOpen: boolean;
  /** bumped by ⌘↵ / titlebar play — the active view reacts (rescan keys, run console) */
  runNonce: number;
  toast: ToastMsg | null;
  dialog: (DialogRequest & { resolve: (value: string | null) => void }) | null;

  // actions
  setConnections: (conns: Connection[]) => void;
  saveConnection: (conn: Connection) => void;
  deleteConnection: (id: string) => void;
  setActiveConn: (id: string | null) => void;
  /** drop tabs whose connection no longer exists (after a delete, or on session restore) */
  pruneConnTabs: () => void;
  setActiveDb: (db: number) => void;

  /** open (or focus) `kind` for `connId`, defaulting to the connection in focus */
  openTab: (kind: TabKind, connId?: string) => void;
  openKeyTab: (key?: string, create?: boolean) => string;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  reorderTab: (id: string, beforeId: string | null) => void;
  renameTab: (id: string, title: string) => void;
  /** rebind a key tab to a new key name (after create/rename) */
  setKeyTabKey: (tabId: string, key: string) => void;

  bumpKeyRecency: (key: string) => void;
  selectKey: (meta: KeyMeta | null) => void;
  setElemEditor: (e: ElemEditor | null) => void;
  bumpElemMutate: () => void;
  setEditingConn: (id: string | null) => void;
  setTheme: (id: string) => void;

  toggleTheme: () => void;
  toggleCompact: () => void;
  toggleVim: () => void;
  setUiFontSize: (size: number) => void;
  setUiFont: (font: string) => void;
  setEditorFont: (font: string) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setCommandOpen: (open: boolean) => void;
  runActive: () => void;
  showToast: (title: string, body: string, kind?: ToastMsg["kind"]) => void;
  clearToast: () => void;
  /** in-app replacement for window.prompt/confirm — those are unimplemented in the Tauri webview */
  openDialog: (req: DialogRequest) => Promise<string | null>;
}

let toastTimer: number | undefined;

/**
 * Which connection the app is currently "in". Read from the active tab, because a tab owns
 * its connection for life — activating a tab is what changes servers, nothing else does.
 * Global tabs carry no connection, so they fall back to the last one focused, which keeps
 * the sidebar from going blank the moment you open Settings.
 */
export const activeConnId = (s: Pick<AppState, "tabs" | "activeTabId" | "lastConnId">) =>
  s.tabs.find((t) => t.id === s.activeTabId)?.connId ?? s.lastConnId;

export const activeConnection = (
  s: Pick<AppState, "connections" | "tabs" | "activeTabId" | "lastConnId">,
) => s.connections.find((c) => c.id === activeConnId(s)) ?? null;

/** the connection a given tab belongs to — drives its color dot and name in the tab bar */
export const tabConnection = (s: Pick<AppState, "connections">, tab: TabDef) =>
  (tab.connId ? s.connections.find((c) => c.id === tab.connId) : null) ?? null;

export const inspectorAvailable = (s: Pick<AppState, "tabs" | "activeTabId">) => {
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  return tab?.kind === "keys" || tab?.kind === "key";
};

export const useApp = create<AppState>((set, get) => ({
  connections: [],
  lastConnId: null,
  activeDb: session?.activeDb ?? 0,

  tabs: session?.tabs ?? [{ id: "welcome", kind: "welcome", ...TAB_META.welcome }],
  activeTabId: session?.activeTabId ?? "welcome",
  keyTabs: session?.keyTabs ?? {},
  keyTabCounter: session?.keyTabCounter ?? 0,

  keyRecency: [],
  selectedKey: null,
  elemEditor: null,
  elemMutateNonce: 0,
  editingConnId: null,

  // default = Bearded Arc (shared with elatic_min/requests_min); invalid stored themes fall back
  theme: (() => {
    const stored = localStorage.getItem("redismin:theme-v2");
    return stored && isThemeId(stored) ? stored : "default-dark";
  })(),
  compact: localStorage.getItem("redismin:compact") === "1",
  vimMode: localStorage.getItem("redismin:vim") === "1",
  uiFontSize: clampFontSize(Number(localStorage.getItem("redismin:ui-font-size")) || DEFAULT_FONT_SIZE),
  uiFont: localStorage.getItem("redismin:ui-font") ?? "",
  editorFont: localStorage.getItem("redismin:editor-font") ?? "",
  leftCollapsed: false,
  rightCollapsed: true,
  commandOpen: false,
  runNonce: 0,
  toast: null,
  dialog: null,

  setConnections: (conns) => set({ connections: conns }),
  saveConnection: (conn) =>
    set((s) => {
      const existing = s.connections.findIndex((c) => c.id === conn.id);
      const connections =
        existing >= 0
          ? s.connections.map((c) => (c.id === conn.id ? conn : c))
          : [...s.connections, conn];
      return { connections };
    }),
  // removing a connection takes its tabs with it — they have no server to talk to anymore
  deleteConnection: (id) => {
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      lastConnId: s.lastConnId === id ? null : s.lastConnId,
    }));
    get().pruneConnTabs();
  },

  pruneConnTabs: () =>
    set((s) => {
      const out = pruneConnTabs(
        s.tabs,
        s.activeTabId,
        s.connections.map((c) => c.id),
        { id: "welcome", kind: "welcome", ...TAB_META.welcome },
      );
      if (!out) return s;
      const keyTabs = { ...s.keyTabs };
      for (const t of out.dropped) delete keyTabs[t.id];
      return { tabs: out.tabs, activeTabId: out.activeTabId, keyTabs };
    }),

  /**
   * Picking a connection means "go to that connection", not "retarget whatever is on screen":
   * focus a tab it already owns, or open its default one. The tab in front keeps its own server.
   */
  setActiveConn: (id) => {
    const s = get();
    if (!id) return set({ lastConnId: null });
    const target = pickConnTab(s.tabs, id, DEFAULT_CONN_KIND);
    if (target) return get().activateTab(target);
    set({ lastConnId: id });
    get().openTab(DEFAULT_CONN_KIND, id);
  },
  setActiveDb: (db) => set({ activeDb: db, selectedKey: null, elemEditor: null }),

  openTab: (kind, connId) => {
    const s = get();
    if (kind === "key") {
      get().openKeyTab();
      return;
    }
    if (GLOBAL_KINDS.has(kind)) {
      const existing = s.tabs.find((t) => t.kind === kind);
      if (existing) return set({ activeTabId: existing.id });
      return set({
        tabs: [...s.tabs, { id: kind, kind, ...TAB_META[kind] }],
        activeTabId: kind,
      });
    }
    // no server to browse — send the user to set one up instead of opening an empty view
    // that would later have to be silently rebound to whatever connection appears first
    const cid = connId ?? activeConnId(s);
    if (!cid) return get().openTab("connection");
    const id = connTabId(kind, cid);
    if (s.tabs.some((t) => t.id === id)) return get().activateTab(id);
    set({
      tabs: [...s.tabs, { id, kind, ...TAB_META[kind], connId: cid }],
    });
    get().activateTab(id);
  },

  openKeyTab: (key, create) => {
    const s = get();
    const cid = activeConnId(s);
    if (!cid) {
      get().openTab("connection");
      return "";
    }
    const k = key ?? "";
    if (k) get().bumpKeyRecency(k);
    const existingId = s.tabs.find(
      (t) => t.kind === "key" && t.connId === cid && s.keyTabs[t.id]?.key === k && !create,
    )?.id;
    if (existingId && k) {
      set({ activeTabId: existingId });
      return existingId;
    }
    const n = s.keyTabCounter + 1;
    const id = `key-${n}`;
    set({
      keyTabCounter: n,
      tabs: [...s.tabs, { id, kind: "key", ...TAB_META.key, title: keyTabTitle(k), connId: cid }],
      activeTabId: id,
      keyTabs: { ...s.keyTabs, [id]: { key: k, create: !!create || !k } },
    });
    return id;
  },

  closeTab: (id) => {
    const s = get();
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    let tabs = s.tabs.filter((t) => t.id !== id);
    const keyTabs = { ...s.keyTabs };
    delete keyTabs[id];
    // renumber from 1 again once the last key tab closes, instead of counting up forever
    const keyTabCounter = tabs.some((t) => t.kind === "key") ? s.keyTabCounter : 0;
    if (tabs.length === 0) tabs = [{ id: "welcome", kind: "welcome", ...TAB_META.welcome }];
    set({ tabs, keyTabs, keyTabCounter });
    // route the successor through activateTab so closing the last tab of a connection
    // clears that connection's leftover state instead of carrying it into the next tab
    if (s.activeTabId === id) get().activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
  },

  /**
   * The one place the app changes servers. Anything scoped to a connection (selected key,
   * element editor, recent keys, current db) is dropped when the incoming tab belongs to a
   * different one, so nothing from the old server leaks into the new view.
   */
  activateTab: (id) =>
    set((s) => {
      const to = s.tabs.find((t) => t.id === id);
      if (!to) return s;
      const from = activeConnId(s);
      if (!to.connId || to.connId === from) return { activeTabId: id };
      return {
        activeTabId: id,
        lastConnId: to.connId,
        selectedKey: null,
        elemEditor: null,
        keyRecency: [],
        activeDb: s.connections.find((c) => c.id === to.connId)?.db ?? 0,
      };
    }),

  reorderTab: (id, beforeId) =>
    set((s) => {
      if (id === beforeId) return s;
      const dragged = s.tabs.find((t) => t.id === id);
      if (!dragged) return s;
      const rest = s.tabs.filter((t) => t.id !== id);
      const idx = beforeId ? rest.findIndex((t) => t.id === beforeId) : -1;
      const tabs = idx < 0 ? [...rest, dragged] : [...rest.slice(0, idx), dragged, ...rest.slice(idx)];
      return { tabs };
    }),

  renameTab: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title: title.trim() || t.title } : t)),
    })),

  setKeyTabKey: (tabId, key) =>
    set((s) => ({
      keyTabs: { ...s.keyTabs, [tabId]: { key, create: false } },
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title: keyTabTitle(key) } : t)),
    })),

  bumpKeyRecency: (key) =>
    set((s) => ({ keyRecency: [key, ...s.keyRecency.filter((k) => k !== key)].slice(0, 50) })),
  // auto show/hide the right-dock inspector with what's selected
  selectKey: (meta) => set({ selectedKey: meta, rightCollapsed: meta === null }),
  setElemEditor: (e) => set((s) => ({ elemEditor: e, rightCollapsed: e ? false : s.rightCollapsed })),
  bumpElemMutate: () => set((s) => ({ elemMutateNonce: s.elemMutateNonce + 1 })),
  setEditingConn: (id) => set({ editingConnId: id }),
  setTheme: (id) => {
    localStorage.setItem("redismin:theme-v2", id);
    set({ theme: id });
  },

  toggleTheme: () =>
    set((s) => {
      const theme = themeBase(s.theme) === "dark" ? "light" : "dark";
      localStorage.setItem("redismin:theme-v2", theme);
      return { theme };
    }),
  toggleCompact: () =>
    set((s) => {
      localStorage.setItem("redismin:compact", s.compact ? "0" : "1");
      return { compact: !s.compact };
    }),
  toggleVim: () =>
    set((s) => {
      localStorage.setItem("redismin:vim", s.vimMode ? "0" : "1");
      return { vimMode: !s.vimMode };
    }),
  setUiFontSize: (size) => {
    const clamped = clampFontSize(size || DEFAULT_FONT_SIZE);
    localStorage.setItem("redismin:ui-font-size", String(clamped));
    set({ uiFontSize: clamped });
  },
  setUiFont: (font) => {
    localStorage.setItem("redismin:ui-font", font);
    set({ uiFont: font });
  },
  setEditorFont: (font) => {
    localStorage.setItem("redismin:editor-font", font);
    set({ editorFont: font });
  },
  toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
  toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
  setCommandOpen: (open) => set({ commandOpen: open }),
  runActive: () => set((s) => ({ runNonce: s.runNonce + 1 })),

  showToast: (title, body, kind) => {
    window.clearTimeout(toastTimer);
    set({ toast: { title, body, kind } });
    toastTimer = window.setTimeout(() => set({ toast: null }), 2600);
  },
  clearToast: () => {
    window.clearTimeout(toastTimer);
    set({ toast: null });
  },

  openDialog: (req) =>
    new Promise<string | null>((resolve) => {
      set({
        dialog: {
          ...req,
          resolve: (value) => {
            resolve(value);
            set({ dialog: null });
          },
        },
      });
    }),
}));
