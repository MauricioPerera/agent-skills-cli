// Embedding provider abstraction. Conformant skill banks may use any model
// they choose; the spec (SPEC.md §4.2) only requires that the same model is
// used at indexing time and at query time. This module defines the provider
// interface and ships two implementations: Cloudflare Workers AI (default)
// and a stub for tests.

import { CliError, EXIT } from "./errors.js";

export interface EmbeddingProvider {
  /** Stable identifier including the model name. Stored on each indexed skill so banks can detect mismatch. */
  readonly name: string;
  /** Output dimensionality of the model. */
  readonly dim: number;
  /** Compute the embedding vector for a single text input. */
  embed(text: string): Promise<number[]>;
}

// Cloudflare Workers AI — known embedding models with their dimensions.
// Source: https://developers.cloudflare.com/workers-ai/models/?task=Text+Embeddings
const CF_MODEL_DIMS: Record<string, number> = {
  "@cf/baai/bge-small-en-v1.5": 384,
  "@cf/baai/bge-base-en-v1.5": 768,
  "@cf/baai/bge-large-en-v1.5": 1024,
  "@cf/baai/bge-m3": 1024,
  "@cf/google/embeddinggemma-300m": 768,
};

export interface CloudflareEmbedderConfig {
  /** Cloudflare account ID (32 hex chars). */
  accountId: string;
  /** API token with Workers AI permission. */
  apiToken: string;
  /** Model identifier. Default: @cf/baai/bge-base-en-v1.5 (768-dim, free tier). */
  model?: string;
  /** Optional custom fetch (for testing). */
  fetchFn?: typeof fetch;
}

/**
 * Create an embedding provider backed by Cloudflare Workers AI's REST API.
 *
 * Auth: the account ID + API token are passed at construction. They are NOT
 * read from the environment automatically — that's the CLI's responsibility,
 * keeping this lib pure.
 *
 * The token never appears in any error message thrown by this module.
 */
export const createCloudflareEmbedder = (
  config: CloudflareEmbedderConfig,
): EmbeddingProvider => {
  if (!/^[a-f0-9]{32}$/.test(config.accountId)) {
    throw new CliError(EXIT.USAGE, `invalid Cloudflare account ID format`);
  }
  if (config.apiToken.length === 0) {
    throw new CliError(EXIT.USAGE, "Cloudflare API token is empty");
  }

  const model = config.model ?? "@cf/baai/bge-base-en-v1.5";
  const dim = CF_MODEL_DIMS[model];
  if (dim === undefined) {
    throw new CliError(
      EXIT.USAGE,
      `unknown Cloudflare embedding model '${model}'. Known: ${Object.keys(CF_MODEL_DIMS).join(", ")}`,
    );
  }

  const fetchImpl = config.fetchFn ?? globalThis.fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${model}`;

  return {
    name: `cloudflare:${model}`,
    dim,
    async embed(text: string): Promise<number[]> {
      if (text.length === 0) {
        throw new CliError(EXIT.USAGE, "cannot embed empty text");
      }

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(EXIT.RUNTIME, `Cloudflare AI request failed: ${msg}`);
      }

      if (!res.ok) {
        // Read body but never include the auth token in error messages.
        let body = "";
        try {
          body = await res.text();
        } catch {
          // ignore
        }
        throw new CliError(
          EXIT.RUNTIME,
          `Cloudflare AI returned ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
        );
      }

      const json = (await res.json()) as {
        result?: { data?: number[][]; shape?: number[] };
        success?: boolean;
        errors?: unknown[];
      };

      if (json.success === false) {
        throw new CliError(
          EXIT.RUNTIME,
          `Cloudflare AI returned errors: ${JSON.stringify(json.errors)}`,
        );
      }

      const vec = json.result?.data?.[0];
      if (!Array.isArray(vec)) {
        throw new CliError(
          EXIT.RUNTIME,
          "Cloudflare AI response missing result.data[0] (embedding vector)",
        );
      }
      if (vec.length !== dim) {
        throw new CliError(
          EXIT.RUNTIME,
          `Cloudflare AI returned ${vec.length}-dim vector; expected ${dim} for model ${model}`,
        );
      }

      return vec;
    },
  };
};

