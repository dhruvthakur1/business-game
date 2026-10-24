import { Link, useNavigate } from 'react-router-dom';
import { useGame } from '../state/game';
import { Logo } from '../components/Icon';
import { PlotMap, type MapItem } from '../components/PlotMap';
import { LeagueBadge } from '../components/ui';
import { BUILDING_TYPES } from '../data/catalog';
import { LEAGUES } from '../data/mock';

const art = (id: string) => BUILDING_TYPES.find((b) => b.id === id)!.art;

const HERO: MapItem[] = [
  { key: 'a', art: art('car_factory'), col: 0, row: 0, label: '' },
  { key: 'b', art: art('chip_fab'), col: 1, row: 0, label: '' },
  { key: 'c', art: art('steel_mill'), col: 0, row: 1, label: '' },
  { key: 'd', art: art('watchmaker'), col: 2, row: 0, label: '' },
  { key: 'e', art: art('bakery'), col: 1, row: 1, label: '' },
  { key: 'f', art: art('power_plant'), col: 0, row: 2, label: '' },
  { key: 'g', art: art('luxury_store'), col: 2, row: 1, label: '' },
  { key: 'h', art: art('mill'), col: 1, row: 2, label: '' },
  { key: 'i', art: art('farm'), col: 2, row: 2, label: '' },
];

const CHAIN = [
  { id: 'farm', name: 'Farm', note: '100 wheat / 4h' },
  { id: 'mill', name: 'Mill', note: '80 flour / 4h' },
  { id: 'bakery', name: 'Bakery', note: '40 bread / 4h' },
  { id: 'supermarket', name: 'Supermarket', note: 'sells to shoppers' },
];

const STEPS = [
  { n: '01 · Produce', t: 'Set a job, come back later', d: 'Buildings run 4-hour cycles. Better inputs make better outputs, so quality is earned through the chain, not bought.' },
  { n: '02 · Trade', t: 'Exchange, contracts and tenders', d: 'Sell on an open order book or sign escrowed supply contracts. Deliver on time and your reliability score opens bigger deals.' },
  { n: '03 · Grow', t: 'Borrow, build, branch out', d: 'The bank lends against your cash flow. Move from food into energy, steel, electronics, cars and luxury goods under your own brand.' },
];

const FAIR = [
  { t: 'Cosmetics only', d: 'No credits, speed-ups, cheaper loans or contest entries for sale. Ever.' },
  { t: 'Scores that resist tricks', d: 'Linked accounts, self-trades and off-market prices don’t count. Net worth is a 24-hour average.' },
  { t: 'Safe to fail', d: 'Go bankrupt and you keep your first building, level, brand and trophies.' },
];

const wrap = { maxWidth: 1200, margin: '0 auto', padding: '0 24px' } as const;
const h2 = { fontFamily: 'var(--font-display)', fontSize: 'clamp(32px, 4vw, 44px)', fontWeight: 700, letterSpacing: -1, lineHeight: 1.05 } as const;

