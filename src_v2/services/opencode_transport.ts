import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync, ChildProcess } from "node:child_process";
import readline from "node:readline";
import { randomBytes } from "node:crypto";
import { streamCloudFreeChat } from "./workbuddy_transport.js";

export interface OpencodeModelDef {
  id: string;
  slug: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoningEfforts?: string[];
  defaultEffort?: string;
  inputModalities?: string[];
}

export const BUILTIN_OPENCODE_FREE_MODELS: OpencodeModelDef[] = [
  {
    id: "big-pickle",
    slug: "opencode/big-pickle",
    name: "Big Pickle (Free)",
    contextWindow: 131072,
    maxTokens: 8192,
    reasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "beam-free",
    slug: "opencode/beam-free",
    name: "Beam (Free)",
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "mimo-v2.6-flash-free",
    slug: "opencode/mimo-v2.6-flash-free",
    name: "MIMO v2.6 Flash (Free)",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "nemotron-3.5-super-vl-free",
    slug: "opencode/nemotron-3.5-super-vl-free",
    name: "Nemotron 3.5 Super VL (Free)",
    contextWindow: 131072,
    maxTokens: 8192,
    inputModalities: ["text", "image"],
  },
  {
    id: "nemotron-3.5-lightning-free",
    slug: "opencode/nemotron-3.5-lightning-free",
    name: "Nemotron 3.5 Lightning (Free)",
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "nemotron-3-ultra-free",
    slug: "opencode/nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra (Free)",
    contextWindow: 131072,
    maxTokens: 8192,
    reasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "jev-1.13-free",
    slug: "opencode/jev-1.13-free",
    name: "JEV 1.13 (Free)",
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "longcat-2.5-preview-free",
    slug: "opencode/longcat-2.5-preview-free",
    name: "Longcat 2.5 Preview (Free)",
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "flint-40b-free",
    slug: "opencode/flint-40b-free",
    name: "Flint 40B (Free)",
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "deepseek-v4.1-flash-free",
    slug: "opencode/deepseek-v4.1-flash-free",
    name: "DeepSeek v4.1 Flash (Free)",
    contextWindow: 131072,
    maxTokens: 8192,
    reasoningEfforts: ["low", "medium", "high", "max"],
    defaultEffort: "high",
  },
  {
    id: "glm-5.3-flash-free",
    slug: "opencode/glm-5.3-flash-free",
    name: "GLM 5.3 Flash (Free)",
    contextWindow: 204800,
    maxTokens: 8192,
    reasoningEfforts: ["low", "medium", "high", "max"],
    defaultEffort: "high",
  },
  {
    id: "minimax-m3.1-flash-free",
    slug: "opencode/minimax-m3.1-flash-free",
    name: "MiniMax M3.1 Flash (Free)",
    contextWindow: 1000000,
    maxTokens: 8192,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
  {
    id: "qwen3.6-plus-free",
    slug: "opencode/qwen3.6-plus-free",
    name: "Qwen 3.6 Plus (Free)",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultEffort: "medium",
  },
];

export function findOpencodeCliPath(): string | null {
  const appSupportCliDir = path.join(os.homedir(), "Library/Application Support/ai.opencode.desktop/cli");
  if (fs.existsSync(appSupportCliDir)) {
    try {
      const entries = fs.readdirSync(appSupportCliDir);
      for (const entry of entries) {
        const candidate = path.join(appSupportCliDir, entry, "opencode-cli");
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  const appCli = "/Applications/OpenCode.app/Contents/Resources/bin/opencode-cli";
  if (fs.existsSync(appCli)) return appCli;

  try {
    const which = execFileSync("which", ["opencode"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (which && fs.existsSync(which)) return which;
  } catch {}
  try {
    const whichCli = execFileSync("which", ["opencode-cli"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (whichCli && fs.existsSync(whichCli)) return whichCli;
  } catch {}
  return null;
}

export function queryInstalledOpencodeCliModelIds(cliPath?: string | null): string[] | null {
  const bin = cliPath || findOpencodeCliPath();
  if (!bin || !fs.existsSync(bin)) return null;
  try {
    const stdout = execFileSync(bin, ["models"], { encoding: "utf8", timeout: 5000 });
    const ids = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith("opencode/") ? line.slice("opencode/".length) : line));
    if (ids.length > 0) return ids;
  } catch {}
  return null;
}

export async function fetchOpencodeModelsDynamic(): Promise<Array<{
  id: string;
  slug: string;
  name: string;
  context_window?: number;
  reasoning_efforts?: string[];
}>> {
  const cliPath = findOpencodeCliPath();
  const cliModelIds = queryInstalledOpencodeCliModelIds(cliPath);
  const builtinMap = new Map(BUILTIN_OPENCODE_FREE_MODELS.map((m) => [m.id, m]));

  if (Array.isArray(cliModelIds) && cliModelIds.length > 0) {
    return cliModelIds.map((id) => {
      const builtin = builtinMap.get(id);
      const isFree = id.includes("-free") || id === "big-pickle";
      return {
        id,
        slug: `opencode/${id}`,
        name: builtin?.name || (isFree ? `${id} (Free)` : id),
        context_window: builtin?.contextWindow || 131072,
        reasoning_efforts: builtin?.reasoningEfforts,
      };
    });
  }

  // Fallback to builtin catalog
  return BUILTIN_OPENCODE_FREE_MODELS.map((m) => ({
    id: m.id,
    slug: m.slug,
    name: m.name,
    context_window: m.contextWindow || 131072,
    reasoning_efforts: m.reasoningEfforts,
  }));
}

const OPENCODE_SERVER_START_TIMEOUT_MS = 15_000;
const OPENCODE_SERVER_READY_PATTERN = /server listening on (https?:\/\/127\.0\.0\.1:\d+)/i;

let serverChild: ChildProcess | null = null;
let serverUrl: string | null = null;
let serverPassword: string | null = null;
let serverStarting: Promise<{ child: ChildProcess; url: string; password: string }> | null = null;

function opencodeServerAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

async function startOpencodeServer(cliPath: string): Promise<{ child: ChildProcess; url: string; password: string }> {
  const password = randomBytes(24).toString("base64url");
  const child = spawn(cliPath, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: os.tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_PASSWORD: password },
  });
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    diagnostics = `${diagnostics}${String(chunk)}`.slice(-4000);
  });
  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      const settle = (error: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.stdout?.off("data", onStdout);
        child.off("exit", onExit);
        child.off("error", onError);
        if (error) reject(error);
        else resolve(value!);
      };
      const onStdout = (chunk: any) => {
        buffer += String(chunk);
        const match = buffer.match(OPENCODE_SERVER_READY_PATTERN);
        if (match) settle(null, match[1]);
      };
      const onExit = (code: number | null, signal: string | null) => {
        settle(
          new Error(
            `OpenCode 本地服务提前退出 (code ${code ?? "null"}, signal ${signal ?? "null"})${diagnostics ? `: ${diagnostics.trim()}` : ""}`,
          ),
        );
      };
      const onError = (error: Error) => settle(error);
      timer = setTimeout(() => {
        settle(new Error(`OpenCode 本地服务启动超时${diagnostics ? `: ${diagnostics.trim()}` : ""}`));
      }, OPENCODE_SERVER_START_TIMEOUT_MS);
      child.stdout?.on("data", onStdout);
      child.once("exit", onExit);
      child.once("error", onError);
    });
  } catch (error) {
    try { child.kill(); } catch {}
    throw error;
  }
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  child.unref?.();
  const info = { child, url, password };
  child.once("exit", () => {
    if (serverChild === child) {
      serverChild = null;
      serverUrl = null;
      serverPassword = null;
    }
  });
  process.once("exit", () => {
    try { child.kill(); } catch {}
  });
  return info;
}

