import { z } from 'zod';

import { err, ok, type Result } from './result.js';
import { SentenceSplitter } from './text.js';

/**
 * Minimal OpenAI-compatible chat-completions client for the codai gateway.
 * The API key is supplied by the caller (string or async getter) — never read
 * from the environment — and never included in errors or logs.
 */

export const DEFAULT_BASE_URL = 'https://ai.codai.ro/v1';

export const LlmConfigSchema = z.object({
  /** OpenAI-compatible base URL including `/v1`. */
  baseUrl: z.url().default(DEFAULT_BASE_URL),
  /** Model alias, e.g. `codai-fast`. */
  model: z.string().min(1),
  /** Sent as `x-codai-client` for attribution. */
  clientName: z.string().min(1).default('codai-live-agent'),
  timeoutMs: z.number().int().positive().default(12_000),
});
export type LlmConfigInput = z.input<typeof LlmConfigSchema>;

export type ApiKeySource = string | (() => string | null | Promise<string | null>);

export interface LlmClientOptions extends LlmConfigInput {
  apiKey: ApiKeySource;
  fetch?: typeof fetch;
}

export type LlmErrorKind =
  | 'no_key'
  | 'unauthorized'
  | 'rate_limited'
  | 'bad_request'
  | 'unavailable'
  | 'server'
  | 'timeout'
  | 'network'
  | 'invalid_response'
  | 'aborted';

export interface LlmError {
  kind: LlmErrorKind;
  status?: number;
  message: string;
  retryAfterMs?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteRequest {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StreamRequest extends CompleteRequest {
  onDelta?: (text: string) => void;
  onSentence?: (sentence: string, index: number) => void;
}

export interface StreamResult {
  text: string;
  sentences: string[];
  /** ms from request start to the first complete sentence; null if none. */
  firstSentenceMs: number | null;
  totalMs: number;
}

/** The surface the agent needs; implement it to plug in any other backend. */
export interface LlmClient {
  complete(request: CompleteRequest): Promise<Result<string, LlmError>>;
  stream(request: StreamRequest): Promise<Result<StreamResult, LlmError>>;
}

export class CodaiLlmClient implements LlmClient {
  readonly #config: z.output<typeof LlmConfigSchema>;
  readonly #apiKey: ApiKeySource;
  readonly #fetch: typeof fetch;

  constructor(options: LlmClientOptions) {
    const { apiKey, fetch: fetchImpl, ...config } = options;
    this.#config = LlmConfigSchema.parse(config);
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get model(): string {
    return this.#config.model;
  }

  async complete(request: CompleteRequest): Promise<Result<string, LlmError>> {
    const signal = this.#signal(request);
    const response = await this.#post(
      {
        model: request.model ?? this.#config.model,
        messages: request.messages,
        stream: false,
        max_tokens: request.maxTokens ?? 300,
        temperature: request.temperature ?? 0.2,
      },
      signal,
    );
    if (!response.ok) return response;
    let body: { choices?: Array<{ message?: { content?: unknown } }> } | null;
    try {
      body = (await response.value.json()) as typeof body;
    } catch {
      return err(invalid('completion is not JSON'));
    }
    const content = body?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? ok(content) : err(invalid('completion has no content'));
  }

  async stream(request: StreamRequest): Promise<Result<StreamResult, LlmError>> {
    const started = performance.now();
    const signal = this.#signal(request);
    const response = await this.#post(
      {
        model: request.model ?? this.#config.model,
        messages: request.messages,
        stream: true,
        max_tokens: request.maxTokens ?? 160,
        temperature: request.temperature ?? 0.7,
      },
      signal,
    );
    if (!response.ok) return response;
    const body = response.value.body;
    if (!body) return err(invalid('empty stream'));

    const parser = new SseParser();
    const splitter = new SentenceSplitter();
    const decoder = new TextDecoder();
    const sentences: string[] = [];
    let text = '';
    let firstSentenceMs: number | null = null;

    const emit = (sentence: string): void => {
      if (firstSentenceMs === null) firstSentenceMs = Math.round(performance.now() - started);
      sentences.push(sentence);
      request.onSentence?.(sentence, sentences.length - 1);
    };
    const handle = (payloads: string[]): void => {
      for (const payload of payloads) {
        const delta = chatDelta(payload);
        if (delta === null) continue;
        text += delta;
        request.onDelta?.(delta);
        for (const sentence of splitter.push(delta)) emit(sentence);
      }
    };

    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        handle(parser.push(decoder.decode(value, { stream: true })));
      }
      handle(parser.push(decoder.decode()));
      handle(parser.end());
    } catch (error) {
      return err(fromThrown(error, signal));
    } finally {
      reader.releaseLock();
    }
    const rest = splitter.flush();
    if (rest) emit(rest);
    return ok({
      text: text.trim(),
      sentences,
      firstSentenceMs,
      totalMs: Math.round(performance.now() - started),
    });
  }

  #signal(request: CompleteRequest): AbortSignal {
    const timeout = AbortSignal.timeout(request.timeoutMs ?? this.#config.timeoutMs);
    return request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  }

  async #key(): Promise<string | null> {
    try {
      return typeof this.#apiKey === 'string' ? this.#apiKey : await this.#apiKey();
    } catch {
      return null;
    }
  }

  async #post(body: unknown, signal: AbortSignal): Promise<Result<Response, LlmError>> {
    const key = await this.#key();
    if (!key) return err({ kind: 'no_key', message: 'codai API key is not configured' });
    let response: Response;
    try {
      response = await this.#fetch(`${this.#config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'x-codai-client': this.#config.clientName,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      return err(fromThrown(error, signal));
    }
    if (response.ok) return ok(response);
    return err(await httpError(response));
  }
}

