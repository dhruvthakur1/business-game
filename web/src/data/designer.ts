const P = (file: string) => `/art/products/${file}.svg`;

export interface SlotOption {
  name: string;
  cost: number;
}

export interface TemplateSlot {
  key: string;
  label: string;
  options: SlotOption[];
}

export interface ProductTemplate {
  id: 'watch' | 'dress' | 'sneaker';
  label: string;
  building: string;
  opCost: number;
  maxValueAdd: number;
  slots: TemplateSlot[];
}

export const TEMPLATES: ProductTemplate[] = [
  {
    id: 'watch', label: 'Watch', building: 'Watchmaker · Lv 30', opCost: 125, maxValueAdd: 1.8,
    slots: [
      { key: 'case', label: 'Case', options: [{ name: 'Steel', cost: 40 }, { name: 'Silver', cost: 150 }, { name: 'Gold', cost: 240 }] },
      { key: 'move', label: 'Movement', options: [{ name: 'Quartz parts', cost: 150 }, { name: 'Automatic parts', cost: 260 }] },
      { key: 'crystal', label: 'Crystal', options: [{ name: 'Mineral', cost: 8 }, { name: 'Sapphire', cost: 25 }] },
      { key: 'strap', label: 'Strap', options: [{ name: 'Leather', cost: 45 }, { name: 'Steel bracelet', cost: 60 }] },
    ],
  },
  {
    id: 'dress', label: 'Dress', building: 'Garment Factory · Lv 8', opCost: 40, maxValueAdd: 1.8,
    slots: [
      { key: 'fabric', label: 'Fabric', options: [{ name: 'Cotton', cost: 30 }, { name: 'Silk', cost: 120 }, { name: 'Synthetic', cost: 20 }] },
      { key: 'trim', label: 'Trim', options: [{ name: 'Buttons', cost: 2 }, { name: 'Lace', cost: 25 }, { name: 'Embroidery', cost: 60 }] },
      { key: 'lining', label: 'Lining', options: [{ name: 'None', cost: 0 }, { name: 'Satin', cost: 18 }] },
    ],
  },
  {
    id: 'sneaker', label: 'Sneaker', building: 'Garment Factory · Lv 8', opCost: 30, maxValueAdd: 1.8,
    slots: [
      { key: 'upper', label: 'Upper', options: [{ name: 'Canvas', cost: 25 }, { name: 'Leather', cost: 60 }] },
      { key: 'sole', label: 'Sole', options: [{ name: 'Rubber', cost: 15 }, { name: 'Foam', cost: 22 }] },
      { key: 'laces', label: 'Laces', options: [{ name: 'Cotton', cost: 2 }, { name: 'Waxed', cost: 5 }] },
    ],
  },
];

export type VariantTier = 'basic' | 'premium' | 'luxury';

export const VARIANT_TIERS: Record<VariantTier, { label: string; inputMult: number; bandMult: number }> = {
  basic: { label: 'Basic', inputMult: 1.0, bandMult: 1.0 },
  premium: { label: 'Premium', inputMult: 1.4, bandMult: 1.7 },
  luxury: { label: 'Luxury', inputMult: 2.2, bandMult: 3.0 },
};

export const LOGOS = [
  { name: 'Crown', d: 'M4 17l2-9 6 5 6-5 2 9z M4 20h16' },
  { name: 'Wheat', d: 'M12 21V8 M12 8c-3 0-4-2-4-5 3 0 4 2 4 5z M12 8c3 0 4-2 4-5-3 0-4 2-4 5z M12 14c-3 0-4-2-4-5 3 0 4 2 4 5z M12 14c3 0 4-2 4-5-3 0-4 2-4 5z' },
  { name: 'Gear', d: 'M12 8a4 4 0 100 8 4 4 0 000-8z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2' },
  { name: 'Star', d: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z' },
];

/** Names already registered on the server (demo). */
export const TAKEN_BRANDS = ['ferro labs', 'harbor bakeries'];

/** Pick the preview drawing for a designed product. */
export function designerArt(template: ProductTemplate['id'], tier: VariantTier, goldCase: boolean): string {
  if (template === 'dress') return P('gala-gown');
  if (template === 'sneaker') return P('sneakers');
  if (tier === 'luxury') return goldCase ? P('watch-founders') : P('watch-tourbillon');
  if (goldCase) return P('watch-gold-dress');
  return tier === 'premium' ? P('watch-automatic') : P('watch-quartz');
}
