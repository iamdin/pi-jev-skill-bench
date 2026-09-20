# madeye/pi-jev skill suite

Copied from [madeye/pi-jev](https://github.com/madeye/pi-jev) `scripts/bench-local.ts` and `scripts/eval-live.ts` (2026-09-20). Three synthetic skills, five requests. Their raw `results/*.json` files are gitignored upstream; the numbers below are transcribed from [VALIDATION.md](https://github.com/madeye/pi-jev/blob/main/VALIDATION.md).

Their protocol is **not** this repo's protocol. They asked a local model to name a skill, with an optional Jev hint (`suggestSkill`). They did not strip a large roster.

## Their published run (2026-09-18/19)

| | baseline | hybrid (Jev hint) |
| --- | --- | --- |
| Exact-match | 5/5 | 5/5 |
| Requests that received a skill hint | — | 1/5 |
| Local-model output tokens | 347 | 383 |

They report the hybrid median wall time was ~32% lower in that single run, and also that this does **not** establish a speedup: three Jev calls timed out, one selected `none`, only the Rust request was advised, and that advised request was slower (4.39 s vs 3.84 s). `eval:live` separately got 5/5 expected skill picks (pdf, rust, spreadsheet, none, none).

## Rerun on this harness

```bash
bun run.ts \
  --cases external/madeye/cases.jsonl \
  --skills-dir external/madeye/skills \
  --tiers 3
```

Add `--jev` to score `suggest()` from `pi-jev-skill-suggestion` on the same five prompts. Roster size is 3, so cache savings (A) will be tiny.
