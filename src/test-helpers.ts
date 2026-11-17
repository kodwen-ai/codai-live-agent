import { parseLiveEvent, type LiveEvent, type LiveEventInput } from './events.js';

let seq = 0;

/** Build a valid LiveEvent with sensible defaults (tests only; not exported from the package). */
export function ev(
  partial: Partial<LiveEventInput> & { userId?: string; name?: string } = {},
): LiveEvent {
  seq += 1;
  const { userId, name, ...rest } = partial;
  return parseLiveEvent({
    id: `e${seq}`,
    kind: 'chat',
    at: 1_000_000,
    text: '',
    user: { id: userId ?? 'ana', name: name ?? 'Ana' },
    ...rest,
  });
}

/** A fetch mock that answers chat-completions with an SSE stream of the given deltas. */
export function sseFetch(
  deltas: string[],
  calls: Array<{ url: string; init: RequestInit }> = [],
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    if (!body.stream) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: deltas.join('') } }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    const encoder = new TextEncoder();
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const delta of deltas) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
            ),
          );
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    if (signal?.aborted) throw signal.reason;
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}
