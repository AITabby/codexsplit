/**
 * Native Google Gemini API Adapter for CodexBridge (OpenCodex V2)
 */

import { ProtocolAdapter } from "./base.js";
import { ChatMessage, ChatCompletionRequestBody } from "../core/types.js";
import { thoughtSignatureStore } from "../services/thought_signature_store.js";

function sanitizeGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return { type: "STRING" };
  }

  const result: any = {};

  if (Array.isArray(schema.type)) {
    const firstType = schema.type.find((t: any) => typeof t === "string" && t !== "null") || "string";
    result.type = String(firstType).toUpperCase();
  } else if (typeof schema.type === "string") {
    result.type = schema.type.toUpperCase();
  } else if (schema.properties) {
    result.type = "OBJECT";
  } else if (schema.items) {
    result.type = "ARRAY";
  } else {
    result.type = "STRING";
  }

  if (["NULL", "UNDEFINED"].includes(result.type)) {
    result.type = "STRING";
  }

  if (typeof schema.description === "string") {
    result.description = schema.description;
  }

  if (Array.isArray(schema.enum)) {
    result.enum = schema.enum.map((e: any) => String(e));
  }

  if (schema.properties && typeof schema.properties === "object") {
    result.properties = {};
    for (const [key, propVal] of Object.entries(schema.properties)) {
      result.properties[key] = sanitizeGeminiSchema(propVal);
    }
  }

  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter((r: any) => typeof r === "string");
  }

  if (schema.items) {
    result.items = sanitizeGeminiSchema(schema.items);
  }

  return result;
}

function appendGeminiContentParts(parts: any[], content: any): void {
  if (typeof content === "string") {
    if (content) parts.push({ text: content });
    return;
  }
  if (!Array.isArray(content)) {
    if (content !== undefined && content !== null) parts.push({ text: JSON.stringify(content) });
    return;
  }
  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push({ text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      if (part.text) parts.push({ text: String(part.text) });
      continue;
    }
    const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    const dataMatch = String(imageUrl || "").match(/^data:([^;]+);base64,(.+)$/);
    if (dataMatch) parts.push({ inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } });
  }
}

function toolCallThoughtSignature(toolCall: any): string {
  const value = toolCall?.thought_signature || toolCall?.thoughtSignature || toolCall?.signature;
  if (typeof value === "string" && value.trim()) return value.trim();
  const id = toolCall?.id || toolCall?.call_id;
  if (id) {
    const fromStore = thoughtSignatureStore.get(String(id));
    if (fromStore) return fromStore;
  }
  return "";
}

function extractToolTextOutput(content: any): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        if (part) texts.push(part);
      } else if (part && typeof part === "object") {
        if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
          if (part.text) texts.push(String(part.text));
        }
      }
    }
    return texts.join("\n");
  }
  if (typeof content === "object") {
    return JSON.stringify(content);
  }
  return String(content);
}

function appendLegacyToolImages(parts: any[], content: any): void {
  if (!Array.isArray(content)) return;
  // A signatureless historical function call cannot be sent back to Gemini
  // as a functionCall/functionResponse pair. Keep only the visual state from
  // its result; textual tool transcripts are internal protocol data and must
  // not become model-visible user text that can be echoed to Codex.
  appendGeminiContentParts(parts, content.filter((part: any) => {
    if (!part || typeof part !== "object") return false;
    return part.type === "image_url" || part.type === "input_image" || part.type === "output_image";
  }));
}

export class GoogleGeminiAdapter implements ProtocolAdapter {
  public name = "google";
  private pendingThoughtSignature: string | null = null;

