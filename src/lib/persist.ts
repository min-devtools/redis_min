import { load, type Store } from "@tauri-apps/plugin-store";
import type { Connection } from "./types";
import { useApp } from "../store";

let store: Store | null = null;

export async function initPersistence(): Promise<void> {
  try {
    store = await load("redismin.json", { autoSave: true, defaults: {} });
    const connections = (await store.get<Connection[]>("connections")) ?? [];
    const lastConnId = (await store.get<string | null>("lastConnId")) ?? null;
    useApp.setState({
      connections,
      lastConnId: connections.some((c) => c.id === lastConnId) ? lastConnId : null,
    });
    // connections load after the session is restored, so this is the first chance to drop
    // restored tabs whose connection has since been deleted
    useApp.getState().pruneConnTabs();
  } catch (err) {
    console.error("failed to load persisted store", err);
  }

  let prev = useApp.getState();
  useApp.subscribe((s) => {
    if (store) {
      if (s.connections !== prev.connections) void store.set("connections", s.connections);
      if (s.lastConnId !== prev.lastConnId) void store.set("lastConnId", s.lastConnId);
    }
    // session restore: open tabs (values/results are not persisted)
    if (
      s.tabs !== prev.tabs ||
      s.activeTabId !== prev.activeTabId ||
      s.keyTabs !== prev.keyTabs ||
      s.activeDb !== prev.activeDb
    ) {
      localStorage.setItem(
        "redismin:session",
        JSON.stringify({
          tabs: s.tabs,
          activeTabId: s.activeTabId,
          activeDb: s.activeDb,
          keyTabCounter: s.keyTabCounter,
          keyTabs: s.keyTabs,
        }),
      );
    }
    prev = s;
  });
}
