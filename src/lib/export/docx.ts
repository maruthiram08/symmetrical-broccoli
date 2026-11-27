// A note or page as a Word document (.docx), with the `docx` package. Same block tree as the
// HTML export: headings, paragraphs, lists and checklists, quotes, callouts, code and tables.
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Packer, Paragraph,
  ShadingType, Table, TableCell, TableRow, TextRun, WidthType, type ParagraphChild,
} from "docx";
import { docBlocks, type Block, type ExportDoc, type Inline } from "./doc";

const SANS = "Instrument Sans";
const MONO = "Geist Mono";
const INK = "0A0A0A";
const MUTED = "525252";
const FAINT = "666666";
const BORDER = "DCDCDC";
const SURFACE = "F6F6F6";

interface RunStyle { bold?: boolean; italics?: boolean; strike?: boolean; color?: string; size?: number }

function runs(c: Inline[], s: RunStyle = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const x of c) {
    switch (x.t) {
      case "text": out.push(new TextRun({ text: x.v, ...s })); break;
      case "b": out.push(...runs(x.c, { ...s, bold: true })); break;
      case "i": out.push(...runs(x.c, { ...s, italics: true })); break;
      case "s": out.push(...runs(x.c, { ...s, strike: true })); break;
      case "code": out.push(new TextRun({ text: x.v, ...s, font: MONO, shading: { type: ShadingType.CLEAR, color: "auto", fill: SURFACE } })); break;
      case "wiki": out.push(new TextRun({ text: x.label, ...s, underline: { color: FAINT } })); break;
      case "br": out.push(new TextRun({ text: "", break: 1 })); break;
      // Word gets the LaTeX itself, in its math font (Word's own equations can't be made from it here).
      case "math": out.push(new TextRun({ text: `$${x.tex}$`, ...s, font: "Cambria Math" })); break;
      case "link": out.push(new ExternalHyperlink({ link: x.href, children: runs(x.c, s).map((r) => r) as TextRun[] })); break;
    }
  }
  return out;
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

interface Ctx {
  /** List nesting: 0 at the top. */
  level: number;
  /** Left indent added by quotes and callouts, in twips. */
  indent: number;
  /** Quote and callout text is muted. */
  color?: string;
  shade?: boolean;
  /** Each ordered list gets its own numbering instance so it restarts at 1. */
  nextList: () => number;
}

