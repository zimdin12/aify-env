// The install chain copies skill data. Only a receipt and matching read-back bytes grant ownership.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = (value, length) => typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value);
const samePath = (a, b) => path.relative(a, b) === "";
const isInside = (root, file) => { const rel = path.relative(root, file); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); };
const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const segment = name => typeof name === "string" && /^[A-Za-z0-9_-](?:[A-Za-z0-9._ -]*[A-Za-z0-9_-])?$/.test(name)
  && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);

/** A portable package-relative path, not a registry path, link target or executable. */
export function skillDirectory(value) {
  return plainObject(value) && Object.keys(value).length === 1 && typeof value.directory === "string"
    && value.directory.split("/").every(segment) ? value.directory : null;
}

function inspect(file, io) {
  const info = io.lstatSync(file, { throwIfNoEntry: false });
  if (info?.isSymbolicLink()) throw new Error(`${file} is a link; nothing follows it`);
  return info;
}

function directory(folder, io, create = false) {
  if (!path.isAbsolute(folder)) throw new Error(`${folder} is not an absolute directory`);
  const parent = path.dirname(folder);
  if (parent !== folder) directory(parent, io, create);
  const info = inspect(folder, io);
  if (info && !info.isDirectory()) throw new Error(`${folder} is not a directory`);
  if (!info && create) io.mkdirSync(folder);
  return Boolean(info || create);
}

function treeAt(root, io) {
  if (!directory(root, io)) return null;
  const entries = [];
  function visit(parent, names = []) {
    const found = io.readdirSync(parent).sort();
    if (new Set(found.map(name => name.toLowerCase())).size !== found.length) throw new Error(`${parent} has case-colliding entries`);
    for (const name of found) {
      if (!segment(name)) throw new Error(`${parent} has a nonportable entry name`);
      const file = path.join(parent, name), rel = [...names, name], info = inspect(file, io);
      if (info?.isDirectory()) {
        entries.push({ rel, data: null });
        visit(file, rel);
      } else if (info?.isFile() && info.nlink === 1) entries.push({ rel, data: io.readFileSync(file) });
      else throw new Error(`${file} is not a regular owned file or directory`);
    }
  }
  visit(root);
  const digest = sha256(JSON.stringify(entries.map(({ rel, data }) => [rel, data === null ? null : sha256(data)])));
  return { entries, digest };
}

function offered(assets, io) {
  const root = path.join(assets.packageDir, ...assets.directory.split("/"));
  if (!isInside(assets.packageDir, root) || !directory(root, io)) throw new Error("the declared skill tree is missing or outside its package");
  const names = io.readdirSync(root).sort();
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error("the skill tree has case-colliding names");
  return names.map(skill => {
    if (!segment(skill)) throw new Error("the declared tree contains a nonportable skill name");
    const tree = treeAt(path.join(root, skill), io);
    if (!tree?.entries.some(({ rel, data }) => rel.length === 1 && rel[0] === "SKILL.md" && data !== null)) {
      throw new Error(`${skill} is missing a regular SKILL.md`);
    }
    return { skill, ...tree };
  });
}

function validRow(row) {
  return plainObject(row) && Object.keys(row).length === 6 && segment(row.service) && segment(row.skill) && segment(row.harness)
    && typeof row.destination === "string" && path.isAbsolute(row.destination) && path.basename(row.destination) === row.skill
    && hex(row.digest, 64) && plainObject(row.source) && Object.keys(row.source).length === 4 && segment(row.source.artifact)
    && hex(row.source.revision, 40) && hex(row.source.approval, 64) && typeof row.source.path === "string"
    && row.source.path.split("/").every(segment);
}

const receiptAt = home => path.join(home, ".aify", "installed-skills.json");

function readReceipt(file, io) {
  directory(path.dirname(file), io);
  const info = inspect(file, io);
  if (!info) return null;
  if (!info.isFile() || info.nlink !== 1) throw new Error("installed-skills.json is not a regular owned file");
  const old = JSON.parse(io.readFileSync(file, "utf8"));
  if (old?.version !== 1 || !Array.isArray(old.placements) || !old.placements.every(validRow)
    || old.placements.some((row, at) => old.placements.slice(0, at).some(other => samePath(row.destination, other.destination)))) {
    throw new Error("installed-skills.json is invalid; it grants no ownership");
  }
  return old.placements;
}

/** Read one placement through the same receipt and digest rules the writer uses. */
export function verifyPlacement(query) {
  const absent = reason => ({ state: "absent", reason });
  if (!plainObject(query)) return absent("a skill placement selector is required");
  const { home, service, skill, harness } = query;
  if (typeof home !== "string" || !path.isAbsolute(home) || ![service, skill, harness].every(segment)) {
    return absent("an absolute home and valid service, skill and harness names are required");
  }
  let rows;
  try { rows = readReceipt(receiptAt(home), fs); }
  catch { return absent("installed-skills.json is invalid or unreadable"); }
  if (!rows) return absent("installed-skills.json is missing");
  const matches = rows.filter(row => row.service === service && row.skill === skill && row.harness === harness);
  if (matches.length === 0) return absent("no receipt matches this skill placement");
  if (matches.length !== 1) return absent("more than one receipt matches this skill placement");

  const [{ destination, digest }] = matches;
  let current;
  try { current = treeAt(destination, fs); }
  catch { return { state: "changed", reason: "the recorded skill tree could not be verified" }; }
  if (!current) return absent("the recorded skill destination is missing");
  return current.digest === digest
    ? { state: "placed", reason: "the recorded skill tree matches its receipt" }
    : { state: "changed", reason: "the recorded skill tree differs from its receipt" };
}

