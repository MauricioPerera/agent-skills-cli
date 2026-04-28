// Tests for the CLI's pure-function arg parser. Every other src file has a
// matching test file; cli.ts (the binary entrypoint) does not because it
// invokes main() at module load. The pure parsing logic was extracted to
// src/lib/cli-args.ts specifically so it CAN be tested directly without
// triggering process.exit() or sub-command dispatch.

import { describe, expect, it } from "vitest";
import { parseArgv, parseRerankMode, parseTenantFlag } from "../../src/lib/cli-args.js";
import { CliError, EXIT } from "../../src/lib/errors.js";

// ────────────────────────────────────────────────────────────────────
// parseArgv
// ────────────────────────────────────────────────────────────────────

describe("parseArgv — positional handling", () => {
  it("returns empty arrays for empty argv", () => {
    const r = parseArgv([]);
    expect(r.positional).toEqual([]);
    expect(r.flags.size).toBe(0);
  });

  it("preserves positional order", () => {
    const r = parseArgv(["validate", "skills/foo/SKILL.md"]);
    expect(r.positional).toEqual(["validate", "skills/foo/SKILL.md"]);
  });

  it("treats arguments not starting with -- as positional, even with dashes inside", () => {
    const r = parseArgv(["sync", "github.com/me/pack@v1.0.0"]);
    expect(r.positional).toEqual(["sync", "github.com/me/pack@v1.0.0"]);
  });

  it("a single dash is positional, only `--` indicates a flag", () => {
    const r = parseArgv(["query", "-not-a-flag"]);
    expect(r.positional).toEqual(["query", "-not-a-flag"]);
    expect(r.flags.size).toBe(0);
  });
});

describe("parseArgv — flag forms", () => {
  it("--key=value sets the flag to a string", () => {
    const r = parseArgv(["query", "--k=5"]);
    expect(r.flags.get("k")).toBe("5");
    expect(r.positional).toEqual(["query"]);
  });

  it("--key value sets the flag to a string when the next token isn't a flag", () => {
    const r = parseArgv(["query", "--k", "5"]);
    expect(r.flags.get("k")).toBe("5");
    expect(r.positional).toEqual(["query"]);
  });

  it("--key (eof) sets the flag to literal true", () => {
    const r = parseArgv(["query", "--no-rerank"]);
    expect(r.flags.get("no-rerank")).toBe(true);
  });

  it("--key followed by another --flag treats the first as boolean", () => {
    const r = parseArgv(["query", "--no-rerank", "--json"]);
    expect(r.flags.get("no-rerank")).toBe(true);
    expect(r.flags.get("json")).toBe(true);
  });

  it("supports key with hyphens (--rerank-mode)", () => {
    const r = parseArgv(["query", "--rerank-mode", "global"]);
    expect(r.flags.get("rerank-mode")).toBe("global");
  });

  it("--key=value preserves the literal value even when value contains '='", () => {
    const r = parseArgv(["resolve", "--args=key=value"]);
    expect(r.flags.get("args")).toBe("key=value");
  });

  it("--key=value preserves an empty value", () => {
    const r = parseArgv(["x", "--empty="]);
    expect(r.flags.get("empty")).toBe("");
  });

  it("later flag values override earlier ones (last wins)", () => {
    const r = parseArgv(["x", "--k=3", "--k=5"]);
    expect(r.flags.get("k")).toBe("5");
  });

  it("late --key=value overrides earlier boolean for the same key", () => {
    const r = parseArgv(["x", "--verbose", "--verbose=on"]);
    expect(r.flags.get("verbose")).toBe("on");
  });
});