export function Landing() {
  const { status, signInDemo } = useGame();
  const navigate = useNavigate();
  const signIn = async () => {
    if (status !== 'ready') await signInDemo();
    navigate('/app');
  };
  return (
    <div style={wrap}>
      <nav aria-label="Site" className="row-between" style={{ padding: '24px 0' }}>
        <Link to="/" className="brand"><Logo size={34} /><span className="brand-name" style={{ fontSize: 21 }}>Mercantile</span></Link>
        <div className="row" style={{ gap: '8px 28px', fontSize: 15 }}>
          <a href="#how" style={{ color: 'var(--text-soft)' }}>How it works</a>
          <a href="#compete" style={{ color: 'var(--text-soft)' }}>Leagues</a>
          <a href="#fair" style={{ color: 'var(--text-soft)' }}>Fair play</a>
          <button type="button" onClick={() => void signIn()} style={{ border: 0, background: 'none', color: 'var(--text-soft)', padding: 0, fontSize: 15 }}>
            {status === 'ready' ? 'Open game' : 'Demo sign-in'}
          </button>
          <Link to="/start" className="btn btn-primary">Play free</Link>
        </div>
      </nav>

      <header className="split" style={{ alignItems: 'center', gap: 48, padding: '24px 0 64px' }}>
        <div className="stack" style={{ flex: '1 1 440px', gap: 24 }}>
          <span className="chip pill" style={{ alignSelf: 'flex-start', background: '#151a22', border: '1px solid var(--line)', color: 'var(--text-soft)', fontSize: 13, padding: '6px 12px' }}>Season 3 · Iron Age is live</span>
          <h1 className="disp" style={{ fontSize: 'clamp(44px, 6vw, 76px)', lineHeight: 1, fontWeight: 700, letterSpacing: -2 }}>
            Start with one farm.<br /><span className="goldtx">Own the supply chain.</span>
          </h1>
          <p className="muted" style={{ fontSize: 19, maxWidth: 520 }}>
            A persistent business world run by players. Grow wheat, mill flour, bake bread, then move into steel, chips, cars and watches. Every price on the exchange is set by someone like you.
          </p>
          <div className="row">
            <Link to="/start" className="btn btn-primary btn-lg">Found your company</Link>
            <a href="#how" className="btn btn-secondary btn-lg">See how it works</a>
          </div>
          <span className="muted" style={{ fontSize: 13 }}>Free to play. The shop sells cosmetics only.</span>
        </div>
        <div style={{ flex: '1 1 480px', minWidth: 0, overflow: 'hidden', display: 'flex', justifyContent: 'center' }} role="img" aria-label="An isometric town of farms, mills, factories and shops">
          <div style={{ position: 'relative' }}>
            <PlotMap items={HERO} />
            <div className="card" style={{ position: 'absolute', left: 0, top: 8, padding: '10px 14px', gap: 2, borderColor: 'var(--line-strong)' }}>
              <span className="small muted">Flour · 24h</span><span className="mono gain">8.34 ▲ 4.2%</span>
            </div>
            <div className="row" style={{ position: 'absolute', right: 0, bottom: 20, background: 'var(--panel)', border: '1px solid var(--line-strong)', borderRadius: 999, padding: '8px 14px', gap: 10 }}>
              <span className="mono" style={{ fontWeight: 600 }}>#6</span><span className="small muted">Gold league</span>
            </div>
          </div>
        </div>
      </header>

      <section aria-label="At a glance" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 1, background: 'var(--line)', border: '1px solid var(--line)', borderRadius: 16, overflow: 'hidden' }}>
        {[['34', 'business types at launch'], ['~110', 'products in 8 tiers'], ['30', 'rivals in your weekly league'], ['4h', 'production cycles, no grinding']].map(([v, l]) => (
          <div key={l} className="stack-sm" style={{ background: 'var(--sunken)', padding: 24, gap: 4 }}>
            <span className="mono" style={{ fontSize: 30, fontWeight: 600 }}>{v}</span>
            <span className="muted">{l}</span>
          </div>
        ))}
      </section>

      <section id="how" className="stack" style={{ gap: 40, paddingTop: 112 }}>
        <div className="stack-sm" style={{ maxWidth: 640, gap: 12 }}>
          <span className="overline goldtx">How it works</span>
          <h2 style={h2}>Every product is someone's input</h2>
          <p className="muted" style={{ fontSize: 17 }}>Your bakery needs another player's flour. Their mill needs your wheat. Supply chains overlap, so trading is how everyone grows.</p>
        </div>
        <div className="row" style={{ justifyContent: 'center', gap: 8, background: 'var(--sunken)', border: '1px solid var(--line)', borderRadius: 20, padding: 24 }}>
          {CHAIN.map((c, i) => (
            <div key={c.id} className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              {i > 0 && <span className="goldtx" aria-hidden="true" style={{ fontSize: 24 }}>→</span>}
              <figure style={{ margin: 0 }} className="stack-sm">
                <img src={art(c.id)} alt="" width={180} height={162} />
                <figcaption style={{ textAlign: 'center', fontWeight: 600 }}>{c.name}</figcaption>
                <span className="mono small muted" style={{ textAlign: 'center' }}>{c.note}</span>
              </figure>
            </div>
          ))}
        </div>
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
          {STEPS.map((s) => (
            <div key={s.n} className="card" style={{ padding: 24, gap: 10 }}>
              <span className="mono goldtx" style={{ fontSize: 13 }}>{s.n}</span>
              <strong className="disp" style={{ fontSize: 22, fontWeight: 600 }}>{s.t}</strong>
              <span className="muted" style={{ fontSize: 15 }}>{s.d}</span>
            </div>
          ))}
        </div>
      </section>

      <section id="compete" className="split" style={{ gap: 48, alignItems: 'center', paddingTop: 112 }}>
        <div className="stack" style={{ flex: '1 1 400px' }}>
          <span className="overline goldtx">Compete</span>
          <h2 style={h2}>A league of 30 companies your size</h2>
          <p className="muted" style={{ fontSize: 17 }}>Each week you're grouped with companies in your division. Top 7 move up, bottom 5 move down. Scores are normalized, so a small company having a great week can beat a big one.</p>
          <div className="row" style={{ gap: 8 }}>{LEAGUES.map((l) => <LeagueBadge key={l} league={l} />)}</div>
        </div>
        <div className="card" style={{ flex: '1 1 420px', gap: 6, borderRadius: 20 }}>
          {[['#4', 'Tundra Extraction', '1,268'], ['#5', 'Ferro Labs', '1,207'], ['#6', 'Your company', '1,178'], ['#7', 'Saltmarsh Foods', '1,107']].map(([r, n, p]) => (
            <div key={r} style={{ display: 'grid', gridTemplateColumns: '48px minmax(0, 1fr) 80px', gap: 10, alignItems: 'center', minHeight: 44, padding: '0 12px', borderRadius: 10, background: r === '#6' ? 'var(--gold-wash)' : undefined, border: `1px solid ${r === '#6' ? 'var(--gold-edge)' : 'transparent'}` }}>
              <span className="mono gain" style={{ fontWeight: 600 }}>{r}</span>
              <span>{n} {r === '#6' && <span className="small muted">1,200 CR behind #5</span>}</span>
              <span className="mono" style={{ textAlign: 'right' }}>{p}</span>
            </div>
          ))}
          <div className="row gain" style={{ gap: 10, padding: '4px 12px', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', flexWrap: 'nowrap' }}>
            <span style={{ flex: 1, height: 1, background: 'var(--gain)', opacity: 0.4 }} />Promotion line<span style={{ flex: 1, height: 1, background: 'var(--gain)', opacity: 0.4 }} />
          </div>
        </div>
      </section>

      <section id="fair" className="stack" style={{ gap: 32, paddingTop: 112 }}>
        <div className="stack-sm" style={{ gap: 12 }}>
          <span className="overline goldtx">Fair play</span>
          <h2 style={h2}>You can't buy a better rank</h2>
        </div>
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20 }}>
          {FAIR.map((f) => (
            <div key={f.t} className="stack-sm" style={{ borderTop: '2px solid var(--gold)', paddingTop: 16 }}>
              <strong style={{ fontSize: 17 }}>{f.t}</strong>
              <span className="muted" style={{ fontSize: 15 }}>{f.d}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card" style={{ marginTop: 112, padding: '56px 32px', alignItems: 'center', textAlign: 'center', gap: 20, borderRadius: 24 }}>
        <h2 className="disp" style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>Your first harvest is four hours away</h2>
        <p className="muted" style={{ fontSize: 17, maxWidth: 520 }}>Start with 100,000 CR and a plot in the North. Plant wheat in your first ten minutes.</p>
        <Link to="/start" className="btn btn-primary btn-lg">Found your company</Link>
      </section>

      <footer className="row-between muted" style={{ padding: '32px 0 48px', marginTop: 64, borderTop: '1px solid var(--line-soft)' }}>
        <span>© Mercantile [YEAR] · [STUDIO NAME]</span>
        <div className="row" style={{ gap: 24 }}>
          <a href="#fair" style={{ color: 'var(--muted)' }}>Fair play policy</a>
          <a href="#" style={{ color: 'var(--muted)' }}>Terms</a>
          <a href="#" style={{ color: 'var(--muted)' }}>Privacy</a>
        </div>
      </footer>
    </div>
  );
}
