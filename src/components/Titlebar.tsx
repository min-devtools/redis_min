import { useQueryClient } from "@tanstack/react-query";
import { ToolButton } from "../ui/ToolButton";
import { Badge } from "../ui/Badge";
import { Icon } from "../ui/Icon";
import { useApp } from "../store";
import { useActiveConnection, useServerInfo } from "../lib/queries";
import logo from "../assets/logo.png";
import { themeBase } from "../lib/themes";

export function Titlebar() {
  const conn = useActiveConnection();
  const info = useServerInfo();
  const { toggleTheme, toggleCompact, setCommandOpen, showToast, theme, openTab, runActive, tabs, activeTabId } = useApp();
  const queryClient = useQueryClient();
  const activeKind = tabs.find((t) => t.id === activeTabId)?.kind;
  const activeRunnable = activeKind === "keys" || activeKind === "console" || activeKind === "key";

  const version = info.data?.server?.redis_version;
  const tone = !conn ? "idle" : info.isError ? "red" : info.data ? "green" : "idle";
  const label = !conn
    ? "no server"
    : info.isError
      ? "unreachable"
      : version
        ? `redis ${version}`
        : "connecting…";

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="traffic">
        <img src={logo} alt="" className="app-logo" />
        <strong>RedisMin</strong>
        <Badge tone={tone}>{label}</Badge>
      </div>
      <button type="button" className="search" title="Search everywhere (⌘K)" onClick={() => setCommandOpen(true)}>
        <Icon name="search" size={13} />
        <span>Search Everywhere</span>
        <span style={{ marginLeft: "auto" }} />
        <kbd>⌘K</kbd>
      </button>
      <div className="toolbar">
        <ToolButton
          iconOnly
          variant="primary"
          title={activeRunnable ? "Reload view (⌘↵)" : "Browse keys (⌘T)"}
          aria-label="Run"
          onClick={() => (activeRunnable ? runActive() : openTab("keys"))}
        >
          <Icon name="play" />
        </ToolButton>
        <ToolButton iconOnly title="Browse keys (⌘T)" aria-label="Browse keys" onClick={() => openTab("keys")}>
          <Icon name="key" />
        </ToolButton>
        <ToolButton iconOnly title="Console (⌘E)" aria-label="Console" onClick={() => openTab("console")}>
          <Icon name="terminal" />
        </ToolButton>
        <ToolButton iconOnly title="Server info (⌘I)" aria-label="Server info" onClick={() => openTab("info")}>
          <Icon name="gauge" />
        </ToolButton>
        <ToolButton
          iconOnly
          title="Reload server info and key listings"
          aria-label="Refresh"
          onClick={() => {
            void queryClient.invalidateQueries();
            showToast("Refreshed", "Server info and key listings are being reloaded.");
          }}
        >
          <Icon name="refresh" />
        </ToolButton>
        <ToolButton iconOnly title="Toggle theme" aria-label="Toggle theme" onClick={toggleTheme}>
          <Icon name={themeBase(theme) === "dark" ? "sun" : "moon"} />
        </ToolButton>
        <ToolButton iconOnly title="Toggle compact density" aria-label="Toggle compact density" onClick={toggleCompact}>
          <Icon name="rows" />
        </ToolButton>
        <ToolButton iconOnly title="Settings (⌘,)" aria-label="Open settings" onClick={() => openTab("settings")}>
          <Icon name="settings" />
        </ToolButton>
      </div>
    </header>
  );
}
