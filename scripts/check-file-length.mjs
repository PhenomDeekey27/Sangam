#!/usr/bin/env node
/**
 * Enforce the 400-physical-line limit on maintained source files.
 * Exits non-zero and lists every violation.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINES = 400;
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
]);
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  "out",
  "build",
  "coverage",
  "dist",
  ".turbo",
]);
const IGNORED_FILES = new Set(["next-env.d.ts"]);

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** @param {string} directory @param {string[]} files @returns {Promise<string[]>} */
async function collectSourceFiles(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      await collectSourceFiles(fullPath, files);
    } else if (entry.isFile()) {
      if (IGNORED_FILES.has(entry.name)) continue;
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(fullPath);
    }
  }
  return files;
}

/** @param {string} content @returns {number} */
function countPhysicalLines(content) {
  if (content.length === 0) return 0;
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

const sourceFiles = await collectSourceFiles(projectRoot, []);
const violations = [];

for (const file of sourceFiles) {
  const content = await readFile(file, "utf8");
  const lineCount = countPhysicalLines(content);
  if (lineCount > MAX_LINES) {
    violations.push({ path: path.relative(projectRoot, file), lineCount });
  }
}

violations.sort(
  (a, b) => b.lineCount - a.lineCount || a.path.localeCompare(b.path),
);

if (violations.length > 0) {
  console.error(`File length limit is ${MAX_LINES} lines. Violations:\n`);
  for (const violation of violations) {
    console.error(`  ${violation.path} — ${violation.lineCount} lines`);
  }
  console.error(`\n${violations.length} file(s) exceed the limit.`);
  process.exit(1);
}

console.log(
  `OK: ${sourceFiles.length} source files are within the ${MAX_LINES}-line limit.`,
);
