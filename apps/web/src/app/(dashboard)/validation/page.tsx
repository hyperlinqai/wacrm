'use client';

import { PhoneValidation } from '@/components/contacts/phone-validation';

/**
 * Contact number health.
 *
 * WhatsApp will only deliver to a number in international form. Most
 * imported lists are national numbers, which look fine in the contacts
 * table and then fail silently at send time — the campaign reports
 * failures with nothing to explain them. This page makes that visible
 * before a campaign runs, and fixes the ones that can be fixed.
 */
export default function ValidationPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Validation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Check that your contact numbers are in a form WhatsApp can deliver to, and fix
          the ones that are not.
        </p>
      </div>
      <PhoneValidation />
    </div>
  );
}
