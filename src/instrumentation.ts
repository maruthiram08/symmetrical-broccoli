export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadSecrets } = await import("./server/local/secrets");
  await loadSecrets();
  const { startScheduler } = await import("./server/local/scheduler");
  startScheduler();
  // Phone access (off by default): the LAN door for paired phones, see src/server/local/phone-proxy.ts.
  const { syncPhoneAccess } = await import("./server/local/phone-proxy");
  await syncPhoneAccess();
}
