import React, { ChangeEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes, useParams } from "react-router-dom";
import { BadgeDollarSign, Box, ChevronRight, Coins, Copy, ImagePlus, Layers, Save, Sparkles, Trash2 } from "lucide-react";
import "./styles.css";

type Rarity = "N" | "HN" | "R" | "HR" | "SR" | "SSR" | "UR";

type Card = {
  id: string;
  name: string;
  image: string;
  rarity: Rarity;
  value: number;
  stars: number;
  atk: string;
  def: string;
  flavor: string;
  cardNo: string;
  creator: string;
  packId?: string;
  twitter?: string;
  followers?: number;
  sig?: string;
};

type PackDef = {
  id: string;
  name: string;
  image: string;
};

type PulledCard = Card & {
  pullId: string;
};

const rarities: Rarity[] = ["N", "HN", "R", "HR", "SR", "SSR", "UR"];
const values: Record<Rarity, number> = { N: 1, HN: 5, R: 100, HR: 300, SR: 1000, SSR: 3000, UR: 10000 };
const weights: Record<Rarity, number> = { N: 50, HN: 28, R: 14, HR: 5, SR: 2, SSR: 0.8, UR: 0.2 };
const highRarities = new Set<Rarity>(["SR", "SSR", "UR"]);
const storageKey = "oritore-state-v1";
const packPrice = 1;

type StoredState = {
  cards: Card[];
  balance: number;
  collection: PulledCard[];
  packs: PackDef[];
  publishedPackId?: string;
};

type CardForm = Pick<Card, "name" | "image" | "flavor" | "creator">;

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Downscale + re-encode uploads so multiple images fit in localStorage (and shrink published packs).
async function downscaleImage(file: File, maxDim = 768, quality = 0.82): Promise<string> {
  const dataUrl = await fileToDataUrl(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("image decode failed"));
      image.src = dataUrl;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return dataUrl;
  }
}

function readStoredState(): StoredState {
  const fallback: StoredState = { cards: [], balance: 1000, collection: [], packs: [] };
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function weightedRarity() {
  const total = rarities.reduce((sum, rarity) => sum + weights[rarity], 0);
  let ticket = Math.random() * total;
  for (const rarity of rarities) {
    ticket -= weights[rarity];
    if (ticket <= 0) return rarity;
  }
  return "N";
}

// Card stats (rarity/stars/atk/def) are generated server-side via POST /api/cards/generate
// so the follower-based rarity floor cannot be tampered with. See src/server.ts.
function floorLabel(followers: number) {
  if (followers >= 1_000_000) return "SR以上";
  if (followers >= 100_000) return "HR以上";
  if (followers >= 10_000) return "R以上";
  if (followers >= 1_000) return "HN以上";
  return "制限なし";
}

function blankCardForm(overrides: Partial<CardForm> = {}): CardForm {
  return {
    name: "",
    image: "",
    flavor: "",
    creator: "marin",
    ...overrides
  };
}

function nextCardNumber(cards: Card[]) {
  const maxNumber = cards.reduce((max, card) => {
    const number = Number.parseInt(card.cardNo, 10);
    return Number.isFinite(number) ? Math.max(max, number) : max;
  }, 0);
  return String(maxNumber + 1);
}

function pickPack(pool: Card[]) {
  const byRarity = new Map<Rarity, Card[]>();
  for (const rarity of rarities) byRarity.set(rarity, pool.filter((card) => card.rarity === rarity));

  return Array.from({ length: 5 }, () => {
    const rarity = weightedRarity();
    const choices = byRarity.get(rarity) ?? pool;
    const card = choices[Math.floor(Math.random() * choices.length)] ?? pool[0];
    return { ...card, pullId: uid("pull") };
  });
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/play/:packId" element={<PublicPlayApp />} />
        <Route path="*" element={<BuilderApp />} />
      </Routes>
    </BrowserRouter>
  );
}

