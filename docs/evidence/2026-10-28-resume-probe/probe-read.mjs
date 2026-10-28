// For each api-request in a session file: which sentinels its recorded system blocks carry, and the reply's usage.
import fs from "node:fs";
const lines = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const shapes = new Map(lines.filter((o) => o.type === "api-request-shape").map((o) => [o.shapeHash, o]));
const sentinel = (text) => ["ALPHA-7F3C", "BRAVO-91D2"].filter((s) => text.includes(s)).join("+") || "none";
const requests = lines.filter((o) => o.type === "api-request");
const usage = lines.filter((o) => o.type === "assistant" && o.message?.usage).map((o) => o.message.usage);
console.log("records:", JSON.stringify(Object.fromEntries([...new Set(lines.map((o) => o.type))].map((t) => [t, lines.filter((o) => o.type === t).length]))));
requests.forEach((r, i) => {
  const shape = shapes.get(r.shapeHash);
  const sys = JSON.stringify(shape?.shape?.system ?? null);
  console.log(`request ${i + 1}: shape ${r.shapeHash.slice(0, 8)} found=${!!shape} system sentinels=${sentinel(sys)} systemBytes=${sys.length}`);
});
usage.forEach((u, i) => console.log(`usage ${i + 1}: cache_read=${u.cache_read_input_tokens} cache_creation=${u.cache_creation_input_tokens} input=${u.input_tokens}`));
console.log("whole file sentinels:", sentinel(fs.readFileSync(process.argv[2], "utf8")));
