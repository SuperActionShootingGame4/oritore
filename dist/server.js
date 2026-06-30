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
app.use(cors());
app.use(express.json({ limit: "60mb" }));
async function readPacks() {
    try {
        return JSON.parse(await fs.readFile(packsFile, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return {};
        throw error;
    }
}
async function writePacks(packs) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(packsFile, JSON.stringify(packs, null, 2));
}
function packIdFor(cards) {
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
        rarities: ["N", "HN", "R", "HR", "SR", "SSR", "UR"]
    });
});
app.post("/api/packs", async (req, res, next) => {
    try {
        const cards = req.body?.cards;
        if (!Array.isArray(cards) || cards.length < 1 || cards.length > 30) {
            res.status(400).json({ error: "cards must contain 1 to 30 items" });
            return;
        }
        const normalized = cards.map((card, index) => ({
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
            creator: String(card.creator ?? "")
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
    }
    catch (error) {
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
    }
    catch (error) {
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
