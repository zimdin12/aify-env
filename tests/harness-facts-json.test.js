import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HARNESS_FACTS } from "../lib/agent-definition-schema.mjs";

const ordered = object => Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));

// Consumers pin these data bytes, not the schema module or the host checkout. Regenerate from
// the owner, sort keys but keep alias order, and compare bytes including the trailing line feed.
test("the versioned harness facts JSON matches the schema export byte for byte", () => {
  const harnesses = ordered(Object.fromEntries(Object.entries(HARNESS_FACTS).map(([name, facts]) => [name, ordered(facts)])));
  const generated = Buffer.from(`${JSON.stringify({ schemaVersion: 1, harnesses }, null, 2)}\n`, "utf8");
  const published = readFileSync(new URL("../lib/harness-facts-v1.json", import.meta.url));
  assert.ok(published.equals(generated), "regenerate lib/harness-facts-v1.json from HARNESS_FACTS, including key order and trailing LF");
});
