import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

export interface WorkbuddyModelDef {
  id: string;
  slug: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoningEfforts?: string[];
  defaultEffort?: string;
  inputModalities?: string[];
}

export const BUILTIN_WORKBUDDY_FREE_MODELS: WorkbuddyModelDef[] = [
  {
    id: "deepseek-v4.1-flash",
    slug: "workbuddy/deepseek-v4.1-flash",
    name: "DeepSeek v4.1 Flash (Free)",
    contextWindow: 1000000,
    maxTokens: 8192,
    reasoningEfforts: ["low", "high", "max", "enabled"],
    defaultEffort: "high",
  },
  {
    id: "hy3",
    slug: "workbuddy/hy3",
    name: "Hy3 (Free)",
    contextWindow: 192000,
    maxTokens: 8192,
    reasoningEfforts: ["low", "high", "enabled"],
    defaultEffort: "high",
  },
];

export function findWorkbuddyAppPath(): string | null {
  const candidates = [
    "/Applications/WorkBuddy AI.app",
    path.join(os.homedir(), "Applications", "WorkBuddy AI.app"),
    "/Applications/WorkBuddy.app",
    path.join(os.homedir(), "Applications", "WorkBuddy.app"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function hasWorkbuddyCredential(): boolean {
  // Cloud free gateway is zero-install and always ready
  return true;
}

export interface WorkbuddySidecarInfo {
  pid: number;
  port: number;
  password: string;
}

let cachedSidecar: WorkbuddySidecarInfo | null = null;
let cachedSidecarCheckedAt = 0;
const SIDECAR_CACHE_TTL_MS = 10_000;

export async function verifySidecarHealth(
  info: WorkbuddySidecarInfo,
  timeoutMs = 2000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/v1/health`, {
      headers: { Authorization: `Bearer ${info.password}` },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverWorkbuddySidecar(
  forceRefresh = false,
): Promise<WorkbuddySidecarInfo | null> {
  const now = Date.now();
  if (!forceRefresh && cachedSidecar && now - cachedSidecarCheckedAt < SIDECAR_CACHE_TTL_MS) {
    return cachedSidecar;
  }

  if (cachedSidecar) {
    const alive = await verifySidecarHealth(cachedSidecar, 1500);
    if (alive) {
      cachedSidecarCheckedAt = now;
      return cachedSidecar;
    }
    cachedSidecar = null;
  }

  let psOut = "";
  try {
    psOut = execFileSync("ps", ["-eo", "pid,command"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }

  let targetPid: number | null = null;
  for (const line of psOut.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.includes("grep ") ||
      trimmed.includes("node -e") ||
      trimmed.includes("zsh -c") ||
      trimmed.includes("antigravity")
    ) {
      continue;
    }
    if (
      trimmed.includes("/cli/bin/codebuddy") ||
      trimmed.includes("codebuddy-lite-wb") ||
      /\bcodebuddy\s+--serve\b/.test(trimmed)
    ) {
      const match = trimmed.match(/^(\d+)/);
      if (match) {
        targetPid = Number(match[1]);
        break;
      }
    }
  }

  if (!targetPid) return null;

  let envOut = "";
  try {
    envOut = execFileSync("ps", ["eww", "-p", String(targetPid)], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }

  const pwdMatch = envOut.match(/CODEBUDDY_GATEWAY_PASSWORD=([^\s]+)/);
  if (!pwdMatch) return null;
  const password = pwdMatch[1];

  let lsofOut = "";
  try {
    lsofOut = execFileSync(
      "lsof",
      ["-nP", "-p", String(targetPid), "-a", "-iTCP", "-sTCP:LISTEN"],
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return null;
  }

  const portMatch = lsofOut.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
  if (!portMatch) return null;
  const port = Number(portMatch[1]);

  const candidate: WorkbuddySidecarInfo = { pid: targetPid, port, password };
  const healthy = await verifySidecarHealth(candidate, 2000);
  if (!healthy) return null;

  cachedSidecar = candidate;
  cachedSidecarCheckedAt = now;
  return candidate;
}

export function fetchWorkbuddyModelsFromCache(): WorkbuddyModelDef[] {
  const cacheDir = path.join(os.homedir(), ".workbuddy-ai", "cache");
  if (!fs.existsSync(cacheDir)) return [];

  try {
    const entries = fs.readdirSync(cacheDir);
    const configFiles = entries
      .filter(
        (f) =>
          f.startsWith("acc-product-config-v3-") ||
          f === "wb-product-config.json" ||
          f.startsWith("acc-product-config-"),
      )
      .sort((a, b) => {
        try {
          return (
            fs.statSync(path.join(cacheDir, b)).mtimeMs -
            fs.statSync(path.join(cacheDir, a)).mtimeMs
          );
        } catch {
          return 0;
        }
      });

    for (const file of configFiles) {
      try {
        const raw = fs.readFileSync(path.join(cacheDir, file), "utf8");
        const json = JSON.parse(raw);
        const models = Array.isArray(json?.models?.availableModels)
          ? json.models.availableModels
          : Array.isArray(json?.models)
            ? json.models
            : [];
        if (models.length === 0) continue;

        const freeModels: WorkbuddyModelDef[] = [];
        for (const m of models) {
          const id = m.modelId || m.id;
          if (!id) continue;
          const desc = String(m.description || "").toLowerCase();
          const credits = String(m.credits || m._meta?.credits || "").toLowerCase();
          const isFree =
            desc.includes("x0.00") ||
            desc.includes("0x") ||
            credits.includes("0.00") ||
            desc.includes("free") ||
            credits.includes("free");
          if (isFree) {
            const cleanName = String(m.name || id).replace(/\s*\(Free\)/i, "");
            freeModels.push({
              id,
              slug: `workbuddy/${id}`,
              name: `${cleanName} (Free)`,
              contextWindow: m._meta?.maxInputTokens || m.maxInputTokens || 300000,
              maxTokens: 8192,
              reasoningEfforts:
                m._meta?.supportsReasoning || m.supportsReasoning
                  ? ["low", "high", "max", "enabled"]
                  : undefined,
              defaultEffort: "high",
            });
          }
        }
        if (freeModels.length > 0) return freeModels;
      } catch {}
    }
  } catch {}

  return [];
}

export async function fetchWorkbuddyModelsDynamic(): Promise<
  Array<{
    id: string;
    slug: string;
    name: string;
    context_window?: number;
    reasoning_efforts?: string[];
  }>
> {
  const sidecar = await discoverWorkbuddySidecar();
  if (sidecar) {
    try {
      const cRes = await fetch(
        `http://127.0.0.1:${sidecar.port}/api/v1/acp/connect`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sidecar.password}` },
        },
      );
      if (cRes.ok) {
        const { connectionId, sessionToken } = (await cRes.json()) as any;
        if (connectionId && sessionToken) {
          const headers = {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "acp-connection-id": connectionId,
            "acp-session-token": sessionToken,
          };

          await fetch(`http://127.0.0.1:${sidecar.port}/api/v1/acp`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { protocolVersion: 1 },
            }),
          });

          const sessRes = await fetch(
            `http://127.0.0.1:${sidecar.port}/api/v1/acp`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "session/new",
                params: { cwd: os.tmpdir(), mcpServers: [] },
              }),
            },
          );

          if (sessRes.ok) {
            const text = await sessRes.text();
            let availableModels: any[] = [];
            const events = text.split("\n\n");
            for (const ev of events) {
              for (const line of ev.split("\n")) {
                if (line.startsWith("data:")) {
                  try {
                    const data = JSON.parse(line.slice(5).trim());
                    if (Array.isArray(data?.result?.models?.availableModels)) {
                      availableModels = data.result.models.availableModels;
                    }
                  } catch {}
                }
              }
            }

            if (availableModels.length > 0) {
              const liveFree = availableModels.filter((m) => {
                const desc = String(m.description || "").toLowerCase();
                const credits = String(m._meta?.credits || "").toLowerCase();
                return (
                  desc.includes("x0.00") ||
                  desc.includes("0x") ||
                  credits.includes("0.00") ||
                  desc.includes("free") ||
                  credits.includes("free")
                );
              });

              if (liveFree.length > 0) {
                return liveFree.map((m) => {
                  const cleanName = String(m.name || m.modelId).replace(
                    /\s*\(Free\)/i,
                    "",
                  );
                  return {
                    id: m.modelId,
                    slug: `workbuddy/${m.modelId}`,
                    name: `${cleanName} (Free)`,
                    context_window: m._meta?.maxInputTokens || 300000,
                    reasoning_efforts: m._meta?.supportsReasoning
                      ? ["low", "high", "max", "enabled"]
                      : undefined,
                  };
                });
              }
            }
          }
        }
      }
    } catch {}
  }

  // Fallback 1: Local cache files
  const cachedModels = fetchWorkbuddyModelsFromCache();
  if (cachedModels.length > 0) {
    return cachedModels.map((m) => ({
      id: m.id,
      slug: m.slug,
      name: m.name,
      context_window: m.contextWindow || 300000,
      reasoning_efforts: m.reasoningEfforts,
    }));
  }

  // Fallback 2: Builtin free catalog
  return BUILTIN_WORKBUDDY_FREE_MODELS.map((m) => ({
    id: m.id,
    slug: m.slug,
    name: m.name,
    context_window: m.contextWindow || 300000,
    reasoning_efforts: m.reasoningEfforts,
  }));
}

