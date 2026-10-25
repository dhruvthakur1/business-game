import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { BUILDING_TYPE_DEFS, PRODUCT_DEFS } from '../../shared/catalog';
import { config } from './config';
import { companyForToken, createCompany, createSession, REGIONS, type Company } from './companies';
import { type Db, withTx } from './db';
import { GameError, mapDbError, notFound } from './errors';
import { cancelOrder, marketSummary, myOrders, orderBook, placeOrder, priceHistory } from './exchange';
import { npcBuy, npcSell } from './npc';
import { buyBuilding, collect, setBuildingDesign, startJob, upgradeBuilding } from './production';
import { applyPoints, researchView, setFocus } from './research';
import { allDesigns, brandNameStatus, createDesign, designerView, registerBrand } from './brands';
import { buyItem, cashflowHistory, declareDividend, ownerWithdrawal, sellItem, setSalary, wealthView } from './wealth';
import { activity, companyState } from './state';
import { bankOverview, repayLoan, restructureLoan, takeLoan } from './bank';
import { closeNextDay } from './daily';
import { acceptContract, offerContract, rejectContract, terminateContract } from './contracts';
import { contractsView, processContracts, suppliers } from './contractWork';
import { awardRfq, cancelRfq, placeBid, postRfq, rfqBoard } from './rfq';
import { activeWeek, closeWeek, contestDetail, leagueOverview, runLeagueCycle, weekLabel } from './leagues';
import { companyAccount, systemAccount, transfer } from './ledger';

declare module 'fastify' {
  interface FastifyRequest {
    company: Company;
  }
}

const PUBLIC = new Set(['/api/health', '/api/catalog', '/api/market', '/api/companies', '/api/session/demo']);
const isPublic = (req: FastifyRequest) =>
  PUBLIC.has(req.routeOptions.url ?? '') || (req.method === 'GET' && (req.routeOptions.url ?? '').startsWith('/api/market/'));

const productId = z.string().min(1).max(40);
const uuid = z.string().uuid();

