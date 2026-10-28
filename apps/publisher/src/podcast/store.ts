// Where episode audio and the TTS cache live (D109). While ANR runs on the laptop this is a local
// directory (`ANR_MEDIA_DIR`); from milestone 7 an R2 bucket behind the same interface (D53, D55).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface MediaStore {
  get(key: string): Promise<Buffer | null>;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
}

/** Keys are relative paths of lower-case letters, digits, dashes, dots and slashes. */
const KEY = /^[a-z0-9][a-z0-9./-]*$/;

export function localStore(dir: string): MediaStore & { path(key: string): string } {
  const root = resolve(dir);
  const path = (key: string) => {
    if (!KEY.test(key) || key.includes("..")) throw new Error(`bad media key ${key}`);
    return join(root, key);
  };
  return {
    path,
    async get(key) {
      const file = path(key);
      return existsSync(file) ? readFileSync(file) : null;
    },
    async put(key, data) {
      const file = path(key);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
    },
  };
}
