/**
 * Run BM25 (always) and optional live Jev across roster tiers 50/100/200/500.
 *
 * Usage:
 *   bun bench/run.ts --skills-dir ../pi-jev-skill-suggestion-fixture/.pi/skills
 *   bun bench/run.ts --skills-dir ... --jev          # needs TYPESAFE_API_KEY
 *   bun bench/run.ts --skills-dir ... --tiers 50,100
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { suggest } from "pi-jev-skill-suggestion/src/router.ts";
import {
  ROSTER_TIERS,
  SHORT_GUIDANCE,
  approxTokens,
  bm25Route,
  costForPred,
  formatSkillListing,
  loadRoster,
  meterClient,
  outcomeOf,
  parseCases,
  predFromSuggestion,
  sampleRoster,
  summarize,
  type Arm,
  type BenchCase,
  type Pred,
  type RosterSkill,
} from "./lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

type Row = {
  tier: number;
  caseId: string;
  category: BenchCase["category"];
  label: string | null;
  arm: Arm;
  pred: string | null;
  outcome: ReturnType<typeof outcomeOf>;
  reason: string;
  jevCalls: number;
  jevInputTokens: number;
  jevOutputTokens: number;
  latencyMs: number;
  listingTokens: number;
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

function rowFrom(
  tier: number,
  c: BenchCase,
  pred: Pred,
  listingTokens: number,
  guidanceTokens: number,
): Row {
  const cost = costForPred(pred.arm, listingTokens, guidanceTokens, pred);
  return {
    tier,
    caseId: c.id,
    category: c.category,
    label: c.label,
    arm: pred.arm,
    pred: pred.skill,
    outcome: outcomeOf(c.label, pred.skill),
    reason: pred.reason,
    jevCalls: pred.jevCalls,
    jevInputTokens: pred.jevInputTokens,
    jevOutputTokens: pred.jevOutputTokens,
    latencyMs: pred.latencyMs,
    listingTokens: cost.listingTokens,
    savedTokens: cost.savedTokens,
    A_naive_usd: cost.A_naive_usd,
    A_warm_usd: cost.A_warm_usd,
    A_cold_usd: cost.A_cold_usd,
    B_jev_usd: cost.B_jev_usd,
    C_tool_usd: cost.C_tool_usd,
    net_naive_usd: cost.net_naive_usd,
    net_warm_usd: cost.net_warm_usd,
    net_cold_usd: cost.net_cold_usd,
  };
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(6)}`;
}

function reportMarkdown(rows: Row[]): string {
  const tiers = [...new Set(rows.map((r) => r.tier))].sort((a, b) => a - b);
  const arms = [...new Set(rows.map((r) => r.arm))];
  const lines: string[] = [
    "# Bench report",
    "",
    `Cases: ${new Set(rows.map((r) => r.caseId)).size}`,
    `Tiers: ${tiers.join(", ")}`,
    `Arms: ${arms.join(", ")}`,
    "",
    "Token counts are chars/4 (relative). USD uses documented assumptions in `bench/lib.ts` (main $3/MTok; cache read 0.1x; cache write 1.25x; Jev $0.042/MTok).",
    "",
  ];

  for (const tier of tiers) {
    lines.push(`## Roster ${tier}`, "");
    for (const arm of arms) {
      const slice = rows.filter((r) => r.tier === tier && r.arm === arm);
      if (!slice.length) continue;
      const score = summarize(slice.map((r) => ({ category: r.category, label: r.label, pred: r.pred })));
      const sum = (k: keyof Row) => slice.reduce((a, r) => a + (r[k] as number), 0);
      lines.push(`### ${arm}`, "");
      lines.push(
        `| metric | value |`,
        `| --- | --- |`,
        `| exact (hit+none) | ${score.exact}/${score.n} (${((100 * score.exact) / score.n).toFixed(1)}%) |`,
        `| wrong_skill | ${score.wrong_skill} |`,
        `| false_load | ${score.false_load} |`,
        `| miss | ${score.miss} |`,
        `| listing tokens | ${slice[0]!.listingTokens} |`,
        `| Σ A_naive | ${fmtUsd(sum("A_naive_usd"))} |`,
        `| Σ A_warm | ${fmtUsd(sum("A_warm_usd"))} |`,
        `| Σ B_jev | ${fmtUsd(sum("B_jev_usd"))} |`,
        `| Σ C_tool | ${fmtUsd(sum("C_tool_usd"))} |`,
        `| Σ net_warm | ${fmtUsd(sum("net_warm_usd"))} |`,
        `| Σ net_cold | ${fmtUsd(sum("net_cold_usd"))} |`,
        `| median latency ms | ${median(slice.map((r) => r.latencyMs)).toFixed(1)} |`,
        "",
      );
      lines.push(`By category:`, "");
      lines.push(`| category | n | exact | false_load | wrong_skill | miss |`);
      lines.push(`| --- | --- | --- | --- | --- | --- |`);
      for (const [cat, b] of Object.entries(score.byCategory).sort()) {
        lines.push(`| ${cat} | ${b.n} | ${b.exact} | ${b.false_load} | ${b.wrong_skill} | ${b.miss} |`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

async function runBm25(cases: BenchCase[], roster: RosterSkill[], tier: number): Promise<Row[]> {
  const listingTokens = approxTokens(formatSkillListing(roster));
  const guidanceTokens = approxTokens(SHORT_GUIDANCE);
  return cases.map((c) => {
    const t0 = performance.now();
    const r = bm25Route(c.request, roster);
    const pred: Pred = {
      arm: "bm25",
      skill: r.skill,
      reason: r.reason,
      jevCalls: 0,
      jevInputTokens: 0,
      jevOutputTokens: 0,
      latencyMs: performance.now() - t0,
    };
    return rowFrom(tier, c, pred, listingTokens, guidanceTokens);
  });
}

async function runJev(
  cases: BenchCase[],
  roster: RosterSkill[],
  tier: number,
  arm: "jev-tool" | "jev-auto",
): Promise<Row[]> {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) throw new Error("TYPESAFE_API_KEY required for --jev");
  const listingTokens = approxTokens(formatSkillListing(roster));
  const guidanceTokens = approxTokens(SHORT_GUIDANCE);
  const raw = new TypeSafeClient({ apiKey: key });
  const rows: Row[] = [];
  for (const c of cases) {
    const metered = meterClient(raw);
    const t0 = performance.now();
    const result = await suggest(metered.client, c.request, roster);
    const pred = predFromSuggestion(arm, result, metered.usage, performance.now() - t0);
    // auto: every prompt pays Jev, no tool overhead → arm tag drives C=0 in costForPred
    rows.push(rowFrom(tier, c, pred, listingTokens, guidanceTokens));
  }
  return rows;
}

async function main() {
  const skillsDir = resolve(
    arg("--skills-dir") ??
      process.env.SKILLS_DIR ??
      join(HERE, "../pi-jev-skill-suggestion-fixture/.pi/skills"),
  );
  const casesPath = resolve(arg("--cases") ?? join(HERE, "cases.jsonl"));
  const outDir = resolve(arg("--out") ?? join(HERE, "out"));
  const wantJev = has("--jev");
  const tierArg = arg("--tiers");
  const tiers = (tierArg ? tierArg.split(",").map((s) => Number(s.trim())) : [...ROSTER_TIERS]).filter(
    (n) => Number.isFinite(n) && n > 0,
  );
  const seed = Number(arg("--seed") ?? 42);

  const cases = parseCases(await readFile(casesPath, "utf8"));
  const full = await loadRoster(skillsDir);
  console.error(`roster full=${full.length} cases=${cases.length} tiers=${tiers.join(",")}`);

  const all: Row[] = [];
  for (const tier of tiers) {
    const roster = sampleRoster(full, cases, tier, seed);
    console.error(`tier ${tier}: roster=${roster.length}`);
    all.push(...(await runBm25(cases, roster, tier)));
    if (wantJev) {
      // Same suggest() path; tag once as jev-tool (C>0) — auto cost view is same B, C=0 via separate tag if needed later
      all.push(...(await runJev(cases, roster, tier, "jev-tool")));
      // Derive auto cost rows from the same preds with arm flipped (same B, C=0)
      const toolRows = all.filter((r) => r.tier === tier && r.arm === "jev-tool");
      for (const r of toolRows) {
        const pred: Pred = {
          arm: "jev-auto",
          skill: r.pred,
          reason: r.reason,
          jevCalls: r.jevCalls,
          jevInputTokens: r.jevInputTokens,
          jevOutputTokens: r.jevOutputTokens,
          latencyMs: r.latencyMs,
        };
        const c = cases.find((x) => x.id === r.caseId)!;
        all.push(rowFrom(tier, c, pred, r.listingTokens, approxTokens(SHORT_GUIDANCE)));
      }
    }
  }

  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(outDir, `results-${stamp}.json`);
  const mdPath = join(outDir, `results-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify({ tiers, seed, skillsDir, rows: all }, null, 2)}\n`);
  await writeFile(mdPath, reportMarkdown(all));
  console.log(mdPath);
  console.error(`wrote ${jsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
