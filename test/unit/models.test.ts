import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_PREFS,
  activeModels,
  applyModelPrefs,
  moveModel,
  orderFlashModels,
  prettyModel,
  setModelEnabled,
} from '../../src/shared/models';

const LISTED = [
  'models/gemini-2.5-flash',
  'models/gemini-2.5-flash-preview-tts',
  'models/gemini-flash-latest',
  'models/gemini-flash-lite-latest',
  'models/gemini-2.5-flash-lite',
  'models/gemini-2.5-flash-image',
  'models/gemini-3-flash-preview',
  'models/gemini-3.1-flash-lite-preview',
  'models/gemini-3.1-flash-lite',
  'models/gemini-3.5-flash',
  'models/gemini-3.5-flash-lite',
  'models/gemini-3.6-flash',
  'models/gemini-3.7-flash',
  'models/gemini-3.8-flash',
  'models/gemini-3.8-flash-tts',
];

const AVAILABLE = orderFlashModels(LISTED);

describe('orderFlashModels', () => {
  it('puts the newest Flash first, then older Flash, then Flash-Lite, then previews; skipping aliases and variants', () => {
    expect(AVAILABLE).toEqual([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
    ]);
  });

  it('compares versions numerically', () => {
    expect(orderFlashModels(['gemini-3.8-flash', 'gemini-3.10-flash', 'gemini-4-flash'])).toEqual([
      'gemini-4-flash',
      'gemini-3.10-flash',
      'gemini-3.8-flash',
    ]);
  });
});

describe('model preferences', () => {
  it('uses the default order, with previews switched off, until the user changes anything', () => {
    const choices = applyModelPrefs(AVAILABLE, DEFAULT_MODEL_PREFS);
    expect(choices.map((c) => c.model)).toEqual(AVAILABLE);
    expect(choices.filter((c) => !c.enabled).map((c) => c.model)).toEqual(['gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview']);
    expect(activeModels(AVAILABLE, undefined)[0]).toBe('gemini-3.8-flash');
  });

  it('switches models on and off relative to their defaults', () => {
    let prefs = setModelEnabled(DEFAULT_MODEL_PREFS, 'gemini-3.8-flash', false);
    prefs = setModelEnabled(prefs, 'gemini-3-flash-preview', true);
    expect(prefs).toEqual({ order: [], off: ['gemini-3.8-flash'], on: ['gemini-3-flash-preview'] });
    expect(activeModels(AVAILABLE, prefs)).not.toContain('gemini-3.8-flash');
    expect(activeModels(AVAILABLE, prefs)).toContain('gemini-3-flash-preview');
    // Switching back to the default leaves no trace.
    prefs = setModelEnabled(setModelEnabled(prefs, 'gemini-3.8-flash', true), 'gemini-3-flash-preview', false);
    expect(prefs).toEqual(DEFAULT_MODEL_PREFS);
  });

  it('moves models up and down', () => {
    let prefs = DEFAULT_MODEL_PREFS;
    for (let i = 0; i < 5; i++) prefs = moveModel(applyModelPrefs(AVAILABLE, prefs), prefs, 'gemini-3.5-flash-lite', -1);
    expect(activeModels(AVAILABLE, prefs).slice(0, 2)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash']);
    // Moving past either end does nothing.
    expect(moveModel(applyModelPrefs(AVAILABLE, prefs), prefs, 'gemini-3.5-flash-lite', -1)).toBe(prefs);
    const last = AVAILABLE[AVAILABLE.length - 1]!;
    expect(moveModel(applyModelPrefs(AVAILABLE, prefs), prefs, last, 1)).toBe(prefs);
  });

  it('keeps a custom order when models come and go, adding new releases after it', () => {
    const prefs = { order: ['gemini-3.5-flash-lite', 'gemini-9-flash-gone', ...AVAILABLE], off: [], on: [] };
    const withNewRelease = orderFlashModels([...LISTED, 'gemini-3.9-flash']);
    const order = applyModelPrefs(withNewRelease, prefs).map((c) => c.model);
    expect(order[0]).toBe('gemini-3.5-flash-lite');
    expect(order).not.toContain('gemini-9-flash-gone');
    expect(order[order.length - 1]).toBe('gemini-3.9-flash');
    // Without a custom order, a new release goes first, as the newest Flash.
    expect(activeModels(withNewRelease, DEFAULT_MODEL_PREFS)[0]).toBe('gemini-3.9-flash');
  });

  it('names models for people', () => {
    expect(prettyModel('gemini-3.8-flash')).toBe('Gemini 3.8 Flash');
    expect(prettyModel('gemini-3.5-flash-lite')).toBe('Gemini 3.5 Flash-Lite');
    expect(prettyModel('gemini-3-flash-preview')).toBe('Gemini 3 Flash (preview)');
    expect(prettyModel('gemini-2.5-flash-preview-09-2025')).toBe('Gemini 2.5 Flash (preview)');
  });
});
