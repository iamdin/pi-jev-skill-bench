/**
 * Benchmark helpers: roster load, BM25 baseline, score, cache-aware cost.
 *
 * Token counts use chars/4 (relative; not a billed tokenizer).
 * USD prices are documented assumptions — swap in cost.ts constants if needed.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RosterSkill, SuggestClient, Suggestion } from "pi-jev-skill-suggestion/src/router.ts";

export type { RosterSkill };

export type Category = "clear" | "near-miss" | "quiet" | "adversarial";
export type Label = { skill: string | null }; // null = none

export type BenchCase = {
  id: string;
  category: Category;
  request: string;
  /** Expected skill name, or null for quiet / no skill. */
  label: string | null;
  /** Assigned before any run. Inspect dev; do not retune on test. */
  split?: "dev" | "test";
};

export type Arm = "bm25" | "jev-tool" | "jev-auto";

export type Pred = {
  arm: Arm;
  skill: string | null;
  reason: string;
  jevCalls: number;
  jevInputTokens: number;
  jevOutputTokens: number;
  latencyMs: number;
};

export type Outcome =
  | "hit"
  | "none_hit"
  | "wrong_skill"
  | "false_load"
  | "miss";

/** Approx tokens — relative, not vendor-billed. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatSkillListing(roster: RosterSkill[]): string {
  const body = roster
    .map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`)
    .join("\n");
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use them when they match the user's request.",
    "",
    "<available_skills>",
    body,
    "</available_skills>",
  ].join("\n");
}

export const SHORT_GUIDANCE = `## Skills

Skills are not listed in this prompt. When a task may need a specialized skill workflow, call the \`skill_suggest\` tool with the task. If it returns a skill, read that skill's file and follow it. If it returns none, continue without a skill.`;

/** Documented price assumptions (USD per million tokens). */
export const PRICE = {
  /** Main-model full input (no cache). */
  mainInputPerMTok: 3.0,
  /** Cache write multiplier vs full input (Anthropic-style ~1.25x). */
  cacheWriteMult: 1.25,
  /** Cache read multiplier vs full input (Anthropic-style ~0.1x). */
  cacheReadMult: 0.1,
  /** TypeSafe Jev input (USD 42 / billion ≈ 0.042 / million). */
  jevInputPerMTok: 0.042,
  /** TypeSafe Jev output — same ballpark until billed separately. */
  jevOutputPerMTok: 0.042,
} as const;

/** Extra main-model tokens for one skill_suggest tool call + result (estimate). */
export const TOOL_OVERHEAD_TOKENS = 280;

export type CostBreakdown = {
  listingTokens: number;
  guidanceTokens: number;
  savedTokens: number;
  A_naive_usd: number;
  A_warm_usd: number;
  A_cold_usd: number;
  B_jev_usd: number;
  C_tool_usd: number;
  net_naive_usd: number;
  net_warm_usd: number;
  net_cold_usd: number;
};

export function costForPred(
  arm: Arm,
  listingTokens: number,
  guidanceTokens: number,
  pred: Pred,
): CostBreakdown {
  const saved = Math.max(0, listingTokens - guidanceTokens);
  const A_naive = (saved / 1e6) * PRICE.mainInputPerMTok;
  const A_warm = (saved / 1e6) * PRICE.mainInputPerMTok * PRICE.cacheReadMult;
  const A_cold = (saved / 1e6) * PRICE.mainInputPerMTok * PRICE.cacheWriteMult;

  const B =
    (pred.jevInputTokens / 1e6) * PRICE.jevInputPerMTok +
    (pred.jevOutputTokens / 1e6) * PRICE.jevOutputPerMTok;

  // tool: pay overhead when a suggest call happened (bm25 never; auto has no tool round-trip)
  const C =
    arm === "jev-tool" && pred.jevCalls > 0
      ? (TOOL_OVERHEAD_TOKENS / 1e6) * PRICE.mainInputPerMTok
      : 0;

  return {
    listingTokens,
    guidanceTokens,
    savedTokens: saved,
    A_naive_usd: A_naive,
    A_warm_usd: A_warm,
    A_cold_usd: A_cold,
    B_jev_usd: B,
    C_tool_usd: C,
    net_naive_usd: A_naive - B - C,
    net_warm_usd: A_warm - B - C,
    net_cold_usd: A_cold - B - C,
  };
}

export function outcomeOf(label: string | null, pred: string | null): Outcome {
  if (label === null && pred === null) return "none_hit";
  if (label === null && pred !== null) return "false_load";
  if (label !== null && pred === null) return "miss";
  if (label !== null && pred === label) return "hit";
  return "wrong_skill";
}

export type ScoreSummary = {
  n: number;
  hit: number;
  none_hit: number;
  wrong_skill: number;
  false_load: number;
  miss: number;
  exact: number; // hit + none_hit
  byCategory: Record<string, { n: number; exact: number; false_load: number; wrong_skill: number; miss: number }>;
};

export function summarize(
  rows: Array<{ category: Category; label: string | null; pred: string | null }>,
): ScoreSummary {
  const byCategory: ScoreSummary["byCategory"] = {};
  const tallies = { hit: 0, none_hit: 0, wrong_skill: 0, false_load: 0, miss: 0 };
  for (const row of rows) {
    const o = outcomeOf(row.label, row.pred);
    tallies[o]++;
    const bucket = (byCategory[row.category] ??= {
      n: 0,
      exact: 0,
      false_load: 0,
      wrong_skill: 0,
      miss: 0,
    });
    bucket.n++;
    if (o === "hit" || o === "none_hit") bucket.exact++;
    if (o === "false_load") bucket.false_load++;
    if (o === "wrong_skill") bucket.wrong_skill++;
    if (o === "miss") bucket.miss++;
  }
  const n = rows.length;
  return {
    n,
    ...tallies,
    exact: tallies.hit + tallies.none_hit,
    byCategory,
  };
}

