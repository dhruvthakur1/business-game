import { NavLink, Outlet, Link, useNavigate } from 'react-router-dom';
import { compact, num } from '../lib/format';
import { useGame } from '../state/game';
import { Icon, Logo, type IconName } from './Icon';
import { ProgressBar } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Operate',
    items: [
      { to: '/app', label: 'Headquarters', icon: 'home', end: true },
      { to: '/app/buildings/b3', label: 'Production', icon: 'factory' },
      { to: '/app/market', label: 'Exchange', icon: 'chart' },
      { to: '/app/contracts', label: 'Contracts', icon: 'contract' },
    ],
  },
  {
    label: 'Create',
    items: [
      { to: '/app/designer', label: 'Product designer', icon: 'pen' },
      { to: '/app/research', label: 'Research', icon: 'flask' },
    ],
  },
  { label: 'Finance', items: [{ to: '/app/bank', label: 'Bank', icon: 'bank' }] },
  {
    label: 'Compete & live',
    items: [
      { to: '/app/leagues', label: 'Leagues', icon: 'trophy' },
      { to: '/app/season', label: 'Season pass', icon: 'star' },
      { to: '/app/showroom', label: 'Showroom', icon: 'gem' },
      { to: '/app/catalog', label: 'Catalog', icon: 'grid' },
    ],
  },
];

const MOBILE: NavItem[] = [
  { to: '/app', label: 'Home', icon: 'home', end: true },
  { to: '/app/buildings/b3', label: 'Build', icon: 'factory' },
  { to: '/app/market', label: 'Market', icon: 'chart' },
  { to: '/app/leagues', label: 'League', icon: 'trophy' },
  { to: '/app/showroom', label: 'Me', icon: 'gem' },
];

function Sidebar() {
  const { ready, company, me, signOut } = useGame();
  const navigate = useNavigate();
  const xp = me?.xp;
  const s = me?.season;
  const name = company?.name ?? '—';
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const level = company?.level ?? 1;
  return (
    <nav className="sidebar" aria-label="Main">
      <Link to="/" className="brand">
        <Logo />
        <span className="brand-name">Mercantile</span>
      </Link>

      <div className="company-card">
        <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
          <span className="avatar">{initials}</span>
          <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
            <strong>{name}</strong>
            {s?.title && <span className="small goldtx" style={{ fontWeight: 600 }}>{s.title}</span>}
            <span className="small muted">Lv {level}{me?.league ? ` · ${me.league.tier} · ${me.league.division}` : ''}</span>
          </div>
        </div>
        <ProgressBar value={xp ? xp.intoLevel / xp.levelSize : 0} size="thin" color="var(--info)" label="Experience to next level" />
        <span className="mono small muted">{num(xp?.intoLevel ?? 0)} / {num(xp?.levelSize ?? 0)} XP to Lv {level + 1}</span>
        {xp?.nextUnlock && (
          <span className="small muted">Lv {xp.nextUnlock.level} unlocks <span style={{ color: 'var(--text-soft)' }}>{xp.nextUnlock.names.join(', ')}</span></span>
        )}
        {xp?.recent[0] && (
          <span className="small" style={{ color: 'var(--info-soft)' }} title={xp.recent.map((r) => `+${r.amount} · ${r.note}`).join('\n')}>
            +{num(xp.recent[0].amount)} XP · {xp.recent[0].note}
          </span>
        )}
      </div>

      {GROUPS.map((g) => (
        <div className="nav-group" key={g.label}>
          <span className="overline">{g.label}</span>
          {g.items.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <Icon name={item.icon} />
              {item.label}
              {item.label === 'Production' && ready.length > 0 && <span className="nav-badge">{ready.length}</span>}
              {item.label === 'Leagues' && me?.league && <span className="nav-meta">#{me.league.rank}</span>}
              {item.label === 'Season pass' && !!s?.unclaimed && <span className="nav-badge">{s.unclaimed}</span>}
            </NavLink>
          ))}
        </div>
      ))}

      {s && (
        <Link to="/app/season" className="company-card" style={{ marginTop: 'auto', color: 'inherit' }}>
          <div className="row-between" style={{ fontSize: 13 }}>
            <strong>Season {s.number} · {s.name}</strong>
            <span className="muted">{s.daysLeft} d</span>
          </div>
          <ProgressBar value={s.tier / s.tiers} size="thin" label="Season progress" />
          <span className="small muted">Tier {s.tier} / {s.tiers}{s.next ? ` · next: ${s.next}` : ' · complete'}</span>
        </Link>
      )}
      {company && (
        <div className="row-between small" style={{ padding: '4px 4px 0', gap: 8 }}>
          <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{me?.account?.email ?? 'Demo company'}</span>
          <button type="button" className="btn btn-ghost" style={{ padding: '4px 0', flexShrink: 0 }} onClick={() => void signOut().then(() => navigate('/'))}>Sign out</button>
        </div>
      )}
    </nav>
  );
}

