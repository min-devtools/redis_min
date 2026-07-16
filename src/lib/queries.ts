import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { Connection } from "./types";
import { exec, execRaw, parseInfo, parseKeyspace, type InfoSections } from "./redis";
import { activeConnection, useApp } from "../store";

/** One server sync every 10s is plenty — applies to all background polling. */
const SYNC_INTERVAL = 10_000;

export function useActiveConnection(): Connection | null {
  return useApp((s) => activeConnection(s));
}

/** INFO — parsed sections; doubles as the connectivity probe. */
export function useServerInfo() {
  const conn = useActiveConnection();
  return useQuery<InfoSections>({
    queryKey: ["server-info", conn?.id],
    queryFn: async () => parseInfo(await exec<string>(conn!, 0, ["INFO"])),
    enabled: !!conn,
    refetchInterval: SYNC_INTERVAL,
    staleTime: SYNC_INTERVAL,
  });
}

/** Databases with keys (INFO keyspace) merged over the configured db count. */
export function useDatabases() {
  const conn = useActiveConnection();
  const info = useServerInfo();
  const dbCount = useQuery({
    queryKey: ["db-count", conn?.id],
    queryFn: async () => {
      // CONFIG may be disabled on managed servers — fall back to 16
      const r = await execRaw(conn!, 0, ["CONFIG", "GET", "databases"]);
      const arr = r.ok as string[] | undefined;
      return arr && arr.length >= 2 ? Number(arr[1]) || 16 : 16;
    },
    enabled: !!conn,
    staleTime: Infinity,
  });
  const populated = info.data ? parseKeyspace(info.data) : [];
  const byDb = new Map(populated.map((d) => [d.db, d]));
  const count = dbCount.data ?? 16;
  const dbs = Array.from({ length: count }, (_, i) => ({
    db: i,
    keys: byDb.get(i)?.keys ?? 0,
    expires: byDb.get(i)?.expires ?? 0,
  }));
  return { dbs, isLoading: info.isLoading, isError: info.isError };
}

export function useSystemFonts() {
  return useQuery({
    queryKey: ["system-fonts"],
    queryFn: () => invoke<string[]>("list_fonts"),
    staleTime: Infinity,
  });
}