// ────────────────────────────────────────────────────────────────────
// Ollama provider (v0.6.0+) — local-first, no credentials, no network egress.
// ────────────────────────────────────────────────────────────────────

/** Known Ollama embedding models with their dimensions. Operators can override via OLLAMA_DIM. */
const OLLAMA_MODEL_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "nomic-embed-text:latest": 768,
  "mxbai-embed-large": 1024,
  "mxbai-embed-large:latest": 1024,
  "all-minilm": 384,
  "all-minilm:latest": 384,
  "snowflake-arctic-embed": 1024,
  "snowflake-arctic-embed:latest": 1024,
  "snowflake-arctic-embed-m": 768,
  "snowflake-arctic-embed-m:latest": 768,
  "bge-m3": 1024,
  "bge-m3:latest": 1024,
  "bge-large": 1024,
  "bge-large:latest": 1024,
  "embeddinggemma": 768,
  "embeddinggemma:latest": 768,
};

export interface OllamaEmbedderConfig {
  /** Base URL of the Ollama server. Default: http://localhost:11434 */
  baseUrl?: string;
  /** Model identifier. Default: nomic-embed-text */
  model?: string;
  /** Output dimensionality. Required for models not in OLLAMA_MODEL_DIMS. */
  dim?: number;
  /** Optional custom fetch (for testing). */
  fetchFn?: typeof fetch;
}

/**
 * Create an embedding provider backed by a local Ollama server.
 *
 * Uses Ollama's `/api/embed` endpoint (the post-0.5 batched API). Returns a
 * 1-text batch each time `embed()` is called; sync/query callers can issue
 * many in parallel — Ollama serializes internally per model.
 *
 * Default model: `nomic-embed-text` (768-dim, OSS, ~270 MB).
 *
 * Setup:
 *   ollama pull nomic-embed-text
 *   # OLLAMA_BASE_URL defaults to http://localhost:11434
 *   EMBEDDING_PROVIDER=ollama agent-skills sync github.com/...
 */
export const createOllamaEmbedder = (
  config: OllamaEmbedderConfig = {},
): EmbeddingProvider => {
  const baseUrl = (config.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
  const model = config.model ?? "nomic-embed-text";
  const dim = config.dim ?? OLLAMA_MODEL_DIMS[model];
  if (dim === undefined) {
    throw new CliError(
      EXIT.USAGE,
      `unknown Ollama embedding model '${model}'. Known: ${Object.keys(OLLAMA_MODEL_DIMS).join(", ")}. ` +
        `For other models, set OLLAMA_DIM=<n> explicitly.`,
    );
  }

  const fetchImpl = config.fetchFn ?? globalThis.fetch;
  const url = `${baseUrl}/api/embed`;

  return {
    name: `ollama:${model}`,
    dim,
    async embed(text: string): Promise<number[]> {
      if (text.length === 0) {
        throw new CliError(EXIT.USAGE, "cannot embed empty text");
      }

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: text }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(
          EXIT.RUNTIME,
          `Ollama request failed (is the server running at ${baseUrl}?): ${msg}`,
        );
      }

      if (!res.ok) {
        let body = "";
        try {
          body = await res.text();
        } catch {
          // ignore
        }
        // Common operator mistake: model not pulled yet.
        if (res.status === 404 && body.includes("model")) {
          throw new CliError(
            EXIT.RUNTIME,
            `Ollama returned 404 for model '${model}'. Run: ollama pull ${model}`,
          );
        }
        throw new CliError(
          EXIT.RUNTIME,
          `Ollama returned ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
        );
      }

      const json = (await res.json()) as { embeddings?: number[][] };
      const vec = json.embeddings?.[0];
      if (!Array.isArray(vec)) {
        throw new CliError(
          EXIT.RUNTIME,
          "Ollama response missing embeddings[0]. Did you set the right model name?",
        );
      }
      if (vec.length !== dim) {
        throw new CliError(
          EXIT.RUNTIME,
          `Ollama returned ${vec.length}-dim vector; expected ${dim} for model ${model}. ` +
            `Override with OLLAMA_DIM=${vec.length} if this model's dim is just unknown to the CLI.`,
        );
      }
      return vec;
    },
  };
};

