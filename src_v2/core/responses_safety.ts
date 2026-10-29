export function isNativeResponsesReasoningId(value: unknown): boolean {
  return typeof value === "string" && /^rs(?:_|[A-Za-z0-9_-])+/i.test(value.trim());
}

export function isNativeResponsesMessageId(value: unknown): boolean {
  return typeof value === "string" && /^msg[A-Za-z0-9_-]*/i.test(value.trim());
}

export function normalizeNativeResponsesMessageId(id: string): string {
  const trimmed = id.trim();
  if (isNativeResponsesMessageId(trimmed)) return trimmed;
  const cleaned = trimmed.replace(/_msg(?:_\d+)?$/i, "").replace(/^_+/, "");
  return `msg_${cleaned || "import"}`;
}

export function sanitizeNativeResponsesItem(item: any): { item: any; normalized: boolean } {
  if (!item || typeof item !== "object") return { item, normalized: false };
  const type = String(item.type || "").trim();
  const role = String(item.role || "").trim();
  let normalized = false;

  // 1. additional_tools: must begin with 'at'
  if (type === "additional_tools" || (typeof item.id === "string" && /^msg_at_/i.test(item.id))) {
    if (typeof item.id === "string") {
      let rawId = item.id.trim();
      if (/^msg_at_/i.test(rawId)) {
        rawId = rawId.slice(4);
        normalized = true;
      }
      if (!rawId.startsWith("at")) {
        rawId = `at_${rawId.replace(/^_+/, "")}`;
        normalized = true;
      }
      return { item: { ...item, type: "additional_tools", id: rawId }, normalized };
    }
    return { item, normalized: false };
  }

  // 2. reasoning: must begin with 'rs', content must be empty array
  if (type === "reasoning" || (typeof item.id === "string" && /^msg_rs_/i.test(item.id))) {
    let rawId = typeof item.id === "string" ? item.id.trim() : "";
    if (/^msg_rs_/i.test(rawId)) {
      rawId = rawId.slice(4);
      normalized = true;
    }
    if (rawId && !rawId.startsWith("rs")) {
      rawId = `rs_${rawId.replace(/^_+/, "")}`;
      normalized = true;
    }
    return {
      item: {
        ...item,
        type: "reasoning",
        ...(rawId ? { id: rawId } : {}),
        content: [],
        summary: Array.isArray(item.summary) ? item.summary : [],
      },
      normalized,
    };
  }

  // 3. function_call / custom_tool_call
  if (type === "function_call" || (typeof item.id === "string" && /^msg_(?:call_|fc_)/i.test(item.id))) {
    if (typeof item.id === "string") {
      let rawId = item.id.trim();
      if (/^msg_(?:call_|fc_)/i.test(rawId)) {
        rawId = rawId.slice(4);
        normalized = true;
      }
      if (!rawId.startsWith("call_") && !rawId.startsWith("fc_")) {
        rawId = `fc_${rawId.replace(/^_+/, "")}`;
        normalized = true;
      }
      return { item: { ...item, id: rawId }, normalized };
    }
  }

  if (type === "function_call_output" && typeof item.call_id === "string") {
    let rawCallId = item.call_id.trim();
    if (/^msg_(?:call_|fc_)/i.test(rawCallId)) {
      rawCallId = rawCallId.slice(4);
      normalized = true;
    }
    if (!rawCallId.startsWith("call_") && !rawCallId.startsWith("fc_")) {
      rawCallId = `fc_${rawCallId.replace(/^_+/, "")}`;
      normalized = true;
    }
    return { item: { ...item, call_id: rawCallId }, normalized };
  }

  if (type === "custom_tool_call" || (typeof item.id === "string" && /^msg_ccall_/i.test(item.id))) {
    if (typeof item.id === "string") {
      let rawId = item.id.trim();
      if (/^msg_ccall_/i.test(rawId)) {
        rawId = rawId.slice(4);
        normalized = true;
      }
      if (!rawId.startsWith("ccall_") && !rawId.startsWith("call_")) {
        rawId = `ccall_${rawId.replace(/^_+/, "")}`;
        normalized = true;
      }
      return { item: { ...item, id: rawId }, normalized };
    }
  }

  if (type === "custom_tool_call_output" && typeof item.call_id === "string") {
    let rawCallId = item.call_id.trim();
    if (/^msg_ccall_/i.test(rawCallId)) {
      rawCallId = rawCallId.slice(4);
      normalized = true;
    }
    if (!rawCallId.startsWith("ccall_") && !rawCallId.startsWith("call_")) {
      rawCallId = `ccall_${rawCallId.replace(/^_+/, "")}`;
      normalized = true;
    }
    return { item: { ...item, call_id: rawCallId }, normalized };
  }

  // 4. message: must begin with 'msg'
  const isMessage = type === "message" || (!type && (role === "user" || role === "assistant" || role === "system"));
  if (isMessage && typeof item.id === "string") {
    const rawId = item.id.trim();
    if (rawId && !isNativeResponsesMessageId(rawId)) {
      return {
        item: {
          ...item,
          id: normalizeNativeResponsesMessageId(rawId),
        },
        normalized: true,
      };
    }
  }

  return { item, normalized: false };
}

export function sanitizeNativeResponsesBody(body: any): {
  body: any;
  removedReasoningItems: number;
  removedPreviousResponseId: boolean;
  normalizedMessageIds: number;
} {
  const sanitized = { ...(body || {}) };
  let removedReasoningItems = 0;
  let removedPreviousResponseId = false;
  let normalizedMessageIds = 0;

  if (Array.isArray(body?.input)) {
    sanitized.input = body.input
      .filter((item: any) => {
        if (item?.type !== "reasoning") return true;
        // Native ChatGPT reasoning items carry server-encrypted content.
        // Gateway-generated reasoning items have encrypted_content == null.
        const keep = isNativeResponsesReasoningId(item?.id) && item?.encrypted_content != null;
        if (!keep) removedReasoningItems++;
        return keep;
      })
      .map((item: any) => {
        const { item: resItem, normalized } = sanitizeNativeResponsesItem(item);
        if (normalized) normalizedMessageIds++;
        return resItem;
      });
  }

  if (typeof body?.previous_response_id === "string" && body.previous_response_id.trim() && !/^resp(?:_|[A-Za-z0-9_-])+/i.test(body.previous_response_id.trim())) {
    delete sanitized.previous_response_id;
    removedPreviousResponseId = true;
  }

  return { body: sanitized, removedReasoningItems, removedPreviousResponseId, normalizedMessageIds };
}
