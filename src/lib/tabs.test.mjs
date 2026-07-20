import assert from "node:assert/strict";
import test from "node:test";
import { connTabId, pickConnTab, pruneConnTabs } from "./tabs.ts";

const tab = (id, kind, connId) => ({ id, kind, title: id, icon: "key", iconClass: "", connId });
const WELCOME = tab("welcome", "welcome", undefined);

test("a kind opens a separate tab per connection", () => {
  assert.notEqual(connTabId("keys", "prod"), connTabId("keys", "local"));
});

test("picking a connection prefers its default view over its other tabs", () => {
  const tabs = [tab("console:prod", "console", "prod"), tab("keys:prod", "keys", "prod")];
  assert.equal(pickConnTab(tabs, "prod", "keys"), "keys:prod");
});

test("picking a connection falls back to whatever of its tabs is open", () => {
  const tabs = [tab("console:prod", "console", "prod")];
  assert.equal(pickConnTab(tabs, "prod", "keys"), "console:prod");
});

test("a connection with nothing open reports null so the caller creates a tab", () => {
  assert.equal(pickConnTab([tab("keys:local", "keys", "local")], "prod", "keys"), null);
});

test("another connection's tabs are never offered", () => {
  const tabs = [tab("keys:local", "keys", "local"), tab("settings", "settings", undefined)];
  assert.equal(pickConnTab(tabs, "prod", "keys"), null);
});

test("pruning drops tabs of deleted connections and keeps global ones", () => {
  const tabs = [tab("keys:gone", "keys", "gone"), tab("keys:prod", "keys", "prod"), WELCOME];
  const out = pruneConnTabs(tabs, "keys:prod", ["prod"], WELCOME);
  assert.deepEqual(out.tabs.map((t) => t.id), ["keys:prod", "welcome"]);
  assert.deepEqual(out.dropped.map((t) => t.id), ["keys:gone"]);
  assert.equal(out.activeTabId, "keys:prod");
});

test("pruning away the active tab moves the selection to a survivor", () => {
  const tabs = [tab("keys:gone", "keys", "gone"), WELCOME];
  assert.equal(pruneConnTabs(tabs, "keys:gone", [], WELCOME).activeTabId, "welcome");
});

test("pruning every tab still leaves one, so activeTabId stays valid", () => {
  const out = pruneConnTabs([tab("keys:gone", "keys", "gone")], "keys:gone", [], WELCOME);
  assert.deepEqual(out.tabs, [WELCOME]);
  assert.equal(out.activeTabId, "welcome");
});

test("nothing to prune reports null so the store skips the update", () => {
  const tabs = [tab("keys:prod", "keys", "prod"), WELCOME];
  assert.equal(pruneConnTabs(tabs, "keys:prod", ["prod"], WELCOME), null);
});