function BuilderApp() {
  const [cards, setCards] = useState<Card[]>(() => readStoredState().cards);
  const [balance, setBalance] = useState(() => readStoredState().balance);
  const [collection, setCollection] = useState<PulledCard[]>(() => readStoredState().collection);
  const [publishedPackId, setPublishedPackId] = useState<string | undefined>(() => readStoredState().publishedPackId);
  const [publishStatus, setPublishStatus] = useState<"idle" | "publishing" | "ready" | "error">(() =>
    readStoredState().publishedPackId ? "ready" : "idle"
  );
  const [xAuth, setXAuth] = useState<{ username: string; followers: number } | null>(null);
  const [packs, setPacks] = useState<PackDef[]>(() => readStoredState().packs);
  const publicUrl = publishedPackId ? `${window.location.origin}/play/${publishedPackId}` : "";

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || data.type !== "x-auth") return;
      if (data.error) {
        setXAuth(null);
        window.alert(String(data.error));
        return;
      }
      setXAuth({ username: String(data.username ?? ""), followers: Number(data.followers ?? 0) });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ cards, balance, collection, packs, publishedPackId }));
    } catch (error) {
      console.warn("ローカル保存に失敗しました（保存容量の上限超過の可能性）", error);
    }
  }, [cards, balance, collection, packs, publishedPackId]);

  useEffect(() => {
    if (cards.length === 0) {
      setPublishedPackId(undefined);
      setPublishStatus("idle");
      return;
    }

    const controller = new AbortController();
    setPublishStatus("publishing");
    const firstPackId = cards.find(c => c.packId)?.packId;
    const firstPack = firstPackId ? packs.find(p => p.id === firstPackId) : undefined;
    const packImage = firstPack?.image;
    const packName = firstPack?.name;
    fetch("/api/packs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards, ...(packImage ? { packImage } : {}), ...(packName ? { packName } : {}) }),
      signal: controller.signal
    })
      .then((response) => {
        if (!response.ok) throw new Error("publish failed");
        return response.json() as Promise<{ id: string }>;
      })
      .then((data) => {
        setPublishedPackId(data.id);
        setPublishStatus("ready");
      })
      .catch((error) => {
        if (error.name !== "AbortError") setPublishStatus("error");
      });

    return () => controller.abort();
  }, [cards]);

  return (
    <div className="app-shell with-publish-bar">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">O</div>
          <div>
            <h1>oritore</h1>
            <p>selfie trading pack</p>
          </div>
        </div>
        <nav>
          <NavLink to="/" end>
            <ImagePlus size={18} /> カード登録
          </NavLink>
          <NavLink to="/packs">
            <Layers size={18} /> パック登録
          </NavLink>
          <NavLink to="/open">
            <Box size={18} /> パック開封
          </NavLink>
        </nav>
        <div className="wallet">
          <Coins size={18} />
          <span>所持金</span>
          <strong>{balance.toLocaleString()}円</strong>
        </div>
      </aside>
      <main>
        <Routes>
          <Route path="/" element={<CreatePack cards={cards} setCards={setCards} xAuth={xAuth} packs={packs} />} />
          <Route path="/packs" element={<PackRegister packs={packs} setPacks={setPacks} />} />
          <Route
            path="/open"
            element={
              <OpenPack
                cardPool={cards}
                balance={balance}
                setBalance={setBalance}
                collection={collection}
                setCollection={setCollection}
                packs={packs}
              />
            }
          />
        </Routes>
      </main>
      <PublishBar publicUrl={publicUrl} status={publishStatus} cardCount={cards.length} />
    </div>
  );
}

