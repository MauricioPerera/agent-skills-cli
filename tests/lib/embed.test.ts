import { describe, expect, it } from "vitest";
import {
  composeEmbeddingText,
  cosineSimilarity,
  createCloudflareEmbedder,
  createStubEmbedder,
} from "../../src/lib/embed.js";

describe("createStubEmbedder", () => {
  it("produces deterministic same-text-same-vector embeddings", async () => {
    const e = createStubEmbedder(32);
    const v1 = await e.embed("hello world");
    const v2 = await e.embed("hello world");
    expect(v1).toEqual(v2);
  });

  it("different texts produce different vectors", async () => {
    const e = createStubEmbedder(32);
    const v1 = await e.embed("hello world");
    const v2 = await e.embed("goodbye world");
    expect(v1).not.toEqual(v2);
  });

  it("output dim matches configured dim", async () => {
    const e = createStubEmbedder(64);
    const v = await e.embed("test");
    expect(v.length).toBe(64);
    expect(e.dim).toBe(64);
  });

  it("vectors are L2-normalized (unit length)", async () => {
    const e = createStubEmbedder(32);
    const v = await e.embed("hello world");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe("cosineSimilarity", () => {
  it("identical vectors = 1.0", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("orthogonal vectors = 0.0", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
  });

  it("opposite vectors = -1.0", () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0);
  });

  it("zero vector returns 0", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });

  it("throws on dim mismatch", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/dim mismatch/);
  });
});

describe("composeEmbeddingText", () => {
  it("concatenates required fields with '. ' separator", () => {
    const text = composeEmbeddingText({
      title: "Foo",
      use_when: "you need foo",
      description: "Foos things.",
    });
    expect(text).toBe("Foo. you need foo. Foos things.");
  });

  it("appends examples joined by newlines", () => {
    const text = composeEmbeddingText({
      title: "T",
      use_when: "U",
      description: "D",
      examples: [
        { intent: "first intent" },
        { intent: "second intent" },
      ],
    });
    expect(text).toContain("first intent\nsecond intent");
  });

  it("appends tags joined by space", () => {
    const text = composeEmbeddingText({
      title: "T",
      use_when: "U",
      description: "D",
      tags: ["one", "two", "three"],
    });
    expect(text.endsWith("one two three")).toBe(true);
  });

  it("omits empty tags array", () => {
    const text = composeEmbeddingText({
      title: "T",
      use_when: "U",
      description: "D",
      tags: [],
    });
    expect(text).toBe("T. U. D");
  });
});

describe("createCloudflareEmbedder — config validation", () => {
  it("rejects non-hex account ID", () => {
    expect(() =>
      createCloudflareEmbedder({
        accountId: "not-hex",
        apiToken: "tok",
      }),
    ).toThrow(/account ID/);
  });

  it("rejects empty token", () => {
    expect(() =>
      createCloudflareEmbedder({
        accountId: "a".repeat(32),
        apiToken: "",
      }),
    ).toThrow(/empty/);
  });

  it("rejects unknown model", () => {
    expect(() =>
      createCloudflareEmbedder({
        accountId: "a".repeat(32),
        apiToken: "tok",
        model: "@cf/unknown/model",
      }),
    ).toThrow(/unknown/i);
  });

  it("accepts known model + valid auth", () => {
    expect(() =>
      createCloudflareEmbedder({
        accountId: "a".repeat(32),
        apiToken: "tok",
        model: "@cf/baai/bge-base-en-v1.5",
      }),
    ).not.toThrow();
  });

  it("default model is bge-base-en-v1.5 (768-dim)", () => {
    const e = createCloudflareEmbedder({
      accountId: "a".repeat(32),
      apiToken: "tok",
    });
    expect(e.name).toBe("cloudflare:@cf/baai/bge-base-en-v1.5");
    expect(e.dim).toBe(768);
  });
});

describe("createCloudflareEmbedder — fetch behavior (mocked)", () => {
  it("sends correct request body + headers", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = url.toString();
      capturedInit = init;
      // Return a fake 768-dim vector
      const data = new Array(768).fill(0).map((_, i) => i / 768);
      return new Response(
        JSON.stringify({ result: { data: [data], shape: [1, 768] }, success: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const e = createCloudflareEmbedder({
      accountId: "a".repeat(32),
      apiToken: "secret-token",
      fetchFn: fakeFetch,
    });
    const vec = await e.embed("hello");
    expect(vec.length).toBe(768);
    expect(capturedUrl).toContain("/accounts/" + "a".repeat(32) + "/ai/run/@cf/baai/bge-base-en-v1.5");
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-token");
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ text: "hello" });
  });

  it("throws CliError on non-2xx without exposing the token", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response("nope", { status: 401, statusText: "Unauthorized" });
    };
    const e = createCloudflareEmbedder({
      accountId: "a".repeat(32),
      apiToken: "secret-token-xxx-DO-NOT-LEAK",
      fetchFn: fakeFetch,
    });
    let err: unknown;
    try {
      await e.embed("test");
    } catch (e) {
      err = e;
    }
    const msg = (err as Error).message;
    expect(msg).toContain("401");
    expect(msg).not.toContain("secret-token-xxx-DO-NOT-LEAK");
  });

  it("throws on dim mismatch in response", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ result: { data: [[1, 2, 3]], shape: [1, 3] }, success: true }),
        { status: 200 },
      );
    };
    const e = createCloudflareEmbedder({
      accountId: "a".repeat(32),
      apiToken: "tok",
      fetchFn: fakeFetch,
    });
    await expect(e.embed("test")).rejects.toThrow(/3-dim vector; expected 768/);
  });

  it("rejects empty input text", async () => {
    const e = createCloudflareEmbedder({
      accountId: "a".repeat(32),
      apiToken: "tok",
    });
    await expect(e.embed("")).rejects.toThrow(/empty/);
  });
});
