// All configuration comes from environment variables. Nothing secret is committed.
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  get appUrl() { return process.env.APP_URL ?? "http://localhost:3000"; },
  get supabaseUrl() { return need("SUPABASE_URL"); },
  get supabaseServiceKey() { return need("SUPABASE_SERVICE_ROLE_KEY"); },
  get anthropicKey() { return need("ANTHROPIC_API_KEY"); },
  get extractionModel() { return process.env.EXTRACTION_MODEL ?? "claude-sonnet-5-5"; },
  get resendKey() { return need("RESEND_API_KEY"); },
  get emailFrom() { return process.env.EMAIL_FROM ?? "Daily brief <brief@example.com>"; },
  /** 32-byte key, base64. Encrypts OAuth tokens at rest and signs action links. */
  get tokenKey() { return need("TOKEN_ENCRYPTION_KEY"); },
  get linkSecret() { return need("LINK_SIGNING_SECRET"); },
  get cronSecret() { return need("CRON_SECRET"); },
  get wisprMcpUrl() { return process.env.WISPR_MCP_URL ?? "https://mcp.wisprflow.ai/mcp"; },
};
