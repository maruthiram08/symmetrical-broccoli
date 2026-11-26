import { describe, expect, it } from "vitest";
import { Bm25, chunkText, cosine, fuse, stem, tokenize, vectorSearch, type Doc } from "./local-index";
import { addTurn, branch, contextTurns, conversations, emptyState, lineage, nameFrom, newConversation, remove, rename, tree, type AskTurn } from "./threads";

const doc = (id: string, title: string, text: string, type: Doc["type"] = "note"): Doc => ({ id, type, title, text, at: "2026-11-20T00:00:00Z", href: `/x/${id}` });

describe("BM25", () => {
  it("tokenizes Unicode, drops stopwords and stems", () => {
    expect(tokenize("We decided the Dividend banners, haan theek hai")).toEqual(["decid", "dividend", "banner", "haan", "theek"]);
    expect(stem("deciding")).toBe(stem("decided"));
    expect(tokenize("नमस्ते दुनिया")).toHaveLength(2);
  });
  it("ranks the document about the question first, and finds nothing for unrelated words", () => {
    const docs = [doc("a", "Launch sync", "We talked about hiring and the offsite."), doc("b", "Banner review", "Ship the dividend banner on Friday. Banner copy from Tarun."), doc("c", "Standup", "Banner mention once.")];
    const hits = new Bm25(docs).search("when do we ship the dividend banner?");
    expect(hits[0].doc.id).toBe("b");
    expect(hits.map((h) => h.doc.id)).not.toContain("a");
    expect(new Bm25(docs).search("capital of France")).toEqual([]);
  });
  it("chunks long text with overlap, at line ends", () => {
    const t = Array.from({ length: 60 }, (_, i) => `Speaker ${i % 3}: line number ${i} about the roadmap.`).join("\n");
    const cs = chunkText(t, 400, 80);
    expect(cs.length).toBeGreaterThan(3);
    expect(cs.every((c) => c.length <= 400)).toBe(true);
    expect(cs.join(" ")).toContain("line number 59");
    expect(chunkText("short")).toEqual(["short"]);
    expect(chunkText("   ")).toEqual([]);
  });
  it("fuses BM25 and vector hits by reciprocal rank", () => {
    const docs = [doc("a", "A", "x"), doc("b", "B", "y"), doc("c", "C", "z")];
    const vectors = new Map([["a", [1, 0]], ["b", [0.9, 0.1]], ["c", [0, 1]]]);
    const v = vectorSearch(docs, vectors, [1, 0]);
    expect(v.map((h) => h.doc.id)).toEqual(["a", "b"]);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    const f = fuse([[{ doc: docs[2], score: 1 }, { doc: docs[1], score: 0.5 }], v]);
    expect(f[0].doc.id).toBe("b"); // second on both lists beats first on one
  });
});

const turn = (id: string, q: string): AskTurn => ({ id, question: q, answer: `Answer to ${q} [1].`, sources: [], model: "m", costInr: 0.1, at: `2026-11-26T10:0${id.length}:00Z` });

describe("branching threads", () => {
  it("branches from an answer without changing the main thread, and a branch sees the turns up to its fork", () => {
    const s = emptyState();
    newConversation(s, { id: "main", name: "x", now: "2026-11-26T10:00:00Z" });
    addTurn(s, "main", turn("t1", "What do I owe Nitin?"));
    addTurn(s, "main", turn("t2", "And Tarun?"));
    expect(s.threads[0].name).toBe("What do I owe Nitin?");
    const b = branch(s, { id: "b1", parentId: "main", turnId: "t1", quote: "I'll send the deck", now: "2026-11-26T11:00:00Z" })!;
    expect(b.name).toBe("“I'll send the deck”");
    addTurn(s, "b1", turn("t3", "When is the deck due?"));
    expect(contextTurns(s, "b1").map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(contextTurns(s, "main").map((t) => t.id)).toEqual(["t1", "t2"]);
    const bb = branch(s, { id: "b2", parentId: "b1", turnId: "t3", now: "2026-11-26T12:00:00Z" })!;
    expect(bb.name).toBe("From: When is the deck due?");
    expect(lineage(s, "b2").map((t) => t.id)).toEqual(["main", "b1", "b2"]);
    expect(contextTurns(s, "b2").map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(tree(s, "main").map((n) => [n.id, n.depth])).toEqual([["main", 0], ["b1", 1], ["b2", 2]]);
    expect(branch(s, { id: "x", parentId: "main", turnId: "nope", now: "z" })).toBeNull();
  });
  it("renames, and deleting a branch removes its own branches only", () => {
    const s = emptyState();
    newConversation(s, { id: "m", name: "n", now: "2026-11-26T10:00:00Z" });
    addTurn(s, "m", turn("t1", "q"));
    branch(s, { id: "b1", parentId: "m", turnId: "t1", now: "2026-11-26T10:01:00Z" });
    addTurn(s, "b1", turn("t2", "q2"));
    branch(s, { id: "b2", parentId: "b1", turnId: "t2", now: "2026-11-26T10:02:00Z" });
    expect(rename(s, "b1", "  Deck   timing ")).toBe(true);
    expect(s.threads.find((t) => t.id === "b1")!.name).toBe("Deck timing");
    expect(rename(s, "b1", "   ")).toBe(false);
    expect(remove(s, "b1").sort()).toEqual(["b1", "b2"]);
    expect(s.threads.map((t) => t.id)).toEqual(["m"]);
  });
  it("lists conversations by latest activity in any branch", () => {
    const s = emptyState();
    newConversation(s, { id: "a", name: "a", now: "2026-11-26T09:00:00Z" });
    addTurn(s, "a", turn("t1", "a?"));
    newConversation(s, { id: "b", name: "b", now: "2026-11-26T10:00:00Z" });
    branch(s, { id: "a1", parentId: "a", turnId: "t1", now: "2026-11-26T11:00:00Z" });
    expect(conversations(s).map((c) => c.id)).toEqual(["a", "b"]);
  });
  it("names threads from the question", () => {
    expect(nameFrom("What did we decide about the dividend banner and its tooltip on mobile?")).toMatch(/…$/);
    expect(nameFrom("")).toBe("Untitled");
  });
});
