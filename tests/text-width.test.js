#!/usr/bin/env node
// Width in terminal COLUMNS, not in UTF-16 code units.
//
// THE DEFECT, confirmed by an independent review and measured: a CJK process title measured 78 by
// the old rule and occupied 113 cells. The row ran 33 columns past the right margin, wrapped, and
// the wrapped remainder landed on the row below -- which is where the HINT LINE lives. `frameUpdate`
// then believed that row already held the hint and never repainted it, so the keys stayed off screen
// until something unrelated changed that row. One mis-measured character took out a whole feature.
//
// The old rule was `.replace(SGR, "").length`, and it is wrong three ways:
//
//     翻訳          2 units,  4 cells   East Asian Wide is two columns
//     👍🏽           4 units,  2 cells   an astral pair plus a modifier that adds nothing
//     e + U+0301    2 units,  1 cell    a combining mark is drawn on the character before it
//
// ZERO DEPENDENCIES AND NO HAND-ROLLED CLUSTERING. `Intl.Segmenter` is built into Node and does
// grapheme clustering, so the only thing left to us is the narrow, stable question "is this base
// character two columns wide".

import assert from "node:assert/strict";
import { test } from "node:test";

import { clip, clipToWidth, pad, width } from "../lib/text-width.mjs";

const ESC = String.fromCharCode(27);
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;

// ── width ───────────────────────────────────────────────────────────────────────────────────────

test("POSITIVE CONTROL: plain ASCII is one column per character", () => {
  // Every assertion below says "this is not simply .length". A width() that returned a constant, or
  // zero, would satisfy several of them; this pins the ordinary case first.
  assert.equal(width("hello"), 5);
  assert.equal(width(""), 0);
});

test("EAST ASIAN WIDE IS TWO COLUMNS — the defect", () => {
  assert.equal(width("翻訳"), 4, "a two-character CJK word measured as two columns");
  assert.equal(width("正在编译项目"), 12);
  assert.equal(width("한글"), 4, "Hangul syllables are wide");
  assert.equal(width("ｆｕｌｌ"), 8, "fullwidth Latin is wide");
});

test("an emoji is two columns however many code units it is", () => {
  assert.equal(width("\u{1F680}"), 2, "an astral pair counted as two characters");
  assert.equal(width("\u{1F44D}\u{1F3FD}"), 2, "a skin-tone modifier added a column");
  assert.equal(width("\u{1F468}‍\u{1F4BB}"), 2, "a ZWJ sequence counted its parts separately");
});

test("a combining mark costs nothing — it is drawn on the character before it", () => {
  assert.equal(width("é"), 1);
  assert.equal(width("à́̂"), 1, "three stacked marks are still one column");
});

test("colour costs no columns", () => {
  assert.equal(width(dim("hello")), 5);
  assert.equal(width(`${ESC}[38;2;220;129;97m翻訳${ESC}[0m`), 4);
});

test("control characters draw nothing", () => {
  // Callers strip these, but charging a column for one would silently over-pad whatever slips past.
  assert.equal(width(`a${String.fromCharCode(7)}b`), 2);
});

test("AMBIGUOUS-WIDTH GLYPHS ARE NARROW, and this view is built out of them", () => {
  // A decision with a name on it: `●○❯▶─│·…↑↓` are East Asian AMBIGUOUS -- one column in a Latin
  // locale, two in a CJK one. Windows Terminal, iTerm2 and most others render them narrow by
  // default. A terminal configured ambiguous-as-wide will draw this view's rules at double width;
  // that is a known limit, written down so the next person meets a decision and not a mystery.
  for (const glyph of ["●", "○", "❯", "▶", "─", "│", "·", "…", "↑", "▌", "◌"]) {
    assert.equal(width(glyph), 1, `${glyph} is not being counted as one column`);
  }
});

// ── pad ─────────────────────────────────────────────────────────────────────────────────────────

test("pad measures what will be seen", () => {
  assert.equal(width(pad("翻訳", 8)), 8, "a padded CJK cell is not the width it was asked for");
  assert.equal(width(pad(dim("ab"), 6)), 6);
  assert.equal(pad("already too long", 4), "already too long", "padding truncated instead");
});

// ── clipping ────────────────────────────────────────────────────────────────────────────────────

test("clipping counts columns, so a budget of 4 fits two CJK characters", () => {
  assert.equal(clipToWidth("翻訳エージェント", 4), "翻訳");
  assert.equal(width(clipToWidth("正在编译项目并运行", 10)), 10);
});

