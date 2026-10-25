import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, setToken, getToken, toCr } from '../api/client';
import type { ActivityItem, CollectResult, MeResponse, PlaceOrderResult, ServerBuilding } from '../api/types';
import { buildingTypeById, productById, registerDesigns } from '../data/catalog';
import type { Building } from '../data/types';
import { netPerDay, type Quality } from '../lib/economy';
import { dec, num } from '../lib/format';
import { PLOT_COLS } from '../../../shared/catalog';
import { unlocksAt } from '../../../shared/levels';
import { cycleOutput, opCostSplit } from '../../../shared/regions';

export type ToastTone = 'ok' | 'info' | 'bad';
export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
}

export type SessionStatus = 'loading' | 'signedOut' | 'ready' | 'offline';

/** Level-scaled net/day at reference prices in the home region (yield bonus, wage index), for list views. */
function estimatedNet(typeId: string, level: number, region: string) {
  const t = buildingTypeById(typeId);
  if (!t.outputs[0]) return 0;
  return netPerDay({
    output: { qty: cycleOutput(t.outputs[0].qty, level, region, t.id), price: productById(t.outputs[0].productId).refPrice },
    inputs: t.inputs.map((i) => ({ qty: i.qty * level, price: productById(i.productId).refPrice })),
    opCost: opCostSplit(t.opCost * level, region).total,
    upkeepPerDay: t.upkeepPerDay * level,
    cyclesPerDay: 24 / t.cycleHours,
  });
}

/** Converts a server building + the current time into the view model the screens use. */
function toView(b: ServerBuilding, now: number, timeScale: number, region: string): Building {
  const base = { id: b.id, typeId: b.typeId, name: b.name, level: b.level, plot: { col: b.plot % PLOT_COLS, row: Math.floor(b.plot / PLOT_COLS) }, netPerDay: estimatedNet(b.typeId, b.level, region) };
  if (!b.job) return { ...base, status: 'idle', progress: 0, minutesLeft: 0 };
  const start = Date.parse(b.job.startedAt);
  const end = Date.parse(b.job.finishesAt);
  if (now >= end) {
    return {
      ...base,
      status: 'ready',
      progress: 1,
      minutesLeft: 0,
      readyOutput: b.job.outputProduct ? { productId: b.job.outputProduct, qty: b.job.outputQty, quality: b.job.outputQuality as Quality } : undefined,
    };
  }
  return { ...base, status: 'running', progress: (now - start) / (end - start), minutesLeft: ((end - now) * timeScale) / 60_000 };
}

interface GameApi {
  status: SessionStatus;
  me: MeResponse | null;
  company: MeResponse['company'] | null;
  cash: number;
  netWorth: number;
  operatingCashFlow7d: number;
  buildings: Building[];
  ready: Building[];
  inventory: MeResponse['inventory'];
  activity: ActivityItem[];
  /** Game minutes per real minute (server TIME_SCALE). */
  timeScale: number;
  refresh: () => Promise<void>;
  signInDemo: () => Promise<void>;
  /** Creates an account and its company. Throws ApiError so forms can show the message by the right field. */
  signUp: (input: { email: string; password: string; companyName: string; region: string }) => Promise<void>;
  /** Throws ApiError (wrong password, too many attempts). */
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  collect: (ids?: string[]) => Promise<void>;
  startJob: (buildingId: string, inputQuality?: number) => Promise<boolean>;
  upgrade: (buildingId: string) => Promise<void>;
  buyBuilding: (typeId: string) => Promise<string | null>;
  npcBuy: (productId: string, qty: number) => Promise<boolean>;
  npcSell: (productId: string, qty: number, quality: number) => Promise<boolean>;
  placeOrder: (o: { productId: string; side: 'buy' | 'sell'; qty: number; priceCents: number; quality: number }) => Promise<PlaceOrderResult | null>;
  cancelOrder: (orderId: string) => Promise<void>;

  /** Runs an API call with error toasts and a state refresh afterwards. */
  act: <T>(fn: () => Promise<T>) => Promise<T | null>;

