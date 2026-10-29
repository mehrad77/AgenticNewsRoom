// Images a publication shows (D16, D119, D120). Before anything is sent, every image must have a
// recorded licence and a credit, or the publication is held: an image is never dropped to let the
// piece go out. Each licensed image is published once as a copy whose XMP carries its IPTC Photo
// Metadata and licence (exiftool), then signed with c2patool, the untouched source as the parent
// ingredient so a manifest the source already had stays valid inside ours. Signing comes last:
// it hashes the file.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@anr/db";
import { mediaIds, mediaPath } from "@anr/render";
import type { MediaStore } from "./podcast/store.ts";

const run = promisify(execFile);
/** A tool that hangs fails the image (and holds the piece) instead of the publication's lock. */
const TOOL_TIMEOUT_MS = 60_000;

export interface MediaRow {
  id: string;
  file: string;
  content_type: string;
  description: string | null;
  creator: string | null;
  credit_line: string | null;
  copyright_notice: string | null;
  web_statement: string | null;
  licensor: string | null;
  digital_source_type: string | null;
  licence: string | null;
  licence_url: string | null;
  published_file: string | null;
}

export interface ImageWriter {
  /** The source with the row's Photo Metadata written in, signed; and whether it was signed. */
  write(
    source: Buffer,
    media: MediaRow,
    workDir: string,
  ): Promise<{ data: Buffer; signed: boolean }>;
}

/** The XMP fields written into every published image (IPTC Photo Metadata, D45). */
export function xmpArgs(m: MediaRow): string[] {
  const fields: [string, string | null][] = [
    ["XMP-dc:Creator", m.creator],
    ["XMP-photoshop:Credit", m.credit_line],
    ["XMP-dc:Rights", m.copyright_notice],
    ["XMP-xmpRights:WebStatement", m.web_statement ?? m.licence_url],
    ["XMP-xmpRights:UsageTerms", m.licence && `${m.licence} (${m.licence_url})`],
    ["XMP-plus:LicensorName", m.licensor],
    ["XMP-dc:Description", m.description],
    // Only as recorded from the source; never guessed (D45).
    ["XMP-iptcExt:DigitalSourceType", m.digital_source_type],
  ];
  return fields.filter(([, v]) => v).map(([tag, v]) => `-${tag}=${v}`);
}

export function manifest(m: MediaRow) {
  return {
    claim_generator_info: [{ name: "ANR", version: "1" }],
    title: m.id,
    assertions: [
      {
        label: "c2pa.actions",
        data: {
          actions: [
            {
              action: "c2pa.edited.metadata",
              ...(m.digital_source_type && { digitalSourceType: m.digital_source_type }),
            },
            { action: "c2pa.published" },
          ],
        },
      },
    ],
  };
}

export function exiftoolWriter(
  exiftool = process.env.ANR_EXIFTOOL ?? "exiftool",
  c2patool = process.env.ANR_C2PATOOL ?? "c2patool",
): ImageWriter {
  return {
    async write(source, m, workDir) {
      const ext = mediaPath(m.id, m.content_type).split(".").pop();
      const original = join(workDir, `original.${ext}`);
      const tagged = join(workDir, `tagged.${ext}`);
      const signed = join(workDir, `signed.${ext}`);
      const spec = join(workDir, "manifest.json");
      writeFileSync(original, source);
      writeFileSync(spec, JSON.stringify(manifest(m)));
      // `-charset utf8`: names in Persian or Turkish stay as written.
      await run(exiftool, ["-q", "-charset", "utf8", ...xmpArgs(m), "-o", tagged, original], {
        timeout: TOOL_TIMEOUT_MS,
      });
      await run(c2patool, [tagged, "-p", original, "-m", spec, "-o", signed, "-f"], {
        timeout: TOOL_TIMEOUT_MS,
      });
      const { stdout } = await run(c2patool, [signed], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: TOOL_TIMEOUT_MS,
      });
      const report = JSON.parse(stdout) as { validation_state?: string };
      if (report.validation_state !== "Valid")
        throw new Error(`the signed image does not validate (${report.validation_state})`);
      return { data: readFileSync(signed), signed: true };
    },
  };
}

/** For tests without exiftool or c2patool: the source unchanged, and says so. */
export const unchangedForTests: ImageWriter = {
  async write(source) {
    return { data: source, signed: false };
  },
};

/** Where ingestion keeps source images: its raw store (D55), a local directory until R2. */
export function rawReader(dir: string) {
  const root = resolve(dir);
  return (key: string): Buffer | null => {
    if (!/^raw\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key)) throw new Error(`bad raw key ${key}`);
    const file = join(root, key);
    return existsSync(file) ? readFileSync(file) : null;
  };
}

export interface MediaDeps {
  writer: ImageWriter;
  raw: (key: string) => Buffer | null;
  store: MediaStore;
  workDir: () => string;
}

export type MediaOutcome = { kind: "ready" } | { kind: "hold"; name: string; detail: unknown };

/**
 * Checks every image the renditions show, then publishes each one not published yet. Runs inside
 * the publication's transaction, before any Post row is written. Media rows are not locked: two
 * pieces publishing the same image at once both write a valid copy to the same key, and the
 * tools' run never blocks another piece or the desk.
 */
export async function prepareMedia(
  client: Client,
  deps: MediaDeps | undefined,
  bodies: unknown[],
): Promise<MediaOutcome> {
  const ids = [...new Set(bodies.flatMap(mediaIds))];
  if (ids.length === 0) return { kind: "ready" };
  const { rows } = await client.query<MediaRow>(
    `select id, file, content_type, description, creator, credit_line, copyright_notice,
            web_statement, licensor, digital_source_type, licence, licence_url, published_file
     from media where id::text = any($1)`,
    [ids],
  );
  const unlicensed = ids.filter((id) => {
    const m = rows.find((r) => r.id === id);
    return !m?.licence || !m.credit_line?.trim();
  });
  if (unlicensed.length > 0)
    return { kind: "hold", name: "unlicensed-media", detail: { media: unlicensed } };
  if (!deps)
    return { kind: "hold", name: "media", detail: { error: "no image writer configured" } };
  for (const m of rows.filter((r) => !r.published_file)) {
    const workDir = deps.workDir();
    try {
      const source = deps.raw(m.file);
      if (!source) throw new Error(`source image ${m.file} is missing`);
      const { data } = await deps.writer.write(source, m, workDir);
      const key = mediaPath(m.id, m.content_type).slice(1);
      await deps.store.put(key, data, m.content_type);
      await client.query(
        "update media set published_file = $2 where id = $1 and published_file is null",
        [m.id, key],
      );
    } catch (error) {
      return {
        kind: "hold",
        name: "media",
        detail: { media: m.id, error: (error as Error).message },
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
  return { kind: "ready" };
}
