// `pnpm --filter @anr/legacy-import translate <units.jsonl> <translations.jsonl>`: the old archive's
// Persian texts into English through the model gateway, on the renderer's chain (D169). Appends to
// the translations file as it goes, so a rerun only translates what is still missing.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCatalog, loadModelsConfig, ModelGateway, modelsFile, roleChains } from "@anr/models";
import { batches, parse, prompt, SYSTEM, type Unit } from "./units.ts";

const [unitsArg, outArg] = process.argv.slice(2);
if (!unitsArg || !outArg) {
  console.error("usage: translate <units.jsonl> <translations.jsonl>");
  process.exit(2);
}
const unitsFile: string = unitsArg;
const outFile: string = outArg;
const readJsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T)
    : [];

const configDir =
  process.env.ANR_CONFIG_DIR ?? fileURLToPath(new URL("../../../config", import.meta.url));
const config = loadModelsConfig(modelsFile(configDir));
const rendererChain = new Map(roleChains(config)).get("renderer");
if (!rendererChain?.length) throw new Error("models.yaml has no renderer chain");
const chain: string[] = rendererChain;
const gateway = new ModelGateway(buildCatalog(config));

const done = new Set(readJsonl<{ key: string }>(outFile).map((t) => t.key));
const todo = readJsonl<Unit>(unitsFile).filter((u) => !done.has(u.key));
console.log(`${done.size} already translated, ${todo.length} to go, chain ${chain.join(" > ")}`);

let cost = 0;
let kept = 0;
const failed: string[] = [];

async function run(batch: Unit[], retry: boolean): Promise<void> {
  const res = await gateway.chat({
    chain,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt(batch) },
    ],
  });
  cost += res.costUsd ?? 0;
  const text = typeof res.message.content === "string" ? res.message.content : "";
  const out = parse(batch, text);
  for (const t of out.kept)
    appendFileSync(outFile, `${JSON.stringify({ ...t, model: res.catalogId })}\n`);
  kept += out.kept.length;
  // A rejected unit gets one more try on its own; then it stays Persian and is reported.
  for (const r of out.rejected) {
    const unit = batch.find((u) => u.key === r.key);
    if (unit && retry) await run([unit], false);
    else failed.push(`${r.key}: ${r.why}`);
  }
}

const queue = batches(todo);
const workers = Array.from({ length: 4 }, async () => {
  for (let b = queue.shift(); b; b = queue.shift()) {
    try {
      await run(b, true);
    } catch (err) {
      failed.push(...b.map((u) => `${u.key}: ${(err as Error).message.slice(0, 400)}`));
    }
    process.stdout.write(`\r${kept} kept, ${failed.length} failed, $${cost.toFixed(3)}   `);
  }
});
await Promise.all(workers);
console.log(`\n${kept} translated, ${failed.length} failed, about $${cost.toFixed(2)}`);
for (const f of failed.slice(0, 20)) console.log(`  ${f}`);
if (failed.length > 0) process.exitCode = 1;
