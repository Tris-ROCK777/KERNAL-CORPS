import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const htmlFiles = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith(".html")) htmlFiles.push(full);
  }
}
walk(root);
const missing = [];
const attributePattern = /\b(?:href|src)\s*=\s*["']([^"'<>]+)["']/gi;
const importPattern = /\b(?:from\s*|import\s*\()\s*["']([^"'"]+)["']/g;

for (const file of htmlFiles) {
  const source = readFileSync(file, "utf8");
  const references = [];
  for (const match of source.matchAll(attributePattern)) references.push(match[1]);
  for (const match of source.matchAll(importPattern)) references.push(match[1]);

  for (const reference of references) {
    if (!reference || /^(?:[a-z]+:|\\/\\/|#)/i.test(reference) || reference.startsWith("/")) continue;
    const pathname = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
    if (!pathname) continue;
    const target = path.resolve(path.dirname(file), pathname);
    if (!existsSync(target)) missing.push({ page: path.relative(root, file), reference });
  }
}
assert.equal(missing.length, 0, "Broken local UI links/imports:\\n" + JSON.stringify(missing, null, 2));
assert.ok(htmlFiles.some(file => path.relative(root, file) === "index.html"), "Overseer entry page is missing");
console.log(`Overseer UI smoke check passed: ${htmlFiles.length} HTML pages and their literal local references.`);
