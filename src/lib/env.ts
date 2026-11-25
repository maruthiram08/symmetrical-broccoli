// Configuration from environment variables (.env.local next to the app). Nothing secret is committed.
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. Add it to .env.local`);
  return v;
}

export const env = {
  get anthropicKey() { return need("ANTHROPIC_API_KEY"); },
  get extractionModel() { return process.env.EXTRACTION_MODEL ?? "claude-sonnet-5-5"; },
  /** 32-byte key, base64. The local app generates one in the data folder on first run. */
  get tokenKey() { return need("TOKEN_ENCRYPTION_KEY"); },
  get wisprMcpUrl() { return process.env.WISPR_MCP_URL ?? "https://api.wisprflow.ai/connect/mcp"; },
};
