// Tests for the SPEC §2.11 `filesystem` allowlist plumbing.
//
// Two layers exercised:
//   1. `buildSandboxFs` — pure factory: scratch-only by default, MountableFs
//      with read-only OverlayFs mounts when `filesystem` is non-empty.
//   2. End-to-end via `createSandboxedExec` + bash.exec — verify a host file
//      is reachable when its parent dir is in the allowlist, and not
//      reachable when no allowlist is given.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxFs, cleanupScratch, createSandboxedExec } from "../../src/lib/runtime.js";

// Convert a (possibly Windows) host path to the POSIX-style virtual
// path that the runtime exposes inside the sandbox. Mirrors the
// translation rule documented next to buildSandboxFs.
const virtualPath = (hostPath: string): string => {
  if (hostPath.startsWith("/")) return hostPath;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (m !== null) {
    const drive = m[1]!.toLowerCase();
    const rest = m[2]!.replace(/\\/g, "/");
    return rest.length === 0 ? `/${drive}` : `/${drive}/${rest}`;
  }
  return "/" + hostPath.replace(/\\/g, "/");
};

describe("buildSandboxFs — defaults (no filesystem allowlist)", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "buildfs-scratch-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("returns a ReadWriteFs at scratch when filesystem is undefined", () => {
    const fs = buildSandboxFs(scratch, undefined);
    // ReadWriteFs is opaque from outside — duck-type by checking
    // it has the IFileSystem methods we care about.
    expect(typeof (fs as unknown as { readFile?: unknown }).readFile).toBe("function");
    expect(typeof (fs as unknown as { writeFile?: unknown }).writeFile).toBe("function");
  });

  it("returns a ReadWriteFs at scratch when filesystem is an empty array", () => {
    const fs = buildSandboxFs(scratch, []);
    expect(typeof (fs as unknown as { readFile?: unknown }).readFile).toBe("function");
  });
});

describe("createSandboxedExec — filesystem allowlist end-to-end", () => {
  let hostDir: string;
  let testFile: string;

  beforeEach(async () => {
    hostDir = await mkdtemp(join(tmpdir(), "fs-allowlist-host-"));
    testFile = join(hostDir, "data.txt");
    await writeFile(testFile, "secret-host-content\n", "utf8");
  });

  afterEach(async () => {
    await rm(hostDir, { recursive: true, force: true });
  });

  it("reads a host file when its directory is in the filesystem allowlist", async () => {
    const { bash, scratchDir } = createSandboxedExec({
      filesystem: [hostDir],
    });
    try {
      const r = await bash.exec(`cat '${virtualPath(testFile)}'`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("secret-host-content\n");
    } finally {
      cleanupScratch(scratchDir);
    }
  });

  it("blocks read of a host file outside the allowlist", async () => {
    // Allow a different host dir; the test file is NOT in it.
    const otherDir = await mkdtemp(join(tmpdir(), "fs-other-"));
    try {
      const { bash, scratchDir } = createSandboxedExec({
        filesystem: [otherDir],
      });
      try {
        const r = await bash.exec(`cat '${virtualPath(testFile)}'`);
        expect(r.exitCode).not.toBe(0);
        expect(r.stdout).toBe("");
      } finally {
        cleanupScratch(scratchDir);
      }
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("blocks read of a host file when no filesystem allowlist is set (default scratch-only)", async () => {
    const { bash, scratchDir } = createSandboxedExec({});  // no filesystem
    try {
      const r = await bash.exec(`cat '${virtualPath(testFile)}'`);
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      cleanupScratch(scratchDir);
    }
  });

  it("skips non-existent filesystem entries gracefully (writes warning to stderr, no crash)", async () => {
    // Capture process.stderr.write to verify the warning AND ensure no throw.
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const { bash, scratchDir } = createSandboxedExec({
        filesystem: [
          "/this/path/does/not/exist/anywhere",
          hostDir, // valid; mounts normally
        ],
      });
      try {
        // Read of valid mount still works — the skip didn't break the rest.
        const r = await bash.exec(`cat '${virtualPath(testFile)}'`);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("secret-host-content\n");
      } finally {
        cleanupScratch(scratchDir);
      }
    } finally {
      process.stderr.write = origWrite;
    }
    const warnings = captured.join("");
    expect(warnings).toContain("filesystem allowlist entry skipped");
    expect(warnings).toContain("/this/path/does/not/exist/anywhere");
  });

  it("scratch dir is still writable when filesystem allowlist is set", async () => {
    const { bash, scratchDir } = createSandboxedExec({
      filesystem: [hostDir],
    });
    try {
      // Write into scratch (the base FS at /), read it back.
      const r = await bash.exec(`echo 'in-scratch' > /probe.txt && cat /probe.txt`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("in-scratch\n");
    } finally {
      cleanupScratch(scratchDir);
    }
  });

  it("blocks WRITE into a filesystem-allowlisted path (read-only mount)", async () => {
    const { bash, scratchDir } = createSandboxedExec({
      filesystem: [hostDir],
    });
    try {
      const evilVirtual = virtualPath(join(hostDir, "evil.txt"));
      // The OverlayFs read-only guard surfaces as a thrown EROFS at the
      // bash exec layer (filesystem errors propagate as exceptions, not
      // as exit codes). Either outcome is acceptable; what matters is
      // that the host file is NOT created.
      let blocked = false;
      try {
        const r = await bash.exec(`echo 'pwned' > '${evilVirtual}'`);
        if (r.exitCode !== 0) blocked = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/read-only|EROFS/.test(msg)) blocked = true;
      }
      expect(blocked).toBe(true);
      // The host file must not have been created.
      const fs = await import("node:fs/promises");
      const stillThere = await fs.readdir(hostDir);
      expect(stillThere).not.toContain("evil.txt");
    } finally {
      cleanupScratch(scratchDir);
    }
  });
});
