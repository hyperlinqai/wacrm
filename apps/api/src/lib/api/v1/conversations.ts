// ============================================================
// Public API (v1) serializers for conversations + messages.
//
// The dashboard's `Conversation`/`Message` rows carry internal columns
// (account_id, user_id, sender_id) that shouldn't leak onto the public
// wire. These serializers project the stable public subset and rename
// the Meta id (`message_id` → `whatsapp_message_id`) to match the send
// endpoint's response vocabulary.
// ============================================================

import type { Conversation, Message } from '@wacrm/shared/types';
import type { SupabaseClient } from '@wacrm/shared/db';

export interface ApiConversation {
  id: string;
  contact_id: string;
  status: string;
  assigned_agent_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
    tags: { id: string; name: string; color: string }[];
  } | null;
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  template_name: string | null;
  whatsapp_message_id: string | null;
  status: string;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  created_at: string;
}

/**
 * Project a normalized `Conversation` (from `normalizeConversation`,
 * which has already flattened `contact.tags`) into the public shape.
 */
export function serializeConversation(conv: Conversation): ApiConversation {
  const c = conv.contact;
  return {
    id: conv.id,
    contact_id: conv.contact_id,
    status: conv.status,
    assigned_agent_id: conv.assigned_agent_id ?? null,
    last_message_text: conv.last_message_text ?? null,
    last_message_at: conv.last_message_at ?? null,
    unread_count: conv.unread_count ?? 0,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    contact: c
      ? {
          id: c.id,
          phone: c.phone,
          name: c.name ?? null,
          email: c.email ?? null,
          company: c.company ?? null,
          tags: (c.tags ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
          })),
        }
      : null,
  };
}

/** Project a `messages` row into the public shape. */
export function serializeMessage(m: Message): ApiMessage {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    // `customer` = inbound (from the contact); anything else is outbound.
    direction: m.sender_type === 'customer' ? 'inbound' : 'outbound',
    sender_type: m.sender_type,
    content_type: m.content_type,
    content_text: m.content_text ?? null,
    media_url: m.media_url ?? null,
    template_name: m.template_name ?? null,
    whatsapp_message_id: m.message_id ?? null,
    status: m.status,
    reply_to_message_id: m.reply_to_message_id ?? null,
    interactive_reply_id: m.interactive_reply_id ?? null,
    created_at: m.created_at,
  };
}

// ---------- Origin attribution ----------
//
// Which outbound channel opened the thread. Automations and flows persist their sends as
// `bot` messages, agents/API as `agent`, customers as `customer`; broadcast sends are NOT
// message rows — they live in broadcast_recipients (sent_at per contact). Comparing the
// earliest of each per conversation gives the channel that started it; the flags say which
// channels have touched it at all, so an inbox can group threads by route.

export type ConversationOrigin = 'automation' | 'broadcast' | 'inbound' | 'agent';

export interface OriginInfo {
  origin: ConversationOrigin;
  origin_flags: { automation: boolean; broadcast: boolean; agent: boolean; inbound: boolean };
}

export async function attachConversationOrigins<T extends { id: string; contact_id: string; created_at: string }>(
  db: SupabaseClient,
  organizationId: string,
  rows: T[]
): Promise<Array<T & OriginInfo>> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const contactIds = [...new Set(rows.map((r) => r.contact_id))];

  const [{ data: msgs }, { data: sends }] = await Promise.all([
    db
      .from('messages')
      .select('conversation_id, sender_type, created_at')
      .in('conversation_id', ids)
      .order('created_at', { ascending: true }),
    db
      .from('broadcast_recipients')
      .select('contact_id, sent_at, broadcast:broadcasts!inner(organization_id)')
      .in('contact_id', contactIds)
      .eq('broadcast.organization_id', organizationId)
      .not('sent_at', 'is', null),
  ]);

  type First = { bot?: string; agent?: string; customer?: string };
  const firstByConv = new Map<string, First>();
  for (const m of (msgs ?? []) as { conversation_id: string; sender_type: keyof First; created_at: string }[]) {
    const f = firstByConv.get(m.conversation_id) ?? {};
    if (!f[m.sender_type]) f[m.sender_type] = m.created_at;
    firstByConv.set(m.conversation_id, f);
  }
  const firstSendByContact = new Map<string, string>();
  for (const s of (sends ?? []) as { contact_id: string; sent_at: string }[]) {
    const cur = firstSendByContact.get(s.contact_id);
    if (!cur || s.sent_at < cur) firstSendByContact.set(s.contact_id, s.sent_at);
  }

  return rows.map((r) => {
    const f = firstByConv.get(r.id) ?? {};
    const broadcastAt = firstSendByContact.get(r.contact_id);
    const candidates: Array<[ConversationOrigin, string | undefined]> = [
      ['automation', f.bot],
      ['broadcast', broadcastAt],
      ['inbound', f.customer],
      ['agent', f.agent],
    ];
    const earliest = candidates
      .filter((c): c is [ConversationOrigin, string] => Boolean(c[1]))
      .sort((a, b) => (a[1] < b[1] ? -1 : 1))[0];
    return {
      ...r,
      origin: earliest?.[0] ?? 'inbound',
      origin_flags: {
        automation: Boolean(f.bot),
        broadcast: Boolean(broadcastAt),
        agent: Boolean(f.agent),
        inbound: Boolean(f.customer),
      },
    };
  });
}
