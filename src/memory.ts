import { eventValue, type LiveEvent } from './events.js';

/**
 * Viewer memory: who came back, what they said about themselves, how much
 * they gave. The store is pluggable (SQLite, Postgres, Redis, a KV); the
 * package ships `InMemoryStore` as the default. Every method may be sync or
 * async.
 */

type MaybePromise<T> = T | Promise<T>;

export interface ViewerProfile {
  id: string;
  name: string;
  avatarUrl?: string;
  firstSeen: number;
  lastSeen: number;
  /** Sessions in which the viewer appeared. */
  visits: number;
  messages: number;
  /** Sum of gift value (platform units). */
  totalValue: number;
  follower: boolean;
}

export interface MemoryStore {
  getViewer(id: string): MaybePromise<ViewerProfile | null>;
  putViewer(profile: ViewerProfile): MaybePromise<void>;
  getFacts(id: string): MaybePromise<string[]>;
  /** Store durable facts (newest wins); the store decides its own cap. */
  addFacts(id: string, facts: readonly string[], at: number): MaybePromise<void>;
  /** Optional raw event log (skip for privacy-sensitive deployments). */
  appendEvent?(sessionId: string, event: LiveEvent): MaybePromise<void>;
}

export const MAX_FACTS_PER_VIEWER = 20;

/** Default store: process memory, lost on restart. */
export class InMemoryStore implements MemoryStore {
  #viewers = new Map<string, ViewerProfile>();
  #facts = new Map<string, Array<{ fact: string; at: number }>>();
  #events: Array<{ sessionId: string; event: LiveEvent }> = [];
  #maxFacts: number;
  #maxEvents: number;

  constructor(options: { maxFactsPerViewer?: number; maxEvents?: number } = {}) {
    this.#maxFacts = options.maxFactsPerViewer ?? MAX_FACTS_PER_VIEWER;
    this.#maxEvents = options.maxEvents ?? 0;
  }

  getViewer(id: string): ViewerProfile | null {
    const viewer = this.#viewers.get(id);
    return viewer ? { ...viewer } : null;
  }

  putViewer(profile: ViewerProfile): void {
    this.#viewers.set(profile.id, { ...profile });
  }

  getFacts(id: string): string[] {
    return (this.#facts.get(id) ?? []).map((f) => f.fact);
  }

  addFacts(id: string, facts: readonly string[], at: number): void {
    const list = this.#facts.get(id) ?? [];
    let offset = 0;
    for (const raw of facts) {
      const fact = raw.trim().slice(0, 200);
      if (fact === '') continue;
      const existing = list.findIndex((f) => f.fact === fact);
      if (existing !== -1) list.splice(existing, 1);
      list.unshift({ fact, at: at + offset++ });
    }
    list.sort((a, b) => b.at - a.at);
    this.#facts.set(id, list.slice(0, this.#maxFacts));
  }

  appendEvent(sessionId: string, event: LiveEvent): void {
    if (this.#maxEvents <= 0) return;
    this.#events.push({ sessionId, event });
    if (this.#events.length > this.#maxEvents)
      this.#events.splice(0, this.#events.length - this.#maxEvents);
  }

  events(): ReadonlyArray<{ sessionId: string; event: LiveEvent }> {
    return this.#events;
  }

  get size(): number {
    return this.#viewers.size;
  }
}

export interface Observation {
  /** Profile before this event; `null` for a viewer never seen before. */
  before: ViewerProfile | null;
  /** First event from this viewer in this session. */
  firstThisSession: boolean;
}

export interface ViewerContext {
  visits: number;
  facts: string[];
  totalValue: number;
}

export interface MemoryHooks {
  /** Begin a session; visits count once per viewer per session. */
  startSession(sessionId: string): void;
  endSession(sessionId: string): void;
  /** Record one event and return what was known before it. Replays write nothing. */
  observe(event: LiveEvent, sessionId: string | null): Promise<Observation>;
  /** What the responder should know about a viewer. */
  context(userId: string): Promise<ViewerContext | null>;
  /** Persist facts extracted by the `FactCollector`. */
  remember(userId: string, facts: readonly string[], at?: number): Promise<void>;
}

/**
 * Hooks the agent calls on every event. Store failures fail OPEN: a broken
 * database must never stop the live co-host, so errors go to `onError` and
 * the event is treated as coming from an unknown viewer.
 */
export function createMemoryHooks(
  store: MemoryStore,
  options: { onError?: (error: unknown) => void; now?: () => number } = {},
): MemoryHooks {
  const visited = new Set<string>();
  const now = options.now ?? Date.now;
  const fail = (error: unknown): void => options.onError?.(error);

  return {
    startSession(sessionId) {
      for (const key of [...visited]) if (key.startsWith(`${sessionId}\u0000`)) visited.delete(key);
    },
    endSession(sessionId) {
      for (const key of [...visited]) if (key.startsWith(`${sessionId}\u0000`)) visited.delete(key);
    },
    async observe(event, sessionId) {
      const id = event.user.id;
      if (id === '') return { before: null, firstThisSession: false };
      const key = `${sessionId ?? 'adhoc'}\u0000${id}`;
      const firstThisSession = !visited.has(key);
      if (firstThisSession) visited.add(key);

      let before: ViewerProfile | null = null;
      try {
        before = await store.getViewer(id);
        if (event.replay || sessionId === null) return { before, firstThisSession };
        const next: ViewerProfile = {
          id,
          name: event.user.name || before?.name || id,
          firstSeen: before?.firstSeen ?? event.at,
          lastSeen: event.at,
          visits: (before?.visits ?? 0) + (firstThisSession ? 1 : 0),
          messages: (before?.messages ?? 0) + (event.kind === 'chat' ? 1 : 0),
          totalValue: (before?.totalValue ?? 0) + eventValue(event),
          follower:
            (before?.follower ?? false) ||
            event.kind === 'follow' ||
            event.user.isFollower === true,
          ...((event.user.avatarUrl ?? before?.avatarUrl)
            ? { avatarUrl: event.user.avatarUrl ?? before?.avatarUrl }
            : {}),
        };
        await store.putViewer(next);
        if (event.kind !== 'like') await store.appendEvent?.(sessionId, event);
      } catch (error) {
        fail(error);
      }
      return { before, firstThisSession };
    },
    async context(userId) {
      if (userId === '') return null;
      try {
        const viewer = await store.getViewer(userId);
        if (!viewer) return null;
        return {
          visits: viewer.visits,
          facts: await store.getFacts(userId),
          totalValue: viewer.totalValue,
        };
      } catch (error) {
        fail(error);
        return null;
      }
    },
    async remember(userId, facts, at = now()) {
      try {
        await store.addFacts(userId, facts, at);
      } catch (error) {
        fail(error);
      }
    },
  };
}
