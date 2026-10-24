import { useState } from 'react';
import { TopBar } from '../components/AppShell';
import { Card, ProgressBar, Segmented, StatTile } from '../components/ui';
import { LADDERS, type Rung } from '../data/lifestyle';
import { COMPANY } from '../data/mock';
import { itemPrestige, maxDailySalary, personalIncomeTax } from '../lib/economy';
import { num } from '../lib/format';
import { useGame } from '../state/game';

const DAILY_DRAW = 7200;
const INFLOWS_30D = 38_900;
const DIVIDEND_AVAILABLE = 22_400;

const priceLabel = (r: Rung) => (r.price === null ? 'auction' : r.price === 0 ? 'renting' : `${num(r.price)} CR`);

export function Showroom() {
  const { wallet, owned, buyItem, notify } = useGame();
  const [ladderId, setLadderId] = useState(LADDERS[0].id);
  const [declared, setDeclared] = useState(false);
  const ladder = LADDERS.find((l) => l.id === ladderId)!;
  const ownedCount = Math.min(owned[ladder.id] ?? 0, ladder.rungs.length);
  const next = ladder.rungs[ownedCount];

  const prestige = Math.round(
    LADDERS.reduce((sum, l) => sum + l.rungs.slice(0, owned[l.id] ?? 0).reduce((s, r) => s + (r.price ? itemPrestige(r.price) : 0), 0), 0) + 400,
  );
  const upkeep = LADDERS.find((l) => l.id === 'garage')!.rungs.slice(0, owned.garage ?? 0).reduce((s, r) => s + (r.price ?? 0) * 0.0002, 0);

  const salary = maxDailySalary(COMPANY.avgDailyOpProfit);
  const taxFreeLeft = Math.max(0, 50_000 - INFLOWS_30D);

  return (
    <>
      <TopBar title="Showroom" subtitle="Your personal wealth, kept apart from the company" />
      <section className="grid-auto">
        <StatTile label="Personal wallet" value={num(wallet)} valueClass="goldtx" deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Protected if the company goes into receivership</span>} />
        <StatTile label="Prestige score" value={num(prestige)} deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Log-scaled, so a curated set beats one huge buy</span>} />
        <StatTile label="Daily upkeep on items" value={upkeep.toFixed(2)} deltaTone="muted" delta={<span className="muted" style={{ fontFamily: 'var(--font-ui)' }}>Unpaid upkeep stores an item, never seizes it</span>} />
      </section>

      <section className="split">
        <Card className="main" style={{ gap: 18 }}>
          <Segmented label="Collection" value={ladderId} onChange={setLadderId} options={LADDERS.map((l) => ({ value: l.id, label: l.label }))} />

          {next ? (
            <NextRung rung={next} wallet={wallet} onBuy={() => next.price && buyItem(ladder.id, next.name, next.price)} />
          ) : (
            <div className="inset"><strong>Ladder complete.</strong> <span className="muted">Limited editions appear here when they drop.</span></div>
          )}

          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }} className="grid-auto-sm">
            {ladder.rungs.map((r, i) => {
              const isOwned = i < ownedCount;
              const isNext = i === ownedCount;
              const canBuy = isNext && r.price !== null && r.price > 0 && wallet >= r.price;
              const state = isOwned ? 'Owned' : isNext ? (canBuy ? 'Affordable now' : 'Next goal') : 'Locked';
              return (
                <li key={r.name} className="stack-sm" style={{ borderRadius: 14, padding: 16, background: isNext ? 'var(--gold-wash)' : 'var(--raised)', border: `1.5px solid ${isNext ? 'var(--gold-edge)' : 'transparent'}`, opacity: isOwned || isNext ? 1 : 0.6 }}>
                  <div className="art-stage" style={{ height: 96, borderRadius: 10 }}>
                    {r.art && <img src={r.art} alt="" style={{ width: '100%', height: 90, objectFit: 'contain' }} />}
                  </div>
                  <span className="mono muted" style={{ fontSize: 11 }}>RUNG {i + 1}</span>
                  <strong style={{ fontSize: 15, minHeight: 40 }}>{r.name}</strong>
                  <span className="mono">{priceLabel(r)}</span>
                  <span className="small" style={{ fontWeight: 700, color: isOwned ? 'var(--gain)' : isNext ? 'var(--gold)' : 'var(--muted)' }}>{state}</span>
                </li>
              );
            })}
          </ol>
          <span className="small muted">{ladder.rule}</span>
        </Card>

        <div className="side stack" style={{ gap: 24 }}>
          <Card title="Pay yourself">
            <div className="stack-sm" style={{ gap: 10 }}>
              <div className="row-between"><span className="muted">Daily salary</span><span className="mono">{num(salary)} / day <span className="small muted">(max)</span></span></div>
              <div className="row-between"><span className="muted">Dividend available</span><span className="mono">{declared ? '0' : num(DIVIDEND_AVAILABLE)}</span></div>
              <div className="row-between"><span className="muted">30-day inflows</span><span className="mono">{num(INFLOWS_30D + (declared ? DIVIDEND_AVAILABLE : 0))}</span></div>
              <div className="row-between"><span className="muted">Tax on this dividend</span><span className="mono">{num(personalIncomeTax(INFLOWS_30D + DIVIDEND_AVAILABLE) - personalIncomeTax(INFLOWS_30D))} CR</span></div>
            </div>
            <ProgressBar value={INFLOWS_30D / 50_000} color="var(--info)" label="Tax-free allowance used" />
            <span className="small muted">{num(taxFreeLeft)} CR more this month before the 10% band starts. Owner withdrawals add a 10% early-withdrawal tax.</span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={declared}
              onClick={() => {
                setDeclared(true);
                const tax = personalIncomeTax(INFLOWS_30D + DIVIDEND_AVAILABLE) - personalIncomeTax(INFLOWS_30D);
                notify('Dividend paid', `${num(DIVIDEND_AVAILABLE - tax)} CR reached your wallet after ${num(tax)} CR tax.`);
              }}
            >
              {declared ? 'Dividend declared' : `Declare ${num(DIVIDEND_AVAILABLE)} dividend`}
            </button>
          </Card>
          <Card title="Trophy cabinet">
            <div className="row" style={{ gap: 10 }}>
              <span className="chip" style={{ background: 'var(--bronze-bg)', color: 'var(--bronze-fg)', padding: '8px 12px', fontSize: 13 }}>Bronze → Silver · W38</span>
              <span className="chip" style={{ background: 'var(--silver-bg)', color: 'var(--silver-fg)', padding: '8px 12px', fontSize: 13 }}>Silver → Gold · W41</span>
              <span className="chip" style={{ background: 'var(--t1-bg)', color: 'var(--t1-fg)', padding: '8px 12px', fontSize: 13 }}>Newcomer Cup #2</span>
            </div>
            <span className="small muted">Trophies can't be sold or traded.</span>
          </Card>
        </div>
      </section>
    </>
  );
}

