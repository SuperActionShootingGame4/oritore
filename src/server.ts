import cors from "cors";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT ?? 3000);
const dataDir = path.resolve(__dirname, "../data");
const packsFile = path.join(dataDir, "packs.json");

// --- X (Twitter) OAuth 2.0 config (set via environment / .env) ---
const X_CLIENT_ID = process.env.X_CLIENT_ID ?? "";
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET ?? "";
const X_REDIRECT_URI = process.env.X_REDIRECT_URI ?? `http://localhost:${port}/auth/twitter/callback`;
const X_SCOPES = "users.read tweet.read";
// Secret used to HMAC-sign the verification cookie and authoritative card stats.
const APP_SECRET = process.env.APP_SECRET ?? "dev-insecure-secret-change-me";
const isProd = process.env.NODE_ENV === "production";

// --- Rarity logic (mirrors frontend/src/main.tsx; keep the two in sync) ---
type Rarity = "N" | "HN" | "R" | "HR" | "SR" | "SSR" | "UR";
const rarities: Rarity[] = ["N", "HN", "R", "HR", "SR", "SSR", "UR"];
const weights: Record<Rarity, number> = { N: 50, HN: 28, R: 14, HR: 5, SR: 2, SSR: 0.8, UR: 0.2 };
const values: Record<Rarity, number> = { N: 1, HN: 5, R: 100, HR: 300, SR: 1000, SSR: 3000, UR: 10000 };
const starRanges: Record<Rarity, [number, number]> = {
  N: [1, 2],
  HN: [2, 3],
  R: [3, 4],
  HR: [4, 5],
  SR: [5, 6],
  SSR: [6, 7],
  UR: [7, 8]
};

// Follower count raises the minimum rarity (floor).
function rarityFloor(followers: number): Rarity {
  if (followers >= 1_000_000) return "SR";
  if (followers >= 100_000) return "HR";
  if (followers >= 10_000) return "R";
  if (followers >= 1_000) return "HN";
  return "N";
}

// Weighted rarity pick restricted to rarities at or above the floor.
function weightedRarity(floor: Rarity): Rarity {
  const pool = rarities.slice(rarities.indexOf(floor));
  const total = pool.reduce((sum, rarity) => sum + weights[rarity], 0);
  let ticket = Math.random() * total;
  for (const rarity of pool) {
    ticket -= weights[rarity];
    if (ticket <= 0) return rarity;
  }
  return pool[pool.length - 1];
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function roundTo50(value: number) {
  return String(Math.min(3000, Math.max(0, Math.round(value / 50) * 50)));
}

function generateStats(floor: Rarity) {
  const rarity = weightedRarity(floor);
  const [minStars, maxStars] = starRanges[rarity];
  const stars = randomInt(minStars, maxStars);
  const statMin = stars * 230;
  const statMax = Math.min(3000, stars * 375);
  return {
    rarity,
    stars,
    atk: roundTo50(randomInt(statMin, statMax)),
    def: roundTo50(randomInt(statMin, statMax)),
    value: values[rarity]
  };
}

// --- HMAC signing helpers ---
function sign(payload: string): string {
  return crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// The signature binds the server-authoritative card fields so the client cannot tamper with them.
type SignableCard = {
  rarity: string;
  stars: number;
  atk: string;
  def: string;
  value: number;
  twitter: string;
  followers: number;
};

function signCard(card: SignableCard): string {
  return sign([card.rarity, card.stars, card.atk, card.def, card.value, card.twitter, card.followers].join("|"));
}

// --- Cookie helpers (express has res.cookie built in; we parse the request header ourselves) ---
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

type Verification = { username: string; followers: number; exp: number };

function makeVerifyCookie(v: Verification): string {
  const body = Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function readVerifyCookie(raw: string | undefined): Verification | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot === -1) return null;
  const body = raw.slice(0, dot);
  if (!safeEqual(raw.slice(dot + 1), sign(body))) return null;
  try {
    const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Verification;
    if (typeof v.followers !== "number" || typeof v.exp !== "number") return null;
    if (Date.now() > v.exp) return null;
    return v;
  } catch {
    return null;
  }
}

// Short-lived PKCE store keyed by state (single instance; entries expire after 10 min).
const pkceStore = new Map<string, { codeVerifier: string; createdAt: number }>();
function prunePkce() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, entry] of pkceStore) if (entry.createdAt < cutoff) pkceStore.delete(state);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}

