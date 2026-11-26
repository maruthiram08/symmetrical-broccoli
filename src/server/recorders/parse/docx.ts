// The text of a .docx (a zip holding word/document.xml), without a dependency. Google Docs
// downloads (File > Download > Microsoft Word) are plain, unencrypted zips: stored or deflated.
import { inflateRawSync } from "node:zlib";

export class DocxError extends Error {
  constructor(why: string) { super(why); this.name = "DocxError"; }
}

/** Largest document.xml we inflate: a long meeting is well under 5 MB of XML. */
const MAX_XML = 20 * 1024 * 1024;

/** Read one file out of a zip archive. Null when the archive has no such file. */
export function unzipEntry(buf: Buffer, wanted: string): Buffer | null {
  // End of central directory: signature 0x06054b50, within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new DocxError("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new DocxError("bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    if (size > MAX_XML) throw new DocxError("document too large");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new DocxError("bad local header");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_XML });
    throw new DocxError(`unsupported compression ${method}`);
  }
  return null;
}

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** Paragraphs of word/document.xml as lines of text. Tabs and line breaks are kept. */
export function docxXmlToText(xml: string): string {
  const body = xml.replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, ""); // deleted (tracked) text isn't there
  const out: string[] = [];
  for (const para of body.split(/<\/w:p>/)) {
    let line = "";
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(para))) {
      if (m[1] !== undefined) line += decode(m[1]);
      else if (m[0] === "<w:tab/>") line += "\t";
      else line += "\n";
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function docxToText(buf: Buffer): string {
  const xml = unzipEntry(buf, "word/document.xml");
  if (!xml) throw new DocxError("no word/document.xml");
  return docxXmlToText(xml.toString("utf8"));
}
