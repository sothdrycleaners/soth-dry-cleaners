/** Only these responses prove that a stored login can no longer be used.
 * A request that forgot to attach its header must not sign the user out. */
export function isInvalidSessionResponse(status: number | undefined, data: unknown): boolean {
  if (status !== 401 || !data || typeof data !== 'object') return false;

  const message = String((data as { error?: unknown }).error || '').trim().toLowerCase();
  return message.includes('invalid or expired token') ||
    message.includes('invalid token format') ||
    message.includes('account is inactive') ||
    message.includes('complete administrator pin verification') ||
    message.includes('session has expired');
}


/** Store a minimal same-tab diagnostic when the app removes a login. Never store tokens or user data. */
export function recordAuthExitReason(reason: string): void {
  try {
    const diagnostic = {
      reason,
      at: new Date().toISOString(),
      path: `${window.location.pathname}${window.location.search}`,
    };
    sessionStorage.setItem('soth_auth_exit_reason', JSON.stringify(diagnostic));
    console.warn('[Soth auth diagnostic]', diagnostic);
  } catch {
    // Diagnostics must never interfere with authentication behavior.
  }
}
