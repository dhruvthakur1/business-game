# Mercantile web client

React 18 + TypeScript + Vite frontend for the Mercantile tycoon game. It implements the design canvas
(`../design/canvas`) as working screens backed by demo data.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # economy formula tests (Vitest)
npm run typecheck
npm run build
```

## Layout

| Path | What lives there |
|---|---|
| `src/styles/tokens.css` | Design tokens: colors, tiers, leagues, type, spacing, radii, motion |
| `src/styles/global.css` | Base styles and component classes (`.card`, `.btn-*`, `.option`, `.bar`…) |
| `src/components/` | `AppShell` (sidebar, top bar, mobile tab bar, toasts), `PlotMap` (isometric plots), `ui.tsx` (chips, stat tiles, progress, stepper, segmented control, quality frame), `Icon` |
| `src/lib/economy.ts` | Pure game formulas: net/day, upgrade cost, admin overhead, quality cap, EMI, credit score, rate tiers, reliability, contest points, value check, income tax, freight, prestige |
| `src/lib/format.ts` | Number, trend and duration formatting |
| `src/data/` | Catalog (products, building types, registered designs), demo company state, contests, luxury art gallery, brand logos |
| `src/state/game.tsx` | Client game store: cash, wallet, buildings with a demo clock (1 s = 1 game minute), loans, toasts |
| `src/screens/` | Landing, Onboarding, Headquarters, BuildingDetail, Market, Contracts, Designer, Research, Bank, Leagues, Contests, Showroom, Catalog |
| `public/art/` | Building and product SVGs copied from `../design/buildings` and `../design/products` |

## Routes

`/` landing · `/start` onboarding · `/app` headquarters · `/app/buildings/:id` · `/app/market` ·
`/app/contracts?tab=active|rfq|dir` · `/app/designer` · `/app/research` · `/app/bank` · `/app/leagues` ·
`/app/contests/:id` · `/app/showroom` · `/app/catalog`

Below 900 px the sidebar becomes a bottom tab bar.

## Server connection

`src/state/game.tsx` talks to the API in `../server` (via the Vite proxy on `/api`) for the company, cash,
buildings and jobs, warehouse, ledger activity, exchange orders and NPC trades. It polls `/api/me` every 5 s
and re-renders job progress every second. The session token is kept in `localStorage`.

Formulas and catalog data come from `../shared`, the same code the server uses.

Research (`/app/research`) and the product designer (`/app/designer`) are server-backed. Branded designs are
registered from `/api/me` so `productById` can name and draw them anywhere; building pages offer a recipe picker
when the company has designs for that building.

The Showroom (`/app/showroom`) runs on `/api/wealth`: wallet, salary, dividends and withdrawals with a tax preview,
luxury purchases and buyback, prestige and the trophy cabinet. The HQ cash-flow chart (`src/components/CashflowChart.tsx`)
reads `/api/cashflow`.

Retail building pages (`src/screens/RetailPanel.tsx`) set the Supermarket shelf with a live sales and revenue
preview, or manage Luxury Store listings. The Showroom lists every player Luxury Store's stock for wallet purchases.

The Season pass (`/app/season`) and the sidebar season box read `/api/season` and `/api/me`: tiers, rewards to
claim, and titles to equip.

Sample data is left only on the marketing landing page.
