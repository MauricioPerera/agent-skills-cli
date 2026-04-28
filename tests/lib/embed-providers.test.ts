// Tests for v0.6.0 multi-provider embedding support: Ollama, OpenAI, and the
// resolveEmbedderFromEnv() factory. Cloudflare provider tests live in
// embed.test.ts (kept stable since v0.2.0).

import { describe, expect, it } from "vitest";
import {
  createOllamaEmbedder,
  createOpenAIEmbedder,
  resolveEmbedderFromEnv,
} from "../../src/lib/embed.js";

// Tiny fetch-mock helper. Returns a fetch impl that records the last call and
// returns the configured Response.
const mockFetch = (handler: (url: string, init: RequestInit) => Response) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    const i = init ?? {};
    calls.push({ url: u, init: i });
    return handler(u, i);
  };
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
};

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// ────────────────────────────────────────────────────────────────────
// Ollama
// ────────────────────────────────────────────────────────────────────

describe("createOllamaEmbedder", () => {
  it("uses default baseUrl + model + auto-resolves dim from known list", async () => {
    const vec = new Array(768).fill(0).map((_, i) => i / 768);
    const { fetchFn, calls } = mockFetch(() => okJson({ embeddings: [vec] }));
    const e = createOllamaEmbedder({ fetchFn });

    expect(e.name).toBe("ollama:nomic-embed-text");
    expect(e.dim).toBe(768);

    const v = await e.embed("hello");
    expect(v).toEqual(vec);
    expect(calls[0]?.url).toBe("http://localhost:11434/api/embed");

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ model: "nomic-embed-text", input: "hello" });
  });

  it("respects custom baseUrl + strips trailing slashes", async () => {
    const vec = new Array(384).fill(0);
    const { fetchFn, calls } = mockFetch(() => okJson({ embeddings: [vec] }));
    const e = createOllamaEmbedder({
      baseUrl: "http://my-host:11434/",
      model: "all-minilm",
      fetchFn,
    });

    await e.embed("x");
    expect(calls[0]?.url).toBe("http://my-host:11434/api/embed");
    expect(e.name).toBe("ollama:all-minilm");
    expect(e.dim).toBe(384);
  });

  it("rejects unknown model unless dim is provided", () => {
    expect(() => createOllamaEmbedder({ model: "weird-new-model" })).toThrow(
      /unknown Ollama embedding model/i,
    );
  });

  it("accepts unknown model when dim is provided explicitly", async () => {
    const vec = new Array(512).fill(0);
    const { fetchFn } = mockFetch(() => okJson({ embeddings: [vec] }));
    const e = createOllamaEmbedder({ model: "weird-new-model", dim: 512, fetchFn });

    expect(e.name).toBe("ollama:weird-new-model");
    expect(e.dim).toBe(512);
    expect((await e.embed("x")).length).toBe(512);
  });

  it("throws CliError on connection failure with a helpful hint", async () => {
    const { fetchFn } = mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const e = createOllamaEmbedder({ fetchFn });
    await expect(e.embed("hi")).rejects.toThrow(/Ollama request failed.*localhost:11434.*ECONNREFUSED/i);
  });

  it("translates 404 'model not found' into a 'ollama pull' hint", async () => {
    const { fetchFn } = mockFetch(
      () =>
        new Response(JSON.stringify({ error: "model 'nomic-embed-text' not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const e = createOllamaEmbedder({ fetchFn });
    await expect(e.embed("hi")).rejects.toThrow(/ollama pull nomic-embed-text/i);
  });

  it("throws on dim mismatch with a hint to override OLLAMA_DIM", async () => {
    const { fetchFn } = mockFetch(() =>
      okJson({ embeddings: [new Array(512).fill(0)] }),
    );
    // Claim the model is 768-dim but server returns 512-dim.
    const e = createOllamaEmbedder({ fetchFn });
    await expect(e.embed("hi")).rejects.toThrow(/512-dim.*expected 768.*OLLAMA_DIM=512/);
  });

  it("rejects empty text", async () => {
    const e = createOllamaEmbedder();
    await expect(e.embed("")).rejects.toThrow(/empty text/);
  });
});

// ────────────────────────────────────────────────────────────────────
// OpenAI / OpenAI-compatible
// ────────────────────────────────────────────────────────────────────

describe("createOpenAIEmbedder", () => {
  it("uses default baseUrl + model + dim, sends Bearer auth", async () => {
    const vec = new Array(1536).fill(0).map((_, i) => i / 1536);
    const { fetchFn, calls } = mockFetch(() =>
      okJson({ data: [{ embedding: vec }] }),
    );
    const e = createOpenAIEmbedder({ apiKey: "sk-test", fetchFn });

    expect(e.name).toBe("openai:text-embedding-3-small");
    expect(e.dim).toBe(1536);

    const v = await e.embed("hello");
    expect(v).toEqual(vec);

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ model: "text-embedding-3-small", input: "hello" });
    // dim NOT sent because user didn't override
    expect(body.dimensions).toBeUndefined();
  });

  it("sends `dimensions` only when user overrides", async () => {
    const vec = new Array(512).fill(0);
    const { fetchFn, calls } = mockFetch(() =>
      okJson({ data: [{ embedding: vec }] }),
    );
    const e = createOpenAIEmbedder({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dim: 512, // explicit downsize
      fetchFn,
    });

    await e.embed("x");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.dimensions).toBe(512);
    expect(e.name).toBe("openai:text-embedding-3-small@512");
  });

  it("supports OpenAI-compatible base URLs (Together, vLLM, etc.)", async () => {
    const vec = new Array(384).fill(0);
    const { fetchFn, calls } = mockFetch(() =>
      okJson({ data: [{ embedding: vec }] }),
    );
    const e = createOpenAIEmbedder({
      apiKey: "k",
      baseUrl: "https://api.together.xyz/v1/",
      model: "togethercomputer/m2-bert-80M-2k-retrieval",
      dim: 384, // unknown model: dim required
      fetchFn,
    });

    await e.embed("hi");
    expect(calls[0]?.url).toBe("https://api.together.xyz/v1/embeddings");
  });

  it("rejects empty API key", () => {
    expect(() => createOpenAIEmbedder({ apiKey: "" })).toThrow(/API key is empty/);
  });

  it("rejects unknown model when no dim provided", () => {
    expect(() =>
      createOpenAIEmbedder({ apiKey: "k", model: "unknown" }),
    ).toThrow(/unknown OpenAI-compatible model/i);
  });

  it("propagates non-2xx as CliError without leaking the auth token", async () => {
    const { fetchFn } = mockFetch(
      () =>
        new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests",
        }),
    );
    const e = createOpenAIEmbedder({ apiKey: "sk-secret-do-not-leak", fetchFn });

    let err: Error | null = null;
    try {
      await e.embed("hi");
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/429/);
    expect(err!.message).toMatch(/rate limited/);
    expect(err!.message).not.toMatch(/sk-secret-do-not-leak/);
  });
});