describe("parseArgv — flag/positional interleaving (greedy-flag semantics)", () => {
  // The parser is eagerly value-consuming: `--key X` always pairs them when
  // X doesn't start with `--`. This means a boolean-style flag placed
  // BEFORE a positional swallows the positional as its value. This is a
  // known limitation; the CLI's convention is "positional first, then
  // flags" — these tests pin the behaviour so future refactors don't
  // silently change it.

  it("known limitation: --boolean-flag BEFORE positional swallows the positional", () => {
    // `--json validate skills/x/SKILL.md` looks like the user wants
    // boolean --json + cmd "validate" + path positional. The parser
    // cannot tell --json is intended boolean, so it eagerly consumes
    // "validate" as the flag's value.
    const r = parseArgv(["--json", "validate", "skills/x/SKILL.md"]);
    expect(r.flags.get("json")).toBe("validate");        // ← eager consumption
    expect(r.positional).toEqual(["skills/x/SKILL.md"]);  // ← only one positional left
  });

  it("workaround for the limitation: use --boolean=true OR put the flag last", () => {
    // Both of these unambiguously give the user what they want:
    const a = parseArgv(["--json=true", "validate", "skills/x/SKILL.md"]);
    expect(a.flags.get("json")).toBe("true");
    expect(a.positional).toEqual(["validate", "skills/x/SKILL.md"]);

    const b = parseArgv(["validate", "skills/x/SKILL.md", "--json"]);
    expect(b.flags.get("json")).toBe(true);
    expect(b.positional).toEqual(["validate", "skills/x/SKILL.md"]);
  });

  it("flag after positional works as expected (canonical form)", () => {
    const r = parseArgv(["validate", "skills/x/SKILL.md", "--json"]);
    expect(r.flags.get("json")).toBe(true);
    expect(r.positional).toEqual(["validate", "skills/x/SKILL.md"]);
  });

  it("positional value-after-flag is consumed by the flag, not added to positional", () => {
    // The contract: `--key value` always pairs them. So if you have
    // `cmd --rerank-mode global pos`, `pos` is positional but `global`
    // is the flag's value. This is the *intended* shape for value-flags;
    // the limitation only bites for boolean-only flags.
    const r = parseArgv(["cmd", "--rerank-mode", "global", "pos"]);
    expect(r.flags.get("rerank-mode")).toBe("global");
    expect(r.positional).toEqual(["cmd", "pos"]);
  });

  it("realistic full command line: agent-skills bench truth.jsonl --rerank-mode global --json", () => {
    const r = parseArgv(["bench", "truth.jsonl", "--rerank-mode", "global", "--json"]);
    expect(r.positional).toEqual(["bench", "truth.jsonl"]);
    expect(r.flags.get("rerank-mode")).toBe("global");
    expect(r.flags.get("json")).toBe(true);
  });

  it("realistic init invocation: agent-skills init demo --pack --author 'Alice'", () => {
    const r = parseArgv(["init", "demo", "--pack", "--author", "Alice"]);
    expect(r.positional).toEqual(["init", "demo"]);
    expect(r.flags.get("pack")).toBe(true);
    expect(r.flags.get("author")).toBe("Alice");
  });
});

// ────────────────────────────────────────────────────────────────────
// parseRerankMode
// ────────────────────────────────────────────────────────────────────

const argvOf = (...flags: Array<[string, string | boolean]>) => ({
  positional: [],
  flags: new Map<string, string | boolean>(flags),
});

describe("parseRerankMode — happy paths", () => {
  it("default is intent-conditional when neither flag is set", () => {
    expect(parseRerankMode(argvOf())).toBe("intent-conditional");
  });

  it("--rerank-mode=intent-conditional", () => {
    expect(parseRerankMode(argvOf(["rerank-mode", "intent-conditional"]))).toBe("intent-conditional");
  });

  it("--rerank-mode=global", () => {
    expect(parseRerankMode(argvOf(["rerank-mode", "global"]))).toBe("global");
  });

  it("--rerank-mode=none", () => {
    expect(parseRerankMode(argvOf(["rerank-mode", "none"]))).toBe("none");
  });
});

describe("parseRerankMode — --no-rerank precedence", () => {
  it("--no-rerank alone selects 'none'", () => {
    expect(parseRerankMode(argvOf(["no-rerank", true]))).toBe("none");
  });

  it("--no-rerank wins over --rerank-mode=global", () => {
    expect(
      parseRerankMode(argvOf(["rerank-mode", "global"], ["no-rerank", true])),
    ).toBe("none");
  });

  it("--no-rerank wins over --rerank-mode=intent-conditional", () => {
    expect(
      parseRerankMode(
        argvOf(["rerank-mode", "intent-conditional"], ["no-rerank", true]),
      ),
    ).toBe("none");
  });

  it("--no-rerank=false (string 'false', not the boolean) is NOT treated as opt-out", () => {
    // Only the literal boolean `true` triggers --no-rerank semantics — a
    // user accidentally writing `--no-rerank=false` should NOT silently
    // override an explicit --rerank-mode setting.
    expect(
      parseRerankMode(
        argvOf(["rerank-mode", "global"], ["no-rerank", "false"]),
      ),
    ).toBe("global");
  });
});

