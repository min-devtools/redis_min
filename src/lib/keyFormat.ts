/** TTL seconds → human label. -1 = no expiry, -2 = missing key. */
export function formatTtl(ttl: number): string {
  if (ttl === -1) return "no expiry";
  if (ttl < 0) return "gone";
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m ${ttl % 60}s`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h ${Math.floor((ttl % 3600) / 60)}m`;
  return `${Math.floor(ttl / 86400)}d ${Math.floor((ttl % 86400) / 3600)}h`;
}

/** badge tone per redis type — one accent per type, semantic colors only */
export function typeTone(type: string): "blue" | "green" | "yellow" | "red" | "purple" | "idle" {
  switch (type) {
    case "string": return "green";
    case "hash": return "blue";
    case "list": return "yellow";
    case "set": return "purple";
    case "zset": return "yellow";
    case "stream": return "red";
    case "ReJSON-RL": return "blue";
    default: return "idle";
  }
}

export interface KeyTreeNode {
  /** display label: namespace segment or full key */
  label: string;
  /** full prefix ("user:1:") for folders, full key for leaves */
  path: string;
  depth: number;
  isLeaf: boolean;
  /** number of keys under this folder */
  count: number;
}

/**
 * Flatten a key list into an indented tree by `:` namespaces.
 * Folders with a single child collapse into their child ("a:b:" not "a:" > "b:").
 */
export function buildKeyTree(keys: string[], sep: string, collapsed: Set<string>): KeyTreeNode[] {
  interface Dir {
    children: Map<string, Dir>;
    leaves: string[];
    count: number;
  }
  const root: Dir = { children: new Map(), leaves: [], count: 0 };
  for (const key of keys) {
    const parts = key.split(sep);
    let node = root;
    node.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = node.children.get(seg);
      if (!child) {
        child = { children: new Map(), leaves: [], count: 0 };
        node.children.set(seg, child);
      }
      node = child;
      node.count++;
    }
    node.leaves.push(key);
  }

  const out: KeyTreeNode[] = [];
  const walk = (dir: Dir, prefix: string, depth: number) => {
    const folders = [...dir.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [seg, child] of folders) {
      // collapse chains of single-folder children into one row
      let label = seg;
      let path = prefix + seg + sep;
      let target = child;
      while (target.children.size === 1 && target.leaves.length === 0) {
        const [nextSeg, next] = [...target.children.entries()][0];
        label += sep + nextSeg;
        path += nextSeg + sep;
        target = next;
      }
      out.push({ label, path, depth, isLeaf: false, count: target.count });
      if (!collapsed.has(path)) walk(target, path, depth + 1);
    }
    for (const key of dir.leaves.sort()) {
      out.push({ label: key.slice(prefix.length) || key, path: key, depth, isLeaf: true, count: 1 });
    }
  };
  walk(root, "", 0);
  return out;
}
