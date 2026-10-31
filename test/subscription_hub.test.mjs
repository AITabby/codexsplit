import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  SubscriptionAccountPool,
  SUBSCRIPTION_ACCOUNT_PROVIDERS,
} from "../dist/services/subscription_account_pool.js";
import {
  SubscriptionAccountLoginService,
  SUBSCRIPTION_LOGIN_CAPABILITIES,
} from "../dist/services/subscription_account_auth.js";
import { SubscriptionAuthService } from "../dist/services/subscription_auth.js";
import { streamCloudFreeChat } from "../dist/services/workbuddy_transport.js";

test("subscription hub: capabilities support direct entry across all providers", () => {
  for (const provider of SUBSCRIPTION_ACCOUNT_PROVIDERS) {
    const cap = SUBSCRIPTION_LOGIN_CAPABILITIES[provider];
    assert.ok(cap, `Capability missing for ${provider}`);
    assert.equal(cap.direct_entry_supported, true, `${provider} should support direct_entry_supported`);
  }
});

test("subscription hub: zero-install free credentials always report ready", () => {
  assert.equal(SubscriptionAuthService.hasOpencodeCredential(), true);
  assert.equal(SubscriptionAuthService.hasWorkbuddyCredential(), true);
});

test("subscription hub: addDirectCredential writes valid credential files and registers accounts", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexsplit-sub-test-"));
  try {
    const pool = new SubscriptionAccountPool(tempDir);
    const authService = new SubscriptionAccountLoginService(pool);

    // 1. Cursor direct token
    const cursorResult = await authService.addDirectCredential("cursor", {
      label: "Cursor Pro Direct",
      token: "ey-cursor-test-access-token",
      refreshToken: "cursor-refresh-token",
    });
    assert.equal(cursorResult.created, true);
    assert.equal(cursorResult.account.auth_status, "ready");
    assert.equal(cursorResult.account.label, "Cursor Pro Direct");
    const cursorCredFile = path.join(cursorResult.account.profile_dir, "credentials.json");
    assert.ok(fs.existsSync(cursorCredFile));
    const cursorJson = JSON.parse(fs.readFileSync(cursorCredFile, "utf-8"));
    assert.equal(cursorJson.accessToken, "ey-cursor-test-access-token");
    assert.equal(cursorJson.refreshToken, "cursor-refresh-token");

    // 2. Antigravity direct token
    const agResult = await authService.addDirectCredential("antigravity", {
      label: "AG Account Direct",
      token: "ag-direct-token-12345",
    });
    assert.equal(agResult.created, true);
    assert.equal(agResult.account.auth_status, "ready");
    const agAuthFile = path.join(agResult.account.profile_dir, "auth.json");
    assert.ok(fs.existsSync(agAuthFile));
    const agJson = JSON.parse(fs.readFileSync(agAuthFile, "utf-8"));
    assert.equal(agJson.token.access_token, "ag-direct-token-12345");

    // 3. Claude direct token
    const claudeResult = await authService.addDirectCredential("claude", {
      label: "Claude Direct Key",
      token: "sk-ant-test-token-67890",
    });
    assert.equal(claudeResult.created, true);
    assert.equal(claudeResult.account.auth_status, "ready");
    const claudeCredFile = path.join(claudeResult.account.profile_dir, "credentials.json");
    assert.ok(fs.existsSync(claudeCredFile));
    const claudeJson = JSON.parse(fs.readFileSync(claudeCredFile, "utf-8"));
    assert.equal(claudeJson.accessToken, "sk-ant-test-token-67890");

    // 4. Grok direct token
    const grokResult = await authService.addDirectCredential("grok", {
      label: "Grok Direct Key",
      token: "grok-session-key-test",
    });
    assert.equal(grokResult.created, true);
    assert.equal(grokResult.account.auth_status, "ready");
    const grokAuthFile = path.join(grokResult.account.profile_dir, "auth.json");
    assert.ok(fs.existsSync(grokAuthFile));
    const grokJson = JSON.parse(fs.readFileSync(grokAuthFile, "utf-8"));
    assert.equal(grokJson.default.token, "grok-session-key-test");

    // 5. Duplicate detection
    const duplicateCursor = await authService.addDirectCredential("cursor", {
      label: "Cursor Pro Duplicate",
      token: "ey-cursor-test-access-token",
      refreshToken: "cursor-refresh-token",
    });
    assert.equal(duplicateCursor.created, false);
    assert.equal(duplicateCursor.account.id, cursorResult.account.id);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("subscription hub: cloud free streaming connects and returns standard SSE chunks", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await streamCloudFreeChat(
      [{ role: "user", content: "ping" }],
      "kilo-auto/free",
      { timeoutMs: 12000 },
      controller.signal,
    );
    assert.ok(res.ok);
    assert.equal(res.headers.get("Content-Type")?.includes("text/event-stream"), true);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let gotData = false;
    let iterations = 0;

    while (iterations++ < 10) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      if (text.includes("data:")) {
        gotData = true;
        break;
      }
    }
    await reader.cancel();
    assert.equal(gotData, true, "Should have received at least one SSE data chunk");
  } finally {
    clearTimeout(timer);
  }
});
