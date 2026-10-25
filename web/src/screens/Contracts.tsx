import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, toCr } from '../api/client';
import type { ContractDelivery, ContractsResponse, ContractView, RfqBoardResponse, Supplier } from '../api/types';
import { TopBar } from '../components/AppShell';
import { Card, Segmented } from '../components/ui';
import { PRODUCTS, productById } from '../data/catalog';
import { dec, duration, num } from '../lib/format';
import { useGame } from '../state/game';
import { bondCents, CONTRACT_RULES, deliveryCount, frequencyLabel, RFQ_RULES, type ContractTerms } from '../../../shared/contracts';

type Tab = 'active' | 'offers' | 'rfq' | 'dir';
const REFRESH_MS = 5000;

const CONTRACT_STATUS: Record<ContractView['status'], { label: string; tone: string }> = {
  offered: { label: 'Offered', tone: 'var(--info)' },
  rejected: { label: 'Rejected', tone: 'var(--muted)' },
  expired: { label: 'Expired', tone: 'var(--muted)' },
  withdrawn: { label: 'Withdrawn', tone: 'var(--muted)' },
  active: { label: 'Active', tone: 'var(--gain)' },
  completed: { label: 'Completed', tone: 'var(--text-soft)' },
  terminated_by_notice: { label: 'Ended by notice', tone: 'var(--text-soft)' },
  terminated_for_breach: { label: 'Ended for breach', tone: 'var(--loss)' },
};

const DELIVERY_STATUS: Record<ContractDelivery['status'], { label: string; tone: string }> = {
  pending: { label: 'Scheduled', tone: 'var(--muted)' },
  funded: { label: 'Escrow funded', tone: 'var(--gold)' },
  unfunded: { label: 'Buyer didn’t fund', tone: 'var(--loss)' },
  settled: { label: 'Delivered', tone: 'var(--gain)' },
  breached: { label: 'Not delivered', tone: 'var(--loss)' },
  cancelled: { label: 'Cancelled', tone: 'var(--faint)' },
};

const productOptions = PRODUCTS.filter((p) => !p.npcVendor);
const productName = (id: string) => productById(id).name;
const title = (c: Pick<ContractView, 'qty' | 'productId' | 'minQuality' | 'frequencyHours' | 'role' | 'counterpartyName'>) =>
  `${num(c.qty)} ${productName(c.productId).toLowerCase()} Q${c.minQuality}+ ${frequencyLabel(c.frequencyHours)} ${c.role === 'seller' ? '→' : '←'} ${c.counterpartyName}`;

function useGameClock() {
  const { timeScale } = useGame();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  /** Game-time distance from now to an ISO time, as "3h 20m" (negative = past). */
  const until = (iso: string) => (Date.parse(iso) - now) * timeScale / 60_000;
  return { now, until };
}

