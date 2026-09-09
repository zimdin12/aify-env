// Does the execution receipt read the FUNCTION, or does it ask the object to describe itself?
//
// REVIEW'S P2, executed rather than argued. `String(fn)` consults the object: an own `toString`, or
// a `Symbol.toPrimitive`, decides the text that gets hashed and looked for in the module. So a
// substitute that never calls the real function could hand back the real function's source and
// publish with module and body digests equal to the real control's and `declaredHere` true.
//
// EACH CARRIER IS PAIRED WITH A CONTROL THAT MUST STILL PASS. A receipt that had stopped
// recognising the real function would be a worse defect than the forgery, and invisible from a run
// that only tries carriers -- so the real imported `startDashboard` is checked in the same run.
//
//   node scripts/control-receipt-forgery.mjs [path to a receipt module]
//
// The optional argument is how the mutant is driven: point it at a copy whose `body` is taken with
// `String(fn)` again and every forgery below is admitted, which is what makes this file evidence
// rather than an assertion.

import { pathToFileURL } from "node:url";
import { startDashboard } from "../lib/dashboard.mjs";

const DASHBOARD_URL = new URL("../lib/dashboard.mjs", import.meta.url).href;
const receiptModule = process.argv[2]
  ? pathToFileURL(process.argv[2]).href
  : new URL("./execution-receipt.mjs", import.meta.url).href;
const { receiptFor } = await import(receiptModule);

/** The real function's intrinsic source, which is what every forgery below tries to borrow. */
const REAL_SOURCE = Function.prototype.toString.call(startDashboard);

/** A function that does NOT render, wearing the real one's source through its own `toString`. */
function forgedToString() {
  const impostor = function startDashboard() { return "not a render"; };
  impostor.toString = () => REAL_SOURCE;
  return impostor;
}

/** The same forgery through the other coercion hook. */
function forgedToPrimitive() {
  const impostor = function startDashboard() { return "not a render"; };
  impostor[Symbol.toPrimitive] = () => REAL_SOURCE;
  return impostor;
}

/** Not a function at all: `String()` accepts it, and an empty body is found in every module. */
function notAFunction() {
  return { name: "startDashboard", toString: () => REAL_SOURCE };
}

const CASES = [
  ["the real imported startDashboard", startDashboard, true],
  ["a non-renderer with an own toString", forgedToString(), false],
  ["a non-renderer with Symbol.toPrimitive", forgedToPrimitive(), false],
  ["an object that is not a function", notAFunction(), false],
];

let wrong = 0;
console.log(`receipt module: ${receiptModule}\n`);
for (const [label, subject, expected] of CASES) {
  let declared;
  let note = "";
  try {
    declared = (await receiptFor(subject, DASHBOARD_URL)).declaredHere;
  } catch (error) {
    // A THROW IS NOT A REFUSAL. The receipt has to answer the question, not fall over on it: a
    // caller wrapping this in a try/catch would read a crash as "no receipt available".
    declared = `THREW ${error?.constructor?.name}`;
    note = ` (${String(error?.message || "").slice(0, 60)})`;
  }
  const ok = declared === expected;
  if (!ok) wrong += 1;
  console.log(`${ok ? "as declared" : "UNEXPECTED "}  declaredHere=${String(declared)}`
    + ` expected=${expected}  ${label}${note}`);
}

console.log(wrong === 0
  ? "\nEvery case matched its declared outcome."
  : `\n${wrong} case(s) did NOT match. The receipt does not bind what this file claims it binds.`);
process.exit(wrong === 0 ? 0 : 1);