  /** Owner's personal wallet, CR (kept apart from company cash). */
  wallet: number;

  toasts: Toast[];
  notify: (title: string, body?: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
}

const GameContext = createContext<GameApi | null>(null);
let toastSeq = 0;

const POLL_MS = 5000;

export function GameProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>(getToken() ? 'loading' : 'signedOut');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [now, setNow] = useState(Date.now());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const clockSkew = useRef(0);
  const lastLevel = useRef<{ company: string; level: number } | null>(null);

  const notify = useCallback((title: string, body?: string, tone: ToastTone = 'ok') => {
    const toast = { id: ++toastSeq, title, body, tone };
    setToasts((t) => [...t.slice(-2), toast]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toast.id)), 4500);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setStatus('signedOut');
      setMe(null);
      return;
    }
    try {
      const [state, act] = await Promise.all([api<MeResponse>('/me'), api<{ items: ActivityItem[] }>('/activity')]);
      clockSkew.current = Date.parse(state.serverTime) - Date.now();
      const prev = lastLevel.current;
      if (prev && prev.company === state.company.id && state.company.level > prev.level) {
        const unlocked = Array.from({ length: state.company.level - prev.level }, (_, i) => unlocksAt(prev.level + 1 + i)).flat();
        notify(`Level up! Lv ${state.company.level}`, unlocked.length ? `Unlocked: ${unlocked.join(', ')}.` : 'Keep producing and trading to reach the next unlock.', 'info');
      }
      lastLevel.current = { company: state.company.id, level: state.company.level };
      registerDesigns(state.designs);
      setMe(state);
      setActivity(act.items);
      setStatus('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        setMe(null);
        setStatus('signedOut');
      } else if (err instanceof ApiError && err.code === 'offline') {
        setStatus('offline');
      } else {
        // A transient server error: keep showing the last good state and retry on the next poll.
        console.warn('Refresh failed', err);
      }
    }
  }, [notify]);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  /** Runs an API action, shows its error as a toast, refreshes state afterwards. */
  const act = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      try {
        const result = await fn();
        return result;
      } catch (err) {
        if (err instanceof ApiError) {
          notify(err.code === 'offline' ? 'Server offline' : 'Couldn’t do that', err.message, 'bad');
          if (err.status === 401) setStatus('signedOut');
          return null;
        }
        throw err;
      } finally {
        void refresh();
      }
    },
    [notify, refresh],
  );

  const timeScale = me?.timeScale ?? 1;
  const serverNow = now + clockSkew.current;
  const buildings = useMemo(() => (me ? me.buildings.map((b) => toView(b, serverNow, timeScale, me.company.region)) : []), [me, serverNow, timeScale]);
  const ready = useMemo(() => buildings.filter((b) => b.status === 'ready'), [buildings]);

  const value: GameApi = {
    status,
    me,
    company: me?.company ?? null,
    cash: me ? toCr(me.cashCents) : 0,
    netWorth: me ? toCr(me.netWorthCents) : 0,
    operatingCashFlow7d: me ? toCr(me.operatingCashFlow7dCents) : 0,
    buildings,
    ready,
    inventory: me?.inventory ?? [],
    activity,
    timeScale,
    refresh,

    signInDemo: async () => {
      const res = await act(() => api<{ token: string }>('/session/demo', { method: 'POST', body: {} }));
      if (res) {
        setToken(res.token);
        setStatus('loading');
        await refresh();
      }
    },
    signUp: async (input) => {
      const res = await api<{ token: string }>('/auth/signup', { body: input });
      setToken(res.token);
      await refresh();
    },
    signIn: async (email, password) => {
      const res = await api<{ token: string }>('/auth/signin', { body: { email, password } });
      setToken(res.token);
      setStatus('loading');
      await refresh();
    },
    signOut: async () => {
      // End the session on the server too; sign out locally even if the server can't be reached.
      await api('/auth/signout', { body: {} }).catch(() => undefined);
      setToken(null);
      setMe(null);
      setStatus('signedOut');
    },

    collect: async (ids) => {
      const res = await act(() => api<CollectResult>('/collect', { body: { buildingIds: ids, restart: true } }));
      if (!res || res.collected.length === 0) return;
      const shelves = res.collected.filter((c) => c.retail);
      const goods = res.collected.filter((c) => !c.researchFamily && !c.retail).map((c) => `${num(c.qty)} ${productById(c.productId).name.toLowerCase()}`).join(', ');
      const rp = res.collected.filter((c) => c.researchFamily).reduce((s, c) => s + c.qty, 0);
      const stalled = res.collected.filter((c) => !c.restarted).length;
      const xp = res.collected.reduce((s, c) => s + c.xp, 0);
      notify(
        `Collected ${res.collected.length} job${res.collected.length > 1 ? 's' : ''}${xp ? ` · +${num(xp)} XP` : ''}`,
        `${goods ? `${goods} added to your warehouse.` : ''}${shelves.map((c) => ` Shoppers bought ${num(c.retail!.sold)} ${productById(c.productId).name.toLowerCase()} for ${dec(toCr(c.retail!.proceedsCents))} CR.`).join('')}${rp ? ` ${num(rp)} research points applied to your lab focus.` : ''}${stalled ? ` ${stalled} building${stalled > 1 ? 's' : ''} need inputs to restart.` : ' Jobs restarted.'}`,
      );
    },
    startJob: async (buildingId, inputQuality) => {
      const res = await act(() => api<{ finishesAt: string; outputQuality: number; stocked?: number; priceCents?: number }>(`/buildings/${buildingId}/start`, { body: { inputQuality } }));
      if (res?.stocked !== undefined) notify('Shelf stocked', `${num(res.stocked)} units at ${dec(toCr(res.priceCents ?? 0))} CR each. Sales settle when you collect.`);
      else if (res) notify('Production started', `Output will be Q${res.outputQuality}.`);
      return !!res;
    },
    upgrade: async (buildingId) => {
      const res = await act(() => api<{ level: number; costCents: number }>(`/buildings/${buildingId}/upgrade`, { body: {} }));
      if (res) notify(`Upgraded to Lv ${res.level}`, `Paid ${num(toCr(res.costCents))} CR.`);
    },
    buyBuilding: async (typeId) => {
      const res = await act(() => api<{ id: string; name: string }>('/buildings', { body: { typeId } }));
      if (res) notify(`${res.name} built`, 'Placed on your next free plot.');
      return res?.id ?? null;
    },
    npcBuy: async (productId, qty) => {
      const res = await act(() => api<{ costCents: number }>('/npc/buy', { body: { productId, qty } }));
      if (res) notify('Bought from NPC vendor', `${num(qty)} ${productById(productId).name.toLowerCase()} for ${dec(toCr(res.costCents))} CR.`);
      return !!res;
    },
    npcSell: async (productId, qty, quality) => {
      const res = await act(() => api<{ proceedsCents: number }>('/npc/sell', { body: { productId, qty, quality } }));
      if (res) notify('Sold to NPC buyers', `${num(qty)} ${productById(productId).name.toLowerCase()} for ${dec(toCr(res.proceedsCents))} CR.`);
      return !!res;
    },
    placeOrder: async (o) => {
      const res = await act(() => api<PlaceOrderResult>('/orders', { body: o }));
      if (res) {
        const filled = res.fills.reduce((s, f) => s + f.qty, 0);
        notify(
          res.status === 'filled' ? 'Order filled' : filled > 0 ? 'Order partly filled' : 'Order placed',
          filled > 0 ? `${num(filled)} filled · ${num(res.remaining)} resting on the book.` : `${num(res.remaining)} resting on the book.`,
          res.status === 'filled' ? 'ok' : 'info',
        );
      }
      return res;
    },
    cancelOrder: async (orderId) => {
      const res = await act(() => api<{ refundedQty: number }>(`/orders/${orderId}`, { method: 'DELETE' }));
      if (res) notify('Order cancelled', 'Escrow or goods returned.', 'info');
    },

    act,
    wallet: me ? toCr(me.walletCents) : 0,

    toasts,
    notify,
    dismiss,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameApi {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}
