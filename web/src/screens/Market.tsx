import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, toCr } from '../api/client';
import type { MarketDetail, MarketRow, OpenOrder } from '../api/types';
import { TopBar } from '../components/AppShell';
import { Card, Segmented, Stepper, TierChip, tierSwatch } from '../components/ui';
import { productById } from '../data/catalog';
import type { TierCode } from '../data/types';
import { SELLER_FEE } from '../lib/economy';
import { dec, num, trend } from '../lib/format';
import { useGame } from '../state/game';
import { PRICE_BAND } from '../../../shared/catalog';

const REFRESH_MS = 5000;

function Sparkline({ points, refPrice }: { points: number[]; refPrice: number }) {
  if (points.length < 2) return null;
  const min = Math.min(...points, refPrice) * 0.995;
  const max = Math.max(...points, refPrice) * 1.005;
  const x = (i: number) => (i / (points.length - 1)) * 600;
  const y = (v: number) => 190 - ((v - min) / (max - min || 1)) * 170;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join(' ');
  const up = points[points.length - 1] >= points[0];
  return (
    <svg viewBox="0 0 600 200" preserveAspectRatio="none" role="img" aria-label={`Seven-day closing prices, trend ${up ? 'up' : 'down'}`} style={{ width: '100%', height: 200, display: 'block' }}>
      <path d="M0 50 H600 M0 100 H600 M0 150 H600" stroke="var(--line-soft)" strokeWidth="1" />
      <path d={`${line} L600 200 L0 200 Z`} fill="var(--info)" opacity="0.12" />
      <path d={line} stroke="var(--info)" strokeWidth="2.5" fill="none" vectorEffect="non-scaling-stroke" />
      <path d={`M0 ${y(refPrice)} H600`} stroke="var(--gold)" strokeWidth="1" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Market() {
  const { cash, inventory, placeOrder, cancelOrder, npcBuy, npcSell } = useGame();
  const [rows, setRows] = useState<MarketRow[]>([]);
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [selId, setSelId] = useState('flour');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState(100);
  const [priceText, setPriceText] = useState('');
  const [quality, setQuality] = useState(0);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, d, o] = await Promise.all([
        api<{ products: MarketRow[] }>('/market'),
        api<MarketDetail>(`/market/${selId}`),
        api<{ orders: OpenOrder[] }>('/orders'),
      ]);
      setRows(m.products);
      setDetail(d);
      setOrders(o.orders);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
  }, [selId]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const sel = rows.find((r) => r.productId === selId);
  const product = productById(selId);
  const ref = sel ? toCr(sel.refPriceCents) : product.refPrice;

  // Default the limit price to the best opposite quote, else the reference.
  useEffect(() => {
    if (!sel) return;
    const touch = side === 'buy' ? sel.bestAskCents : sel.bestBidCents;
    setPriceText(dec(toCr(touch ?? sel.refPriceCents)).replace(/,/g, ''));
  }, [selId, side, sel?.bestAskCents, sel?.bestBidCents, sel?.refPriceCents]); // eslint-disable-line react-hooks/exhaustive-deps

  const myLots = inventory.filter((l) => l.productId === selId);
  useEffect(() => {
    if (side === 'sell' && myLots.length && !myLots.some((l) => l.quality === quality)) setQuality(myLots[myLots.length - 1].quality);
  }, [side, selId]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => rows.filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase())), [rows, query]);

  const price = Number(priceText);
  const priceCents = Math.round(price * 100);
  const minP = Math.ceil(ref * 100 * PRICE_BAND.min) / 100;
  const maxP = Math.floor(ref * 100 * PRICE_BAND.max) / 100;
  const priceOk = Number.isFinite(price) && price >= minP && price <= maxP;
  const subtotal = qty * (priceOk ? price : 0);
  const fee = side === 'sell' ? subtotal * SELLER_FEE : 0;
  const lotQty = myLots.find((l) => l.quality === quality)?.qty ?? 0;
  const problem = !priceOk
    ? `Price must be ${dec(minP)}–${dec(maxP)}`
    : side === 'buy' && subtotal > cash
      ? 'Not enough cash'
      : side === 'sell' && qty > lotQty
        ? `You have ${num(lotQty)} at Q${quality}`
        : null;

  const submit = async () => {
    setBusy(true);
    await placeOrder({ productId: selId, side, qty, priceCents, quality });
    await load();
    setBusy(false);
  };

  const maxBook = Math.max(1, ...(detail?.book.bids ?? []).map((b) => b.qty), ...(detail?.book.asks ?? []).map((a) => a.qty));

  return (
    <>
      <TopBar title="Exchange" subtitle="Live order book · price-time priority · 2% seller fee · 0.5×–2× reference" />
      <section className="split">
        <Card style={{ flex: '1 1 240px', padding: 16, gap: 12 }}>
          <label className="field">
            Search products
            <input className="input" placeholder="e.g. steel" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="stack-sm" style={{ gap: 2, maxHeight: 640, overflowY: 'auto' }}>
            {list.map((m) => {
              const p = productById(m.productId);
              return (
                <button
                  key={m.productId}
                  type="button"
                  aria-pressed={m.productId === selId}
                  onClick={() => setSelId(m.productId)}
                  className="row"
                  style={{ minHeight: 48, padding: '0 10px', border: 0, borderRadius: 10, background: m.productId === selId ? '#1e2530' : 'transparent', flexWrap: 'nowrap', textAlign: 'left' }}
                >
                  {p.art ? <img src={p.art} alt="" width={28} height={28} /> : <span className="swatch" style={{ background: tierSwatch(p.tier), margin: '0 9px' }} />}
                  <span style={{ flex: 1, fontWeight: 500 }}>{m.name}</span>
                  <span className="stack-sm" style={{ gap: 2, alignItems: 'flex-end' }}>
                    <span className="mono">{dec(toCr(m.lastPriceCents))}</span>
                    <span className={`mono small ${m.change24h >= 0 ? 'gain' : 'loss'}`}>{trend(m.change24h)}</span>
                  </span>
                </button>
              );
            })}
            {list.length === 0 && <span className="muted small" style={{ padding: 10 }}>{rows.length ? `No products match “${query}”.` : 'Loading market…'}</span>}
          </div>
        </Card>

        <div className="stack" style={{ flex: '3 1 480px', minWidth: 0, gap: 24 }}>
          <Card>
            <div className="row-between" style={{ alignItems: 'flex-end' }}>
              <div className="row" style={{ gap: 16, flexWrap: 'nowrap' }}>
                {product.art && <img src={product.art} alt="" width={64} height={64} />}
                <div className="stack-sm" style={{ gap: 4 }}>
                  <span className="row muted" style={{ fontSize: 13, gap: 8 }}>{product.name} <TierChip tier={product.tier as TierCode} /> per {product.unit ?? 'unit'}</span>
                  <div className="row" style={{ alignItems: 'baseline' }}>
                    <span className="mono" style={{ fontSize: 36, fontWeight: 600 }}>{sel ? dec(toCr(sel.lastPriceCents)) : '—'}</span>
                    {sel && <span className={`mono ${sel.change24h >= 0 ? 'gain' : 'loss'}`}>{trend(sel.change24h)} · 1 game day</span>}
                  </div>
                </div>
              </div>
              <div className="row mono small muted" style={{ gap: 20 }}>
                <span className="stack-sm" style={{ gap: 2 }}>Reference<strong style={{ color: 'var(--text)', fontSize: 14 }}>{dec(ref)}</strong></span>
                <span className="stack-sm" style={{ gap: 2 }}>Volume<strong style={{ color: 'var(--text)', fontSize: 14 }}>{num(sel?.volume24h ?? 0)}</strong></span>
              </div>
            </div>
            {detail && <Sparkline points={detail.history.map(toCr)} refPrice={ref} />}
            <div className="row-between mono small muted"><span>7 game days ago</span><span>today</span><span className="goldtx">- - reference</span></div>
          </Card>

          <Card title="Order book">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 20 }}>
              <div className="stack-sm" style={{ gap: 4 }}>
                <div className="row-between small muted" style={{ padding: '0 8px' }}><span>Bid qty · min Q</span><span>Price</span></div>
                {(detail?.book.bids ?? []).map((b) => (
                  <div key={`${b.priceCents}-${b.quality}`} className="row-between mono" style={{ padding: 8, borderRadius: 6, flexWrap: 'nowrap', background: `linear-gradient(to left, var(--gain-wash) ${(b.qty / maxBook) * 100}%, transparent ${(b.qty / maxBook) * 100}%)` }}>
                    <span>{num(b.qty)} · Q{b.quality}+</span><span className="gain">{dec(toCr(b.priceCents))}</span>
                  </div>
                ))}
                {detail && detail.book.bids.length === 0 && <span className="small muted" style={{ padding: 8 }}>No bids</span>}
              </div>
              <div className="stack-sm" style={{ gap: 4 }}>
                <div className="row-between small muted" style={{ padding: '0 8px' }}><span>Price</span><span>Ask qty · Q</span></div>
                {(detail?.book.asks ?? []).map((a) => (
                  <div key={`${a.priceCents}-${a.quality}`} className="row-between mono" style={{ padding: 8, borderRadius: 6, flexWrap: 'nowrap', background: `linear-gradient(to right, var(--loss-wash) ${(a.qty / maxBook) * 100}%, transparent ${(a.qty / maxBook) * 100}%)` }}>
                    <span className="loss">{dec(toCr(a.priceCents))}</span><span>{num(a.qty)} · Q{a.quality}</span>
                  </div>
                ))}
                {detail && detail.book.asks.length === 0 && <span className="small muted" style={{ padding: 8 }}>No asks</span>}
              </div>
            </div>
          </Card>

          <Card title="Your open orders" action={<span className="mono muted">{orders.length}</span>} style={{ gap: 4 }}>
            {orders.length === 0 && <p className="muted">None. Orders that don’t fill right away rest here until filled or cancelled.</p>}
            {orders.map((o) => (
              <div key={o.id} className="list-row">
                <span className={`chip ${o.side === 'buy' ? 'gain' : 'loss'}`} style={{ background: o.side === 'buy' ? 'var(--gain-wash)' : 'var(--loss-wash)' }}>{o.side}</span>
                <span style={{ flex: 1 }}>{productById(o.productId).name} · {o.side === 'buy' ? `Q${o.quality}+` : `Q${o.quality}`}</span>
                <span className="mono">{num(o.remaining)}/{num(o.qty)} @ {dec(toCr(o.priceCents))}</span>
                <button type="button" className="btn btn-ghost" style={{ height: 36 }} onClick={() => void cancelOrder(o.id).then(load)}>Cancel</button>
              </div>
            ))}
          </Card>
        </div>

        <div className="stack" style={{ flex: '1 1 300px', gap: 24 }}>
          <Card>
            <Segmented label="Order side" boxed value={side} onChange={setSide} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }} />
            <div className="field">
              Quantity
              <Stepper value={num(qty)} decLabel="Decrease quantity by 50" incLabel="Increase quantity by 50" onDec={() => setQty((q) => Math.max(1, q - 50))} onInc={() => setQty((q) => q + 50)} />
            </div>
            <label className="field">
              Limit price (CR)
              <input className="input mono" inputMode="decimal" value={priceText} aria-invalid={!priceOk} onChange={(e) => setPriceText(e.target.value)} />
              <span className="small">Allowed {dec(minP)} – {dec(maxP)} (0.5×–2× reference)</span>
            </label>
            <div className="field">
              {side === 'buy' ? 'Minimum quality' : 'Quality to sell'}
              <div className="row" style={{ gap: 6 }}>
                {[0, 1, 2, 3, 4, 5].map((q) => {
                  const owned = myLots.find((l) => l.quality === q)?.qty ?? 0;
                  const disabled = side === 'sell' && owned === 0;
                  return (
                    <button key={q} type="button" aria-pressed={q === quality} disabled={disabled} className="option" style={{ minWidth: 44, padding: '0 10px', alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1 }} onClick={() => setQuality(q)}>
                      Q{q}
                    </button>
                  );
                })}
              </div>
              {side === 'sell' && <span className="small">In warehouse: {myLots.length ? myLots.map((l) => `Q${l.quality} ${num(l.qty)}`).join(' · ') : 'none'}</span>}
            </div>
            <div className="stack-sm mono" style={{ borderTop: '1px solid var(--line)', paddingTop: 14, gap: 8 }}>
              <div className="row-between"><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>{side === 'buy' ? 'Locked in escrow (max)' : 'Gross at limit'}</span><span>{dec(subtotal)}</span></div>
              {side === 'sell' && <div className="row-between"><span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Seller fee 2%</span><span>−{dec(fee)}</span></div>}
              <div className="row-between" style={{ fontSize: 16, fontWeight: 600 }}><span style={{ fontFamily: 'var(--font-ui)' }}>{side === 'buy' ? 'You pay at most' : 'You receive at least'}</span><span className="goldtx">{dec(subtotal - fee)} CR</span></div>
            </div>
            <button type="button" className={`btn btn-lg ${side === 'buy' ? 'btn-buy' : 'btn-sell'}`} disabled={!!problem || busy} onClick={() => void submit()}>
              {problem ?? (side === 'buy' ? 'Place buy order' : 'Place sell order')}
            </button>
            <span className="small muted">Fills happen at the resting order’s price; any better price is refunded from escrow.</span>
          </Card>

          <NpcPanel
            productId={selId}
            npcVendor={sel?.npcVendor ?? !!product.npcVendor}
            refPrice={ref}
            lots={myLots}
            onBuy={(n) => npcBuy(selId, n).then(load)}
            onSell={(n, q) => npcSell(selId, n, q).then(load)}
          />
        </div>
      </section>
    </>
  );
}

