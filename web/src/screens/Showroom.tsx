import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, toCr } from '../api/client';
import type { PayoutKind, StoreListing, WealthResponse } from '../api/types';
import { productById } from '../data/catalog';
import { TopBar } from '../components/AppShell';
import { Card, ProgressBar, Segmented, StatTile, Stepper } from '../components/ui';
import { personalIncomeTax } from '../lib/economy';
import { dec, num } from '../lib/format';
import { useGame } from '../state/game';
import { CATEGORY_RULES, itemUpkeep, LADDERS, PAY_RULES, TAX_FREE_ALLOWANCE, type LuxuryItem } from '../../../shared/wealth';

const REFRESH_MS = 10_000;

const priceLabel = (i: LuxuryItem) => (i.price === null ? 'auction only' : i.price === 0 ? 'free' : `${num(i.price)} CR`);

/** Tax (CR) on a new gross payout given what was already paid out in the 30-day window. Mirrors server/src/wealth.ts. */
function taxOn(priorCr: number, grossCr: number, kind: PayoutKind) {
  const income = personalIncomeTax(priorCr + grossCr) - personalIncomeTax(priorCr);
  return Math.min(grossCr, income + (kind === 'withdrawal' ? grossCr * PAY_RULES.withdrawalTax : 0));
}

const TROPHY_TONE: Record<string, [string, string]> = {
  promotion: ['var(--silver-bg)', 'var(--silver-fg)'],
  contest: ['var(--t1-bg)', 'var(--t1-fg)'],
  relegation: ['var(--line)', 'var(--text-soft)'],
};

