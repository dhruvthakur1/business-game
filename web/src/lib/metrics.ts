import type { MetricUnit } from '../api/types';
import { num } from './format';

/** Formats a contest metric for display. */
export function formatMetric(unit: MetricUnit, value: number): string {
  switch (unit) {
    case 'cr':
      return `${num(value)} CR`;
    case 'pct':
      return `${(value * 100).toFixed(1)}%`;
    case 'units_per_level':
      return `${value.toFixed(1)} / level`;
    default:
      return num(value);
  }
}