// ────────────────────────────────────────────────────────────────────
// OpenAI / OpenAI-compatible provider (v0.6.0+).
// ────────────────────────────────────────────────────────────────────

/** Known OpenAI models with their default dimensions. */
const OPENAI_MODEL_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export interface OpenAIEmbedderConfig {
  /** API key. */
  apiKey: string;
  /** Base URL. Default: https://api.openai.com/v1. Override for OpenAI-compatible servers (TEI, infinity, vLLM, Together, Anyscale, Mistral …). */
  baseUrl?: string;
  /** Model identifier. Default: text-embedding-3-small */
  model?: string;
  /**
   * Output dimensionality. Optional — omitted means use the model's default.
   * For `text-embedding-3-*`, OpenAI supports projecting to a smaller dim;
   * pass `dim` to enable the `dimensions` parameter on the request.
   */
  dim?: number;
  /** Optional custom fetch (for testing). */
  fetchFn?: typeof fetch;
}

/**
 * Create an embedding provider for OpenAI's /v1/embeddings or any
 * OpenAI-compatible endpoint (Together, Anyscale, Mistral, vLLM, infinity,
 * TEI when run in OpenAI-compatibility mode, Voyage, Cohere via gateway, …).
 */
export const createOpenAIEmbedder = (
  config: OpenAIEmbedderConfig,
): EmbeddingProvider => {
  if (!config.apiKey || config.apiKey.length === 0) {
    throw new CliError(EXIT.USAGE, "OpenAI API key is empty");
  }
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = config.model ?? "text-embedding-3-small";
  const defaultDim = OPENAI_MODEL_DIMS[model];
  const dim = config.dim ?? defaultDim;
  if (dim === undefined) {
    throw new CliError(
      EXIT.USAGE,
      `unknown OpenAI-compatible model '${model}'. Known OpenAI defaults: ${Object.keys(OPENAI_MODEL_DIMS).join(", ")}. ` +
        `For other models / providers, pass dim explicitly.`,
    );
  }

  const fetchImpl = config.fetchFn ?? globalThis.fetch;
  const url = `${baseUrl}/embeddings`;

  return {
    name: `openai:${model}${config.dim ? `@${config.dim}` : ""}`,
    dim,
    async embed(text: string): Promise<number[]> {
      if (text.length === 0) {
        throw new CliError(EXIT.USAGE, "cannot embed empty text");
      }

      // Only send `dimensions` param if user explicitly downsized (or model supports it
      // and the value differs from default).
      const body: Record<string, unknown> = { model, input: text };
      if (config.dim !== undefined && config.dim !== defaultDim) {
        body.dimensions = config.dim;
      }

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(EXIT.RUNTIME, `OpenAI embeddings request failed: ${msg}`);
      }

      if (!res.ok) {
        let bodyTxt = "";
        try {
          bodyTxt = await res.text();
        } catch {
          // ignore
        }
        throw new CliError(
          EXIT.RUNTIME,
          `OpenAI embeddings returned ${res.status} ${res.statusText}: ${bodyTxt.slice(0, 500)}`,
        );
      }

      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec)) {
        throw new CliError(
          EXIT.RUNTIME,
          "OpenAI embeddings response missing data[0].embedding",
        );
      }
      if (vec.length !== dim) {
        throw new CliError(
          EXIT.RUNTIME,
          `OpenAI embeddings returned ${vec.length}-dim vector; expected ${dim}`,
        );
      }
      return vec;
    },
  };
};

// ────────────────────────────────────────────────────────────────────
// Transformers.js provider (v2.3.0+) — fully local, no server, no creds.
//
// Runs the embedding model in-process via @huggingface/transformers
// (ONNX Runtime). Works in Node ≥22, Bun, Deno, Cloudflare Workers, and
// the browser. The first embed() call lazy-loads the model (downloads
// from Hugging Face Hub on first use, then served from disk cache).
// ────────────────────────────────────────────────────────────────────

