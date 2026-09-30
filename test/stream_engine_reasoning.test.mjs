import test from "node:test";
import assert from "node:assert/strict";
import { ResponsesStreamEngine } from "../dist/core/stream_engine.js";

test("ResponsesStreamEngine streams reasoning deltas and completes reasoning block", async () => {
  const events = [];
  const writeSse = async (payload) => {
    events.push(payload);
  };

  const engine = new ResponsesStreamEngine("gemini-3-flash", "turn-123");
  await engine.start(writeSse);

  // 1. Stream reasoning chunks from model (e.g. Gemini thinking)
  await engine.processChatChunk(writeSse, {
    choices: [{
      delta: {
        reasoning_content: "Let me think about this step by step. ",
      },
    }],
  });

  await engine.processChatChunk(writeSse, {
    choices: [{
      delta: {
        reasoning_content: "First, check the directory.",
      },
    }],
  });

  // Verify reasoning output_item.added and deltas
  const addedItem = events.find((e) => e.type === "response.output_item.added" && e.item?.type === "reasoning");
  assert.ok(addedItem, "Should emit response.output_item.added for reasoning");
  assert.ok(addedItem.item.id.startsWith("rs_"), "Reasoning item ID should start with rs_");

  const reasoningDeltas = events.filter((e) => e.type === "response.reasoning_text.delta");
  assert.equal(reasoningDeltas.length, 2, "Should emit 2 reasoning deltas");
  assert.equal(reasoningDeltas[0].delta, "Let me think about this step by step. ");
  assert.equal(reasoningDeltas[1].delta, "First, check the directory.");

  // 2. Next, model emits tool call
  await engine.processChatChunk(writeSse, {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_123",
          function: {
            name: "exec_command",
            arguments: "{\"cmd\": \"ls\"}",
          },
        }],
      },
    }],
  });

  // Verify reasoning is closed when tool call arrives
  const reasoningDone = events.find((e) => e.type === "response.reasoning_text.done");
  assert.ok(reasoningDone, "Should emit response.reasoning_text.done");
  assert.equal(reasoningDone.text, "Let me think about this step by step. First, check the directory.");

  const reasoningItemDone = events.find((e) => e.type === "response.output_item.done" && e.item?.type === "reasoning");
  assert.ok(reasoningItemDone, "Should emit response.output_item.done for reasoning");
  assert.equal(reasoningItemDone.item.status, "completed");

  // 3. Finish turn
  await engine.finish(writeSse);

  const completed = events.find((e) => e.type === "response.completed");
  assert.ok(completed, "Should emit response.completed");
  assert.ok(Array.isArray(completed.response.output), "output should be an array");
  
  // Verify output order: reasoning first, then function_call
  const outputTypes = completed.response.output.map((o) => o.type);
  assert.deepEqual(outputTypes, ["reasoning", "function_call"]);
  assert.equal(completed.response.output[0].content[0].text, "Let me think about this step by step. First, check the directory.");
});
