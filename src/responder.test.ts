import { describe, expect, it } from 'vitest';

import { CodaiLlmClient, SseParser, chatDelta } from './llm.js';
import { PersonaSchema } from './persona.js';
import { draftReply, systemPrompt, userPrompt } from './responder.js';
import { sseFetch } from './test-helpers.js';

const KEY = 'test-key';
const persona = PersonaSchema.parse({ name: 'Codai', platform: 'Twitch' });
const context = {
  userName: 'Ana',
  userId: 'ana',
  message: 'what game is this?',
  reasons: ['question'],
};

describe('CodaiLlmClient', () => {
  it('posts an OpenAI-compatible streaming request with the caller key and model alias', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const llm = new CodaiLlmClient({
      model: 'codai-fast',
      apiKey: KEY,
      fetch: sseFetch(['Hi ', 'there. ', 'Bye.'], calls),
    });
    const sentences: string[] = [];
    const result = await llm.stream({
      messages: [{ role: 'user', content: 'x' }],
      onSentence: (s) => sentences.push(s),
    });
    expect(result.ok && result.value.text).toBe('Hi there. Bye.');
    expect(sentences).toEqual(['Hi there.', 'Bye.']);
    expect(calls[0]?.url).toBe('https://ai.codai.ro/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: 'codai-fast',
      stream: true,
    });
  });

  it('accepts an async key getter and reports no_key without calling fetch', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const llm = new CodaiLlmClient({
      model: 'm',
      apiKey: async () => null,
      fetch: sseFetch([], calls),
    });
    const result = await llm.complete({ messages: [] });
    expect(result).toMatchObject({ ok: false, error: { kind: 'no_key' } });
    expect(calls).toHaveLength(0);
  });

  it('maps HTTP errors to typed kinds and never echoes the key', async () => {
    const fetch401 = (async () =>
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
        status: 401,
      })) as unknown as typeof fetch;
    const llm = new CodaiLlmClient({ model: 'm', apiKey: KEY, fetch: fetch401 });
    const result = await llm.complete({ messages: [] });
    expect(result).toMatchObject({ ok: false, error: { kind: 'unauthorized', status: 401 } });
    expect(JSON.stringify(result)).not.toContain(KEY);

    const fetch429 = (async () =>
      new Response('busy', {
        status: 429,
        headers: { 'retry-after': '2' },
      })) as unknown as typeof fetch;
    const limited = await new CodaiLlmClient({ model: 'm', apiKey: KEY, fetch: fetch429 }).complete(
      { messages: [] },
    );
    expect(limited).toMatchObject({
      ok: false,
      error: { kind: 'rate_limited', retryAfterMs: 2000 },
    });
  });

  it('rejects a non-URL base URL at construction', () => {
    expect(() => new CodaiLlmClient({ model: 'm', apiKey: KEY, baseUrl: 'not a url' })).toThrow();
  });
});

describe('SseParser', () => {
  it('handles frames split across chunks, comments and CRLF', () => {
    const p = new SseParser();
    expect(p.push(': keep-alive\r\ndata: {"a"')).toEqual([]);
    expect(p.push(':1}\r\n\r\ndata: [DONE]\n\n')).toEqual(['{"a":1}', '[DONE]']);
    expect(chatDelta('[DONE]')).toBeNull();
    expect(chatDelta('{"choices":[{"delta":{"content":"x"}}]}')).toBe('x');
  });
});

describe('draftReply (streaming responder)', () => {
  it('tells the model it is an AI that never claims or implies to be human', () => {
    const prompt = systemPrompt(persona);
    expect(prompt).toContain('You are an AI. Never claim or imply to be human');
    expect(prompt).toContain("say you are the streamer's AI co-host whenever asked");
  });

  it('streams speakable sentences and cuts at the persona sentence limit', async () => {
    const llm = new CodaiLlmClient({
      model: 'codai-fast',
      apiKey: KEY,
      fetch: sseFetch(['It is ', 'Minecraft 😀. ', 'Have fun! ', 'Third sentence.']),
    });
    const heard: string[] = [];
    const result = await draftReply(llm, { persona, context, onSentence: (s) => heard.push(s) });
    expect(heard).toEqual(['It is Minecraft .', 'Have fun!']);
    expect(result).toEqual({ ok: true, value: 'It is Minecraft . Have fun!' });
  });

  it('blocks the whole draft when output moderation rejects a sentence', async () => {
    const llm = new CodaiLlmClient({
      model: 'm',
      apiKey: KEY,
      fetch: sseFetch(['Fine. ', 'Bad word here.']),
    });
    const heard: string[] = [];
    const result = await draftReply(llm, {
      persona,
      context,
      moderate: (s) => !s.includes('Bad'),
      onSentence: (s) => heard.push(s),
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'blocked' } });
    expect(heard).toEqual(['Fine.']);
  });

  it('returns empty when the model says nothing speakable', async () => {
    const llm = new CodaiLlmClient({ model: 'm', apiKey: KEY, fetch: sseFetch(['😀😀']) });
    expect(await draftReply(llm, { persona, context })).toMatchObject({
      ok: false,
      error: { kind: 'empty' },
    });
  });

  it('keeps the system prompt stable and puts viewer context in the user prompt', () => {
    expect(systemPrompt(persona)).toBe(systemPrompt(persona));
    expect(systemPrompt(persona)).toContain('Twitch');
    const user = userPrompt({
      ...context,
      visits: 3,
      facts: ['lives in Cluj'],
      transcript: 'we are building a base',
    });
    expect(user).toContain('Previous visits: 2');
    expect(user).toContain('lives in Cluj');
    expect(user).toContain('we are building a base');
  });
});
