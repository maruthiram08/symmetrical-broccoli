export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadSecrets } = await import("./server/local/secrets");
  await loadSecrets();
  const { startScheduler } = await import("./server/local/scheduler");
  startScheduler();
}
