import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { symbolIndex } from "./symbol-index.js";

/**
 * Run ripgrep with an argument array (never a shell string — query/glob are
 * model- and repo-content-controlled) against the working directory.
 * Returns { output, error }: error is set for real rg failures (e.g. invalid
 * regex), not for "no matches" (rg exit 1 with empty output).
 */
function runRg(args: string[], cwd: string = process.cwd(), timeoutMs = 5000): { output: string; error: string | null } {
  try {
    const output = execFileSync("rg", [...args, "."], {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { output, error: null };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (e.status === 1) return { output: e.stdout ?? "", error: null }; // no matches
    return { output: e.stdout ?? "", error: (e.stderr ?? "").trim() || "ripgrep failed" };
  }
}

/**
 * Parse ripgrep output into structured results.
 */
function parseRgOutput(
  output: string,
  maxResults: number = 50,
): Array<{ file: string; line: number; text: string }> {
  const results: Array<{ file: string; line: number; text: string }> = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    // ripgrep default format: file:line:text
    const match = line.match(/^([^:]+):(\d+):(.*)/);
    if (match) {
      results.push({
        file: match[1]!,
        line: parseInt(match[2]!, 10),
        text: match[3]!.slice(0, 100), // truncate long lines
      });
      if (results.length >= maxResults) break;
    }
  }
  return results;
}

export const repoSearchTool = defineTool({
  name: "repo_search",
  label: "Repository Search",
  description:
    "Search the repository for files, functions, classes, or any pattern. " +
    "Useful for discovering all files that need to be modified or all implementations of an interface. " +
    "Type 'definition' finds where a symbol is defined; type 'calls' finds all call sites.",
  promptSnippet: "repo_search: find files, defs, calls, patterns",
  parameters: Type.Object({
    query: Type.String({
      description: "Search term or regex pattern (ripgrep format)",
    }),
    type: Type.Optional(
      Type.Enum(
        ["files", "definition", "calls", "pattern"],
        {
          description:
            "Search type: 'files' lists matching filenames, 'definition' finds function/class defs, 'calls' finds call sites (requires exact name), 'pattern' searches any line",
        },
      ),
    ),
    glob: Type.Optional(
      Type.String({
        description: "Glob filter (e.g., '*.py' or 'src/**/*.ts')",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max results to return (default 50)",
      }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    const type = params.type || "pattern";
    const limit = Math.min(params.limit || 50, 200);
    const globArgs = params.glob ? ["--glob", params.glob] : [];

    let results: Array<{ file: string; line: number; text: string }> = [];
    let rgError: string | null = null;
    const cwd = process.cwd();

    try {
      if (type === "files") {
        // List files, then filter names by the query in JS (case-insensitive)
        const { output, error } = runRg(["--files", ...globArgs], cwd);
        rgError = error;
        const q = params.query.toLowerCase();
        results = output
          .split("\n")
          .filter((f) => f.trim() && f.toLowerCase().includes(q))
          .slice(0, limit)
          .map((f) => ({ file: f, line: 0, text: "" }));
      } else if (type === "definition") {
        results = (await symbolIndex.findDefinitions(params.query, cwd, params.glob)).slice(0, limit);
      } else if (type === "calls") {
        results = (await symbolIndex.findCallSites(params.query, cwd, params.glob)).slice(0, limit);
      } else {
        // Plain pattern search
        const { output, error } = runRg(["-n", "-e", params.query, ...globArgs], cwd);
        rgError = error;
        results = parseRgOutput(output, limit);
      }
    } catch (err) {
      rgError = err instanceof Error ? err.message : String(err);
      results = [];
    }

    const summary = rgError
      ? `Search failed: ${rgError}`
      : results.length === 0
        ? `No matches found for "${params.query}" (type: ${type})`
        : `Found ${results.length} match${results.length === 1 ? "" : "es"}:\n${results
            .map((r) => (r.line ? `${r.file}:${r.line} — ${r.text}` : r.file))
            .join("\n")}`;

    return {
      content: [{ type: "text" as const, text: summary }],
      details: { results, count: results.length },
    };
  },
});