export function buildApp(db: Db, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err, req, reply) => {
    const mapped = mapDbError(err);
    if (mapped instanceof GameError) return reply.status(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'bad_request', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong on the server.' } });
  });

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || isPublic(req)) return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const company = token ? await companyForToken(db, token) : null;
    if (!company) return reply.status(401).send({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
    req.company = company;
  });

  // ---------- Public ----------
  app.get('/api/health', async () => ({ ok: true, timeScale: config.timeScale }));
  app.get('/api/catalog', async () => ({ products: PRODUCT_DEFS, buildingTypes: BUILDING_TYPE_DEFS, designs: await allDesigns(db) }));
  app.get('/api/market', async () => ({ products: await marketSummary(db) }));
  app.get('/api/market/:productId', async (req) => {
    const id = productId.parse((req.params as { productId: string }).productId);
    const [book, history, trades] = await Promise.all([
      orderBook(db, id),
      priceHistory(db, id),
      db.query('SELECT price_cents, qty, quality, created_at FROM trades WHERE product_id = $1 ORDER BY id DESC LIMIT 20', [id]),
    ]);
    return {
      productId: id,
      book,
      history,
      trades: trades.rows.map((t) => ({ priceCents: t.price_cents, qty: t.qty, quality: t.quality, at: (t.created_at as Date).toISOString() })),
    };
  });

  app.post('/api/companies', async (req, reply) => {
    const body = z.object({ name: z.string(), region: z.enum(REGIONS).default('north') }).parse(req.body);
    const created = await createCompany(db, body);
    return reply.status(201).send(created);
  });

  app.post('/api/session/demo', async (_req, reply) => {
    if (!config.demoLogin) throw notFound('Demo login');
    const res = await db.query<{ id: string }>("SELECT id FROM companies WHERE name = 'Northwind Holdings' AND NOT is_npc");
    if (!res.rows[0]) throw new GameError(404, 'no_demo', 'Demo company not seeded. Run npm run seed in server/.');
    const token = await withTx(db, (tx) => createSession(tx, res.rows[0].id));
    return reply.status(201).send({ token });
  });

  // ---------- Signed in ----------
  app.get('/api/me', async (req) => companyState(db, req.company));
  app.get('/api/activity', async (req) => ({ items: await activity(db, req.company.id) }));

  app.post('/api/buildings', async (req, reply) => {
    const body = z.object({ typeId: z.string(), plot: z.number().int().optional() }).parse(req.body);
    const result = await withTx(db, (tx) => buyBuilding(tx, req.company.id, body.typeId, body.plot));
    return reply.status(201).send(result);
  });

  app.post('/api/buildings/:id/start', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z.object({ inputQuality: z.number().int().min(0).max(5).optional() }).parse(req.body ?? {});
    return withTx(db, (tx) => startJob(tx, req.company.id, id, body));
  });

  app.post('/api/buildings/:id/upgrade', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    return withTx(db, (tx) => upgradeBuilding(tx, req.company.id, id));
  });

  app.post('/api/collect', async (req) => {
    const body = z.object({ buildingIds: z.array(uuid).optional(), restart: z.boolean().default(true) }).parse(req.body ?? {});
    return { collected: await withTx(db, (tx) => collect(tx, req.company.id, body)) };
  });

  app.get('/api/orders', async (req) => ({ orders: await myOrders(db, req.company.id) }));

  app.post('/api/orders', async (req, reply) => {
    const body = z
      .object({ productId, side: z.enum(['buy', 'sell']), qty: z.number().int().positive(), priceCents: z.number().int().positive(), quality: z.number().int().min(0).max(5).default(0) })
      .parse(req.body);
    const result = await withTx(db, (tx) => placeOrder(tx, req.company.id, body));
    return reply.status(201).send(result);
  });

  app.delete('/api/orders/:id', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    return withTx(db, (tx) => cancelOrder(tx, req.company.id, id));
  });

  app.post('/api/npc/buy', async (req) => {
    const body = z.object({ productId, qty: z.number().int().positive() }).parse(req.body);
    return withTx(db, (tx) => npcBuy(tx, req.company.id, body.productId, body.qty));
  });

  app.post('/api/npc/sell', async (req) => {
    const body = z.object({ productId, qty: z.number().int().positive(), quality: z.number().int().min(0).max(5).default(0) }).parse(req.body);
    return withTx(db, (tx) => npcSell(tx, req.company.id, body.productId, body.qty, body.quality));
  });

  // ---------- Bank & upkeep ----------
  app.get('/api/bank', async (req) => bankOverview(db, req.company.id, { devTools: config.demoLogin }));

  app.post('/api/loans', async (req, reply) => {
    const body = z
      .object({ product: z.enum(['starter', 'term']), principalCents: z.number().int().positive().optional(), days: z.number().int().positive().optional() })
      .parse(req.body);
    const result = await withTx(db, (tx) => takeLoan(tx, req.company.id, body));
    return reply.status(201).send(result);
  });

  app.post('/api/loans/:id/repay', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    return withTx(db, (tx) => repayLoan(tx, req.company.id, id));
  });

  app.post('/api/loans/:id/restructure', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    return withTx(db, (tx) => restructureLoan(tx, req.company.id, id));
  });

  app.post('/api/upkeep/pay', async (req) =>
    withTx(db, async (tx) => {
      const row = await tx.query<{ upkeep_arrears_cents: number }>('SELECT upkeep_arrears_cents FROM companies WHERE id = $1 FOR UPDATE', [req.company.id]);
      const arrears = Number(row.rows[0].upkeep_arrears_cents);
      const cash = await companyAccount(tx, req.company.id, 'cash');
      const balance = (await tx.query<{ balance_cents: number }>('SELECT balance_cents FROM accounts WHERE id = $1', [cash])).rows[0].balance_cents;
      const pay = Math.min(arrears, balance);
      if (pay > 0) await transfer(tx, 'upkeep', 'Unpaid upkeep settled', cash, await systemAccount(tx, 'sink:upkeep'), pay);
      await tx.query('UPDATE companies SET upkeep_arrears_cents = upkeep_arrears_cents - $2 WHERE id = $1', [req.company.id, pay]);
      return { paidCents: pay, remainingCents: arrears - pay };
    }),
  );

  // ---------- Contracts & RFQs ----------
  const terms = z.object({
    productId,
    qty: z.number().int().positive(),
    minQuality: z.number().int().min(0).max(5).default(0),
    priceCents: z.number().int().positive(),
    frequencyHours: z.number().int(),
    windowHours: z.number().int(),
    termDays: z.number().int(),
  });

  app.get('/api/contracts', async (req) => contractsView(db, req.company.id));

  app.post('/api/contracts', async (req, reply) => {
    const body = z.object({ counterpartyId: uuid, role: z.enum(['buy', 'sell']), terms }).parse(req.body);
    const result = await withTx(db, (tx) => offerContract(tx, req.company.id, body));
    return reply.status(201).send(result);
  });

  const contractAction = (path: string, fn: (tx: Parameters<Parameters<typeof withTx>[1]>[0], companyId: string, id: string) => Promise<unknown>) =>
    app.post(`/api/contracts/:id/${path}`, async (req) => {
      const id = uuid.parse((req.params as { id: string }).id);
      return withTx(db, (tx) => fn(tx, req.company.id, id));
    });
  contractAction('accept', (tx, c, id) => acceptContract(tx, c, id));
  contractAction('reject', (tx, c, id) => rejectContract(tx, c, id));
  contractAction('terminate', (tx, c, id) => terminateContract(tx, c, id));

  app.get('/api/suppliers', async (req) => {
    const q = z.object({ productId }).parse(req.query);
    return { suppliers: await suppliers(db, req.company.id, q.productId) };
  });

  app.get('/api/rfqs', async (req) => rfqBoard(db, req.company.id));

  app.post('/api/rfqs', async (req, reply) => {
    const body = z
      .object({
        productId, qty: z.number().int().positive(), minQuality: z.number().int().min(0).max(5).default(0),
        maxPriceCents: z.number().int().positive(), frequencyHours: z.number().int(), windowHours: z.number().int(),
        termDays: z.number().int(), minReliability: z.number().min(0).max(100).default(0),
      })
      .parse(req.body);
    const result = await withTx(db, (tx) => postRfq(tx, req.company.id, body));
    return reply.status(201).send(result);
  });

  app.post('/api/rfqs/:id/bids', async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z.object({ priceCents: z.number().int().positive() }).parse(req.body);
    const result = await withTx(db, (tx) => placeBid(tx, req.company.id, id, body.priceCents));
    return reply.status(201).send(result);
  });

  app.post('/api/rfqs/:id/award', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z.object({ bidId: uuid }).parse(req.body);
    return withTx(db, (tx) => awardRfq(tx, req.company.id, id, body.bidId));
  });

  app.post('/api/rfqs/:id/cancel', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    return withTx(db, (tx) => cancelRfq(tx, req.company.id, id));
  });

  // Development only: fast-forward this company's contracts by `hours` game hours (shifts their
  // delivery windows, offers and RFQ deadlines into the past), then process them at the real time.
  app.post('/api/dev/advance-contracts', async (req) => {
    if (!config.demoLogin) throw notFound('Route');
    const body = z.object({ hours: z.number().min(0).max(240).default(1) }).parse(req.body ?? {});
    const shift = `${Math.round((body.hours * 3_600_000) / config.timeScale)} milliseconds`;
    const me = req.company.id;
    await withTx(db, async (tx) => {
      await tx.query(
        `UPDATE contract_deliveries d SET window_start = window_start - $2::interval, window_end = window_end - $2::interval
         FROM contracts c WHERE c.id = d.contract_id AND (c.buyer_id = $1 OR c.seller_id = $1) AND d.status IN ('pending', 'funded')`,
        [me, shift],
      );
      await tx.query(
        `UPDATE contracts SET created_at = created_at - $2::interval, offer_expires_at = offer_expires_at - $2::interval,
           notice_ends_at = notice_ends_at - $2::interval
         WHERE (buyer_id = $1 OR seller_id = $1) AND status IN ('offered', 'active')`,
        [me, shift],
      );
      await tx.query(
        `UPDATE rfqs SET created_at = created_at - $2::interval, closes_at = closes_at - $2::interval
         WHERE status = 'open' AND (buyer_id = $1 OR id IN (SELECT rfq_id FROM rfq_bids WHERE seller_id = $1))`,
        [me, shift],
      );
    });
    return { processed: await processContracts(db) };
  });

  // ---------- Research ----------
  app.get('/api/research', async (req) => researchView(db, req.company.id));

  app.post('/api/research/focus', async (req) => {
    const body = z.object({ family: z.string().max(20).nullable() }).parse(req.body);
    return withTx(db, (tx) => setFocus(tx, req.company.id, body.family));
  });

  app.post('/api/research/apply', async (req) => {
    const body = z.object({ family: z.string().max(20), points: z.number().int().positive() }).parse(req.body);
    return withTx(db, (tx) => applyPoints(tx, req.company.id, body.family, body.points));
  });

  // ---------- Product designer & brands ----------
  app.get('/api/designer', async (req) => designerView(db, req.company.id));

  app.get('/api/brands/check', async (req) => {
    const q = z.object({ name: z.string().max(60) }).parse(req.query);
    const problem = await brandNameStatus(db, q.name);
    return { ok: problem === null, problem };
  });

  app.post('/api/brands', async (req, reply) => {
    const body = z.object({ name: z.string().max(60), logo: z.number().int() }).parse(req.body);
    const result = await withTx(db, (tx) => registerBrand(tx, req.company.id, body));
    return reply.status(201).send(result);
  });

  app.post('/api/designs', async (req, reply) => {
    const body = z
      .object({
        brandId: uuid,
        templateId: z.enum(['loaf', 'car', 'watch']),
        slots: z.record(z.string().max(20), z.number().int()),
        tier: z.enum(['basic', 'premium', 'luxury']),
        priceCents: z.number().int().positive(),
      })
      .parse(req.body);
    const result = await withTx(db, (tx) => createDesign(tx, req.company.id, body));
    return reply.status(201).send(result);
  });

  app.post('/api/buildings/:id/design', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z.object({ designId: z.string().max(40).nullable() }).parse(req.body);
    return withTx(db, (tx) => setBuildingDesign(tx, req.company.id, id, body.designId));
  });

  // ---------- Personal wealth ----------
  app.get('/api/wealth', async (req) => wealthView(db, req.company.id));
  app.get('/api/cashflow', async (req) => ({ days: await cashflowHistory(db, req.company.id, 7) }));

  app.post('/api/wealth/salary', async (req) => {
    const body = z.object({ salaryCents: z.number().int().min(0) }).parse(req.body);
    return withTx(db, (tx) => setSalary(tx, req.company.id, body.salaryCents));
  });

  app.post('/api/wealth/dividend', async (req) => {
    const body = z.object({ amountCents: z.number().int().positive() }).parse(req.body);
    return withTx(db, (tx) => declareDividend(tx, req.company.id, body.amountCents));
  });

  app.post('/api/wealth/withdraw', async (req) => {
    const body = z.object({ amountCents: z.number().int().positive() }).parse(req.body);
    return withTx(db, (tx) => ownerWithdrawal(tx, req.company.id, body.amountCents));
  });

  app.post('/api/wealth/items', async (req, reply) => {
    const body = z.object({ itemId: z.string().max(40) }).parse(req.body);
    const result = await withTx(db, (tx) => buyItem(tx, req.company.id, body.itemId));
    return reply.status(201).send(result);
  });

  app.post('/api/wealth/items/:itemId/sell', async (req) => {
    const itemId = z.string().max(40).parse((req.params as { itemId: string }).itemId);
    return withTx(db, (tx) => sellItem(tx, req.company.id, itemId));
  });

  // ---------- Leagues & contests ----------
  app.get('/api/leagues', async (req) => leagueOverview(db, req.company.id));
  app.get('/api/contests/:id', async (req) => contestDetail(db, req.company.id, z.string().max(40).parse((req.params as { id: string }).id)));

  // Development only: close the current league week now (promotion, relegation, prizes) and open the next.
  app.post('/api/dev/close-week', async () => {
    if (!config.demoLogin) throw notFound('Route');
    const w = await activeWeek(db);
    const result = w ? await closeWeek(db, w.week) : { closed: false };
    const next = await runLeagueCycle(db);
    return { ...result, closedWeek: w ? await weekLabel(db, w.week) : null, nextWeek: await weekLabel(db, next.week) };
  });

  // Development only: run the company's next daily close immediately.
  app.post('/api/dev/close-day', async (req) => {
    if (!config.demoLogin) throw notFound('Route');
    return closeNextDay(db, req.company.id);
  });

  return app;
}
