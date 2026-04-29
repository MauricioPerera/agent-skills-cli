// Tests for `loadCustomCommandFromSource` — the v2.1.0 dynamic loader for
// pack-distributed CustomCommands.
//
// The loader is the seam between an untrusted pack's command.js and the
// just-bash runtime. It MUST:
//   1. Return a Command on the happy path.
//   2. Return null (with structured onError feedback) on every malformed
//      shape — never throw past the caller.
//   3. Not silently mask failures: each failure mode reports a stable
//      reason string so callers can write actionable diagnostics.
//
// The five failure modes (LoadFailureReason): import-failed, no-default,
// factory-threw, factory-empty, shape-invalid. One test per mode + a happy
// path test = 6 tests total.

import { describe, expect, it } from "vitest";
import {
  loadCustomCommandFromSource,
  type LoadFailureReason,
} from "../../src/lib/runtime.js";

interface CapturedError {
  reason: LoadFailureReason;
  error: unknown;
}

const captureErrors = (): {
  errors: CapturedError[];
  onError: (reason: LoadFailureReason, error: unknown) => void;
} => {
  const errors: CapturedError[] = [];
  return {
    errors,
    onError: (reason, error) => {
      errors.push({ reason, error });
    },
  };
};

describe("loadCustomCommandFromSource — happy path", () => {
  it("returns a Command and does NOT call onError when source is valid", async () => {
    const src = `
      export default ({ defineCommand }) =>
        defineCommand("ok", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    `;
    const cap = captureErrors();
    const cmd = await loadCustomCommandFromSource(src, { onError: cap.onError });
    expect(cmd).not.toBeNull();
    expect(cmd?.name).toBe("ok");
    expect(typeof cmd?.execute).toBe("function");
    expect(cap.errors).toHaveLength(0);
  });

  it("works without the onError option (back-compat)", async () => {
    const src = `
      export default ({ defineCommand }) =>
        defineCommand("ok", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    `;
    const cmd = await loadCustomCommandFromSource(src);
    expect(cmd).not.toBeNull();
  });
});

describe("loadCustomCommandFromSource — failure modes", () => {
  it("reports 'import-failed' with the underlying Error when the source has a parse error", async () => {
    const src = `export default ({ defineCommand =>`; // syntax error
    const cap = captureErrors();
    const cmd = await loadCustomCommandFromSource(src, { onError: cap.onError });
    expect(cmd).toBeNull();
    expect(cap.errors).toHaveLength(1);
    expect(cap.errors[0]?.reason).toBe("import-failed");
    expect(cap.errors[0]?.error).toBeInstanceOf(Error);
  });

  it("reports 'no-default' when the module has no default export", async () => {
    const src = `export const notDefault = 42;`;
    const cap = captureErrors();
    const cmd = await loadCustomCommandFromSource(src, { onError: cap.onError });
    expect(cmd).toBeNull();
    expect(cap.errors).toHaveLength(1);
    expect(cap.errors[0]?.reason).toBe("no-default");
  });

  it("reports 'no-default' when default export is not a function", async () => {
    const src = `export default { not: "a function" };`;
    const cap = captureErrors();
    const cmd = await loadCustomCommandFromSource(src, { onError: cap.onError });
    expect(cmd).toBeNull();
    expect(cap.errors[0]?.reason).toBe("no-default");
  });

  it("reports 'factory-threw' with the underlying Error when the factory throws", async () => {
    const src = `
      export default () => {
        throw new Error("kaboom from pack init");
      };
    `;
    const cap = captureErrors();
    const cmd = await loadCustomCommandFromSource(src, { onError: cap.onError });
    expect(cmd).toBeNull();
    expect(cap.errors[0]?.reason).toBe("factory-threw");
    expect(cap.errors[0]?.error).toBeInstanceOf(Error);
    expect((cap.errors[0]?.error as Error).message).toBe("kaboom from pack init");
  });

  it("reports 'factory-empty' when the factory returns null", async () => {
    const src = `export default () => null;`;
    const cap = captureErrors();
    const cmd = await loadCustomCommandFromSource(src, { onError: cap.onError });
    expect(cmd).toBeNull();
    expect(cap.errors[0]?.reason).toBe("factory-empty");
  });

  it("reports 'factory-empty' when the factory returns undefined", async () => {
    const src = `export default () => undefined;`;
    const cap = captureErrors();
    const cmd = await loadCustomCommandFromSource(src, { onError: cap.onError });
    expect(cmd).toBeNull();
    expect(cap.errors[0]?.reason).toBe("factory-empty");
  });

  it("reports 'shape-invalid' when the factory returns an object missing 'name'", async () => {
    const src = `export default () => ({ execute: async () => ({}) });`;
    const cap = captureErrors();
    const cmd = await loadCustomCommandFromSource(src, { onError: cap.onError });
    expect(cmd).toBeNull();
    expect(cap.errors[0]?.reason).toBe("shape-invalid");
  });

  it("reports 'shape-invalid' when the factory returns an object missing 'execute'", async () => {
    const src = `export default () => ({ name: "no-exec" });`;
    const cap = captureErrors();
    const cmd = await loadCustomCommandFromSource(src, { onError: cap.onError });
    expect(cmd).toBeNull();
    expect(cap.errors[0]?.reason).toBe("shape-invalid");
  });

  it("never throws — even if onError is omitted on a malformed pack", async () => {
    const src = `export default ({ defineCommand =>`; // syntax error
    // No onError. Should not throw. Should return null.
    const cmd = await loadCustomCommandFromSource(src);
    expect(cmd).toBeNull();
  });
});
