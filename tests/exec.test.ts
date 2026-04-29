// Tests for the exec command. Uses real bash subprocesses (no mocking) but
// against trivial commands like `echo` and `bash -c "exit N"` so the tests
// stay fast + cross-platform-relevant (skipped on Windows where bash is
// optional). Audit log persistence verified by inspecting the JSONL file.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBank, type IndexedSkill } from "../src/lib/bank.js";
import { runExec } from "../src/commands/exec.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-skills-exec-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const stubVec = (dim = 32): number[] =>
  Array.from({ length: dim }, () => 1 / Math.sqrt(dim));

const buildSkill = (overrides: Partial<IndexedSkill> = {}): IndexedSkill => ({
  identity: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo-skill",
  schema_version: "0.1",
  id: "echo-skill",
  version: "1.0.0",
  title: "Echo a message",
  description: "Echoes the given message to stdout",
  use_when: "you need to print a string",
  command_template: "echo {msg}",
  args: { msg: { type: "string" } },
  provenance: {
    source_type: "git",
    source: "github.com/test/pack",
    ref_resolved_to: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    fetched_at: "2026-04-28T00:00:00Z",
    signature_status: "unsigned",
  },
  embedding: stubVec(),
  embedding_model: "stub:fnv1a-32",
  inserted_at: "2026-04-28T00:00:00Z",
  updated_at: "2026-04-28T00:00:00Z",
  ...overrides,
});

describe("runExec — happy path", () => {
  it("executes a simple echo skill and captures stdout", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill());
    const result = await runExec({
      bank,
      skillIdentifier: "echo-skill",
      args: { msg: "hello world" },
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("");
    expect(result.timed_out).toBe(false);
    expect(result.dry_run).toBe(false);
    expect(result.command).toBe("echo 'hello world'");
  });

  it("captures stderr from a failing skill", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(
      buildSkill({
        identity: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/fail",
        id: "fail",
        command_template: "echo {msg} >&2; exit {code}",
        args: {
          msg: { type: "string" },
          code: { type: "integer", range: [0, 255] },
        },
      }),
    );
    const result = await runExec({
      bank,
      skillIdentifier: "fail",
      args: { msg: "boom", code: 7 },
    });
    expect(result.exit_code).toBe(7);
    expect(result.stderr).toBe("boom\n");
    expect(result.stdout).toBe("");
  });

  it("respects timeout and reports timed_out", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(
      buildSkill({
        identity: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/slow",
        id: "slow",
        command_template: "sleep {seconds}; echo done",
        args: { seconds: { type: "integer", range: [1, 60] } },
      }),
    );
    const result = await runExec({
      bank,
      skillIdentifier: "slow",
      args: { seconds: 10 },
      timeoutSec: 1,
    });
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).not.toBe(0);
    expect(result.elapsed_ms).toBeLessThan(7000);
  }, 10_000); // sleep 10 + SIGTERM at 1s + SIGKILL grace at 6s; vitest needs ≥7s
});

describe("runExec — dry-run", () => {
  it("does NOT execute when dryRun is true", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(
      buildSkill({
        // Even an `exit 1` should NOT run in dry-run.
        command_template: "exit 1",
        args: {},
      }),
    );
    const result = await runExec({
      bank,
      skillIdentifier: "echo-skill",
      args: {},
      dryRun: true,
    });
    expect(result.dry_run).toBe(true);
    expect(result.exit_code).toBe(0); // dry-run reports 0
    expect(result.command).toBe("exit 1");
    expect(result.stdout).toBe("");
  });

  it("dry-run does NOT append an audit entry", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill());
    await runExec({
      bank,
      skillIdentifier: "echo-skill",
      args: { msg: "x" },
      dryRun: true,
    });
    const entries = await bank.listAudit();
    expect(entries).toHaveLength(0);
  });
});

describe("runExec — identity resolution", () => {
  it("resolves a skill by full identity", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    const skill = buildSkill();
    await bank.upsertSkill(skill);
    const result = await runExec({
      bank,
      skillIdentifier: skill.identity,
      args: { msg: "ok" },
    });
    expect(result.skill_identity).toBe(skill.identity);
  });

  it("resolves a skill by short id when unique", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill());
    const result = await runExec({
      bank,
      skillIdentifier: "echo-skill",
      args: { msg: "ok" },
    });
    expect(result.exit_code).toBe(0);
  });

  it("rejects when short id is ambiguous", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill({
      identity: "github.com/a/p@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo-skill",
    }));
    await bank.upsertSkill(buildSkill({
      identity: "github.com/b/p@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo-skill",
    }));
    await expect(
      runExec({ bank, skillIdentifier: "echo-skill", args: { msg: "x" } }),
    ).rejects.toThrow(/ambiguous/);
  });

  it("rejects when no skill matches", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await expect(
      runExec({ bank, skillIdentifier: "nonexistent", args: {} }),
    ).rejects.toThrow(/no skill found/);
  });
});

