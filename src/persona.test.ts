import { describe, expect, it } from 'vitest';

import { PersonaSchema, disclosureLine } from './persona.js';

describe('persona AI disclosure (EU AI Act art. 50)', () => {
  it('defaults aiLabel to " (AI)"', () => {
    expect(PersonaSchema.parse({}).aiLabel).toBe(' (AI)');
  });

  it('rejects an empty or blank aiLabel', () => {
    expect(PersonaSchema.safeParse({ aiLabel: '' }).success).toBe(false);
    expect(PersonaSchema.safeParse({ aiLabel: '   ' }).success).toBe(false);
  });

  it('keeps a custom label', () => {
    expect(PersonaSchema.parse({ aiLabel: ' 🤖 AI' }).aiLabel).toBe(' 🤖 AI');
  });

  it('builds the English disclosure line', () => {
    expect(disclosureLine(PersonaSchema.parse({ name: 'Nova' }))).toBe('Nova (AI) — AI co-host');
  });

  it('builds the Romanian disclosure line', () => {
    expect(disclosureLine(PersonaSchema.parse({ name: 'Nova', language: 'ro' }))).toBe(
      'Nova (AI) — co-gazdă AI',
    );
  });

  it('never drops the label even for a hand-built persona with a blank one', () => {
    expect(disclosureLine({ name: 'Nova', aiLabel: '', language: 'en' })).toBe(
      'Nova (AI) — AI co-host',
    );
  });
});