export function Contracts() {
  const { act, notify, refresh, company, me } = useGame();
  const locked = (company?.level ?? 1) < CONTRACT_RULES.minLevel;
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'active';
  const setTab = (t: Tab) => setParams(t === 'active' ? {} : { tab: t }, { replace: true });
  const [data, setData] = useState<ContractsResponse | null>(null);
  const [board, setBoard] = useState<RfqBoardResponse | null>(null);
  const [devTools, setDevTools] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([api<ContractsResponse>('/contracts'), api<RfqBoardResponse>('/rfqs')]);
      setData(c);
      setBoard(r);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else throw err;
    }
  }, []);

  useEffect(() => {
    void load();
    void api<{ devTools: boolean }>('/bank').then((b) => setDevTools(b.devTools)).catch(() => undefined);
    const t = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  /** Runs an action, reports errors as toasts, reloads contracts and company state. */
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, ok?: (r: T) => [string, string?]) => {
      const res = await act(fn);
      if (res && ok) notify(...ok(res));
      await load();
      return res;
    },
    [act, load, notify],
  );

  const contracts = data?.contracts ?? [];
  const active = contracts.filter((c) => c.status !== 'offered');
  const offers = contracts.filter((c) => c.status === 'offered');
  const incoming = offers.filter((c) => !c.proposedByMe);
  const rel = data?.reliability;

  const fastForward = async (hours: number) => {
    await run(() => api('/dev/advance-contracts', { body: { hours } }), () => [`Fast-forwarded ${hours} game hours`, 'Deliveries and NPC responses processed.']);
    await refresh();
  };

  return (
    <>
      <TopBar title="Contracts" subtitle="Escrowed deliveries, performance bonds, sealed-bid tenders · 1% fee" />

      <section className="row-between">
        <Segmented
          label="Contracts sections"
          boxed
          value={tab}
          onChange={setTab}
          options={[
            { value: 'active', label: `Contracts · ${active.filter((c) => c.status === 'active').length}` },
            { value: 'offers', label: `Offers${incoming.length ? ` · ${incoming.length} new` : ''}` },
            { value: 'rfq', label: `RFQ board · ${board?.open.length ?? 0}` },
            { value: 'dir', label: 'Suppliers' },
          ]}
        />
        <div className="card row" style={{ padding: '10px 16px', flexDirection: 'row', gap: 14 }}>
          <span className="muted" style={{ fontSize: 13 }}>Your reliability</span>
          <span className={`mono ${rel && rel.score >= 80 ? 'gain' : 'loss'}`} style={{ fontSize: 20, fontWeight: 600 }}>{rel ? rel.score.toFixed(1) : '—'}</span>
          <span className="small muted">{rel ? (rel.verified ? `verified · ${rel.counterparties} buyers` : `prior · ${rel.counterparties}/3 buyers to verify`) : ''}</span>
        </div>
      </section>

      {locked && (
        <div className="callout bad" role="status" style={{ background: 'var(--info-wash)' }}>
          <span style={{ fontWeight: 700, color: 'var(--info)' }}>i</span>
          <span>
            <strong style={{ color: 'var(--info-soft)' }}>Contracts unlock at Lv {CONTRACT_RULES.minLevel}.</strong>{' '}
            <span className="muted">
              You can browse the board and suppliers now; offering, accepting and bidding open up in{' '}
              {num(Math.max(0, (me?.xp.nextLevelAt ?? 0) - (me?.xp.total ?? 0)))} XP{(company?.level ?? 1) < CONTRACT_RULES.minLevel - 1 ? ' plus more levels' : ''}. Production and trading earn XP.
            </span>
          </span>
        </div>
      )}
      {data?.suspendedUntil && Date.parse(data.suspendedUntil) > Date.now() && (
        <div className="callout bad" role="alert">
          <span className="loss" style={{ fontWeight: 700 }}>!</span>
          <span><strong className="loss">Contract activity suspended</strong> <span className="muted">after {CONTRACT_RULES.breachLimit} breaches in {CONTRACT_RULES.breachLookbackDays} days. Existing contracts continue.</span></span>
        </div>
      )}
      {error && <p className="loss">{error}</p>}

      {tab === 'active' && <ActiveTab contracts={active} run={run} devTools={devTools} onFastForward={fastForward} />}
      {tab === 'offers' && <OffersTab offers={offers} run={run} />}
      {tab === 'rfq' && board && <RfqTab board={board} run={run} devTools={devTools} onFastForward={fastForward} />}
      {tab === 'dir' && <SuppliersTab run={run} goToOffers={() => setTab('offers')} />}
    </>
  );
}

type Run = <T>(fn: () => Promise<T>, ok?: (r: T) => [string, string?]) => Promise<T | null>;

// ---------------------------------------------------------------- active