/** Map a non-2xx response to a typed error, reading the codai error envelope. */
export async function httpError(response: Response): Promise<LlmError> {
  const status = response.status;
  const retryAfter = Number(response.headers.get('retry-after'));
  const retryAfterMs =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  let message = `HTTP ${status}`;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } | string };
    const detail = typeof body.error === 'string' ? body.error : body.error?.message;
    if (typeof detail === 'string' && detail !== '') message = detail.slice(0, 300);
  } catch {
    // Non-JSON body; the status line is enough.
  }
  const kind: LlmErrorKind =
    status === 401 || status === 403
      ? 'unauthorized'
      : status === 429
        ? 'rate_limited'
        : status === 503
          ? 'unavailable'
          : status >= 500
            ? 'server'
            : 'bad_request';
  return { kind, status, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

function fromThrown(error: unknown, signal: AbortSignal): LlmError {
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    const timedOut = reason instanceof DOMException && reason.name === 'TimeoutError';
    return {
      kind: timedOut ? 'timeout' : 'aborted',
      message: timedOut ? 'request timed out' : 'request aborted',
    };
  }
  return { kind: 'network', message: error instanceof Error ? error.message : 'network error' };
}

function invalid(message: string): LlmError {
  return { kind: 'invalid_response', message };
}

/** Incremental SSE parser yielding complete `data:` payloads. */
export class SseParser {
  #buffer = '';
  #data: string[] = [];

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const out: string[] = [];
    let index: number;
    while ((index = this.#buffer.search(/\r\n|\r|\n/)) !== -1) {
      // A lone trailing CR may be the first half of a CRLF split across chunks.
      if (index === this.#buffer.length - 1 && this.#buffer.endsWith('\r')) break;
      const line = this.#buffer.slice(0, index);
      const newline = this.#buffer.startsWith('\r\n', index) ? 2 : 1;
      this.#buffer = this.#buffer.slice(index + newline);
      this.#line(line, out);
    }
    return out;
  }

  end(): string[] {
    const out: string[] = [];
    if (this.#buffer !== '') this.#line(this.#buffer.replace(/\r$/, ''), out);
    this.#buffer = '';
    this.#line('', out);
    return out;
  }

  #line(line: string, out: string[]): void {
    if (line === '') {
      if (this.#data.length > 0) out.push(this.#data.join('\n'));
      this.#data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.#data.push(value);
  }
}

/** Text delta of one chat-completions chunk; `null` for non-content frames. */
export function chatDelta(payload: string): string | null {
  if (payload === '[DONE]') return null;
  try {
    const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.delta?.content;
    return typeof content === 'string' && content !== '' ? content : null;
  } catch {
    return null;
  }
}
