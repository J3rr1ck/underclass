import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

/** Separator between a line's anchor and its text in rendered output. */
const SEP = "│";
/** Max anchor lines echoed back in a listing (whole-file dumps defeat the point). */
const LIST_LIMIT = 40;

function lineHash(line: string): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 8);
}

/**
 * Anchors are derived from line content alone, never from line number, so
 * inserting or deleting lines leaves every other line's anchor intact
 * (UNDER-13). Lines whose text is repeated in the file all carry a 1-based
 * `#n` ordinal, so a bare hash always means "unique in this file".
 */
function anchorsOf(lines: string[]): string[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    const h = lineHash(line);
    totals.set(h, (totals.get(h) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const h = lineHash(line);
    if ((totals.get(h) ?? 0) < 2) return h;
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return `${h}#${n}`;
  });
}

function render(lines: string[], anchors: string[], from: number, to: number): string {
  return lines
    .slice(from, to)
    .map((line, i) => {
      // Mark truncation: an unmarked cut looks like text worth copying as an anchor.
      const shown = line.length > 120 ? `${line.slice(0, 120)}…` : line;
      return `${anchors[from + i]}${SEP}${shown}`;
    })
    .join("\n");
}

/**
 * Accepts an anchor in any of the forms the model plausibly produces: the bare
 * hash, `hash#n`, a whole rendered `hash│text` line, or the literal text of the
 * line itself (so the tool is usable straight off a plain `read`).
 */
