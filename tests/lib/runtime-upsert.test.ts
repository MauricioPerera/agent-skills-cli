// Tests for `dbUpdate({ upsert: true })` semantics.
//
// Background: just-bash-data accepts a `--upsert` flag on `db update` but
// silently no-ops it (verified empirically — the flag parses, the doc never
// gets inserted). The wrapper at runtime.ts transparently does the right
// thing via count → insert | update so callers don't need to repeat the
// pattern (and so they can't accidentally rely on the broken flag).
//
// These tests pin the wrapper's contract end-to-end against a real bank
// runtime: missing-doc → insert with merged filter+$set fields, existing-doc
// → update, returned shape, the unsupported {upsert+many} guard.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBankBash,
  dbCount,
  dbFind,
  dbInsert,
  dbUpdate,
} from "../../src/lib/runtime.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-skills-upsert-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("dbUpdate — upsert semantics", () => {
  it("inserts when no document matches the filter", async () => {
    const bash = createBankBash({ bankDir: tmpDir });

    const result = await dbUpdate(
      bash,
      "things",
      { _id: "alpha" },
      { $set: { _id: "alpha", color: "red", count: 7 } },
      { upsert: true },
    );

    expect(result.modified).toBe(0);
    expect(result.upserted).toBe("alpha");

    const docs = await dbFind<{ _id: string; color: string; count: number }>(
      bash,
      "things",
      { _id: "alpha" },
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]?.color).toBe("red");
    expect(docs[0]?.count).toBe(7);
  });

  it("merges filter scalars with $set on the inserted doc, $set wins on conflict", async () => {
    const bash = createBankBash({ bankDir: tmpDir });

    await dbUpdate(
      bash,
      "things",
      { _id: "merge", category: "from-filter" },
      { $set: { extra: "from-set", category: "from-set-wins" } },
      { upsert: true },
    );

    const [doc] = await dbFind<{
      _id: string;
      category: string;
      extra: string;
    }>(bash, "things", { _id: "merge" });
    // _id from filter, extra from $set, category from $set (overrides filter).
    expect(doc?._id).toBe("merge");
    expect(doc?.extra).toBe("from-set");
    expect(doc?.category).toBe("from-set-wins");
  });

  it("inserts even when $set is absent (uses only filter scalars)", async () => {
    const bash = createBankBash({ bankDir: tmpDir });

    await dbUpdate(
      bash,
      "things",
      { _id: "no-set", flag: true, n: 42 },
      {},
      { upsert: true },
    );

    const [doc] = await dbFind<Record<string, unknown>>(
      bash,
      "things",
      { _id: "no-set" },
    );
    expect(doc).toEqual({ _id: "no-set", flag: true, n: 42 });
  });

  it("updates when a document matches and does NOT insert a duplicate", async () => {
    const bash = createBankBash({ bankDir: tmpDir });
    await dbInsert(bash, "things", { _id: "beta", color: "blue", count: 1 });

    const result = await dbUpdate(
      bash,
      "things",
      { _id: "beta" },
      { $set: { color: "green", count: 99 } },
      { upsert: true },
    );

    // upserted is undefined on the update path.
    expect(result.upserted).toBeUndefined();
    expect(await dbCount(bash, "things", {})).toBe(1);
    const [doc] = await dbFind<{ color: string; count: number }>(
      bash,
      "things",
      { _id: "beta" },
    );
    expect(doc?.color).toBe("green");
    expect(doc?.count).toBe(99);
  });

  it("auto-creates the collection on the first upsert (CollectionNotFound from dbCount → 0 → insert path)", async () => {
    const bash = createBankBash({ bankDir: tmpDir });
    // The collection has never been touched; dbCount returns 0 (sentinel
    // path), so the upsert falls into insert. dbInsert auto-creates.
    const result = await dbUpdate(
      bash,
      "fresh",
      { _id: "first" },
      { $set: { _id: "first", v: "x" } },
      { upsert: true },
    );
    expect(result.upserted).toBe("first");
    expect(await dbCount(bash, "fresh", {})).toBe(1);
  });

  it("rejects { upsert: true, many: true } with a clear error", async () => {
    const bash = createBankBash({ bankDir: tmpDir });
    await expect(
      dbUpdate(
        bash,
        "things",
        { _id: "x" },
        { $set: { v: 1 } },
        { upsert: true, many: true },
      ),
    ).rejects.toThrow(/not supported/);
  });

  it("ignores operator-shaped filter keys when seeding the upsert insert", async () => {
    const bash = createBankBash({ bankDir: tmpDir });

    // $or in the filter shouldn't pollute the inserted doc; only the scalar
    // _id should be seeded.
    await dbUpdate(
      bash,
      "ops",
      { _id: "scalar-only", $or: [{ x: 1 }, { y: 2 }] },
      { $set: { _id: "scalar-only", real: "field" } },
      { upsert: true },
    );

    const [doc] = await dbFind<Record<string, unknown>>(
      bash,
      "ops",
      { _id: "scalar-only" },
    );
    expect(doc?.["$or"]).toBeUndefined();
    expect(doc?.["real"]).toBe("field");
  });

  it("regular update (no upsert) on a missing match is a no-op (modified: 0), no insert", async () => {
    const bash = createBankBash({ bankDir: tmpDir });
    // Seed the collection so it exists (just-bash-data doesn't auto-create
    // on update without upsert).
    await dbInsert(bash, "things", { _id: "exists", v: 1 });

    const result = await dbUpdate(
      bash,
      "things",
      { _id: "absent" },
      { $set: { v: 99 } },
      // upsert NOT set
    );

    expect(result.modified).toBe(0);
    expect(result.upserted).toBeUndefined();
    expect(await dbCount(bash, "things", {})).toBe(1); // still just the seed
  });
});
