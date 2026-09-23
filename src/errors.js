/**
 * Failures that have a shape the caller can act on.
 *
 * The rest of the stack throws ordinary Errors: a missing mailbox, a message
 * that has gone from the server, a parse that found nothing. Those are 502s
 * and worth saying out loud.
 *
 * This one is different. It means the credential itself was refused — an
 * app-specific password revoked at account.apple.com, a typo that survived
 * the first connect — and no retry and no amount of waiting will fix it. The
 * account is marked `reauth` and somebody has to paste a fresh password.
 *
 * It used to be an `e.reauth = true` flag stuck onto whatever Error was
 * already in flight. That survived a round trip through `String(e.message)`
 * about as well as you would expect.
 */
export class MailAuthError extends Error {
  constructor(message = "Apple rejected that address or app password") {
    super(message);
    this.name = "MailAuthError";
  }
}

/** true when this failure means "reconnect the account", whatever threw it. */
export const isAuthFailure = (e) =>
  e instanceof MailAuthError || !!(e && e.reauth);
