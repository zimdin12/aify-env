// The files tracked at a folder's HEAD, sent to aify-dashboard when its head report asks (aify-dashboard
// docs/DESIGN-FILE-LIST.md).
//
// A FACT ABOUT THE COMMIT, NEVER THE WORKING TREE: `git ls-tree -r -z --name-only <head>`. A commit's list never
// changes, so a page may be sent again, and the dashboard says whether it already holds the list.
//
// THE BOUNDS ARE THE DASHBOARD'S, agreed with comms-tech-lead (B1-B4, 2026-10-18):
// - B1: a page closes at 2,000 paths or 512 KB of its JSON in UTF-8, whichever comes first;
// - B2: over 50,000 files, nothing is listed and the count is sent as withheld;
// - B3: git runs bounded (`GitReader.trackedFiles`), and a failure sends nothing;
// - B4: a path that is not valid UTF-8 is skipped and counted, never sent lossy.
//
// A LIST FOR A HEAD THE FOLDER HAS LEFT IS DROPPED. The dashboard answers it 409 stale_head, and the next head report
// asks again for the head the folder is at by then.

import { DashboardApiError } from "./dashboard-api.mjs";

export const MAX_PAGE_FILES = 2_000;
/** Measured as the dashboard measures it: the UTF-8 bytes of the page's JSON array. */
export const MAX_PAGE_BYTES = 512 * 1024;
export const MAX_LIST_FILES = 50_000;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** `ls-tree -z` output as paths, and how many were not UTF-8. PURE. */
export function decodeTree(bytes) {
  const files = [];
  let unencodable = 0;
  let start = 0;
  for (let at = 0; at < bytes.length; at += 1) {
    if (bytes[at] !== 0) continue;
    if (at > start) {
      try {
        files.push(UTF8.decode(bytes.subarray(start, at)));
      } catch {
        unencodable += 1;
      }
    }
    start = at + 1;
  }
  // `-z` ends every entry with a NUL, so bytes after the last one are a truncated entry, not a path.
  if (start < bytes.length) unencodable += 1;
  return { files, unencodable };
}

/** The paths in pages, each closed at whichever bound comes first. PURE. */
export function pagesOf(files, { maxFiles = MAX_PAGE_FILES, maxBytes = MAX_PAGE_BYTES } = {}) {
  const pages = [];
  let page = [];
  // `[]` is 2 bytes, and each path adds its JSON plus a comma after the first, all counted in UTF-8: a string's length
  // counts UTF-16 units, and a page of three-byte characters measured that way is three times the bound.
  let bytes = 2;
  for (const path of files) {
    const size = Buffer.byteLength(JSON.stringify(path), "utf8");
    if (page.length > 0 && (page.length >= maxFiles || bytes + size + 1 > maxBytes)) {
      pages.push(page);
      page = [];
      bytes = 2;
    }
    bytes += page.length === 0 ? size : size + 1;
    page.push(path);
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

export class FileListSender {
  #api;
  #git;
  #machineId;
  #reporter;

  constructor({ api, git, machineId, reporter }) {
    this.#api = api;
    this.#git = git;
    this.#machineId = machineId;
    this.#reporter = reporter;
  }

  /**
   * Send the list of `head` for the folder at `path`, read from its judged `places`.
   *
   * @returns {Promise<{kind: "sent", pages: number, files: number} | {kind: "withheld", files: number} | {kind: "stale"}>}
   *   Throws a GitReadError when git could not list the head, and a DashboardApiError for any other refusal.
   */
  async send({ path, places, head, signal }) {
    const { files, unencodable } = decodeTree(await this.#git.trackedFiles(places, head, { signal }));
    const where = { machineId: this.#machineId, worktree: { raw: path, canonical: path }, head, bridgeInstanceId: this.#reporter };
    try {
      if (files.length > MAX_LIST_FILES) {
        await this.#api.sendFileList({ ...where, withheld: { reason: "too_large", fileCount: files.length } }, { signal });
        return { kind: "withheld", files: files.length };
      }
      // No single path outgrows a page: git refuses a path over 4,096 bytes, and a page holds 512 KB.
      const pages = pagesOf(files);
      // An empty commit still has a list: one empty page says so.
      const sent = pages.length === 0 ? [[]] : pages;
      for (const [page, paths] of sent.entries()) {
        await this.#api.sendFileList({ ...where, page, pages: sent.length, files: paths, unencodable }, { signal });
      }
      return { kind: "sent", pages: sent.length, files: files.length };
    } catch (error) {
      if (error instanceof DashboardApiError && error.status === 409 && error.code === "stale_head") return { kind: "stale" };
      throw error;
    }
  }
}