test("A WIDE CHARACTER THAT WOULD STRADDLE THE EDGE IS DROPPED, not half-drawn", () => {
  // Terminals differ on what they do with the leftover column. Leaving it blank is the one
  // behaviour that cannot misalign the row.
  const cut = clipToWidth("翻訳エージェント", 5);
  assert.equal(cut, "翻訳", "a wide character was cut in half to fill the budget");
  assert.ok(width(cut) <= 5);
});

test("a grapheme is never split", () => {
  // Half an emoji, or a base character without the accent that belongs to it, is a mangled
  // character rather than a shortened string.
  assert.equal(clipToWidth("a\u{1F468}‍\u{1F4BB}b", 3), "a\u{1F468}‍\u{1F4BB}");
  assert.equal(clipToWidth("éx", 1), "é", "the accent was cut off its letter");
});

test("clip marks a shortening, clipToWidth does not, and both respect the budget", () => {
  assert.equal(clipToWidth("abcdef", 3), "abc");
  assert.equal(clip("abcdef", 3), "ab…");
  assert.equal(width(clip("翻訳エージェント", 5)), 5, "the ellipsis pushed the cell over budget");
  assert.equal(clip("abc", 3), "abc", "an exact fit was shortened");
});

test("a cut inside colour closes it", () => {
  const cut = clip(dim("T".repeat(40)), 10);
  assert.ok(cut.includes(`${ESC}[0m`), "the cut cell leaves its colour open to bleed down the frame");
  assert.equal(width(cut), 10);
});

test("a zero budget yields nothing, and never a stray escape", () => {
  assert.equal(clipToWidth(dim("text"), 0), "");
  assert.equal(clip(dim("text"), 0), "");
});

// ── R10: the cases an independent oracle caught ─────────────────────────────────────────────────
//
// Review measured a row this module ADMITTED as 80 cells occupying 115 under an independent wcwidth,
// and wrapping in pyte. The cause was judging a cluster by its BASE character alone: an
// emoji-presentation selector, a keycap mark and a regional-indicator pair each make a cluster two
// cells wide whatever its base is.

test("EMOJI PRESENTATION IS TWO CELLS, whatever the base character is", () => {
  // U+FE0F asks for the emoji rendering of a character that is TEXT by default. The base is narrow;
  // the cluster is not. Every one of these was counted as one cell.
  assert.equal(width("❤️"), 2, "heart with emoji presentation");
  assert.equal(width("✔️"), 2, "check mark with emoji presentation");
  assert.equal(width("1️⃣"), 2, "keycap 1");
  // ...and the TEXT presentation of the same base stays one cell, which is what makes this a rule
  // about the selector rather than about the character.
  assert.equal(width("❤"), 1, "a bare heart is text presentation and one cell");
});

test("A FLAG IS ONE GRAPHEME AND TWO CELLS", () => {
  // A regional-indicator PAIR is a single grapheme. Counting the pair as two separate narrow
  // characters is the same error in a different costume.
  assert.equal(width("\u{1F1FA}\u{1F1F8}"), 2, "US flag");
  assert.equal(width("\u{1F1FA}\u{1F1F8}\u{1F1EA}\u{1F1FA}"), 4, "two flags are four cells");
});

test("the ranges the table was missing", () => {
  assert.equal(width("\u{1FAE0}"), 2, "melting face — Extended-A was absent entirely");
  assert.equal(width("⌚"), 2, "watch — Emoji_Presentation outside the pictograph blocks");
  assert.equal(width("⭐"), 2, "star");
  assert.equal(width("\u{1F7E0}"), 2, "orange circle");
  // CONTROL: the ambiguous glyphs this view is built from must NOT have become wide.
  for (const glyph of ["●", "○", "❯", "▶", "─", "│", "·", "…", "↑"]) {
    assert.equal(width(glyph), 1, `${glyph} became wide`);
  }
});

test("CLIPPING SEGMENTS THE SAME BYTES WIDTH MEASURES", () => {
  // `width` strips SGR then segments; clipping used to segment the RAW string, so an escape between a
  // letter and its combining mark split one grapheme in two and the accent was dropped. The styled
  // and unstyled forms are the same character and must clip the same way.
  const styled = `e${ESC}[31ḿx`;
  assert.ok(clipToWidth(styled, 1).includes("́"),
    "the accent was cut off its letter because an escape sat between them");
  assert.equal(width(clipToWidth(styled, 1)), 1, "the styled clip is not one column wide");
  assert.equal(width(clipToWidth("éx", 1)), 1);
});
