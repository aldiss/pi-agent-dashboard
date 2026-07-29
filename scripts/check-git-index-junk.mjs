#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DS_STORE = Buffer.from(".DS_Store");
const APPLEDOUBLE_PREFIX = Buffer.from("._");
const MACOSX_DIR = Buffer.from("__MACOSX");

function git(repo, args, env = process.env) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: null,
    env: { ...env, LC_ALL: "C", LANG: "C" },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function nulRecords(raw) {
  const records = [];
  let start = 0;
  while (start < raw.length) {
    const end = raw.indexOf(0, start);
    if (end < 0) throw new Error("git emitted an unterminated NUL-delimited path");
    if (end > start) records.push(raw.subarray(start, end));
    start = end + 1;
  }
  return records;
}

function components(file) {
  const result = [];
  let start = 0;
  for (let index = 0; index <= file.length; index += 1) {
    if (index === file.length || file[index] === 0x2f) {
      result.push(file.subarray(start, index));
      start = index + 1;
    }
  }
  return result;
}

function isJunk(file) {
  const parts = components(file);
  const basename = parts.at(-1) ?? Buffer.alloc(0);
  return basename.equals(DS_STORE)
    || basename.subarray(0, APPLEDOUBLE_PREFIX.length).equals(APPLEDOUBLE_PREFIX)
    || parts.some((part) => part.equals(MACOSX_DIR));
}

function display(file) {
  const decoded = file.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(file) ? decoded : `hex:${file.toString("hex")}`;
}

function parseArgs(argv) {
  let ref;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--ref" || index + 1 >= argv.length || ref !== undefined) {
      throw new Error("usage: node scripts/check-git-index-junk.mjs [--ref <commit-ish>]");
    }
    ref = argv[index + 1];
    index += 1;
  }
  return { ref };
}

function indexedPaths(repo, ref) {
  if (ref === undefined) return git(repo, ["ls-files", "--cached", "-z"]);
  const scratch = mkdtempSync(path.join(tmpdir(), "git-index-junk-gate-"));
  const indexPath = path.join(scratch, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    git(repo, ["read-tree", ref], env);
    return git(repo, ["ls-files", "--cached", "-z"], env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const { ref } = parseArgs(process.argv.slice(2));
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const hits = nulRecords(indexedPaths(repo, ref)).filter(isJunk).sort(Buffer.compare);
const result = {
  gate: "macos-junk-in-git-index",
  source: ref === undefined ? "current-index" : `temporary-index-from:${ref}`,
  nul_delimited_enumeration: true,
  hit_count: hits.length,
  hits: hits.map(display),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = hits.length === 0 ? 0 : 1;
