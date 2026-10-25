/**
 * Product designer and brands (report section 4). A design is a branded variant of a building's normal
 * output: the same recipe with more (and better) inputs, sold under the brand's name at its own price.
 */
import { BUILDING_TYPE_DEFS, PRODUCT_DEFS } from './catalog';
import { valueCheck } from './economy';

export interface SlotOption {
  name: string;
  /** Extra material cost per unit (CR) on top of the recipe's normal inputs. */
  surcharge: number;
}

export interface TemplateSlot {
  key: string;
  label: string;
  options: SlotOption[];
}

export type TemplateId = 'loaf' | 'car' | 'watch';

export interface ProductTemplate {
  id: TemplateId;
  label: string;
  /** Building that makes it; its recipe is the variant's base recipe. */
  buildingTypeId: string;
  /** The product the variant replaces in that recipe's output. */
  baseProductId: string;
  slots: TemplateSlot[];
}

export const TEMPLATES: ProductTemplate[] = [
  {
    id: 'loaf', label: 'Bread', buildingTypeId: 'bakery', baseProductId: 'bread',
    slots: [
      { key: 'grain', label: 'Grain', options: [{ name: 'Standard', surcharge: 0 }, { name: 'Stone-ground', surcharge: 4 }, { name: 'Heritage rye', surcharge: 9 }] },
      { key: 'finish', label: 'Finish', options: [{ name: 'Plain', surcharge: 0 }, { name: 'Seeded', surcharge: 2 }, { name: 'Glazed', surcharge: 3 }] },
    ],
  },
  {
    id: 'car', label: 'Car', buildingTypeId: 'car_factory', baseProductId: 'economy_car',
    slots: [
      { key: 'trim', label: 'Interior', options: [{ name: 'Cloth', surcharge: 0 }, { name: 'Leather', surcharge: 180 }, { name: 'Carbon', surcharge: 420 }] },
      { key: 'paint', label: 'Paint', options: [{ name: 'Solid', surcharge: 0 }, { name: 'Metallic', surcharge: 60 }, { name: 'Pearl', surcharge: 140 }] },
      { key: 'wheels', label: 'Wheels', options: [{ name: 'Steel', surcharge: 0 }, { name: 'Alloy', surcharge: 90 }] },
    ],
  },
  {
    id: 'watch', label: 'Watch', buildingTypeId: 'watchmaker', baseProductId: 'luxury_watch',
    slots: [
      { key: 'case', label: 'Case', options: [{ name: 'Steel', surcharge: 0 }, { name: 'Silver', surcharge: 110 }, { name: 'Gold', surcharge: 200 }] },
      { key: 'move', label: 'Movement', options: [{ name: 'Quartz', surcharge: 0 }, { name: 'Automatic', surcharge: 110 }] },
      { key: 'crystal', label: 'Crystal', options: [{ name: 'Sapphire', surcharge: 0 }, { name: 'Domed sapphire', surcharge: 15 }] },
      { key: 'strap', label: 'Strap', options: [{ name: 'Leather', surcharge: 0 }, { name: 'Steel bracelet', surcharge: 15 }, { name: 'Alligator', surcharge: 60 }] },
    ],
  },
];

export type VariantTier = 'basic' | 'premium' | 'luxury';

/** inputMult scales every input (and material) the recipe uses; bandMult scales the highest price allowed. */
export const VARIANT_TIERS: Record<VariantTier, { label: string; inputMult: number; bandMult: number; minReputation: number }> = {
  basic: { label: 'Basic', inputMult: 1.0, bandMult: 1.0, minReputation: 0 },
  premium: { label: 'Premium', inputMult: 1.4, bandMult: 1.7, minReputation: 0 },
  luxury: { label: 'Luxury', inputMult: 2.2, bandMult: 3.0, minReputation: 40 },
};

export const MAX_VALUE_ADD = 1.8;

export const BRAND_RULES = {
  minLength: 3,
  maxLength: 24,
  /** Registration fee in CR (a sink). */
  fee: 5_000,
  maxPerCompany: 3,
  maxDesignsPerBrand: 6,
  logoCount: 4,
  startingReputation: 10,
} as const;

const BLOCKED = ['fuck', 'shit', 'cunt', 'bitch', 'nigg', 'fag', 'rape', 'nazi', 'whore', 'slut', 'dick', 'cock', 'pussy', 'porn'];

