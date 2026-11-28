import { describe, expect, it } from "vitest";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
  NODE_VERSION,
  TARGETS,
  extractRuntime,
  extractTar,
  extractZip,
  hostTriple,
  parseShasums,
  sha256,
} from "./node-runtime.mjs";

function octal(n: number, len: number) {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

/** A minimal ustar header + data for one regular file (or a pax "x" record). */
function tarEntry(name: string, data: Buffer, type = "0", mode = 0o755) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write(octal(mode, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(data.length, 12), 124);
  h.write(octal(0, 12), 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

function tar(...entries: Buffer[]) {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

function paxPath(path: string) {
  const body = (len: number) => `${len} path=${path}\n`;
  let len = body(0).length;
  while (body(len).length !== len) len = body(len).length;
  return tarEntry("PaxHeader", Buffer.from(body(len)), "x", 0o644);
}

/** A minimal zip (deflated entries) built by hand. */
function zip(files: Record<string, Buffer>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const comp = deflateRawSync(data);
    const n = Buffer.from(name);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(8, 8);
    l.writeUInt32LE(comp.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(l, n, comp);
    centrals.push(c, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Object.keys(files).length, 8);
  e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

describe("node-runtime", () => {
  it("pins a Node 22 build for each shipped target", () => {
    expect(NODE_VERSION).toMatch(/^22\.\d+\.\d+$/);
    for (const triple of ["aarch64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]) {
      const t = TARGETS[triple as keyof typeof TARGETS];
      expect(t.archive).toContain(`node-v${NODE_VERSION}-`);
      expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(TARGETS["x86_64-pc-windows-msvc"].exe).toBe("node.exe");
    expect(TARGETS["aarch64-apple-darwin"].archive).toMatch(/darwin-arm64\.tar\.gz$/);
    expect(TARGETS["x86_64-unknown-linux-gnu"].archive).toMatch(/linux-x64\.tar\.gz$/);
  });

  it("maps the host to a target triple", () => {
    expect(hostTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(hostTriple("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(hostTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(() => hostTriple("darwin", "x64")).toThrow(/--target/);
  });

  it("parses SHASUMS256.txt", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const m = parseShasums(`${a}  node-v1-linux-x64.tar.gz\n${b}  win-x64/node.exe\r\nnot a line\n`);
    expect(m.get("node-v1-linux-x64.tar.gz")).toBe(a);
    expect(m.get("win-x64/node.exe")).toBe("b".repeat(64));
    expect(m.size).toBe(2);
  });

  it("reads bin/node and LICENSE from a tar, including pax long names", () => {
    const node = Buffer.from("#!fake node binary");
    const t = tar(
      tarEntry("node-v1-linux-x64/", Buffer.alloc(0), "5"),
      tarEntry("node-v1-linux-x64/bin/npm", Buffer.from("npm"), "2"),
      paxPath("node-v1-linux-x64/LICENSE"),
      tarEntry("ignored-short-name", Buffer.from("MIT")),
      tarEntry("node-v1-linux-x64/bin/node", node),
      tarEntry("node-v1-linux-x64/lib/node_modules/npm/index.js", Buffer.from("x".repeat(700))),
    );
    const files = extractTar(t, ["bin/node", "LICENSE"]);
    expect(files.get("bin/node")?.data.equals(node)).toBe(true);
    expect(files.get("bin/node")?.mode).toBe(0o755);
    expect(files.get("LICENSE")?.data.toString()).toBe("MIT");
    expect(files.size).toBe(2);

    const r = extractRuntime("node-v1-linux-x64.tar.gz", gzipSync(t));
    expect(r.node.equals(node)).toBe(true);
    expect(r.license?.toString()).toBe("MIT");
  });

  it("reads node.exe and LICENSE from a zip", () => {
    const exe = Buffer.from("MZ".padEnd(5000, "z"));
    const z = zip({
      "node-v1-win-x64/LICENSE": Buffer.from("MIT"),
      "node-v1-win-x64/npm.cmd": Buffer.from("npm"),
      "node-v1-win-x64/node.exe": exe,
    });
    const files = extractZip(z, ["node.exe", "LICENSE"]);
    expect(files.get("node.exe")?.data.equals(exe)).toBe(true);
    expect(files.size).toBe(2);
    expect(extractRuntime("node-v1-win-x64.zip", z).license?.toString()).toBe("MIT");
  });

  it("fails clearly when the binary is missing", () => {
    expect(() => extractRuntime("x.tar.gz", gzipSync(tar(tarEntry("x/LICENSE", Buffer.from("MIT")))))).toThrow(
      /bin\/node is missing/,
    );
    expect(() => extractZip(Buffer.from("not a zip at all, definitely not"), ["node.exe"])).toThrow(/Not a zip/);
  });

  it("hashes with sha256", () => {
    expect(sha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
