// On a single GPU, N concurrent agents queue behind each other and inflate
// latency roughly N-fold (measured 2.7x in this repo — see CLAUDE.md, "Fan-out
// costs time, not tokens"). Spreading agents across endpoints is the only real
// fix, but endpoints are rarely equal: a Mac Studio serves several times what a
// laptop does, so "least loaded" must mean lowest inFlight *per unit of
// capacity*, not lowest inFlight. Raw counts would send half the run to the
// slow box and stall the whole fan-out on it.

export interface PoolEntry {
  /** Display name; the model spec as given. */
  label: string;
  /** CLI args appended to a child agent's argv, e.g. ["-m","lmstudio/x","--base-url","http://…"]. */
  args: string[];
  /** Relative capacity; a weight-3 entry absorbs 3x the load of a weight-1. */
  weight: number;
}

/**
 * Providers whose prefix in a spec would defeat an explicit base URL. under's
 * model resolution takes a known-provider prefix as authoritative and routes
 * to THAT provider's configured endpoint — reproduced live: the doc's own
 * former example `lmstudio/model@http://host/v1` sent every completion to the
 * local LM Studio and only discovery probes to the named URL, so the pool
 * "spread" nothing while reporting that it had. A spec with a base URL is
 * therefore rewritten to the `custom` provider, whose endpoint IS the given
 * URL; these prefixes are stripped first so the model id sent to that endpoint
 * is the id it actually serves.
 */
const LOCAL_PROVIDER_PREFIXES = ["custom/", "lmstudio/", "ollama/", "danger/"];

/**
 * Parse "model[@baseUrl][*weight]" — e.g.
 * "google/gemma-4-26b@http://gpu-box.local:1234/v1*3".
 *
 * Split from the right: model ids contain '/' freely but never '@' or '*',
 * so the LAST '*' is the weight separator and the LAST '@' before it starts
 * the base URL. Splitting from the left would amputate at the first '/' of a
 * namespaced model. Without a base URL the spec is passed to `-m` verbatim, so
 * a provider prefix (lmstudio/…) selects that provider's own endpoint; WITH
 * one, the spec is the model id as the endpoint serves it. Errors carry the
 * offending spec verbatim because they surface directly in CLI output, where
 * "bad weight" without the spec that caused it sends the user diffing their
 * own command line.
 */
export function parsePoolSpec(spec: string): PoolEntry {
  let rest = spec.trim();
  let weight = 1;
  const star = rest.lastIndexOf("*");
  if (star !== -1) {
    const raw = rest.slice(star + 1).trim();
    rest = rest.slice(0, star).trim();
    // An integer >= 1, nothing looser: a fractional or zero weight is a typo,
    // and a zero in particular would make the entry unpickable while looking
    // configured.
    if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
      throw new Error(`bad pool spec '${spec}': weight must be an integer >= 1, got '${raw}'`);
    }
    weight = Number(raw);
  }
  let baseUrl: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at !== -1) {
    baseUrl = rest.slice(at + 1).trim();
    rest = rest.slice(0, at).trim();
    if (!baseUrl.startsWith("http")) {
      throw new Error(`bad pool spec '${spec}': base URL must start with http, got '${baseUrl}'`);
    }
  }
  if (!rest) throw new Error(`bad pool spec '${spec}': empty model spec`);
  if (baseUrl === undefined) {
    return { label: rest, args: ["-m", rest], weight };
  }
  // With a base URL the entry must resolve as `custom` — a known-provider
  // prefix would silently win the routing (see LOCAL_PROVIDER_PREFIXES). The
  // `-m custom/…` prefix is authoritative in the child's model resolution, so
  // this also survives a forwarded --lmstudio/--provider in the passthrough.
  let model = rest;
  for (const prefix of LOCAL_PROVIDER_PREFIXES) {
    if (model.startsWith(prefix)) {
      model = model.slice(prefix.length);
      break;
    }
  }
  if (!model) throw new Error(`bad pool spec '${spec}': a provider prefix alone is not a model`);
  return { label: model, args: ["-m", `custom/${model}`, "--base-url", baseUrl], weight };
}

/**
 * Tracks in-flight work per endpoint and hands each new agent the least-loaded
 * one. Deliberately not a queue: the caller already caps concurrency, so pick()
 * never blocks — it only decides *where* the next agent goes.
 */
export class EndpointPool {
  private entries: PoolEntry[];
  private inFlight: number[];

  constructor(entries: PoolEntry[]) {
    if (entries.length === 0) throw new Error("endpoint pool needs at least one entry");
    this.entries = [...entries];
    this.inFlight = entries.map(() => 0);
  }

  /** Least-loaded entry (lowest inFlight/weight; first-listed wins ties). Never blocks. */
  pick(): { entry: PoolEntry; release: () => void } {
    let best = 0;
    for (let i = 1; i < this.entries.length; i++) {
      // Strict `<` keeps ties on the first-listed entry, so listing order is a
      // preference the user controls rather than an accident of iteration.
      if (this.inFlight[i]! / this.entries[i]!.weight < this.inFlight[best]! / this.entries[best]!.weight) {
        best = i;
      }
    }
    this.inFlight[best]!++;
    const idx = best;
    // Idempotent: a finally block and an error path can both reach release(),
    // and a double decrement would leave the entry looking forever underloaded.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.inFlight[idx]!--;
    };
    return { entry: this.entries[idx]!, release };
  }

  /** Current in-flight count per entry, in constructor order (for tests and reports). */
  counts(): number[] {
    return [...this.inFlight];
  }
}