export function Showroom() {
  const { act, notify } = useGame();
  const [data, setData] = useState<WealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ladderId, setLadderId] = useState(LADDERS[0].id);
  const [payKind, setPayKind] = useState<'dividend' | 'withdrawal'>('dividend');
  const [amount, setAmount] = useState<number | null>(null);
  const [salary, setSalary] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [listings, setListings] = useState<StoreListing[]>([]);

  const load = useCallback(async () => {
    try {
      const [wealth, stores] = await Promise.all([api<WealthResponse>('/wealth'), api<{ listings: StoreListing[] }>('/stores')]);
      setData(wealth);
      setListings(stores.listings);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else throw err;
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const run = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    const res = await act(fn);
    await load();
    setBusy(false);
    return res;
  };

  if (!data) {
    return (
      <>
        <TopBar title="Showroom" subtitle="Your personal wealth, kept apart from the company" />
        <p className={error ? 'loss' : 'muted'}>{error ?? 'Loading your wallet…'}</p>
      </>
    );
  }

  const wallet = toCr(data.walletCents);
  const owned = new Map(data.owned.map((o) => [o.itemId, o]));
  const ladder = LADDERS.find((l) => l.id === ladderId)!;
  const nextIdx = ladder.items.findIndex((i) => !owned.has(i.id));
  const next = nextIdx >= 0 ? ladder.items[nextIdx] : null;
  const { limits } = data;
  const cap = toCr(limits.salaryCapCents);
  // What actually reaches the wallet each day: the salary setting, capped by today's profit-based limit.
  const dailyDraw = limits.blocked ? 0 : Math.min(toCr(data.salaryCents), cap);
  const prior = toCr(data.inflows30dCents);

  const maxPay = toCr(payKind === 'dividend' ? limits.dividendAvailableCents : limits.withdrawableCents);
  const payAmount = Math.max(0, Math.min(maxPay, amount ?? Math.floor(maxPay)));
  const payStep = Math.max(100, Math.round(maxPay / 10 / 100) * 100);
  const payTax = taxOn(prior, payAmount, payKind);

  const salaryValue = salary ?? toCr(data.salaryCents);
  const salaryStep = Math.max(10, Math.round(cap / 10 / 10) * 10);
  const salaryChanged = Math.round(salaryValue * 100) !== data.salaryCents;

  const buy = async (item: LuxuryItem) => {
    const res = await run(() => api('/wealth/items', { body: { itemId: item.id } }));
    if (res) notify(`${item.name} is yours`, 'Shown in your showroom and on your profile.');
  };
  const sell = async (item: LuxuryItem) => {
    const res = await run(() => api<{ proceedsCents: number }>(`/wealth/items/${item.id}/sell`, { body: {} }));
    if (res) notify(`Sold ${item.name}`, `${dec(toCr(res.proceedsCents))} CR back in your wallet.`, 'info');
  };
  const pay = async () => {
    const res = await run(() => api<{ netCents: number; taxCents: number }>(`/wealth/${payKind === 'dividend' ? 'dividend' : 'withdraw'}`, { body: { amountCents: Math.round(payAmount * 100) } }));
    if (res) {
      setAmount(null);
      notify(payKind === 'dividend' ? 'Dividend paid' : 'Withdrawal made', `${dec(toCr(res.netCents))} CR reached your wallet after ${dec(toCr(res.taxCents))} CR tax.`);
    }
  };
  const buyFromStore = async (l: StoreListing) => {
    const res = await run(() => api(`/stores/${l.id}/buy`, { body: {} }));
    if (res) notify(`${productById(l.productId).name} is yours`, `Bought from ${l.sellerName} for ${num(toCr(l.priceCents))} CR.`);
  };
  const storePieces = data.owned.filter((o) => o.productId);

  const saveSalary = async () => {
    const res = await run(() => api('/wealth/salary', { body: { salaryCents: Math.round(salaryValue * 100) } }));
    if (res) {
      setSalary(null);
      notify('Salary set', salaryValue > 0 ? `${num(salaryValue)} CR a day, paid at each daily close.` : 'You are no longer paying yourself a salary.', 'info');
    }
  };

  return (
    <>
      <TopBar title="Showroom" subtitle="Your personal wealth, kept apart from the company" />
      <section className="grid-auto">
        <StatTile label="Personal wallet" value={num(wallet)} valueClass="goldtx" deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Protected if the company goes into receivership</span>} />
        <StatTile label="Prestige score" value={num(data.prestige)} deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Log-scaled, so a curated set beats one huge buy · +100 per trophy</span>} />
        <StatTile label="Daily upkeep on items" value={dec(toCr(data.upkeepPerDayCents))} deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Paid from the wallet · unpaid upkeep stores an item, never seizes it</span>} />
      </section>

      <section className="split">
        <Card className="main" style={{ gap: 18 }}>
          <Segmented label="Collection" value={ladderId} onChange={setLadderId} options={LADDERS.map((l) => ({ value: l.id, label: l.label }))} />

          {next ? (
            <NextRung item={next} wallet={wallet} dailyDraw={dailyDraw} busy={busy} onBuy={() => void buy(next)} />
          ) : (
            <div className="inset"><strong>Collection complete.</strong> <span className="muted">Limited editions appear here when they drop.</span></div>
          )}

          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }} className="grid-auto-sm">
            {ladder.items.map((item, i) => {
              const mine = owned.get(item.id);
              const isNext = i === nextIdx;
              const canBuy = isNext && item.price !== null && item.price > 0 && wallet >= item.price;
              const state = mine ? (mine.stored ? 'In storage' : 'Owned') : isNext ? (item.price === null ? 'Auction only' : canBuy ? 'Affordable now' : 'Next goal') : 'Locked';
              return (
                <li key={item.id} className="stack-sm" style={{ borderRadius: 14, padding: 16, background: isNext ? 'var(--gold-wash)' : 'var(--raised)', border: `1.5px solid ${isNext ? 'var(--gold-edge)' : 'transparent'}`, opacity: mine || isNext ? 1 : 0.6 }}>
                  <div className="art-stage" style={{ height: 96, borderRadius: 10 }}>
                    {item.art && <img src={item.art} alt="" style={{ width: '100%', height: 90, objectFit: 'contain', opacity: mine?.stored ? 0.4 : 1 }} />}
                  </div>
                  <span className="mono muted" style={{ fontSize: 11 }}>RUNG {i + 1}</span>
                  <strong style={{ fontSize: 15, minHeight: 40 }}>{item.name}</strong>
                  <span className="mono">{priceLabel(item)}</span>
                  <span className="small" style={{ fontWeight: 700, color: mine?.stored ? 'var(--loss)' : mine ? 'var(--gain)' : isNext ? 'var(--gold)' : 'var(--muted)' }}>{state}</span>
                  {mine && item.price ? (
                    <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start', padding: '4px 0' }} disabled={busy} onClick={() => void sell(item)}>
                      Sell for {num(item.price * CATEGORY_RULES[item.category].buyback)}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <span className="small muted">{ladder.rule}</span>
        </Card>

        <div className="side stack" style={{ gap: 24 }}>
          <Card title="Pay yourself">
            {limits.blocked && <span className="loss small">{limits.blocked}</span>}
            <div className="stack-sm" style={{ gap: 8 }}>
              <div className="row-between"><span className="muted">7-day avg operating profit</span><span className="mono">{num(toCr(limits.avgOpProfit7dCents))} / day</span></div>
              <div className="row-between"><span className="muted">Cash the company keeps</span><span className="mono">{num(toCr(limits.reserveCents))}</span></div>
              <div className="row-between"><span className="muted">30-day payouts so far</span><span className="mono">{num(prior)}</span></div>
            </div>

            <div className="field">
              Daily salary <span className="small muted">(max {num(cap)}, 15% of avg profit)</span>
              <Stepper
                value={`${num(salaryValue)} CR / day`}
                decLabel="Lower salary"
                incLabel="Raise salary"
                onDec={() => setSalary(Math.max(0, Math.min(salaryValue, cap) - salaryStep))}
                onInc={() => setSalary(Math.min(cap, salaryValue + salaryStep))}
              />
            </div>
            {!salaryChanged && toCr(data.salaryCents) > cap && (
              <span className="small loss">Capped at {num(cap)} CR today: the company’s recent operating profit doesn’t support more.</span>
            )}
            <button type="button" className="btn btn-secondary" disabled={busy || !salaryChanged || salaryValue > cap} onClick={() => void saveSalary()}>
              {salaryChanged ? `Set salary to ${num(salaryValue)} CR / day` : 'Paid at each daily close'}
            </button>

            <Segmented label="Payout" value={payKind} onChange={(v) => { setPayKind(v as 'dividend' | 'withdrawal'); setAmount(null); }} options={[{ value: 'dividend', label: 'Dividend' }, { value: 'withdrawal', label: 'Withdrawal' }]} />
            <div className="field">
              {payKind === 'dividend' ? 'Dividend' : 'Withdrawal'} <span className="small muted">(up to {num(maxPay)})</span>
              <Stepper
                value={`${num(payAmount)} CR`}
                decLabel="Less"
                incLabel="More"
                onDec={() => setAmount(Math.max(0, payAmount - payStep))}
                onInc={() => setAmount(Math.min(maxPay, payAmount + payStep))}
              />
            </div>
            {maxPay <= 0 && !limits.blocked && (
              <span className="small muted">
                {payKind === 'dividend'
                  ? 'No profit left to distribute from the last 30 days.'
                  : 'Company cash is at or below the 7-day reserve.'}
              </span>
            )}
            <div className="row-between small"><span className="muted">Tax on this payout</span><span className="mono">{dec(payTax)} CR</span></div>
            <ProgressBar value={Math.min(1, (prior + payAmount) / TAX_FREE_ALLOWANCE)} color="var(--info)" label="Tax-free allowance used" />
            <span className="small muted">
              {prior >= TAX_FREE_ALLOWANCE ? 'Tax-free allowance used up for this 30-day window.' : `${num(TAX_FREE_ALLOWANCE - prior)} CR more this month before the 10% band starts.`}
              {payKind === 'dividend' ? ' Dividends are limited to the last 30 days’ operating profit, minus what you already took.' : ' Withdrawals add a 10% early-withdrawal tax.'}
            </span>
            <button type="button" className="btn btn-primary" disabled={busy || payAmount <= 0 || !!limits.blocked} onClick={() => void pay()}>
              {payKind === 'dividend' ? `Declare ${num(payAmount)} dividend` : `Withdraw ${num(payAmount)}`}
            </button>
            {data.payouts.length > 0 && (
              <div className="stack-sm" style={{ gap: 4 }}>
                <span className="overline">Recent</span>
                {data.payouts.slice(0, 4).map((p, i) => (
                  <div key={i} className="row-between small">
                    <span className="muted">{p.kind[0].toUpperCase() + p.kind.slice(1)}</span>
                    <span className="mono">{dec(toCr(p.grossCents - p.taxCents))} <span className="muted">net</span></span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Trophy cabinet">
            {data.trophies.length === 0 ? (
              <span className="muted">No trophies yet. Win a weekly contest or get promoted in your league.</span>
            ) : (
              <div className="row" style={{ gap: 10 }}>
                {data.trophies.map((t, i) => {
                  const [bg, fg] = TROPHY_TONE[t.kind] ?? TROPHY_TONE.contest;
                  return <span key={i} className="chip" style={{ background: bg, color: fg, padding: '8px 12px', fontSize: 13 }}>{t.title}</span>;
                })}
              </div>
            )}
            <span className="small muted">Trophies can't be sold or traded.</span>
          </Card>
        </div>
      </section>

      <Card title="Player luxury stores" action={<span className="small muted">Other companies’ Luxury Stores · paid from your wallet</span>}>
        {storePieces.length > 0 && (
          <div className="row" style={{ gap: 12 }}>
            {storePieces.map((o) => {
              const p = productById(o.productId!);
              return (
                <div key={o.itemId} className="inset row" style={{ gap: 10, alignItems: 'center', flexWrap: 'nowrap' }}>
                  {p.art && <img src={p.art} alt="" width={44} height={44} style={{ objectFit: 'contain' }} />}
                  <div className="stack-sm" style={{ gap: 2 }}>
                    <strong style={{ fontSize: 14 }}>{p.name} · Q{o.quality ?? 0}</strong>
                    <span className="small muted">Paid {num(toCr(o.priceCents))} · {o.rarity === 'limited' ? 'limited' : 'common'}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => void run(async () => {
                      const r = await api<{ proceedsCents: number }>(`/wealth/items/${encodeURIComponent(o.itemId)}/sell`, { body: {} });
                      notify(`Sold ${p.name}`, `${dec(toCr(r.proceedsCents))} CR back in your wallet.`, 'info');
                      return r;
                    })}
                  >
                    Sell for {num(toCr(o.priceCents) * CATEGORY_RULES.watch.buyback)}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {listings.length === 0 ? (
          <span className="muted">No player stores have stock right now.</span>
        ) : (
          <div className="stack-sm" style={{ gap: 8 }}>
            {listings.map((l) => {
              const p = productById(l.productId);
              const ownedAlready = data.owned.some((o) => o.productId === l.productId);
              const short = wallet < toCr(l.priceCents);
              return (
                <div key={l.id} className="list-row" style={{ alignItems: 'center', gap: 12 }}>
                  {p.art && <img src={p.art} alt="" width={40} height={40} style={{ objectFit: 'contain' }} />}
                  <span style={{ flex: 1 }}>
                    <strong>{p.name} · Q{l.quality}</strong>
                    <span className="small muted"> · {l.storeName}, {l.sellerName} · {num(l.qty)} left</span>
                  </span>
                  <span className="mono">{num(toCr(l.priceCents))} CR</span>
                  <button type="button" className="btn btn-secondary" disabled={busy || l.mine || ownedAlready || short} onClick={() => void buyFromStore(l)}>
                    {l.mine ? 'Your store' : ownedAlready ? 'Owned' : short ? 'Not enough' : 'Buy'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <span className="small muted">One of each piece per collection. Store pieces count toward prestige and sell back to the NPC shop at 70% of what you paid.</span>
      </Card>
    </>
  );
}

function NextRung({ item, wallet, dailyDraw, busy, onBuy }: { item: LuxuryItem; wallet: number; dailyDraw: number; busy: boolean; onBuy: () => void }) {
  const price = item.price ?? 0;
  const progress = price > 0 ? Math.min(1, wallet / price) : 0;
  const gap = price - wallet;
  const upkeep = itemUpkeep(item);
  const note =
    item.price === null
      ? 'Sold only at auction. Watch for the next drop.'
      : gap <= 0
        ? `You can buy this today.${upkeep ? ` Upkeep ${dec(upkeep)} CR a day.` : ''}`
        : dailyDraw > 0
          ? `${num(gap)} CR more · about ${Math.ceil(gap / dailyDraw)} days at your salary`
          : `${num(gap)} CR more · set a salary or declare a dividend to fill your wallet`;
  return (
    <div className="inset row" style={{ padding: 18, gap: 20, alignItems: 'center' }}>
      {item.art && (
        <div style={{ width: 220, height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, background: 'radial-gradient(circle at 50% 45%, #3a2e14, var(--sunken) 70%)' }}>
          <img src={item.art} alt={item.name} style={{ width: 200, height: 150, objectFit: 'contain' }} />
        </div>
      )}
      <div className="stack-sm" style={{ flex: '1 1 260px', gap: 10 }}>
        <div className="row-between small muted"><span>Next rung</span><span className="mono">{Math.round(progress * 100)}%</span></div>
        <span className="disp" style={{ fontSize: 26, fontWeight: 600 }}>{item.name}{item.price ? ` · ${num(item.price)} CR` : ''}</span>
        <ProgressBar value={progress} size="thick" label={`Savings toward ${item.name}`} />
        <span className="muted">{note}</span>
        {item.price !== null && item.price > 0 && gap <= 0 && (
          <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={onBuy}>Buy for {num(price)} CR</button>
        )}
      </div>
    </div>
  );
}
