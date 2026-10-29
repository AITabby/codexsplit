import test from "node:test";
import assert from "node:assert/strict";
import {
  promptFromMessages,
  BUILTIN_OPENCODE_FREE_MODELS,
} from "../dist/services/opencode_transport.js";

test("promptFromMessages formats single user message cleanly", () => {
  const result = promptFromMessages([{ role: "user", content: "Hello world" }]);
  assert.equal(result.trim(), "User: Hello world");
});

test("promptFromMessages caps long system prompts and preserves latest user query", () => {
  const longSystem = "Rule ".repeat(2000);
  const messages = [
    { role: "system", content: longSystem },
    { role: "user", content: "What is 2+2?" },
  ];
  const result = promptFromMessages(messages);
  assert.match(result, /truncated/);
  assert.match(result, /User: What is 2\+2\?/);
  assert.ok(result.length < 5000);
});

test("promptFromMessages handles multi-turn conversation and prunes older turns", () => {
  const messages = [];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: "user", content: `Question ${i}` });
    messages.push({ role: "assistant", content: `Answer ${i}` });
  }
  messages.push({ role: "user", content: "Final question" });

  const result = promptFromMessages(messages);
  assert.match(result, /User: Final question/);
  // Oldest questions (0 to 15) should be pruned
  assert.equal(result.includes("Question 0"), false);
  // Recent questions should be present
  assert.ok(result.includes("Question 28") || result.includes("Question 29"));
});

test("promptFromMessages handles tool results and array content structures", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", name: "exec_command", id: "call_1" },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_1", output: "Command completed successfully" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Explain the result" },
      ],
    },
  ];
  const result = promptFromMessages(messages);
  assert.match(result, /\[Tool Call: exec_command\]/);
  assert.match(result, /\[Tool Result call_1\]: Command completed successfully/);
  assert.match(result, /User: Explain the result/);
});

test("BUILTIN_OPENCODE_FREE_MODELS contains all active free models with correct context windows", () => {
  const slugs = BUILTIN_OPENCODE_FREE_MODELS.map((m) => m.slug);
  assert.ok(slugs.includes("opencode/deepseek-v4.1-flash-free"));
  assert.ok(slugs.includes("opencode/glm-5.3-flash-free"));
  assert.ok(slugs.includes("opencode/mimo-v2.6-flash-free"));
  assert.ok(slugs.includes("opencode/beam-free"));
  assert.ok(slugs.includes("opencode/big-pickle"));

  const deepseek = BUILTIN_OPENCODE_FREE_MODELS.find((m) => m.id === "deepseek-v4.1-flash-free");
  assert.ok(deepseek);
  assert.equal(deepseek.contextWindow, 131072);
  assert.ok(deepseek.reasoningEfforts?.includes("max"));
});
