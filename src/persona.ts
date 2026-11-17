import { z } from 'zod';

export const LanguageSchema = z.enum(['ro', 'en']);
export type Language = z.infer<typeof LanguageSchema>;

export const PersonaSchema = z.object({
  /** Name the co-host answers to. */
  name: z.string().min(1).default('codai'),
  /**
   * AI label callers append to the display name wherever the co-host is shown
   * (EU AI Act art. 50 disclosure). Never empty.
   */
  aiLabel: z
    .string()
    .refine((s) => s.trim() !== '', { message: 'aiLabel must not be empty' })
    .default(' (AI)'),
  personality: z.string().default('friendly, concise'),
  /** Free text about the streamer / channel, added to the system prompt. */
  aboutStreamer: z.string().default(''),
  /** Platform name used in the prompt ("TikTok", "Twitch"...); generic when empty. */
  platform: z.string().default(''),
  /** Fallback language for replies and template lines. */
  language: LanguageSchema.default('en'),
  /** Persona contract: at most this many short spoken sentences. */
  maxSentences: z.number().int().min(1).max(5).default(2),
});
export type Persona = z.infer<typeof PersonaSchema>;
export type PersonaInput = z.input<typeof PersonaSchema>;

/** One-line AI disclosure for overlays and chat, e.g. `codai (AI) — AI co-host`. */
export function disclosureLine(persona: Pick<Persona, 'name' | 'aiLabel' | 'language'>): string {
  const label = persona.aiLabel.trim() === '' ? ' (AI)' : persona.aiLabel;
  const role = persona.language === 'ro' ? 'co-gazdă AI' : 'AI co-host';
  return `${persona.name}${label} — ${role}`;
}