function paragraphs(blocks: Block[], ctx: Ctx): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  const base = () => ({
    indent: ctx.indent ? { left: ctx.indent } : undefined,
    shading: ctx.shade ? { type: ShadingType.CLEAR, color: "auto", fill: SURFACE } : undefined,
    border: ctx.indent && !ctx.shade ? { left: { style: BorderStyle.SINGLE, size: 12, color: BORDER, space: 8 } } : undefined,
  });
  for (const b of blocks) {
    switch (b.t) {
      case "h":
        out.push(new Paragraph({ heading: HEADINGS[b.level - 1], children: runs(b.c), ...base() }));
        break;
      case "p":
        out.push(new Paragraph({ children: runs(b.c, ctx.color ? { color: ctx.color } : {}), spacing: { after: 120 }, ...base() }));
        break;
      case "math":
        out.push(new Paragraph({ children: [new TextRun({ text: `$$${b.tex}$$`, font: "Cambria Math" })], alignment: AlignmentType.CENTER, spacing: { after: 120 }, ...base() }));
        break;
      case "hr":
        out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BORDER, space: 1 } }, spacing: { after: 200 } }));
        break;
      case "code":
        for (const line of b.v.split("\n")) {
          out.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: MONO, size: 18 })], shading: { type: ShadingType.CLEAR, color: "auto", fill: SURFACE }, spacing: { after: 0 }, indent: ctx.indent ? { left: ctx.indent } : undefined }));
        }
        out.push(new Paragraph({ children: [], spacing: { after: 80 } }));
        break;
      case "quote":
        out.push(...paragraphs(b.blocks, { ...ctx, indent: ctx.indent + 360, color: MUTED }));
        break;
      case "callout":
        out.push(new Paragraph({ children: b.title.length ? runs(b.title, { bold: true }) : [new TextRun({ text: b.kind[0].toUpperCase() + b.kind.slice(1), bold: true })], shading: { type: ShadingType.CLEAR, color: "auto", fill: SURFACE }, spacing: { after: 40 }, indent: ctx.indent ? { left: ctx.indent } : undefined }));
        out.push(...paragraphs(b.blocks, { ...ctx, shade: true }));
        break;
      case "list": {
        const instance = b.ordered ? ctx.nextList() : 0;
        for (const item of b.items) {
          const [first, ...rest] = item.blocks;
          const box = item.checked === null ? [] : [new TextRun({ text: item.checked ? "☑ " : "☐ ", font: "Segoe UI Symbol" })];
          const firstRuns = first && first.t === "p" ? runs(first.c, item.checked ? { color: FAINT } : {}) : [];
          const level = Math.min(ctx.level, 8);
          out.push(new Paragraph({
            children: [...box, ...firstRuns],
            ...(b.ordered ? { numbering: { reference: "db-ordered", level, instance } } : item.checked !== null ? { indent: { left: 360 + level * 360 + ctx.indent } } : { bullet: { level } }),
            spacing: { after: 40 },
          }));
          const more = first && first.t === "p" ? rest : item.blocks;
          out.push(...paragraphs(more, { ...ctx, level: ctx.level + 1 }));
        }
        break;
      }
      case "table": {
        const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length), 1);
        const cell = (c: Inline[] | undefined, head: boolean) => new TableCell({
          children: [new Paragraph({ children: runs(c ?? [], head ? { bold: true } : {}) })],
          shading: head ? { type: ShadingType.CLEAR, color: "auto", fill: SURFACE } : undefined,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
        });
        const row = (r: Inline[][], head: boolean) => new TableRow({ tableHeader: head, children: Array.from({ length: cols }, (_, k) => cell(r[k], head)) });
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [...(b.head.length ? [row(b.head, true)] : []), ...b.rows.map((r) => row(r, false))],
          borders: {
            top: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
            left: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, right: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
          },
        }));
        out.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      }
    }
  }
  return out;
}

/** The Document object (exported for tests). */
export function buildDocx(d: ExportDoc, now = new Date()): Document {
  let lists = 0;
  const body = paragraphs(docBlocks(d), { level: 0, indent: 0, nextList: () => ++lists });
  const made = now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return new Document({
    creator: "Daily brief",
    title: d.title,
    styles: {
      default: { document: { run: { font: SANS, size: 22, color: INK } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 34, bold: true, font: SANS, color: INK }, paragraph: { spacing: { before: 320, after: 120 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 28, bold: true, font: SANS, color: INK }, paragraph: { spacing: { before: 280, after: 100 } } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 24, bold: true, font: SANS, color: INK }, paragraph: { spacing: { before: 220, after: 80 } } },
        { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", run: { size: 44, bold: true, font: SANS, color: INK }, paragraph: { spacing: { after: 60 } } },
      ],
    },
    numbering: {
      config: [{
        reference: "db-ordered",
        levels: Array.from({ length: 9 }, (_, level) => ({
          level, format: level % 3 === 0 ? LevelFormat.DECIMAL : level % 3 === 1 ? LevelFormat.LOWER_LETTER : LevelFormat.LOWER_ROMAN,
          text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
        })),
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
      children: [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(d.title)] }),
        ...(d.subtitle ? [new Paragraph({ children: [new TextRun({ text: d.subtitle, color: MUTED, size: 20 })], spacing: { after: 280 } })] : []),
        ...body,
        new Paragraph({ children: [new TextRun({ text: `Exported from Daily brief, ${made}.`, color: FAINT, size: 18 })], spacing: { before: 480 } }),
      ],
    }],
  });
}

/** The .docx file's bytes. */
export async function renderDocx(d: ExportDoc, now = new Date()): Promise<Buffer> {
  return Packer.toBuffer(buildDocx(d, now));
}
