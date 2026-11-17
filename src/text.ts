/**
 * Text helpers shared by the scorer, moderation and the responder.
 */

/**
 * Normalise text for matching: lowercase, strip diacritics, and fold the
 * common leetspeak substitutions spammers use to slip past word lists.
 */
export function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[0]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't');
}

/** Lowercase + strip diacritics only (no leetspeak folding). */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a word list into one regex applied to `normaliseForMatch` text.
 * Entries match on word boundaries so `ass` does not flag `password`; wrap an
 * entry in `*` (`*spam*`) to opt into substring matching.
 */
export function compileWordList(words: readonly string[]): RegExp | null {
  const patterns = words
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
    .map((word) => {
      const substring = word.startsWith('*') && word.endsWith('*') && word.length > 2;
      const bare = substring ? word.slice(1, -1) : word;
      const escaped = escapeRegExp(normaliseForMatch(bare));
      return substring ? escaped : `\\b${escaped}\\b`;
    });
  if (patterns.length === 0) return null;
  return new RegExp(patterns.join('|'), 'iu');
}

/** Strip what reads badly through TTS: URLs, emoji, joiners. */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[×]/g, 'x')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABBREVIATIONS = new Set([
  'dl',
  'dna',
  'dra',
  'dr',
  'prof',
  'ing',
  'nr',
  'str',
  'etc',
  'ex',
  'vs',
  'mr',
  'mrs',
  'ms',
  'st',
  'jr',
  'sr',
  'e.g',
  'i.e',
]);

const BOUNDARY = /[.!?…]+["'”’»)\]]*\s+/g;

/**
 * Streaming sentence splitter: text arrives token by token and complete
 * sentences are released as soon as their boundary is certain, so TTS can
 * start on the first sentence while the model is still writing the second.
 * A boundary needs trailing whitespace, which keeps `3.5` and `ai.codai.ro`
 * intact; common abbreviations are not boundaries.
 */
export class SentenceSplitter {
  #buffer = '';

  push(text: string): string[] {
    this.#buffer += text;
    const out: string[] = [];
    let start = 0;
    BOUNDARY.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BOUNDARY.exec(this.#buffer)) !== null) {
      const end = match.index + match[0].length;
      const candidate = this.#buffer.slice(start, end).trim();
      if (isAbbreviation(candidate)) continue;
      if (candidate !== '') out.push(candidate);
      start = end;
    }
    this.#buffer = this.#buffer.slice(start);
    return out;
  }

  flush(): string | null {
    const rest = this.#buffer.trim();
    this.#buffer = '';
    return rest === '' ? null : rest;
  }
}

function isAbbreviation(sentence: string): boolean {
  if (!sentence.endsWith('.')) return false;
  const lastWord = sentence.slice(0, -1).split(/\s+/).pop() ?? '';
  return ABBREVIATIONS.has(lastWord.toLowerCase());
}

export function splitSentences(text: string): string[] {
  const splitter = new SentenceSplitter();
  const out = splitter.push(text);
  const rest = splitter.flush();
  if (rest) out.push(rest);
  return out;
}
