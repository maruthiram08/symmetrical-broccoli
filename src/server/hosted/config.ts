// Hosted-mode configuration, all from environment variables (Vercel project settings).
// Nothing here is read in local mode. `npm run hosted:check` runs checkHostedEnv on your env.
type Env = Record<string, string | undefined>;

const on = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? "");
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export interface HostedConfig {
  appUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  sessionSecret: string;
  cronSecret: string;
  resendKey: string;
  emailFrom: string;
  /** Lower-case emails allowed to sign in. Empty: anyone with the link can make an account. */
  allowedEmails: string[];
  /** Users handled at once by a cron run. */
  concurrency: number;
  teamsEnabled: boolean;
  billing: BillingConfig;
}

export interface BillingConfig {
  enabled: boolean;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  planId: string;
  priceInr: number;
  freeMeetingsPerMonth: number;
  referralFreeDays: number;
}

export function billingConfig(env: Env = process.env): BillingConfig {
  return {
    enabled: on(env.BILLING_ENABLED),
    keyId: env.RAZORPAY_KEY_ID ?? "",
    keySecret: env.RAZORPAY_KEY_SECRET ?? "",
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? "",
    planId: env.RAZORPAY_PLAN_ID ?? "",
    priceInr: num(env.PRICE_INR, 500),
    freeMeetingsPerMonth: num(env.FREE_MEETINGS_PER_MONTH, 20),
    referralFreeDays: num(env.REFERRAL_FREE_DAYS, 30),
  };
}

export function hostedConfig(env: Env = process.env): HostedConfig {
  return {
    appUrl: (env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    supabaseUrl: (env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
    supabaseAnonKey: env.SUPABASE_ANON_KEY ?? "",
    sessionSecret: env.SESSION_SECRET ?? "",
    cronSecret: env.CRON_SECRET ?? "",
    resendKey: env.RESEND_API_KEY ?? "",
    emailFrom: env.EMAIL_FROM ?? "Daily brief <brief@example.com>",
    allowedEmails: (env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    concurrency: Math.max(1, Math.min(10, num(env.HOSTED_CONCURRENCY, 3))),
    teamsEnabled: on(env.TEAMS_ENABLED),
    billing: billingConfig(env),
  };
}

/** Razorpay test keys start with rzp_test_. Live keys are refused everywhere: this app never takes real money. */
export const isTestKey = (keyId: string) => keyId.startsWith("rzp_test_");

export interface EnvCheck {
  errors: string[];
  warnings: string[];
}

/** What's missing or wrong for hosted mode. Never prints secret values. */
export function checkHostedEnv(env: Env = process.env): EnvCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const need = (k: string, why: string) => { if (!env[k]?.trim()) errors.push(`${k} is missing: ${why}`); };

  if (env.DAILY_BRIEF_MODE !== "hosted") errors.push('DAILY_BRIEF_MODE must be "hosted"');
  need("APP_URL", "the public https address of the app (sign-in links and Wispr Flow come back here)");
  if (env.APP_URL && !/^https:\/\//.test(env.APP_URL) && !/localhost|127\.0\.0\.1/.test(env.APP_URL)) errors.push("APP_URL must start with https://");
  need("DATABASE_URL", "Supabase > Project Settings > Database > Connection string (session pooler, port 5432)");
  if (env.DATABASE_URL && /:6543\//.test(env.DATABASE_URL)) errors.push("DATABASE_URL uses the transaction pooler (port 6543): job locks need the session pooler (port 5432)");
  if (env.DATABASE_URL && !env.DATABASE_CA_CERT) warnings.push("DATABASE_CA_CERT is not set: the database certificate is not verified (download it from Supabase > Database > SSL)");
  need("SUPABASE_URL", "Supabase > Project Settings > API > Project URL");
  need("SUPABASE_ANON_KEY", "Supabase > Project Settings > API > anon public key (sends the sign-in emails)");
  need("ANTHROPIC_API_KEY", "reads the meetings");
  need("CRON_SECRET", "protects /api/cron/*");
  if (env.CRON_SECRET && env.CRON_SECRET.length < 24) errors.push("CRON_SECRET should be at least 24 characters");
  need("SESSION_SECRET", "signs the sign-in cookie");
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) errors.push("SESSION_SECRET should be at least 32 characters");
  need("TOKEN_ENCRYPTION_KEY", "encrypts Wispr Flow tokens (openssl rand -base64 32)");
  if (env.TOKEN_ENCRYPTION_KEY && Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64").length !== 32) errors.push("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 (openssl rand -base64 32)");
  need("RESEND_API_KEY", "sends the daily brief by email");
  if (!env.EMAIL_FROM) warnings.push("EMAIL_FROM is not set: emails come from brief@example.com, which Resend will refuse until you verify a domain");
  if (!env.ALLOWED_EMAILS) warnings.push("ALLOWED_EMAILS is empty: anyone who finds the site can make an account");

  const b = billingConfig(env);
  if (b.enabled) {
    for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_PLAN_ID"]) need(k, "billing is on (BILLING_ENABLED=1)");
    if (b.keyId && !isTestKey(b.keyId)) errors.push("RAZORPAY_KEY_ID is not a test key (rzp_test_...): live keys are refused, this app never takes real payments");
  } else {
    warnings.push("BILLING_ENABLED is off: everyone has the full plan, no limits");
  }
  return { errors, warnings };
}
