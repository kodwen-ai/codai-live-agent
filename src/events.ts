import { z } from 'zod';

/**
 * Platform-agnostic live event. Adapters (TikTok, Twitch, YouTube, Kick, a
 * custom chat) map their wire events onto this shape; nothing downstream
 * knows which platform produced it.
 */
export const LIVE_EVENT_KINDS = ['chat', 'gift', 'join', 'like', 'follow', 'share'] as const;
export const LiveEventKindSchema = z.enum(LIVE_EVENT_KINDS);
export type LiveEventKind = z.infer<typeof LiveEventKindSchema>;

export const LiveUserSchema = z.object({
  /** Stable platform user id / handle (without `@`). */
  id: z.string(),
  /** Display name. */
  name: z.string(),
  avatarUrl: z.string().optional(),
  isModerator: z.boolean().optional(),
  isSubscriber: z.boolean().optional(),
  isFollower: z.boolean().optional(),
});
export type LiveUser = z.infer<typeof LiveUserSchema>;

export const LiveGiftSchema = z.object({
  name: z.string(),
  /** How many of this gift in the event (combo / streak). */
  count: z.number().int().positive().default(1),
  /** Value of ONE gift in platform units (diamonds, bits, cents...). */
  value: z.number().nonnegative().default(0),
});
export type LiveGift = z.infer<typeof LiveGiftSchema>;

export const LiveEventSchema = z.object({
  id: z.string(),
  kind: LiveEventKindSchema,
  /** Epoch ms. */
  at: z.number(),
  user: LiveUserSchema,
  /** Chat text; empty for non-chat events. */
  text: z.string().default(''),
  gift: LiveGiftSchema.optional(),
  /** Replayed / simulated events never write to memory. */
  replay: z.boolean().optional(),
});
export type LiveEvent = z.infer<typeof LiveEventSchema>;
/** Input shape (defaults not yet applied). */
export type LiveEventInput = z.input<typeof LiveEventSchema>;

/** Validate and normalise an untrusted event. Throws a `ZodError` on bad input. */
export function parseLiveEvent(input: unknown): LiveEvent {
  return LiveEventSchema.parse(input);
}

/** Total value carried by an event (gift value x count; 0 for everything else). */
export function eventValue(event: LiveEvent): number {
  if (event.kind !== 'gift' || !event.gift) return 0;
  return event.gift.value * event.gift.count;
}
