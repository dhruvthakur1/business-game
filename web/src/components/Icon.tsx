const PATHS = {
  home: 'M3 9l7-5 7 5v8H3z M8 17v-5h4v5',
  factory: 'M3 17V8l4-3v3l4-3v3l4-3v12z',
  chart: 'M3 15l4-5 3 3 6-7M12 6h4v4',
  contract: 'M5 3h7l3 3v11H5z M8 9h5M8 12h5M8 15h3',
  pen: 'M4 16l2.5-.5L15 7l-2-2-8.5 8.5zM11.5 6.5l2 2',
  flask: 'M8 3h4M9 3v5l-4.5 7.5A1 1 0 005.4 17h9.2a1 1 0 00.9-1.5L11 8V3',
  bank: 'M3 8l7-4 7 4M4 8v7M8 8v7M12 8v7M16 8v7M3 16h14',
  trophy: 'M6 3h8v4a4 4 0 01-8 0zM10 11v3M7 17h6M6 5H3.5a2.5 2.5 0 002.5 3M14 5h2.5a2.5 2.5 0 01-2.5 3',
  gem: 'M3 7l3-3h8l3 3-7 9z M3 7h14',
  grid: 'M3 3h6v6H3z M11 3h6v6h-6z M3 11h6v6H3z M11 11h6v6h-6z',
  bell: 'M5 14V9a5 5 0 0110 0v5l1.5 2h-13zM8 18h4',
  check: 'M6.5 10.2l2.3 2.3 4.7-4.9',
  alert: 'M10 6v5 M10 14v.5',
  arrow: 'M4 10h11M11 5l5 5-5 5',
  back: 'M16 10H5M9 5l-5 5 5 5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  const circled = name === 'check' || name === 'alert';
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className={className}>
      {circled && <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.6" fill="none" />}
      <path d={PATHS[name]} stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true">
      <rect width="44" height="44" rx="10" fill="var(--gold)" />
      <path d="M11 32V14l11 9 11-9v18" stroke="var(--gold-ink)" strokeWidth="3.4" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
