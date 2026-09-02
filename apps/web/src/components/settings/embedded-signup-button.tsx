'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

import { loadFacebookSdk } from '@/lib/meta/facebook-sdk';

/** Shape of the WA_EMBEDDED_SIGNUP postMessage Meta's popup sends. */
interface EmbeddedSignupMessage {
  type: 'WA_EMBEDDED_SIGNUP';
  event: 'FINISH' | 'FINISH_ONLY_WABA' | 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' | 'CANCEL';
  data?: {
    phone_number_id?: string;
    waba_id?: string;
    current_step?: string;
    error_message?: string;
    error_code?: string | number;
  };
}

interface EmbeddedSignupButtonProps {
  onConnected: () => void;
}

/**
 * "Connect WhatsApp with Meta" — the fully automatic onboarding path.
 * The business logs into Facebook, picks their WhatsApp Business
 * Account, phone number and 2-step-verification PIN entirely inside
 * Meta's own hosted UI; this component's only job is to run that
 * flow and hand the result to the server, which does the rest
 * (POST /api/whatsapp/embedded-signup — see that route for why no
 * manual token/WABA-id/PIN entry is needed on either side).
 *
 * Two independent signals have to both arrive before the flow can be
 * completed:
 *   - FB.login()'s callback: an OAuth `code` (valid only ~30s)
 *   - a window `message` event Meta's popup posts on completion,
 *     carrying which phone number / WABA the business picked
 * They aren't guaranteed to arrive in the same order every time, so
 * both are held in refs and the server call fires once whichever
 * arrives second completes the pair.
 */
export function EmbeddedSignupButton({ onConnected }: EmbeddedSignupButtonProps) {
  const t = useTranslations('Settings.whatsapp.embeddedSignup');
  const [status, setStatus] = useState<'idle' | 'loading-sdk' | 'awaiting-popup' | 'finishing'>(
    'idle',
  );

  const codeRef = useRef<string | null>(null);
  const selectionRef = useRef<{ phoneNumberId: string; wabaId: string } | null>(null);
  const submittedRef = useRef(false);

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const configId = process.env.NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID;
  const configured = Boolean(appId && configId);

  const finishIfReady = useCallback(async () => {
    if (submittedRef.current) return;
    const code = codeRef.current;
    const selection = selectionRef.current;
    if (!code || !selection) return;
    submittedRef.current = true;
    setStatus('finishing');

    try {
      const res = await fetch('/api/whatsapp/embedded-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          phone_number_id: selection.phoneNumberId,
          waba_id: selection.wabaId,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error || t('toastFailed'));
      } else if (data.registration_error) {
        toast.error(t('toastConnectedNotRegistered'));
        onConnected();
      } else {
        toast.success(t('toastConnected'));
        onConnected();
      }
    } catch (err) {
      console.error('[embedded-signup] finish failed:', err);
      toast.error(t('toastFailed'));
    } finally {
      setStatus('idle');
      codeRef.current = null;
      selectionRef.current = null;
      submittedRef.current = false;
    }
  }, [onConnected, t]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // Meta's own documented origin check for this exact event —
      // covers www.facebook.com / web.facebook.com / any future
      // subdomain they route the popup through.
      if (!event.origin.endsWith('facebook.com')) return;

      let parsed: EmbeddedSignupMessage;
      try {
        parsed = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return; // Not JSON — not our message (Facebook's SDK posts other event shapes too).
      }
      if (parsed?.type !== 'WA_EMBEDDED_SIGNUP') return;

      if (parsed.event === 'CANCEL') {
        if (parsed.data?.error_message) {
          console.error('[embedded-signup] Meta reported an error:', parsed.data);
          toast.error(t('toastMetaError', { message: parsed.data.error_message }));
        }
        // A plain user-abandoned cancel (current_step set, no error_message)
        // is not worth a toast — they just closed the popup.
        setStatus('idle');
        codeRef.current = null;
        selectionRef.current = null;
        return;
      }

      // FINISH / FINISH_ONLY_WABA / FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING
      const { phone_number_id, waba_id } = parsed.data ?? {};
      if (!phone_number_id || !waba_id) {
        // WABA created but no phone number attached yet — signup isn't
        // complete enough to activate. Not an error the user caused.
        toast.info(t('toastNoPhoneSelected'));
        setStatus('idle');
        return;
      }
      selectionRef.current = { phoneNumberId: phone_number_id, wabaId: waba_id };
      finishIfReady();
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [finishIfReady, t]);

  async function handleClick() {
    if (!appId || !configId) return;
    setStatus('loading-sdk');
    try {
      await loadFacebookSdk(appId);
    } catch (err) {
      console.error('[embedded-signup] SDK load failed:', err);
      toast.error(t('toastSdkLoadFailed'));
      setStatus('idle');
      return;
    }

    setStatus('awaiting-popup');
    window.FB!.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          // User closed Facebook's own login dialog before Meta's
          // WA_EMBEDDED_SIGNUP flow even started — no message event
          // will follow either. Nothing to report; just reset.
          setStatus('idle');
          return;
        }
        codeRef.current = code;
        finishIfReady();
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {} },
      },
    );
  }

  if (!configured) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {t('notConfigured')}
      </p>
    );
  }

  const busy = status !== 'idle';

  return (
    <Button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className="bg-primary text-primary-foreground hover:bg-primary/90"
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
      {status === 'loading-sdk'
        ? t('statusLoadingSdk')
        : status === 'awaiting-popup'
          ? t('statusAwaitingPopup')
          : status === 'finishing'
            ? t('statusFinishing')
            : t('connectBtn')}
    </Button>
  );
}