export function promptFromMessages(messages: any[]): string {
  const rawList = Array.isArray(messages) ? messages : [];
  if (rawList.length === 0) return "";

  let latestUserIndex = -1;
  for (let i = rawList.length - 1; i >= 0; i--) {
    if (rawList[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }

  const systemMsgs = rawList.filter((m) => m?.role === "system");
  let systemPrompt = "";
  if (systemMsgs.length > 0) {
    const rawSys = systemMsgs
      .map((m) => (typeof m?.content === "string" ? m.content : ""))
      .filter(Boolean)
      .join("\n\n");
    systemPrompt =
      rawSys.length > 4000
        ? rawSys.slice(0, 4000) + "\n[System instructions truncated]"
        : rawSys;
  }

  const historyStart = Math.max(
    0,
    (latestUserIndex >= 0 ? latestUserIndex : rawList.length) - 12,
  );
  const recentMsgs = rawList.slice(historyStart);

  const parts: string[] = [];
  if (systemPrompt && !recentMsgs.some((m) => m?.role === "system")) {
    parts.push(`System: ${systemPrompt}`);
  }

  for (const msg of recentMsgs) {
    const role =
      msg?.role === "assistant"
        ? "Assistant"
        : msg?.role === "system"
          ? "System"
          : "User";
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

export function sanitizeMessagesForCloudChat(messages: any[]): Array<any> {
  const rawList = Array.isArray(messages) ? messages : [];
  if (rawList.length === 0) {
    return [{ role: "user", content: "Hello" }];
  }

  // 1. Separate system messages
  const systemParts: string[] = [];
  for (const m of rawList) {
    if (m?.role === "system") {
      let txt = "";
      if (typeof m.content === "string") txt = m.content.trim();
      else if (Array.isArray(m.content)) {
        txt = m.content
          .map((p: any) => (typeof p === "string" ? p : (p?.text || "")))
          .filter(Boolean)
          .join("\n")
          .trim();
      }
      if (txt) systemParts.push(txt);
    }
  }

  // 2. Separate non-system messages
  const nonSystem = rawList.filter((m) => m?.role !== "system");
  if (nonSystem.length === 0) {
    const res: any[] = [];
    if (systemParts.length > 0) {
      res.push({ role: "system", content: systemParts.join("\n\n").slice(0, 10000) });
    }
    res.push({ role: "user", content: "Hello" });
    return res;
  }

  // Identify the initiating user message (CRITICAL: never drop the primary objective)
  const initialUserIndex = nonSystem.findIndex((m) => m?.role === "user");
  const initialUserMsg = initialUserIndex >= 0 ? nonSystem[initialUserIndex] : null;

  // Window size: keep up to 40 recent messages to retain full tool conversation history
  const MAX_HISTORY = 40;
  let recentSlice: any[];
  if (nonSystem.length <= MAX_HISTORY) {
    recentSlice = [...nonSystem];
  } else {
    // Slicing from the end
    let startIdx = nonSystem.length - MAX_HISTORY;
    // Avoid slicing directly in the middle of a tool call / tool result group
    // If the slice starts on a tool message, walk backward to include the assistant message that triggered it
    while (startIdx > 0 && nonSystem[startIdx]?.role === "tool") {
      startIdx--;
    }
    recentSlice = nonSystem.slice(startIdx);
    // If the initial user message was sliced out, prepend it so the goal is never lost!
    if (initialUserMsg && !recentSlice.includes(initialUserMsg)) {
      recentSlice.unshift(initialUserMsg);
    }
  }

  const sanitized: any[] = [];
  if (systemParts.length > 0) {
    sanitized.push({ role: "system", content: systemParts.join("\n\n").slice(0, 10000) });
  }

  // Track valid assistant tool call IDs in the current sanitized list
  const activeToolCallIds = new Set<string>();

  for (let i = 0; i < recentSlice.length; i++) {
    const msg = recentSlice[i];
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role || "user").toLowerCase();
    const isRecent = i >= recentSlice.length - 6;

    // Handle string or array content
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .map((p: any) => {
          if (typeof p === "string") return p;
          if (p?.type === "text" && typeof p.text === "string") return p.text;
          if (typeof p?.text === "string") return p.text;
          if (p?.type === "tool-result" || p?.type === "tool_result") {
            const out = p.content ?? p.output ?? p.result ?? p.text ?? "";
            return typeof out === "string" ? out : JSON.stringify(out);
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
    }

    if (role === "assistant") {
      const sanitizedAssistant: any = { role: "assistant" };
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const validCalls: any[] = [];
        for (const tc of msg.tool_calls) {
          if (!tc || typeof tc !== "object") continue;
          const callId = String(tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
          let argsStr = tc.function?.arguments;
          if (typeof argsStr !== "string") {
            try {
              argsStr = JSON.stringify(argsStr || {});
            } catch {
              argsStr = "{}";
            }
          }
          validCalls.push({
            id: callId,
            type: "function",
            function: {
              name: String(tc.function?.name || tc.name || "exec"),
              arguments: argsStr,
            },
          });
          activeToolCallIds.add(callId);
        }
        if (validCalls.length > 0) {
          sanitizedAssistant.tool_calls = validCalls;
          sanitizedAssistant.content = text ? text.trim() : null;
        } else {
          sanitizedAssistant.content = text ? text.trim() : "(assistant message)";
        }
      } else {
        sanitizedAssistant.content = text ? text.trim() : "(assistant message)";
      }
      sanitized.push(sanitizedAssistant);
    } else if (role === "tool") {
      const toolCallId = String(msg.tool_call_id || msg.toolCallId || "");
      // Truncate older tool output to conserve tokens while preserving recent output fidelity
      const maxLen = isRecent ? 8000 : 800;
      let trimmedText = text.trim();
      if (trimmedText.length > maxLen) {
        trimmedText = trimmedText.slice(0, maxLen) + "\n...[output truncated]";
      }
      if (!trimmedText) trimmedText = "(completed)";

      // If the parent assistant tool_call exists in sanitized, keep native role: "tool"
      // Otherwise, convert orphaned tool result to user message to prevent OpenAI HTTP 400
      if (toolCallId && activeToolCallIds.has(toolCallId)) {
        sanitized.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: trimmedText,
        });
      } else {
        sanitized.push({
          role: "user",
          content: `[Tool Result ${toolCallId}]: ${trimmedText}`,
        });
      }
    } else {
      // User message
      const trimmedUser = text.trim() || "(empty user message)";
      sanitized.push({ role: "user", content: trimmedUser });
    }
  }

  // Final sanity check: ensure at least one user message is present
  if (!sanitized.some((m) => m.role === "user")) {
    sanitized.push({ role: "user", content: "Hello" });
  }

  return sanitized;
}

export async function streamCloudFreeChat(
  messages: any[],
  model: string,
  options: { reasoningEffort?: string; timeoutMs?: number; tools?: any[] } = {},
  signal?: AbortSignal,
): Promise<Response> {
  const sanitizedMessages = sanitizeMessagesForCloudChat(messages);
  const candidateModels = ["kilo-auto/free", "nvidia/nemotron-3.5-super-vl:free", "reflection/beam-free"];
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 45_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      controller.abort();
    }, { once: true });
  }

  try {
    let lastError: Error | null = null;
    for (const freeModel of candidateModels) {
      if (controller.signal.aborted) break;
      try {
        const postBody: any = {
          model: freeModel,
          messages: sanitizedMessages,
          stream: true,
        };
        if (Array.isArray(options.tools) && options.tools.length > 0) {
          postBody.tools = options.tools;
        }

        const upstreamRes = await fetch("https://api.kilo.ai/api/gateway/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(postBody),
          signal: controller.signal,
        });

        if (!upstreamRes.ok || !upstreamRes.body) {
          const errText = await upstreamRes.text().catch(() => "");
          console.warn(`[CodexSplit Cloud Free] ${freeModel} HTTP ${upstreamRes.status}: ${errText.slice(0, 300)}`);
          lastError = new Error(`Cloud Free Gateway failed: HTTP ${upstreamRes.status} (${errText.slice(0, 200)})`);
          continue; // Try next candidate
        }

        const transformStream = new TransformStream();
        upstreamRes.body.pipeTo(transformStream.writable).catch(() => {}).finally(() => clearTimeout(timer));

        return new Response(transformStream.readable, {
          status: upstreamRes.status,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } catch (candidateErr: any) {
        if (controller.signal.aborted) throw candidateErr;
        lastError = candidateErr;
      }
    }

    clearTimeout(timer);
    throw lastError || new Error("Cloud Free Gateway: all free models failed");
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export async function streamWorkbuddyChat(
  messages: any[],
  model: string,
  options: { reasoningEffort?: string; timeoutMs?: number; tools?: any[] } = {},
  signal?: AbortSignal,
): Promise<Response> {
  const cleanModelId = model.startsWith("workbuddy/")
    ? model.slice("workbuddy/".length)
    : model;

  const sidecar = await discoverWorkbuddySidecar();
  if (!sidecar) {
    // Cloud free direct fallback: 0 local software required
    return streamCloudFreeChat(messages, cleanModelId, options, signal);
  }
  const promptText = promptFromMessages(messages);
  const effort = options.reasoningEffort;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const sendSse = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let emittedAny = false;
      let activeSessionId: string | null = null;
      let activeConnectionId: string | null = null;
      let activeSessionToken: string | null = null;

      const cancelSession = async () => {
        if (!activeSessionId || !activeConnectionId || !activeSessionToken) return;
        try {
          await fetch(`http://127.0.0.1:${sidecar.port}/api/v1/acp`, {
            method: "POST",
            headers: {
              Accept: "application/json, text/event-stream",
              "Content-Type": "application/json",
              "acp-connection-id": activeConnectionId,
              "acp-session-token": activeSessionToken,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "session/cancel",
              params: { sessionId: activeSessionId },
            }),
          });
        } catch {}
      };

      if (signal) {
        signal.addEventListener("abort", () => {
          cancelSession();
        }, { once: true });
      }

      try {
        // Step 1: Connect to ACP
        const connectRes = await fetch(
          `http://127.0.0.1:${sidecar.port}/api/v1/acp/connect`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${sidecar.password}` },
            signal,
          },
        );

        if (!connectRes.ok) {
          throw new Error(`WorkBuddy ACP 连接失败 (HTTP ${connectRes.status})`);
        }

        const connectData = (await connectRes.json()) as any;
        activeConnectionId = connectData?.connectionId;
        activeSessionToken = connectData?.sessionToken;

        if (!activeConnectionId || !activeSessionToken) {
          throw new Error("WorkBuddy ACP 未返回有效 connectionId 或 sessionToken");
        }

        const acpHeaders = {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "acp-connection-id": activeConnectionId,
          "acp-session-token": activeSessionToken,
        };

        // Step 2: Initialize
        const initRes = await fetch(
          `http://127.0.0.1:${sidecar.port}/api/v1/acp`,
          {
            method: "POST",
            headers: acpHeaders,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { protocolVersion: 1 },
            }),
            signal,
          },
        );

        if (!initRes.ok) {
          throw new Error(`WorkBuddy ACP 初始化失败 (HTTP ${initRes.status})`);
        }
        await initRes.text();

        // Step 3: Create Session
        const sessionRes = await fetch(
          `http://127.0.0.1:${sidecar.port}/api/v1/acp`,
          {
            method: "POST",
            headers: acpHeaders,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "session/new",
              params: { cwd: os.tmpdir(), mcpServers: [] },
            }),
            signal,
          },
        );

        if (!sessionRes.ok) {
          throw new Error(`WorkBuddy ACP 创建会话失败 (HTTP ${sessionRes.status})`);
        }

        const sessionText = await sessionRes.text();
        const sessionEvents = sessionText.split("\n\n");
        for (const ev of sessionEvents) {
          for (const line of ev.split("\n")) {
            if (line.startsWith("data:")) {
              try {
                const data = JSON.parse(line.slice(5).trim());
                if (data?.result?.sessionId) {
                  activeSessionId = data.result.sessionId;
                } else if (data?.params?.sessionId) {
                  activeSessionId = data.params.sessionId;
                }
              } catch {}
            }
          }
        }

        if (!activeSessionId) {
          throw new Error("WorkBuddy ACP 会话创建未返回 sessionId");
        }

        // Step 4: Configure Model
        await fetch(`http://127.0.0.1:${sidecar.port}/api/v1/acp`, {
          method: "POST",
          headers: acpHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "session/set_config_option",
            params: {
              sessionId: activeSessionId,
              configId: "model",
              value: cleanModelId,
            },
          }),
          signal,
        });

        // Step 5: Configure Reasoning Effort if specified
        if (effort && ["low", "high", "max", "enabled"].includes(effort.toLowerCase())) {
          await fetch(`http://127.0.0.1:${sidecar.port}/api/v1/acp`, {
            method: "POST",
            headers: acpHeaders,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 4,
              method: "session/set_config_option",
              params: {
                sessionId: activeSessionId,
                configId: "thought_level",
                value: effort.toLowerCase(),
              },
            }),
            signal,
          });
        }

        // Step 6: Send Prompt with streaming
        const promptRes = await fetch(
          `http://127.0.0.1:${sidecar.port}/api/v1/acp`,
          {
            method: "POST",
            headers: acpHeaders,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 5,
              method: "session/prompt",
              params: {
                sessionId: activeSessionId,
                prompt: [{ type: "text", text: promptText }],
              },
            }),
            signal,
          },
        );

        if (!promptRes.ok || !promptRes.body) {
          throw new Error(`WorkBuddy ACP 推理请求失败 (HTTP ${promptRes.status})`);
        }

        const reader = promptRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finished = false;

        while (!finished) {
          const { value, done } = await reader.read();
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

                // Check for updates
                if (ev?.method === "session/update" && ev?.params?.update) {
                  const update = ev.params.update;
                  const updateType = update.sessionUpdate;

                  if (updateType === "agent_message_chunk" && update.content?.text) {
                    emittedAny = true;
                    sendSse({
                      choices: [{ delta: { content: update.content.text } }],
                    });
                  } else if (updateType === "agent_thought_chunk" && update.content?.text) {
                    emittedAny = true;
                    sendSse({
                      choices: [
                        { delta: { reasoning_content: update.content.text } },
                      ],
                    });
                  } else if (updateType === "usage_update") {
                    const usage = update._meta?.usage;
                    if (usage) {
                      sendSse({
                        choices: [{ delta: {} }],
                        usage: {
                          prompt_tokens: usage.prompt_tokens ?? 0,
                          completion_tokens: usage.completion_tokens ?? 0,
                          total_tokens: usage.total_tokens ?? 0,
                        },
                      });
                    }
                  }
                } else if (ev?.id === 5 && ev?.result) {
                  // Final prompt result
                  if (ev.result.stopReason) {
                    finished = true;
                  }
                }
              } catch {}
            }
          }
        }

        try {
          await reader.cancel();
        } catch {}

        sendSse({ choices: [{ delta: {}, finish_reason: "stop" }] });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err: any) {
        if (!emittedAny && signal?.aborted) {
          controller.close();
          return;
        }
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

export async function testWorkbuddyModel(
  model: string,
  timeoutMs = 15000,
): Promise<{ status: "connected" | "failed"; message: string }> {
  const cleanModelId = model.startsWith("workbuddy/")
    ? model.slice("workbuddy/".length)
    : model;

  const sidecar = await discoverWorkbuddySidecar();
  const sourceLabel = sidecar ? "本机客户端" : "云端直连";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await streamWorkbuddyChat(
      [{ role: "user", content: "ping" }],
      cleanModelId,
      {},
      controller.signal,
    );

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      return {
        status: "failed",
        message: `WorkBuddy ${sourceLabel}服务响应异常 (${res.status})`,
      };
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
          if (delta?.content || delta?.reasoning_content || delta?.text) {
            receivedAssistantContent = true;
            try {
              await reader.cancel();
            } catch {}
            clearTimeout(timer);
            return {
              status: "connected",
              message: `模型测试成功（${sourceLabel}），已生成响应：${cleanModelId}`,
            };
          }
        } catch {}
      }
    }

    clearTimeout(timer);
    if (receivedAssistantContent) {
      return {
        status: "connected",
        message: `模型测试成功（${sourceLabel}），已生成响应：${cleanModelId}`,
      };
    }
    return {
      status: "failed",
      message: `模型未返回有效文本内容：${cleanModelId}`,
    };
  } catch (err: any) {
    clearTimeout(timer);
    const errMsg = String(err?.message || err);
    return {
      status: "failed",
      message: `模型测试失败：${errMsg.slice(0, 300)}`,
    };
  }
}
