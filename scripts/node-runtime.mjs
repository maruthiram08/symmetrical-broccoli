// Downloads the Node.js runtime that ships inside the desktop app, checks it against the official
// SHASUMS256.txt, and stages just the node binary (plus Node's LICENSE) in build/node-runtime, where
// src-tauri/tauri.conf.json bundles it as the app's "node-runtime" resource. No npm, no corepack.
//
// Downloads are cached in src-tauri/target/node-cache/v<version>/ (never committed).
//
//   node scripts/node-runtime.mjs                          # the host's target
//   node scripts/node-runtime.mjs --target aarch64-apple-darwin
//   node scripts/node-runtime.mjs --verify-all             # download + check all three, stage nothing
//
// Behind a proxy, run it with NODE_USE_ENV_PROXY=1 (Node 22.21+ then honours HTTPS_PROXY).
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";

/** Node 22 LTS ("Jod"), released 2026-11-11. To move it: change this and the three hashes below. */
export const NODE_VERSION = "22.23.5";

/**
 * Per Rust target triple: Node's archive and the SHA-256 we expect for it (copied from
 * https://nodejs.org/dist/v22.23.5/SHASUMS256.txt; the download is checked against that file too).
 */
export const TARGETS = {
  "aarch64-apple-darwin": {
    archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d",
    exe: "node",
  },
  "x86_64-unknown-linux-gnu": {
    archive: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    sha256: "c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1",
    exe: "node",
  },
  "x86_64-pc-windows-msvc": {
    archive: `node-v${NODE_VERSION}-win-x64.zip`,
    sha256: "4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3",
    exe: "node.exe",
  },
};
// The same Windows build serves the GNU toolchain (cargo check / cross builds).
TARGETS["x86_64-pc-windows-gnu"] = TARGETS["x86_64-pc-windows-msvc"];

const BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;

/** The Rust target triple of this machine, for the targets the app ships. */
export function hostTriple(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  throw new Error(`No bundled Node for ${platform}-${arch}. Pass --target <triple>.`);
}

