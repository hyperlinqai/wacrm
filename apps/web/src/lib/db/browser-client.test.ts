import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@wacrm/shared/db/client-types';

// The hub and the in-flight read map are module-level singletons, so each
// test imports a fresh copy rather than inheriting the previous one's state.
async function freshClient(): Promise<SupabaseClient> {
  vi.resetModules();
  const { makeBrowserClient } = await import('./browser-client');
  return makeBrowserClient();
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  /** The `subs` query param the hub asked the server for. */
  get subs(): { event: string; table: string; filter?: string }[] {
    const raw = new URL(this.url, 'http://localhost').searchParams.get('subs');
    return JSON.parse(raw ?? '[]');
  }
}

/** Live (not closed) streams — what actually occupies a browser socket. */
function openStreams() {
  return FakeEventSource.instances.filter((s) => !s.closed);
}

/** Let the hub's mount-burst debounce fire. */
async function settle() {
  await vi.advanceTimersByTimeAsync(100);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('realtime channels share one stream', () => {
  it('opens a single EventSource for the whole dashboard', async () => {
    const supabase = await freshClient();

    // What the dashboard mounts on the inbox route: sidebar unread,
    // sidebar + header notification counts, presence, inbox, reactions.
    supabase
      .channel('total-unread-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => {})
      .subscribe();
    supabase
      .channel('notifications-unread-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => {})
      .subscribe();
    supabase
      .channel('notifications-unread-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => {})
      .subscribe();
    supabase
      .channel('presence:acc-1')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'member_presence',
          filter: 'account_id=eq.acc-1',
        },
        () => {},
      )
      .subscribe();
    supabase
      .channel('inbox-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {})
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => {})
      .subscribe();
    supabase
      .channel('reactions:conv-1')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, () => {})
      .subscribe();

    await settle();

    // Six channels, one socket. Browsers allow six per origin over
    // HTTP/1.1 — a stream each left nothing for /api/db or navigation.
    expect(openStreams()).toHaveLength(1);
  });

  it('de-duplicates identical bindings on the wire', async () => {
    const supabase = await freshClient();
    for (const name of ['sidebar', 'header']) {
      supabase
        .channel(name)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => {})
        .subscribe();
    }
    await settle();

    expect(openStreams()[0].subs).toEqual([
      { event: '*', table: 'notifications', filter: undefined },
    ]);
  });

  it('fans one event out to every channel bound to that table', async () => {
    const supabase = await freshClient();
    const sidebar = vi.fn();
    const header = vi.fn();
    const unrelated = vi.fn();

    supabase
      .channel('sidebar')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, sidebar)
      .subscribe();
    supabase
      .channel('header')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, header)
      .subscribe();
    supabase
      .channel('inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, unrelated)
      .subscribe();
    await settle();

    openStreams()[0].onmessage?.({
      data: JSON.stringify({
        table: 'notifications',
        eventType: 'INSERT',
        commit_timestamp: '2026-01-01T00:00:00Z',
        new: { id: 'n1', read_at: null },
        old: {},
      }),
    });

    expect(sidebar).toHaveBeenCalledTimes(1);
    expect(sidebar.mock.calls[0][0]).toMatchObject({ table: 'notifications', eventType: 'INSERT' });
    expect(header).toHaveBeenCalledTimes(1);
    expect(unrelated).not.toHaveBeenCalled();
  });

  it('honours a binding filter that the merged stream does not narrow', async () => {
    const supabase = await freshClient();
    const mine = vi.fn();
    const theirs = vi.fn();

    supabase
      .channel('presence:acc-1')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'member_presence', filter: 'account_id=eq.acc-1' },
        mine,
      )
      .subscribe();
    supabase
      .channel('presence:acc-2')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'member_presence', filter: 'account_id=eq.acc-2' },
        theirs,
      )
      .subscribe();
    await settle();

    openStreams()[0].onmessage?.({
      data: JSON.stringify({
        table: 'member_presence',
        eventType: 'UPDATE',
        commit_timestamp: '2026-01-01T00:00:00Z',
        new: { user_id: 'u1', account_id: 'acc-1', status: 'online' },
        old: {},
      }),
    });

    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
  });

  it('reports SUBSCRIBED to a channel that joins an already-open stream', async () => {
    const supabase = await freshClient();
    supabase
      .channel('first')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => {})
      .subscribe();
    await settle();
    openStreams()[0].onopen?.();

    // Same binding as the live stream, so nothing reconnects — the
    // channel still has to learn that it is connected.
    const status = vi.fn();
    supabase
      .channel('second')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => {})
      .subscribe(status);
    await settle();

    expect(status.mock.calls[0][0]).toBe('SUBSCRIBED');
    expect(openStreams()).toHaveLength(1);
  });

  it('closes the stream once the last channel unsubscribes', async () => {
    const supabase = await freshClient();
    const channel = supabase
      .channel('inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {})
      .subscribe();
    await settle();
    expect(openStreams()).toHaveLength(1);

    await supabase.removeChannel(channel);
    await settle();
    expect(openStreams()).toHaveLength(0);
  });

  it('rejects a table the server will not stream, as it did before', async () => {
    const supabase = await freshClient();
    supabase
      .channel('c')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {})
      .subscribe();
    await settle();
    // The guard lives server-side (SUBSCRIBABLE_TABLES); the client just
    // has to put the table on the wire for it to be checked.
    expect(openStreams()[0].subs.map((s) => s.table)).toContain('messages');
  });
});