// ────────────────────────────────────────────────────────────────────
// resolveEmbedderFromEnv()
// ────────────────────────────────────────────────────────────────────

describe("resolveEmbedderFromEnv", () => {
  it("explicit provider=cloudflare uses CF_* vars", () => {
    const e = resolveEmbedderFromEnv({
      provider: "cloudflare",
      env: {
        CF_ACCOUNT_ID: "0".repeat(32),
        CF_API_TOKEN: "tok",
        CF_EMBEDDING_MODEL: "@cf/baai/bge-large-en-v1.5",
      },
    });
    expect(e.name).toBe("cloudflare:@cf/baai/bge-large-en-v1.5");
    expect(e.dim).toBe(1024);
  });

  it("explicit provider=ollama uses OLLAMA_* vars (with sane defaults)", () => {
    const e = resolveEmbedderFromEnv({ provider: "ollama", env: {} });
    expect(e.name).toBe("ollama:nomic-embed-text");
    expect(e.dim).toBe(768);
  });

  it("explicit provider=openai requires OPENAI_API_KEY", () => {
    expect(() =>
      resolveEmbedderFromEnv({ provider: "openai", env: {} }),
    ).toThrow(/OPENAI_API_KEY/);

    const e = resolveEmbedderFromEnv({
      provider: "openai",
      env: { OPENAI_API_KEY: "sk-x", OPENAI_MODEL: "text-embedding-3-large" },
    });
    expect(e.name).toBe("openai:text-embedding-3-large");
    expect(e.dim).toBe(3072);
  });

  it("auto-detects: prefers Cloudflare when CF_* present", () => {
    const e = resolveEmbedderFromEnv({
      env: {
        CF_ACCOUNT_ID: "a".repeat(32),
        CF_API_TOKEN: "t",
        OPENAI_API_KEY: "sk-also-set", // present but lower priority
      },
    });
    expect(e.name.startsWith("cloudflare:")).toBe(true);
  });

  it("auto-detects: falls back to OpenAI when only OPENAI_API_KEY is set", () => {
    const e = resolveEmbedderFromEnv({ env: { OPENAI_API_KEY: "sk-x" } });
    expect(e.name.startsWith("openai:")).toBe(true);
  });

  it("auto-detects: falls back to Ollama when OLLAMA_* hints are set", () => {
    const e = resolveEmbedderFromEnv({ env: { OLLAMA_MODEL: "mxbai-embed-large" } });
    expect(e.name).toBe("ollama:mxbai-embed-large");
    expect(e.dim).toBe(1024);
  });

  it("explicit EMBEDDING_PROVIDER overrides auto-detect", () => {
    // CF vars present BUT EMBEDDING_PROVIDER=ollama → use Ollama
    const e = resolveEmbedderFromEnv({
      env: {
        EMBEDDING_PROVIDER: "ollama",
        CF_ACCOUNT_ID: "a".repeat(32),
        CF_API_TOKEN: "t",
      },
    });
    expect(e.name.startsWith("ollama:")).toBe(true);
  });

  it("throws helpful error when no provider configured", () => {
    expect(() => resolveEmbedderFromEnv({ env: {} })).toThrow(
      /no embedding provider configured/i,
    );
  });

  it("rejects invalid EMBEDDING_PROVIDER", () => {
    expect(() =>
      resolveEmbedderFromEnv({ env: { EMBEDDING_PROVIDER: "bogus" } }),
    ).toThrow(/unknown EMBEDDING_PROVIDER/i);
  });

  it("rejects malformed OLLAMA_DIM", () => {
    expect(() =>
      resolveEmbedderFromEnv({
        provider: "ollama",
        env: { OLLAMA_DIM: "not-a-number" },
      }),
    ).toThrow(/OLLAMA_DIM/);
  });

  it("rejects malformed OPENAI_DIM", () => {
    expect(() =>
      resolveEmbedderFromEnv({
        provider: "openai",
        env: { OPENAI_API_KEY: "sk", OPENAI_DIM: "-5" },
      }),
    ).toThrow(/OPENAI_DIM/);
  });
});