function ActiveTab({ contracts, run, devTools, onFastForward }: { contracts: ContractView[]; run: Run; devTools: boolean; onFastForward: (h: number) => Promise<void> }) {
  const [selId, setSelId] = useState<string | null>(null);
  const sel = contracts.find((c) => c.id === selId) ?? contracts[0];
  const { until } = useGameClock();

  if (contracts.length === 0) {
    return (
      <Card>
        <p className="muted">No contracts yet. Bid on a request in the RFQ board, or propose a deal from the supplier directory.</p>
      </Card>
    );
  }

  const next = sel.deliveries.find((d) => d.status === 'pending' || d.status === 'funded');
  const steps = next
    ? [
        { label: 'Window opens', done: until(next.windowStart) <= 0, meta: until(next.windowStart) > 0 ? `in ${duration(until(next.windowStart))}` : 'open' },
        { label: 'Escrow funded', done: next.status === 'funded', meta: `${dec(toCr(next.valueCents))} CR` },
        { label: 'Delivered', done: false, meta: until(next.windowEnd) > 0 ? `window ends in ${duration(until(next.windowEnd))}` : `${duration(-until(next.windowEnd))} late` },
        { label: 'Settled', done: false, meta: `−1% fee` },
      ]
    : [];

  return (
    <section className="split">
      <Card title="Your contracts" className="side" style={{ gap: 4 }}>
        {contracts.map((c) => {
          const s = CONTRACT_STATUS[c.status];
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={c.id === sel.id}
              onClick={() => setSelId(c.id)}
              className="list-row"
              style={{ border: 0, background: c.id === sel.id ? '#1e2530' : 'transparent', borderRadius: 10, padding: '10px 10px', textAlign: 'left', justifyContent: 'space-between', width: '100%' }}
            >
              <span className="stack-sm" style={{ gap: 2 }}>
                <span style={{ fontSize: 14 }}>{productName(c.productId)} {c.role === 'seller' ? '→' : '←'} {c.counterpartyName}</span>
                <span className="mono small muted">{c.role === 'seller' ? 'you sell' : 'you buy'} · {c.summary.settled}/{c.summary.total} delivered</span>
              </span>
              <span className="small" style={{ color: s.tone }}>{s.label}</span>
            </button>
          );
        })}
      </Card>

      <Card className="main" style={{ gap: 18 }}>
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div className="stack-sm" style={{ gap: 4 }}>
            <span className="mono small muted">{sel.id.slice(0, 8)} · {sel.role === 'seller' ? 'you sell' : 'you buy'}{sel.fromRfq ? ' · from RFQ' : ''}</span>
            <h2 className="h-section" style={{ fontSize: 22 }}>{title(sel)}</h2>
            <span className="muted" style={{ fontSize: 13 }}>
              {dec(toCr(sel.priceCents))} CR/unit · {sel.windowHours}h window · {sel.termDays} days · {dec(toCr(sel.qty * sel.priceCents))} CR per delivery
            </span>
          </div>
          <span className="chip" style={{ color: CONTRACT_STATUS[sel.status].tone, background: 'var(--raised)' }}>
            {CONTRACT_STATUS[sel.status].label} · {sel.summary.onTime}/{sel.summary.settled} on time
          </span>
        </div>

        {next && (
          <div className="stack-sm">
            <span className="overline">Delivery #{next.seq}</span>
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
              {steps.map((s, i) => {
                const current = !s.done && (i === 0 || steps[i - 1].done);
                return (
                  <li key={s.label} className="stack-sm" aria-current={current ? 'step' : undefined}>
                    <span style={{ height: 6, borderRadius: 999, background: s.done ? 'var(--gain)' : current ? 'var(--gold)' : 'var(--line)' }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: s.done || current ? undefined : 'var(--muted)' }}>{s.label}</span>
                    <span className="mono muted" style={{ fontSize: 11 }}>{s.meta}</span>
                  </li>
                );
              })}
            </ol>
            {sel.role === 'seller' && next.status === 'funded' && (
              <span className="small muted">Delivery happens automatically as soon as you have {num(sel.qty)} {productName(sel.productId).toLowerCase()} at Q{sel.minQuality} or better in the warehouse. The goods then travel to the buyer (1 h inside a region, 4 h per region hop); the seller pays freight. On time is judged at dispatch.</span>
            )}
          </div>
        )}

        <div className="grid-auto-sm">
          <div className="inset stack-sm"><span className="small muted">Performance bond</span><span className="mono" style={{ fontSize: 18 }}>{dec(toCr(sel.bondRemainingCents))}</span><span className="small muted">of {dec(toCr(sel.bondCents))} CR · posted by the seller</span></div>
          <div className="inset stack-sm"><span className="small muted">If late</span><span className="mono" style={{ fontSize: 18 }}>1%/h · max 10%</span><span className="small muted">paid from the bond to the buyer</span></div>
          <div className="inset stack-sm"><span className="small muted">Exit</span><span className="mono" style={{ fontSize: 18 }}>{sel.noticeEndsAt ? `ends in ${duration(Math.max(0, until(sel.noticeEndsAt)))}` : '72h notice'}</span><span className="small muted">no penalty</span></div>
        </div>

        <div className="scroll-x">
          <table className="table" style={{ minWidth: 560 }}>
            <thead><tr><th>#</th><th>Window</th><th>Status</th><th className="num">Value</th><th className="num">Late / penalty</th></tr></thead>
            <tbody>
              {sel.deliveries.slice(0, 12).map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.seq}</td>
                  <td className="mono small">{until(d.windowStart) > 0 ? `opens in ${duration(until(d.windowStart))}` : until(d.windowEnd) > 0 ? `open · ${duration(until(d.windowEnd))} left` : `closed ${duration(-until(d.windowEnd))} ago`}</td>
                  <td style={{ color: DELIVERY_STATUS[d.status].tone }}>{DELIVERY_STATUS[d.status].label}{d.deliveredQuality !== null ? ` · Q${d.deliveredQuality}` : ''}</td>
                  <td className="num">{dec(toCr(d.valueCents))}</td>
                  <td className="num">{d.lateHours ? `${d.lateHours}h · ` : ''}{d.penaltyCents ? dec(toCr(d.penaltyCents)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sel.deliveries.length > 12 && <span className="small muted">+{sel.deliveries.length - 12} more deliveries</span>}
        </div>

        <div className="row">
          {sel.status === 'active' && !sel.noticeEndsAt && (
            <button type="button" className="btn btn-secondary" onClick={() => void run(() => api(`/contracts/${sel.id}/terminate`, { body: {} }), () => ['Notice given', 'Deliveries after 72 game hours are cancelled. No penalty.'])}>
              Give 72h notice
            </button>
          )}
          {devTools && sel.status === 'active' && (
            <button type="button" className="btn btn-ghost" onClick={() => void onFastForward(6)} title="Development only">Fast-forward 6h (dev)</button>
          )}
          {sel.endReason && sel.status !== 'active' && <span className="small muted">Ended: {sel.endReason.replace(/_/g, ' ')}</span>}
        </div>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------- offers

function OffersTab({ offers, run }: { offers: ContractView[]; run: Run }) {
  const { until } = useGameClock();
  const { cash } = useGame();
  if (offers.length === 0) return <Card><p className="muted">No open offers. Propose one from the supplier directory.</p></Card>;
  return (
    <section className="stack" style={{ gap: 12 }}>
      {offers.map((o) => {
        const needsBond = o.role === 'seller' && !o.proposedByMe;
        return (
          <Card key={o.id} style={{ gap: 12 }}>
            <div className="row-between" style={{ alignItems: 'flex-start' }}>
              <div className="stack-sm" style={{ gap: 4 }}>
                <span className="mono small muted">{o.proposedByMe ? 'You proposed' : `${o.counterpartyName} proposed`} · expires in {duration(Math.max(0, until(o.offerExpiresAt!)))}</span>
                <h2 className="h-section">{title(o)}</h2>
                <span className="muted" style={{ fontSize: 13 }}>
                  {dec(toCr(o.priceCents))} CR/unit · {o.windowHours}h window · {o.termDays} days · {o.deliveries.length || deliveryCount(o)} deliveries · {dec(toCr(o.qty * o.priceCents))} CR each
                </span>
              </div>
              <span className="chip" style={{ background: 'var(--info-wash)', color: 'var(--info-soft)' }}>{o.role === 'seller' ? 'You would sell' : 'You would buy'}</span>
            </div>
            <span className="small muted">
              Seller’s performance bond: {dec(toCr(o.bondCents))} CR, held until the contract ends.
              {needsBond && o.bondCents > cash * 100 ? ' You don’t have enough cash for it.' : ''}
            </span>
            <div className="row">
              {o.proposedByMe ? (
                <button type="button" className="btn btn-secondary" onClick={() => void run(() => api(`/contracts/${o.id}/reject`, { body: {} }), () => ['Offer withdrawn'])}>Withdraw</button>
              ) : (
                <>
                  <button type="button" className="btn btn-primary" onClick={() => void run(() => api(`/contracts/${o.id}/accept`, { body: {} }), () => ['Contract signed', needsBond ? 'Your bond is posted. Deliveries start in 1 game hour.' : 'Deliveries start in 1 game hour.'])}>
                    Accept{needsBond ? ` & post ${dec(toCr(o.bondCents))} bond` : ''}
                  </button>
                  <button type="button" className="btn btn-ghost" style={{ color: 'var(--loss)' }} onClick={() => void run(() => api(`/contracts/${o.id}/reject`, { body: {} }), () => ['Offer rejected'])}>Reject</button>
                </>
              )}
            </div>
          </Card>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------- RFQ board

function TermsFields({ value, onChange, priceLabel }: { value: ContractTerms; onChange: (t: ContractTerms) => void; priceLabel: string }) {
  const set = (patch: Partial<ContractTerms>) => onChange({ ...value, ...patch });
  const windows = CONTRACT_RULES.windows.filter((w) => w <= value.frequencyHours);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
      <label className="field">Product
        <select className="input" value={value.productId} onChange={(e) => set({ productId: e.target.value, priceCents: Math.round(productById(e.target.value).refPrice * 100) })}>
          {productOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="field">Units per delivery
        <input className="input mono" inputMode="numeric" value={value.qty} onChange={(e) => set({ qty: Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1) })} />
      </label>
      <label className="field">Min quality
        <select className="input" value={value.minQuality} onChange={(e) => set({ minQuality: Number(e.target.value) })}>
          {[0, 1, 2, 3, 4, 5].map((q) => <option key={q} value={q}>Q{q}+</option>)}
        </select>
      </label>
      <label className="field">{priceLabel}
        <input className="input mono" inputMode="decimal" value={(value.priceCents / 100).toFixed(2)} onChange={(e) => set({ priceCents: Math.round((Number(e.target.value) || 0) * 100) })} />
      </label>
      <label className="field">Frequency
        <select className="input" value={value.frequencyHours} onChange={(e) => { const f = Number(e.target.value); set({ frequencyHours: f, windowHours: Math.min(value.windowHours, f) }); }}>
          {CONTRACT_RULES.frequencies.map((f) => <option key={f} value={f}>{frequencyLabel(f)}</option>)}
        </select>
      </label>
      <label className="field">Delivery window
        <select className="input" value={value.windowHours} onChange={(e) => set({ windowHours: Number(e.target.value) })}>
          {windows.map((w) => <option key={w} value={w}>{w} hours</option>)}
        </select>
      </label>
      <label className="field">Term (days)
        <input className="input mono" inputMode="numeric" value={value.termDays} onChange={(e) => set({ termDays: Math.min(CONTRACT_RULES.maxTermDays, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1)) })} />
      </label>
    </div>
  );
}

const defaultTerms = (productId = 'flour'): ContractTerms => ({
  productId, qty: 100, minQuality: 0, priceCents: Math.round(productById(productId).refPrice * 100), frequencyHours: 24, windowHours: 24, termDays: 7,
});

function RfqTab({ board, run, devTools, onFastForward }: { board: RfqBoardResponse; run: Run; devTools: boolean; onFastForward: (h: number) => Promise<void> }) {
  const { until } = useGameClock();
  const [selId, setSelId] = useState<string | null>(null);
  const sel = board.open.find((r) => r.id === selId) ?? board.open[0];
  const [bidText, setBidText] = useState<Record<string, string>>({});
  const [posting, setPosting] = useState(false);
  const [draft, setDraft] = useState<ContractTerms>(defaultTerms());
  const [minRel, setMinRel] = useState(0);

  const bidValue = sel ? bidText[sel.id] ?? ((sel.myBidCents ?? Math.round(sel.maxPriceCents * 0.97)) / 100).toFixed(2) : '';
  const bidCents = Math.round(Number(bidValue) * 100);
  const bidOk = sel && Number.isFinite(bidCents) && bidCents > 0 && bidCents <= sel.maxPriceCents;
  const bidTerms = sel ? { productId: sel.productId, qty: sel.qty, minQuality: sel.minQuality, priceCents: bidOk ? bidCents : sel.maxPriceCents, frequencyHours: sel.frequencyHours, windowHours: sel.windowHours, termDays: sel.termDays } : null;

  return (
    <section className="stack" style={{ gap: 24 }}>
      <div className="split">
        <div className="main stack-sm" style={{ gap: 12 }} role="radiogroup" aria-label="Open requests">
          {board.open.length === 0 && <Card><p className="muted">No open requests from other companies right now.</p></Card>}
          {board.open.map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={r.id === sel?.id} className="option row-between" style={{ flexDirection: 'row', padding: '16px 18px', background: 'var(--panel)' }} onClick={() => setSelId(r.id)}>
              <span className="stack-sm" style={{ gap: 4 }}>
                <strong style={{ fontSize: 15 }}>{num(r.qty)} {productName(r.productId).toLowerCase()} Q{r.minQuality}+ · {frequencyLabel(r.frequencyHours)} for {r.termDays} days</strong>
                <span className="muted" style={{ fontSize: 13 }}>{r.buyerName} · {r.buyerRegion} · min reliability {r.minReliability} · {r.bids} sealed bid{r.bids === 1 ? '' : 's'}</span>
              </span>
              <span className="stack-sm" style={{ gap: 4, alignItems: 'flex-end' }}>
                <span className="mono" style={{ fontSize: 15 }}>≤ {dec(toCr(r.maxPriceCents))}</span>
                <span className="mono small muted">{r.myBidCents ? `your bid ${dec(toCr(r.myBidCents))}` : `closes in ${duration(Math.max(0, until(r.closesAt)))}`}</span>
              </span>
            </button>
          ))}
        </div>
        {sel && bidTerms && (
          <Card className="side" title="Sealed bid" style={{ alignSelf: 'flex-start' }}>
            <span>{num(sel.qty)} {productName(sel.productId).toLowerCase()} for {sel.buyerName}</span>
            <span className="muted" style={{ fontSize: 13 }}>Bids stay hidden until bidding closes ({RFQ_RULES.biddingHours}h). The buyer then picks one; the contract starts immediately.</span>
            <label className="field">
              Your unit price (CR)
              <input className="input mono" inputMode="decimal" value={bidValue} aria-invalid={!bidOk} onChange={(e) => setBidText({ ...bidText, [sel.id]: e.target.value })} />
              {!bidOk && <span className="loss small">Enter a price up to {dec(toCr(sel.maxPriceCents))} CR.</span>}
            </label>
            <div className="row-between" style={{ fontSize: 13 }}><span className="muted">Bond if you win</span><span className="mono">{dec(toCr(bondCents(bidTerms)))} CR</span></div>
            <div className="row-between" style={{ fontSize: 13 }}><span className="muted">Per delivery (after 1% fee)</span><span className="mono">{dec(toCr(sel.qty * (bidOk ? bidCents : 0) * 0.99))} CR</span></div>
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={!bidOk}
              onClick={() => void run(() => api(`/rfqs/${sel.id}/bids`, { body: { priceCents: bidCents } }), () => [sel.myBidCents ? 'Bid updated' : 'Bid sealed', 'You can change it until bidding closes.'])}
            >
              {sel.myBidCents ? 'Update sealed bid' : 'Submit sealed bid'}
            </button>
          </Card>
        )}
      </div>

      <Card
        title="Your requests"
        action={<button type="button" className="btn btn-secondary" onClick={() => setPosting((p) => !p)}>{posting ? 'Close' : 'Post a request'}</button>}
      >
        {posting && (
          <div className="inset stack" style={{ gap: 14 }}>
            <TermsFields value={draft} onChange={setDraft} priceLabel="Max unit price (CR)" />
            <label className="field" style={{ maxWidth: 220 }}>Min supplier reliability
              <input className="input mono" inputMode="numeric" value={minRel} onChange={(e) => setMinRel(Math.min(100, Number(e.target.value.replace(/[^\d.]/g, '')) || 0))} />
            </label>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  const res = await run(
                    () => api('/rfqs', { body: { productId: draft.productId, qty: draft.qty, minQuality: draft.minQuality, maxPriceCents: draft.priceCents, frequencyHours: draft.frequencyHours, windowHours: draft.windowHours, termDays: draft.termDays, minReliability: minRel } }),
                    () => ['Request posted', `Sellers have ${RFQ_RULES.biddingHours} game hours to bid.`],
                  );
                  if (res) setPosting(false);
                }}
              >
                Post request
              </button>
              <span className="small muted">{deliveryCount(draft)} deliveries · up to {dec(toCr(draft.qty * draft.priceCents))} CR each. Escrow is taken from your cash as each window opens.</span>
            </div>
          </div>
        )}
        {board.mine.length === 0 && !posting && <p className="muted">You haven’t posted any requests.</p>}
        {board.mine.map((r) => (
          <div key={r.id} className="inset stack-sm" style={{ gap: 10 }}>
            <div className="row-between">
              <strong>{num(r.qty)} {productName(r.productId).toLowerCase()} Q{r.minQuality}+ · {frequencyLabel(r.frequencyHours)} · {r.termDays} days · ≤ {dec(toCr(r.maxPriceCents))}</strong>
              <span className="small muted">{r.status === 'open' ? (r.sealed ? `${r.bids} sealed bid${r.bids === 1 ? '' : 's'} · closes in ${duration(Math.max(0, until(r.closesAt)))}` : 'Bidding closed · choose a bid') : r.status}</span>
            </div>
            {r.status === 'open' && !r.sealed && r.bidList.length === 0 && <span className="small muted">No bids came in.</span>}
            {r.status === 'open' && !r.sealed && r.bidList.map((b) => (
              <div key={b.id} className="list-row">
                <span style={{ flex: 1 }}>{b.sellerName}</span>
                <span className="mono small muted">reliability {b.reliability.toFixed(1)}</span>
                <span className="mono">{dec(toCr(b.priceCents))}</span>
                <button type="button" className="btn btn-primary" style={{ height: 36 }} onClick={() => void run(() => api(`/rfqs/${r.id}/award`, { body: { bidId: b.id } }), () => ['Contract awarded', `${b.sellerName} posted their bond. Deliveries start in 1 game hour.`])}>Award</button>
              </div>
            ))}
            {r.status === 'open' && (
              <div className="row">
                <button type="button" className="btn btn-ghost" style={{ color: 'var(--loss)', height: 36 }} onClick={() => void run(() => api(`/rfqs/${r.id}/cancel`, { body: {} }), () => ['Request cancelled'])}>Cancel request</button>
                {devTools && r.sealed && <button type="button" className="btn btn-ghost" style={{ height: 36 }} onClick={() => void onFastForward(RFQ_RULES.biddingHours)}>Close bidding now (dev)</button>}
              </div>
            )}
          </div>
        ))}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------- suppliers

function SuppliersTab({ run, goToOffers }: { run: Run; goToOffers: () => void }) {
  const [productId, setProductId] = useState('iron_ore');
  const [list, setList] = useState<Supplier[] | null>(null);
  const [proposeTo, setProposeTo] = useState<Supplier | null>(null);
  const [draft, setDraft] = useState<ContractTerms>(defaultTerms('iron_ore'));

  useEffect(() => {
    setList(null);
    void api<{ suppliers: Supplier[] }>(`/suppliers?productId=${productId}`).then((r) => setList(r.suppliers)).catch(() => setList([]));
  }, [productId]);

  const pickProduct = (id: string) => {
    setProductId(id);
    setProposeTo(null);
    setDraft(defaultTerms(id));
  };

  const bond = useMemo(() => bondCents(draft), [draft]);

  return (
    <section className="stack" style={{ gap: 24 }}>
      <Card
        title={`Supplier directory · ${productName(productId).toLowerCase()}`}
        action={
          <label className="row small muted" style={{ gap: 8 }}>Product
            <select className="input" style={{ width: 200, height: 40 }} value={productId} onChange={(e) => pickProduct(e.target.value)}>
              {productOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        }
      >
        <span className="small muted">Reliability counts value delivered on time, against a 50,000 CR prior at 80. It is “verified” after deliveries to 3 different buyers.</span>
        <div className="scroll-x">
          <table className="table" style={{ minWidth: 680, fontSize: 14 }}>
            <thead><tr><th>Company</th><th>Region</th><th>Quality</th><th className="num">Best ask</th><th className="num">Reliability</th><th /></tr></thead>
            <tbody>
              {list === null && <tr><td colSpan={6} className="muted">Loading…</td></tr>}
              {list?.length === 0 && <tr><td colSpan={6} className="muted">Nobody is offering this product right now.</td></tr>}
              {list?.map((s) => (
                <tr key={s.companyId}>
                  <td>{s.name} {s.isNpc && <span className="chip" style={{ background: 'var(--line)', color: 'var(--text-soft)' }}>NPC</span>}</td>
                  <td style={{ textTransform: 'capitalize' }}>{s.region}</td>
                  <td className="mono">{s.qualityRange ?? '—'}</td>
                  <td className="num">{s.askCents ? dec(toCr(s.askCents)) : '—'}</td>
                  <td className={`num ${s.reliability >= 90 ? 'gain' : ''}`}>{s.reliability.toFixed(1)}{s.verified ? '' : ' prior'}</td>
                  <td className="num">
                    <button type="button" className="btn btn-ghost" style={{ height: 36 }} onClick={() => { setProposeTo(s); setDraft({ ...defaultTerms(productId), priceCents: s.askCents ?? draft.priceCents }); }}>
                      Propose
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {proposeTo && (
        <Card title={`Propose a supply contract to ${proposeTo.name}`}>
          <TermsFields value={draft} onChange={setDraft} priceLabel="Unit price (CR)" />
          <span className="small muted">
            You buy {num(draft.qty)} {productName(draft.productId).toLowerCase()} {frequencyLabel(draft.frequencyHours)} for {draft.termDays} days: {deliveryCount(draft)} deliveries of {dec(toCr(draft.qty * draft.priceCents))} CR.
            The seller posts a {dec(toCr(bond))} CR bond when accepting. {proposeTo.isNpc ? 'NPC companies answer within a game hour and accept fair prices.' : ''}
          </span>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                const res = await run(() => api('/contracts', { body: { counterpartyId: proposeTo.companyId, role: 'buy', terms: draft } }), () => ['Offer sent', `${proposeTo.name} has 48 game hours to answer.`]);
                if (res) { setProposeTo(null); goToOffers(); }
              }}
            >
              Send offer
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setProposeTo(null)}>Cancel</button>
          </div>
        </Card>
      )}
    </section>
  );
}
