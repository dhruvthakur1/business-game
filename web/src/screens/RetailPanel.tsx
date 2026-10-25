import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, toCr } from '../api/client';
import type { RetailResponse } from '../api/types';
import { Card, Stepper } from '../components/ui';
import { productById } from '../data/catalog';
import { dec, num } from '../lib/format';
import { useGame } from '../state/game';
import { bestSupermarketMarkup, supermarketUnits } from '../../../shared/retail';

const lotKey = (l: { productId: string; quality: number }) => `${l.productId}:${l.quality}`;

/** Shelf settings (Supermarket) or listings (Luxury Store) for a retail building page. */
export function RetailPanel({ buildingId, typeId, idle }: { buildingId: string; typeId: 'supermarket' | 'luxury_store'; idle: boolean }) {
  const { act, notify, startJob, me } = useGame();
  const [data, setData] = useState<RetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<RetailResponse>(`/buildings/${buildingId}/retail`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else throw err;
    }
  }, [buildingId]);
  // Reload when the company state changes (collects, restarts, sales).
  useEffect(() => { void load(); }, [load, me?.serverTime]);

  const run = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    const res = await act(fn);
    await load();
    setBusy(false);
    return res;
  };

  if (!data) return <Card title={typeId === 'supermarket' ? 'Shelf' : 'Listings'}><p className={error ? 'loss' : 'muted'}>{error ?? 'Loading…'}</p></Card>;

  if (data.kind === 'supermarket') {
    const shelfKey = data.shelf ? lotKey(data.shelf) : null;
    const options = [...data.lots];
    if (data.shelf && !options.some((l) => lotKey(l) === shelfKey)) options.unshift({ ...data.shelf, qty: 0 });
    const selKey = pick ?? shelfKey ?? (options[0] ? lotKey(options[0]) : null);
    const lot = options.find((l) => lotKey(l) === selKey);
    if (!lot) {
      return (
        <Card title="Shelf">
          <span className="muted">No food in the warehouse. Supermarkets sell bread and bread designs. <Link to="/app/market?product=bread">Buy bread</Link> or bake some.</span>
        </Card>
      );
    }
    const band = lot.band;
    const suggested = Math.floor(band.minCents * (1 + bestSupermarketMarkup(lot.quality)));
    const isShelf = selKey === shelfKey;
    const value = Math.max(band.minCents, Math.min(band.maxCents, price ?? (isShelf && data.shelf ? data.shelf.priceCents : suggested)));
    const step = Math.max(1, Math.round(band.minCents * 0.02));
    const stock = Math.min(data.capacity, lot.qty);
    const units = supermarketUnits(data.capacity, stock, value, band.minCents, lot.quality);
    const revenue = units * value;
    const changed = !isShelf || value !== data.shelf?.priceCents;
    const name = productById(lot.productId).name;

    const save = async () => {
      const res = await run(() => api(`/buildings/${buildingId}/shelf`, { body: { productId: lot.productId, quality: lot.quality, priceCents: value } }));
      if (res) {
        setPick(null);
        setPrice(null);
        notify('Shelf set', `${name} Q${lot.quality} at ${dec(toCr(value))} CR. Applies from the next cycle.`);
      }
    };

    return (
      <Card title="Shelf" action={<span className="small muted">Up to {num(data.capacity)} units a cycle</span>}>
        <div className="grid-auto-sm" role="radiogroup" aria-label="Product to sell">
          {options.map((l) => (
            <button key={lotKey(l)} type="button" role="radio" aria-checked={lotKey(l) === selKey} className="option" onClick={() => { setPick(lotKey(l)); setPrice(null); }}>
              <strong>{productById(l.productId).name} · Q{l.quality}</strong>
              <span className="mono small muted">{num(l.qty)} in stock{lotKey(l) === shelfKey ? ' · on the shelf' : ''}</span>
            </button>
          ))}
        </div>
        <div className="field">
          Shelf price <span className="small muted">({dec(toCr(band.minCents))}–{dec(toCr(band.maxCents))} CR: reference × quality, up to +35%)</span>
          <Stepper
            value={`${dec(toCr(value))} CR`}
            decLabel="Lower price"
            incLabel="Raise price"
            onDec={() => setPrice(Math.max(band.minCents, value - step))}
            onInc={() => setPrice(Math.min(band.maxCents, value + step))}
          />
        </div>
        <div className="grid-auto-sm">
          <div className="inset stack-sm">
            <span className="small muted">Expected sales / cycle</span>
            <span className="stat-value sm">{num(units)} <span className="muted" style={{ fontSize: 14 }}>of {num(stock)}</span></span>
            <span className="small muted">Higher markup sells fewer; quality sells more</span>
          </div>
          <div className="inset stack-sm">
            <span className="small muted">Revenue / cycle</span>
            <span className="stat-value sm">{num(toCr(revenue))} CR</span>
            <span className="small muted">Op cost {num(toCr(data.opCostCents))} CR · unsold stock comes back</span>
          </div>
        </div>
        <span className="small muted">Best price for a full shelf at Q{lot.quality}: {dec(toCr(suggested))} CR (+{Math.round(bestSupermarketMarkup(lot.quality) * 100)}%).</span>
        <div className="row">
          <button type="button" className="btn btn-secondary" disabled={busy || !changed} onClick={() => void save()}>{changed ? 'Save shelf' : 'Shelf saved'}</button>
          {idle && data.shelf && !changed && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => startJob(buildingId))}>Stock shelf &amp; start cycle</button>
          )}
        </div>
        {data.recent.length > 0 && (
          <div className="stack-sm" style={{ gap: 4 }}>
            <span className="overline">Recent cycles</span>
            {data.recent.map((r, i) => (
              <div key={i} className="row-between small">
                <span className="muted">{num(r.sold)} / {num(r.stocked)} {productById(r.productId).name.toLowerCase()} at {dec(toCr(r.priceCents))}</span>
                <span className="mono gain">+{dec(toCr(r.proceedsCents))}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    );
  }

  // ---------- Luxury Store ----------
  const room = data.capacity - data.listed;
  const selKey = pick ?? (data.lots[0] ? lotKey(data.lots[0]) : null);
  const lot = data.lots.find((l) => lotKey(l) === selKey);
  const value = lot ? Math.max(lot.band.minCents, Math.min(lot.band.maxCents, price ?? Math.round(lot.band.minCents * 1.25))) : 0;
  const step = lot ? Math.max(100, Math.round(lot.band.minCents * 0.05)) : 0;
  const maxQty = lot ? Math.min(room, lot.qty) : 0;
  const listQty = Math.max(1, Math.min(maxQty, qty));

  const list = async () => {
    if (!lot) return;
    const res = await run(() => api(`/buildings/${buildingId}/listings`, { body: { productId: lot.productId, quality: lot.quality, qty: listQty, priceCents: value } }));
    if (res) {
      setPrice(null);
      setQty(1);
      notify('Listed', `${num(listQty)} ${productById(lot.productId).name.toLowerCase()} at ${dec(toCr(value))} CR each.`);
    }
  };
  const withdraw = async (id: string) => {
    const res = await run(() => api<{ returnedQty: number }>(`/listings/${id}`, { method: 'DELETE' }));
    if (res) notify('Listing withdrawn', `${num(res.returnedQty)} back in the warehouse.`, 'info');
  };

  return (
    <Card title="Listings" action={<span className="small muted">{num(data.listed)} / {num(data.capacity)} units listed</span>}>
      {data.listings.length === 0 && <span className="muted">Nothing listed yet.</span>}
      {data.listings.map((l) => (
        <div key={l.id} className="row-between">
          <span>{productById(l.productId).name} · Q{l.quality} <span className="mono muted">× {num(l.qty)}</span></span>
          <span className="row" style={{ gap: 12 }}>
            <span className="mono">{dec(toCr(l.priceCents))} CR</span>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void withdraw(l.id)}>Withdraw</button>
          </span>
        </div>
      ))}

      {lot ? (
        <div className="inset stack-sm">
          <span className="small muted">List T7 goods from your warehouse</span>
          <div className="grid-auto-sm" role="radiogroup" aria-label="Product to list">
            {data.lots.map((l) => (
              <button key={lotKey(l)} type="button" role="radio" aria-checked={lotKey(l) === selKey} className="option" onClick={() => { setPick(lotKey(l)); setPrice(null); setQty(1); }}>
                <strong>{productById(l.productId).name} · Q{l.quality}</strong>
                <span className="mono small muted">{num(l.qty)} in stock</span>
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 16 }}>
            <div className="field">
              Price each <span className="small muted">(1.2×–3× wholesale)</span>
              <Stepper value={`${num(toCr(value))} CR`} decLabel="Lower price" incLabel="Raise price" onDec={() => setPrice(Math.max(lot.band.minCents, value - step))} onInc={() => setPrice(Math.min(lot.band.maxCents, value + step))} />
            </div>
            <div className="field">
              Units
              <Stepper value={num(listQty)} decLabel="Fewer" incLabel="More" onDec={() => setQty(Math.max(1, listQty - 1))} onInc={() => setQty(Math.min(maxQty, listQty + 1))} />
            </div>
          </div>
          <span className="small muted">Buyers pay from their personal wallets; you receive the price minus a 2% store fee.</span>
          <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={busy || maxQty <= 0} onClick={() => void list()}>
            {maxQty <= 0 ? 'Store is full' : `List ${num(listQty)} at ${num(toCr(value))} CR`}
          </button>
        </div>
      ) : (
        <span className="small muted">No T7 goods in the warehouse. Luxury watches come from a Watchmaker.</span>
      )}

      {data.recent.length > 0 && (
        <div className="stack-sm" style={{ gap: 4 }}>
          <span className="overline">Recent sales</span>
          {data.recent.map((r, i) => (
            <div key={i} className="row-between small">
              <span className="muted">{productById(r.productId).name} to {r.buyerName}</span>
              <span className="mono gain">+{dec(toCr(r.priceCents))}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
