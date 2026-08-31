import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  executeDescriptor: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock('@/lib/db/sql-compiler', () => ({ executeDescriptor: h.executeDescriptor }));
vi.mock('@/lib/db/auth-server', () => ({ getSessionUser: h.getSessionUser }));
vi.mock('@wacrm/shared/db/jwt', () => ({ SESSION_COOKIE: 'wacrm-session' }));

import { POST } from './route';

/** Minimal stand-in for the NextRequest the route reads. */
function makeRequest(body: unknown, { raw }: { raw?: string } = {}) {
  return {
    json: async () => {
      if (raw !== undefined) return JSON.parse(raw);
      return body;
    },
    cookies: { get: () => ({ value: 'token' }) },
  } as unknown as Parameters<typeof POST>[0];
}

function ok(data: unknown) {
  return { data, error: null, count: null, status: 200, statusText: 'OK' };
}

const select = (table: string) => ({ table, action: 'select', filters: [] });

beforeEach(() => {
  h.getSessionUser.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.c' } });
  h.executeDescriptor.mockImplementation(async (_ctx, q) => ok([{ table: q.table }]));
});

describe('POST /api/db', () => {
  it('answers a single descriptor with an object, as it always did', async () => {
    const res = await POST(makeRequest(select('tags')));
    const body = await res.json();

    expect(Array.isArray(body)).toBe(false);
    expect(body).toMatchObject({ data: [{ table: 'tags' }], error: null });
  });

  it('answers a batch with results in the order they were sent', async () => {
    const res = await POST(makeRequest([select('tags'), select('contacts'), select('deals')]));
    const body = await res.json();

    expect(body.map((r: { data: { table: string }[] }) => r.data[0].table)).toEqual([
      'tags',
      'contacts',
      'deals',
    ]);
  });

  it('resolves the session once for the whole batch', async () => {
    await POST(makeRequest([select('tags'), select('contacts'), select('deals')]));

    // The per-request `auth.users` lookup was the reason four effects
    // cost four session queries; a batch pays for one.
    expect(h.getSessionUser).toHaveBeenCalledTimes(1);
    expect(h.executeDescriptor).toHaveBeenCalledTimes(3);
  });

  it('runs every descriptor under the caller`s RLS context', async () => {
    await POST(makeRequest([select('tags'), select('contacts')]));

    for (const [ctx] of h.executeDescriptor.mock.calls) {
      expect(ctx).toEqual({
        role: 'authenticated',
        claims: { sub: 'user-1', role: 'authenticated', email: 'a@b.c' },
      });
    }
  });

  it('runs an anonymous caller as `anon`, which RLS restricts to nothing', async () => {
    h.getSessionUser.mockResolvedValue(null);
    await POST(makeRequest([select('tags')]));

    expect(h.executeDescriptor.mock.calls[0][0]).toEqual({ role: 'anon' });
  });

  it('lets one failing descriptor fail alone', async () => {
    h.executeDescriptor.mockImplementation(async (_ctx, q) =>
      q.table === 'contacts'
        ? {
            data: null,
            error: Object.assign(new Error('permission denied'), {
              code: '42501',
              details: '',
              hint: '',
            }),
            count: null,
            status: 400,
            statusText: 'Bad Request',
          }
        : ok([{ table: q.table }]),
    );

    const res = await POST(makeRequest([select('tags'), select('contacts'), select('deals')]));
    const body = await res.json();

    expect(body[0].data).toEqual([{ table: 'tags' }]);
    expect(body[1].error).toEqual({
      message: 'permission denied',
      code: '42501',
      details: '',
      hint: '',
    });
    // The neighbour after the failure still ran and still returned rows —
    // a batch is N transactions, not one.
    expect(body[2].data).toEqual([{ table: 'deals' }]);
  });

  it('serializes errors into plain objects the client can read', async () => {
    h.executeDescriptor.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('boom'), { code: '500', details: 'd', hint: 'h' }),
      count: null,
      status: 400,
      statusText: 'Bad Request',
    });

    const body = await (await POST(makeRequest(select('tags')))).json();
    // JSON.stringify of an Error instance would have yielded `{}`.
    expect(body.error).toEqual({ message: 'boom', code: '500', details: 'd', hint: 'h' });
  });

  it('rejects a batch larger than the cap without touching the database', async () => {
    const res = await POST(
      makeRequest(Array.from({ length: 26 }, (_, i) => select(`t${i}`))),
    );

    expect(res.status).toBe(400);
    expect(h.executeDescriptor).not.toHaveBeenCalled();
  });

  it('rejects an empty batch', async () => {
    const res = await POST(makeRequest([]));

    expect(res.status).toBe(400);
    expect(h.executeDescriptor).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON', async () => {
    const res = await POST(makeRequest(undefined, { raw: 'not json' }));

    expect(res.status).toBe(400);
    expect(h.executeDescriptor).not.toHaveBeenCalled();
  });
});
