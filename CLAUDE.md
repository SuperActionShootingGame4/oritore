# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

oritore is a self-portrait trading-card game. A creator uploads photos, the app turns each into a TCG-style card with a randomized rarity (N < HN < R < HR < SR < SSR < UR), stats, and stars, then bundles them into packs. Packs can be **published** to get a shareable public URL where anyone can spend a starting balance to buy packs, play an opening animation, swipe through cards, and sell duplicates. `oritore_spec.txt` (Japanese) is the product spec — treat it as intent, not as a description of current behavior (see "Spec vs. implementation" below).

## Commands

```bash
npm run dev            # backend only: tsx watch src/server.ts (port 3000)
npm run dev:frontend   # Vite dev server on :5173, proxies /api,/auth,/admin,/health -> :3000
npm run build          # tsc (server -> dist/) + vite build (frontend -> frontend/dist/)
npm start              # node dist/server.js (serves built frontend + API)
npm run typecheck      # type-checks BOTH tsconfig.server.json and frontend/tsconfig.json
```

Local development needs **two processes**: `npm run dev` and `npm run dev:frontend`, then open `http://localhost:5173`. There is no test runner and no linter configured — `npm run typecheck` is the only static check, so run it after changes.

## Architecture

Two independently-compiled TypeScript halves with separate tsconfigs:

- **Backend** (`src/server.ts`, `tsconfig.server.json`, NodeNext ESM): a single-file Express app. Compiles to `dist/`. In production it also serves `frontend/dist/` statically and falls back to `index.html` for any unmatched route (client-side routing).
- **Frontend** (`frontend/`, `frontend/tsconfig.json`, Bundler resolution, `noEmit`): the **entire React app lives in `frontend/src/main.tsx`** (~1000 lines) — all components, routing, game logic, and the rarity/value/weight tables are there. `frontend/src/styles.css` holds all styling. Vite `root` is `frontend/`.

### Routing splits the app into two modes
`main.tsx` `<App>` routes `/play/:packId` to `PublicPlayApp` (the published, third-party play experience that fetches a pack from the server) and everything else to `BuilderApp` (the creator: `CreatePack`, `OpenPack`, `Collection` tabs).

### Source of truth for game rules
The rarity ladder is defined in `main.tsx` and partly mirrored by the server's `/api/config`:
- `values` — sell price per rarity (N:1, HN:5, R:100, HR:300, SR:1000, SSR:3000, UR:10000)
- `weights` — drop-rate weights used by `weightedRarity()`
- `highRarities` (SR/SSR/UR) — triggers the premium pack-opening animation
- `packPrice` = 1 in code

### Persistence is split and inconsistent
- **Creator state** (built cards, balance, collection, published pack id) is persisted client-side in `localStorage` under key `oritore-state-v1` — there is no server-side user account.
- **Published packs** are written server-side to `data/packs.json` (a JSON object keyed by pack id). The id is a SHA-256 hash of the cards' content (`packIdFor`), so republishing identical cards is idempotent. Card images are stored inline as base64 `data:image/...` URLs, which is why `data/packs.json` is multi-megabyte and `express.json` is configured with a `60mb` limit.

### Publish flow
`BuilderApp` POSTs `{ cards }` to `/api/packs`; the server validates 1–30 cards, **verifies each card's HMAC `sig`** (see anti-cheat below), requires every `image` to be a `data:image/` URL, normalizes fields, and returns `{ id, publicPath: "/play/:id" }`. `PublicPlayApp` GETs `/api/packs/:id`.

### Server-authoritative card generation + X (Twitter) auth (anti-cheat)
Card stats (rarity/stars/atk/def/value) are **generated on the server**, not in the browser — this is what makes the follower-based rarity floor tamper-proof:
- `POST /api/cards/generate` rolls the stats. The rarity **floor** comes from the caller's verified follower count (`rarityFloor`): 1k→HN, 10k→R, 100k→HR, 1M→SR. The response is HMAC-signed (`signCard`, key = `APP_SECRET`) and the frontend stores `sig` on the card.
- `POST /api/packs` recomputes each card's signature and rejects any card whose `sig` is missing/invalid or whose rarity is below its verified floor. So a tampered localStorage card cannot be published.
- Follower count comes from the user authenticating **their own** X account via OAuth 2.0 (PKCE): `GET /auth/twitter/login` → X → `GET /auth/twitter/callback` reads `GET /2/users/me?user.fields=public_metrics`, then sets a signed httpOnly cookie `x_verify` and `postMessage`s the result to the opener popup. `/api/cards/generate` reads that cookie. Login is optional (no login → floor N). The rarity logic is **duplicated** in `src/server.ts` and `frontend/src/main.tsx` (separate tsconfigs) — keep the two in sync. Note `weightedRarity` in the frontend still drives pack-opening pulls (`pickPack`); only card *creation* moved server-side.

### X OAuth setup (required for the follower feature)
Configure via env (`.env`, see `.env.example`): `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`, `APP_SECRET`. The npm `dev`/`start` scripts load `.env` via Node's `--env-file-if-exists`. In the X Developer Portal: Web App / **confidential** client, OAuth 2.0 on, scopes `users.read tweet.read`, Callback URL must match `X_REDIRECT_URI` exactly (dev: `http://localhost:3000/auth/twitter/callback`). **Caveat:** reading `users/me` + `public_metrics` may not be in X's free tier (could require the paid Basic plan); the callback returns a friendly error if X responds 403/453.

## Docker / deployment

`Dockerfile` does a two-stage build (build → runtime). The runtime image exposes port 3000 and serves both API and static frontend. **Mount a persistent volume at `/app/data`** so `data/packs.json` survives container restarts. Required env vars at runtime: `APP_SECRET`, and optionally `X_CLIENT_ID`/`X_CLIENT_SECRET`/`X_REDIRECT_URI` for the follower feature, plus `PORT` (default 3000). `template/` contains card-frame and pack-art PNG assets plus sample JPEG images used for manual testing — they are not imported by the app at runtime.

## Spec vs. implementation (important)

`oritore_spec.txt` and `db/schema.sql` describe an intended design that is partly **not** what the code does. Don't assume these are wired up:
- **SQLite is not used.** `db/schema.sql` defines `packs`/`cards` tables and the spec mentions `data/app.sqlite3` + `data/sessions.sqlite3`, but no SQLite driver is in `package.json`; the server uses `data/packs.json` instead.
- **`/auth/twitter/*` now exists** (X OAuth, added above) and is proxied by Vite; **`/admin` is still proxied but unimplemented**.
- **Pack price** is 400 in the spec but `1` in both `/api/config` and the frontend.

If you implement spec features (real DB, accounts, auth), reconcile these deliberately rather than trusting one source.