describe("runExec — audit log persistence", () => {
  it("appends one JSONL entry per exec by default", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill());
    await runExec({
      bank,
      skillIdentifier: "echo-skill",
      args: { msg: "first" },
    });
    await runExec({
      bank,
      skillIdentifier: "echo-skill",
      args: { msg: "second" },
    });

    // Audit storage migrated to `db skill_audit` (commit 3c7d412+);
    // the legacy audit.jsonl path is no longer written. Assert via the
    // bank's listAudit() public API, which is the contract callers see.
    const entries = await bank.listAudit();
    expect(entries).toHaveLength(2);
    // listAudit returns newest-first, so the second exec is index 0.
    expect(entries[0]?.args).toEqual({ msg: "second" });
    expect(entries[1]?.args).toEqual({ msg: "first" });
  });

  it("listAudit returns entries newest-first with stdout/stderr byte counts", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill());
    await runExec({ bank, skillIdentifier: "echo-skill", args: { msg: "alpha" } });
    await new Promise((r) => setTimeout(r, 10));
    await runExec({ bank, skillIdentifier: "echo-skill", args: { msg: "beta" } });

    const entries = await bank.listAudit({ limit: 10 });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.args).toEqual({ msg: "beta" }); // newest first
    expect(entries[1]?.args).toEqual({ msg: "alpha" });
    expect(entries[0]?.exit_code).toBe(0);
    expect(entries[0]?.stdout_bytes).toBe(5); // "beta\n"
  });

  it("--no-audit skips the entry", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill());
    await runExec({
      bank,
      skillIdentifier: "echo-skill",
      args: { msg: "x" },
      noAudit: true,
    });
    expect(await bank.listAudit()).toHaveLength(0);
  });

  it("redacts sensitive args in the audit entry", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(
      buildSkill({
        command_template: "echo {public}",
        args: {
          public: { type: "string" },
          secret: { type: "string", sensitive: true, default: "shh" },
        },
      }),
    );
    await runExec({
      bank,
      skillIdentifier: "echo-skill",
      args: { public: "hello", secret: "p@ssw0rd-DO-NOT-LOG" },
    });

    const entries = await bank.listAudit();
    expect(entries[0]?.args.public).toBe("hello");
    expect(entries[0]?.args.secret).toBe("<redacted>");

    // Verify the secret never reaches persisted audit storage. Audit
    // backed by `db skill_audit` (commit 3c7d412+); query the entries
    // and serialize to confirm the secret string never appears.
    const allEntries = await bank.listAudit();
    expect(JSON.stringify(allEntries)).not.toContain("p@ssw0rd-DO-NOT-LOG");
  });

  it("records the optional intent field when provided", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill());
    await runExec({
      bank,
      skillIdentifier: "echo-skill",
      args: { msg: "x" },
      intent: "user wants to print a thing",
    });
    const entries = await bank.listAudit();
    expect(entries[0]?.intent).toBe("user wants to print a thing");
  });

  it("listAudit can filter by skill_id", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill({
      identity: "github.com/x/p@a1b2c3d4e5f67890abcdef1234567890abcdef12/skill-a",
      id: "skill-a",
    }));
    await bank.upsertSkill(buildSkill({
      identity: "github.com/x/p@a1b2c3d4e5f67890abcdef1234567890abcdef12/skill-b",
      id: "skill-b",
    }));
    await runExec({ bank, skillIdentifier: "skill-a", args: { msg: "a1" } });
    await runExec({ bank, skillIdentifier: "skill-b", args: { msg: "b1" } });
    await runExec({ bank, skillIdentifier: "skill-a", args: { msg: "a2" } });

    const aOnly = await bank.listAudit({
      skill_id: "github.com/x/p@a1b2c3d4e5f67890abcdef1234567890abcdef12/skill-a",
    });
    expect(aOnly).toHaveLength(2);
    expect(aOnly.every((e) => e.skill_id.endsWith("/skill-a"))).toBe(true);
  });
});

describe("runExec — re-validation safety net", () => {
  it("rejects a stale skill in the bank with non-conformant frontmatter", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    await bank.upsertSkill(buildSkill({
      // Manually insert a non-conformant skill (simulating bank corruption / drift)
      command_template: 'echo "amount={msg}"', // placeholder inside literal quotes
    }));
    await expect(
      runExec({ bank, skillIdentifier: "echo-skill", args: { msg: "x" } }),
    ).rejects.toThrow(/literal quote/);
  });

  // Regression: exec re-validates the skill against the SKILL.md JSON Schema,
  // which has `additionalProperties: false` at the root. Bank-managed fields
  // (identity, provenance, embedding, …, command_source) live on IndexedSkill
  // but NOT on the schema, so exec must strip them before validation. Missing
  // any one of them in `extractFrontmatter` causes exec to fail with a
  // misleading "additional property" error for any skill that has that field
  // populated. `command_source` (v2.1.0+) was the most recently-added bank
  // field; this test pins the strip behaviour for it.
  it("does not reject a skill that has command_source set (v2.1.0+ pack-distributed CustomCommand)", async () => {
    const bank = new FileBank({ rootDir: tmpDir });
    // A pack-distributed CustomCommand: minimal valid factory that registers
    // an `mycmd` command echoing its first arg. Run via command_template.
    const customCommandJs = `
      export default ({ defineCommand }) =>
        defineCommand("mycmd", async (args) => ({
          stdout: (args[0] ?? "") + "\\n",
          stderr: "",
          exitCode: 0,
        }));
    `;
    await bank.upsertSkill(buildSkill({
      identity: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/with-cmd",
      id: "with-cmd",
      command_template: "mycmd {msg}",
      args: { msg: { type: "string" } },
      command_source: customCommandJs,
    }));

    const result = await runExec({
      bank,
      skillIdentifier: "with-cmd",
      args: { msg: "hello-from-pack-cmd" },
    });

    // The exec must succeed: re-validation accepted the stripped frontmatter,
    // the loader installed the pack's `mycmd`, and just-bash dispatched to it.
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hello-from-pack-cmd\n");
    expect(result.stderr).toBe("");
  });
});
