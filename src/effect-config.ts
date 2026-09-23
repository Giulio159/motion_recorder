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
  },
  {
    id: 2,
    label: 'sminchia-bit',
    sliders: [
      { key: 'bitMode', label: 'Tipo di effetto', min: 0, max: 3, step: 1, defaultValue: 0 },
      { key: 'bleedDecay', label: 'Bleeding orizzontale', min: 0, max: 0.99, step: 0.01, defaultValue: 0.9, decimals: 2 },
      { key: 'pixelation', label: 'Pixelizzazione', min: 1, max: 32, step: 1, defaultValue: 4, suffix: '×' }
    ]
  },
  {
    id: 3,
    label: 'sminchia-bit colori',
    sliders: [
      { key: 'colorMode', label: 'Tipo di effetto', min: 2, max: 8, step: 1, defaultValue: 2 },
      { key: 'bleedDecay', label: 'Bleeding orizzontale', min: 0, max: 0.99, step: 0.01, defaultValue: 0.9, decimals: 2 },
      { key: 'pixelation', label: 'Pixelizzazione', min: 1, max: 32, step: 1, defaultValue: 4, suffix: '×' }
    ]
  }
] as const satisfies readonly EffectDefinition[];

export type EffectId = (typeof EFFECT_DEFINITIONS)[number]['id'];
