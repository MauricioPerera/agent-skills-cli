import { describe, expect, it } from "vitest";
import { checkApplicability, type HostContext } from "../../src/lib/applicable.js";

const host = (overrides: Partial<HostContext> = {}): HostContext => ({
  os: "linux",
  arch: "x86_64",
  envKeys: new Set(["HOME", "PATH"]),
  ...overrides,
});

describe("checkApplicability — undefined / empty", () => {
  it("undefined applicable_when always passes", () => {
    expect(checkApplicability(undefined, host())).toEqual({ applicable: true, reasons: [] });
  });

  it("empty constraints object passes", () => {
    expect(checkApplicability({}, host())).toEqual({ applicable: true, reasons: [] });
  });
});

describe("checkApplicability — os", () => {
  it("passes when host.os is in the list", () => {
    expect(checkApplicability({ os: ["linux", "macos"] }, host()).applicable).toBe(true);
  });

  it("fails when host.os is not in the list", () => {
    const r = checkApplicability({ os: ["macos", "windows"] }, host({ os: "linux" }));
    expect(r.applicable).toBe(false);
    expect(r.reasons[0]).toMatch(/os 'linux'/);
  });
});

describe("checkApplicability — arch", () => {
  it("passes for matching arch", () => {
    expect(checkApplicability({ arch: ["x86_64", "arm64"] }, host()).applicable).toBe(true);
  });

  it("fails for non-matching arch", () => {
    const r = checkApplicability({ arch: ["arm64"] }, host({ arch: "x86_64" }));
    expect(r.applicable).toBe(false);
  });
});

describe("checkApplicability — env_present (all-of)", () => {
  it("passes when all required env vars are set", () => {
    const h = host({ envKeys: new Set(["A", "B", "C"]) });
    expect(checkApplicability({ env_present: ["A", "B"] }, h).applicable).toBe(true);
  });

  it("fails if any required env var is missing", () => {
    const h = host({ envKeys: new Set(["A"]) });
    const r = checkApplicability({ env_present: ["A", "MISSING"] }, h);
    expect(r.applicable).toBe(false);
    expect(r.reasons[0]).toContain("MISSING");
  });
});

describe("checkApplicability — env_absent (none-of)", () => {
  it("passes when forbidden env vars are NOT set", () => {
    const h = host({ envKeys: new Set(["HOME"]) });
    expect(
      checkApplicability({ env_absent: ["DRY_RUN", "DEBUG"] }, h).applicable,
    ).toBe(true);
  });

  it("fails when a forbidden env var IS set", () => {
    const h = host({ envKeys: new Set(["DRY_RUN"]) });
    const r = checkApplicability({ env_absent: ["DRY_RUN"] }, h);
    expect(r.applicable).toBe(false);
    expect(r.reasons[0]).toContain("DRY_RUN");
  });
});

describe("checkApplicability — shell_commands_present", () => {
  it("passes when host has the required commands", () => {
    const h = host({ shellCommandsAvailable: new Set(["jq", "curl"]) });
    expect(
      checkApplicability({ shell_commands_present: ["jq", "curl"] }, h).applicable,
    ).toBe(true);
  });

  it("fails when a required command is missing", () => {
    const h = host({ shellCommandsAvailable: new Set(["jq"]) });
    const r = checkApplicability({ shell_commands_present: ["jq", "rg"] }, h);
    expect(r.applicable).toBe(false);
    expect(r.reasons[0]).toContain("rg");
  });

  it("skips command checks when host.shellCommandsAvailable is undefined", () => {
    // No shellCommandsAvailable set → command checks are not enforced.
    // This lets banks defer the (potentially expensive) `command -v` checks.
    const h = host(); // undefined shellCommandsAvailable
    expect(
      checkApplicability({ shell_commands_present: ["nonexistent"] }, h).applicable,
    ).toBe(true);
  });
});

describe("checkApplicability — multi-constraint conjunction", () => {
  it("all constraints must pass; reports all failures", () => {
    const h = host({
      os: "linux",
      envKeys: new Set([]),
    });
    const r = checkApplicability(
      {
        os: ["macos"],            // fails
        env_present: ["TOKEN"],   // fails
      },
      h,
    );
    expect(r.applicable).toBe(false);
    expect(r.reasons.length).toBe(2);
  });

  it("passes when every constraint is satisfied", () => {
    const h = host({
      os: "linux",
      arch: "x86_64",
      envKeys: new Set(["STRIPE_KEY"]),
      shellCommandsAvailable: new Set(["curl"]),
    });
    expect(
      checkApplicability(
        {
          os: ["linux"],
          arch: ["x86_64"],
          env_present: ["STRIPE_KEY"],
          shell_commands_present: ["curl"],
        },
        h,
      ).applicable,
    ).toBe(true);
  });
});

// v0.6.1: detectAvailableCommands no longer spawns a shell.
describe("detectAvailableCommands (v0.6.1+ — pure-Node PATH scan)", () => {
  // Deferred imports because the module caches available-command results
  // across tests; we _resetHostCache between subtests via a fresh import
  // would be even cleaner, but module-level caches persist.

  it("rejects names containing path or shell metacharacters without filesystem access", async () => {
    const { detectAvailableCommands, _resetHostCache } = await import(
      "../../src/lib/applicable.js"
    );
    _resetHostCache();
    const result = detectAvailableCommands([
      "; rm -rf /",
      "$(whoami)",
      "../../../etc/passwd",
      "foo bar",
      "ls|cat",
    ]);
    expect(result.size).toBe(0);
  });

  it("accepts a real binary that exists on PATH (uses node itself, present in any test env)", async () => {
    const { detectAvailableCommands, _resetHostCache } = await import(
      "../../src/lib/applicable.js"
    );
    _resetHostCache();
    // `node` MUST be on PATH — vitest runs under node, so this is a safe oracle.
    const result = detectAvailableCommands(["node"]);
    expect(result.has("node")).toBe(true);
  });

  it("returns empty set for a non-existent binary", async () => {
    const { detectAvailableCommands, _resetHostCache } = await import(
      "../../src/lib/applicable.js"
    );
    _resetHostCache();
    const result = detectAvailableCommands(["definitely-not-a-real-binary-xyzzy-9999"]);
    expect(result.size).toBe(0);
  });

  it("caches results across calls (idempotent for the process lifetime)", async () => {
    const { detectAvailableCommands, _resetHostCache } = await import(
      "../../src/lib/applicable.js"
    );
    _resetHostCache();
    const a = detectAvailableCommands(["node"]);
    const b = detectAvailableCommands(["node"]);
    // Same membership; underlying cache hit on the second call.
    expect(a.has("node")).toBe(b.has("node"));
  });
});
