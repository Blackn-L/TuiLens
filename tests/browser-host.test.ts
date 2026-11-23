import assert from "node:assert/strict";
import test from "node:test";
import { BrowserHost } from "../src/engine/browser-host.js";

interface FakeBrowser {
  close(): Promise<void>;
  isConnected(): boolean;
}

test("启动完成前引用归零时，宿主会关闭新浏览器而不是遗留进程", async () => {
  const host = new BrowserHost();
  let closed = 0;
  const browser: FakeBrowser = {
    close: async () => {
      closed += 1;
    },
    isConnected: () => true,
  };
  let resolvePending!: (value: FakeBrowser) => void;
  const pending = new Promise<FakeBrowser>((resolve) => {
    resolvePending = resolve;
  });
  (host as unknown as { pending: Promise<FakeBrowser> }).pending = pending;

  const disposal = (host as unknown as { dispose(): Promise<void> }).dispose();
  (host as unknown as { browser?: FakeBrowser }).browser = browser;
  resolvePending(browser);
  await disposal;

  assert.equal(closed, 1);
  assert.equal((host as unknown as { browser?: FakeBrowser }).browser, undefined);
});
