"""Writes cases.json, the agent-definition fixture both repositories test against (P0 C1, C3).

WHY PYTHON. The golden canonical bytes and digests are computed here with Python's own json.dumps and
hashlib, not with aify-env's JavaScript encoder: an expectation computed by the code under test is
satisfied by anything that code does. The expected problems are written by hand from the P0 rules.

Run: python tests/fixtures/agent-definitions/make-cases.py   (rewrites cases.json beside it)
"""
import base64
import copy
import hashlib
import json
import os

MAX_SAFE = 2**53 - 1


def agent(**over):
    base = {
        "id": "coder-1", "name": "Coder One", "role": "coder", "harness": "claude", "mode": "managed",
        "workspace": "C:/Docker/project", "model": "", "effort": "", "instructions": "", "env": {},
        "herdrSpace": True,
    }
    base.update(over)
    return base


def body(a=None, **top):
    b = {"version": 1, "agent": a if a is not None else agent()}
    b.update(top)
    return b


def without(d, key):
    d = copy.deepcopy(d)
    del d[key]
    return d


def case(name, file_id, b, problems, population="candidate"):
    return {"name": name, "population": population, "fileId": file_id, "body": b, "problems": sorted(problems)}


def raw(name, text, problems, population="candidate", file_id="coder-1"):
    """A case given as the file's exact TEXT: number tokens and syntax a parsed body cannot carry."""
    return {"name": name, "population": population, "fileId": file_id, "raw": text, "problems": sorted(problems)}


def raw_bytes(name, data, problems, file_id="coder-1"):
    return {"name": name, "population": "candidate", "fileId": file_id,
            "rawBase64": base64.b64encode(data).decode("ascii"), "problems": sorted(problems)}


OP_ID = "0b6c2f4e-8d1a-4c3b-9e7f-1a2b3c4d5e6f"
STORE_FIELDS = {"incarnation": 3, "revision": 7, "operation": OP_ID, "updatedAt": "2026-09-30T10:00:00.123Z"}
BASE_TEXT = json.dumps(body())


def with_text(**replace):
    """The base body's text with `"key": <literal>` spliced in verbatim at the top level."""
    extra = ", ".join(f'"{k}": {v}' for k, v in replace.items())
    return BASE_TEXT[:-1] + ", " + extra + "}"


def same_id(i):
    return body(agent(id=i))


ID_128 = "a" * 128
EMOJI_128 = "\U0001F600" * 128  # 128 code points, 256 UTF-16 units