function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Main">
      {MOBILE.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon name={item.icon} size={22} />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function TopBar({ title, subtitle }: { title: string; subtitle?: string }) {
  const { cash, netWorth, timeScale } = useGame();
  return (
    <header className="topbar">
      <div className="stack-sm" style={{ gap: 2 }}>
        <h1 className="h-page">{title}</h1>
        {subtitle && <span className="muted" style={{ fontSize: 13 }}>{subtitle}</span>}
      </div>
      <div className="topbar-right">
        {timeScale > 1 && <span className="mono small muted hide-sm" style={{ padding: '0 6px' }} title="Server TIME_SCALE">Game speed ×{timeScale}</span>}
        <div className="pill-stat">
          <span className="small muted">Cash</span>
          <span className="mono goldtx" style={{ fontWeight: 600 }}>{num(cash)} CR</span>
        </div>
        <div className="pill-stat hide-sm">
          <span className="small muted">Net worth</span>
          <span className="mono" style={{ fontWeight: 600 }}>{compact(netWorth)}</span>
        </div>
        <button type="button" className="icon-btn" aria-label="Notifications, 4 unread">
          <Icon name="bell" />
          <span className="dot" />
        </button>
      </div>
    </header>
  );
}

function Toasts() {
  const { toasts, dismiss } = useGame();
  return (
    <div className="toast-wrap" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" role="status">
          <span className={t.tone === 'bad' ? 'loss' : t.tone === 'info' ? '' : 'gain'} style={{ color: t.tone === 'info' ? 'var(--info)' : undefined }}>
            <Icon name={t.tone === 'bad' ? 'alert' : 'check'} />
          </span>
          <div className="stack-sm" style={{ gap: 2, flex: 1 }}>
            <strong>{t.title}</strong>
            {t.body && <span className="muted" style={{ fontSize: 13 }}>{t.body}</span>}
          </div>
          <button type="button" className="btn-ghost" style={{ border: 0, background: 'none', color: 'var(--muted)' }} aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

function SessionGate() {
  const { status, signInDemo } = useGame();
  if (status === 'ready') return <Outlet />;
  if (status === 'loading') return <p className="muted" style={{ paddingTop: 48 }}>Loading your company…</p>;
  if (status === 'offline') {
    return (
      <div className="card" style={{ marginTop: 48, maxWidth: 560 }} role="alert">
        <h1 className="h-section">Can’t reach the game server</h1>
        <p className="muted">Start the API with <code className="mono">npm run dev</code> in the <code className="mono">server</code> folder, then this page reconnects on its own.</p>
      </div>
    );
  }
  return (
    <div className="card" style={{ marginTop: 48, maxWidth: 560 }}>
      <h1 className="h-section">You’re not signed in</h1>
      <p className="muted">Sign in to your company, or found a new one.</p>
      <div className="row">
        <Link to="/signin" className="btn btn-primary">Sign in</Link>
        <Link to="/start" className="btn btn-secondary">Found a company</Link>
        <button type="button" className="btn btn-ghost" onClick={() => void signInDemo()}>Use demo company</button>
      </div>
    </div>
  );
}

export function AppShell() {
  return (
    <div className="shell">
      <Sidebar />
      <main className="shell-main">
        <SessionGate />
      </main>
      <BottomNav />
      <Toasts />
    </div>
  );
}

/** Toasts for pages outside the app shell (onboarding). */
export { Toasts };
