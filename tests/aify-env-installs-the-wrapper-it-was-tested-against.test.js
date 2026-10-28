// `aify-env install` installs aify-wrapper at one commit, the one this aify-env was tested against, and that commit is
// written in one place: package.json's `aifyWrapper` (lib/wrapper-pin.mjs). Before 0.9.9 it installed whatever
// aify-wrapper's main was that day, and nothing said which.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { pinnedWrapperSource, wrapperInstallSource } from "../lib/wrapper-pin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("the pin is package.json's aifyWrapper, at a full commit, and the installer's source unless a caller overrides it", () => {
  assert.equal(pinnedWrapperSource(), manifest.aifyWrapper);
  assert.match(manifest.aifyWrapper, /^github:zimdin12\/aify-wrapper#[0-9a-f]{40}$/);
  assert.equal(wrapperInstallSource({}), manifest.aifyWrapper);
  assert.equal(wrapperInstallSource({ AIFY_INSTALL_WRAPPER_SOURCE: "C:/w/aify-wrapper.tgz" }), "C:/w/aify-wrapper.tgz");
});

test("NEGATIVE CONTROL: a branch, a short id or no pin at all is refused, not installed", () => {
  for (const aifyWrapper of ["github:zimdin12/aify-wrapper", "github:zimdin12/aify-wrapper#main", "github:zimdin12/aify-wrapper#8f8096b",
    "github:someone/aify-wrapper#8f8096b7be4b5115485f87a78d70284fb464271c", undefined]) {
    assert.throws(() => pinnedWrapperSource({ aifyWrapper }), /must name aify-wrapper at a full commit/, String(aifyWrapper));
  }
});

test("ONE PLACE: no installer code spells aify-wrapper's source itself, so it cannot disagree with the pin", () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".mjs") ? [path.join(dir, entry.name)] : []));
  const files = [...walk(path.join(ROOT, "lib")), ...walk(path.join(ROOT, "bin"))];
  const spelled = files.filter((file) => fs.readFileSync(file, "utf8").includes("github:zimdin12/aify-wrapper")).map((file) => path.relative(ROOT, file).split(path.sep).join("/"));
  assert.deepEqual(spelled, ["lib/wrapper-pin.mjs"], "only the pin's own module may spell the source, and only to say what a pin looks like");
  assert.match(fs.readFileSync(path.join(ROOT, "bin", "aify-env-install.mjs"), "utf8"), /const wrapperSource = wrapperInstallSource\(env\);/,
    "the installer does not take its source from the pin");
});