function writeReceipt(file, placements, io) {
  const parent = path.dirname(file);
  directory(parent, io, true);
  inspect(file, io);
  const temp = io.mkdtempSync(path.join(parent, "skill-receipt-"));
  try {
    const next = path.join(temp, "record.json");
    io.writeFileSync(next, `${JSON.stringify({ version: 1, placements }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    io.renameSync(next, file);
  } finally {
    io.rmSync(temp, { recursive: true, force: true });
  }
}

function populate(destination, tree, created, io) {
  io.mkdirSync(destination); // exclusive, including an empty unmanaged folder
  created.push({ file: destination, data: null });
  for (const { rel, data } of tree.entries) {
    const file = path.join(destination, ...rel);
    if (data === null) io.mkdirSync(file);
    else {
      try { io.writeFileSync(file, data, { flag: "wx" }); }
      catch (error) {
        // A partial exclusive write can leave a file behind. Do not adopt an existing target.
        if (error.code !== "EEXIST" && inspect(file, io)?.isFile()) {
          const partial = io.readFileSync(file);
          if (data.subarray(0, partial.length).equals(partial)) created.push({ file, data: partial });
        }
        throw error;
      }
    }
    created.push({ file, data });
  }
  if (treeAt(destination, io)?.digest !== tree.digest) throw new Error(`${destination} did not read back as placed`);
}

// Only undo writes this step made. A competing writer's new bytes are never removed on rollback.
function undoCreated(created, io) {
  for (const { file, data } of created.reverse()) {
    const info = inspect(file, io);
    if (!info) continue;
    if (data === null) io.rmdirSync(file);
    else if (info.isFile() && io.readFileSync(file).equals(data)) io.unlinkSync(file);
    else throw new Error(`${file} changed during placement; left as found`);
  }
}

function changeSkill({ destination, before, next, store }, io) {
  const parent = path.dirname(destination);
  directory(parent, io, true);
  const staging = io.mkdtempSync(path.join(parent, ".aify-skill-"));
  const backup = path.join(staging, "previous");
  const created = [];
  let kept = false, discard = false;
  try {
    if (treeAt(destination, io)?.digest !== before?.digest) throw new Error(`${destination} changed before placement`);
    if (before) { io.renameSync(destination, backup); kept = true; }
    if (next) populate(destination, next, created, io);
    else if (inspect(destination, io)) throw new Error(`${destination} did not read back as removed`);
    store();
    discard = true;
  } catch (error) {
    try {
      undoCreated(created, io);
      if (kept) {
        if (inspect(destination, io)) throw new Error(`${destination} appeared during rollback`);
        io.renameSync(backup, destination);
      }
      discard = true;
    } catch (rollback) {
      throw new Error(`${error.message}; rollback incomplete (${rollback.message}); previous bytes, if any, are in ${staging}`);
    }
    throw error;
  } finally {
    if (discard) io.rmSync(staging, { recursive: true, force: true });
  }
}

/** Place one approved service's declared tree into a proved runtime root. Commit each read-back, not the plan. */
export class SkillPlacer {
  #file; #io;
  constructor({ home, io = fs }) {
    if (!path.isAbsolute(home)) throw new Error("skill receipts need an absolute home");
    this.#io = io;
    this.#file = receiptAt(home);
  }

  place(assets, harness, { root, searchRoots = [] }) {
    const io = this.#io;
    if (!path.isAbsolute(root) || !searchRoots.every(at => path.isAbsolute(at))) throw new Error("skill roots were not established");
    const desired = offered(assets, io);
    let rows = readReceipt(this.#file, io) ?? [];
    const commit = (destination, row, before, next) => {
      const updated = rows.filter(old => !samePath(old.destination, destination));
      if (row) updated.push(row);
      changeSkill({ destination, before, next, store: () => writeReceipt(this.#file, updated, io) }, io);
      rows = updated;
    };
    const owned = row => row?.service === assets.service && row.harness === harness;
    for (const skill of desired) {
      const destination = path.join(root, skill.skill);
      for (const other of searchRoots) {
        const there = path.join(other, skill.skill);
        if (!samePath(destination, there) && directory(other, io) && inspect(there, io)) throw new Error(`${there} would shadow this skill`);
      }
      const before = treeAt(destination, io);
      const old = rows.find(row => samePath(row.destination, destination));
      if (before && (!owned(old) || old.digest !== before.digest)) throw new Error(`${destination} is unmanaged or changed; left in place`);
      if (before?.digest === skill.digest) continue;
      const row = { service: assets.service, skill: skill.skill, harness, source: { ...assets.source, path: `${assets.directory}/${skill.skill}` },
        destination, digest: skill.digest };
      if (!validRow(row)) throw new Error("skill placement has no valid source receipt");
      commit(destination, row, before, skill);
    }
    for (const old of [...rows]) {
      if (!owned(old) || !samePath(path.dirname(old.destination), root) || desired.some(skill => samePath(path.join(root, skill.skill), old.destination))) continue;
      const before = treeAt(old.destination, io);
      if (before && before.digest !== old.digest) throw new Error(`${old.destination} changed; it was not removed`);
      commit(old.destination, null, before, null);
    }
  }
}
