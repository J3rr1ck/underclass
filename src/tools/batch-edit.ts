import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

interface PlannedEdit {
  /** 1-based position in the caller's `edits` array, for error messages. */
  n: number;
  start: number;
  end: number;
  newText: string;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Multi-file search/replace in one call. Every edit is matched against the file
 * as it was read, so positions never depend on the order edits are applied.
 * The batch is all-or-nothing: a single bad edit writes no files at all.
 */
export const batchEditTool = defineTool({
  name: "batch_edit",
  label: "Batch Edit Files",
  description:
    "Apply many search/replace edits across several files in ONE call. " +
    "Use this instead of `edit` whenever the same change touches more than one file " +
    "(renames, signature changes, config bumps) — one call instead of one turn per file. " +
    "Each old_text must appear EXACTLY ONCE in its file; if it appears twice, include " +
    "surrounding lines until it is unique. Two edits to the same file must not overlap. " +
    'Example: {"edits":[{"path":"src/a.ts","old_text":"getUser(","new_text":"fetchUser("},' +
    '{"path":"src/b.ts","old_text":"getUser(","new_text":"fetchUser("}]}. ' +
    "new_text is inserted literally — $, \\ and newlines have no special meaning. " +
    "Errors are recoverable and change nothing on disk: the message names the failing edit " +
    "by number, so re-read that file, fix only that edit, and send the batch again.",
  promptSnippet: "batch_edit: one call for the same change across many files (all-or-nothing)",
  parameters: Type.Object({
    edits: Type.Array(
      Type.Object({
        path: Type.String({ description: "File path relative to cwd; the file must already exist" }),
        old_text: Type.String({
          description: "Exact text to replace, copied from the file; must occur exactly once in that file",
        }),
        new_text: Type.String({ description: "Replacement text, inserted literally" }),
      }),
      { minItems: 1, description: "One entry per replacement; several entries may target the same file" },
    ),
    description: Type.Optional(
      Type.String({ description: "One line describing what this batch changes" }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    const errors: string[] = [];
    const staged = new Map<string, { content: string; count: number }>();

    /**
     * Identity of the FILE a path names, not the spelling of the path.
     *
     * Grouping on the raw path string meant two spellings of one file became two
     * groups. Each group read the *original* content and staged a whole-file
     * rewrite, so the last write clobbered the first — and the tool reported
     * every edit applied. Five edits could be erased by one. The all-or-nothing
     * overlap detector did not merely fail to fire across the split; two
     * genuinely overlapping edits spelled two ways corrupted the file outright.
     *
     * `./a.txt`, `x/../a.txt` and an absolute path all reach `resolve()`. `A.TXT`
     * does not: **macOS `realpath(3)` does not case-fold**, so resolving (or
     * `realpathSync`) still splits the exact case that matters most on the
     * platform this is developed on. `dev:ino` is the identity the filesystem
     * itself uses, so it collapses all of them, plus hard links and symlinks.
     *
     * This tool's headline promise is "one call instead of one turn per file",
     * so a repo-wide rename emits exactly this shape — and a model that got
     * `./src/a.ts` from `ls` and `src/a.ts` from `grep` produces the drift
     * without trying.
     */
    const fileIdentity = (p: string): string => {
      const abs = resolve(process.cwd(), p);
      try {
        const st = statSync(abs);
        return `${st.dev}:${st.ino}`;
      } catch {
        // Nonexistent (or unstattable): fall back to the resolved path so the
        // "file not found" error below still fires once per distinct file
        // rather than turning a missing file into an uncaught throw.
        return abs;
      }
    };

    // Group by file, keeping the caller's numbering. The first spelling seen
    // names the group in messages.
    const grouped = new Map<string, { path: string; edits: Array<{ n: number; old_text: string; new_text: string }> }>();
    params.edits.forEach((edit, i) => {
      const key = fileIdentity(edit.path);
      const group = grouped.get(key) ?? { path: edit.path, edits: [] };
      group.edits.push({ n: i + 1, old_text: edit.old_text, new_text: edit.new_text });
      grouped.set(key, group);
    });

    for (const [, { path, edits: fileEdits }] of grouped) {
      const before = errors.length;
      const abs = resolve(process.cwd(), path);
      if (!existsSync(abs)) {
        errors.push(`Edit ${fileEdits.map((e) => e.n).join(", ")}: file not found: ${path}`);
        continue;
      }
      const content = readFileSync(abs, "utf8");

      const planned: PlannedEdit[] = [];
      for (const edit of fileEdits) {
        if (edit.old_text === "") {
          errors.push(`Edit ${edit.n} (${path}): old_text is empty`);
          continue;
        }
        const occurrences = countOccurrences(content, edit.old_text);
        if (occurrences === 0) {
          errors.push(`Edit ${edit.n} (${path}): old_text not found — copy it exactly from the file`);
          continue;
        }
        if (occurrences > 1) {
          errors.push(
            `Edit ${edit.n} (${path}): old_text matched ${occurrences} times, must match exactly once — ` +
              `add surrounding lines until it is unique`,
          );
          continue;
        }
        const start = content.indexOf(edit.old_text);
        planned.push({ n: edit.n, start, end: start + edit.old_text.length, newText: edit.new_text });
      }

      planned.sort((a, b) => a.start - b.start);
      for (let i = 1; i < planned.length; i++) {
        const prev = planned[i - 1]!;
        const cur = planned[i]!;
        if (cur.start < prev.end) {
          errors.push(`Edit ${cur.n} (${path}): overlaps edit ${prev.n}`);
        }
      }
      if (errors.length > before) continue;

      // Apply back-to-front by index splice so earlier offsets stay valid, and
      // never String.replace: replace() treats $&/$'/$$ in the replacement as
      // patterns and silently corrupts the output (UNDER-12).
      let updated = content;
      for (let i = planned.length - 1; i >= 0; i--) {
        const p = planned[i]!;
        updated = updated.slice(0, p.start) + p.newText + updated.slice(p.end);
      }
      staged.set(path, { content: updated, count: planned.length });
    }

    if (errors.length > 0) {
      throw new Error(`Batch rejected, no files were changed:\n${errors.join("\n")}`);
    }

    const written: string[] = [];
    for (const [path, { content, count }] of staged) {
      writeFileSync(resolve(process.cwd(), path), content, "utf8");
      written.push(`  - ${path} (${count} edit(s), hash:${hashContent(content)})`);
    }

    const headline = params.description ? `${params.description}\n` : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `${headline}Applied ${params.edits.length} edit(s) across ${staged.size} file(s):\n${written.join("\n")}`,
        },
      ],
      details: { filesModified: Array.from(staged.keys()) },
    };
  },
});
