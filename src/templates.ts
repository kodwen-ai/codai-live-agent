import { eventValue, type LiveEvent, type LiveEventKind } from './events.js';
import type { Language } from './persona.js';
import { speakable } from './text.js';

/** Low-cost spoken lines that never touch an LLM. */

function displayName(event: LiveEvent, language: Language): string {
  return (
    speakable(event.user.name.trim() || event.user.id) || (language === 'ro' ? 'Cineva' : 'Someone')
  );
}

export function thanksLine(event: LiveEvent, language: Language = 'en'): string {
  const name = displayName(event, language);
  const count = event.gift?.count ?? 1;
  if (language === 'ro') {
    const gift = speakable(event.gift?.name ?? '') || 'cadou';
    return count > 1
      ? `Mulțumim mult, ${name}, pentru cele ${count} ${gift}!`
      : `Mulțumim mult, ${name}, pentru ${gift}!`;
  }
  const gift = speakable(event.gift?.name ?? '') || 'the gift';
  return count > 1
    ? `Thank you so much, ${name}, for the ${count} ${gift}!`
    : `Thank you so much, ${name}, for ${gift}!`;
}

export function greetingLine(name: string, visits: number, language: Language = 'en'): string {
  if (language === 'ro') {
    const who = speakable(name) || 'prietene';
    return visits >= 5
      ? `Bine ai revenit, ${who}! Ne bucurăm mereu să te vedem.`
      : `Bine ai revenit, ${who}!`;
  }
  const who = speakable(name) || 'friend';
  return visits >= 5 ? `Welcome back, ${who}! Always great to see you.` : `Welcome back, ${who}!`;
}

export interface ReadAloudFilters {
  kinds: Partial<Record<LiveEventKind, boolean>>;
  /** Gifts below this total value are not read. */
  minGiftValue: number;
  readNames: boolean;
}

export function passesReadFilters(event: LiveEvent, filters: ReadAloudFilters): boolean {
  if (!filters.kinds[event.kind]) return false;
  return event.kind !== 'gift' || eventValue(event) >= filters.minGiftValue;
}

export function readAloudLine(
  event: LiveEvent,
  readNames: boolean,
  language: Language = 'en',
): string {
  const ro = language === 'ro';
  const name = readNames ? displayName(event, language) : ro ? 'Cineva' : 'Someone';
  const text = speakable(event.text);
  switch (event.kind) {
    case 'chat':
      if (!readNames) return text;
      return ro ? `${name} zice: ${text}` : `${name} says: ${text}`;
    case 'gift': {
      const count = event.gift?.count ?? 1;
      const gift = speakable(event.gift?.name ?? '') || (ro ? 'un cadou' : 'a gift');
      if (ro) return count > 1 ? `${name} a trimis ${count} ${gift}` : `${name} a trimis ${gift}`;
      return count > 1 ? `${name} sent ${count} ${gift}` : `${name} sent ${gift}`;
    }
    case 'follow':
      return ro ? `${name} te urmărește acum` : `${name} is following now`;
    case 'join':
      return ro ? `${name} a intrat` : `${name} joined`;
    case 'like':
      return ro ? `${name} a dat like` : `${name} liked the stream`;
    case 'share':
      return ro ? `${name} a distribuit liveul` : `${name} shared the stream`;
  }
}
