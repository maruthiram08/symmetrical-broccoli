import { describe, expect, it, vi } from "vitest";
import { fixtureBrief } from "@/lib/email/fixture";
import type { User } from "@/lib/types";
import { checkHostedEnv } from "./config";
import { isSlackWebhook, publishHosted, slackText } from "./deliver";

const user: User = { id: "u1", email: "a@x.com", name: "A", aliases: [], timeZone: "Asia/Kolkata", briefTime: "18:00", createdAt: "2026-11-01T00:00:00.000Z" };
const HOOK = "https://hooks.slack.com/services/T0/B0/abc";
const ok = (body: unknown = { id: "em_1" }) => new Response(JSON.stringify(body), { status: 200 });

describe("publishHosted", () => {
  it("emails through Resend with an idempotency key per user and day", async () => {
    const f = vi.fn(async () => ok());
    const model = fixtureBrief;
    const r = await publishHosted(user, model, "# md", { appUrl: "https://b.example", resendKey: "re_x", emailFrom: "Brief <b@b.example>", delivery: { email: true, slackWebhook: null }, fetch: f as unknown as typeof fetch });
    expect(r).toEqual({ id: "em_1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(`brief-u1-${model.date}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: "Brief <b@b.example>", to: ["a@x.com"], subject: model.subject });
    expect(body.html).toContain("https://b.example/item/");
  });

  it("posts to Slack too, adds the team lines, and succeeds if one channel works", async () => {
    const f = vi.fn(async (url: string) => (url.startsWith("https://api.resend.com") ? new Response("{}", { status: 500 }) : new Response("ok")));
    const r = await publishHosted(user, fixtureBrief, "", { appUrl: "https://b.example", resendKey: "re_x", emailFrom: "x", delivery: { email: true, slackWebhook: HOOK }, team: ["Growth · Asha: 2 open"], fetch: f as unknown as typeof fetch });
    expect(r).toEqual({ id: "slack" });
    const slack = JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(slack.text).toContain("Growth · Asha: 2 open");
  });

  it("throws when every channel failed, so the brief is tried again", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 500 }));
    await expect(publishHosted(user, fixtureBrief, "", { appUrl: "x", resendKey: "re", emailFrom: "x", delivery: { email: true, slackWebhook: null }, fetch: f as unknown as typeof fetch })).rejects.toThrow(/Resend/);
    await expect(publishHosted(user, fixtureBrief, "", { appUrl: "x", resendKey: "re", emailFrom: "x", delivery: { email: false, slackWebhook: null } })).rejects.toThrow();
  });

  it("only calls Slack's own webhook host", () => {
    expect(isSlackWebhook(HOOK)).toBe(true);
    expect(isSlackWebhook("https://hooks.slack.com.evil.com/services/x")).toBe(false);
    expect(isSlackWebhook("http://hooks.slack.com/services/x")).toBe(false);
    expect(slackText({ ...fixtureBrief, empty: "no_meetings", youOwe: [] }, "https://b")).toContain("No meetings today.");
  });
});

describe("checkHostedEnv", () => {
  const good = {
    DAILY_BRIEF_MODE: "hosted", APP_URL: "https://brief.example.com",
    DATABASE_URL: "postgresql://postgres.ref:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres", DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----",
    SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon", ANTHROPIC_API_KEY: "sk-ant-x",
    CRON_SECRET: "c".repeat(32), SESSION_SECRET: "s".repeat(40), TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    RESEND_API_KEY: "re_x", EMAIL_FROM: "Brief <b@brief.example.com>", ALLOWED_EMAILS: "a@x.com",
  };

  it("passes a complete setup, with a note that billing is off", () => {
    expect(checkHostedEnv(good)).toEqual({ errors: [], warnings: ["BILLING_ENABLED is off: everyone has the full plan, no limits"] });
  });

  it("names what's missing or wrong, never the values", () => {
    const r = checkHostedEnv({ ...good, DATABASE_URL: good.DATABASE_URL.replace(":5432", ":6543"), TOKEN_ENCRYPTION_KEY: "short", SESSION_SECRET: undefined, APP_URL: "http://brief.example.com" });
    expect(r.errors.join("\n")).toMatch(/transaction pooler/);
    expect(r.errors.join("\n")).toMatch(/TOKEN_ENCRYPTION_KEY must be 32 bytes/);
    expect(r.errors.join("\n")).toMatch(/SESSION_SECRET is missing/);
    expect(r.errors.join("\n")).toMatch(/APP_URL must start with https/);
    expect(r.errors.join("\n")).not.toContain("pw@");
    expect(checkHostedEnv({}).errors[0]).toMatch(/DAILY_BRIEF_MODE/);
  });

  it("refuses Razorpay live keys", () => {
    const r = checkHostedEnv({ ...good, BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_live_x", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w", RAZORPAY_PLAN_ID: "plan_x" });
    expect(r.errors).toEqual([expect.stringMatching(/not a test key/)]);
    expect(checkHostedEnv({ ...good, BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w", RAZORPAY_PLAN_ID: "plan_x" }).errors).toEqual([]);
  });
});