/** SHASUMS256.txt → Map(file name → lowercase hex digest). */
export function parseShasums(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Strips the archive's top folder ("node-v22.x-linux-x64/bin/node" → "bin/node"). */
function inner(path) {
  const i = path.indexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function cstr(buf, start, len) {
  const s = buf.subarray(start, start + len);
  const nul = s.indexOf(0);
  return s.subarray(0, nul < 0 ? s.length : nul).toString("utf8");
}

/**
 * Reads the files in `wanted` (paths under the top folder) from an uncompressed tar.
 * Handles ustar prefixes, pax `path` records and GNU long names. → Map(path → {data, mode}).
 */
export function extractTar(tar, wanted) {
  const want = new Set(wanted);
  const found = new Map();
  let off = 0;
  let longName = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(cstr(h, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const mode = parseInt(cstr(h, 100, 8).trim() || "0", 8);
    const prefix = cstr(h, 345, 155);
    let name = cstr(h, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (m) longName = m[1];
      continue;
    }
    if (type === "L") {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (longName !== null) {
      name = longName;
      longName = null;
    }
    if ((type === "0" || type === "\0") && want.has(inner(name))) {
      found.set(inner(name), { data: Buffer.from(data), mode });
    }
  }
  return found;
}

/** Reads the files in `wanted` (paths under the top folder) from a zip. → Map(path → {data, mode}). */
export function extractZip(zip, wanted) {
  const want = new Set(wanted);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file (no end of central directory).");
  const count = zip.readUInt16LE(eocd + 10);
  let off = zip.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error("Zip64 archives are not supported.");
  const found = new Map();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(off) !== 0x02014b50) throw new Error("Bad zip central directory.");
    const method = zip.readUInt16LE(off + 10);
    const compSize = zip.readUInt32LE(off + 20);
    const size = zip.readUInt32LE(off + 24);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    const local = zip.readUInt32LE(off + 42);
    const name = zip.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    off += 46 + nameLen + extraLen + commentLen;
    if (!want.has(inner(name))) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`Bad zip local header for ${name}.`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`Unsupported zip compression ${method} for ${name}.`);
    if (data.length !== size) throw new Error(`Size mismatch for ${name} in the zip.`);
    found.set(inner(name), { data, mode: 0o755 });
  }
  return found;
}

/** Pulls the node binary and LICENSE out of a downloaded Node archive. */
export function extractRuntime(archiveName, buf) {
  const isZip = archiveName.endsWith(".zip");
  const exe = isZip ? "node.exe" : "bin/node";
  const files = isZip ? extractZip(buf, [exe, "LICENSE"]) : extractTar(gunzipSync(buf), [exe, "LICENSE"]);
  const node = files.get(exe);
  if (!node) throw new Error(`${exe} is missing from ${archiveName}.`);
  return { node: node.data, license: files.get("LICENSE")?.data ?? null };
}

async function download(url, file) {
  mkdirSync(dirname(file), { recursive: true });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      const tmp = `${file}.part`;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw new Error(`Couldn't download ${url}: ${lastErr?.cause?.message ?? lastErr?.message ?? lastErr}`);
}

/** The official checksums for this version, cached next to the downloads. */
async function shasums(cacheDir) {
  const file = join(cacheDir, "SHASUMS256.txt");
  if (!existsSync(file)) await download(`${BASE}/SHASUMS256.txt`, file);
  return parseShasums(readFileSync(file, "utf8"));
}

/**
 * Downloads (or reuses from the cache) the archive for `triple` and checks it. Returns the bytes.
 * The archive must match both the official SHASUMS256.txt and the hash pinned in this file.
 */
export async function fetchArchive(triple, cacheDir, log = console.log) {
  const t = TARGETS[triple];
  if (!t) throw new Error(`No bundled Node for ${triple}. Known: ${Object.keys(TARGETS).join(", ")}.`);
  const sums = await shasums(cacheDir);
  const official = sums.get(t.archive);
  if (!official) throw new Error(`${t.archive} is not listed in SHASUMS256.txt.`);
  if (official !== t.sha256) {
    throw new Error(`SHASUMS256.txt lists ${official} for ${t.archive}, but scripts/node-runtime.mjs pins ${t.sha256}.`);
  }
  const file = join(cacheDir, t.archive);
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!existsSync(file)) {
      log(`==> downloading ${t.archive}`);
      await download(`${BASE}/${t.archive}`, file);
    }
    const buf = readFileSync(file);
    const got = sha256(buf);
    if (got === official) {
      log(`    ${t.archive}: sha256 ok (${got})`);
      return buf;
    }
    log(`    ${t.archive}: sha256 mismatch (${got}), downloading again`);
    rmSync(file, { force: true });
  }
  throw new Error(`${t.archive} doesn't match SHASUMS256.txt.`);
}

/** Stages node (or node.exe) and LICENSE for `triple` in `outDir`, replacing what was there. */
export async function stageRuntime(triple, { cacheDir, outDir, log = console.log }) {
  const t = TARGETS[triple];
  const buf = await fetchArchive(triple, cacheDir, log);
  const { node, license } = extractRuntime(t.archive, buf);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const exe = join(outDir, t.exe);
  writeFileSync(exe, node, { mode: 0o755 });
  if (license) writeFileSync(join(outDir, "LICENSE"), license);
  writeFileSync(join(outDir, "VERSION"), `v${NODE_VERSION} ${triple}\n`);
  log(`    staged ${exe} (${(node.length / 1048576).toFixed(1)} MB)`);
  return exe;
}

async function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cacheDir = join(root, "src-tauri", "target", "node-cache", `v${NODE_VERSION}`);
  const outDir = join(root, "build", "node-runtime");
  if (argv.includes("--verify-all")) {
    for (const triple of ["aarch64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]) {
      const buf = await fetchArchive(triple, cacheDir);
      const { node } = extractRuntime(TARGETS[triple].archive, buf);
      console.log(`    ${triple}: ${TARGETS[triple].exe} ${(node.length / 1048576).toFixed(1)} MB`);
    }
    return;
  }
  const i = argv.indexOf("--target");
  const triple = i >= 0 ? argv[i + 1] : hostTriple();
  console.log(`==> bundled Node v${NODE_VERSION} for ${triple}`);
  await stageRuntime(triple, { cacheDir, outDir });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
