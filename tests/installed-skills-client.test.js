// Exercise the public package leaf against receipts written by the actual placer.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as installedSkills from "aify-env/client/installed-skills";
import { SkillPlacer, skillDirectory } from "../lib/install-skills.mjs";

const { verifyPlacement } = installedSkills;

test("the public declaration check uses the installer's grammar", () => {
  assert.equal(installedSkills.skillDirectory, skillDirectory, "connect must share the installer's declaration check");
  assert.equal(installedSkills.skillDirectory({ directory: "share/skills" }), "share/skills");
  for (const declaration of [undefined, "skills", {}, { directory: "../skills" }, { directory: "C:/skills" },
    { directory: ".agents/skills" }, { directory: "skills/nul.txt" }, { directory: "skills//nested" },
    { directory: "skills", command: "node" }]) {
    assert.equal(installedSkills.skillDirectory(declaration), null);
  }
});

function fixture(t, { place = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "placement-client-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "host-home");
  const packageDir = path.join(root, "approved-package");
  const runtimeSkills = path.join(root, "custom-runtime-home", "skills");
  const skill = "a-checkable-skill";
  const service = "a-fixture-service";
  const query = { home, service, skill, harness: "claude" };
  const src = path.join(packageDir, "skills", skill);
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(src, "SKILL.md"), "declared fixture skill");
  const assets = { service, packageDir, directory: "skills", source: { artifact: "fixture", revision: "a".repeat(40), approval: "b".repeat(64) } };
  const put = target => new SkillPlacer({ home }).place(assets, query.harness, { root: target });
  if (place) put(runtimeSkills);
  return { root, home, query, put, destination: path.join(runtimeSkills, skill), receipt: path.join(home, ".aify", "installed-skills.json") };
}

test("the public reader verifies a writer's receipt in an explicit home without writing", t => {
  const f = fixture(t);
  const receipt = fs.readFileSync(f.receipt);
  const skill = path.join(f.destination, "SKILL.md");
  const bytes = fs.readFileSync(skill);
  const denyWrite = () => assert.fail("verifyPlacement attempted a write");
  try {
    for (const operation of ["mkdirSync", "mkdtempSync", "writeFileSync", "renameSync", "unlinkSync", "rmdirSync", "rmSync"]) {
      t.mock.method(fs, operation, denyWrite);
    }
    assert.deepEqual(verifyPlacement(f.query), { state: "placed", reason: "the recorded skill tree matches its receipt" });
  } finally {
    t.mock.restoreAll();
  }
  assert.deepEqual(fs.readFileSync(f.receipt), receipt);
  assert.deepEqual(fs.readFileSync(skill), bytes);
  assert.equal(verifyPlacement({ ...f.query, harness: "codex" }).state, "absent", "a different harness must not inherit this receipt");
});

test("changed on-disk bytes are changed, not placed by the old receipt", t => {
  const f = fixture(t);
  const old = fs.readFileSync(f.receipt);
  fs.writeFileSync(path.join(f.destination, "SKILL.md"), "changed after install");
  assert.deepEqual(verifyPlacement(f.query), { state: "changed", reason: "the recorded skill tree differs from its receipt" });
  assert.deepEqual(fs.readFileSync(f.receipt), old, "a reader may not silently bless new bytes");
});

test("a missing destination is absent even when the receipt is still there", t => {
  const f = fixture(t);
  fs.rmSync(f.destination, { recursive: true });
  assert.deepEqual(verifyPlacement(f.query), { state: "absent", reason: "the recorded skill destination is missing" });
  assert.equal(fs.existsSync(f.receipt), true);
  assert.equal(fs.existsSync(f.destination), false, "the reader does not repair a missing tree");
});

test("invalid receipt bytes or rows fail closed without quoting their contents", t => {
  const f = fixture(t);
  const valid = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
  const invalid = ["fixture-private-value broken JSON", JSON.stringify({ ...valid, placements: [{ ...valid.placements[0], digest: "not-a-digest" }] })];
  for (const body of invalid) {
    fs.writeFileSync(f.receipt, body);
    assert.deepEqual(verifyPlacement(f.query), { state: "absent", reason: "installed-skills.json is invalid or unreadable" });
    assert.equal(fs.readFileSync(f.receipt, "utf8"), body);
  }
});

test("no receipt cannot attest an unmanaged skill with the same name", t => {
  const f = fixture(t, { place: false });
  fs.mkdirSync(f.destination, { recursive: true });
  fs.writeFileSync(path.join(f.destination, "SKILL.md"), "declared fixture skill");
  assert.deepEqual(verifyPlacement(f.query), { state: "absent", reason: "installed-skills.json is missing" });
  assert.equal(fs.existsSync(path.dirname(f.receipt)), false);
});

test("two valid placements for one selector are ambiguous, never chosen by age or path", t => {
  const f = fixture(t);
  f.put(path.join(f.root, "another-runtime-home", "skills"));
  assert.equal(JSON.parse(fs.readFileSync(f.receipt, "utf8")).placements.length, 2);
  assert.deepEqual(verifyPlacement(f.query), { state: "absent", reason: "more than one receipt matches this skill placement" });
});

test("a link substituted at the recorded destination is not verified even with matching bytes", t => {
  const f = fixture(t);
  const elsewhere = path.join(f.root, "other-tree");
  fs.renameSync(f.destination, elsewhere);
  fs.symlinkSync(elsewhere, f.destination, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(verifyPlacement(f.query), { state: "changed", reason: "the recorded skill tree could not be verified" });
  assert.equal(fs.lstatSync(f.destination).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(elsewhere, "SKILL.md"), "utf8"), "declared fixture skill");
});
