/**
 * Thought Signature Store for CodexBridge (OpenCodex V2)
 *
 * Codex Desktop is an OpenAI-native client that does not persist or echo
 * provider-proprietary fields like Google's thought_signature across
 * multi-turn chat completions.
 *
 * This store caches thought_signature keyed by call_id and item id (fc_*)
 * so they can be rehydrated when Codex Desktop sends back the continuation.
 */

interface CachedSignature {
  signature: string;
  timestamp: number;
}

export class ThoughtSignatureStore {
  private cache = new Map<string, CachedSignature>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = 50_000, ttlMs = 24 * 60 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  public set(id: unknown, signature: unknown): void {
    const key = typeof id === "string" ? id.trim() : "";
    const val = typeof signature === "string" ? signature.trim() : "";
    if (!key || !val) return;

    // Refresh position for LRU
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      // Evict oldest entry
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { signature: val, timestamp: Date.now() });
  }

  public get(id: unknown): string | undefined {
    const key = typeof id === "string" ? id.trim() : "";
    if (!key) return undefined;

    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Refresh LRU position on access
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.signature;
  }

  public has(id: unknown): boolean {
    return this.get(id) !== undefined;
  }

  public delete(id: unknown): boolean {
    const key = typeof id === "string" ? id.trim() : "";
    if (!key) return false;
    return this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }

  public prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }
}

export const thoughtSignatureStore = new ThoughtSignatureStore();
