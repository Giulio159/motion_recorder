import type { EffectDefinition } from './types';

export const EFFECT_DEFINITIONS = [
  {
    id: 0,
    label: 'Il Precursore',
    sliders: [
      { key: 'sensitivity', label: 'Sensibilità', min: 1, max: 30, step: 1, defaultValue: 8 },
      { key: 'trail', label: 'Scia', min: 0, max: 0.95, step: 0.01, defaultValue: 0.8, displayMultiplier: 100, decimals: 0, suffix: '%' }
    ]
  },
  {
    id: 1,
    label: 'LSD Silver Surfer',
    sliders: [
      { key: 'intensity', label: 'Intensità', min: 1, max: 30, step: 1, defaultValue: 17 }
    ]
  }
] as const satisfies readonly EffectDefinition[];

export type EffectId = (typeof EFFECT_DEFINITIONS)[number]['id'];
