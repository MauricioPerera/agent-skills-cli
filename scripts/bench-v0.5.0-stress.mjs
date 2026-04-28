// v0.5.0 stress-test benchmark prep:
// builds the 7 embedding-text strings + 35 paraphrases + the
// concentrated-usage past-intent corpus. Outputs a JSON ready to pass
// to the Cloudflare connector for batch embedding.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillSource, composeEmbeddingText } from "../dist/index.js";

const PACK = "D:/repos/Nueva carpeta (27)/agent-skills-pack/skills";
const SKILL_DIRS = [
  "http-get",
  "http-post-json",
  "github-issue-create",
  "ripgrep-search",
  "read-file",
  "json-query",
  "base64-encode",
];

const skills = SKILL_DIRS.map((dir) => {
  const src = readFileSync(join(PACK, dir, "SKILL.md"), "utf8");
  const parsed = parseSkillSource(src);
  if (!parsed.frontmatter || !parsed.body) throw new Error("parse fail: " + dir);
  return {
    id: parsed.frontmatter.id,
    text: composeEmbeddingText(parsed.frontmatter, parsed.body),
  };
});

// 5 paraphrases per skill = 35 queries — same as v0.4.0 BENCHMARK.
const paraphrases = [
  // http-get
  { expected: "github.com/MauricioPerera/agent-skills-pack/http-get",            q: "fetch the contents of a URL" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/http-get",            q: "GET request to a webpage" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/http-get",            q: "download a json document over http" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/http-get",            q: "retrieve data from an API endpoint" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/http-get",            q: "read what's at this https url" },
  // http-post-json
  { expected: "github.com/MauricioPerera/agent-skills-pack/http-post-json",      q: "POST a JSON body to an API" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/http-post-json",      q: "send JSON to a webhook endpoint" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/http-post-json",      q: "submit a JSON payload via http" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/http-post-json",      q: "make an HTTP POST with a request body" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/http-post-json",      q: "push data to a REST endpoint as JSON" },
  // github-issue-create
  { expected: "github.com/MauricioPerera/agent-skills-pack/github-issue-create", q: "open a new GitHub issue" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/github-issue-create", q: "file a bug report on a repo" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/github-issue-create", q: "create a ticket on GitHub" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/github-issue-create", q: "submit an issue to a repository" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/github-issue-create", q: "report a problem in a github project" },
  // ripgrep-search
  { expected: "github.com/MauricioPerera/agent-skills-pack/ripgrep-search",      q: "search for a regex pattern across files" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/ripgrep-search",      q: "find all TODO comments in the source" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/ripgrep-search",      q: "grep through a codebase for a string" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/ripgrep-search",      q: "look for pattern matches in many files" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/ripgrep-search",      q: "scan all source files for a regex" },
  // read-file
  { expected: "github.com/MauricioPerera/agent-skills-pack/read-file",           q: "show me the contents of package.json" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/read-file",           q: "open a file from disk and print it" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/read-file",           q: "cat the README" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/read-file",           q: "load a local text file" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/read-file",           q: "display what's inside a file path" },
  // json-query
  { expected: "github.com/MauricioPerera/agent-skills-pack/json-query",          q: "extract a field from JSON data" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/json-query",          q: "query JSON with a path expression" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/json-query",          q: "pluck the .name field out of this object" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/json-query",          q: "filter a JSON array by a property" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/json-query",          q: "use jq-like syntax to traverse JSON" },
  // base64-encode
  { expected: "github.com/MauricioPerera/agent-skills-pack/base64-encode",       q: "encode a string as base64" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/base64-encode",       q: "create an Authorization header value" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/base64-encode",       q: "make a Basic Auth credential" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/base64-encode",       q: "convert text to base64" },
  { expected: "github.com/MauricioPerera/agent-skills-pack/base64-encode",       q: "build a base64-encoded token" },
];

// 50 past intents on base64-encode — but DIVERSE: most are about base64
// (genuine concentrated usage), but many cover tangents that are NOT in
// the 35-query set. The intent-conditional rerank should still boost
// base64-encode on the 5 base64 paraphrases (where past intents are
// semantically similar) while NOT boosting it on the other 30 queries
// (where past intents are dissimilar).
const pastIntents = [
  // 50 entries (each with daysAgo for recency variance)
  ...Array.from({ length: 10 }, (_, i) => ({ skill_id: "github.com/MauricioPerera/agent-skills-pack/base64-encode", intent: `encode credential ${i} as base64`, daysAgo: i * 0.5 })),
  ...Array.from({ length: 10 }, (_, i) => ({ skill_id: "github.com/MauricioPerera/agent-skills-pack/base64-encode", intent: `make a Basic Auth header for service ${i}`, daysAgo: 5 + i * 0.3 })),
  ...Array.from({ length: 10 }, (_, i) => ({ skill_id: "github.com/MauricioPerera/agent-skills-pack/base64-encode", intent: `convert username:password ${i} to base64`, daysAgo: 8 + i * 0.4 })),
  ...Array.from({ length: 10 }, (_, i) => ({ skill_id: "github.com/MauricioPerera/agent-skills-pack/base64-encode", intent: `generate Authorization token #${i}`, daysAgo: 12 + i * 0.5 })),
  ...Array.from({ length: 10 }, (_, i) => ({ skill_id: "github.com/MauricioPerera/agent-skills-pack/base64-encode", intent: `build base64 string for blob ${i}`, daysAgo: 15 + i * 0.6 })),
];

const out = {
  skills,
  paraphrases,
  pastIntents,
};

writeFileSync("scripts/bench-v0.5.0-input.json", JSON.stringify(out, null, 2));
console.log(`skills=${skills.length} paraphrases=${paraphrases.length} pastIntents=${pastIntents.length}`);
console.log(`total embedding-texts to embed: ${skills.length + paraphrases.length + pastIntents.length}`);