/**
 * Known transformers.js-compatible embedding models with their dimensions.
 * Operators can use any other ONNX feature-extraction model on the Hub by
 * passing `dim` explicitly via TRANSFORMERS_DIM.
 *
 * `onnx-community/embeddinggemma-300m-ONNX` is provided for parity with
 * the Cloudflare `@cf/google/embeddinggemma-300m` provider — same weights,
 * same vector space, no network egress.
 */
const TRANSFORMERS_MODEL_DIMS: Record<string, number> = {
  // Sentence-transformers (English)
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/all-MiniLM-L12-v2": 384,
  "Xenova/all-mpnet-base-v2": 768,
  "Xenova/all-distilroberta-v1": 768,
  // BGE family (BAAI)
  "Xenova/bge-small-en-v1.5": 384,
  "Xenova/bge-base-en-v1.5": 768,
  "Xenova/bge-large-en-v1.5": 1024,
  "Xenova/bge-m3": 1024,
  // Multilingual
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": 384,
  "Xenova/multilingual-e5-small": 384,
  "Xenova/multilingual-e5-base": 768,
  "Xenova/multilingual-e5-large": 1024,
  // GTE
  "Xenova/gte-small": 384,
  "Xenova/gte-base": 768,
  "Xenova/gte-large": 1024,
  // Jina
  "Xenova/jina-embeddings-v2-small-en": 512,
  "Xenova/jina-embeddings-v2-base-en": 768,
  // EmbeddingGemma — parity with Cloudflare @cf/google/embeddinggemma-300m
  "onnx-community/embeddinggemma-300m-ONNX": 768,
};

/** Subset of @huggingface/transformers types we use, declared inline so this
 *  module compiles without the dep installed. */
type TransformersPipeline = (
  text: string,
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean },
) => Promise<{ data: ArrayLike<number> }>;

type TransformersModule = {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<TransformersPipeline>;
  env?: { cacheDir?: string; allowLocalModels?: boolean; allowRemoteModels?: boolean };
};

export interface TransformersJSEmbedderConfig {
  /** Model identifier on Hugging Face Hub. Default: Xenova/all-MiniLM-L6-v2 (384-dim, ~25 MB). */
  model?: string;
  /** Output dimensionality. Required for models not in TRANSFORMERS_MODEL_DIMS. */
  dim?: number;
  /** Cache directory for downloaded models. Default: process default ($HOME/.cache/huggingface). */
  cacheDir?: string;
  /** Quantization. Default: "fp32". Other values: "fp16" | "q8" | "q4" (smaller/faster, slight quality loss). */
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  /** Pooling strategy applied by the pipeline. Default: "mean". */
  pooling?: "mean" | "cls";
  /** L2-normalize the resulting vector. Default: true. */
  normalize?: boolean;
  /**
   * Test-only injection point. When provided, used in place of dynamically
   * importing "@huggingface/transformers". Lets tests avoid pulling the
   * real library and downloading weights.
   */
  loadModule?: () => Promise<TransformersModule>;
}

/**
 * Create an embedding provider that runs the model entirely in-process via
 * @huggingface/transformers (ONNX Runtime).
 *
 * The pipeline is lazy-loaded on the first `embed()` call and reused for
 * subsequent calls. Concurrent first calls share the same load promise.
 *
 * @huggingface/transformers is a runtime peer dependency — install it
 * separately:
 *
 *   npm install @huggingface/transformers
 *
 * Setup (Node):
 *   npm install @huggingface/transformers
 *   EMBEDDING_PROVIDER=transformers-js \
 *   TRANSFORMERS_MODEL=Xenova/all-MiniLM-L6-v2 \
 *   agent-skills sync github.com/...
 */
