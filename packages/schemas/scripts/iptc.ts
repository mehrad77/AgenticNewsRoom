// Refreshes the vendored IPTC NewsCodes in iptc/ from cv.iptc.org, and the ninjs JSON Schema. Run by hand
// (`pnpm --filter @anr/schemas iptc`) and commit the result; CI never fetches.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMES = ["mediatopic", "genre", "digitalsourcetype", "trustindicator"] as const;
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "iptc");

interface Concept {
  qcode: string;
  prefLabel?: Record<string, string>;
  broader?: string[];
  retired?: string;
}

// Fetch everything first and write only when every fetch succeeded, so a failure never leaves
// a mixed snapshot behind.
const files: { name: string; body: unknown; note: string }[] = [];
for (const scheme of SCHEMES) {
  const res = await fetch(`https://cv.iptc.org/newscodes/${scheme}/?format=json&lang=en-GB`);
  if (!res.ok) throw new Error(`${scheme}: HTTP ${res.status}`);
  const data = (await res.json()) as {
    uri: string;
    prefSchemeAlias: string;
    copyrightHolder: string;
    licenceLink: string;
    dateReleased: string;
    conceptSet: Concept[];
  };
  const prefix = `${data.uri}`;
  const concepts = data.conceptSet
    .map((c) => ({
      qcode: c.qcode,
      label: c.prefLabel?.["en-GB"] ?? "",
      ...(c.broader?.length
        ? { broader: c.broader.map((b) => b.replace(prefix, `${data.prefSchemeAlias}:`)) }
        : {}),
      ...(c.retired ? { retired: c.retired } : {}),
    }))
    .sort((a, b) => a.qcode.localeCompare(b.qcode));
  const file = {
    scheme: data.uri,
    alias: data.prefSchemeAlias,
    copyright: data.copyrightHolder,
    licence: data.licenceLink,
    released: data.dateReleased,
    concepts,
  };
  files.push({
    name: `${scheme}.json`,
    body: file,
    note: `${concepts.length} concepts, released ${data.dateReleased}`,
  });
}

const NINJS = "https://www.iptc.org/std/ninjs/ninjs-schema_3.2.json";
const ninjs = await fetch(NINJS);
if (!ninjs.ok) throw new Error(`ninjs: HTTP ${ninjs.status}`);
files.push({ name: "ninjs-schema_3.2.json", body: await ninjs.json(), note: NINJS });

for (const { name, body, note } of files) {
  writeFileSync(join(out, name), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`${name}: ${note}`);
}