function NextRung({ rung, wallet, onBuy }: { rung: Rung; wallet: number; onBuy: () => void }) {
  const price = rung.price ?? 0;
  const progress = price > 0 ? Math.min(1, wallet / price) : 0;
  const gap = price - wallet;
  const note =
    rung.price === null
      ? 'Sold only at auction. Watch for the next drop.'
      : gap <= 0
        ? 'You can buy this today. A player Luxury Store is usually cheaper than the NPC shop.'
        : `${num(gap)} CR more · about ${Math.ceil(gap / DAILY_DRAW)} days at your current draw`;
  return (
    <div className="inset row" style={{ padding: 18, gap: 20, alignItems: 'center' }}>
      {rung.art && (
        <div style={{ width: 220, height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, background: 'radial-gradient(circle at 50% 45%, #3a2e14, var(--sunken) 70%)' }}>
          <img src={rung.art} alt={rung.name} style={{ width: 200, height: 150, objectFit: 'contain' }} />
        </div>
      )}
      <div className="stack-sm" style={{ flex: '1 1 260px', gap: 10 }}>
        <div className="row-between small muted"><span>Next rung</span><span className="mono">{Math.round(progress * 100)}%</span></div>
        <span className="disp" style={{ fontSize: 26, fontWeight: 600 }}>{rung.name}{rung.price ? ` · ${num(rung.price)} CR` : ''}</span>
        <ProgressBar value={progress} size="thick" label={`Savings toward ${rung.name}`} />
        <span className="muted">{note}</span>
        {rung.price !== null && rung.price > 0 && gap <= 0 && (
          <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={onBuy}>Buy for {num(price)} CR</button>
        )}
      </div>
    </div>
  );
}
