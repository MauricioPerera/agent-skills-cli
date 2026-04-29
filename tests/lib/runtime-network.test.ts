// Tests for the agent-skills `network` allowlist → just-bash NetworkConfig
// translation (`buildNetworkConfig`).
//
// Background: the agent-skills SPEC §2.10 lets skills declare `network` as
// a list of origins. just-bash treats each entry as a literal URL (so
// "https://*" parses as origin "https://*" and matches nothing — silent
// fail at exec time), and defaults `allowedMethods` to ["GET", "HEAD"]
// (so any POST-shaped skill is blocked even with a valid URL match).
//
// The real-world pack ecosystem ships skills with `network: ["https://*"]`
// meaning "any URL the user provides" — generic HTTP fetchers like
// http-get and http-post-json. Without translation, those skills are
// 100% broken in the v2 sandbox (verified via E2E suite — intents 2 and
// 3 of 7 failed with "URL not in allow-list").
//
// `buildNetworkConfig` translates wildcard intent into just-bash's
// dangerouslyAllowFullInternetAccess + all-methods. These tests pin
// the contract.

import { describe, expect, it } from "vitest";
import { buildNetworkConfig } from "../../src/lib/runtime.js";

describe("buildNetworkConfig — empty / undefined", () => {
  it("returns undefined for missing network", () => {
    expect(buildNetworkConfig(undefined)).toBeUndefined();
  });

  it("returns undefined for empty array (no network access)", () => {
    expect(buildNetworkConfig([])).toBeUndefined();
  });
});

describe("buildNetworkConfig — wildcard mode", () => {
  it("translates 'https://*' to dangerouslyAllowFullInternetAccess", () => {
    const cfg = buildNetworkConfig(["https://*"]);
    expect(cfg?.dangerouslyAllowFullInternetAccess).toBe(true);
    // Without method extension, POST-shaped skills break. So wildcard mode
    // unlocks the standard 7 HTTP methods.
    expect(cfg?.allowedMethods).toEqual([
      "GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS",
    ]);
    // No specific origins were given alongside the wildcard.
    expect(cfg?.allowedUrlPrefixes).toBeUndefined();
  });

  it("translates 'http://*' to dangerouslyAllowFullInternetAccess", () => {
    const cfg = buildNetworkConfig(["http://*"]);
    expect(cfg?.dangerouslyAllowFullInternetAccess).toBe(true);
  });

  it("translates bare '*' to dangerouslyAllowFullInternetAccess", () => {
    const cfg = buildNetworkConfig(["*"]);
    expect(cfg?.dangerouslyAllowFullInternetAccess).toBe(true);
  });

  it("recognises trailing-slash wildcard variants ('https://*/')", () => {
    expect(buildNetworkConfig(["https://*/"])?.dangerouslyAllowFullInternetAccess).toBe(true);
    expect(buildNetworkConfig(["http://*/"])?.dangerouslyAllowFullInternetAccess).toBe(true);
  });

  it("recognises mixed http+https wildcards (the canonical pack idiom)", () => {
    const cfg = buildNetworkConfig(["https://*", "http://*"]);
    expect(cfg?.dangerouslyAllowFullInternetAccess).toBe(true);
    expect(cfg?.allowedMethods).toContain("POST");
  });

  it("preserves specific origins alongside wildcards (defence in depth / docs)", () => {
    // Skill says "any URL plus this specific one" — we keep the specific
    // entries in allowedUrlPrefixes for documentation even though the
    // dangerous-allow flag bypasses the check. Future tooling could
    // surface them in audit / inventory.
    const cfg = buildNetworkConfig(["https://*", "https://api.github.com/"]);
    expect(cfg?.dangerouslyAllowFullInternetAccess).toBe(true);
    expect(cfg?.allowedUrlPrefixes).toEqual(["https://api.github.com/"]);
  });
});

describe("buildNetworkConfig — strict origin mode (no wildcards)", () => {
  it("passes specific origins through to allowedUrlPrefixes unchanged", () => {
    const cfg = buildNetworkConfig(["https://api.github.com/", "https://api.cloudflare.com/"]);
    expect(cfg?.allowedUrlPrefixes).toEqual([
      "https://api.github.com/",
      "https://api.cloudflare.com/",
    ]);
    // No wildcard → no dangerous flag, no method extension. just-bash's
    // strict default applies (GET + HEAD only — explicitly NOT extending
    // here since the SPEC has no `allowed_methods` field yet).
    expect(cfg?.dangerouslyAllowFullInternetAccess).toBeUndefined();
    expect(cfg?.allowedMethods).toBeUndefined();
  });

  it("does NOT match origins that just LOOK like wildcards (e.g., literal-asterisk hostname)", () => {
    // "https://x.example.com/*" is a path with a literal asterisk — NOT
    // a wildcard origin. The detector must not be fooled by substring
    // matches.
    const cfg = buildNetworkConfig(["https://x.example.com/*"]);
    expect(cfg?.dangerouslyAllowFullInternetAccess).toBeUndefined();
    expect(cfg?.allowedUrlPrefixes).toEqual(["https://x.example.com/*"]);
  });
});