export const createTransformersJSEmbedder = (
  config: TransformersJSEmbedderConfig = {},
): EmbeddingProvider => {
  const model = config.model ?? "Xenova/all-MiniLM-L6-v2";
  const dim = config.dim ?? TRANSFORMERS_MODEL_DIMS[model];
  if (dim === undefined) {
    throw new CliError(
      EXIT.USAGE,
      `unknown transformers.js embedding model '${model}'. ` +
        `Known: ${Object.keys(TRANSFORMERS_MODEL_DIMS).join(", ")}. ` +
        `For other models, set TRANSFORMERS_DIM=<n> explicitly.`,
    );
  }

  const dtype = config.dtype ?? "fp32";
  const pooling = config.pooling ?? "mean";
  const normalize = config.normalize ?? true;

  let pipelinePromise: Promise<TransformersPipeline> | null = null;

  const getPipeline = async (): Promise<TransformersPipeline> => {
    if (pipelinePromise) return pipelinePromise;
    pipelinePromise = (async () => {
      let mod: TransformersModule;
      try {
        if (config.loadModule) {
          mod = await config.loadModule();
        } else {
          // Dynamic import via a string variable so TypeScript's module
          // resolver doesn't require the package to be present at compile time.
          // It's an optional peer dependency: only required at runtime when
          // the user explicitly selects this provider.
          const pkg = "@huggingface/transformers";
          mod = (await import(/* @vite-ignore */ pkg)) as unknown as TransformersModule;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(
          EXIT.USAGE,
          `transformers.js provider requires @huggingface/transformers. ` +
            `Install with: npm install @huggingface/transformers. ` +
            `Original error: ${msg}`,
        );
      }
      if (config.cacheDir && mod.env) {
        mod.env.cacheDir = config.cacheDir;
      }
      try {
        return await mod.pipeline("feature-extraction", model, { dtype });
      } catch (err) {
        // Reset so a transient failure doesn't permanently break the provider.
        pipelinePromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(
          EXIT.RUNTIME,
          `transformers.js failed to load model '${model}': ${msg}`,
        );
      }
    })();
    return pipelinePromise;
  };

  return {
    name: `transformers-js:${model}`,
    dim,
    async embed(text: string): Promise<number[]> {
      if (text.length === 0) {
        throw new CliError(EXIT.USAGE, "cannot embed empty text");
      }
      const extractor = await getPipeline();
      let output: { data: ArrayLike<number> };
      try {
        output = await extractor(text, { pooling, normalize });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(EXIT.RUNTIME, `transformers.js inference failed: ${msg}`);
      }
      const vec = Array.from(output.data as ArrayLike<number>) as number[];
      if (vec.length !== dim) {
        throw new CliError(
          EXIT.RUNTIME,
          `transformers.js returned ${vec.length}-dim vector; expected ${dim} for model ${model}. ` +
            `Override with TRANSFORMERS_DIM=${vec.length} if this model's dim is unknown to the CLI.`,
        );
      }
      return vec;
    },
  };
};

// ────────────────────────────────────────────────────────────────────
// Provider factory: pick a provider from env vars.
// ────────────────────────────────────────────────────────────────────

export interface ResolveEmbedderOptions {
  /** Override-everything: explicit provider name. Otherwise read from env EMBEDDING_PROVIDER. */
  provider?: "cloudflare" | "ollama" | "openai" | "transformers-js";
  /** Optional custom fetch (for testing). */
  fetchFn?: typeof fetch;
  /** Snapshot of env vars (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Test-only loader for the @huggingface/transformers module. */
  loadTransformersModule?: () => Promise<TransformersModule>;
}

/**
 * Resolve which embedding provider to use based on environment variables.
 *
 * Selection algorithm:
 *   1. If `opts.provider` is set, use it.
 *   2. Else if `env.EMBEDDING_PROVIDER` is set, use that.
 *   3. Else auto-detect, in this order:
 *        a. Cloudflare — if both CF_ACCOUNT_ID and CF_API_TOKEN are set.
 *        b. OpenAI — if OPENAI_API_KEY is set.
 *        c. Ollama — if OLLAMA_BASE_URL or OLLAMA_MODEL is set as a hint.
 *        d. transformers.js — if TRANSFORMERS_MODEL is set as a hint.
 *   4. Else throw a USAGE error listing all 4 options.
 *
 * Rationale for the auto-detect order: existing Cloudflare users (the v0.2-v0.5
 * audience) keep working with no env changes; explicit OpenAI keys signal a
 * clear opt-in; Ollama and transformers.js are reserved for the explicit case
 * (no other creds present AND a positive *_MODEL hint) because they would
 * otherwise shadow misconfigured environments where the user forgot to set
 * their real provider's vars.
 *
 * To override the auto-detect priority, set EMBEDDING_PROVIDER explicitly.
 */
export const resolveEmbedderFromEnv = (
  opts: ResolveEmbedderOptions = {},
): EmbeddingProvider => {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn;
  const explicit = opts.provider ?? env.EMBEDDING_PROVIDER;

  const tryCloudflare = (): EmbeddingProvider => {
    const accountId = env.CF_ACCOUNT_ID;
    const apiToken = env.CF_API_TOKEN;
    if (!accountId || !apiToken) {
      throw new CliError(
        EXIT.USAGE,
        "Cloudflare provider needs CF_ACCOUNT_ID and CF_API_TOKEN in the environment.",
      );
    }
    return createCloudflareEmbedder({
      accountId,
      apiToken,
      model: env.CF_EMBEDDING_MODEL,
      fetchFn,
    });
  };

  const tryOllama = (): EmbeddingProvider => {
    const dimEnv = env.OLLAMA_DIM ? Number.parseInt(env.OLLAMA_DIM, 10) : undefined;
    if (dimEnv !== undefined && (!Number.isFinite(dimEnv) || dimEnv <= 0)) {
      throw new CliError(EXIT.USAGE, `OLLAMA_DIM must be a positive integer, got '${env.OLLAMA_DIM}'`);
    }
    return createOllamaEmbedder({
      baseUrl: env.OLLAMA_BASE_URL,
      model: env.OLLAMA_MODEL,
      dim: dimEnv,
      fetchFn,
    });
  };

  const tryOpenAI = (): EmbeddingProvider => {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new CliError(
        EXIT.USAGE,
        "OpenAI provider needs OPENAI_API_KEY in the environment.",
      );
    }
    const dimEnv = env.OPENAI_DIM ? Number.parseInt(env.OPENAI_DIM, 10) : undefined;
    if (dimEnv !== undefined && (!Number.isFinite(dimEnv) || dimEnv <= 0)) {
      throw new CliError(EXIT.USAGE, `OPENAI_DIM must be a positive integer, got '${env.OPENAI_DIM}'`);
    }
    return createOpenAIEmbedder({
      apiKey,
      baseUrl: env.OPENAI_BASE_URL,
      model: env.OPENAI_MODEL,
      dim: dimEnv,
      fetchFn,
    });
  };

  const tryTransformersJS = (): EmbeddingProvider => {
    const dimEnv = env.TRANSFORMERS_DIM ? Number.parseInt(env.TRANSFORMERS_DIM, 10) : undefined;
    if (dimEnv !== undefined && (!Number.isFinite(dimEnv) || dimEnv <= 0)) {
      throw new CliError(
        EXIT.USAGE,
        `TRANSFORMERS_DIM must be a positive integer, got '${env.TRANSFORMERS_DIM}'`,
      );
    }
    const dtypeEnv = env.TRANSFORMERS_DTYPE;
    if (
      dtypeEnv !== undefined &&
      !["fp32", "fp16", "q8", "q4"].includes(dtypeEnv)
    ) {
      throw new CliError(
        EXIT.USAGE,
        `TRANSFORMERS_DTYPE must be one of fp32 | fp16 | q8 | q4, got '${dtypeEnv}'`,
      );
    }
    const poolingEnv = env.TRANSFORMERS_POOLING;
    if (poolingEnv !== undefined && !["mean", "cls"].includes(poolingEnv)) {
      throw new CliError(
        EXIT.USAGE,
        `TRANSFORMERS_POOLING must be one of mean | cls, got '${poolingEnv}'`,
      );
    }
    const normalizeEnv = env.TRANSFORMERS_NORMALIZE;
    let normalize: boolean | undefined;
    if (normalizeEnv !== undefined) {
      if (normalizeEnv === "true" || normalizeEnv === "1") normalize = true;
      else if (normalizeEnv === "false" || normalizeEnv === "0") normalize = false;
      else {
        throw new CliError(
          EXIT.USAGE,
          `TRANSFORMERS_NORMALIZE must be true|false|1|0, got '${normalizeEnv}'`,
        );
      }
    }
    return createTransformersJSEmbedder({
      model: env.TRANSFORMERS_MODEL,
      dim: dimEnv,
      cacheDir: env.TRANSFORMERS_CACHE_DIR,
      dtype: dtypeEnv as TransformersJSEmbedderConfig["dtype"],
      pooling: poolingEnv as TransformersJSEmbedderConfig["pooling"],
      normalize,
      loadModule: opts.loadTransformersModule,
    });
  };

  if (explicit === "cloudflare") return tryCloudflare();
  if (explicit === "ollama") return tryOllama();
  if (explicit === "openai") return tryOpenAI();
  if (explicit === "transformers-js") return tryTransformersJS();
  if (explicit !== undefined) {
    throw new CliError(
      EXIT.USAGE,
      `unknown EMBEDDING_PROVIDER '${explicit}'. Valid: cloudflare | ollama | openai | transformers-js`,
    );
  }

  // Auto-detect (no explicit provider)
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) return tryCloudflare();
  if (env.OPENAI_API_KEY) return tryOpenAI();
  if (env.OLLAMA_BASE_URL || env.OLLAMA_MODEL) return tryOllama();
  if (env.TRANSFORMERS_MODEL) return tryTransformersJS();

  // Nothing configured. Helpful error listing all 4 options.
  throw new CliError(
    EXIT.USAGE,
    [
      "no embedding provider configured. Set one of:",
      "  • EMBEDDING_PROVIDER=cloudflare with CF_ACCOUNT_ID + CF_API_TOKEN",
      "  • EMBEDDING_PROVIDER=ollama (defaults to http://localhost:11434, model nomic-embed-text)",
      "  • EMBEDDING_PROVIDER=openai with OPENAI_API_KEY",
      "  • EMBEDDING_PROVIDER=transformers-js (in-process via @huggingface/transformers, no creds, no server)",
      "Or set the relevant credentials and the provider auto-detects.",
    ].join("\n"),
  );
};