async function ensureOpencodeServer(cliPath: string): Promise<{ child: ChildProcess; url: string; password: string }> {
  if (serverUrl && serverChild && serverChild.exitCode === null && !serverChild.killed) {
    return { child: serverChild, url: serverUrl, password: serverPassword! };
  }
  if (serverStarting) return serverStarting;
  serverStarting = startOpencodeServer(cliPath)
    .then((info) => {
      serverChild = info.child;
      serverUrl = info.url;
      serverPassword = info.password;
      serverStarting = null;
      return info;
    })
    .catch((error) => {
      serverStarting = null;
      throw error;
    });
  return serverStarting;
}

export function promptFromMessages(messages: any[]): string {
  const rawList = Array.isArray(messages) ? messages : [];
  if (rawList.length === 0) return "";

  // 1. Extract the latest user message index
  let latestUserIndex = -1;
  for (let i = rawList.length - 1; i >= 0; i--) {
    if (rawList[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }

  // 2. Extract system instructions if any, capped to avoid massive prompt bloat
  const systemMsgs = rawList.filter((m) => m?.role === "system");
  let systemPrompt = "";
  if (systemMsgs.length > 0) {
    const rawSys = systemMsgs.map((m) => (typeof m?.content === "string" ? m.content : "")).filter(Boolean).join("\n\n");
    systemPrompt = rawSys.length > 4000 ? rawSys.slice(0, 4000) + "\n[System instructions truncated]" : rawSys;
  }

  // 3. Keep recent conversation history (up to last 12 messages)
  const historyStart = Math.max(0, (latestUserIndex >= 0 ? latestUserIndex : rawList.length) - 12);
  const recentMsgs = rawList.slice(historyStart);

  const parts: string[] = [];
  if (systemPrompt && !recentMsgs.some((m) => m?.role === "system")) {
    parts.push(`System: ${systemPrompt}`);
  }

  for (const msg of recentMsgs) {
    const role = msg?.role === "assistant" ? "Assistant" : msg?.role === "system" ? "System" : "User";
    let text = "";
    if (typeof msg?.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg?.content)) {
      text = msg.content
        .map((p: any) => {
          if (typeof p === "string") return p;
          if (p?.type === "text") return p.text || "";
          if (p?.type === "tool-result" || p?.type === "tool_result") {
            const out = p.content ?? p.output ?? p.result ?? p.text ?? "";
            const outStr = typeof out === "string" ? out : JSON.stringify(out);
            return `[Tool Result ${p.toolCallId ?? p.id ?? ""}]: ${outStr.slice(0, 500)}`;
          }
          if (p?.type === "tool-call" || p?.type === "function-call") {
            const name = p.name ?? p.function?.name ?? "tool";
            return `[Tool Call: ${name}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (text) {
      if (text.length > 4000 && msg !== rawList[latestUserIndex]) {
        text = text.slice(0, 4000) + "\n...[truncated]";
      }
      parts.push(`${role}: ${text}`);
    }
  }

  return parts.join("\n\n");
}

export async function streamOpencodeChat(
  messages: any[],
  model: string,
  options: { reasoningEffort?: string; timeoutMs?: number; tools?: any[] } = {},
  signal?: AbortSignal,
): Promise<Response> {
  const cleanModelId = model.startsWith("opencode/") ? model.slice("opencode/".length) : model;
  const cliPath = findOpencodeCliPath();
  if (!cliPath) {
    // Cloud free direct fallback: 0 local software required
    return streamCloudFreeChat(messages, cleanModelId, options, signal);
  }
  const prompt = promptFromMessages(messages);
  const effort = options.reasoningEffort;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const sendSse = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let emittedAny = false;

      // 1. Try local server first for low-latency streaming
      let serverInfo: { child: ChildProcess; url: string; password: string } | null = null;
      try {
        serverInfo = await ensureOpencodeServer(cliPath);
      } catch {
        serverInfo = null;
      }

      if (serverInfo) {
        try {
          const auth = opencodeServerAuth(serverInfo.password);
          const modelPayload = {
            providerID: "opencode",
            id: cleanModelId,
            ...(effort && effort !== "medium" ? { variant: effort } : {}),
          };

          const sRes = await fetch(`${serverInfo.url}/api/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: auth },
            body: JSON.stringify({ model: modelPayload }),
            signal,
          });

          if (!sRes.ok) {
            throw new Error(`OpenCode session creation failed: ${sRes.status}`);
          }

          const sData = (await sRes.json()) as any;
          const sessionId = sData?.data?.id || sData?.id;
          if (!sessionId) {
            throw new Error("OpenCode did not return a session ID");
          }

          const eventRes = await fetch(`${serverInfo.url}/api/event`, {
            headers: { Authorization: auth, Accept: "text/event-stream" },
            signal,
          });

          if (!eventRes.ok || !eventRes.body) {
            throw new Error(`OpenCode event stream failed: ${eventRes.status}`);
          }

          const reader = eventRes.body.getReader();
          const decoder = new TextDecoder();
          let promptError: Error | null = null;

          if (signal) {
            signal.addEventListener(
              "abort",
              () => {
                try { reader.cancel(); } catch {}
              },
              { once: true },
            );
          }

          // Submit prompt concurrently with reading events
          const promptPromise = fetch(`${serverInfo.url}/api/session/${sessionId}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: auth },
            body: JSON.stringify({ text: prompt }),
            signal,
          }).then(async (pRes) => {
            if (!pRes.ok) {
              const errBody = await pRes.text().catch(() => "");
              if (/Free usage limit reached/i.test(errBody)) {
                throw new Error("OpenCode 免费模型额度已耗尽 (Free usage limit reached)。请在 OpenCode 中续费或切换到 MiniMax / 原生 GPT 等其他模型。");
              }
              throw new Error(`OpenCode prompt failed (${pRes.status}): ${errBody.slice(0, 200)}`);
            }
          }).catch((err) => {
            promptError = err;
            try { reader.cancel(); } catch {}
          });

          let buffer = "";
          let finished = false;

          while (!finished) {
            if (promptError) {
              throw promptError;
            }
            const { value, done } = await reader.read();
            if (promptError) {
              throw promptError;
            }
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
              const raw = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf("\n\n");

              for (const line of raw.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const jsonStr = line.slice(5).trim();
                if (!jsonStr) continue;
                try {
                  const ev = JSON.parse(jsonStr);
                  if (ev?.data?.sessionID && ev.data.sessionID !== sessionId) continue;

                  if (ev.type === "session.reasoning.delta" && typeof ev.data?.delta === "string") {
                    emittedAny = true;
                    sendSse({ choices: [{ delta: { reasoning_content: ev.data.delta } }] });
                  } else if ((ev.type === "session.text.delta" || ev.type === "message.part.delta") && typeof ev.data?.delta === "string") {
                    emittedAny = true;
                    sendSse({ choices: [{ delta: { content: ev.data.delta } }] });
                  } else if (ev.type === "session.step.ended") {
                    if (ev.data?.tokens) {
                      sendSse({
                        choices: [{ delta: {} }],
                        usage: {
                          prompt_tokens: ev.data.tokens.input ?? 0,
                          completion_tokens: ev.data.tokens.output ?? 0,
                          total_tokens: (ev.data.tokens.input ?? 0) + (ev.data.tokens.output ?? 0),
                        },
                      });
                    }
                    finished = true;
                  } else if (ev.type === "session.execution.succeeded") {
                    finished = true;
                  } else if (ev.type === "session.execution.failed" || ev.type === "session.error" || ev.type === "session.step.failed") {
                    const rawError = ev.data?.error || ev.data?.message || ev.data;
                    let errText = "";
                    if (typeof rawError === "object" && rawError !== null) {
                      errText = rawError.message || rawError.error?.message || JSON.stringify(rawError);
                    } else {
                      errText = String(rawError || "OpenCode 执行失败");
                    }
                    if (
                      /Free usage limit reached/i.test(errText) ||
                      /FreeUsageLimitError/i.test(errText) ||
                      /free-limit/i.test(errText)
                    ) {
                      throw new Error("OpenCode 免费模型额度已耗尽 (Free usage limit reached)。请在 OpenCode 中续费或切换到 MiniMax / 原生 GPT 等其他模型。");
                    }
                    throw new Error(errText);
                  } else if (ev.type === "step_finish" && ev.data?.tokens) {
                    sendSse({
                      choices: [{ delta: {} }],
                      usage: {
                        prompt_tokens: ev.data.tokens.input ?? 0,
                        completion_tokens: ev.data.tokens.output ?? 0,
                        total_tokens: (ev.data.tokens.input ?? 0) + (ev.data.tokens.output ?? 0),
                      },
                    });
                    finished = true;
                  } else if (ev.type === "session.idle") {
                    finished = true;
                  }
                } catch (parseOrExecErr: any) {
                  if (
                    parseOrExecErr instanceof Error &&
                    !parseOrExecErr.message.startsWith("Unexpected token") &&
                    !parseOrExecErr.message.includes("JSON")
                  ) {
                    throw parseOrExecErr;
                  }
                }
              }
            }
          }

          await promptPromise;
          try { await reader.cancel(); } catch {}

          sendSse({ choices: [{ delta: {}, finish_reason: "stop" }] });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        } catch (serverErr: any) {
          const errMsg = String(serverErr?.message || serverErr);
          if (/Free usage limit reached|免费模型额度已耗尽/i.test(errMsg)) {
            controller.error(
              new Error("OpenCode 免费模型额度已耗尽 (Free usage limit reached)。请在 OpenCode 中续费或切换到 MiniMax / 原生 GPT 等其他模型。"),
            );
            return;
          }
          if (emittedAny || signal?.aborted) {
            controller.error(serverErr);
            return;
          }
          // Server path failed before emitting anything, fall through to CLI runner
        }
      }

      // 2. Direct CLI fallback: `opencode-cli run`
      try {
        const fullModelArg = effort && effort !== "medium" ? `opencode/${cleanModelId}#${effort}` : `opencode/${cleanModelId}`;
        const args = ["run", "--model", fullModelArg, "--format", "json", prompt];

        const child = spawn(cliPath, args, {
          signal,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        });

        const rl = readline.createInterface({ input: child.stdout });
        let stderrText = "";
        child.stderr?.on("data", (chunk) => { stderrText += String(chunk); });

        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "reasoning" && parsed.part?.text) {
              emittedAny = true;
              sendSse({ choices: [{ delta: { reasoning_content: parsed.part.text } }] });
            } else if (parsed.type === "text" && parsed.part?.text) {
              emittedAny = true;
              sendSse({ choices: [{ delta: { content: parsed.part.text } }] });
            } else if (parsed.type === "step_finish" && parsed.part?.tokens) {
              sendSse({
                choices: [{ delta: {} }],
                usage: {
                  prompt_tokens: parsed.part.tokens.input ?? 0,
                  completion_tokens: parsed.part.tokens.output ?? 0,
                  total_tokens: (parsed.part.tokens.input ?? 0) + (parsed.part.tokens.output ?? 0),
                },
              });
            }
          } catch {}
        }

        await new Promise<void>((resolve, reject) => {
          if (child.exitCode !== null) return resolve();
          child.once("close", () => resolve());
          child.once("error", (err) => reject(err));
        });

        if (!emittedAny && (child.exitCode !== 0 || stderrText.trim())) {
          const cleanErr = stderrText.trim();
          if (/Free usage limit reached/i.test(cleanErr)) {
            throw new Error("OpenCode 免费模型额度已耗尽 (Free usage limit reached)。请在 OpenCode 中续费或切换到 MiniMax / 原生 GPT 等其他模型。");
          }
          throw new Error(cleanErr || `OpenCode 模型运行失败 (exit code: ${child.exitCode})`);
        }

        sendSse({ choices: [{ delta: {}, finish_reason: "stop" }] });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err: any) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function testOpencodeModel(
  model: string,
  timeoutMs = 15000,
): Promise<{ status: "connected" | "failed"; message: string }> {
  const cleanModelId = model.startsWith("opencode/") ? model.slice("opencode/".length) : model;

  // Use the local HTTP server or direct streaming chat to test end-to-end inference
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await streamOpencodeChat(
      [{ role: "user", content: "ping" }],
      cleanModelId,
      {},
      controller.signal,
    );

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      return { status: "failed", message: `OpenCode 本地服务响应异常 (${res.status})` };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let receivedAssistantContent = false;
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed?.choices?.[0]?.delta;
          if (delta?.content || delta?.reasoning_content) {
            receivedAssistantContent = true;
            try { await reader.cancel(); } catch {}
            clearTimeout(timer);
            return { status: "connected", message: `模型测试成功，已生成响应：${cleanModelId}` };
          }
        } catch {}
      }
    }

    clearTimeout(timer);
    if (receivedAssistantContent) {
      return { status: "connected", message: `模型测试成功，已生成响应：${cleanModelId}` };
    }
    return { status: "failed", message: `模型未返回有效文本内容：${cleanModelId}` };
  } catch (err: any) {
    clearTimeout(timer);
    const errMsg = String(err?.message || err);
    if (/Free usage limit reached|免费模型额度已耗尽|free-limit/i.test(errMsg)) {
      return {
        status: "failed",
        message: "免费模型额度已耗尽 (HTTP 429 / Free usage limit reached)。请在 OpenCode 中续费或切换到其他模型",
      };
    }
    return { status: "failed", message: `模型测试失败：${errMsg.slice(0, 300)}` };
  }
}
