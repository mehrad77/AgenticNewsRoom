// `pnpm --filter @anr/legacy-import translate:batch <units.jsonl> <translations.jsonl> --budget <usd>`:
// the same translation as translate.ts, through the Anthropic Message Batches API (half price) on
// Claude Sonnet 5.5, under a hard spending cap (D169). Before it submits, it counts every request's
// input tokens and refuses a batch whose worst case (every request writing its max_tokens) would
// take the ledger past the cap. The ledger (<translations>.spend.json) adds up what every run cost,
// and the batch id is kept (<translations>.batch.json), so a rerun resumes a batch instead of
// paying for it twice. Reads ANTHROPIC_API_KEY from the environment.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { batches, parse, prompt, SYSTEM, type Unit } from "./units.ts";

const MODEL = "claude-sonnet-5-5";
// USD per million tokens: Sonnet 5.5's $2 / $10, halved for batches.
const PRICE = { in: 1.0, out: 5.0 };

const args = process.argv.slice(2);
const [unitsArg, outArg] = args.filter((a) => !a.startsWith("--") && !/^\d/.test(a));
const budgetAt = args.indexOf("--budget");
const cap = budgetAt >= 0 ? Number(args[budgetAt + 1]) : Number.NaN;
if (!unitsArg || !outArg || !(cap > 0)) {
  console.error("usage: translate:batch <units.jsonl> <translations.jsonl> --budget <usd>");
  process.exit(2);
}
const unitsFile: string = unitsArg;
const outFile: string = outArg;
const ledgerFile = `${outFile}.spend.json`;
const stateFile = `${outFile}.batch.json`;

const readJsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T)
    : [];
const spent = (): number =>
  existsSync(ledgerFile)
    ? (JSON.parse(readFileSync(ledgerFile, "utf8")) as { usd: number }).usd
    : 0;
const addSpend = (usd: number) =>
  writeFileSync(ledgerFile, `${JSON.stringify({ usd: spent() + usd, model: MODEL })}\n`);
const cost = (input: number, output: number) => (input * PRICE.in + output * PRICE.out) / 1e6;

const client = new Anthropic();

interface State {
  id: string;
  /** custom_id -> the units in that request. */
  requests: Record<string, Unit[]>;
  /** The worst case this batch was allowed at. */
  worstUsd: number;
}

async function submit(): Promise<State | null> {
  const done = new Set(readJsonl<{ key: string }>(outFile).map((t) => t.key));
  const todo = readJsonl<Unit>(unitsFile).filter((u) => !done.has(u.key));
  if (todo.length === 0) return null;
  const groups = batches(todo);
  // Exact input tokens per request (count_tokens is free), then a max_tokens with room to spare.
  const sized: { units: Unit[]; input: number; maxTokens: number }[] = [];
  for (let i = 0; i < groups.length; i += 4) {
    const counted = await Promise.all(
      groups.slice(i, i + 4).map(async (units) => {
        const { input_tokens: input } = await client.messages.countTokens({
          model: MODEL,
          system: SYSTEM,
          messages: [{ role: "user", content: prompt(units) }],
        });
        return { units, input, maxTokens: Math.min(32000, Math.ceil(input * 1.5) + 500) };
      }),
    );
    sized.push(...counted);
  }
  // Keep requests in order while the worst case fits what is left of the cap.
  const left = cap - spent();
  let worst = 0;
  const chosen: typeof sized = [];
  for (const r of sized) {
    const w = cost(r.input, r.maxTokens);
    if (worst + w > left) break;
    worst += w;
    chosen.push(r);
  }
  const input = sized.reduce((s, r) => s + r.input, 0);
  console.log(
    `${todo.length} texts in ${sized.length} requests, ${input} input tokens; ` +
      `$${spent().toFixed(2)} spent of $${cap}; submitting ${chosen.length} requests, worst case $${worst.toFixed(2)}`,
  );
  if (chosen.length === 0) {
    console.error("nothing fits in what is left of the budget");
    process.exit(1);
  }
  const requests = Object.fromEntries(chosen.map((r, i) => [`r${i}`, r.units]));
  const batch = await client.messages.batches.create({
    requests: chosen.map((r, i) => ({
      custom_id: `r${i}`,
      params: {
        model: MODEL,
        max_tokens: r.maxTokens,
        // Translation needs no reasoning: thinking off, low effort.
        thinking: { type: "between_tools" },
        output_config: { effort: "low" },
        system: SYSTEM,
        messages: [{ role: "user", content: prompt(r.units) }],
      },
    })),
  });
  const state: State = { id: batch.id, requests, worstUsd: worst };
  writeFileSync(stateFile, JSON.stringify(state));
  console.log(`batch ${batch.id} submitted`);
  return state;
}

const state: State | null = existsSync(stateFile)
  ? (JSON.parse(readFileSync(stateFile, "utf8")) as State)
  : await submit();
if (!state) {
  console.log("everything is translated");
  process.exit(0);
}

for (;;) {
  const b = await client.messages.batches.retrieve(state.id);
  const c = b.request_counts;
  process.stdout.write(
    `\r${b.processing_status}: ${c.succeeded} done, ${c.processing} running, ${c.errored} errored   `,
  );
  if (b.processing_status === "ended") break;
  await new Promise((r) => setTimeout(r, 30_000));
}

let input = 0;
let output = 0;
let kept = 0;
const failed: string[] = [];
for await (const r of await client.messages.batches.results(state.id)) {
  const units = state.requests[r.custom_id] ?? [];
  if (r.result.type !== "succeeded") {
    failed.push(...units.map((u) => `${u.key}: ${r.result.type}`));
    continue;
  }
  const m = r.result.message;
  input += m.usage.input_tokens;
  output += m.usage.output_tokens;
  if (m.stop_reason === "refusal" || m.stop_reason === "max_tokens") {
    failed.push(...units.map((u) => `${u.key}: ${m.stop_reason}`));
    continue;
  }
  const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const out = parse(units, text);
  for (const t of out.kept)
    appendFileSync(outFile, `${JSON.stringify({ ...t, model: `${MODEL}:batch` })}\n`);
  kept += out.kept.length;
  failed.push(...out.rejected.map((x) => `${x.key}: ${x.why}`));
}
const usd = cost(input, output);
addSpend(usd);
rmSync(stateFile);
console.log(
  `\n${kept} translated, ${failed.length} not kept; this batch $${usd.toFixed(2)} ` +
    `(${input} in, ${output} out), $${spent().toFixed(2)} of $${cap} spent in all`,
);
for (const f of failed.slice(0, 20)) console.log(`  ${f}`);
