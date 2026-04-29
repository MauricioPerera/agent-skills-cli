// Tests for the vec helpers' collection-not-found semantics.
//
// The bank uses `vec` for cosine similarity over skill embeddings (SPEC §4.3).
// Real-world hot path: a freshly-created bank has no `skills` vec collection
// until the first upsert lands. Read paths (`vecSearch`) MUST tolerate that
// empty state and return [] — not throw "not found: skills" all the way up
// to the user.
//
// Internally we use a `CollectionNotFound` sentinel raised by `runVec` (and
// `runDb`, in parity). These tests pin the contract end-to-end against a
// real just-bash + just-bash-data runtime: spin up a bank Bash, exercise
// each helper against an empty store, and assert the documented behaviour.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBankBash,
  vecCreate,
  vecRemove,
  vecSearch,
  vecStore,
} from "../../src/lib/runtime.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-skills-vec-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("vec helpers — collection-not-found parity with db helpers", () => {
  it("vecSearch returns [] on a missing collection (parity with dbFind returning [])", async () => {
    const bash = createBankBash({ bankDir: tmpDir });
    // No `vec create`. The collection genuinely doesn't exist.
    const hits = await vecSearch(bash, "never-created", [1, 0, 0], 5);
    expect(hits).toEqual([]);
  });

  it("vecRemove returns false on a missing collection (parity with dbRemove returning {removed:0})", async () => {
    const bash = createBankBash({ bankDir: tmpDir });
    const removed = await vecRemove(bash, "never-created", "some-id");
    expect(removed).toBe(false);
  });

  it("vecRemove returns false when the id is absent inside an existing collection", async () => {
    const bash = createBankBash({ bankDir: tmpDir });
    await vecCreate(bash, "my-coll", 3);
    // Collection exists, id does not.
    const removed = await vecRemove(bash, "my-coll", "nonexistent-id");
    expect(removed).toBe(false);
  });

  it("vecStore auto-creates a missing collection at the first vector's dim and succeeds", async () => {
    const bash = createBankBash({ bankDir: tmpDir });
    // Collection does NOT exist yet. Store should create it (dim = 4 from
    // the vector) and persist the entry. Subsequent search must find it.
    await vecStore(bash, "auto-bootstrap", "id-1", [1, 0, 0, 0]);

    const hits = await vecSearch(bash, "auto-bootstrap", [1, 0, 0, 0], 5);
    expect(hits.length).toBe(1);
    expect(hits[0]?.id).toBe("id-1");
    // Cosine similarity of identical unit vectors is 1.
    expect(hits[0]?.score).toBeGreaterThan(0.99);
  });

  it("end-to-end: search empty → store → search returns the new entry", async () => {
    const bash = createBankBash({ bankDir: tmpDir });

    // 1. Empty bank: search the (not-yet-existing) collection.
    const empty = await vecSearch(bash, "skills", [1, 0, 0], 5);
    expect(empty).toEqual([]);

    // 2. Store: should auto-create.
    await vecStore(bash, "skills", "alpha", [1, 0, 0]);

    // 3. Search: should hit.
    const hits = await vecSearch(bash, "skills", [1, 0, 0], 5);
    expect(hits.length).toBe(1);
    expect(hits[0]?.id).toBe("alpha");

    // 4. Remove: should succeed.
    const removed = await vecRemove(bash, "skills", "alpha");
    expect(removed).toBe(true);

    // 5. Search again: empty (collection still exists, but no vectors).
    const after = await vecSearch(bash, "skills", [1, 0, 0], 5);
    expect(after).toEqual([]);
  });
});
