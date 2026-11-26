/**
 * Whether a provider's enable switch draws ticked: only when a token is saved and it passed its
 * test (a passing test is the only thing that sets `enabled`). With no token it is always off.
 */
export function switchOn(enabled: boolean, saved: string | null): boolean {
  return enabled && !!saved;
}
