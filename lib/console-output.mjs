// Where `aify-env attach` writes the stream, and on Windows how the console is told to keep it as sent.
//
// THE DEFECT (2026-09-30), the scrambled herdr pane. ConPTY moves the cursor down with a bare LF, meaning
// "same column". Two converters made it CR+LF on the way into the pane's console: libuv's TTY writer
// (`process.stdout`) and the console's own auto-return while DISABLE_NEWLINE_AUTO_RETURN is clear. So a
// row went back to column 1, and the cells it did not cover kept the old text ("bot-" for "both").
// Measured through the system ConPTY and herdr's bundled one: a raw write to fd 1 keeps the column only
// with that flag set, and needs the UTF-8 output code page or box drawing comes out as mojibake.
//
// SO ON WINDOWS THIS SETS BOTH, IN-PROCESS, and writes raw. Through koffi, an optional dependency like
// node-pty: where it is missing or refuses, the output is exactly what it was before. Not through a
// PowerShell helper sharing the console, which Windows Defender blocked as Trojan:Win32/SuspExec.SE,
// and not by translating LF, which changes some streams and was withdrawn four times (aify-env 1736898).
//
// THE CONSOLE IS HANDED BACK on every way out: `restore()` gives back what is still owed and is a no-op once nothing
// is, and the caller runs it from its exit handler as well as its own paths. A write that fails restores at once and
// falls back. A console whose code page cannot be read is left alone.

import fs from "node:fs";

export const STD_OUTPUT_HANDLE = -11;
export const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x4;
export const DISABLE_NEWLINE_AUTO_RETURN = 0x8;
export const UTF8_CODE_PAGE = 65001;

/** kernel32's five console calls through koffi. Throws when koffi is absent or cannot load them. */
export async function loadConsoleApi(importKoffi = () => import("koffi")) {
  const koffi = (await importKoffi()).default;
  const kernel32 = koffi.load("kernel32.dll");
  // Windows' BOOL is a 4-byte int, not C's one-byte bool, so it is declared as one and compared with 0.
  const getStdHandle = kernel32.func("void* __stdcall GetStdHandle(int32_t nStdHandle)");
  const getConsoleMode = kernel32.func("int32_t __stdcall GetConsoleMode(void* hConsoleHandle, _Out_ uint32_t* lpMode)");
  const setConsoleMode = kernel32.func("int32_t __stdcall SetConsoleMode(void* hConsoleHandle, uint32_t dwMode)");
  const getConsoleOutputCP = kernel32.func("uint32_t __stdcall GetConsoleOutputCP()");
  const setConsoleOutputCP = kernel32.func("int32_t __stdcall SetConsoleOutputCP(uint32_t wCodePageID)");
  return {
    getStdHandle: (which) => getStdHandle(which),
    getConsoleMode(handle) {
      const mode = [0];
      return getConsoleMode(handle, mode) !== 0 ? mode[0] : null;
    },
    setConsoleMode: (handle, mode) => setConsoleMode(handle, mode) !== 0,
    getConsoleOutputCP: () => getConsoleOutputCP(),
    setConsoleOutputCP: (codePage) => setConsoleOutputCP(codePage) !== 0,
  };
}

/**
 * The attach client's output: `{ raw, write(text), restore() }`. `raw` is true only while the console holds the
 * modes this set; otherwise `write` is `fallback` and `restore` does nothing.
 */
export async function openConsoleOutput({
  platform = process.platform,
  isTTY = Boolean(process.stdout.isTTY),
  loadApi = loadConsoleApi,
  writeSync = fs.writeSync,
  fallback = (text) => process.stdout.write(text),
  log = () => {},
} = {}) {
  const plain = { raw: false, write: fallback, restore: () => {} };
  if (platform !== "win32" || !isTTY) return plain;
  let api;
  try {
    api = await loadApi();
  } catch (error) {
    log(`koffi is unavailable (${error?.message ?? error}); writing through stdout, so a herdr pane may shift a row`);
    return plain;
  }
  let handle;
  let mode;
  let codePage;
  try {
    handle = api.getStdHandle(STD_OUTPUT_HANDLE);
    mode = api.getConsoleMode(handle);
    if (mode === null) throw new Error("GetConsoleMode failed");
    // 0 is GetConsoleOutputCP failing, and a code page this cannot give back is one it must not change.
    codePage = api.getConsoleOutputCP();
    if (!codePage) throw new Error("GetConsoleOutputCP failed");
  } catch (error) {
    log(`the console could not be read (${error?.message ?? error}); writing through stdout`);
    return plain;
  }

  // WHAT THIS CHANGED STAYS OWED until the console takes it back: a hand-back that is refused is tried again by the
  // next `restore()`, including the one the caller's exit handler runs, never dropped.
  const owed = { mode: false, codePage: false };
  const handBack = () => {
    const attempt = (part, call) => {
      if (!owed[part]) return;
      try {
        if (call()) owed[part] = false;
      } catch { /* still owed */ }
      if (owed[part]) log(`could not restore the console ${part === "mode" ? "mode" : "code page"}`);
    };
    attempt("mode", () => api.setConsoleMode(handle, mode));
    attempt("codePage", () => api.setConsoleOutputCP(codePage));
  };
  const take = (part, call) => {
    let ok = false;
    try { ok = call(); } catch { /* refused */ }
    // A refused setter may still have applied, so it is owed either way.
    owed[part] = true;
    return ok;
  };
  if (!take("mode", () => api.setConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN))
      || !take("codePage", () => api.setConsoleOutputCP(UTF8_CODE_PAGE))) {
    log("the console would not take its modes; writing through stdout");
    handBack();
    return { raw: false, write: fallback, restore: handBack };
  }

  const output = { raw: true };
  output.restore = () => {
    output.raw = false;
    handBack();
  };
  output.write = (text) => {
    if (!output.raw) return fallback(text);
    const bytes = Buffer.from(text, "utf8");
    let at = 0;
    try {
      while (at < bytes.length) at += writeSync(1, bytes, at, bytes.length - at);
    } catch (error) {
      // HANDED BACK BEFORE ANYTHING ELSE, so a write that failed never leaves the console in our modes. Only the
      // bytes not yet written follow, so nothing is painted twice.
      output.restore();
      log(`a raw console write failed (${error?.code ?? error?.message ?? error}); writing through stdout`);
      fallback(bytes.subarray(at));
    }
  };
  return output;
}