CASES = [
    # --- valid ---
    case("the base definition", "coder-1", body(), []),
    case("store-owned fields present", "coder-1",
         body(incarnation=3, revision=7, operation="op-1", updatedAt="2026-09-30T10:00:00.123Z"), []),
    case("store-owned fields absent in a hand-made file", "coder-1", body(), []),
    case("hand-typed counters are not validity", "coder-1", body(incarnation=0, revision=-4, operation=5), []),
    case("a 128-emoji name is 128 code points", "coder-1", body(agent(name=EMOJI_128)), []),
    case("non-ASCII name with U+2028, which is not Cc", "coder-1", body(agent(name="\u00dcn\u00efc\u00f8d\u00e9 \u273b \u2028")), []),
    case("POSIX workspace", "coder-1", body(agent(workspace="/home/op/w")), []),
    case("drive workspace with a backslash", "coder-1", body(agent(workspace="D:\\w")), []),
    case("UNC workspace", "coder-1", body(agent(workspace="\\\\srv\\share\\w")), []),
    case("32 env vars, a 4096-byte value", "coder-1",
         body(agent(env={**{f"V{i}": "x" for i in range(31)}, "BIG": "y" * 4096})), []),
    case("instructions of exactly 65536 bytes", "coder-1", body(agent(instructions="z" * 65536)), []),
    case("an applied request", "coder-1", body(appliedRequest="req-0001"), []),
    case("the shortest id", "a", same_id("a"), []),
    case("dots, underscores and dashes", "a.b_c-d", same_id("a.b_c-d"), []),
    case("a 128-character id", ID_128, same_id(ID_128), []),
    case("COM0 is not a device name", "COM0", same_id("COM0"), []),
    case("resident codex, hermes", "coder-1", body(agent(harness="hermes", mode="resident")), []),
    # --- identifiers ---
    case("agent with LF", "agent\n", same_id("agent\n"), ["id: pattern", "agent.id: pattern"]),
    case("agent with CRLF", "agent\r\n", same_id("agent\r\n"), ["id: pattern", "agent.id: pattern"]),
    case("a device name", "CON", same_id("CON"), ["id: reserved-name", "agent.id: reserved-name"]),
    case("a device name before a dot, lower case", "con.txt", same_id("con.txt"),
         ["id: reserved-name", "agent.id: reserved-name"]),
    case("LPT9 before a dot, mixed case", "Lpt9.x", same_id("Lpt9.x"), ["id: reserved-name", "agent.id: reserved-name"]),
    case("a 129-character id", "a" * 129, same_id("a" * 129), ["id: pattern", "agent.id: pattern"]),
    case("a leading dash", "-x", same_id("-x"), ["id: pattern", "agent.id: pattern"]),
    case("a leading dot", ".x", same_id(".x"), ["id: pattern", "agent.id: pattern"]),
    case("the body names another id", "coder-1", body(agent(id="coder-2")), ["agent.id: mismatch"]),
    case("a role with a space", "coder-1", body(agent(role="Bad Role")), ["agent.role: pattern"]),
    # --- text ---
    case("an empty name", "coder-1", body(agent(name="")), ["agent.name: length"]),
    case("a 129-emoji name", "coder-1", body(agent(name="\U0001F600" * 129)), ["agent.name: length"]),
    case("a C1 control (NEL) in the name", "coder-1", body(agent(name="a\u0085b")), ["agent.name: control"]),
    case("a tab in the name", "coder-1", body(agent(name="a\tb")), ["agent.name: control"]),
    case("DEL in the name", "coder-1", body(agent(name="a\u007fb")), ["agent.name: control"]),
    case("a lone surrogate in the name", "coder-1", body(agent(name="a\ud800b")), ["agent.name: malformed-unicode"]),
    case("a lone surrogate in instructions", "coder-1", body(agent(instructions="\udfff")),
         ["agent.instructions: malformed-unicode"]),
    case("an unsupported harness", "coder-1", body(agent(harness="pi")), ["agent.harness: unsupported"]),
    case("an unsupported mode", "coder-1", body(agent(mode="shared")), ["agent.mode: unsupported"]),
    case("a relative workspace", "coder-1", body(agent(workspace="relative/w")), ["agent.workspace: not-absolute"]),
    case("a drive-relative workspace", "coder-1", body(agent(workspace="C:w")), ["agent.workspace: not-absolute"]),
    case("a server with no share", "coder-1", body(agent(workspace="\\\\srv")), ["agent.workspace: not-absolute"]),
    case("instructions one byte over", "coder-1", body(agent(instructions="z" * 65537)), ["agent.instructions: too-large"]),
    case("instructions over in bytes, under in characters", "coder-1", body(agent(instructions="\u273b" * 21846)),
         ["agent.instructions: too-large"]),
    # --- env ---
    case("33 env vars", "coder-1", body(agent(env={f"V{i}": "x" for i in range(33)})), ["agent.env: too-many"]),
    case("an env name starting with a digit", "coder-1", body(agent(env={"1BAD": "x"})), ["agent.env: bad-name"]),
    case("an env name with a newline", "coder-1", body(agent(env={"A\n": "x"})), ["agent.env: bad-name"]),
    case("an aify_ name in lower case", "coder-1", body(agent(env={"aify_x": "x"})), ["agent.env.aify_x: reserved"]),
    case("a number value", "coder-1", body(agent(env={"X": 1})), ["agent.env.X: type"]),
    case("a NUL in a value", "coder-1", body(agent(env={"X": "a\u0000b"})), ["agent.env.X: nul"]),
    case("a 4097-byte value", "coder-1", body(agent(env={"X": "y" * 4097})), ["agent.env.X: too-large"]),
    case("env is a list", "coder-1", body(agent(env=[])), ["agent.env: type"]),
    # --- shape ---
    case("an unknown agent field", "coder-1", body({**agent(), "systemPrompt": "x"}), ["agent.systemPrompt: unknown-field"]),
    case("an unknown top-level field", "coder-1", body(profile="x"), ["profile: unknown-field"]),
    case("an unknown key that cannot be named", "coder-1", body({**agent(), "\u00f1ame": "x"}), ["agent: unknown-field"]),
    case("an unknown top-level key with a lone surrogate", "coder-1", {**body(), "\ud800": 1}, ["file: unknown-field"]),
    case("version 2", "coder-1", body(version=2), ["version: unsupported"]),
    case("version as a string", "coder-1", body(version="1"), ["version: unsupported"]),
    case("version missing", "coder-1", without(body(), "version"), ["version: missing"]),
    case("agent missing", "coder-1", without(body(), "agent"), ["agent: missing"]),
    case("agent is a list", "coder-1", {"version": 1, "agent": []}, ["agent: type"]),
    case("herdrSpace as a string", "coder-1", body(agent(herdrSpace="yes")), ["agent.herdrSpace: type"]),
    case("model missing", "coder-1", body(without(agent(), "model")), ["agent.model: missing"]),
    case("a malformed updatedAt", "coder-1", body(updatedAt="2026-09-30 10:00:00"), ["updatedAt: format"]),
    case("an empty applied request", "coder-1", body(appliedRequest=""), ["appliedRequest: length"]),
    case("a number applied request", "coder-1", body(appliedRequest=5), ["appliedRequest: type"]),
    case("the file is a list", "coder-1", [], ["file: not-an-object"]),
    case("several problems, listed out of order", "coder-1",
         body(agent(name="", harness="pi", env={"aify_q": "x"}), profile=1),
         ["profile: unknown-field", "agent.name: length", "agent.harness: unsupported", "agent.env.aify_q: reserved"]),
    case("env keys that name Object.prototype members", "coder-1",
         body(agent(env={"__proto__": "p", "constructor": "c", "toString": "t"})), []),
    case("an updatedAt the calendar would refuse: the rule is the pattern only", "coder-1",
         body(updatedAt="2026-13-45T99:99:99Z"), []),
    # --- two populations: what a person wrote, and what the store writes and publishes ---
    case("a normalized file", "coder-1", body(**STORE_FIELDS), [], "normalized"),
    case("identity omitted: a candidate for adoption", "coder-1", body(), []),
    case("identity omitted: not a normalized file", "coder-1", body(),
         ["incarnation: missing", "revision: missing", "operation: missing", "updatedAt: missing"], "normalized"),
    case("identity forged: a candidate for adoption", "coder-1", body(incarnation=0, revision=-4, operation=5), []),
    case("identity forged: not a normalized file", "coder-1",
         body(**{**STORE_FIELDS, "incarnation": 0, "revision": -4, "operation": 5}),
         ["incarnation: not-a-counter", "revision: not-a-counter", "operation: format"], "normalized"),
    case("the largest safe counters", "coder-1", body(**{**STORE_FIELDS, "incarnation": MAX_SAFE, "revision": MAX_SAFE}), [], "normalized"),
    case("a boolean counter", "coder-1", body(**{**STORE_FIELDS, "incarnation": True}), ["incarnation: not-a-counter"], "normalized"),
    case("a boolean version", "coder-1", body(version=True), ["version: unsupported"]),
    case("an upper-case operation id", "coder-1", body(**{**STORE_FIELDS, "operation": OP_ID.upper()}), ["operation: format"], "normalized"),
    # --- the text: numbers a parsed value cannot prove, syntax, encoding ---
    raw("version written 1.0", BASE_TEXT.replace('"version": 1', '"version": 1.0'), ["file: non-integer-number"]),
    raw("version written 1e0", BASE_TEXT.replace('"version": 1', '"version": 1e0'), ["file: non-integer-number"]),
    raw("a fraction just under the largest safe integer", with_text(revision="9007199254740990.5"), ["file: non-integer-number"]),
    raw("the largest safe integer plus one", with_text(incarnation="9007199254740992"), ["file: unsafe-integer"]),
    raw("the largest safe integer plus one, normalized",
        with_text(incarnation="9007199254740992", revision="1", operation=f'"{OP_ID}"', updatedAt='"2026-09-30T10:00:00Z"'),
        ["file: unsafe-integer"], "normalized"),
    raw("the largest safe integer, normalized",
        with_text(incarnation="9007199254740991", revision="9007199254740991", operation=f'"{OP_ID}"', updatedAt='"2026-09-30T10:00:00Z"'),
        [], "normalized"),
    raw("a fraction inside a string is text", BASE_TEXT.replace('"model": ""', '"model": "1.5"'), []),
    raw("NaN is not JSON", BASE_TEXT.replace('"version": 1', '"version": NaN'), ["file: not-json"]),
    raw("Infinity is not JSON", BASE_TEXT.replace('"version": 1', '"version": Infinity'), ["file: not-json"]),
    raw("a byte-order mark", "﻿" + BASE_TEXT, ["file: not-json"]),
    raw("trailing text", BASE_TEXT + " x", ["file: not-json"]),
    raw_bytes("a byte that is not UTF-8", BASE_TEXT.encode("utf-8").replace(b'"model": ""', b'"model": "\xff"'), ["file: not-utf8"]),
]


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def golden(value):
    text = canonical(value)
    return {"canonical": text, "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}


# C3: the digest of `agent` alone.
AGENT_VECTORS = [
    {"name": "the base agent", "agent": agent()},
    {"name": "non-ASCII, controls escaped, U+2028 raw, env keys out of order",
     "agent": agent(name="\u00dcn\u00efc\u00f8d\u00e9 \u273b \U0001F600", instructions="a\u0001b\nc\u2028d\"e\\f",
                    env={"ZED": "\u00e9", "ALPHA": "1", "MID": "\t"})},
    {"name": "env keys naming Object.prototype members are kept and sorted like any other",
     "agent": agent(env={"toString": "t", "__proto__": "p", "constructor": "c", "A": "a"})},
]
for v in AGENT_VECTORS:
    v.update(golden(v["agent"]))


def utf16_order(text):
    """UTF-16 code-unit order, which is what JavaScript's string comparison gives. Python's own str
    order is by code point, and the two differ once an id (an invalid entry's filename can hold any
    character) mixes an astral character with one from U+E000-U+FFFF."""
    return text.encode("utf-16-be")


def canonical_entries(entries):
    out = []
    for e in sorted(entries, key=lambda e: utf16_order(e["id"])):
        e = dict(e)
        if "problems" in e:
            e["problems"] = sorted(e["problems"])
        out.append(e)
    return out


SNAPSHOT_VECTORS = [
    {"name": "empty", "entries": []},
    {"name": "invalid filename ids ordered by UTF-16 code unit: U+1F600 before U+E000", "entries": [
        {"id": "", "state": "invalid", "problems": ["id: pattern"]},
        {"id": "\U0001F600", "state": "invalid", "problems": ["id: pattern"]},
    ]},
    {"name": "entries out of order, problems out of order, the largest safe counters", "entries": [
        {"state": "valid", "id": "zeta", "revision": MAX_SAFE, "incarnation": MAX_SAFE,
         "definitionDigest": AGENT_VECTORS[1]["sha256"], "available": True},
        {"id": "Alpha", "state": "invalid", "problems": ["version: unsupported", "agent.name: length", "agent: missing"]},
        {"id": "beta", "state": "valid", "incarnation": 1, "revision": 1,
         "definitionDigest": AGENT_VECTORS[0]["sha256"], "available": False, "unavailableReason": "harness-not-installed"},
    ]},
]
for v in SNAPSHOT_VECTORS:
    v.update(golden(canonical_entries(v["entries"])))

OUT = {
    "_about": "Generated by make-cases.py; do not edit by hand. P0 C1 cases and C3 golden vectors.",
    "cases": CASES,
    "agentVectors": AGENT_VECTORS,
    "snapshotVectors": SNAPSHOT_VECTORS,
}

here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "cases.json"), "w", encoding="ascii", newline="\n") as f:
    # ASCII with escapes: a lone surrogate cannot be written as UTF-8, and the cases carry two.
    json.dump(OUT, f, ensure_ascii=True, indent=1)
    f.write("\n")
print(f"{len(CASES)} cases, {len(AGENT_VECTORS)} agent vectors, {len(SNAPSHOT_VECTORS)} snapshot vectors")
