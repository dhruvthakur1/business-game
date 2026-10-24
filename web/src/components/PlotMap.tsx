import { Link } from 'react-router-dom';
import { buildingTypeById } from '../data/catalog';
import type { Building } from '../data/types';

const TILE_HALF_W = 83;
const TILE_HALF_H = 48;
const ART_W = 200;
const ART_H = 180;

export interface MapItem {
  key: string;
  art: string;
  col: number;
  row: number;
  label: string;
  href?: string;
  dim?: boolean;
  badge?: { text: string; bg: string; fg: string };
}

export function statusBadge(b: Building): MapItem['badge'] {
  switch (b.status) {
    case 'ready':
      return { text: 'Ready', bg: 'var(--gold)', fg: 'var(--gold-ink)' };
    case 'running':
      return { text: `${Math.round(b.progress * 100)}%`, bg: 'var(--gain-wash)', fg: 'var(--gain-soft)' };
    case 'construction':
      return { text: `Building ${Math.round(b.progress * 100)}%`, bg: 'var(--info-wash)', fg: 'var(--info-soft)' };
    default:
      return { text: 'Idle', bg: 'var(--line)', fg: 'var(--text-soft)' };
  }
}

export function buildingsToMap(buildings: Building[]): MapItem[] {
  return buildings.map((b) => ({
    key: b.id,
    art: buildingTypeById(b.typeId).art,
    col: b.plot.col,
    row: b.plot.row,
    label: `${b.name}, level ${b.level}, ${b.status}`,
    href: `/app/buildings/${b.id}`,
    dim: b.status === 'idle' || b.status === 'construction',
    badge: statusBadge(b),
  }));
}

/** Isometric plot grid. Items are drawn back-to-front so nearer buildings overlap farther ones. */
export function PlotMap({ items, cols = 3, rows = 3 }: { items: MapItem[]; cols?: number; rows?: number }) {
  const width = (cols - 1 + rows - 1) * TILE_HALF_W + ART_W;
  const height = (cols - 1 + rows - 1) * TILE_HALF_H + ART_H + 8;
  const originX = (rows - 1) * TILE_HALF_W;
  const sorted = [...items].sort((a, b) => a.col + a.row - (b.col + b.row) || a.col - b.col);

  return (
    <div style={{ position: 'relative', width, height, margin: '0 auto', flexShrink: 0 }}>
      {sorted.map((it) => {
        const left = originX + (it.col - it.row) * TILE_HALF_W;
        const top = (it.col + it.row) * TILE_HALF_H;
        const img = <img src={it.art} alt="" width={ART_W} height={ART_H} style={{ opacity: it.dim ? 0.55 : 1 }} />;
        return (
          <div key={it.key} style={{ position: 'absolute', left, top, width: ART_W, height: ART_H }}>
            {it.href ? (
              <Link to={it.href} aria-label={it.label} title={it.label}>{img}</Link>
            ) : (
              img
            )}
            {it.badge && (
              <span
                className="mono"
                style={{
                  position: 'absolute', left: '50%', top: 34, transform: 'translateX(-50%)', pointerEvents: 'none',
                  fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 999, whiteSpace: 'nowrap',
                  background: it.badge.bg, color: it.badge.fg,
                }}
              >
                {it.badge.text}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
