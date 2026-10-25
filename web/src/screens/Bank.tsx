import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, toCr } from '../api/client';
import type { BankOverview, DayReport, ServerLoan } from '../api/types';
import { TopBar } from '../components/AppShell';
import { Card, ProgressBar, Stepper } from '../components/ui';
import { emi, RATE_TIERS } from '../lib/economy';
import { dec, duration, num, pct } from '../lib/format';
import { useGame } from '../state/game';
import { DELINQUENCY } from '../../../shared/bank';

const REFRESH_MS = 5000;

const LADDER = [
  { when: '0–24h', title: 'Grace', note: 'Reminder only', color: 'var(--info)' },
  { when: 'day 1–3', title: 'Late', note: `${pct(DELINQUENCY.lateFeePct)} fee, +${pct(DELINQUENCY.penaltyRate, 2)}/day, −${DELINQUENCY.missedScorePenalty} score`, color: 'var(--gold)' },
  { when: `day ${DELINQUENCY.restructureAtDays}`, title: 'Restructure offer', note: `Term up to 2×, no new loans ${DELINQUENCY.borrowBlockDays}d`, color: 'var(--t4)' },
  { when: `day ${DELINQUENCY.collectionsAtDays}`, title: 'Collections', note: `Bank sweeps ${pct(DELINQUENCY.collectionsSweepPct)} of revenue`, color: 'var(--loss)' },
  { when: `day ${DELINQUENCY.receivershipAtDays}`, title: 'Receivership', note: 'Assets liquidated. First building, level and wallet protected.', color: 'var(--text-soft)' },
];

const STATUS: Record<ServerLoan['status'], { label: string; bg: string; fg: string }> = {
  active: { label: 'On track', bg: 'var(--gain-wash)', fg: 'var(--gain)' },
  late: { label: 'Late', bg: 'var(--gold-wash)', fg: 'var(--gold)' },
  restructure_offered: { label: 'Restructure offered', bg: 'var(--t4-bg)', fg: 'var(--t4-fg)' },
  collections: { label: 'Collections', bg: 'var(--loss-wash)', fg: 'var(--loss)' },
  repaid: { label: 'Repaid', bg: 'var(--line)', fg: 'var(--text-soft)' },
  defaulted: { label: 'Defaulted', bg: 'var(--loss-wash)', fg: 'var(--loss)' },
};

const PRODUCT_LABEL = { starter: 'Starter loan', term: 'Term loan', overdraft: 'Overdraft', mortgage: 'Mortgage', credit_line: 'Line of credit' } as const;

const EVENT_LABEL: Record<string, string> = {
  disbursed: 'Loan paid out', paid: 'Installment paid', missed: 'Installment missed', late_fee: 'Late fee', restructured: 'Restructured',
  collections: 'Collections sweep', liquidation: 'Paid from liquidation', repaid: 'Loan closed', defaulted: 'Written off', overdraft_draw: 'Overdraft drawn',
  credit_draw: 'Credit drawn', credit_repay: 'Credit repaid', limit_review: 'Credit limit set', closed: 'Line closed',
};

function ScoreGauge({ score, tierFloor, tierCeil }: { score: number; tierFloor: number; tierCeil: number }) {
  const f = Math.max(0, Math.min(1, (score - 300) / 600));
  const theta = Math.PI * (1 - f);
  const x = 120 + 100 * Math.cos(theta);
  const y = 120 - 100 * Math.sin(theta);
  return (
    <svg viewBox="0 0 240 132" role="img" aria-label={`Credit score ${score} of 900`} style={{ width: '100%', maxWidth: 280, display: 'block', margin: '0 auto' }}>
      <path d="M20 120 A100 100 0 0 1 220 120" stroke="var(--line)" strokeWidth="16" fill="none" strokeLinecap="round" />
      {f > 0 && <path d={`M20 120 A100 100 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`} stroke="var(--gold)" strokeWidth="16" fill="none" strokeLinecap="round" />}
      <text x="120" y="104" textAnchor="middle" fill="var(--text)" fontFamily="JetBrains Mono, monospace" fontSize="38" fontWeight="600">{score}</text>
      <text x="120" y="126" textAnchor="middle" fill="var(--muted)" fontFamily="Inter, sans-serif" fontSize="12">tier {tierFloor}–{tierCeil}</text>
    </svg>
  );
}

