export async function register() {
  // The if-block (not an early return) lets the edge build drop these Node-only imports.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Hosted (Vercel): no Keychain, no in-process scheduler, no phone door; Vercel Cron calls /api/cron/*.
    if (process.env.DAILY_BRIEF_MODE === "hosted") return;
    const { loadSecrets } = await import("./server/local/secrets");
    await loadSecrets();
    const { startScheduler } = await import("./server/local/scheduler");
    startScheduler();
    // Phone access (off by default): the LAN door for paired phones, see src/server/local/phone-proxy.ts.
    const { syncPhoneAccess } = await import("./server/local/phone-proxy");
    await syncPhoneAccess();
  }
}