/**
 * Stub provider for testing. Hashes the input text deterministically into a
 * fixed-dim vector. Same text → same vector → reproducible tests.
 *
 * Uses a simple FNV-1a hash to spread bytes across the vector.
 */
export const createStubEmbedder = (dim = 32): EmbeddingProvider => {
  return {
    name: `stub:fnv1a-${dim}`,
    dim,
    async embed(text: string): Promise<number[]> {
      const vec = new Array<number>(dim).fill(0);
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
        vec[i % dim] = ((vec[i % dim] ?? 0) + (h & 0xff) / 0xff) % 1;
      }
      // L2-normalize so cosine similarity is well-behaved
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm) || 1;
      return vec.map((v) => v / norm);
    },
  };
};

/**
 * Compose the embedding text per SPEC.md §4.2.
 *
 *   1. title
 *   2. use_when
 *   3. description
 *   4. examples[].intent (joined by \n)
 *   5. tags (joined by space)
 *
 * Sections joined by ". " (period + space).
 */
export const composeEmbeddingText = (fm: {
  title: string;
  use_when: string;
  description: string;
  examples?: Array<{ intent: string }>;
  tags?: string[];
}): string => {
  const parts: string[] = [fm.title, fm.use_when, fm.description];

  if (fm.examples && fm.examples.length > 0) {
    parts.push(fm.examples.map((e) => e.intent).join("\n"));
  }

  if (fm.tags && fm.tags.length > 0) {
    parts.push(fm.tags.join(" "));
  }

  return parts.join(". ");
};

/**
 * Cosine similarity between two equal-length vectors. Range: [-1, 1].
 * Higher = more similar.
 */
export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
};