const STOP = new Set(
  `a an the this that these those to of in on for from with and or is are be it its as at by my me i you your please not do does no into using use their them then than just only can should would could what which how when where who why`.split(
    " ",
  ),
);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((t) => !STOP.has(t) && t.length > 1) ?? [];
}

/** Okapi BM25 over skill name + description. */
export function bm25Route(
  request: string,
  roster: RosterSkill[],
  opts: { k1?: number; b?: number; minScore?: number } = {},
): { skill: string | null; score: number; reason: string } {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  const minScore = opts.minScore ?? 1.5;

  const docs = roster.map((s) => ({
    name: s.name,
    terms: tokens(`${s.name.replace(/-/g, " ")} ${s.description}`),
  }));
  const N = docs.length;
  if (!N) return { skill: null, score: 0, reason: "empty roster" };

  const avgdl = docs.reduce((a, d) => a + d.terms.length, 0) / N;
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const q = tokens(request);
  let bestName: string | null = null;
  let best = -Infinity;
  let second = -Infinity;

  for (const d of docs) {
    const tf = new Map<string, number>();
    for (const t of d.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = f + k1 * (1 - b + (b * d.terms.length) / avgdl);
      score += idf * ((f * (k1 + 1)) / denom);
    }
    if (score > best) {
      second = best;
      best = score;
      bestName = d.name;
    } else if (score > second) {
      second = score;
    }
  }

  if (best < minScore) return { skill: null, score: best, reason: `bm25 ${best.toFixed(2)} < ${minScore}` };
  return { skill: bestName, score: best, reason: `bm25 ${best.toFixed(2)} (margin ${(best - second).toFixed(2)})` };
}

export async function loadRoster(skillsDir: string): Promise<RosterSkill[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const out: RosterSkill[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const filePath = join(skillsDir, ent.name, "SKILL.md");
    try {
      const raw = await readFile(filePath, "utf8");
      let name = ent.name;
      let description = "";
      if (raw.startsWith("---")) {
        const end = raw.indexOf("---", 3);
        const header = end === -1 ? "" : raw.slice(3, end);
        for (const line of header.split("\n")) {
          const mName = line.match(/^name:\s*(.*)$/i);
          const mDesc = line.match(/^description:\s*(.*)$/i);
          if (mName) name = mName[1]!.trim().replace(/^["']|["']$/g, "");
          if (mDesc) description = mDesc[1]!.trim().replace(/^["']|["']$/g, "");
        }
      }
      if (!description) description = name;
      out.push({ name, description, filePath });
    } catch {
      // skip broken skill dirs
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function parseCases(jsonl: string): BenchCase[] {
  return jsonl
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => JSON.parse(l) as BenchCase);
}

/** Roster size tiers for the 50–500 sweep. */
export const ROSTER_TIERS = [50, 100, 200, 500] as const;
export type RosterTier = (typeof ROSTER_TIERS)[number];

/** Deterministic mulberry32. */
function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a tier roster that always includes every labeled skill from cases,
 * then fills the rest with a seeded sample from the full catalogue.
 */
export function sampleRoster(
  full: RosterSkill[],
  cases: BenchCase[],
  size: number,
  seed = 42,
): RosterSkill[] {
  if (size < 1) throw new Error(`roster size must be >= 1, got ${size}`);
  if (size > full.length) {
    throw new Error(`roster size ${size} > full catalogue ${full.length}`);
  }

  const byName = new Map(full.map((s) => [s.name, s]));
  const required = new Set<string>();
  for (const c of cases) {
    if (c.label) {
      if (!byName.has(c.label)) throw new Error(`case ${c.id}: label skill missing: ${c.label}`);
      required.add(c.label);
    }
  }
  if (required.size > size) {
    throw new Error(`need ${required.size} labeled skills but tier size is ${size}`);
  }

  const picked = [...required].map((n) => byName.get(n)!);
  const rest = full.filter((s) => !required.has(s.name));
  const rand = rng(seed);
  // Fisher–Yates with seeded rng
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  picked.push(...rest.slice(0, size - required.size));
  picked.sort((a, b) => a.name.localeCompare(b.name));
  return picked;
}

export function meterClient(inner: SuggestClient): {
  client: SuggestClient;
  usage: { calls: number; input: number; output: number };
} {
  const usage = { calls: 0, input: 0, output: 0 };
  const client = {
    async systemOne(request: Parameters<SuggestClient["systemOne"]>[0], options?: Parameters<SuggestClient["systemOne"]>[1]) {
      const res = await inner.systemOne(request, options);
      usage.calls++;
      usage.input += res.usage.input_tokens;
      usage.output += res.usage.output_tokens;
      return res;
    },
  } as SuggestClient;
  return { usage, client };
}

export function predFromSuggestion(arm: Arm, result: Suggestion, usage: { calls: number; input: number; output: number }, latencyMs: number): Pred {
  return {
    arm,
    skill: result.skill,
    reason: result.reason,
    jevCalls: usage.calls,
    jevInputTokens: usage.input,
    jevOutputTokens: usage.output,
    latencyMs,
  };
}
