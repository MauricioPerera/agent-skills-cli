import { describe, expect, it } from "vitest";
import { resolveCommand, substituteValue } from "../../src/lib/substitute.js";
import type { SkillFrontmatter } from "../../src/types.js";

describe("substituteValue — per-type quoting", () => {
  it("string: single-quoted, no specials", () => {
    expect(substituteValue({ type: "string" }, "hello")).toBe("'hello'");
  });

  it("string: embedded single quote escaped via '\\''", () => {
    expect(substituteValue({ type: "string" }, "Don't")).toBe("'Don'\\''t'");
  });

  it("string: with spaces is one shell argument", () => {
    expect(substituteValue({ type: "string" }, "Hello World")).toBe("'Hello World'");
  });

  it("string: with embedded special characters is preserved", () => {
    expect(substituteValue({ type: "string" }, "$VAR; rm -rf /")).toBe("'$VAR; rm -rf /'");
  });

  it("integer: raw, no quoting", () => {
    expect(substituteValue({ type: "integer" }, 1000)).toBe("1000");
    expect(substituteValue({ type: "integer" }, -5)).toBe("-5");
  });

  it("number: raw, no quoting", () => {
    expect(substituteValue({ type: "number" }, 3.14)).toBe("3.14");
    expect(substituteValue({ type: "number" }, 1e10)).toBe("10000000000");
  });

  it("boolean: literal true/false", () => {
    expect(substituteValue({ type: "boolean" }, true)).toBe("true");
    expect(substituteValue({ type: "boolean" }, false)).toBe("false");
  });

  it("array: JSON-encoded, single-quoted", () => {
    expect(substituteValue({ type: "array", items: { type: "string" } }, ["a", "b"]))
      .toBe("'[\"a\",\"b\"]'");
  });

  it("object: JSON-encoded, single-quoted", () => {
    expect(substituteValue({ type: "object" }, { x: 1, y: "two" }))
      .toBe("'{\"x\":1,\"y\":\"two\"}'");
  });

  it("unquoted bypass: value inserted raw", () => {
    expect(substituteValue({ type: "string", unquoted: true, pattern: "^[a-z]+$" }, "hello"))
      .toBe("hello");
  });
});

const baseFm = (overrides: Partial<SkillFrontmatter> = {}): SkillFrontmatter => ({
  schema_version: "0.1",
  id: "test",
  version: "1.0.0",
  title: "Test",
  description: "test skill",
  use_when: "tests",
  command_template: "echo {msg}",
  args: { msg: { type: "string" } },
  ...overrides,
});

describe("resolveCommand — happy paths", () => {
  it("substitutes a single string arg", () => {
    const r = resolveCommand(baseFm(), { msg: "hello" });
    expect(r.command).toBe("echo 'hello'");
  });

  it("substitutes an integer in argument position", () => {
    const fm = baseFm({
      command_template: "curl -d amount={amount}",
      args: { amount: { type: "integer" } },
    });
    const r = resolveCommand(fm, { amount: 1000 });
    expect(r.command).toBe("curl -d amount=1000");
  });

  it("substitutes multiple args of mixed types", () => {
    const fm = baseFm({
      command_template: "curl -d amount={amount} -d currency={currency} -d active={active}",
      args: {
        amount: { type: "integer" },
        currency: { type: "string" },
        active: { type: "boolean" },
      },
    });
    const r = resolveCommand(fm, { amount: 50, currency: "usd", active: true });
    expect(r.command).toBe("curl -d amount=50 -d currency='usd' -d active=true");
  });

  it("uses default when arg is omitted", () => {
    const fm = baseFm({
      args: { msg: { type: "string", default: "hi" } },
    });
    const r = resolveCommand(fm, {});
    expect(r.command).toBe("echo 'hi'");
  });

  it("explicit value overrides default", () => {
    const fm = baseFm({
      args: { msg: { type: "string", default: "hi" } },
    });
    const r = resolveCommand(fm, { msg: "explicit" });
    expect(r.command).toBe("echo 'explicit'");
  });

  it("trace records each substitution", () => {
    const r = resolveCommand(baseFm(), { msg: "x" });
    expect(r.trace).toEqual([{ name: "msg", type: "string", rendered: "'x'" }]);
  });
});

describe("resolveCommand — type validation", () => {
  it("rejects string where integer expected", () => {
    const fm = baseFm({
      command_template: "echo {n}",
      args: { n: { type: "integer" } },
    });
    expect(() => resolveCommand(fm, { n: "five" })).toThrow(/expected integer/);
  });

  it("rejects float where integer expected", () => {
    const fm = baseFm({
      command_template: "echo {n}",
      args: { n: { type: "integer" } },
    });
    expect(() => resolveCommand(fm, { n: 3.14 })).toThrow(/expected integer/);
  });

  it("rejects NaN as number", () => {
    const fm = baseFm({
      command_template: "echo {n}",
      args: { n: { type: "number" } },
    });
    expect(() => resolveCommand(fm, { n: NaN })).toThrow(/expected finite number/);
  });
});

describe("resolveCommand — range / enum / pattern", () => {
  it("rejects out-of-range integer", () => {
    const fm = baseFm({
      command_template: "echo {n}",
      args: { n: { type: "integer", range: [1, 100] } },
    });
    expect(() => resolveCommand(fm, { n: 200 })).toThrow(/out of range/);
  });

  it("rejects value not in enum", () => {
    const fm = baseFm({
      command_template: "echo {currency}",
      args: { currency: { type: "string", enum: ["usd", "eur"] } },
    });
    expect(() => resolveCommand(fm, { currency: "yen" })).toThrow(/not in enum/);
  });

  it("rejects pattern mismatch", () => {
    const fm = baseFm({
      command_template: "echo {id}",
      args: { id: { type: "string", pattern: "^cus_" } },
    });
    expect(() => resolveCommand(fm, { id: "user_x" })).toThrow(/does not match pattern/);
  });
});

describe("resolveCommand — error cases", () => {
  it("rejects missing required arg", () => {
    const fm = baseFm({
      args: { msg: { type: "string" } },
    });
    expect(() => resolveCommand(fm, {})).toThrow(/missing required arg/);
  });

  it("rejects unresolved placeholder leftover", () => {
    const fm = baseFm({
      command_template: "echo {a} {b}",
      args: { a: { type: "string" } },
    });
    // 'b' has no args entry but appears in template
    expect(() => resolveCommand(fm, { a: "x" })).toThrow(/unresolved placeholder/);
  });
});

describe("resolveCommand — privacy invariant demonstration", () => {
  it("$STRIPE_SECRET_KEY in template is NOT substituted by the bank", () => {
    // This is the credential isolation invariant from SPEC §8 P1.
    // Bank only substitutes {placeholders}; shell vars survive the bank.
    const fm = baseFm({
      command_template: "curl -u $STRIPE_SECRET_KEY: -d amount={amount} https://api.stripe.com/v1/charges",
      args: { amount: { type: "integer" } },
    });
    const r = resolveCommand(fm, { amount: 1000 });
    expect(r.command).toBe(
      "curl -u $STRIPE_SECRET_KEY: -d amount=1000 https://api.stripe.com/v1/charges",
    );
    // $STRIPE_SECRET_KEY remains literal — shell will expand at exec.
  });
});
