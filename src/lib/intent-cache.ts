// Lazy intent → embedding cache for intent-conditional rerank.
//
// Design:
//   - exec writes audit entries with intent strings, NOT embeddings.
//   - At query time, when intent-conditional rerank is enabled, the bank
//     reads recent audit entries, embeds any whose intent isn't yet cached,
//     and caches the result keyed by the intent string.
//   - The cache lives at <bank>/intent-embeddings.json — a flat map from
//     intent string to vector + the embedding model that produced it.
//   - If the bank's embedding model changes (rare), the cache is invalidated.
//
// This keeps exec entirely local (no embedding API call per skill execution)
// while still enabling intent-conditional rerank when it matters at query time.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EmbeddingProvider } from "./embed.js";

interface IntentCacheFile {
  schema_version: "0.1";
  embedding_model: string;
  embeddings: Record<string, number[]>;
}

export class IntentEmbeddingCache {
  private readonly path: string;
  private readonly embedder: EmbeddingProvider;
  private cache: Map<string, number[]> = new Map();
  private loaded = false;

  constructor(path: string, embedder: EmbeddingProvider) {
    this.path = path;
    this.embedder = embedder;
  }

  /** Load the on-disk cache. Idempotent. */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const text = await readFile(this.path, "utf8");
      const parsed = JSON.parse(text) as IntentCacheFile;
      // If the embedding model changed, the cache is invalid.
      if (parsed.embedding_model === this.embedder.name) {
        for (const [intent, vec] of Object.entries(parsed.embeddings)) {
          if (Array.isArray(vec) && vec.length === this.embedder.dim) {
            this.cache.set(intent, vec);
          }
        }
      }
    } catch {
      // file doesn't exist yet; start fresh
    }
    this.loaded = true;
  }

  /** Persist the cache to disk. */
  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const out: IntentCacheFile = {
      schema_version: "0.1",
      embedding_model: this.embedder.name,
      embeddings: Object.fromEntries(this.cache.entries()),
    };
    await writeFile(this.path, JSON.stringify(out, null, 2), "utf8");
  }

  /** Get the embedding for an intent, computing + caching it if needed. */
  async getOrEmbed(intent: string): Promise<number[]> {
    if (!this.loaded) await this.load();
    const cached = this.cache.get(intent);
    if (cached !== undefined) return cached;
    const vec = await this.embedder.embed(intent);
    this.cache.set(intent, vec);
    // Save async-ish (don't await — caller can call save() at the end of the batch)
    return vec;
  }

  /**
   * Bulk-embed a list of intents, returning a Map. New embeddings are cached
   * and the cache is persisted at the end.
   */
  async embedBatch(intents: readonly string[]): Promise<Map<string, number[]>> {
    if (!this.loaded) await this.load();
    let added = false;
    for (const intent of intents) {
      if (!this.cache.has(intent)) {
        const vec = await this.embedder.embed(intent);
        this.cache.set(intent, vec);
        added = true;
      }
    }
    if (added) await this.save();
    const result = new Map<string, number[]>();
    for (const intent of intents) {
      const v = this.cache.get(intent);
      if (v !== undefined) result.set(intent, v);
    }
    return result;
  }

  /** For tests / introspection. */
  size(): number {
    return this.cache.size;
  }
}
