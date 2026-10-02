import test from "node:test";
import assert from "node:assert/strict";
import {
  capThirdPartyChatHistory,
  getThirdPartyHistoryWindow,
  DEFAULT_THIRD_PARTY_HISTORY_WINDOW,
  GOOGLE_THIRD_PARTY_HISTORY_WINDOW,
} from "../dist/core/transformer.js";
import { GoogleGeminiAdapter } from "../dist/adapters/google.js";

test("getThirdPartyHistoryWindow returns 0 by default so all models inherit full context", () => {
  assert.equal(getThirdPartyHistoryWindow("google"), 0);
  assert.equal(getThirdPartyHistoryWindow("gemini"), 0);
  assert.equal(getThirdPartyHistoryWindow("antigravity"), 0);
  assert.equal(getThirdPartyHistoryWindow("minimax"), 0);
  assert.equal(getThirdPartyHistoryWindow("deepseek"), 0);
  assert.equal(getThirdPartyHistoryWindow(), 0);
});

test("capThirdPartyChatHistory preserves initiating user instruction without synthetic notes when explicit window is set", () => {
  // Simulate a user request followed by 25 tool turns (50 messages)
  const messages = [
    { role: "user", content: "更新吧，对比官方最新版本升级并测试" },
  ];

  for (let i = 1; i <= 25; i++) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: `call_${i}`, function: { name: "exec_command", arguments: JSON.stringify({ cmd: `step ${i}` }) } }
      ]
    });
    messages.push({
      role: "tool",
      tool_call_id: `call_${i}`,
      name: "exec_command",
      content: `step ${i} completed successfully with exit code 0`
    });
  }

  // Total messages: 1 + 50 = 51 messages.
  // With windowSize = 10, history would normally truncate to the last 10 messages (all assistant/tool).
  const result = capThirdPartyChatHistory(messages, "google", 10);
  assert.ok(result.dropped > 0, "Should report dropped messages");

  // No synthetic system bridge note injected! The first message MUST be the preserved user prompt!
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[0].content, "更新吧，对比官方最新版本升级并测试");

  // The rest are the most recent tool executions
  const rest = result.messages.slice(1);
  assert.ok(rest.length > 0);
  assert.equal(rest.at(-1).role, "tool");
  assert.equal(rest.at(-1).tool_call_id, "call_25");
});

test("GoogleGeminiAdapter payload starts with user instruction without fallback 'Hello'", () => {
  const adapter = new GoogleGeminiAdapter();

  const messages = [
    { role: "user", content: "更新吧" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_25", function: { name: "exec_command", arguments: "{}" }, thought_signature: "sig_25" }
      ]
    },
    {
      role: "tool",
      tool_call_id: "call_25",
      name: "exec_command",
      content: "All 202 tests passed!"
    }
  ];

  const payload = adapter.transformPayload({
    model: "gemini-3-flash",
    messages,
  });

  assert.ok(payload.body.contents.length >= 2);
  assert.equal(payload.body.contents[0].role, "user");
  assert.equal(payload.body.contents[0].parts[0].text, "更新吧");

  // Verify "Hello" is NEVER injected when real user instruction exists
  for (const turn of payload.body.contents) {
    for (const part of turn.parts || []) {
      if (part.text) {
        assert.notEqual(part.text, "Hello");
      }
    }
  }
});
