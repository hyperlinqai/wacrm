import { describe, it, expect } from 'vitest';
import type { Conversation, Message } from '@wacrm/shared/types';
import { serializeConversation, serializeMessage, originFromMessages } from './conversations';

describe('serializeConversation', () => {
  it('projects public fields + nested contact/tags and drops internals', () => {
    const conv = {
      id: 'conv1',
      user_id: 'internal-user',
      account_id: 'internal-acct',
      contact_id: 'c1',
      status: 'open',
      last_message_text: 'hi',
      last_message_at: '2026-01-01T00:00:00Z',
      unread_count: 2,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      contact: {
        id: 'c1',
        phone: '+1',
        name: 'Jane',
        tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      },
    } as unknown as Conversation;

    const out = serializeConversation(conv);
    expect(out).not.toHaveProperty('user_id');
    expect(out).not.toHaveProperty('account_id');
    expect(out.contact?.tags).toEqual([{ id: 't1', name: 'vip', color: '#fff' }]);
    expect(out.unread_count).toBe(2);
  });
});

describe('serializeMessage', () => {
  it('maps message_id → whatsapp_message_id and derives direction', () => {
    const inbound = {
      id: 'm1',
      conversation_id: 'conv1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'hello',
      message_id: 'wamid.123',
      status: 'delivered',
      created_at: '2026-01-01T00:00:00Z',
    } as unknown as Message;
    const outMsg = serializeMessage(inbound);
    expect(outMsg.direction).toBe('inbound');
    expect(outMsg.whatsapp_message_id).toBe('wamid.123');
    expect(outMsg).not.toHaveProperty('message_id');

    const agent = { ...inbound, sender_type: 'agent' } as unknown as Message;
    expect(serializeMessage(agent).direction).toBe('outbound');
  });
});

describe('originFromMessages', () => {
  const row = (sender_type: string, created_at: string, broadcast_id: string | null = null) =>
    ({ conversation_id: 'c1', sender_type, broadcast_id, created_at });

  it('attributes a thread opened by a broadcast send even after the customer replies', () => {
    const o = originFromMessages([
      row('customer', '2026-09-12T11:00:00Z'),
      row('bot', '2026-09-12T10:00:00Z', 'b1'),
    ]);
    expect(o.origin).toBe('broadcast');
    expect(o.origin_flags).toEqual({ automation: false, broadcast: true, agent: false, inbound: true });
  });

  it('treats untagged bot messages as automation and empty threads as inbound', () => {
    expect(originFromMessages([row('bot', '2026-09-12T10:00:00Z')]).origin).toBe('automation');
    expect(originFromMessages([]).origin).toBe('inbound');
  });
});
