/**
 * Turn Meta's raw `/register` error text into something a non-technical
 * admin can actually act on. Meta's message is just enough detail for
 * a developer reading logs ("(#133005) Two step verification pin
 * mismatch") — surfaced as-is in the Settings UI, it reads as an
 * opaque code with no next step.
 *
 * Only maps codes actually seen in the wild; anything unrecognized
 * falls back to the raw message so nothing is silently hidden.
 */
export interface ExplainedRegistrationError {
  /** Plain-language explanation of what went wrong. */
  summary: string;
  /** What to actually do about it. */
  action: string;
}

export function explainRegistrationError(
  error: string | null | undefined
): ExplainedRegistrationError | null {
  if (!error) return null;

  // (#133005) — the pin sent to /register doesn't match the PIN Meta
  // already has on file for this number. Happens whenever the number
  // was previously registered elsewhere (WhatsApp Business app, an
  // earlier Cloud API connection, a different BSP) with a PIN this app
  // doesn't know — including Embedded Signup, which has to invent a
  // PIN since Meta's popup never hands one back to the caller.
  if (/133005/.test(error) || /pin mismatch/i.test(error)) {
    return {
      summary:
        'This number already has a 2-step verification PIN set from an earlier WhatsApp connection, and it doesn\'t match the one just used.',
      action:
        'Enter that existing PIN in the field below and click Save Configuration. If you don\'t know it, reset it in Meta\'s WhatsApp Manager (business.facebook.com → WhatsApp Manager → your phone number → Two-step verification) and try again.',
    };
  }

  return null;
}