function resolveAnchor(
  input: string,
  lines: string[],
  anchors: string[],
  path: string,
): { index: number; viaTrim: boolean } {
  const raw = input.trim();
  const cut = raw.indexOf(SEP);
  const token = (cut === -1 ? raw : raw.slice(0, cut)).trim();
  const hashForm = /^([0-9a-f]{4,64})(?:#(\d+))?$/.exec(token);

  let candidates: number[] = [];
  let ordinal: number | null = null;
  let viaTrim = false;
  if (hashForm) {
    const h = hashForm[1]!;
    ordinal = hashForm[2] ? parseInt(hashForm[2], 10) : null;
    candidates = lines.flatMap((line, i) => (lineHash(line).startsWith(h) ? [i] : []));
  }
  if (candidates.length === 0) {
    // No such hash (or the input was never a hash): read it as the line's text.
    const body = cut === -1 ? raw : raw.slice(cut + 1);
    candidates = lines.flatMap((line, i) => (line === body ? [i] : []));
    if (candidates.length === 0) {
      candidates = lines.flatMap((line, i) => (line.trim() === body.trim() ? [i] : []));
      // Remember HOW we matched. This last-resort pass exists so a model can
      // pass an anchor whose whitespace does not match the file — and the caller
      // then replaced the whole line with new_text verbatim, so the fallback
      // that tolerates a whitespace mismatch was the fallback that destroyed the
      // file's whitespace. See the re-indent in `execute`.
      viaTrim = candidates.length > 0;
    }
  }

  if (candidates.length === 0) {
    const listing = render(lines, anchors, 0, LIST_LIMIT);
    const more = lines.length > LIST_LIMIT ? `\n… ${lines.length - LIST_LIMIT} more line(s)` : "";
    throw new Error(
      `Anchor not found in ${path}: ${input}\nCurrent anchors:\n${listing}${more}\n` +
        `Copy one of the anchors above (the part before ${SEP}) and retry.`,
    );
  }
  if (ordinal !== null) {
    const idx = candidates[ordinal - 1];
    if (idx === undefined) {
      throw new Error(
        `Anchor ${token} has only ${candidates.length} occurrence(s) in ${path}; #${ordinal} does not exist.`,
      );
    }
    return { index: idx, viaTrim };
  }
  if (candidates.length > 1) {
    const options = candidates.map((i) => `${anchors[i]} (line ${i + 1})`).join(", ");
    throw new Error(
      `Anchor ${token} is ambiguous in ${path} — it matches ${candidates.length} lines. ` +
        `Retry with one of: ${options}`,
    );
  }
  return { index: candidates[0]!, viaTrim };
}

export const lineAnchoredEditTool = defineTool({
  name: "line_anchored_edit",
  label: "Line Anchored Edit",
  description:
    "Replace or delete a run of whole lines in a file, addressed by anchor. " +
    "Use this instead of `edit` when you are replacing several consecutive lines, or deleting lines. " +
    `An anchor is the short hash printed before ${SEP} in this tool's output; you may also pass the ` +
    "exact text of the line itself, so you can go straight from a plain `read`. " +
    "Anchors come from line content only: inserting or deleting lines never changes another line's " +
    "anchor, so you can chain edits without re-reading the file (the one exception is duplicate " +
    "lines, which are numbered hash#1, hash#2 in file order). " +
    'Example: {"path":"src/app.ts","start_anchor":"const port = 3000","new_text":"const port = 8080"}. ' +
    'Set new_text to "" to delete the lines outright. ' +
    "Errors change nothing on disk and are recoverable: an unknown anchor is answered with the file's " +
    "current anchors, an ambiguous one with the numbered choices — pick one and retry.",
  promptSnippet: "line_anchored_edit: replace/delete whole lines by stable content anchor",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to cwd" }),
    start_anchor: Type.String({
      description: "Anchor hash, or the exact text, of the FIRST line to replace",
    }),
    end_anchor: Type.Optional(
      Type.String({
        description:
          "Anchor hash, or exact text, of the LAST line to replace (inclusive). Omit to edit one line",
      }),
    ),
    new_text: Type.String({
      description: "Replacement lines (may be multiline). An empty string deletes the range",
    }),
  }),
  execute: async (_toolCallId, params) => {
    const abs = resolve(process.cwd(), params.path);
    if (!existsSync(abs)) throw new Error(`File not found: ${params.path}`);

    const content = readFileSync(abs, "utf8");
    const lines = content.split("\n");
    const anchors = anchorsOf(lines);

    const start = resolveAnchor(params.start_anchor, lines, anchors, params.path);
    const startIdx = start.index;
    const endIdx = params.end_anchor
      ? resolveAnchor(params.end_anchor, lines, anchors, params.path).index
      : startIdx;
    if (endIdx < startIdx) {
      throw new Error("end_anchor is above start_anchor; swap them");
    }

    // "" means delete the range — splitting it would leave a blank line behind.
    const replacement = params.new_text === "" ? [] : params.new_text.split("\n");

    // Re-apply the matched line's indentation when the anchor matched only
    // after trimming and the caller's replacement carries none of its own.
    //
    // The bug this closes: the tool's description invites the triggering input
    // ("you may also pass the exact text of the line itself, so you can go
    // straight from a plain `read`"), the trim pass accepted it, and then the
    // whole line was replaced with new_text verbatim — dedenting it. It
    // reported `lines 2–2 replaced with 1 line(s).` and produced an
    // IndentationError in Python, "missing separator" in a Makefile, and a YAML
    // child promoted out of its parent with its sibling still indented. One turn
    // later the model has to diagnose a syntax error it was told did not happen;
    // in a one-shot unverified run it ships. `hash_edit` on the same input has
    // always been correct, which is worse — a registered alternative works and
    // this tool's own description steers models off it.
    //
    // Scoped to the trim pass on purpose, which in practice means: the HASH
    // form is the escape hatch for a deliberate dedent, and it is the only one.
    // `resolveAnchor` trims its input on entry, so a text anchor copied WITH the
    // file's indentation still misses the `line === body` pass and lands here —
    // verified, not assumed. That is the right default (a model passing line
    // text is being whitespace-approximate either way), and a caller who really
    // means to move a line to column 0 addresses it by hash, where new_text is
    // inserted verbatim.
    if (start.viaTrim && replacement.length > 0 && !/^[ \t]/.test(replacement[0]!)) {
      const indent = /^[ \t]*/.exec(lines[startIdx] ?? "")![0];
      // Every non-empty line, so multi-line new_text keeps its own relative
      // structure and gains the anchor line's base indentation.
      if (indent) for (let i = 0; i < replacement.length; i++) {
        if (replacement[i] !== "") replacement[i] = indent + replacement[i]!;
      }
    }
    const updated = [...lines.slice(0, startIdx), ...replacement, ...lines.slice(endIdx + 1)];
    writeFileSync(abs, updated.join("\n"), "utf8");

    const newAnchors = anchorsOf(updated);
    const from = Math.max(0, startIdx - 2);
    const end = Math.min(updated.length, startIdx + replacement.length + 2);
    // Echo enough of the result to chain the next edit, never the whole insert.
    const to = Math.min(end, from + 14);
    const elided = end > to ? `\n… ${end - to} more changed line(s)` : "";
    const what = replacement.length === 0 ? "deleted" : `replaced with ${replacement.length} line(s)`;
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Edited ${params.path}: lines ${startIdx + 1}–${endIdx + 1} ${what}.\n` +
            `${render(updated, newAnchors, from, to)}${elided}`,
        },
      ],
      details: { startLine: startIdx + 1, endLine: endIdx + 1, lines: updated.length },
    };
  },
});
