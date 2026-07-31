#!/usr/bin/env node
// D2 parity — normalize a vitest JSON report into a sorted failure-signature set.
// A signature is `<worktree-relative test file> :: <full test name>` for every
// assertionResult whose status is "failed". Worktree-absolute path prefixes are
// stripped so BASELINE and CANDIDATE signatures are directly comparable.
//
// Usage: node normalize-failures.cjs <results.json> <worktree-abs-root> [outFile]
// Prints the sorted unique signature set to stdout (and outFile if given), plus
// a trailing "# count=<N>" line to stderr for a quick tally.
const fs = require("fs");
const path = require("path");

const [, , jsonPath, wtRoot, outFile] = process.argv;
if (!jsonPath || !wtRoot) {
  console.error("usage: node normalize-failures.cjs <results.json> <worktree-abs-root> [outFile]");
  process.exit(2);
}

const raw = fs.readFileSync(jsonPath, "utf8");
let report;
try {
  report = JSON.parse(raw);
} catch (e) {
  console.error("FATAL: results json did not parse:", e.message);
  process.exit(2);
}

const rootPrefix = wtRoot.endsWith("/") ? wtRoot : wtRoot + "/";
function rel(p) {
  if (typeof p !== "string") return String(p);
  let s = p;
  if (s.startsWith(rootPrefix)) s = s.slice(rootPrefix.length);
  return s;
}

const sigs = new Set();
const results = Array.isArray(report.testResults) ? report.testResults : [];
for (const suite of results) {
  const file = rel(suite.name || suite.testFilePath || "<unknown-file>");
  const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
  for (const a of assertions) {
    if (a.status === "failed") {
      const name = a.fullName || (Array.isArray(a.ancestorTitles) ? a.ancestorTitles.concat(a.title || "").join(" > ") : a.title || "<unknown-test>");
      sigs.add(`${file} :: ${name}`);
    }
  }
}

const sorted = Array.from(sigs).sort();
const body = sorted.join("\n") + (sorted.length ? "\n" : "");
if (outFile) fs.writeFileSync(outFile, body);
process.stdout.write(body);
console.error(`# count=${sorted.length}`);
