// C2PA content credentials for an episode (D25, D109): c2patool signs the finished MP3 with its
// built-in test certificate, after the ID3 tags are written (signing hashes the file, so nothing
// may change it afterwards). The c2pa.actions assertion carries the publication's IPTC digital
// source type; the signed file is read back and must validate and carry it.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Signer {
  /** Signs `mp3`; returns the signed bytes and whether a manifest was embedded. */
  sign(
    mp3: Buffer,
    digitalSourceType: string,
    title: string,
    workDir: string,
  ): Promise<{ mp3: Buffer; signed: boolean }>;
}

export function manifest(digitalSourceType: string, title: string) {
  return {
    claim_generator_info: [{ name: "ANR", version: "1" }],
    title,
    assertions: [
      {
        label: "c2pa.actions",
        data: { actions: [{ action: "c2pa.created", digitalSourceType }] },
      },
    ],
  };
}

export function c2paSigner(tool = process.env.ANR_C2PATOOL ?? "c2patool"): Signer {
  return {
    async sign(mp3, digitalSourceType, title, workDir) {
      const input = join(workDir, "unsigned.mp3");
      const output = join(workDir, "signed.mp3");
      const spec = join(workDir, "manifest.json");
      writeFileSync(input, mp3);
      writeFileSync(spec, JSON.stringify(manifest(digitalSourceType, title)));
      await run(tool, [input, "-m", spec, "-o", output, "-f"], { maxBuffer: 16 * 1024 * 1024 });
      const { stdout } = await run(tool, [output], { maxBuffer: 16 * 1024 * 1024 });
      const report = JSON.parse(stdout) as { validation_state?: string };
      if (report.validation_state !== "Valid" || !stdout.includes(digitalSourceType))
        throw new Error(
          `the signed episode does not validate (${report.validation_state ?? "no state"})`,
        );
      return { mp3: readFileSync(output), signed: true };
    },
  };
}

/** For tests without c2patool: the file unchanged, and says so. */
export const unsignedForTests: Signer = {
  async sign(mp3) {
    return { mp3, signed: false };
  },
};
