// Run by `pnpm lint`, in CI and by the pre-commit hook (.githooks/): the repository is public, so a
// plaintext secret is leaked once it is pushed (D125).
//   1. Every file in infra/secrets/ is SOPS-encrypted: dotenv (.env) or JSON (.json), every value
//      ENC[...] and a MAC over them.
//   2. The secrets .env.example lists are the ones infra/env.sh knows (D124).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const problems: string[] = [];
const ENC = /^ENC\[AES256_GCM,/;

/** Whether a dotenv file is SOPS-encrypted: values ENC[...], plus sops_ metadata with a MAC. */
function dotenvProblem(text: string): string | null {
  const lines = text.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
  if (!lines.some((l) => /^sops_mac=ENC\[/.test(l))) return "no SOPS MAC";
  // An empty value has nothing to leak, and SOPS leaves it as it is.
  const plain = lines.filter((l) => {
    const value = l.slice(l.indexOf("=") + 1);
    return !l.startsWith("sops_") && value !== "" && !ENC.test(value);
  });
  return plain.length > 0
    ? `plaintext value for ${plain.map((l) => l.split("=")[0]).join(", ")}`
    : null;
}

/** Whether a JSON file is SOPS-encrypted: every string outside `sops` is ENC[...]. */
function jsonProblem(text: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return "not JSON";
  }
  const { sops, ...rest } = (data ?? {}) as { sops?: { mac?: string } };
  if (!sops?.mac || !ENC.test(sops.mac)) return "no SOPS MAC";
  const plain: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string") {
      if (value !== "" && !ENC.test(value)) plain.push(path);
    } else if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) walk(v, `${path}[${i}]`);
    } else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    else if (value !== null) plain.push(path);
  };
  walk(rest, "");
  return plain.length > 0 ? `plaintext value at ${plain.join(", ")}` : null;
}

const secrets = join(root, "infra/secrets");
// Git does not keep an empty directory, so a fresh clone may have none yet.
for (const name of existsSync(secrets) ? readdirSync(secrets) : []) {
  const text = readFileSync(join(secrets, name), "utf8");
  const problem = name.endsWith(".env")
    ? dotenvProblem(text)
    : name.endsWith(".json")
      ? jsonProblem(text)
      : "only .env and .json files, SOPS-encrypted, belong here";
  if (problem) problems.push(`infra/secrets/${name}: ${problem} (encrypt it: sops -e -i)`);
}

const example = readFileSync(join(root, ".env.example"), "utf8");
const section = example.slice(example.indexOf("# Secrets: the complete list."));
const listed = [...section.matchAll(/^([A-Z0-9_]+)=/gm)]
  .map((m) => m[1] as string)
  // Database URLs are built from the passwords; .env.example lists them for apps run on the host.
  .filter((n) => !n.startsWith("DATABASE_"));
const known = readFileSync(join(root, "infra/env.sh"), "utf8")
  .match(/ANR_SECRETS=\(([^)]*)\)/)?.[1]
  ?.split(/\s+/)
  .filter(Boolean);
const missing = listed.filter((n) => !known?.includes(n));
const extra = (known ?? []).filter((n) => !listed.includes(n));
if (missing.length > 0) problems.push(`infra/env.sh ANR_SECRETS lacks ${missing.join(", ")}`);
if (extra.length > 0) problems.push(`.env.example's secrets lack ${extra.join(", ")}`);

if (problems.length > 0) {
  for (const p of problems) console.error(`infra check: ${p}`);
  process.exit(1);
}