describe("parseRerankMode — error path", () => {
  it("throws CliError(USAGE) on unknown rerank-mode value", () => {
    let err: unknown = null;
    try {
      parseRerankMode(argvOf(["rerank-mode", "fancy-mode"]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    expect((err as CliError).message).toMatch(
      /must be one of: intent-conditional \| global \| none/,
    );
  });

  it("throws on empty string rerank-mode", () => {
    expect(() => parseRerankMode(argvOf(["rerank-mode", ""]))).toThrow(
      /must be one of/,
    );
  });

  it("throws on case-mismatched value (modes are exact-match, not lowercased)", () => {
    expect(() => parseRerankMode(argvOf(["rerank-mode", "Global"]))).toThrow(
      /must be one of/,
    );
  });

  it("when --rerank-mode is a boolean (e.g., user wrote `--rerank-mode` with no value), default applies", () => {
    // A bare `--rerank-mode` followed by another flag becomes `boolean true`
    // in parseArgv. parseRerankMode treats only string values as a mode
    // selection, so this falls through to the default. The user gets the
    // default behaviour, not an error — debatable, but consistent with how
    // boolean-vs-string flags work elsewhere in the CLI.
    expect(parseRerankMode(argvOf(["rerank-mode", true]))).toBe("intent-conditional");
  });
});

// ────────────────────────────────────────────────────────────────────
// parseTenantFlag (v0.12.0+, SPEC §4.5.1)
// ────────────────────────────────────────────────────────────────────

describe("parseTenantFlag — happy paths", () => {
  it("returns undefined when --tenant is absent", () => {
    expect(parseTenantFlag(argvOf())).toBeUndefined();
  });

  it("accepts a normal alphanumeric tenant", () => {
    expect(parseTenantFlag(argvOf(["tenant", "alice"]))).toBe("alice");
  });

  it("accepts dots, dashes, and underscores", () => {
    expect(parseTenantFlag(argvOf(["tenant", "team-1.alpha_v2"]))).toBe("team-1.alpha_v2");
  });

  it("accepts a 64-char tenant (boundary)", () => {
    const id = "a".repeat(64);
    expect(parseTenantFlag(argvOf(["tenant", id]))).toBe(id);
  });

  it("accepts a single-char tenant", () => {
    expect(parseTenantFlag(argvOf(["tenant", "a"]))).toBe("a");
  });
});

describe("parseTenantFlag — rejects bad input", () => {
  it("rejects bare --tenant (boolean form, no value)", () => {
    expect(() => parseTenantFlag(argvOf(["tenant", true]))).toThrow(
      /requires a non-empty string value/,
    );
  });

  it("rejects empty string --tenant=", () => {
    expect(() => parseTenantFlag(argvOf(["tenant", ""]))).toThrow(
      /requires a non-empty string value/,
    );
  });

  it("rejects 65-char tenant (over the boundary)", () => {
    expect(() => parseTenantFlag(argvOf(["tenant", "a".repeat(65)]))).toThrow(
      /must match/,
    );
  });

  it("rejects spaces", () => {
    expect(() => parseTenantFlag(argvOf(["tenant", "alice bob"]))).toThrow(
      /must match/,
    );
  });

  it("rejects path traversal attempts", () => {
    expect(() => parseTenantFlag(argvOf(["tenant", "../etc/passwd"]))).toThrow(
      /must match/,
    );
  });

  it("rejects shell metacharacters", () => {
    for (const evil of ["alice;rm", "alice|wc", "alice$x", "alice`pwd`"]) {
      expect(() => parseTenantFlag(argvOf(["tenant", evil]))).toThrow(/must match/);
    }
  });

  it("rejects slashes and forward slashes", () => {
    expect(() => parseTenantFlag(argvOf(["tenant", "a/b"]))).toThrow(/must match/);
    expect(() => parseTenantFlag(argvOf(["tenant", "a\\b"]))).toThrow(/must match/);
  });

  it("throws CliError(USAGE), not a generic error", () => {
    let err: unknown = null;
    try {
      parseTenantFlag(argvOf(["tenant", "bad/value"]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
  });
});

// ────────────────────────────────────────────────────────────────────
// Composition: parseArgv → parseRerankMode
// ────────────────────────────────────────────────────────────────────

describe("integration: parseArgv → parseRerankMode", () => {
  it("`bench truth.jsonl --rerank-mode global` yields 'global'", () => {
    const args = parseArgv(["bench", "truth.jsonl", "--rerank-mode", "global"]);
    expect(parseRerankMode(args)).toBe("global");
  });

  it("`query 'x' --no-rerank` yields 'none'", () => {
    const args = parseArgv(["query", "x", "--no-rerank"]);
    expect(parseRerankMode(args)).toBe("none");
  });

  it("`query 'x' --rerank-mode=global --no-rerank` yields 'none' (--no-rerank wins)", () => {
    const args = parseArgv(["query", "x", "--rerank-mode=global", "--no-rerank"]);
    expect(parseRerankMode(args)).toBe("none");
  });

  it("`query 'x' --rerank-mode=fancy` throws via parseRerankMode", () => {
    const args = parseArgv(["query", "x", "--rerank-mode=fancy"]);
    expect(() => parseRerankMode(args)).toThrow(/must be one of/);
  });
});
