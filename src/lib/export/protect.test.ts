import { describe, expect, it } from "vitest";
import { renderExportHtml } from "./html";
import { OPEN_SCRIPT, PBKDF2_ITERATIONS, passwordProblem, protectHtml, protectedHtml, seal, unseal, type Sealed } from "./protect";

const SECRET = "Send Nitin the Q4 zebrafish numbers before the board call";
const page = renderExportHtml({ title: "Board prep", markdown: `# Board prep\n\n- [ ] ${SECRET}\n` });

/** The payload inside a protected file. */
const payloadOf = (file: string): Sealed => JSON.parse(file.match(/<script type="application\/json" id="p">([\s\S]*?)<\/script>/)![1]);
/** The very script the file runs in the browser, run here: dbOpen(payload, password). */
const fileOpener = () => new Function(`${OPEN_SCRIPT}; return dbOpen;`)() as (p: Sealed, pw: string) => Promise<string>;

describe("protected sharing", () => {
  it("uses AES-GCM with a PBKDF2 key of at least 200k iterations, fresh salt and IV each time", async () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(200_000);
    const a = await seal("x", "correct horse");
    const b = await seal("x", "correct horse");
    expect(a.iter).toBe(PBKDF2_ITERATIONS);
    expect(a.kdf).toBe("PBKDF2-SHA256");
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    await expect(seal("x", "pw", 1000)).rejects.toThrow();
  });

  it("opens with the right password and fails with a wrong one", async () => {
    const s = await seal(page, "correct horse battery");
    expect(await unseal(s, "correct horse battery")).toBe(page);
    await expect(unseal(s, "correct horse batterY")).rejects.toThrow();
    await expect(unseal(s, "")).rejects.toThrow();
  });

  it("the file's own script decrypts with the right password and rejects a wrong one", async () => {
    const file = await protectHtml(page, "correct horse battery");
    const open = fileOpener();
    expect(await open(payloadOf(file), "correct horse battery")).toBe(page);
    await expect(open(payloadOf(file), "wrong password")).rejects.toThrow();
  });

  it("refuses a file that was changed", async () => {
    const s = await seal(page, "correct horse battery");
    const ct = Buffer.from(s.ct, "base64");
    ct[10] ^= 1;
    await expect(unseal({ ...s, ct: ct.toString("base64") }, "correct horse battery")).rejects.toThrow();
  });

  it("contains no plaintext: not the content, not the title, not the password", async () => {
    const file = await protectHtml(page, "correct horse battery");
    for (const s of [SECRET, "Send Nitin", "zebrafish", "Board prep", "correct horse", "Nitin"]) expect(file).not.toContain(s);
    // Not even base64 of a plain run of it.
    expect(file).not.toContain(Buffer.from(SECRET).toString("base64").slice(0, 16));
    expect(file).toContain("<title>Protected file</title>");
    expect(file).not.toMatch(/https?:\/\//);
    expect(protectedHtml(payloadOf(file))).toBe(file);
  });

  it("checks the password before making a file", () => {
    expect(passwordProblem("short", "short")).toMatch(/at least 8/);
    expect(passwordProblem("long enough", "long enougH")).toMatch(/don't match/);
    expect(passwordProblem("long enough", "long enough")).toBeNull();
  });
});