/** Normalized form used for uniqueness: lower case, single spaces. */
export const brandKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Null when the name is acceptable, otherwise the reason. Uniqueness is checked by the server. */
export function brandNameProblem(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < BRAND_RULES.minLength) return `At least ${BRAND_RULES.minLength} characters.`;
  if (name.length > BRAND_RULES.maxLength) return `At most ${BRAND_RULES.maxLength} characters.`;
  if (!/^[A-Za-z0-9][A-Za-z0-9 &'.-]*$/.test(name)) return 'Letters, numbers, spaces and & \' . - only.';
  const squashed = name.toLowerCase().replace(/[^a-z]/g, '').replace(/0/g, 'o');
  if (BLOCKED.some((w) => squashed.includes(w))) return 'That name is not allowed.';
  return null;
}

export interface DesignChoice {
  templateId: TemplateId;
  /** Option index per slot key; missing slots take option 0. */
  slots: Record<string, number>;
  tier: VariantTier;
}

const productRef = (id: string) => PRODUCT_DEFS.find((p) => p.id === id)!.refPrice;

export function templateById(id: string): ProductTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function pickedOptions(t: ProductTemplate, slots: Record<string, number>): SlotOption[] {
  return t.slots.map((s) => s.options[slots[s.key] ?? 0] ?? s.options[0]);
}

/**
 * Per-unit economics of a design, in CR: the recipe's inputs at reference price, the material
 * surcharges, both scaled by the tier, plus the building's op cost spread over its output.
 */
export function designEconomics(c: DesignChoice) {
  const t = templateById(c.templateId);
  if (!t) throw new Error(`Unknown template ${c.templateId}`);
  const b = BUILDING_TYPE_DEFS.find((x) => x.id === t.buildingTypeId)!;
  const outQty = b.outputs[0].qty;
  const tier = VARIANT_TIERS[c.tier];
  const recipeInputs = b.inputs.reduce((s, l) => s + l.qty * productRef(l.productId), 0) / outQty;
  const materials = pickedOptions(t, c.slots).reduce((s, o) => s + o.surcharge, 0);
  const inputs = (recipeInputs + materials) * tier.inputMult;
  const op = b.opCost / outQty;
  const valueCap = valueCheck(inputs, op, 0, MAX_VALUE_ADD).max;
  const bandCap = productRef(t.baseProductId) * tier.bandMult;
  const maxPrice = Math.floor(Math.min(valueCap, bandCap));
  return { template: t, building: b, outQty, recipeInputs, materials, inputs, op, valueCap, bandCap, maxPrice, suggested: Math.floor(Math.min(maxPrice, inputs * 1.45 + op)) };
}

/** Units of each recipe input a variant consumes per cycle at building level `level`. */
export function variantInputQty(baseQty: number, level: number, tier: VariantTier): number {
  return Math.ceil(baseQty * level * VARIANT_TIERS[tier].inputMult);
}

/** Cash materials charge per cycle, in CR. */
export function variantMaterialsCost(materialsPerUnit: number, outQty: number, level: number, tier: VariantTier): number {
  return materialsPerUnit * VARIANT_TIERS[tier].inputMult * outQty * level;
}

/** Reputation adds up to +20% to what NPC buyers pay for the brand's goods. */
export const reputationPriceMultiplier = (rep: number) => 1 + 0.2 * Math.max(0, Math.min(100, rep)) / 100;

/**
 * Daily reputation update: 1% decay, then growth from the day's sales (units sold, the number of distinct
 * buyers and their average quality) and on-time contract deliveries of the brand's goods.
 */
export function nextReputation(rep: number, day: { units: number; buyers: number; avgQuality: number; onTimeDeliveries: number }): number {
  const sales = day.units > 0 ? Math.min(3, Math.sqrt(day.units) / 4 + 0.25 * day.buyers) * (0.7 + 0.06 * day.avgQuality) : 0;
  const contracts = Math.min(2, 0.5 * day.onTimeDeliveries);
  return Math.round(Math.max(0, Math.min(100, rep * 0.99 + sales + contracts)) * 100) / 100;
}

const P = (file: string) => `/art/products/${file}.svg`;

/** Drawing for a design: depends on template, tier and a few slot picks. */
export function designArt(c: DesignChoice): string {
  if (c.templateId === 'loaf') return P('bread');
  if (c.templateId === 'car') return c.tier === 'luxury' ? P('car-sports') : c.tier === 'premium' ? P('car-sedan') : P('car-economy');
  const gold = (c.slots.case ?? 0) === 2;
  if (c.tier === 'luxury') return gold ? P('watch-founders') : P('watch-tourbillon');
  if (gold) return P('watch-gold-dress');
  return c.tier === 'premium' ? P('watch-automatic') : P('watch-quartz');
}

export function designName(brand: string, c: DesignChoice): string {
  const t = templateById(c.templateId)!;
  return `${brand} ${VARIANT_TIERS[c.tier].label} ${t.label}`;
}