  public sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages;
  }

  public transformPayload(chatBody: ChatCompletionRequestBody): {
    urlEndpoint: string;
    headers: Record<string, string>;
    body: any;
  } {
    const rawContents: any[] = [];
    let systemInstruction: any = undefined;
    const toolNames = new Map<string, string>();
    const signaturelessToolCallIds = new Set<string>();
    for (const message of chatBody.messages) {
      for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!toolCallThoughtSignature(toolCall) && toolCall?.id) {
          signaturelessToolCallIds.add(String(toolCall.id));
        }
      }
    }

    let activeModelTurnCalls: Set<string> | null = null;

    for (const msg of chatBody.messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string" ? msg.content : "";
        if (!text.trim()) continue;
        if (!systemInstruction) {
          systemInstruction = {
            parts: [{ text }]
          };
        } else {
          systemInstruction.parts[0].text += `\n\n${text}`;
        }
        continue;
      }

      if (msg.role === "user") {
        activeModelTurnCalls = null;
        const parts: any[] = [];
        appendGeminiContentParts(parts, msg.content);
        if (parts.length > 0) {
          rawContents.push({ role: "user", parts });
        }
        continue;
      }

      if (msg.role === "assistant") {
        const parts: any[] = [];
        if (msg.content) appendGeminiContentParts(parts, msg.content);
        const emittedCallNames = new Set<string>();

        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
            const sig = toolCallThoughtSignature(tc);
            if (!sig) {
              if (tc.id && tc.function?.name) toolNames.set(String(tc.id), String(tc.function.name));
              continue;
            }
            const partObj: any = {
              functionCall: {
                name: tc.function.name,
                args,
              }
            };
            partObj.thoughtSignature = sig;
            partObj.thought_signature = sig;
            if (tc.id && tc.function?.name) toolNames.set(String(tc.id), String(tc.function.name));
            if (tc.function?.name) emittedCallNames.add(String(tc.function.name));
            parts.push(partObj);
          }
        }

        if (parts.length > 0) {
          rawContents.push({ role: "model", parts });
          activeModelTurnCalls = emittedCallNames.size > 0 ? emittedCallNames : null;
        }
        continue;
      }

      if (msg.role === "tool") {
        const parts: any[] = [];
        const responseName = String(msg.name || toolNames.get(String(msg.tool_call_id || "")) || "exec_command").trim();
        const isSignatureless = Boolean(msg.tool_call_id && signaturelessToolCallIds.has(String(msg.tool_call_id)));
        const hasPrecedingCall = activeModelTurnCalls !== null && activeModelTurnCalls.has(responseName);

        if (hasPrecedingCall && !isSignatureless) {
          parts.push({
            functionResponse: {
              name: responseName,
              response: { output: extractToolTextOutput(msg.content) }
            }
          });
        } else {
          // A functionResponse without an immediately preceding functionCall turn
          // violates Gemini's strict turn alternation and causes HTTP 400.
          appendLegacyToolImages(parts, msg.content);
        }
        // A local Computer Use result carries the screenshot beside the
        // function response so Gemini can inspect the updated desktop.
        if (Array.isArray(msg.content)) appendGeminiContentParts(parts, msg.content.filter((part: any) => part?.type !== "text"));

        if (parts.length > 0) {
          rawContents.push({ role: "user", parts });
        }
      }
    }

    const mergedContents: any[] = [];
    for (const item of rawContents) {
      if (!item.parts || item.parts.length === 0) continue;
      if (mergedContents.length > 0 && mergedContents[mergedContents.length - 1].role === item.role) {
        mergedContents[mergedContents.length - 1].parts.push(...item.parts);
      } else {
        mergedContents.push({ role: item.role, parts: [...item.parts] });
      }
    }

    if (mergedContents.length > 0 && mergedContents[0].role === "model") {
      mergedContents.unshift({ role: "user", parts: [{ text: "Continue the current task based on the preceding context and instructions." }] });
    }

    // Gemini's native endpoint rejects a request whose final turn is `model`.
    if (mergedContents.length > 0 && mergedContents[mergedContents.length - 1].role === "model") {
      while (mergedContents.length > 0 && mergedContents[mergedContents.length - 1].role === "model") {
        mergedContents.pop();
      }
    }

    // Final defense-in-depth: Ensure Gemini invariant that every functionResponse
    // is strictly in a `user` turn immediately following a `model` turn containing
    // a matching functionCall.
    for (let i = 0; i < mergedContents.length; i++) {
      const item = mergedContents[i];
      if (item.role === "user" && Array.isArray(item.parts)) {
        const prevModel = i > 0 && mergedContents[i - 1]?.role === "model" ? mergedContents[i - 1] : null;
        const availableCalls = new Set<string>();
        if (prevModel && Array.isArray(prevModel.parts)) {
          for (const p of prevModel.parts) {
            if (p?.functionCall?.name) availableCalls.add(String(p.functionCall.name));
          }
        }
        item.parts = item.parts.filter((p: any) => {
          if (p?.functionResponse) {
            const fnName = String(p.functionResponse.name || "");
            return availableCalls.has(fnName);
          }
          return true;
        });
      }
    }

    let finalContents = mergedContents.filter((c: any) => c.parts && c.parts.length > 0);
    if (finalContents.length === 0) {
      finalContents = [{ role: "user", parts: [{ text: "Hello" }] }];
    }
    if (finalContents[0].role === "model") {
      finalContents.unshift({ role: "user", parts: [{ text: "Hello" }] });
    }
    while (finalContents.length > 0 && finalContents[finalContents.length - 1].role === "model") {
      finalContents.pop();
    }
    if (finalContents.length === 0) {
      finalContents = [{ role: "user", parts: [{ text: "Hello" }] }];
    }

    const compactContents: any[] = [];
    for (const item of finalContents) {
      if (compactContents.length > 0 && compactContents[compactContents.length - 1].role === item.role) {
        compactContents[compactContents.length - 1].parts.push(...item.parts);
      } else {
        compactContents.push({ role: item.role, parts: [...item.parts] });
      }
    }

    const functionDeclarations = (chatBody.tools || []).map((t: any) => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || "",
        parameters: sanitizeGeminiSchema(fn.parameters || { type: "object", properties: {} }),
      };
    });

    const geminiBody: any = {
      contents: compactContents,
      generationConfig: {
        temperature: chatBody.temperature ?? 0.7,
        maxOutputTokens: chatBody.max_tokens ?? 65536,
        thinkingConfig: {
          includeThoughts: true,
        },
      }
    };

    if (systemInstruction) geminiBody.systemInstruction = systemInstruction;
    if (functionDeclarations.length > 0) {
      geminiBody.tools = [{ functionDeclarations }];
    }

    return {
      urlEndpoint: `:streamGenerateContent?alt=sse`,
      headers: { "Content-Type": "application/json" },
      body: geminiBody,
    };
  }

  public processStreamChunk(eventData: any): any[] {
    if (!eventData || typeof eventData !== "object") return [];
    const chunks: any[] = [];
    const candidate = (eventData.response?.candidates || eventData.candidates || [])[0];
    if (!candidate) return chunks;

    const candidateSig = candidate.content?.thoughtSignature
      || candidate.content?.thought_signature
      || candidate.thoughtSignature
      || candidate.thought_signature
      || eventData.thoughtSignature
      || eventData.response?.thoughtSignature;
    if (typeof candidateSig === "string" && candidateSig.trim()) {
      this.pendingThoughtSignature = candidateSig.trim();
    }

    const parts = candidate.content?.parts || [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const partSig = part.thoughtSignature || part.thought_signature;
      if (typeof partSig === "string" && partSig.trim()) {
        this.pendingThoughtSignature = partSig.trim();
      }

      if (part.text) {
        if (part.thought === true) {
          chunks.push({
            choices: [{
              delta: { reasoning_content: part.text }
            }]
          });
        } else {
          chunks.push({
            choices: [{
              delta: { content: part.text }
            }]
          });
        }
      }
      if (part.functionCall) {
        const sig = part.thoughtSignature
          || part.thought_signature
          || this.pendingThoughtSignature
          || candidate.content?.thoughtSignature
          || candidate.content?.thought_signature;
        let argumentSize = 0;
        try {
          argumentSize = JSON.stringify(part.functionCall.args || {}).length;
        } catch {
          argumentSize = 0;
        }
        console.info(
          `[CodexSplit Gemini] functionCall name=${String(part.functionCall.name || "").trim() || "(empty)"} ` +
          `args_chars=${argumentSize} thought_signature=${Boolean(sig)}`,
        );
        const toolCallObj: any = {
          index: i,
          id: `call_gemini_${Date.now()}_${i}`,
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        };
        if (sig) {
          toolCallObj.thought_signature = sig;
          toolCallObj.thoughtSignature = sig;
          thoughtSignatureStore.set(toolCallObj.id, sig);
        }
        chunks.push({
          choices: [{
            delta: {
              tool_calls: [toolCallObj]
            }
          }]
        });
      }
    }
    if (candidate.finishReason) {
      this.pendingThoughtSignature = null;
    }
    return chunks;
  }
}
