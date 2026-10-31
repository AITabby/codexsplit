import test from "node:test";
import assert from "node:assert/strict";
import {
  promptFromMessages,
  sanitizeMessagesForCloudChat,
  BUILTIN_WORKBUDDY_FREE_MODELS,
  findWorkbuddyAppPath,
  hasWorkbuddyCredential,
  fetchWorkbuddyModelsDynamic,
  fetchWorkbuddyModelsFromCache,
  testWorkbuddyModel,
} from "../dist/services/workbuddy_transport.js";
import { SUBSCRIPTION_TRANSPORTS } from "../dist/services/provider_transports.js";
import { SUBSCRIPTION_ACCOUNT_PROVIDERS } from "../dist/services/subscription_account_pool.js";
import { XmlToolTagFilter } from "../dist/core/stream_engine.js";

test("promptFromMessages formats single user message cleanly", () => {
  const result = promptFromMessages([{ role: "user", content: "Hello WorkBuddy" }]);
  assert.equal(result.trim(), "User: Hello WorkBuddy");
});

test("promptFromMessages caps long system prompts and preserves latest user query", () => {
  const longSystem = "Guideline ".repeat(1500);
  const messages = [
    { role: "system", content: longSystem },
    { role: "user", content: "Calculate 10 + 20" },
  ];
  const result = promptFromMessages(messages);
  assert.match(result, /truncated/);
  assert.match(result, /User: Calculate 10 \+ 20/);
  assert.ok(result.length < 5000);
});

test("promptFromMessages handles multi-turn conversation and prunes older turns", () => {
  const messages = [];
  for (let i = 0; i < 25; i++) {
    messages.push({ role: "user", content: `Question ${i}` });
    messages.push({ role: "assistant", content: `Answer ${i}` });
  }
  messages.push({ role: "user", content: "Final turn" });

  const result = promptFromMessages(messages);
  assert.match(result, /User: Final turn/);
  assert.equal(result.includes("Question 0"), false);
  assert.ok(result.includes("Question 23") || result.includes("Question 24"));
});

test("promptFromMessages handles tool results and array content structures", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", name: "fs_read", id: "call_99" },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_99", output: "File content loaded" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Summarize it" },
      ],
    },
  ];
  const result = promptFromMessages(messages);
  assert.match(result, /\[Tool Call: fs_read\]/);
  assert.match(result, /\[Tool Result call_99\]: File content loaded/);
  assert.match(result, /User: Summarize it/);
});

test("BUILTIN_WORKBUDDY_FREE_MODELS contains all active free models with correct context windows", () => {
  const slugs = BUILTIN_WORKBUDDY_FREE_MODELS.map((m) => m.slug);
  assert.ok(slugs.includes("workbuddy/deepseek-v4.1-flash"));
  assert.ok(slugs.includes("workbuddy/hy3"));

  const deepseek = BUILTIN_WORKBUDDY_FREE_MODELS.find((m) => m.id === "deepseek-v4.1-flash");
  assert.ok(deepseek);
  assert.equal(deepseek.contextWindow, 1000000);
  assert.ok(deepseek.reasoningEfforts?.includes("max"));

  const hy3 = BUILTIN_WORKBUDDY_FREE_MODELS.find((m) => m.id === "hy3");
  assert.ok(hy3);
  assert.equal(hy3.contextWindow, 192000);
  assert.ok(hy3.reasoningEfforts?.includes("high"));
});

test("SUBSCRIPTION_TRANSPORTS and SUBSCRIPTION_ACCOUNT_PROVIDERS include workbuddy", () => {
  assert.ok(SUBSCRIPTION_ACCOUNT_PROVIDERS.includes("workbuddy"));
  assert.ok(SUBSCRIPTION_TRANSPORTS.workbuddy);
  assert.equal(SUBSCRIPTION_TRANSPORTS.workbuddy.id, "workbuddy");
  assert.equal(SUBSCRIPTION_TRANSPORTS.workbuddy.apiKeySentinel, "workbuddy-cli-auto");
});

test("findWorkbuddyAppPath and hasWorkbuddyCredential detect WorkBuddy on macOS", () => {
  const appPath = findWorkbuddyAppPath();
  assert.ok(appPath, "WorkBuddy app path should be detected");
  assert.equal(hasWorkbuddyCredential(), true);
});

test("fetchWorkbuddyModelsDynamic returns active free models", async () => {
  const models = await fetchWorkbuddyModelsDynamic();
  assert.ok(Array.isArray(models));
  assert.ok(models.length >= 2, `Expected at least 2 free models, got ${models.length}`);
  const modelIds = models.map((m) => m.id);
  assert.ok(modelIds.includes("deepseek-v4.1-flash"));
  assert.ok(modelIds.includes("hy3"));
  for (const m of models) {
    assert.ok(m.slug.startsWith("workbuddy/"));
    assert.ok(m.name.includes("(Free)"));
  }
});

