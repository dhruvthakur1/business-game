import type { BuildingTypeDef, ProductDef } from '../../../shared/catalog';
import type { Quality } from '../lib/economy';

export type { TierCode, SectorTag, RecipeLine } from '../../../shared/catalog';

export interface Product extends ProductDef {
  art?: string;
}

export interface BuildingType extends BuildingTypeDef {
  art: string;
}

export type BuildingStatus = 'running' | 'ready' | 'idle' | 'construction';

export interface Building {
  id: string;
  typeId: string;
  name: string;
  level: number;
  status: BuildingStatus;
  /** 0–1 for running/construction jobs */
  progress: number;
  minutesLeft: number;
  plot: { col: number; row: number };
  readyOutput?: { productId: string; qty: number; quality: Quality };
  netPerDay: number;
}

export type LeagueName = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond' | 'Master' | 'Tycoon';
