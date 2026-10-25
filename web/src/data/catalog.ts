import { BUILDING_TYPE_DEFS, PRODUCT_DEFS } from '../../../shared/catalog';
import type { BuildingType, Product } from './types';
import type { ServerDesign } from '../api/types';

const P = (file: string) => `/art/products/${file}.svg`;
const B = (file: string) => `/art/buildings/${file}.svg`;

const PRODUCT_ART: Record<string, string> = {
  iron_ore: P('iron-ore'), coal: P('coal'), wheat: P('wheat'), cotton: P('cotton'), flour: P('flour'),
  fabric: P('fabric'), steel: P('steel'), mwh: P('electricity'), gold_bar: P('gold-bar'), chip: P('chip'),
  engine: P('engine'), bread: P('bread'), smartphone: P('smartphone'), laptop: P('laptop'),
  economy_car: P('car-economy'), suv: P('car-suv'), sports_car: P('car-sports'), luxury_watch: P('watch-automatic'),
  research_points: P('research-points'),
  sand: P('sand'), limestone: P('limestone'), cement: P('cement'), garments: P('streetwear-tee'),
};

const BUILDING_ART: Record<string, string> = {
  farm: B('farm'), mill: B('mill'), bakery: B('bakery'), supermarket: B('supermarket'), iron_mine: B('mine'),
  power_plant: B('power-plant'), solar: B('solar-farm'), steel_mill: B('steel-mill'), chip_fab: B('chip-fab'),
  car_factory: B('car-factory'), watchmaker: B('watchmaker'), luxury_store: B('luxury-store'), rnd_lab: B('rnd-lab'),
  cotton_farm: B('cotton-farm'), coal_mine: B('coal-mine'), quarry: B('quarry'), sand_pit: B('sand-pit'),
  textile_mill: B('textile-mill'), garment_factory: B('garment-factory'), cement_plant: B('cement-plant'),
};

export const PRODUCTS: Product[] = PRODUCT_DEFS.map((p) => ({ ...p, art: PRODUCT_ART[p.id] }));

export const BUILDING_TYPES: BuildingType[] = BUILDING_TYPE_DEFS.map((t) => ({ ...t, art: BUILDING_ART[t.id] }));

/** Branded designs are products too; the game store registers them from /api/me. */
const DESIGNED = new Map<string, Product>();

export function registerDesigns(designs: ServerDesign[]) {
  for (const d of designs) {
    const base = PRODUCT_DEFS.find((p) => p.id === d.baseProductId);
    DESIGNED.set(d.id, { id: d.id, name: d.name, tier: base?.tier ?? 'T4', refPrice: d.priceCents / 100, art: d.art });
  }
}

export const isDesign = (id: string) => DESIGNED.has(id);

export const productById = (id: string): Product => {
  const p = PRODUCTS.find((x) => x.id === id) ?? DESIGNED.get(id);
  if (p) return p;
  // A design created since the last refresh: show its id until the next poll registers it.
  return { id, name: id.startsWith('d_') ? 'Branded product' : id, tier: 'T4', refPrice: 0 };
};

export const buildingTypeById = (id: string) => {
  const t = BUILDING_TYPES.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown building type ${id}`);
  return t;
};

export function recipeText(t: BuildingType): string {
  if (t.summary) return t.summary;
  const side = (lines: { productId: string; qty: number }[]) =>
    lines.map((l) => `${l.qty} ${productById(l.productId).unit ?? productById(l.productId).name.toLowerCase()}`).join(' + ');
  const ins = t.inputs.length ? side(t.inputs) : 'No inputs';
  return `${ins} → ${side(t.outputs)} · ${t.cycleHours} h`;
}