export function Bank() {
  const { act, notify, cash, timeScale } = useGame();
  const [bank, setBank] = useState<BankOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [product, setProduct] = useState<'starter' | 'term' | 'mortgage'>('starter');
  const [mortgageBuilding, setMortgageBuilding] = useState<string | null>(null);
  const [lineAmount, setLineAmount] = useState<number | null>(null);
  const [saveAmount, setSaveAmount] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setBank(await api<BankOverview>('/bank'));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else throw err;
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), REFRESH_MS);
    const c = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(t);
      window.clearInterval(c);
    };
  }, [load]);

  const run = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    const res = await act(fn);
    await load();
    setBusy(false);
    return res;
  };

  if (!bank) {
    return (
      <>
        <TopBar title="Bank" subtitle="Rates are quoted per day, because your buildings earn per day" />
        <p className={error ? 'loss' : 'muted'}>{error ?? 'Loading the bank…'}</p>
      </>
    );
  }

  const { credit, offers } = bank;
  const tierIdx = RATE_TIERS.findIndex((t) => t.minScore === credit.tier.minScore);
  const nextTier = tierIdx > 0 ? RATE_TIERS[tierIdx - 1] : null;
  const tierCeil = nextTier ? nextTier.minScore - 1 : 900;

  const term = offers.term;
  const mortgage = offers.mortgage;
  const freeBuildings = mortgage.buildings.filter((b) => !b.mortgaged && b.maxCents >= mortgage.minCents);
  const mBuilding = freeBuildings.find((b) => b.id === mortgageBuilding) ?? freeBuildings[0];
  // Term loans and mortgages share the amount/term form; only their limits and rates differ.
  const lending = product === 'mortgage'
    ? { available: mortgage.available && !!mBuilding, reason: mortgage.reason ?? (mBuilding ? undefined : 'No building has enough resale value to mortgage.'), minCents: mortgage.minCents, maxCents: mBuilding?.maxCents ?? 0, dailyRate: mortgage.dailyRate, minDscr: mortgage.minDscr, terms: mortgage.terms }
    : term;
  const amountCents = Math.min(lending.maxCents, Math.max(lending.minCents, amount ?? Math.min(lending.maxCents, Math.round(lending.maxCents / 2 / 100_000) * 100_000 || lending.minCents)));
  const isStarter = product === 'starter';
  const loanDays = isStarter ? offers.starter.days : lending.terms.includes(days) ? days : lending.terms[1] ?? lending.terms[0];
  const principal = isStarter ? offers.starter.amountCents : amountCents;
  const rate = isStarter ? offers.starter.dailyRate : lending.dailyRate;
  const installment = emi(principal, rate, loanDays);
  const totalInterest = installment * loanDays - principal;
  const dscr = credit.avgDailyOperatingCents / (credit.dailyDebtServiceCents + installment);
  const offer = isStarter ? offers.starter : lending;
  const dscrOk = isStarter || dscr >= lending.minDscr;
  const step = 1_000_00;

  const openLoans = bank.loans.filter((l) => l.status !== 'repaid' && l.status !== 'defaulted');
  const line = openLoans.find((l) => l.product === 'credit_line');
  const lineRoom = line ? (line.creditLimitCents ?? 0) - line.outstandingCents : 0;
  const lineValue = lineAmount ?? Math.max(100_00, Math.min(10_000_00, lineRoom || (line?.outstandingCents ?? 0)));
  const lineStep = 1_000_00;
  const saveValue = saveAmount ?? 10_000_00;
  const closedLoans = bank.loans.filter((l) => l.status === 'repaid' || l.status === 'defaulted').slice(0, 4);
  const msToClose = Math.max(0, Date.parse(bank.nextCloseAt) - now);
  const gameMinutesToClose = (msToClose * timeScale) / 60_000;
  const dailyInstallments = credit.dailyDebtServiceCents;

  const factors = [
    { name: 'On-time repayments', w: '30%', v: credit.factors.repayment.toFixed(2), p: credit.factors.repayment },
    { name: 'Low debt use', w: '20%', v: credit.factors.lowDebt.toFixed(2), p: credit.factors.lowDebt },
    { name: 'Company age', w: '15%', v: `${credit.factors.ageDays} / 90 d`, p: credit.factors.ageDays / 90 },
    { name: 'Debt cover (DSCR)', w: '20%', v: `${credit.factors.dscr.toFixed(2)}×`, p: credit.factors.dscr / 2 },
    { name: 'Profit stability', w: '15%', v: credit.factors.stability.toFixed(2), p: credit.factors.stability },
  ];

  const takeLoan = async () => {
    const res = await run(() =>
      api<{ principalCents: number; installmentCents: number }>('/loans', {
        body: isStarter ? { product: 'starter' } : { product, principalCents: amountCents, days: loanDays, ...(product === 'mortgage' ? { buildingId: mBuilding?.id } : {}) },
      }),
    );
    if (res) notify('Loan paid out', `${num(toCr(res.principalCents))} CR added to cash. ${dec(toCr(res.installmentCents))} CR is due at each daily close.`);
  };

  const closeDayNow = async () => {
    const r = await run(() => api<DayReport>('/dev/close-day', { body: {} }));
    if (r) {
      const parts = [`upkeep ${dec(toCr(r.upkeepPaidCents))}`, `installments ${dec(toCr(r.installmentsPaidCents))}`];
      if (r.overdraftDrawCents) parts.push(`overdraft drawn ${dec(toCr(r.overdraftDrawCents))}`);
      if (r.missed) parts.push(`${r.missed} missed`);
      if (r.receivership) parts.push(r.bankrupt ? 'BANKRUPT — restarted' : 'receivership');
      notify(`Closed game day ${r.day}`, parts.join(' · '), r.missed || r.receivership ? 'bad' : 'info');
    }
  };

  return (
    <>
      <TopBar title="Bank" subtitle="Rates are quoted per day, because your buildings earn per day" />

      {bank.upkeep.arrearsCents > 0 && (
        <div className="callout bad" role="alert">
          <span className="loss" style={{ fontWeight: 700 }}>!</span>
          <div className="row-between" style={{ flex: 1 }}>
            <span><strong className="loss">Unpaid upkeep: {dec(toCr(bank.upkeep.arrearsCents))} CR.</strong> <span className="muted">Production is paused until it is settled.</span></span>
            <button type="button" className="btn btn-primary" disabled={busy || cash <= 0} onClick={() => void run(() => api('/upkeep/pay', { body: {} }))}>Pay now</button>
          </div>
        </div>
      )}

      <section className="split">
        <Card title="Credit score" style={{ flex: '1 1 320px' }}>
          <ScoreGauge score={credit.score} tierFloor={credit.tier.minScore} tierCeil={tierCeil} />
          <div className="stack-sm" style={{ gap: 10 }}>
            {factors.map((f) => (
              <div key={f.name} className="stack-sm" style={{ gap: 4 }}>
                <div className="row-between" style={{ fontSize: 13 }}>
                  <span>{f.name} <span className="muted">· {f.w}</span></span>
                  <span className="mono muted">{f.v}</span>
                </div>
                <ProgressBar value={f.p} size="thin" color="var(--info)" label={f.name} />
              </div>
            ))}
          </div>
          {credit.penalty > 0 && <span className="small loss">−{credit.penalty} penalty points from missed payments or restructuring. They recover with on-time payments.</span>}
          {nextTier && (
            <span className="muted" style={{ fontSize: 13 }}>
              <strong style={{ color: 'var(--text)' }}>Next tier at {nextTier.minScore}:</strong> {pct(nextTier.dailyRate ?? 0, 2)}/day, needs {nextTier.minDscr}× debt cover.
            </span>
          )}
        </Card>

        <Card style={{ flex: '2 1 520px' }}>
          <div className="row-between">
            <h2 className="h-section">Borrow</h2>
            <div role="tablist" aria-label="Loan product" className="segmented">
              <button type="button" role="tab" aria-selected={isStarter} onClick={() => setProduct('starter')}>Starter</button>
              <button type="button" role="tab" aria-selected={product === 'term'} onClick={() => { setProduct('term'); setAmount(null); }}>Term loan</button>
              <button type="button" role="tab" aria-selected={product === 'mortgage'} onClick={() => { setProduct('mortgage'); setAmount(null); }}>Mortgage</button>
            </div>
          </div>

          {isStarter ? (
            <p className="muted" style={{ fontSize: 13 }}>A one-time {num(toCr(offers.starter.amountCents))} CR loan to finish your first production chain, at {pct(offers.starter.dailyRate, 2)}/day whatever your score.</p>
          ) : (
            <>
              {product === 'term' ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  Up to 10 × your average daily operating cash flow ({dec(toCr(credit.avgDailyOperatingCents))} CR/day over the last 7 game days). Your rate: {pct(term.dailyRate, 2)}/day.
                </p>
              ) : (
                <>
                  <p className="muted" style={{ fontSize: 13 }}>
                    Secured on one building: up to {Math.round(mortgage.maxLtv * 100)}% of its resale value (70% of what you spent on it), at {pct(mortgage.dailyRate, 2)}/day. If the loan ends in receivership, that building is sold first to repay it.
                  </p>
                  <div role="radiogroup" aria-label="Building to mortgage" className="grid-auto-sm">
                    {mortgage.buildings.map((b) => (
                      <button key={b.id} type="button" role="radio" aria-checked={b.id === mBuilding?.id} className="option" disabled={b.mortgaged || b.maxCents < mortgage.minCents} onClick={() => { setMortgageBuilding(b.id); setAmount(null); }}>
                        <strong>{b.name}</strong>
                        <span className="mono small muted">{b.mortgaged ? 'Already mortgaged' : `up to ${num(toCr(b.maxCents))} CR`}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div className="field">
                Amount
                <Stepper
                  value={`${num(toCr(amountCents))} CR`}
                  decLabel="Decrease amount by 1,000"
                  incLabel="Increase amount by 1,000"
                  onDec={() => setAmount(Math.max(lending.minCents, amountCents - step))}
                  onInc={() => setAmount(Math.min(lending.maxCents, amountCents + step))}
                />
                <span className="small">Allowed {num(toCr(lending.minCents))} – {num(toCr(Math.max(lending.minCents, lending.maxCents)))} CR</span>
              </div>
              <div className="field">
                Term
                <div role="radiogroup" aria-label="Term" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
                  {lending.terms.map((t) => (
                    <button key={t} type="button" role="radio" aria-checked={t === loanDays} className="option" style={{ alignItems: 'center', justifyContent: 'center', fontWeight: 600 }} onClick={() => setDays(t)}>
                      {t} days
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="grid-auto-sm">
            <div className="inset stack-sm"><span className="small muted">Amount</span><span className="stat-value sm">{num(toCr(principal))}</span><span className="small muted">over {loanDays} game days</span></div>
            <div className="inset stack-sm"><span className="small muted">Daily installment</span><span className="stat-value sm goldtx">{dec(toCr(installment))}</span><span className="small muted">debited at each daily close</span></div>
            <div className="inset stack-sm"><span className="small muted">Total interest</span><span className="stat-value sm">{dec(toCr(totalInterest))}</span><span className="small muted">≈ {Math.round(rate * 365 * 100)}% simple annual</span></div>
            {!isStarter && (
              <div className="inset stack-sm">
                <span className="small muted">Debt cover after loan</span>
                <span className={`stat-value sm ${dscrOk ? 'gain' : 'loss'}`}>{Number.isFinite(dscr) ? dscr.toFixed(2) : '—'}×</span>
                <span className="small muted">bank needs ≥ {lending.minDscr}×</span>
              </div>
            )}
          </div>

          <div className="row">
            <button type="button" className="btn btn-primary btn-lg" disabled={busy || !offer.available || !dscrOk} onClick={() => void takeLoan()}>
              {!offer.available ? 'Not available' : !dscrOk ? 'Debt cover too low' : `Take ${num(toCr(principal))} CR`}
            </button>
            {offer.reason && <span className="muted" style={{ fontSize: 13, maxWidth: 420 }}>{offer.reason}</span>}
          </div>
        </Card>
      </section>

      <section className="split">
        <Card title="Your loans" className="main" style={{ gap: 12 }}>
          {openLoans.length === 0 && <p className="muted">No open loans.</p>}
          {openLoans.map((l) => {
            const s = STATUS[l.status];
            const owed = l.outstandingCents + l.arrearsCents;
            return (
              <div key={l.id} className="inset stack-sm" style={{ gap: 10 }}>
                <div className="row-between">
                  <strong>{PRODUCT_LABEL[l.product]}{l.product === 'mortgage' && l.buildingId ? ` · ${mortgage.buildings.find((b) => b.id === l.buildingId)?.name ?? 'building'}` : ''}{l.restructured ? ' · restructured' : ''}</strong>
                  <span className="chip" style={{ background: s.bg, color: s.fg }}>{s.label}{l.daysPastDue > 0 ? ` · ${l.daysPastDue}d past due` : ''}</span>
                </div>
                {l.product === 'credit_line' && (
                  <>
                    <ProgressBar value={l.outstandingCents / Math.max(1, l.creditLimitCents ?? 1)} size="thin" color="var(--info)" label="Credit used" />
                    <span className="mono small muted">{dec(toCr(l.outstandingCents))} drawn of {dec(toCr(l.creditLimitCents ?? 0))} · {pct(l.dailyRate, 2)}/day on what is drawn</span>
                  </>
                )}
                {l.product !== 'overdraft' && l.product !== 'credit_line' && (
                  <>
                    <ProgressBar value={l.installmentsPaid / Math.max(1, l.termDays)} size="thin" label="Installments paid" />
                    <span className="mono small muted">{l.installmentsPaid} / {l.termDays} installments · {dec(toCr(l.installmentCents))} per day · {pct(l.dailyRate, 2)}/day</span>
                  </>
                )}
                <div className="grid-auto-sm mono" style={{ fontSize: 13 }}>
                  <span className="stack-sm" style={{ gap: 2 }}><span className="muted small" style={{ fontFamily: 'var(--font-ui)' }}>Principal left</span>{dec(toCr(l.outstandingCents))}</span>
                  <span className="stack-sm" style={{ gap: 2 }}><span className="muted small" style={{ fontFamily: 'var(--font-ui)' }}>Overdue</span><span className={l.arrearsCents > 0 ? 'loss' : ''}>{dec(toCr(l.arrearsCents))}</span></span>
                  <span className="stack-sm" style={{ gap: 2 }}><span className="muted small" style={{ fontFamily: 'var(--font-ui)' }}>Pay off today</span>{dec(toCr(owed))}</span>
                </div>
                <div className="row">
                  {l.status === 'restructure_offered' && (
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => api(`/loans/${l.id}/restructure`, { body: {} }))}>
                      Accept restructuring
                    </button>
                  )}
                  {l.product !== 'overdraft' && l.product !== 'credit_line' && (
                    <button type="button" className="btn btn-secondary" disabled={busy || cash * 100 < owed} onClick={() => void run(() => api(`/loans/${l.id}/repay`, { body: {} }))}>
                      Repay {dec(toCr(owed))} CR
                    </button>
                  )}
                </div>
                {l.status === 'restructure_offered' && (
                  <span className="small muted">Folds overdue amounts into principal and doubles the remaining term at +{pct(DELINQUENCY.restructureRateBump, 2)}/day. Costs {DELINQUENCY.restructureScorePenalty} score points and pauses new borrowing for {DELINQUENCY.borrowBlockDays} game days.</span>
                )}
              </div>
            );
          })}
          {closedLoans.length > 0 && (
            <div className="stack-sm" style={{ gap: 4 }}>
              <span className="overline">Closed</span>
              {closedLoans.map((l) => (
                <div key={l.id} className="list-row">
                  <span style={{ flex: 1 }}>{PRODUCT_LABEL[l.product]} · {num(toCr(l.principalCents))} CR</span>
                  <span className="chip" style={{ background: STATUS[l.status].bg, color: STATUS[l.status].fg }}>{STATUS[l.status].label}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="side stack" style={{ gap: 24 }}>
          <Card title="Line of credit">
            {line ? (
              <>
                <div className="row-between"><span className="muted">Drawn</span><span className="mono">{dec(toCr(line.outstandingCents))} / {dec(toCr(line.creditLimitCents ?? 0))}</span></div>
                <ProgressBar value={line.outstandingCents / Math.max(1, line.creditLimitCents ?? 1)} size="thin" color="var(--info)" label="Credit used" />
                <div className="field">
                  Amount
                  <Stepper value={`${num(toCr(lineValue))} CR`} decLabel="Less" incLabel="More" onDec={() => setLineAmount(Math.max(100_00, lineValue - lineStep))} onInc={() => setLineAmount(lineValue + lineStep)} />
                </div>
                <div className="row">
                  <button type="button" className="btn btn-secondary" disabled={busy || lineValue > lineRoom || line.arrearsCents > 0} onClick={() => void run(() => api('/credit-line/draw', { body: { amountCents: lineValue } }))}>Draw</button>
                  <button type="button" className="btn btn-ghost" disabled={busy || line.outstandingCents + line.arrearsCents === 0} onClick={() => void run(() => api('/credit-line/repay', { body: { amountCents: Math.min(lineValue, line.outstandingCents + line.arrearsCents) } }))}>Repay</button>
                </div>
                <span className="small muted">Interest {pct(line.dailyRate, 2)}/day on the drawn balance, charged at each close. The limit follows 30% of your last 7 days' revenue, reviewed weekly.</span>
              </>
            ) : (
              <>
                <div className="row-between"><span className="muted">Limit offered</span><span className="mono">{num(toCr(offers.creditLine.limitCents))} CR</span></div>
                <div className="row-between"><span className="muted">Rate</span><span className="mono">{pct(offers.creditLine.dailyRate, 2)}/day on what you draw</span></div>
                <button type="button" className="btn btn-secondary" disabled={busy || !offers.creditLine.available} onClick={() => void run(() => api('/credit-line', { body: {} }))}>Open line of credit</button>
                {offers.creditLine.reason && <span className="small muted">{offers.creditLine.reason}</span>}
              </>
            )}
          </Card>

          <Card title="Savings">
            <div className="row-between"><span className="muted">Balance</span><span className="mono">{dec(toCr(bank.savings.balanceCents))} CR</span></div>
            <div className="row-between"><span className="muted">Interest</span><span className="mono">{pct(bank.savings.dailyRate, 2)}/day up to {num(toCr(bank.savings.capCents))} CR</span></div>
            <div className="field">
              Amount
              <Stepper value={`${num(toCr(saveValue))} CR`} decLabel="Less" incLabel="More" onDec={() => setSaveAmount(Math.max(100_00, saveValue - 10_000_00))} onInc={() => setSaveAmount(saveValue + 10_000_00)} />
            </div>
            <div className="row">
              <button type="button" className="btn btn-secondary" disabled={busy || saveValue > cash * 100} onClick={() => void run(() => api('/savings/deposit', { body: { amountCents: saveValue } }))}>Deposit</button>
              <button type="button" className="btn btn-ghost" disabled={busy || saveValue > bank.savings.balanceCents} onClick={() => void run(() => api('/savings/withdraw', { body: { amountCents: saveValue } }))}>Withdraw</button>
            </div>
            <span className="small muted">A safe place for spare cash. Savings go to your debts first if the company ever enters receivership.</span>
          </Card>

          <Card title="Daily close">
            <div className="row-between"><span className="muted">Next close</span><span className="mono">in {duration(gameMinutesToClose)} game time</span></div>
            <div className="row-between"><span className="muted">Building upkeep</span><span className="mono">{dec(toCr(bank.upkeep.dailyCents))} / day</span></div>
            <div className="row-between"><span className="muted">Loan installments</span><span className="mono">{dec(toCr(dailyInstallments))} / day</span></div>
            <div className="row-between"><span className="muted">Overdraft</span><span className="mono">up to {num(toCr(bank.overdraft.limitCents))} CR · {pct(bank.overdraft.dailyRate, 1)}/day</span></div>
            <span className="small muted">Installments are taken first, then upkeep. If cash runs short the overdraft covers upkeep (+{num(toCr(bank.overdraft.drawFeeCents))} CR fee) and is repaid automatically.</span>
            {bank.devTools && (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void closeDayNow()} title="Development only">
                Run next daily close now (dev)
              </button>
            )}
          </Card>

          <Card title="Bank activity" style={{ gap: 4 }}>
            {bank.events.length === 0 && <p className="muted">Nothing yet.</p>}
            {bank.events.slice(0, 8).map((e) => (
              <div key={e.id} className="list-row">
                <span className="mono muted" style={{ width: 52 }}>D{e.day}</span>
                <span style={{ flex: 1 }}>{EVENT_LABEL[e.kind] ?? e.kind}{e.note ? ` · ${e.note}` : ''}</span>
                {e.amountCents > 0 && <span className="mono">{dec(toCr(e.amountCents))}</span>}
              </div>
            ))}
          </Card>
        </div>
      </section>

      <Card title="If a payment is missed">
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }} className="grid-auto-sm">
          {LADDER.map((s) => (
            <li key={s.title} className="inset stack-sm" style={{ borderTop: `3px solid ${s.color}`, gap: 4 }}>
              <span className="mono small muted">{s.when}</span>
              <strong>{s.title}</strong>
              <span className="small muted">{s.note}</span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
