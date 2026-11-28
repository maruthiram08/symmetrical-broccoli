import { describe, expect, it, vi } from "vitest";
import { appMode, isHosted } from "@/server/mode";
import { completeSignIn, pkceChallenge, safeNext, sendMagicLink } from "./auth";
import { isPublicPath, signSession, verifySession } from "./session";

const cfg = { supabaseUrl: "https://proj.supabase.co", supabaseAnonKey: "anon", appUrl: "https://brief.example.com", allowedEmails: [] as string[] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SECRET = "x".repeat(40);
const UID = "11111111-2222-4333-8444-555555555555";

describe("mode switch", () => {
  it("is local unless DAILY_BRIEF_MODE=hosted", () => {
    expect(appMode({})).toBe("local");
    expect(appMode({ DAILY_BRIEF_MODE: "cloud" })).toBe("local");
    expect(appMode({ DAILY_BRIEF_MODE: " Hosted " })).toBe("hosted");
    expect(isHosted({ DAILY_BRIEF_MODE: "local" })).toBe(false);
  });
});

describe("magic link", () => {
  it("asks Supabase for a PKCE magic link back to /auth/callback", async () => {
    const f = vi.fn(async () => json({}));
    const r = await sendMagicLink(" Asha@X.com ", cfg, f as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/auth/v1/otp?redirect_to=https%3A%2F%2Fbrief.example.com%2Fauth%2Fcallback");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ email: "asha@x.com", create_user: true, code_challenge_method: "s256" });
    expect(body.code_challenge).toBe(pkceChallenge((r as { verifier: string }).verifier));
  });

  it("refuses bad and uninvited emails without calling Supabase", async () => {
    const f = vi.fn(async () => json({}));
    expect(await sendMagicLink("nope", cfg, f as unknown as typeof fetch)).toEqual({ ok: false, error: "invalid_email" });
    expect(await sendMagicLink("z@x.com", { ...cfg, allowedEmails: ["a@x.com"] }, f as unknown as typeof fetch)).toEqual({ ok: false, error: "not_invited" });
    expect(f).not.toHaveBeenCalled();
    const fail = vi.fn(async () => json({}, 429));
    expect(await sendMagicLink("a@x.com", cfg, fail as unknown as typeof fetch)).toEqual({ ok: false, error: "send_failed" });
  });

  it("exchanges the code with the verifier, or verifies a token hash", async () => {
    const f = vi.fn(async () => json({ user: { id: UID, email: "Asha@x.com" } }));
    expect(await completeSignIn({ code: "c", verifier: "v" }, cfg, f as unknown as typeof fetch)).toEqual({ id: UID, email: "asha@x.com" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/auth/v1/token?grant_type=pkce");
    expect(JSON.parse(String(init.body))).toEqual({ auth_code: "c", code_verifier: "v" });
    await completeSignIn({ tokenHash: "h", type: "magiclink" }, cfg, f as unknown as typeof fetch);
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ type: "magiclink", token_hash: "h" });
  });

  it("fails closed: no verifier, a rejected code, or an email off the list", async () => {
    const ok = vi.fn(async () => json({ user: { id: UID, email: "z@x.com" } }));
    expect(await completeSignIn({ code: "c" }, cfg, ok as unknown as typeof fetch)).toBeNull();
    expect(await completeSignIn({ code: "c", verifier: "v" }, cfg, (async () => json({}, 400)) as unknown as typeof fetch)).toBeNull();
    expect(await completeSignIn({ code: "c", verifier: "v" }, { ...cfg, allowedEmails: ["a@x.com"] }, ok as unknown as typeof fetch)).toBeNull();
  });

  it("only follows same-site next paths", () => {
    expect(safeNext("/team?ws=1")).toBe("/team?ws=1");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("/\\evil.com")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });
});

describe("session cookie", () => {
  it("round-trips and expires", async () => {
    const v = await signSession(UID, SECRET, 1_000_000);
    expect(await verifySession(v, SECRET, 1_000_000)).toBe(UID);
    expect(await verifySession(v, SECRET, 1_000_000 + 31 * 86_400_000)).toBeNull();
  });

  it("rejects tampering and other secrets", async () => {
    const v = await signSession(UID, SECRET);
    const other = "22222222-2222-4333-8444-555555555555";
    expect(await verifySession(v.replace(UID, other), SECRET)).toBeNull();
    expect(await verifySession(v, "y".repeat(40))).toBeNull();
    expect(await verifySession(v.replace(/\.(\d+)\./, ".9999999999."), SECRET)).toBeNull();
    expect(await verifySession("garbage", SECRET)).toBeNull();
    expect(await verifySession(v, "short")).toBeNull();
    await expect(signSession(UID, "short")).rejects.toThrow();
  });

  it("lets only sign-in, cron and the webhook through without a session", () => {
    for (const p of ["/login", "/auth/callback", "/api/cron/poll", "/api/billing/webhook", "/api/health"]) expect(isPublicPath(p), p).toBe(true);
    for (const p of ["/", "/setup", "/api/ask", "/team", "/item/x", "/api/account/export", "/loginx"]) expect(isPublicPath(p), p).toBe(false);
  });
});