function PublicPlayApp() {
  const { packId } = useParams();
  const [cards, setCards] = useState<Card[]>([]);
  const [packImage, setPackImage] = useState<string | undefined>(undefined);
  const [packName, setPackName] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [balance, setBalance] = useState(1000);
  const [collection, setCollection] = useState<PulledCard[]>([]);

  useEffect(() => {
    if (!packId) return;
    fetch(`/api/packs/${packId}`)
      .then((response) => {
        if (!response.ok) throw new Error("pack not found");
        return response.json() as Promise<{ cards?: Card[]; packImage?: string; packName?: string }>;
      })
      .then((pack) => {
        setCards(pack.cards ?? []);
        setPackImage(pack.packImage);
        setPackName(pack.packName);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, [packId]);

  if (status === "loading") {
    return <div className="public-message">パックを読み込み中です</div>;
  }

  if (status === "error") {
    return <div className="public-message">公開パックが見つかりません</div>;
  }

  return (
    <main className="public-shell">
      <OpenPack
        cardPool={cards}
        balance={balance}
        setBalance={setBalance}
        collection={collection}
        setCollection={setCollection}
        packImage={packImage}
        packName={packName}
        publicOnly
      />
    </main>
  );
}

function PackRegister({
  packs,
  setPacks
}: {
  packs: PackDef[];
  setPacks: React.Dispatch<React.SetStateAction<PackDef[]>>;
}) {
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const canAdd = name.trim() !== "" && Boolean(image);

  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const dataUrl = await downscaleImage(file);
    setImage(dataUrl);
    event.target.value = "";
  }

  function addPack() {
    if (!canAdd) return;
    setPacks((current) => [{ id: uid("pack"), name: name.trim(), image }, ...current]);
    setName("");
    setImage("");
  }

  function removePack(id: string) {
    setPacks((current) => current.filter((pack) => pack.id !== id));
  }

  return (
    <section className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">STEP 1</p>
          <h2>パック登録</h2>
        </div>
        <button className="primary-button" type="button" onClick={addPack} disabled={!canAdd}>
          <Save size={18} />
          パック登録
        </button>
      </header>

      <div className="card-editor">
        <form className="card-form" onSubmit={(event) => event.preventDefault()}>
          <label className="wide-field">
            パック名
            <input value={name} placeholder="パック名を入力" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="wide-field">
            パック画像
            <span className="file-picker">
              <ImagePlus size={17} />
              画像を選択
              <input type="file" accept="image/*" onChange={onUpload} />
            </span>
          </label>
        </form>
        <div className="template-preview">
          <div className="pack-art-card">
            {image ? <img src={image} alt="" /> : <div className="image-placeholder">PACK IMAGE</div>}
            <strong>{name || "パック名"}</strong>
          </div>
        </div>
      </div>

      {packs.length === 0 ? (
        <div className="empty-state">
          <Layers size={42} />
          <h3>パックを登録</h3>
          <p>パック名と画像を登録すると、カード登録時にパックをリストから選べるようになります。</p>
        </div>
      ) : (
        <div className="registered-cards">
          <div className="section-title">
            <h3>登録済みパック</h3>
          </div>
          <div className="pack-gallery">
            {packs.map((pack) => (
              <div className="registered-card" key={pack.id}>
                <div className="pack-art-card">
                  {pack.image ? <img src={pack.image} alt="" /> : <div className="image-placeholder">PACK IMAGE</div>}
                  <strong>{pack.name}</strong>
                </div>
                <button className="icon-button" type="button" aria-label="削除" onClick={() => removePack(pack.id)}>
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function CreatePack({
  cards,
  setCards,
  xAuth,
  packs
}: {
  cards: Card[];
  setCards: React.Dispatch<React.SetStateAction<Card[]>>;
  xAuth: { username: string; followers: number } | null;
  packs: PackDef[];
}) {
  const [form, setForm] = useState<CardForm>(() => blankCardForm());
  const [packId, setPackId] = useState("");
  const [saving, setSaving] = useState(false);
  const canSave =
    Boolean(form.image) &&
    form.name.trim() !== "" &&
    form.flavor.trim() !== "" &&
    packId !== "" &&
    cards.length < 30 &&
    !saving;
  const nextCardNo = nextCardNumber(cards);
  const previewCard: Card = { ...form, id: "preview", cardNo: nextCardNo, rarity: "N", value: 0, stars: 0, atk: "???", def: "???" };

  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const image = await downscaleImage(file);
    setForm((current) => ({ ...current, image }));
    event.target.value = "";
  }

  function updateForm<K extends keyof CardForm>(key: K, value: CardForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function saveCard() {
    if (!canSave) return;
    setSaving(true);
    try {
      const response = await fetch("/api/cards/generate", { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("generate failed");
      const generated = (await response.json()) as {
        rarity: Rarity;
        stars: number;
        atk: string;
        def: string;
        value: number;
        twitter: string;
        followers: number;
        sig: string;
      };
      setCards((current) => [
        {
          ...form,
          id: uid("card"),
          cardNo: nextCardNumber(current),
          packId,
          rarity: generated.rarity,
          stars: generated.stars,
          atk: generated.atk,
          def: generated.def,
          value: generated.value,
          twitter: generated.twitter,
          followers: generated.followers,
          sig: generated.sig
        },
        ...current
      ]);
      setForm((current) => ({ ...blankCardForm({ creator: current.creator }) }));
    } catch {
      window.alert("カードの生成に失敗しました。時間をおいて再度お試しください。");
    } finally {
      setSaving(false);
    }
  }

  function loginWithX() {
    window.open("/auth/twitter/login", "xauth", "width=600,height=720");
  }

  function removeCard(id: string) {
    setCards((current) => current.filter((card) => card.id !== id));
  }

  return (
    <section className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">STEP 1</p>
          <h2>カード登録モード</h2>
        </div>
      </header>

      <div className="summary-strip">
        <Metric icon={<Layers size={18} />} label="登録カード" value={`${cards.length}/30枚`} />
        <Metric icon={<Sparkles size={18} />} label="能力値" value="登録時に生成" />
        <Metric icon={<Box size={18} />} label="1パック" value="5枚" />
      </div>

      <div className="x-auth-row">
        {xAuth ? (
          <div className="x-auth-badge">
            <a href={`https://x.com/${xAuth.username}`} target="_blank" rel="noreferrer">
              @{xAuth.username}
            </a>
            <span>フォロワー {xAuth.followers.toLocaleString()}</span>
            <span className="x-auth-floor">最低レアリティ {floorLabel(xAuth.followers)}</span>
          </div>
        ) : (
          <button className="secondary-button" type="button" onClick={loginWithX}>
            <BadgeDollarSign size={18} /> Xでログインしてレアリティ強化
          </button>
        )}
      </div>

      <div className="card-editor">
        <form className="card-form" onSubmit={(event) => event.preventDefault()}>
          <label className="wide-field">
            パック
            <select value={packId} onChange={(event) => setPackId(event.target.value)} disabled={packs.length === 0}>
              <option value="">{packs.length === 0 ? "パック未登録（先にパック登録）" : "パックを選択"}</option>
              {packs.map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {pack.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            カード名
            <input value={form.name} placeholder="カード名を入力" onChange={(event) => updateForm("name", event.target.value)} />
          </label>
          <label>
            カード画像
            <span className="file-picker">
              <ImagePlus size={17} />
              画像を選択
              <input type="file" accept="image/*" onChange={onUpload} />
            </span>
          </label>
          <label>
            作成者
            <input value={form.creator} onChange={(event) => updateForm("creator", event.target.value)} />
          </label>
          <label className="wide-field">
            カードフレイバー
            <textarea value={form.flavor} placeholder="カードフレイバーを入力" onChange={(event) => updateForm("flavor", event.target.value)} rows={4} />
          </label>
          <button className="primary-button" type="button" onClick={saveCard} disabled={!canSave}>
            <Save size={18} />
            {saving ? "生成中…" : "カード登録"}
          </button>
        </form>
        <div className="template-preview">
          <TradingCard card={previewCard} total={packId ? cards.filter(c => c.packId === packId).length + 1 : cards.length + 1} packName={packId ? packs.find(p => p.id === packId)?.name : undefined} concealStats />
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="empty-state">
          <ImagePlus size={42} />
          <h3>カードを1枚ずつ登録</h3>
          <p>画像とパラメータを入れると、オリカテンプレートでパック用カードとして保存できます。</p>
        </div>
      ) : (
        <div className="registered-cards">
          <div className="section-title">
            <h3>登録済みカード</h3>
          </div>
          <div className="card-gallery">
            {cards.map((card) => (
              <div className="registered-card" key={card.id}>
                <TradingCard card={card} total={cards.filter(c => c.packId === card.packId).length} packName={packs.find(p => p.id === card.packId)?.name} onRemove={() => removeCard(card.id)} compact />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function OpenPack({
  cardPool,
  balance,
  setBalance,
  collection,
  setCollection,
  packs,
  packImage,
  packName,
  publicOnly = false
}: {
  cardPool: Card[];
  balance: number;
  setBalance: React.Dispatch<React.SetStateAction<number>>;
  collection: PulledCard[];
  setCollection: React.Dispatch<React.SetStateAction<PulledCard[]>>;
  packs?: PackDef[];
  packImage?: string;
  packName?: string;
  publicOnly?: boolean;
}) {
  const [currentPack, setCurrentPack] = useState<PulledCard[]>([]);
  const [position, setPosition] = useState(0);
  const [animation, setAnimation] = useState<"idle" | "normal" | "premium">("idle");
  const [openingPhase, setOpeningPhase] = useState<"idle" | "sealed" | "ripping" | "opened">("idle");
  const [selectedPackId, setSelectedPackId] = useState("");

  // When packs are supplied (builder mode) the player picks a named pack to open;
  // otherwise (public play) the whole published set is one pool.
  const showPackPicker = Array.isArray(packs);
  const packList = packs ?? [];
  const selectedPack = packList.find((pack) => pack.id === selectedPackId);
  const activePool = showPackPicker
    ? selectedPackId
      ? cardPool.filter((card) => card.packId === selectedPackId)
      : []
    : cardPool;

  useEffect(() => {
    if (showPackPicker && !selectedPackId && packList.length > 0) {
      const withCards = packList.find((pack) => cardPool.some((card) => card.packId === pack.id));
      setSelectedPackId((withCards ?? packList[0]).id);
    }
  }, [showPackPicker, selectedPackId, packs, cardPool]);

  const canBuy = activePool.length > 0 && balance >= packPrice && currentPack.length === 0;
  const revealed = currentPack.slice(0, position);
  const isComplete = currentPack.length > 0 && position >= currentPack.length;
  const isPremiumPack = currentPack.some((card) => highRarities.has(card.rarity));

  function buyPack() {
    if (!canBuy) return;
    const pack = pickPack(activePool);
    setBalance((current) => current - packPrice);
    setCurrentPack(pack);
    setPosition(0);
    setOpeningPhase("sealed");
    setAnimation("idle");
  }

  function completePackRip() {
    if (openingPhase !== "sealed") return;
    setOpeningPhase("ripping");
    setAnimation(isPremiumPack ? "premium" : "normal");
    window.setTimeout(() => {
      setOpeningPhase("opened");
      setAnimation("idle");
    }, 900);
  }

  function nextCard() {
    setPosition((current) => Math.min(current + 1, currentPack.length));
  }

  function finishPack() {
    setCollection((current) => [...currentPack, ...current]);
    setCurrentPack([]);
    setPosition(0);
    setOpeningPhase("idle");
  }

  function sellCards(cards: PulledCard[]) {
    const ids = new Set(cards.map((card) => card.pullId));
    const total = cards.reduce((sum, card) => sum + card.value, 0);
    setBalance((current) => current + total);
    setCollection((current) => current.filter((card) => !ids.has(card.pullId)));
  }

  return (
    <section className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">STEP 2</p>
          <h2>{publicOnly ? "公開パック開封" : "パック開封モード"}</h2>
        </div>
        <div className="opener-actions">
          {showPackPicker && (
            <select
              className="pack-select"
              value={selectedPackId}
              onChange={(event) => setSelectedPackId(event.target.value)}
              disabled={currentPack.length > 0}
            >
              <option value="">{packList.length === 0 ? "パック未登録" : "パックを選択"}</option>
              {packList.map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {pack.name}
                </option>
              ))}
            </select>
          )}
          <button className="primary-button" type="button" onClick={buyPack} disabled={!canBuy}>
            <Box size={18} />
            {packPrice.toLocaleString()}円で購入
          </button>
        </div>
      </header>

      <div className="opener-layout">
        <div className={`pack-stage ${animation}`}>
          {activePool.length === 0 && currentPack.length === 0 ? (
            <div className="empty-stage">
              {showPackPicker
                ? packList.length === 0
                  ? "先にパックを登録してください"
                  : "このパックにはカードがありません"
                : "先にパックを作成してください"}
            </div>
          ) : currentPack.length === 0 ? (
            <button className="pack-art" type="button" onClick={buyPack} disabled={!canBuy}>
              {(selectedPack?.image ?? packImage) ? <img src={selectedPack?.image ?? packImage} alt="" /> : null}
              <span>{selectedPack?.name ?? packName ?? "ORITORE"}</span>
              <strong>5 CARDS</strong>
            </button>
          ) : openingPhase !== "opened" ? (
            <PackRipInteraction premium={isPremiumPack} phase={openingPhase === "ripping" ? "ripping" : "sealed"} onComplete={completePackRip} image={selectedPack?.image ?? packImage} />
          ) : isComplete ? (
            <div className="result-grid">
              {currentPack.map((card) => (
                <TradingCard key={card.pullId} card={card} total={activePool.length} packName={selectedPack?.name ?? packName} compact />
              ))}
            </div>
          ) : (
            <div className="single-pull">
              <TradingCard card={currentPack[position]} total={activePool.length} packName={selectedPack?.name ?? packName} />
              <button className="next-button" type="button" onClick={nextCard}>
                次へ <ChevronRight size={20} />
              </button>
            </div>
          )}
        </div>

        <div className="side-panel">
          <Metric icon={<Coins size={18} />} label="所持金" value={`${balance.toLocaleString()}円`} />
          <Metric icon={<BadgeDollarSign size={18} />} label="売却額" value={`${collection.reduce((sum, card) => sum + card.value, 0).toLocaleString()}円`} />
          {isComplete && (
            <div className="action-stack">
              <button className="primary-button full" type="button" onClick={finishPack}>
                コレクションへ入れる
              </button>
              <button className="secondary-button full" type="button" onClick={() => sellCards(currentPack)}>
                この5枚を売る
              </button>
            </div>
          )}
          {revealed.length > 0 && !isComplete && (
            <div className="mini-results">
              {revealed.map((card) => (
                <span key={card.pullId} className={`rarity-chip ${card.rarity}`}>
                  {card.rarity}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <Collection cards={collection} totalCards={activePool.length} sellCards={sellCards} packs={packList} cardPool={cardPool} fallbackPackName={packName} />
    </section>
  );
}

function PackRipInteraction({
  premium,
  phase,
  onComplete,
  image
}: {
  premium: boolean;
  phase: "sealed" | "ripping";
  onComplete: () => void;
  image?: string;
}) {
  const packRef = useRef<HTMLDivElement | null>(null);
  const dragStart = useRef<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [direction, setDirection] = useState<"left" | "right">("right");
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  const isRipping = phase === "ripping";
  const signedProgress = isRipping ? (direction === "right" ? 1 : -1) : progress;
  const visualProgress = Math.min(1, Math.abs(signedProgress));

  useEffect(() => {
    if (!image) {
      setImageAspect(null);
      return;
    }
    const probe = new Image();
    probe.onload = () => setImageAspect(probe.naturalWidth / probe.naturalHeight);
    probe.src = image;
  }, [image]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (isRipping) return;
    dragStart.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (dragStart.current === null || isRipping) return;
    const width = packRef.current?.getBoundingClientRect().width ?? 320;
    const nextProgress = Math.max(-1, Math.min(1, (event.clientX - dragStart.current) / (width * 0.72)));
    setProgress(nextProgress);
    if (Math.abs(nextProgress) > 0.08) setDirection(nextProgress > 0 ? "right" : "left");
    if (Math.abs(nextProgress) >= 0.82) {
      dragStart.current = null;
      setProgress(nextProgress > 0 ? 1 : -1);
      onComplete();
    }
  }

  function onPointerEnd() {
    if (isRipping) return;
    dragStart.current = null;
    if (Math.abs(progress) < 0.82) setProgress(0);
  }

  return (
    <div
      ref={packRef}
      className={`rip-pack ${premium ? "premium" : ""} ${isRipping ? "ripped" : ""}`}
      style={
        {
          "--rip-progress": visualProgress,
          "--rip-offset": `${signedProgress * 48}px`,
          "--rip-offset-inverse": `${signedProgress * -48}px`,
          "--rip-tilt": `${signedProgress * 5}deg`,
          "--rip-tilt-inverse": `${signedProgress * -5}deg`,
          aspectRatio: imageAspect ? String(imageAspect) : undefined
        } as React.CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      role="button"
      tabIndex={0}
      aria-label="左右にスワイプしてパックを開封"
    >
      <div className="rip-card-peek" />
      <div
        className="rip-half rip-half-top"
        style={
          image
            ? { backgroundImage: `url(${image})`, backgroundSize: "100% 500%", backgroundPosition: "center top", backgroundRepeat: "no-repeat" }
            : undefined
        }
      >
        {!image && <span>ORITORE</span>}
      </div>
      <div
        className="rip-half rip-half-bottom"
        style={
          image
            ? { backgroundImage: `url(${image})`, backgroundSize: "100% 125%", backgroundPosition: "center bottom", backgroundRepeat: "no-repeat" }
            : undefined
        }
      >
        {!image && <strong>SWIPE TO OPEN</strong>}
      </div>
      <div className="rip-line" />
      <div className="rip-spark" />
      <p>左右にドラッグしてパックを開封</p>
    </div>
  );
}

function PublishBar({ publicUrl, status, cardCount }: { publicUrl: string; status: "idle" | "publishing" | "ready" | "error"; cardCount: number }) {
  const label =
    status === "ready"
      ? publicUrl
      : status === "publishing"
        ? "公開URLを作成中です"
        : status === "error"
          ? "公開URLの作成に失敗しました"
          : "パック作成後に公開URLが表示されます";

  function copyUrl() {
    if (publicUrl) void navigator.clipboard?.writeText(publicUrl);
  }

  return (
    <div className="publish-bar">
      <div>
        <span>公開URL</span>
        <strong>{label}</strong>
      </div>
      <button className="secondary-button" type="button" onClick={copyUrl} disabled={!publicUrl || cardCount === 0}>
        <Copy size={17} />
        コピー
      </button>
    </div>
  );
}

function Collection({ cards, totalCards, sellCards, packs, cardPool, fallbackPackName }: { cards: PulledCard[]; totalCards: number; sellCards: (cards: PulledCard[]) => void; packs?: PackDef[]; cardPool?: Card[]; fallbackPackName?: string }) {
  const total = cards.reduce((sum, card) => sum + card.value, 0);

  // Group identical cards (same source card id) so duplicates show once with an ×N count.
  const groups: { card: PulledCard; count: number }[] = [];
  const indexById = new Map<string, number>();
  for (const card of cards) {
    const idx = indexById.get(card.id);
    if (idx === undefined) {
      indexById.set(card.id, groups.length);
      groups.push({ card, count: 1 });
    } else {
      groups[idx].count += 1;
    }
  }

  return (
    <section className="collection-section">
      <div className="section-title">
        <h3>コレクション</h3>
        <button className="secondary-button" type="button" disabled={cards.length === 0} onClick={() => sellCards(cards)}>
          全部売る {total.toLocaleString()}円
        </button>
      </div>
      {cards.length === 0 ? (
        <p className="muted">開封したカードはここに保存されます。</p>
      ) : (
        <div className="collection-grid">
          {groups.map(({ card, count }) => {
            const cardPackTotal = cardPool && card.packId ? cardPool.filter(c => c.packId === card.packId).length : totalCards;
            const cardPackName = packs?.find(p => p.id === card.packId)?.name ?? fallbackPackName;
            return (
            <div className="collection-card" key={card.id}>
              <TradingCard card={card} total={cardPackTotal} packName={cardPackName} dupeCount={count} compact />
            </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TradingCard({ card, total, packName, onRemove, dupeCount, compact = false, concealStats = false }: { card: Card; total?: number; packName?: string; onRemove?: () => void; dupeCount?: number; compact?: boolean; concealStats?: boolean }) {
  const rarityLabel = concealStats ? "??" : card.rarity;
  const paddedNo = String(card.cardNo).padStart(3, "0");
  const noLabel = packName ? `${rarityLabel}-${paddedNo} ${packName}` : `${rarityLabel}-${paddedNo}`;
  return (
    <article className={`trading-card ${concealStats ? "concealed-card" : card.rarity} ${compact ? "compact" : ""}`}>
      {onRemove ? (
        <button className="card-remove-btn icon-button" type="button" aria-label="削除" onClick={onRemove}>
          <Trash2 size={17} />
        </button>
      ) : null}
      <header className="card-title-row">
        <strong>{card.name}</strong>
      </header>
      <div className="card-stars" aria-label={`星${card.stars}`}>
        {concealStats ? <span>登録後に生成</span> : Array.from({ length: card.stars }, (_, index) => <span key={index}>★</span>)}
      </div>
      <div className="card-image-wrap">
        {card.image ? <img src={card.image} alt="" /> : <div className="image-placeholder">CARD IMAGE</div>}
        {dupeCount && dupeCount > 1 ? <span className="dupe-badge">×{dupeCount}</span> : null}
      </div>
      <p className="card-flavor">{card.flavor}</p>
      <div className="card-stats">
        <span>ATK {concealStats ? "???" : card.atk}</span>
        <span>DEF {concealStats ? "???" : card.def}</span>
      </div>
      <footer className="card-meta">
        <span>{noLabel}</span>
        <span className="card-creator">{card.creator}</span>
      </footer>
      {card.twitter && !concealStats ? (
        <a className="card-x-link" href={`https://x.com/${card.twitter}`} target="_blank" rel="noreferrer">
          @{card.twitter}
        </a>
      ) : null}
    </article>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
