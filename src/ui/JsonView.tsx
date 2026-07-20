import { useEffect, useRef, useState } from "react";
import { ToolButton } from "./ToolButton";
import { Icon } from "./Icon";

interface Props {
  value: unknown;
  className?: string;
}

const pathKey = (path: (string | number)[]) => JSON.stringify(path);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const matches = (value: unknown, q: string): boolean => {
  if (!q) return true;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.toLowerCase().includes(q);
};

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const re = new RegExp(`(${escapeRegExp(q)})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i}>{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function LeafValue({ value, q }: { value: unknown; q: string }) {
  if (value === null) return <span className="syntax-null">null</span>;
  if (typeof value === "boolean") return <span className="syntax-bool">{String(value)}</span>;
  if (typeof value === "number") return <span className="syntax-number">{String(value)}</span>;
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return (
    <span className="syntax-string">
      &quot;<Highlight text={raw} q={q} />&quot;
    </span>
  );
}

function TreeNode({
  value,
  path,
  name,
  q,
  collapsed,
  setCollapsed,
}: {
  value: unknown;
  path: (string | number)[];
  name?: string | number;
  q: string;
  collapsed: Set<string>;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const key = pathKey(path);
  const isContainer = value !== null && typeof value === "object";

  const toggle = () => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!isContainer) {
    return (
      <div className="json-tree-line json-tree-leaf">
        <span className="json-tree-toggle placeholder" />
        {name !== undefined && (
          <>
            {typeof name === "number" ? (
              <span className="syntax-number">{String(name)}</span>
            ) : (
              <span className="syntax-key">&quot;<Highlight text={name} q={q} />&quot;</span>
            )}
            <span className="syntax-colon">: </span>
          </>
        )}
        <LeafValue value={value} q={q} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => ({ key: i as number | string, value: v }))
    : Object.entries(value as Record<string, unknown>).map(([k, v]) => ({ key: k, value: v }));
  const isCollapsed = collapsed.has(key);
  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";

  return (
    <div className="json-tree-node">
      <div className="json-tree-line json-tree-branch">
        <button type="button" className="json-tree-toggle" onClick={toggle} aria-label={isCollapsed ? "Expand" : "Collapse"}>
          {isCollapsed ? "▶" : "▼"}
        </button>
        {name !== undefined && (
          <>
            {typeof name === "number" ? (
              <span className="syntax-number">{String(name)}</span>
            ) : (
              <span className="syntax-key">&quot;<Highlight text={name} q={q} />&quot;</span>
            )}
            <span className="syntax-colon">: </span>
          </>
        )}
        <span className="syntax-punc">{open}</span>
        {isCollapsed && (
          <span className="json-tree-summary">
            {isArray ? `[${entries.length}]` : `{${entries.length}}`}
          </span>
        )}
        {!isCollapsed && entries.length === 0 && <span className="syntax-punc">{close}</span>}
      </div>
      {!isCollapsed && entries.length > 0 && (
        <>
          <div className="json-tree-children">
            {entries.map(({ key: childKey, value: childValue }) => (
              <TreeNode
                key={pathKey([...path, childKey])}
                value={childValue}
                path={[...path, childKey]}
                name={childKey}
                q={q}
                collapsed={collapsed}
                setCollapsed={setCollapsed}
              />
            ))}
          </div>
          <div className="json-tree-line json-tree-closer">
            <span className="json-tree-toggle placeholder" />
            <span className="syntax-punc">{close}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function JsonView({ value, className = "json-tree" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const showSearchRef = useRef(showSearch);
  showSearchRef.current = showSearch;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const q = query.trim().toLowerCase();

  // Cmd/Ctrl+F opens the search bar when focus/selection is inside this viewer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f") {
        const inside =
          containerRef.current &&
          (containerRef.current.contains(document.activeElement) ||
            containerRef.current.contains(window.getSelection()?.anchorNode ?? null));
        if (inside) {
          e.preventDefault();
          setShowSearch(true);
          setQuery("");
        }
      }
      if (e.key === "Escape" && showSearchRef.current) {
        e.preventDefault();
        setShowSearch(false);
        setQuery("");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (showSearch) inputRef.current?.focus();
  }, [showSearch]);

  // reset expansion state when the value changes
  useEffect(() => {
    setCollapsed(new Set());
    setShowSearch(false);
    setQuery("");
  }, [value]);

  // expand paths that contain the search query
  useEffect(() => {
    if (!q) return;
    const toExpand = new Set<string>();
    const walk = (v: unknown, path: (string | number)[]): boolean => {
      let childMatch = false;
      if (v !== null && typeof v === "object") {
        if (Array.isArray(v)) {
          v.forEach((child, i) => {
            if (walk(child, [...path, i])) childMatch = true;
          });
        } else {
          Object.entries(v as Record<string, unknown>).forEach(([k, child]) => {
            if (walk(child, [...path, k])) childMatch = true;
          });
        }
      }
      const hit = matches(v, q);
      if (hit || childMatch) {
        for (let i = 0; i <= path.length; i++) toExpand.add(pathKey(path.slice(0, i)));
      }
      return hit || childMatch;
    };
    walk(value, []);
    setCollapsed((prev) => {
      const next = new Set(prev);
      toExpand.forEach((k) => next.delete(k));
      return next;
    });
  }, [q, value]);

  const collapseAll = () => {
    const all = new Set<string>();
    const walk = (v: unknown, path: (string | number)[]) => {
      if (v !== null && typeof v === "object") {
        all.add(pathKey(path));
        if (Array.isArray(v)) v.forEach((child, i) => walk(child, [...path, i]));
        else Object.entries(v as Record<string, unknown>).forEach(([k, child]) => walk(child, [...path, k]));
      }
    };
    walk(value, []);
    setCollapsed(all);
  };

  const expandAll = () => setCollapsed(new Set());

  const toolbar = (
    <div className="json-view-head" style={{ display: showSearch ? "flex" : "none" }}>
      <Icon name="search" size={13} />
      <input
        ref={inputRef}
        value={query}
        placeholder="Search value"
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      {query && (
        <ToolButton iconOnly title="Clear search" onClick={() => setQuery("")}>
          <Icon name="x" size={13} />
        </ToolButton>
      )}
      <ToolButton iconOnly title="Collapse all" onClick={collapseAll}>
        <Icon name="minify" size={13} />
      </ToolButton>
      <ToolButton iconOnly title="Expand all" onClick={expandAll}>
        <Icon name="plus" size={13} />
      </ToolButton>
    </div>
  );

  if (value === undefined || value === null) {
    return (
      <div className="json-view" ref={containerRef}>
        {toolbar}
        <pre className={className}>
          <span className="syntax-null">null</span>
        </pre>
      </div>
    );
  }

  if (typeof value === "string") {
    return (
      <div className="json-view" ref={containerRef}>
        {toolbar}
        <pre className={className}>
          <Highlight text={value} q={q} />
        </pre>
      </div>
    );
  }

  return (
    <div className="json-view" ref={containerRef}>
      {toolbar}
      <div className={`json-view-body ${className}`}>
        <TreeNode value={value} path={[]} q={q} collapsed={collapsed} setCollapsed={setCollapsed} />
      </div>
    </div>
  );
}
