import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db';
import { freshDb } from './helpers';

let db: Db;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  db = await freshDb();
  app = buildApp(db);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe('HTTP API', () => {
  it('serves the catalog publicly', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/catalog' });
    expect(res.statusCode).toBe(200);
    expect(res.json().buildingTypes.find((b: { id: string }) => b.id === 'farm').buildCost).toBe(30_000);
  });

  it('requires a session for company routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('runs the onboarding flow over HTTP', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/companies', payload: { name: 'Api Test Holdings', region: 'north' } });
    expect(created.statusCode).toBe(201);
    const { token } = created.json();
    const auth = { authorization: `Bearer ${token}` };

    const dup = await app.inject({ method: 'POST', url: '/api/companies', payload: { name: 'api test holdings' } });
    expect(dup.statusCode).toBe(409);

    const farm = await app.inject({ method: 'POST', url: '/api/buildings', headers: auth, payload: { typeId: 'farm' } });
    expect(farm.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: '/api/npc/buy', headers: auth, payload: { productId: 'seeds', qty: 60 } });
    await app.inject({ method: 'POST', url: '/api/npc/buy', headers: auth, payload: { productId: 'fertilizer', qty: 20 } });
    const start = await app.inject({ method: 'POST', url: `/api/buildings/${farm.json().id}/start`, headers: auth, payload: {} });
    expect(start.statusCode).toBe(200);

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth });
    const body = me.json();
    expect(body.cashCents).toBe(100_000_00 - 30_000_00 - 152_00 - 120_00);
    expect(body.buildings).toHaveLength(1);
    expect(body.buildings[0].job.outputQty).toBe(100);

    const activity = await app.inject({ method: 'GET', url: '/api/activity', headers: auth });
    expect(activity.json().items.map((i: { kind: string }) => i.kind)).toContain('starting_capital');
  });

  it('validates input and returns readable errors', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/companies', payload: { name: 'Validation Co' } });
    const auth = { authorization: `Bearer ${created.json().token}` };
    const bad = await app.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: { productId: 'flour', side: 'buy', qty: -5, priceCents: 800 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/qty/);
    const poor = await app.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: { productId: 'gold_bar', side: 'buy', qty: 1000, priceCents: 95000 } });
    expect(poor.statusCode).toBe(409);
    expect(poor.json().error.code).toBe('insufficient_funds');
  });
});
