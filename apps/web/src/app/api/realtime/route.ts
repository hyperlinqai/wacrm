import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/db/auth-server';
import { ANON_CONTEXT, userContext } from '@/lib/db/exec';
import { SESSION_COOKIE } from '@/lib/db/jwt';
import { getRealtimeHub, type Binding, type OutgoingEvent } from '@/lib/db/realtime-server';

// SSE stream carrying live postgres_changes events, RLS-filtered per
// subscriber. EventSource on the client reconnects automatically.

export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

export async function GET(request: NextRequest) {
  let bindings: Binding[];
  try {
    bindings = JSON.parse(request.nextUrl.searchParams.get('subs') ?? '[]') as Binding[];
    if (!Array.isArray(bindings) || bindings.length === 0 || bindings.length > 20) {
      throw new Error('bad subs');
    }
  } catch {
    return new Response('invalid subscription list', { status: 400 });
  }

  const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
  const ctx = session ? userContext(session.user.id, session.user.email) : ANON_CONTEXT;

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: OutgoingEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* stream already closed */
        }
      };
      try {
        unsubscribe = await getRealtimeHub().subscribe(bindings, ctx, send);
      } catch (err) {
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify((err as Error).message)}\n\n`),
        );
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(': connected\n\n'));
      // Keep intermediaries from idling the connection out.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          /* closed */
        }
      }, 25_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  request.signal.addEventListener('abort', () => {
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
