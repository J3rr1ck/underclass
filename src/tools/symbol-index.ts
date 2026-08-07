import { execFileSync } from "node:child_process";

/**
 * Lightweight symbol index built via ripgrep.
 * Caches results per working directory (with a short TTL — the agent edits
 * files mid-session, so stale-forever caching returned wrong results).
 *
 * All rg invocations use execFileSync with an argument array: user-controlled
 * values (symbol, glob) are never interpolated into a shell string. A confirmed
 * command injection via the glob parameter existed in the execSync version.
 */
const CACHE_TTL_MS = 30_000;

/** Escape regex metacharacters so a symbol name is matched literally. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rg(args: string[], cwd: string): string {
  try {
    return execFileSync("rg", [...args, "."], {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // rg exits 1 on "no matches" (stdout empty) — treat other failures as empty too
    const e = err as { stdout?: string };
    return e.stdout ?? "";
  }
}

class SymbolIndex {
  private cache = new Map<string, { at: number; symbols: SymbolLocation[] }>();

  private parseSymbols(output: string): SymbolLocation[] {
    const symbols: SymbolLocation[] = [];
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const match = line.match(/^([^:]+):(\d+):(.*)/);
      if (match) {
        symbols.push({
          file: match[1]!,
          line: parseInt(match[2]!, 10),
          text: match[3]!.slice(0, 120),
        });
      }
    }
    return symbols;
  }

  private cached(key: string): SymbolLocation[] | null {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.symbols;
    if (hit) this.cache.delete(key);
    return null;
  }

  /** Find all definitions of a symbol (function, class, const, type…). */
  async findDefinitions(symbol: string, cwd: string, glob?: string): Promise<SymbolLocation[]> {
    const cacheKey = `defs:${cwd}:${symbol}:${glob || "*"}`;
    const hit = this.cached(cacheKey);
    if (hit) return hit;

    const sym = escapeRe(symbol);
    const patterns = [
      `^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(function|def|class|interface|struct|enum|type)\\s+${sym}\\b`,
      `^\\s*(export\\s+)?(const|let|var)\\s+${sym}\\s*[:=]`,
      `^\\s*${sym}\\s*[:=]\\s*(async\\s+)?(function|class|\\(|=>|\\{)`,
    ];

    let output = "";
    for (const pattern of patterns) {
      const globArgs = glob ? ["--glob", glob] : [];
      output += rg(["-n", "-e", pattern, ...globArgs], cwd);
    }

    const symbols = this.parseSymbols(output);
    this.cache.set(cacheKey, { at: Date.now(), symbols });
    return symbols;
  }

  /** Find all call sites of a symbol (references, excluding definition lines). */
  async findCallSites(symbol: string, cwd: string, glob?: string): Promise<SymbolLocation[]> {
    const cacheKey = `calls:${cwd}:${symbol}:${glob || "*"}`;
    const hit = this.cached(cacheKey);
    if (hit) return hit;

    const sym = escapeRe(symbol);
    const pattern = `\\b${sym}\\s*\\(|\\b${sym}\\s*\\.|\\b${sym}\\s*[,\\)\\]]`;
    const globArgs = glob ? ["--glob", glob] : [];
    const output = rg(["-n", "-e", pattern, ...globArgs], cwd);

    const allLines = this.parseSymbols(output);
    const definitions = new Set(
      (await this.findDefinitions(symbol, cwd, glob)).map((s) => `${s.file}:${s.line}`),
    );
    const callSites = allLines.filter((s) => !definitions.has(`${s.file}:${s.line}`));
    this.cache.set(cacheKey, { at: Date.now(), symbols: callSites });
    return callSites;
  }

  /** Clear all cached results for a directory. */
  invalidate(cwd: string) {
    for (const key of this.cache.keys()) {
      if (key.includes(`:${cwd}:`)) this.cache.delete(key);
    }
  }
}

export interface SymbolLocation {
  file: string;
  line: number;
  text: string;
}

export const symbolIndex = new SymbolIndex();
