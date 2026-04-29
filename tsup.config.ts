import { defineConfig } from "tsup";

// Heavy runtime deps stay external (real ESM imports at runtime) instead
// of being inlined into dist. Two reasons:
//   1. dist size: bundling just-bash + just-bash-data adds ~1MB.
//   2. correctness: the dynamic CustomCommand loader (data:URL import)
//      needs `defineCommand` to be reachable at runtime; tsup's tree
//      shaking on inlined symbols was dropping it because the only
//      reference is inside a function body that gets called via the
//      data URL pathway.
const external = [
  "just-bash",
  "just-bash-data",
  "ajv",
  "ajv-formats",
  "yaml",
];

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node22",
    external,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    sourcemap: true,
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
    external,
  },
]);
