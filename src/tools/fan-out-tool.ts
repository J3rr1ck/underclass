import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fanOut, type FanOutReport } from "../fanout.js";
import { createFanOutRunner } from "../runner.js";

interface FanOutToolDetails {
  report: FanOutReport | null;
  error: string | null;
  log: string[];
}

/**
 * In-session delegation: lets the agent fan a set of small, discrete sub-tasks
 * out to child `under` agents, one git worktree + branch each, then merge the
 * results back. This is how under anticipates model clumsiness: the caller
 * decomposes the work into problems small models reliably handle, phrases each
 * imperatively, and monitors the structured report instead of doing one long
 * error-prone pass itself.
 *
 * Guard rails:
 * - Children are spawned with UNDER_FANOUT_DEPTH=1 and do NOT get this tool,
 *   so delegation cannot recurse.
 * - Each child gets a hard timeout; a wedged child fails only its own task.
 * - fanOut() refuses on a dirty tree, duplicate/pre-existing branches, etc. —
 *   those errors are returned to the model as text so it can adapt.
 */
export function createFanOutTool(opts: { modelArgs: string[]; defaultTimeoutSec?: number }) {
  return defineTool({
    name: "fan_out",
    label: "Fan out sub-tasks",
    description:
      "Delegate independent sub-tasks to parallel child agents, each in an isolated git worktree " +
      "on its own branch; committed branches are merged back into the current branch sequentially " +
      "(conflicts leave the branch intact for manual resolution). Use for work that splits into " +
      "small, self-contained, file-level changes. Each prompt must be a complete, imperative " +
      "instruction naming the exact file(s) and change — child agents cannot ask questions. " +
      "Requires a clean working tree: commit your own changes first.",
    promptSnippet: "fan_out: delegate small sub-tasks to parallel child agents",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          branch: Type.String({ description: "New branch name for this sub-task (e.g. fan/fix-header)" }),
          prompt: Type.String({
            description:
              "Complete imperative instruction for the child agent: exact file, exact change, no ambiguity",
          }),
        }),
        { minItems: 1, description: "One entry per independent sub-task" },
      ),
      concurrency: Type.Optional(Type.Number({ description: "Max children at once (default: task count)" })),
      timeoutSec: Type.Optional(Type.Number({ description: "Per-child timeout in seconds (default 300)" })),
      merge: Type.Optional(Type.Boolean({ description: "Merge committed branches back (default true)" })),
    }),
    execute: async (_toolCallId, params) => {
      const lines: string[] = [];
      // The hard per-child timeout is a guard rail, so a model-supplied 0 or a
      // negative must not disable it (falsy) or kill every child instantly.
      const timeoutSec = Math.max(5, params.timeoutSec ?? opts.defaultTimeoutSec ?? 300);
      const runner = createFanOutRunner({
        passthroughArgs: opts.modelArgs,
        timeoutMs: timeoutSec * 1000,
      });
      try {
        const report = await fanOut({
          repoDir: process.cwd(),
          tasks: params.tasks,
          ...(params.concurrency ? { concurrency: params.concurrency } : {}),
          ...(params.merge === false ? { merge: false } : {}),
          runner,
          log: (m) => {
            lines.push(m);
            process.stderr.write(`\x1b[2m[fan_out] ${m}\x1b[0m\n`);
          },
        });
        const summary = [
          `merged: ${report.merged.map((r) => r.branch).join(", ") || "none"}`,
          report.committedNotMerged.length
            ? `committed (not merged): ${report.committedNotMerged.map((r) => r.branch).join(", ")}`
            : "",
          report.conflicted.length
            ? `CONFLICTED (branch preserved, resolve manually): ${report.conflicted.map((r) => r.branch).join(", ")}`
            : "",
          report.empty.length ? `no changes made: ${report.empty.map((r) => r.branch).join(", ")}` : "",
          report.failed.length
            ? `FAILED: ${report.failed.map((r) => `${r.branch} (${r.error})`).join("; ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        const details: FanOutToolDetails = { report, error: null, log: lines };
        return {
          content: [{ type: "text" as const, text: `fan-out complete.\n${summary}` }],
          details,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const details: FanOutToolDetails = { report: null, error: msg, log: lines };
        return {
          content: [
            {
              type: "text" as const,
              text: `fan-out refused: ${msg}\nFix the precondition (e.g. commit pending changes) or do the work directly.`,
            },
          ],
          details,
        };
      }
    },
  });
}