function NpcPanel(props: {
  productId: string;
  npcVendor: boolean;
  refPrice: number;
  lots: { quality: number; qty: number }[];
  onBuy: (qty: number) => Promise<void>;
  onSell: (qty: number, quality: number) => Promise<void>;
}) {
  const [qty, setQty] = useState(100);
  const [busy, setBusy] = useState(false);
  const p = productById(props.productId);
  const best = props.lots[props.lots.length - 1];
  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  return (
    <Card title={props.npcVendor ? 'NPC vendor' : 'NPC buyers'}>
      <span className="muted" style={{ fontSize: 13 }}>
        {props.npcVendor
          ? `Always sells ${p.name.toLowerCase()} at the reference price (${dec(props.refPrice)}). Money paid here leaves the economy.`
          : `Pay reference × quality bonus, falling to 90/80/70% as you sell more per game day.`}
      </span>
      <Stepper value={num(qty)} decLabel="Decrease by 50" incLabel="Increase by 50" onDec={() => setQty((q) => Math.max(1, q - 50))} onInc={() => setQty((q) => q + 50)} />
      {props.npcVendor ? (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void go(() => props.onBuy(qty))}>Buy {num(qty)} for {dec(qty * props.refPrice)} CR</button>
      ) : (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !best || best.qty < qty}
          onClick={() => void go(() => props.onSell(qty, best.quality))}
        >
          {best ? `Sell ${num(qty)} Q${best.quality} to NPCs` : `No ${p.name.toLowerCase()} to sell`}
        </button>
      )}
    </Card>
  );
}
