const P = (file: string) => `/art/products/${file}.svg`;

export interface Rung {
  name: string;
  /** null = auction only, 0 = renting */
  price: number | null;
  art?: string;
}

export interface Ladder {
  id: string;
  label: string;
  owned: number;
  rule: string;
  rungs: Rung[];
}

export const LADDERS: Ladder[] = [
  {
    id: 'garage', label: 'Garage', owned: 1,
    rule: 'Cars: upkeep 0.02% of price per day · NPC buys back at 70% · numbered classics trade between players only',
    rungs: [
      { name: 'Economy hatch', price: 2500, art: P('car-economy') },
      { name: 'Sports coupé', price: 90_000, art: P('car-sports') },
      { name: 'Luxury sedan', price: 400_000, art: P('car-sedan') },
      { name: 'Supercar', price: 2_500_000, art: P('car-supercar') },
      { name: 'Hypercar', price: 15_000_000, art: P('car-hypercar') },
    ],
  },
  {
    id: 'vault', label: 'Vault', owned: 1,
    rule: 'Watches: no upkeep · NPC buys back at 70% · Founders editions are 1-of-100 and never re-released',
    rungs: [
      { name: 'Steel quartz', price: 1500, art: P('watch-quartz') },
      { name: 'Automatic', price: 12_000, art: P('watch-automatic') },
      { name: 'Gold dress watch', price: 150_000, art: P('watch-gold-dress') },
      { name: 'Complication', price: 1_000_000, art: P('watch-tourbillon') },
      { name: 'Founders 1-of-100', price: null, art: P('watch-founders') },
    ],
  },
  {
    id: 'wardrobe', label: 'Wardrobe', owned: 2,
    rule: 'Clothing: no upkeep · NPC buys back at 50% · worn on your avatar and profile',
    rungs: [
      { name: 'Streetwear', price: 300, art: P('streetwear-tee') },
      { name: 'Designer sneakers', price: 5000, art: P('sneakers') },
      { name: 'Designer bag', price: 25_000, art: P('handbag') },
      { name: 'Gala gown', price: 250_000, art: P('gala-gown') },
      { name: 'Numbered collab drop', price: null, art: P('sneakers') },
    ],
  },
  {
    id: 'homes', label: 'Homes & toys', owned: 1,
    rule: 'Homes: upkeep 0.03%/day, NPC buyback 75% · Yachts and jets: upkeep 0.08%/day, buyback 70% · renting is the cheap way up',
    rungs: [
      { name: 'Studio (rent 200/day)', price: 0 },
      { name: 'Apartment', price: 500_000 },
      { name: 'Villa', price: 5_000_000 },
      { name: 'Superyacht', price: 150_000_000, art: P('superyacht') },
      { name: 'Private jet', price: 300_000_000, art: P('private-jet') },
    ],
  },
];

/** Showroom gallery used by the product art catalog page. */
export const GALLERY = {
  luxury: [
    { name: 'Silver chain', price: '2,000 CR', art: P('silver-chain') },
    { name: 'Designer bag', price: '25,000 CR', art: P('handbag') },
    { name: 'Diamond ring', price: '200,000 CR', art: P('diamond-ring') },
    { name: 'Named gem', price: '10M+ CR', art: P('named-gem') },
    { name: 'Streetwear', price: '300 CR', art: P('streetwear-tee') },
    { name: 'Designer sneakers', price: '5,000 CR', art: P('sneakers') },
    { name: 'Gala gown', price: '250,000 CR', art: P('gala-gown') },
  ],
  big: [
    { name: 'Superyacht', price: '150M CR', art: P('superyacht') },
    { name: 'Private jet', price: '300M CR', art: P('private-jet') },
    { name: 'Smartphone', price: '230 wholesale', art: P('smartphone') },
    { name: 'Laptop', price: '650 wholesale', art: P('laptop') },
  ],
};
