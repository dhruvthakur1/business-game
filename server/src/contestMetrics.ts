import type { ContestId, Division } from '../../shared/leagues';
import { reliability } from './contracts';
import type { Tx } from './db';
import { assetsCents, debtCents, operatingFlowCents } from './state';
import { gameDay } from './time';

type Q = Pick<Tx, 'query'>;

export interface MetricLine {
  what: string;
  why: string;
  value: string;
  counted: boolean;
}

export interface MetricResult {
  metric: number;
  eligible: boolean;
  reason?: string;
  lines: MetricLine[];
}

export interface MetricContext {
  companyId: string;
  from: Date;
  to: Date;
  division: Division;
  startNetWorthCents: number;
}

/** Exchange and contract prices outside 0.85–1.15× reference are excluded from trade-based contests. */
const BAND = { min: 0.85, max: 1.15 };
const MARGIN_MIN_REVENUE_CR = 20_000;
const NEWCOMER_MAX_AGE_DAYS = 30;
const SUPPLIER_MIN_RELIABILITY = 70;
const SUPPLIER_MIN_BUYERS = 3;

const cr = (cents: number) => cents / 100;
const fmt = (n: number, digits = 0) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const line = (what: string, why: string, value: string, counted = true): MetricLine => ({ what, why, value, counted });

const inBand = `t.price_cents BETWEEN ${BAND.min} * COALESCE(r.price_cents, p.ref_price_cents) AND ${BAND.max} * COALESCE(r.price_cents, p.ref_price_cents)`;

