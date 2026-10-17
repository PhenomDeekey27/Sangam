import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Server credentials must never ship to the browser. The frontend bundle is
 * built from `src/` (plus `next-env` types), so no file there may name a
 * server-only secret — translation included: the browser never calls the
 * vendor, the server does.
 */
const SECRET_NAMES = ["GEMINI_API_KEY", "DEEPGRAM_API_KEY", "SARVAM_API_KEY"];

async function sourceFiles(
  directory: string,
  files: string[],
): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      await sourceFiles(full, files);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe("no server secrets in client sources", () => {
  it("never names server-only credentials under src/", async () => {
    const root = path.resolve(import.meta.dirname, "..", "..");
    const offenders: string[] = [];
    for (const file of await sourceFiles(path.join(root, "src"), [])) {
      // This guard lists the secret names itself, so it cannot scan itself.
      if (path.basename(file) === "server-secrets.test.ts") continue;
      const content = await readFile(file, "utf8");
      if (SECRET_NAMES.some((name) => content.includes(name))) {
        offenders.push(path.relative(root, file));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("never logs the translation key from the vendor adapter", async () => {
    const root = path.resolve(import.meta.dirname, "..", "..");
    const adapter = await readFile(
      path.join(root, "server", "src", "translation", "gemini-provider.ts"),
      "utf8",
    );
    assert.equal(adapter.includes("console.log"), false);
    assert.equal(adapter.includes("console.info"), false);
    assert.equal(adapter.includes("console.debug"), false);
  });
});