/** Descriptors the client actually put on the wire, per request. */
function sentDescriptors(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.map((call) => {
    const body = JSON.parse((call[1] as { body: string }).body);
    return Array.isArray(body) ? body : [body];
  });
}

/**
 * Answers a single descriptor with an object and a batch with an array,
 * mirroring the route. `rows` is keyed by table so positional mapping is
 * verifiable.
 */
function mockDb(rows: Record<string, unknown[]> = {}) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const answer = (q: { table: string }) => ({
      data: rows[q.table] ?? [],
      error: null,
      count: null,
      status: 200,
      statusText: 'OK',
    });
    const payload = Array.isArray(body) ? body.map(answer) : answer(body);
    return { json: async () => payload };
  });
}

describe('/api/db request batching', () => {
  it('sends queries issued in one tick as a single request', async () => {
    const fetchMock = mockDb();
    vi.stubGlobal('fetch', fetchMock);
    const supabase = await freshClient();

    // What an effect pass looks like on the contacts page.
    await Promise.all([
      supabase.from('tags').select('*'),
      supabase.from('custom_fields').select('*'),
      supabase.from('contact_lists').select('*'),
      supabase.from('contacts').select('*'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentDescriptors(fetchMock)[0]).toHaveLength(4);
  });

  it('maps batched results back to their own callers, in order', async () => {
    const fetchMock = mockDb({
      tags: [{ id: 'tag-1' }],
      custom_fields: [{ id: 'field-1' }],
      contacts: [{ id: 'contact-1' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const supabase = await freshClient();

    const [tags, fields, contacts] = await Promise.all([
      supabase.from('tags').select('*'),
      supabase.from('custom_fields').select('*'),
      supabase.from('contacts').select('*'),
    ]);

    expect(tags.data).toEqual([{ id: 'tag-1' }]);
    expect(fields.data).toEqual([{ id: 'field-1' }]);
    expect(contacts.data).toEqual([{ id: 'contact-1' }]);
  });

  it('keeps the original single-descriptor body for a lone query', async () => {
    const fetchMock = mockDb();
    vi.stubGlobal('fetch', fetchMock);
    const supabase = await freshClient();

    await supabase.from('tags').select('*');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(Array.isArray(body)).toBe(false);
    expect(body).toMatchObject({ table: 'tags', action: 'select' });
  });

  it('does not batch across an await, so a read after a write is not reordered', async () => {
    const fetchMock = mockDb();
    vi.stubGlobal('fetch', fetchMock);
    const supabase = await freshClient();

    await supabase.from('contacts').update({ name: 'x' }).eq('id', 'c1');
    await supabase.from('contacts').select('*');

    expect(sentDescriptors(fetchMock)).toEqual([
      [expect.objectContaining({ action: 'update' })],
      [expect.objectContaining({ action: 'select' })],
    ]);
  });

  it('splits a batch that exceeds the route cap', async () => {
    const fetchMock = mockDb();
    vi.stubGlobal('fetch', fetchMock);
    const supabase = await freshClient();

    await Promise.all(
      Array.from({ length: 30 }, (_, i) => supabase.from(`t${i}`).select('*')),
    );

    // 25 is the server's MAX_BATCH; the remainder rides a second request
    // rather than being rejected wholesale.
    expect(sentDescriptors(fetchMock).map((d) => d.length)).toEqual([25, 5]);
  });

  it('fails every caller in a batch that comes back the wrong shape', async () => {
    // A proxy error page, or a server that predates batching — resolving
    // callers with each other's rows would be far worse than an error.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({ data: [{ id: 'wrong' }], error: null }) })),
    );
    const supabase = await freshClient();

    const results = await Promise.all([
      supabase.from('tags').select('*'),
      supabase.from('contacts').select('*'),
    ]);

    for (const result of results) {
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('FETCH_ERROR');
    }
  });

  it('turns a network failure into an error result for every caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const supabase = await freshClient();

    const results = await Promise.all([
      supabase.from('tags').select('*'),
      supabase.from('contacts').select('*'),
    ]);

    for (const result of results) {
      expect(result.error?.message).toBe('offline');
      expect(result.status).toBe(0);
    }
  });
});

describe('/api/db read de-duplication', () => {
  it('collapses concurrent identical selects into one descriptor', async () => {
    const fetchMock = mockDb({ notifications: [{ id: 'n1' }] });
    vi.stubGlobal('fetch', fetchMock);
    const supabase = await freshClient();

    const [a, b] = await Promise.all([
      supabase.from('notifications').select('*'),
      supabase.from('notifications').select('*'),
    ]);

    expect(sentDescriptors(fetchMock)).toEqual([[expect.objectContaining({ table: 'notifications' })]]);
    expect(a.data).toEqual([{ id: 'n1' }]);
    expect(b.data).toEqual([{ id: 'n1' }]);
    // Separate copies, so one caller mutating rows can't corrupt the other.
    expect(a.data).not.toBe(b.data);
  });

  it('keeps different selects as distinct descriptors in the batch', async () => {
    const fetchMock = mockDb();
    vi.stubGlobal('fetch', fetchMock);
    const supabase = await freshClient();

    await Promise.all([
      supabase.from('notifications').select('*'),
      supabase.from('notifications').select('*').is('read_at', null),
      supabase.from('conversations').select('*'),
    ]);

    expect(sentDescriptors(fetchMock)[0]).toHaveLength(3);
  });

  it('never de-duplicates mutations', async () => {
    const fetchMock = mockDb();
    vi.stubGlobal('fetch', fetchMock);
    const supabase = await freshClient();

    await Promise.all([
      supabase.from('notifications').update({ read_at: 'now' }).eq('id', 'n1'),
      supabase.from('notifications').update({ read_at: 'now' }).eq('id', 'n1'),
    ]);

    // Identical on the wire, but both must reach the server.
    expect(sentDescriptors(fetchMock)[0]).toHaveLength(2);
  });

  it('re-requests once the first read has settled, so writes are never masked', async () => {
    const fetchMock = mockDb();
    vi.stubGlobal('fetch', fetchMock);
    const supabase = await freshClient();

    await supabase.from('notifications').select('*');
    await supabase.from('notifications').select('*');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