export async function computeMetric(q: Q, contest: ContestId, ctx: MetricContext): Promise<MetricResult> {
  const { companyId: me, from, to } = ctx;
  switch (contest) {
    case 'industry': {
      const r = await q.query<{ name: string; total: number; jobs: number }>(
        `SELECT bt.name, SUM(j.value_add_cents)::bigint AS total, COUNT(*)::int AS jobs
         FROM production_jobs j JOIN buildings b ON b.id = j.building_id JOIN building_types bt ON bt.id = b.building_type_id
         WHERE b.company_id = $1 AND j.state = 'collected' AND j.collected_at >= $2 AND j.collected_at < $3
         GROUP BY bt.name ORDER BY total DESC`,
        [me, from, to],
      );
      const total = r.rows.reduce((s, x) => s + Number(x.total), 0);
      return {
        metric: cr(total),
        eligible: true,
        lines: r.rows.length
          ? r.rows.slice(0, 5).map((x) => line(x.name, `${x.jobs} job${x.jobs === 1 ? '' : 's'} collected`, `+${fmt(cr(Number(x.total)))}`))
          : [line('No jobs collected this week', 'Collect finished production to score', '0', false)],
      };
    }

    case 'harvest_sprint': {
      const [npc, contracts, levels] = await Promise.all([
        q.query<{ qty: number }>(
          `SELECT COALESCE(SUM(l.qty), 0)::bigint AS qty FROM npc_sale_log l JOIN products p ON p.id = l.product_id
           WHERE l.company_id = $1 AND p.tier = 'T1' AND l.created_at >= $2 AND l.created_at < $3`, [me, from, to]),
        q.query<{ qty: number }>(
          `SELECT COALESCE(SUM(c.qty), 0)::bigint AS qty FROM contract_deliveries d JOIN contracts c ON c.id = d.contract_id JOIN products p ON p.id = c.product_id
           WHERE c.seller_id = $1 AND p.tier = 'T1' AND d.status = 'settled' AND d.delivered_at >= $2 AND d.delivered_at < $3`, [me, from, to]),
        q.query<{ levels: number }>(
          `SELECT COALESCE(SUM(b.level), 0)::int AS levels FROM buildings b JOIN building_types bt ON bt.id = b.building_type_id
           WHERE b.company_id = $1 AND bt.tag = 'T1'`, [me]),
      ]);
      const units = Number(npc.rows[0].qty) + Number(contracts.rows[0].qty);
      const lv = levels.rows[0].levels;
      return {
        metric: lv > 0 ? units / lv : 0,
        eligible: lv > 0,
        reason: lv > 0 ? undefined : 'Needs at least one T1 (agricultural) building',
        lines: [
          line('Sold to NPC buyers', 'T1 products', fmt(Number(npc.rows[0].qty))),
          line('Delivered under contracts', 'T1 products, settled', fmt(Number(contracts.rows[0].qty))),
          line('Exchange sales', 'Not counted in this contest', '—', false),
          line('Per building level', `${fmt(units)} units ÷ ${lv} T1 levels`, lv ? fmt(units / lv, 1) : '—', lv > 0),
        ],
      };
    }

    case 'margin_master': {
      const [npc, tradesSold, tradesBought, cSold, cBought, ledger] = await Promise.all([
        q.query<{ v: number }>('SELECT COALESCE(SUM(proceeds_cents), 0)::bigint AS v FROM npc_sale_log WHERE company_id = $1 AND created_at >= $2 AND created_at < $3', [me, from, to]),
        q.query<{ v: number }>('SELECT COALESCE(SUM(price_cents * qty - fee_cents), 0)::bigint AS v FROM trades WHERE seller_id = $1 AND created_at >= $2 AND created_at < $3', [me, from, to]),
        q.query<{ v: number }>('SELECT COALESCE(SUM(price_cents * qty), 0)::bigint AS v FROM trades WHERE buyer_id = $1 AND created_at >= $2 AND created_at < $3', [me, from, to]),
        q.query<{ v: number }>(
          `SELECT COALESCE(SUM(d.funded_cents - d.fee_cents), 0)::bigint AS v FROM contract_deliveries d JOIN contracts c ON c.id = d.contract_id
           WHERE c.seller_id = $1 AND d.status = 'settled' AND d.delivered_at >= $2 AND d.delivered_at < $3`, [me, from, to]),
        q.query<{ v: number }>(
          `SELECT COALESCE(SUM(d.funded_cents), 0)::bigint AS v FROM contract_deliveries d JOIN contracts c ON c.id = d.contract_id
           WHERE c.buyer_id = $1 AND d.status = 'settled' AND d.delivered_at >= $2 AND d.delivered_at < $3`, [me, from, to]),
        q.query<{ kind: string; v: number }>(
          `SELECT t.kind, COALESCE(-SUM(e.amount_cents), 0)::bigint AS v
           FROM ledger_entries e JOIN ledger_txns t ON t.id = e.txn_id JOIN accounts a ON a.id = e.account_id
           WHERE a.company_id = $1 AND a.kind = 'cash' AND t.kind IN ('op_cost', 'upkeep', 'npc_purchase') AND t.created_at >= $2 AND t.created_at < $3
           GROUP BY t.kind`, [me, from, to]),
      ]);
      const revenue = Number(npc.rows[0].v) + Number(tradesSold.rows[0].v) + Number(cSold.rows[0].v);
      const opex = ledger.rows.reduce((s, x) => s + Number(x.v), 0);
      const costs = opex + Number(tradesBought.rows[0].v) + Number(cBought.rows[0].v);
      const margin = revenue > 0 ? (revenue - costs) / revenue : 0;
      const gate = revenue >= MARGIN_MIN_REVENUE_CR * 100;
      return {
        metric: Math.max(0, margin),
        eligible: gate,
        reason: gate ? undefined : `Needs ${fmt(MARGIN_MIN_REVENUE_CR)} CR revenue this week (you have ${fmt(cr(revenue))})`,
        lines: [
          line('Revenue', 'NPC sales, exchange and contract proceeds after fees', fmt(cr(revenue))),
          line('Operating costs', 'Op costs, upkeep and NPC input purchases', `−${fmt(cr(opex))}`),
          line('Goods bought', 'Exchange purchases and contract deliveries received', `−${fmt(cr(Number(tradesBought.rows[0].v) + Number(cBought.rows[0].v)))}`),
          line('Margin', gate ? 'Above the volume gate' : 'Below the 20,000 CR volume gate', `${fmt(margin * 100, 1)}%`, gate),
        ],
      };
    }

    case 'reliable_supplier': {
      const rows = await q.query<{ contract_id: string; buyer: string; buyer_id: string; product: string; value: number; late: boolean; in_band: boolean; breached: boolean }>(
        `SELECT c.id AS contract_id, b.name AS buyer, c.buyer_id, p.name AS product, d.funded_cents AS value, d.late_hours > 0 AS late,
                c.price_cents BETWEEN ${BAND.min} * COALESCE(r.price_cents, p.ref_price_cents) AND ${BAND.max} * COALESCE(r.price_cents, p.ref_price_cents) AS in_band,
                EXISTS (SELECT 1 FROM contract_deliveries x WHERE x.contract_id = c.id AND x.status = 'breached' AND x.resolved_at >= $2 AND x.resolved_at < $3) AS breached
         FROM contract_deliveries d JOIN contracts c ON c.id = d.contract_id JOIN companies b ON b.id = c.buyer_id
         JOIN products p ON p.id = c.product_id LEFT JOIN reference_prices r ON r.product_id = p.id
         WHERE c.seller_id = $1 AND d.status = 'settled' AND d.delivered_at >= $2 AND d.delivered_at < $3`,
        [me, from, to],
      );
      const byContract = new Map<string, { buyer: string; product: string; value: number; n: number; late: number; inBand: boolean; breached: boolean; buyerId: string }>();
      for (const r of rows.rows) {
        const cur = byContract.get(r.contract_id) ?? { buyer: r.buyer, product: r.product, value: 0, n: 0, late: 0, inBand: r.in_band, breached: r.breached, buyerId: r.buyer_id };
        cur.value += Number(r.value) * (r.late ? 0.5 : 1);
        cur.n += 1;
        if (r.late) cur.late += 1;
        byContract.set(r.contract_id, cur);
      }
      let metric = 0;
      const buyers = new Set<string>();
      const lines: MetricLine[] = [];
      for (const c of byContract.values()) {
        const ok = c.inBand && !c.breached;
        if (ok) {
          metric += c.value;
          buyers.add(c.buyerId);
        }
        lines.push(line(
          `${c.product} to ${c.buyer}`,
          !c.inBand ? 'Price outside 0.85–1.15× reference: excluded' : c.breached ? 'Contract breached this week: excluded' : `${c.n} deliver${c.n === 1 ? 'y' : 'ies'}${c.late ? `, ${c.late} late at 50%` : ', all on time'}`,
          ok ? `+${fmt(cr(c.value))}` : '0',
          ok,
        ));
      }
      const rel = await reliability(q, me);
      const reasons: string[] = [];
      if (rel.score < SUPPLIER_MIN_RELIABILITY) reasons.push(`reliability ${rel.score} is below ${SUPPLIER_MIN_RELIABILITY}`);
      if (buyers.size < SUPPLIER_MIN_BUYERS) reasons.push(`${buyers.size} of ${SUPPLIER_MIN_BUYERS} unique buyers`);
      if (lines.length === 0) lines.push(line('No contract deliveries this week', 'Deliver on time to score', '0', false));
      return { metric: cr(metric), eligible: reasons.length === 0, reason: reasons.length ? `Not eligible yet: ${reasons.join('; ')}` : undefined, lines };
    }

    case 'power_rush': {
      const [ex, outBand, con] = await Promise.all([
        q.query<{ qty: number }>(
          `SELECT COALESCE(SUM(t.qty), 0)::bigint AS qty FROM trades t JOIN products p ON p.id = t.product_id LEFT JOIN reference_prices r ON r.product_id = p.id
           WHERE t.seller_id = $1 AND t.product_id = 'mwh' AND t.created_at >= $2 AND t.created_at < $3 AND ${inBand}`, [me, from, to]),
        q.query<{ qty: number }>(
          `SELECT COALESCE(SUM(t.qty), 0)::bigint AS qty FROM trades t JOIN products p ON p.id = t.product_id LEFT JOIN reference_prices r ON r.product_id = p.id
           WHERE t.seller_id = $1 AND t.product_id = 'mwh' AND t.created_at >= $2 AND t.created_at < $3 AND NOT (${inBand})`, [me, from, to]),
        q.query<{ qty: number }>(
          `SELECT COALESCE(SUM(c.qty), 0)::bigint AS qty FROM contract_deliveries d JOIN contracts c ON c.id = d.contract_id
           WHERE c.seller_id = $1 AND c.product_id = 'mwh' AND d.status = 'settled' AND d.delivered_at >= $2 AND d.delivered_at < $3`, [me, from, to]),
      ]);
      const metric = Number(ex.rows[0].qty) + Number(con.rows[0].qty);
      return {
        metric,
        eligible: true,
        lines: [
          line('Sold on the exchange', 'Within 0.85–1.15× reference', `${fmt(Number(ex.rows[0].qty))} MWh`),
          line('Delivered under contracts', 'Settled deliveries', `${fmt(Number(con.rows[0].qty))} MWh`),
          ...(Number(outBand.rows[0].qty) ? [line('Off-price exchange sales', 'Outside 0.85–1.15× reference: excluded', `${fmt(Number(outBand.rows[0].qty))} MWh`, false)] : []),
        ],
      };
    }

    case 'quality_quest': {
      const [ex, con, npc] = await Promise.all([
        q.query<{ qty: number }>(
          `SELECT COALESCE(SUM(t.qty), 0)::bigint AS qty FROM trades t JOIN products p ON p.id = t.product_id LEFT JOIN reference_prices r ON r.product_id = p.id
           WHERE t.seller_id = $1 AND t.quality >= 2 AND t.created_at >= $2 AND t.created_at < $3 AND ${inBand}`, [me, from, to]),
        q.query<{ qty: number }>(
          `SELECT COALESCE(SUM(c.qty), 0)::bigint AS qty FROM contract_deliveries d JOIN contracts c ON c.id = d.contract_id
           WHERE c.seller_id = $1 AND d.status = 'settled' AND d.delivered_quality >= 2 AND d.delivered_at >= $2 AND d.delivered_at < $3`, [me, from, to]),
        q.query<{ qty: number }>('SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM npc_sale_log WHERE company_id = $1 AND quality >= 2 AND created_at >= $2 AND created_at < $3', [me, from, to]),
      ]);
      const parts = [Number(ex.rows[0].qty), Number(con.rows[0].qty), Number(npc.rows[0].qty)];
      return {
        metric: parts[0] + parts[1] + parts[2],
        eligible: true,
        lines: [
          line('Exchange sales at Q2+', 'Within 0.85–1.15× reference', fmt(parts[0])),
          line('Contract deliveries at Q2+', 'Settled', fmt(parts[1])),
          line('NPC sales at Q2+', 'All NPC buyers', fmt(parts[2])),
        ],
      };
    }

    case 'balance_sheet': {
      const now = (await assetsCents(q, me)) - (await debtCents(q, me));
      const delta = now - ctx.startNetWorthCents;
      return {
        metric: Math.max(0, cr(delta)),
        eligible: true,
        lines: [
          line('Net worth at week start', 'Assets − debt when you joined this week', fmt(cr(ctx.startNetWorthCents))),
          line('Net worth now', 'Assets − debt', fmt(cr(now))),
          line('Growth', delta >= 0 ? 'Counted' : 'Shrinking scores 0', `${delta >= 0 ? '+' : '−'}${fmt(Math.abs(cr(delta)))}`, delta > 0),
        ],
      };
    }

    case 'newcomer_cup': {
      const c = (await q.query<{ created_day: number }>('SELECT created_day FROM companies WHERE id = $1', [me])).rows[0];
      const age = gameDay(to.getTime()) - c.created_day;
      const flow = await operatingFlowCents(q, me, from, to);
      const ok = age < NEWCOMER_MAX_AGE_DAYS;
      return {
        metric: Math.max(0, cr(flow)),
        eligible: ok,
        reason: ok ? undefined : `Only companies younger than ${NEWCOMER_MAX_AGE_DAYS} game days (yours: ${age})`,
        lines: [
          line('Company age', ok ? 'Eligible' : 'Too old for the Newcomer Cup', `${age} days`, ok),
          line('Operating cash flow', 'Sales − purchases − op costs − upkeep', `${flow >= 0 ? '+' : '−'}${fmt(Math.abs(cr(flow)))}`, flow > 0),
        ],
      };
    }
  }
}
