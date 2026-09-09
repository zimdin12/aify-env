// What was actually invoked, bound to the source it claims to come from.
//
// WHY THIS EXISTS. Review's standing objection to every figure these probes publish is that "the
// import line alone is only one link". A file importing `startDashboard` and timing it establishes
// where the NAME came from and nothing about the OBJECT that ran -- a probe that had been handed a
// replacement would look identical, and no predicate over the frames it produced can separate a
// non-renderer that lays the right rows out itself from the real thing. That is a genuine
// impossibility, agreed on both sides, and it is why provenance has to be established at the source
// rather than from the output.
//
// THE CHAIN, and each link is checkable:
//
//   1. the module URL the import RESOLVED to, which is a path rather than a specifier
//   2. the sha256 of that file's bytes on disk
//   3. the sha256 of the function object's OWN source, via `Function.prototype.toString`
//   4. that (3) appears VERBATIM inside (2)
//
// Link 4 is the one that carries the weight. A replacement function hashes differently at 3 and is
// not found in 2, whatever the import line says. It is not a proof that the bytes on disk are the
// bytes anyone reviewed -- that is what the sha256 is for, quoted beside the figures so a reader can
// compare it against their own copy.
//
// WHAT IT IS STILL NOT. It does not prove the function was CALLED, and nothing in-process can: a
// caller could hold the receipt and invoke something else. What the probes add beside it is the
// collaborators' own recorded effects -- bytes written, requests issued -- which only the injected
// `write` and `fetchImpl` can produce and which only exist inside the timed bracket.
//
// SEPARATE FROM THE FRAME CHECK ON PURPOSE. The frame check answers "is this frame this frame". This
// answers "is this function that function". Neither substitutes for the other, and review asked for
// the second as its own block rather than folded into the first.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Bind one imported function to the module it claims to come from.
 *
 * @param {Function} fn the function object that will actually be called
 * @param {string} moduleUrl the `import.meta.url`-style URL of the module it was imported from
 * @returns {Promise<object>} the receipt, including `declaredHere` -- FALSE is the refusal
 */
export async function receiptFor(fn, moduleUrl) {
  const path = fileURLToPath(moduleUrl);
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  // THE INTRINSIC, NOT WHATEVER THE OBJECT SAYS ABOUT ITSELF. `String(fn)` consults the object:
  // an own `toString`, or a `Symbol.toPrimitive`, decides the text that gets hashed and looked for
  // below -- so a substitute that never calls the real function can hand back the real function's
  // source and publish. Review drove exactly that through both probes: forged `toString` and forged
  // `Symbol.toPrimitive`, module and body digests equal to the real control's, `declaredHere` true.
  // `Function.prototype.toString.call` reads the function's own source text and cannot be answered
  // by the object under test.
  //
  // THIS FIXES THE SPOOF, NOT PROVENANCE IN GENERAL. Intrinsic source membership is still narrower
  // than resolved-export identity, than the identity of the object actually invoked, and than the
  // provenance of what that object depends on. The receipt claims the first only.
  //
  // AND IT FAILS CLOSED ON A NON-FUNCTION. `Function.prototype.toString` throws on one, and an
  // empty body would otherwise be found in every module -- `includes("")` is true -- so a callable
  // object that is not a function would have published with the strongest possible receipt.
  const isFunction = typeof fn === "function";
  const body = isFunction ? Function.prototype.toString.call(fn) : "";
  return {
    name: typeof fn?.name === "string" ? fn.name : "",
    module: path,
    moduleSha256: createHash("sha256").update(bytes).digest("hex"),
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    bodyChars: body.length,
    // THE LINK THAT MATTERS. A function handed in from somewhere else hashes differently above and
    // is not found here, whatever name it answers to.
    declaredHere: isFunction && body.length > 0 && text.includes(body),
  };
}

/** The receipt as lines a report can print, shortest identifying prefix of each digest. */
export function receiptLines(receipt) {
  return [
    `EXECUTION RECEIPT for ${receipt.name}:`,
    `  module      ${receipt.module}`,
    `  module      sha256 ${receipt.moduleSha256}`,
    `  body        sha256 ${receipt.bodySha256} (${receipt.bodyChars} chars)`,
    `  declared    ${receipt.declaredHere ? "the body appears VERBATIM in that module"
      : "THE BODY IS NOT IN THAT MODULE"}`,
  ];
}
