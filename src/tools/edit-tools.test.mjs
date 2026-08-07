// Edit-tool regression suite: real temp files, no model, no build.
//   node packages/under/src/tools/edit-tools.test.mjs
// Imports the TypeScript sources directly (Node type stripping), so it can
// never pass against a stale dist/.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.features.typescript) {
  // Node < 22.18 needs the flag; re-exec once rather than silently skipping.
  const again = spawnSync(
    process.execPath,
    ["--experimental-strip-types", fileURLToPath(import.meta.url)],
    { stdio: "inherit" },
  );
  if (again.status === null || again.status > 1) {
    console.error(`these tests need Node >= 22.18 (TypeScript type stripping); this is ${process.version}`);
  }
  process.exit(again.status ?? 1);
}

const { createHash } = await import("node:crypto");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join, resolve } = await import("node:path");
const { batchEditTool } = await import("./batch-edit.ts");
const { lineAnchoredEditTool } = await import("./line-anchored-edit.ts");
const { hashEditTool } = await import("../hash-edit.ts");

const root = mkdtempSync(join(tmpdir(), "under-edit-tools-"));
const results = [];

/** Each case runs in its own empty directory, which becomes cwd (the tools resolve from it). */
async function test(name, fn) {
  const dir = join(root, `t${results.length}`);
  mkdirSync(dir);
  process.chdir(dir);
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  FAIL ${name}\n       ${err && err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fileIs(path, expected, msg) {
  const actual = readFileSync(path, "utf8");
  assert(actual === expected, `${msg}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
}

/** Assert the call rejects and that the model-visible message contains `needle`. */
async function rejects(fn, needle, what) {
  try {
    await fn();
  } catch (err) {
    assert(
      String(err.message).includes(needle),
      `${what}: error did not mention ${JSON.stringify(needle)} — got ${JSON.stringify(err.message)}`,
    );
    return;
  }
  throw new Error(`${what}: expected a rejection, the call succeeded`);
}

const text = (res) => res.content[0].text;
/** Replacement-string specials for String.replace — must survive verbatim (UNDER-12). */
const DOLLARS = "$& and $$ and $` and $' and $1";

// ---- UNDER-2: duplicated old_text must reject the whole batch ----
await test("UNDER-2 batch_edit rejects duplicated old_text and writes nothing", async () => {
  writeFileSync("dup.txt", "SAME\nmiddle\nSAME\n");
  writeFileSync("other.txt", "keep\n");
  await rejects(
    () =>
      batchEditTool.execute("t", {
        edits: [
          { path: "dup.txt", old_text: "SAME", new_text: "CHANGED" },
          { path: "other.txt", old_text: "keep", new_text: "touched" },
        ],
      }),
    "matched 2 times",
    "duplicate old_text",
  );
  fileIs("dup.txt", "SAME\nmiddle\nSAME\n", "the offending file must be untouched");
  fileIs("other.txt", "keep\n", "the rest of the batch must be untouched too");
});

await test("batch_edit applies unique edits across files, two of them in one file", async () => {
  writeFileSync("a.txt", "alpha\nbeta\n");
  writeFileSync("b.txt", "gamma\n");
  await batchEditTool.execute("t", {
    edits: [
      { path: "a.txt", old_text: "alpha", new_text: "ALPHA" },
      { path: "a.txt", old_text: "beta", new_text: "BETA" },
      { path: "b.txt", old_text: "gamma", new_text: "GAMMA" },
    ],
  });
  fileIs("a.txt", "ALPHA\nBETA\n", "both edits to one file applied");
  fileIs("b.txt", "GAMMA\n", "second file applied");
});

await test("batch_edit rejects overlapping edits to the same file", async () => {
  writeFileSync("o.txt", "abcdef\n");
  await rejects(
    () =>
      batchEditTool.execute("t", {
        edits: [
          { path: "o.txt", old_text: "abcd", new_text: "X" },
          { path: "o.txt", old_text: "cdef", new_text: "Y" },
        ],
      }),
    "overlaps",
    "overlapping edits",
  );
  fileIs("o.txt", "abcdef\n", "file untouched after an overlap rejection");
});

// ---- T1: one file named two ways must be ONE group ----
// Grouping on the raw path string split them, each group read the ORIGINAL
// content and staged a whole-file rewrite, and the last write clobbered the
// first — reported as complete success. A repo-wide rename is exactly this
// shape, and a model that got ./src/a.ts from `ls` and src/a.ts from `grep`
// produces the drift without trying.
for (const [name, second] of [
  ["a dot-slash prefix", "./t1.txt"],
  ["a traversed path", "sub/../t1.txt"],
  ["an absolute path", null], // filled in below; needs cwd
  ["a different case", "T1.TXT"],
]) {
  await test(`T1 batch_edit does not lose an edit when the file is spelled with ${name}`, async () => {
    writeFileSync("t1.txt", "alpha\nbeta\n");
    mkdirSync("sub", { recursive: true });
    const other = second ?? resolve(process.cwd(), "t1.txt");
    const res = await batchEditTool.execute("t", {
      edits: [
        { path: "t1.txt", old_text: "alpha", new_text: "ALPHA" },
        { path: other, old_text: "beta", new_text: "BETA" },
      ],
    });
    // On a case-sensitive volume "T1.TXT" is genuinely a different (missing)
    // file, so the batch is correctly rejected instead. Either outcome is safe;
    // silently dropping an edit is not.
    fileIs("t1.txt", "ALPHA\nBETA\n", `both edits survive when the second is ${other}`);
    assert(/across 1 file/.test(text(res)), `should report one file, said: ${text(res)}`);
  });
}

await test("T1 five edits are not erased by a sixth under another spelling", async () => {
  writeFileSync("t1b.txt", "1\n2\n3\n4\n5\n6\n");
  await batchEditTool.execute("t", {
    edits: [
      ...["1", "2", "3", "4", "5"].map((d) => ({ path: "t1b.txt", old_text: d, new_text: `X${d}` })),
      { path: "./t1b.txt", old_text: "6", new_text: "X6" },
    ],
  });
  fileIs("t1b.txt", "X1\nX2\nX3\nX4\nX5\nX6\n", "five edits erased by one");
});

await test("T1 the all-or-nothing overlap guard fires across two spellings", async () => {
  writeFileSync("t1c.txt", "hello world\n");
  await rejects(
    () =>
      batchEditTool.execute("t", {
        edits: [
          { path: "t1c.txt", old_text: "hello w", new_text: "XX" },
          { path: "./t1c.txt", old_text: "lo wor", new_text: "YY" },
        ],
      }),
    "overlaps",
    "overlapping edits spelled two ways",
  );
  // Not merely a missed error: unsplit, this produced "helXXrld\n" — corruption
  // under a contract that promises all-or-nothing.
  fileIs("t1c.txt", "hello world\n", "file untouched after a cross-spelling overlap");
});

// ---- T2: the trim fallback must not discard the whitespace it exists to tolerate ----
// The last-resort match is `line.trim() === body.trim()`, so a model can pass an
// anchor whose whitespace does not match the file — which the tool's own
// description invites ("you may also pass the exact text of the line itself, so
// you can go straight from a plain `read`"). Having matched, it replaced the
// WHOLE line with new_text verbatim, dedenting it, and reported success.
await test("T2 line_anchored_edit keeps Python indentation on a trimmed anchor", async () => {
  writeFileSync("m.py", "def f():\n    return 1\n\nprint(f())\n");
  await lineAnchoredEditTool.execute("t", { path: "m.py", start_anchor: "return 1", new_text: "return 2" });
  fileIs("m.py", "def f():\n    return 2\n\nprint(f())\n", "indentation destroyed");
});

await test("T2 line_anchored_edit keeps a Makefile's leading tab", async () => {
  writeFileSync("Makefile", "build:\n\tgcc -O2 -o a a.c\n");
  await lineAnchoredEditTool.execute("t", {
    path: "Makefile",
    start_anchor: "gcc -O2 -o a a.c",
    new_text: "gcc -O3 -o a a.c",
  });
  // Losing this tab is `Makefile:2: *** missing separator.  Stop.`
  fileIs("Makefile", "build:\n\tgcc -O3 -o a a.c\n", "the tab was lost");
});

await test("T2 line_anchored_edit does not promote a YAML child out of its parent", async () => {
  writeFileSync("c.yaml", "root:\n  child: 1\n  other: 2\n");
  await lineAnchoredEditTool.execute("t", { path: "c.yaml", start_anchor: "child: 1", new_text: "child: 9" });
  fileIs("c.yaml", "root:\n  child: 9\n  other: 2\n", "child promoted out of root");
});

await test("T2 multiline new_text keeps its own relative structure", async () => {
  writeFileSync("ml.py", "def f():\n    return 1\n");
  await lineAnchoredEditTool.execute("t", {
    path: "ml.py",
    start_anchor: "return 1",
    new_text: "if x:\n    return 2\nreturn 3",
  });
  fileIs("ml.py", "def f():\n    if x:\n        return 2\n    return 3\n", "relative indentation lost");
});

await test("T2 an indent the caller supplied is respected, not doubled", async () => {
  writeFileSync("o.py", "def f():\n    return 1\n");
  await lineAnchoredEditTool.execute("t", { path: "o.py", start_anchor: "return 1", new_text: "        return 2" });
  fileIs("o.py", "def f():\n        return 2\n", "the caller's own indentation was overridden");
});

await test("T2 a hash anchor still allows a deliberate dedent", async () => {
  writeFileSync("h.py", "def f():\n    return 1\n");
  // The hash form proves the caller is addressing the exact line, so new_text is
  // inserted verbatim — moving a line to column 0 is a real edit and must stay
  // possible. (A TEXT anchor cannot reach this path: resolveAnchor trims its
  // input, so even "    return 1" lands in the trim pass.)
  let hash;
  try {
    await lineAnchoredEditTool.execute("t", { path: "h.py", start_anchor: "nosuchanchor", new_text: "x" });
  } catch (err) {
    hash = err.message.split("\n").find((l) => l.includes("return 1")).split("\u2502")[0].trim();
  }
  assert(hash, "could not read an anchor hash out of the not-found listing");
  await lineAnchoredEditTool.execute("t", { path: "h.py", start_anchor: hash, new_text: "pass" });
  fileIs("h.py", "def f():\npass\n", "a hash anchor must insert new_text verbatim");
});

// ---- UNDER-12: $-patterns must be inserted literally ----
await test("UNDER-12 batch_edit preserves $-patterns verbatim", async () => {
  writeFileSync("d.txt", "before TOKEN after\n");
  await batchEditTool.execute("t", {
    edits: [{ path: "d.txt", old_text: "TOKEN", new_text: DOLLARS }],
  });
  fileIs("d.txt", `before ${DOLLARS} after\n`, "$-patterns must be literal");
});

await test("UNDER-12 hash_edit preserves $-patterns verbatim", async () => {
  writeFileSync("d.txt", "before TOKEN after\n");
  await hashEditTool.execute("t", { path: "d.txt", old_string: "TOKEN", new_string: DOLLARS });
  fileIs("d.txt", `before ${DOLLARS} after\n`, "$-patterns must be literal");
});

await test("UNDER-12 line_anchored_edit preserves $-patterns verbatim", async () => {
  writeFileSync("d.txt", "one\nTOKEN\nthree\n");
  await lineAnchoredEditTool.execute("t", { path: "d.txt", start_anchor: "TOKEN", new_text: DOLLARS });
  fileIs("d.txt", `one\n${DOLLARS}\nthree\n`, "$-patterns must be literal");
});

// ---- UNDER-13: anchors are content-derived, so an insert must not shift them ----
await test("UNDER-13 line_anchored_edit anchors survive an insert above them", async () => {
  writeFileSync("anch.txt", "alpha\nbeta\ngamma\n");
  const first = await lineAnchoredEditTool.execute("t", {
    path: "anch.txt",
    start_anchor: "alpha",
    new_text: "alpha\ninserted",
  });
  fileIs("anch.txt", "alpha\ninserted\nbeta\ngamma\n", "insert applied");

  // The anchor the tool printed for gamma must still address gamma one edit later.
  const gammaLine = text(first)
    .split("\n")
    .find((l) => l.endsWith("│gamma"));
  assert(gammaLine, `result did not echo gamma's anchor:\n${text(first)}`);
  await lineAnchoredEditTool.execute("t", {
    path: "anch.txt",
    start_anchor: gammaLine.split("│")[0],
    new_text: "GAMMA",
  });
  fileIs("anch.txt", "alpha\ninserted\nbeta\nGAMMA\n", "anchor taken before the insert still resolves");
});

await test("UNDER-13 line_anchored_edit deletes a range on empty new_text", async () => {
  writeFileSync("del.txt", "one\ntwo\nthree\nfour\n");
  await lineAnchoredEditTool.execute("t", {
    path: "del.txt",
    start_anchor: "two",
    end_anchor: "three",
    new_text: "",
  });
  fileIs("del.txt", "one\nfour\n", "range removed with no blank line left behind");
});

await test("line_anchored_edit refuses an ambiguous anchor and names the choices", async () => {
  writeFileSync("amb.txt", "dup\nmid\ndup\n");
  const h = createHash("sha256").update("dup").digest("hex").slice(0, 8);
  await rejects(
    () => lineAnchoredEditTool.execute("t", { path: "amb.txt", start_anchor: h, new_text: "X" }),
    `${h}#2`,
    "ambiguous anchor",
  );
  fileIs("amb.txt", "dup\nmid\ndup\n", "file untouched");
  await lineAnchoredEditTool.execute("t", { path: "amb.txt", start_anchor: `${h}#2`, new_text: "X" });
  fileIs("amb.txt", "dup\nmid\nX\n", "the #2 ordinal selects the second occurrence");
});

await test("line_anchored_edit answers an unknown anchor with the file's anchors", async () => {
  writeFileSync("miss.txt", "only\n");
  await rejects(
    () => lineAnchoredEditTool.execute("t", { path: "miss.txt", start_anchor: "deadbeef", new_text: "X" }),
    "Current anchors",
    "unknown anchor",
  );
});

// ---- hash_edit: chaining and staleness ----
await test("hash_edit chains on a fresh hash and rejects a stale one", async () => {
  writeFileSync("h.txt", "value = 1\n");
  const first = await hashEditTool.execute("t", { path: "h.txt", old_string: "1", new_string: "2" });
  const stale = /hash:([0-9a-f]+)/.exec(text(first))[1];

  await hashEditTool.execute("t", {
    path: "h.txt",
    old_string: "2",
    new_string: "3",
    expected_hash: stale,
  });
  fileIs("h.txt", "value = 3\n", "chained edit applied against the fresh hash");

  await rejects(
    () =>
      hashEditTool.execute("t", {
        path: "h.txt",
        old_string: "3",
        new_string: "4",
        expected_hash: stale,
      }),
    "Hash mismatch",
    "stale expected_hash",
  );
  fileIs("h.txt", "value = 3\n", "file untouched after a hash mismatch");
});

await test("hash_edit rejects a non-unique old_string", async () => {
  writeFileSync("h.txt", "x\nx\n");
  await rejects(
    () => hashEditTool.execute("t", { path: "h.txt", old_string: "x", new_string: "y" }),
    "must be unique",
    "duplicate old_string",
  );
  fileIs("h.txt", "x\nx\n", "file untouched");
});

process.chdir(tmpdir());
rmSync(root, { recursive: true, force: true });
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
