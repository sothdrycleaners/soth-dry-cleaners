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