test("sanitizeMessagesForCloudChat preserves native tool calls, handles orphans, and preserves initial user prompt across multi-turn sessions", () => {
  const dirty = [
    { role: "system", content: "You are an assistant." },
    { role: "user", content: "Initiating user prompt: Open Chrome and visit x.com" },
    { role: "user", content: [] }, // empty array
    { role: "assistant", content: null, tool_calls: [{ id: "t_101", function: { name: "exec_command", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t_101", content: "ls output" },
    { role: "tool", tool_call_id: "orphan_999", content: "orphaned output" }, // no matching assistant tool call
    { role: "user", content: "" }, // empty string
    { role: "user", content: "Final query" },
  ];
  const cleaned = sanitizeMessagesForCloudChat(dirty);
  assert.ok(cleaned.length >= 5);
  assert.equal(cleaned[0].role, "system");
  assert.equal(cleaned[0].content, "You are an assistant.");

  // Initiating user prompt is preserved
  assert.equal(cleaned[1].role, "user");
  assert.equal(cleaned[1].content, "Initiating user prompt: Open Chrome and visit x.com");

  // Paired assistant tool call is preserved
  const assistantMsg = cleaned.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  assert.ok(assistantMsg, "Assistant tool_calls must be preserved");
  assert.equal(assistantMsg.tool_calls[0].id, "t_101");

  // Paired tool result is preserved as native role: "tool"
  const pairedToolMsg = cleaned.find((m) => m.role === "tool");
  assert.ok(pairedToolMsg, "Paired tool message must have role tool");
  assert.equal(pairedToolMsg.tool_call_id, "t_101");
  assert.equal(pairedToolMsg.content, "ls output");

  // Orphaned tool result is safely adapted to role: "user" to prevent OpenAI HTTP 400
  const orphanMsg = cleaned.find((m) => m.role === "user" && m.content.includes("orphan_999"));
  assert.ok(orphanMsg, "Orphaned tool result must be adapted to user message");

  // Multi-turn test: ensure initial user prompt is NEVER dropped even after 30 tool iterations
  const longSession = [
    { role: "system", content: "System instructions" },
    { role: "user", content: "Crucial root prompt: do not lose me!" },
  ];
  for (let i = 0; i < 30; i++) {
    longSession.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `step_${i}`, function: { name: "js", arguments: "{}" } }],
    });
    longSession.push({
      role: "tool",
      tool_call_id: `step_${i}`,
      content: `Result ${i}`,
    });
  }
  const cleanedLong = sanitizeMessagesForCloudChat(longSession);
  assert.equal(cleanedLong[0].role, "system");
  assert.equal(cleanedLong[1].role, "user");
  assert.equal(cleanedLong[1].content, "Crucial root prompt: do not lose me!");
});

test("testWorkbuddyModel successfully connects and generates response for free models", async () => {
  const result = await testWorkbuddyModel("workbuddy/deepseek-v4.1-flash", 25000);
  assert.equal(result.status, "connected");
  assert.match(result.message, /模型测试成功/);
});

test("XmlToolTagFilter buffers streaming chunks and extracts dots_function_call to mcp__node_repl_js", () => {
  const filter = new XmlToolTagFilter();
  const sample = 'I will run this.\n\n<dots_function_call>\ninvoke name="node_repl_js">\n<parameter name="code">\nconst sky = await import("@oai/sky");\nnodeRepl.write(JSON.stringify(state));\n</parameter>\n</invoke>\n</dots_function_call>\n\nFinished!';

  let emittedText = "";
  const emittedCalls = [];
  // Send in small 6-character chunks to simulate real SSE streaming
  for (let i = 0; i < sample.length; i += 6) {
    const chunk = sample.slice(i, i + 6);
    const res = filter.filter(chunk);
    if (res.text) emittedText += res.text;
    if (res.calls.length) emittedCalls.push(...res.calls);
  }
  const flushed = filter.flush();
  if (flushed.text) emittedText += flushed.text;
  if (flushed.calls.length) emittedCalls.push(...flushed.calls);

  assert.equal(emittedCalls.length, 1);
  assert.equal(emittedCalls[0].function.name, "mcp__node_repl_js");
  const parsedArgs = JSON.parse(emittedCalls[0].function.arguments);
  assert.match(parsedArgs.code, /nodeRepl\.write/);
  assert.equal(emittedText.includes("<dots_function_call>"), false);
  assert.equal(emittedText.includes("invoke name"), false);
  assert.match(emittedText, /I will run this\./);
  assert.match(emittedText, /Finished!/);
});