// Popup page that hands the (non-secret) result back to the opener and closes itself.
// The signed proof itself lives in the httpOnly cookie, not in this message.
function popupHtml(data: { username?: string; followers?: number; error?: string }): string {
  const json = JSON.stringify({ type: "x-auth", ...data }).replace(/</g, "\\u003c");
  const message = data.error ? escapeHtml(data.error) : "認証が完了しました。ウィンドウを閉じています…";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;padding:24px;color:#222">
<p>${message}</p>
<script>
  try { if (window.opener) window.opener.postMessage(${json}, "*"); } catch (e) {}
  setTimeout(function () { window.close(); }, ${data.error ? 3000 : 400});
</script>
</body></html>`;
}

app.use(cors());
app.use(express.json({ limit: "60mb" }));

type PublishedCard = {
  id: string;
  name: string;
  image: string;
  rarity: string;
  value: number;
  stars: number;
  atk: string;
  def: string;
  flavor: string;
  cardNo: string;
  creator: string;
  twitter: string;
  twitterUrl: string;
};

type PublishedPack = {
  id: string;
  cards: PublishedCard[];
  createdAt: string;
  updatedAt: string;
};

async function readPacks(): Promise<Record<string, PublishedPack>> {
  try {
    return JSON.parse(await fs.readFile(packsFile, "utf8")) as Record<string, PublishedPack>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writePacks(packs: Record<string, PublishedPack>) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(packsFile, JSON.stringify(packs, null, 2));
}

function packIdFor(cards: PublishedCard[]) {
  const hash = crypto.createHash("sha256");
  for (const card of cards) {
    hash.update(card.name);
    hash.update(card.image);
    hash.update(card.rarity);
    hash.update(card.cardNo);
  }
  return hash.digest("hex").slice(0, 16);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "oritore", version: "1.0.0" });
});

app.get("/api/config", (_req, res) => {
  res.json({
    startingBalance: 1000,
    packPrice: 1,
    cardsPerPack: 5,
    rarities,
    twitterAuthEnabled: Boolean(X_CLIENT_ID)
  });
});

// Step 1 of OAuth: redirect the user to X with a PKCE challenge.
app.get("/auth/twitter/login", (_req, res) => {
  if (!X_CLIENT_ID) {
    res.status(500).send(popupHtml({ error: "X OAuthが未設定です（X_CLIENT_ID を設定してください）。" }));
    return;
  }
  prunePkce();
  const state = crypto.randomBytes(16).toString("hex");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  pkceStore.set(state, { codeVerifier, createdAt: Date.now() });

  const url = new URL("https://twitter.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", X_CLIENT_ID);
  url.searchParams.set("redirect_uri", X_REDIRECT_URI);
  url.searchParams.set("scope", X_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  res.redirect(url.toString());
});

// Step 2 of OAuth: exchange the code, read the user's own follower count, set a signed cookie.
app.get("/auth/twitter/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  const entry = state ? pkceStore.get(state) : undefined;
  if (state) pkceStore.delete(state);
  if (!code || !entry) {
    res.status(400).send(popupHtml({ error: "認証に失敗しました（stateが一致しません）。" }));
    return;
  }

  try {
    const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64")
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: X_REDIRECT_URI,
        code_verifier: entry.codeVerifier,
        client_id: X_CLIENT_ID
      })
    });
    if (!tokenRes.ok) {
      res.status(200).send(popupHtml({ error: "アクセストークンの取得に失敗しました。" }));
      return;
    }
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) {
      res.status(200).send(popupHtml({ error: "アクセストークンが取得できませんでした。" }));
      return;
    }

    const meRes = await fetch("https://api.twitter.com/2/users/me?user.fields=public_metrics", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (meRes.status === 403 || meRes.status === 453) {
      res.status(200).send(
        popupHtml({ error: "フォロワー数の取得はX APIの無料枠では許可されていません（Basicプランが必要な可能性があります）。" })
      );
      return;
    }
    if (!meRes.ok) {
      res.status(200).send(popupHtml({ error: "ユーザー情報の取得に失敗しました。" }));
      return;
    }

    const me = (await meRes.json()) as {
      data?: { username?: string; public_metrics?: { followers_count?: number } };
    };
    const username = String(me.data?.username ?? "");
    const followers = Number(me.data?.public_metrics?.followers_count ?? 0);

    res.cookie("x_verify", makeVerifyCookie({ username, followers, exp: Date.now() + 60 * 60 * 1000 }), {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 60 * 60 * 1000,
      path: "/"
    });
    res.status(200).send(popupHtml({ username, followers }));
  } catch {
    res.status(200).send(popupHtml({ error: "認証処理中にエラーが発生しました。" }));
  }
});

// Server-authoritative card stat generation. Rarity floor comes from the verified follower count.
app.post("/api/cards/generate", (req, res) => {
  const verification = readVerifyCookie(parseCookies(req.headers.cookie)["x_verify"]);
  const followers = verification?.followers ?? 0;
  const twitter = verification?.username ?? "";
  const floor = rarityFloor(followers);
  const stats = generateStats(floor);
  const card: SignableCard = { ...stats, twitter, followers };
  res.json({ ...card, floor, sig: signCard(card) });
});

app.post("/api/packs", async (req, res, next) => {
  try {
    const cards = req.body?.cards;
    if (!Array.isArray(cards) || cards.length < 1 || cards.length > 30) {
      res.status(400).json({ error: "cards must contain 1 to 30 items" });
      return;
    }

    // Anti-cheat: every card's authoritative stats must carry a valid server signature,
    // and its rarity must respect the floor justified by the verified follower count.
    for (const card of cards) {
      const probe: SignableCard = {
        rarity: String(card.rarity ?? ""),
        stars: Number(card.stars ?? 0),
        atk: String(card.atk ?? ""),
        def: String(card.def ?? ""),
        value: Number(card.value ?? 0),
        twitter: String(card.twitter ?? ""),
        followers: Number(card.followers ?? 0)
      };
      if (typeof card.sig !== "string" || !safeEqual(card.sig, signCard(probe))) {
        res.status(400).json({ error: "card signature invalid (tampered or unsigned card)" });
        return;
      }
      if (rarities.indexOf(probe.rarity as Rarity) < rarities.indexOf(rarityFloor(probe.followers))) {
        res.status(400).json({ error: "card rarity below the verified follower floor" });
        return;
      }
    }

    const normalized: PublishedCard[] = cards.map((card, index) => ({
      id: String(card.id ?? `card-${index}`),
      name: String(card.name ?? `card-${index + 1}`),
      image: String(card.image ?? ""),
      rarity: String(card.rarity ?? "N"),
      value: Number(card.value ?? 1),
      stars: Math.max(1, Math.min(8, Number(card.stars ?? 1))),
      atk: String(card.atk ?? "0"),
      def: String(card.def ?? "0"),
      flavor: String(card.flavor ?? ""),
      cardNo: String(card.cardNo ?? ""),
      creator: String(card.creator ?? ""),
      twitter: String(card.twitter ?? ""),
      twitterUrl: card.twitter ? `https://x.com/${String(card.twitter)}` : ""
    }));

    if (normalized.some((card) => !card.image.startsWith("data:image/"))) {
      res.status(400).json({ error: "all card images must be image data URLs" });
      return;
    }

    const packs = await readPacks();
    const id = packIdFor(normalized);
    const now = new Date().toISOString();
    packs[id] = {
      id,
      cards: normalized,
      createdAt: packs[id]?.createdAt ?? now,
      updatedAt: now
    };
    await writePacks(packs);

    res.json({ id, publicPath: `/play/${id}` });
  } catch (error) {
    next(error);
  }
});

app.get("/api/packs/:id", async (req, res, next) => {
  try {
    const packs = await readPacks();
    const pack = packs[req.params.id];
    if (!pack) {
      res.status(404).json({ error: "pack not found" });
      return;
    }
    res.json(pack);
  } catch (error) {
    next(error);
  }
});

const frontendDist = path.resolve(__dirname, "../frontend/dist");
app.use(express.static(frontendDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"));
});

app.listen(port, () => {
  console.log(`oritore server listening on http://localhost:${port}`);
});
