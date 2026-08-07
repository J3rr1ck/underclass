import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/**
 * Dirac-style hash-anchored search/replace. The returned hash lets the model
 * chain edits to the same file without re-reading it: pass the hash from the
 * previous result as expected_hash and the edit is rejected if the file
 * changed underneath it.
 */
export const hashEditTool = defineTool({
  name: "hash_edit",
  label: "Hash Edit",
  description:
    "Replace one exact snippet of text in a file and return the file's new content hash. " +
    "Use this instead of `edit` when you will make SEVERAL edits to the SAME file in a row: pass the " +
    "hash printed by the previous hash_edit as expected_hash and you never have to re-read the file. " +
    "old_string must appear EXACTLY ONCE in the file; if it appears more than once, add surrounding " +
    "lines until it is unique. " +
    'Example: {"path":"src/app.ts","old_string":"const port = 3000","new_string":"const port = 8080"}. ' +
    "new_string is inserted literally — $, \\ and newlines have no special meaning. " +
    "Errors change nothing on disk and are recoverable: \"not found\" or \"matched N times\" means " +
    "re-read the file and copy the text exactly; \"hash mismatch\" means the file changed underneath " +
    "you — re-read it and retry, omitting expected_hash.",
  promptSnippet: "hash_edit: chained edits to one file without re-reading it (pass expected_hash)",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to cwd" }),
    old_string: Type.String({
      description: "Exact text to replace, copied from the file; must occur exactly once",
    }),
    new_string: Type.String({ description: "Replacement text, inserted literally" }),
    expected_hash: Type.Optional(
      Type.String({
        description: "The hash:… value printed by the previous hash_edit on this file; edit is rejected if it no longer matches",
      }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    const abs = resolve(process.cwd(), params.path);
    if (!existsSync(abs)) throw new Error(`File not found: ${params.path}`);

    const content = readFileSync(abs, "utf8");
    const currentHash = hashContent(content);
    if (params.expected_hash && !currentHash.startsWith(params.expected_hash)) {
      throw new Error(
        `Hash mismatch: expected ${params.expected_hash}, file is now ${currentHash}. Re-read the file.`,
      );
    }

    const occurrences = content.split(params.old_string).length - 1;
    if (occurrences === 0) throw new Error("old_string not found in file");
    if (occurrences > 1) {
      throw new Error(`old_string matched ${occurrences} times; must be unique`);
    }

    // Index splice, NOT String.replace: replace() treats $&/$'/$$ in the
    // replacement as patterns and silently corrupts the output (UNDER-12).
    const idx = content.indexOf(params.old_string);
    const updated =
      content.slice(0, idx) + params.new_string + content.slice(idx + params.old_string.length);
    writeFileSync(abs, updated, "utf8");
    return {
      content: [{ type: "text" as const, text: `Edited ${params.path} (hash:${hashContent(updated)})` }],
      details: {},
    };
  },
});
