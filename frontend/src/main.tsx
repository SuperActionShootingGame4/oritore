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
  publishedPackId?: string;
};

type CardForm = Pick<Card, "name" | "image" | "flavor" | "creator">;

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function readStoredState(): StoredState {
  const fallback: StoredState = { cards: [], balance: 1000, collection: [] };
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

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function roundTo50(value: number) {
  return String(Math.min(3000, Math.max(0, Math.round(value / 50) * 50)));
}

function randomBattleParams() {
  const rarity = weightedRarity();
  const starRanges: Record<Rarity, [number, number]> = {
    N: [1, 2],
    HN: [2, 3],
    R: [3, 4],
    HR: [4, 5],
    SR: [5, 6],
    SSR: [6, 7],
    UR: [7, 8]
  };
  const [minStars, maxStars] = starRanges[rarity];
  const stars = randomInt(minStars, maxStars);
  const statMin = stars * 230;
  const statMax = Math.min(3000, stars * 375);

  return {
    rarity,
    stars,
    atk: roundTo50(randomInt(statMin, statMax)),
    def: roundTo50(randomInt(statMin, statMax))
  };
}

function blankCardForm(overrides: Partial<CardForm> = {}): CardForm {
  return {
    name: "無名のカード",
    image: "",
    flavor: "ここにカードフレイバーを入力",
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
  const publicUrl = publishedPackId ? `${window.location.origin}/play/${publishedPackId}` : "";

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify({ cards, balance, collection, publishedPackId }));
  }, [cards, balance, collection, publishedPackId]);

  useEffect(() => {
    if (cards.length === 0) {
      setPublishedPackId(undefined);
      setPublishStatus("idle");
      return;
    }

    const controller = new AbortController();
    setPublishStatus("publishing");
    fetch("/api/packs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards }),
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
            <ImagePlus size={18} /> パック作成
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
          <Route path="/" element={<CreatePack cards={cards} setCards={setCards} />} />
          <Route
            path="/open"
            element={
              <OpenPack
                cardPool={cards}
                balance={balance}
                setBalance={setBalance}
                collection={collection}
                setCollection={setCollection}
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
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [balance, setBalance] = useState(1000);
  const [collection, setCollection] = useState<PulledCard[]>([]);

  useEffect(() => {
    if (!packId) return;
    fetch(`/api/packs/${packId}`)
      .then((response) => {
        if (!response.ok) throw new Error("pack not found");
        return response.json() as Promise<{ cards?: Card[] }>;
      })
      .then((pack) => {
        setCards(pack.cards ?? []);
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
        publicOnly
      />
    </main>
  );
}

function CreatePack({ cards, setCards }: { cards: Card[]; setCards: React.Dispatch<React.SetStateAction<Card[]>> }) {
  const [form, setForm] = useState<CardForm>(() => blankCardForm());
  const nextCardNo = nextCardNumber(cards);
  const previewCard: Card = { ...form, id: "preview", cardNo: nextCardNo, rarity: "N", value: 0, stars: 0, atk: "???", def: "???" };

  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const image = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    setForm((current) => ({ ...current, image }));
    event.target.value = "";
  }

  function updateForm<K extends keyof CardForm>(key: K, value: CardForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function saveCard() {
    if (!form.image) return;
    const generated = randomBattleParams();
    setCards((current) => [{ ...form, ...generated, id: uid("card"), cardNo: nextCardNumber(current), value: values[generated.rarity] }, ...current]);
    setForm((current) => ({
      ...blankCardForm({
        creator: current.creator
      })
    }));
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
        <button className="primary-button" type="button" onClick={saveCard} disabled={!form.image || cards.length >= 30}>
          <Save size={18} />
          カード登録
        </button>
      </header>

      <div className="summary-strip">
        <Metric icon={<Layers size={18} />} label="登録カード" value={`${cards.length}/30枚`} />
        <Metric icon={<Sparkles size={18} />} label="能力値" value="登録時に生成" />
        <Metric icon={<Box size={18} />} label="1パック" value="5枚" />
      </div>

      <div className="card-editor">
        <form className="card-form" onSubmit={(event) => event.preventDefault()}>
          <label>
            カード名
            <input value={form.name} onChange={(event) => updateForm("name", event.target.value)} />
          </label>
          <label>
            カード画像
            <span className="file-picker">
              <ImagePlus size={17} />
              画像を選択
              <input type="file" accept="image/*" onChange={onUpload} />
            </span>
          </label>
          <div className="generated-panel concealed wide-field">
            <div>
              <span>カードNo.</span>
              <strong>{nextCardNo}</strong>
            </div>
            <div>
              <span>レアリティ</span>
              <strong>登録後</strong>
            </div>
            <div>
              <span>☆マーク</span>
              <strong>登録後</strong>
            </div>
            <div>
              <span>ATK</span>
              <strong>登録後</strong>
            </div>
            <div>
              <span>DEF</span>
              <strong>登録後</strong>
            </div>
          </div>
          <label>
            作成者
            <input value={form.creator} onChange={(event) => updateForm("creator", event.target.value)} />
          </label>
          <label className="wide-field">
            カードフレイバー
            <textarea value={form.flavor} onChange={(event) => updateForm("flavor", event.target.value)} rows={4} />
          </label>
        </form>
        <div className="template-preview">
          <TradingCard card={previewCard} total={cards.length + 1} concealStats />
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
                <TradingCard card={card} total={cards.length} compact />
                <button className="icon-button" type="button" aria-label="削除" onClick={() => removeCard(card.id)}>
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

function OpenPack({
  cardPool,
  balance,
  setBalance,
  collection,
  setCollection,
  publicOnly = false
}: {
  cardPool: Card[];
  balance: number;
  setBalance: React.Dispatch<React.SetStateAction<number>>;
  collection: PulledCard[];
  setCollection: React.Dispatch<React.SetStateAction<PulledCard[]>>;
  publicOnly?: boolean;
}) {
  const [currentPack, setCurrentPack] = useState<PulledCard[]>([]);
  const [position, setPosition] = useState(0);
  const [animation, setAnimation] = useState<"idle" | "normal" | "premium">("idle");
  const [openingPhase, setOpeningPhase] = useState<"idle" | "sealed" | "ripping" | "opened">("idle");
  const canBuy = cardPool.length > 0 && balance >= packPrice && currentPack.length === 0;
  const revealed = currentPack.slice(0, position);
  const isComplete = currentPack.length > 0 && position >= currentPack.length;
  const isPremiumPack = currentPack.some((card) => highRarities.has(card.rarity));

  function buyPack() {
    if (!canBuy) return;
    const pack = pickPack(cardPool);
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
        <button className="primary-button" type="button" onClick={buyPack} disabled={!canBuy}>
          <Box size={18} />
          {packPrice.toLocaleString()}円で購入
        </button>
      </header>

      <div className="opener-layout">
        <div className={`pack-stage ${animation}`}>
          {cardPool.length === 0 ? (
            <div className="empty-stage">先にパックを作成してください</div>
          ) : currentPack.length === 0 ? (
            <button className="pack-art" type="button" onClick={buyPack} disabled={!canBuy}>
              <span>ORITORE</span>
              <strong>5 CARDS</strong>
            </button>
          ) : openingPhase !== "opened" ? (
            <PackRipInteraction premium={isPremiumPack} phase={openingPhase === "ripping" ? "ripping" : "sealed"} onComplete={completePackRip} />
          ) : isComplete ? (
            <div className="result-grid">
              {currentPack.map((card) => (
                <TradingCard key={card.pullId} card={card} total={cardPool.length} compact />
              ))}
            </div>
          ) : (
            <div className="single-pull">
              <TradingCard card={currentPack[position]} total={cardPool.length} />
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

      <Collection cards={collection} totalCards={cardPool.length} sellCards={sellCards} />
    </section>
  );
}

function PackRipInteraction({
  premium,
  phase,
  onComplete
}: {
  premium: boolean;
  phase: "sealed" | "ripping";
  onComplete: () => void;
}) {
  const packRef = useRef<HTMLDivElement | null>(null);
  const dragStart = useRef<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [direction, setDirection] = useState<"left" | "right">("right");
  const isRipping = phase === "ripping";
  const signedProgress = isRipping ? (direction === "right" ? 1 : -1) : progress;
  const visualProgress = Math.min(1, Math.abs(signedProgress));

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
          "--rip-tilt-inverse": `${signedProgress * -5}deg`
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
      <div className="rip-half rip-half-top">
        <span>ORITORE</span>
      </div>
      <div className="rip-half rip-half-bottom">
        <strong>SWIPE TO OPEN</strong>
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

function Collection({ cards, totalCards, sellCards }: { cards: PulledCard[]; totalCards: number; sellCards: (cards: PulledCard[]) => void }) {
  const total = cards.reduce((sum, card) => sum + card.value, 0);

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
          {cards.map((card) => (
            <TradingCard key={card.pullId} card={card} total={totalCards} compact />
          ))}
        </div>
      )}
    </section>
  );
}

function TradingCard({ card, total, compact = false, concealStats = false }: { card: Card; total?: number; compact?: boolean; concealStats?: boolean }) {
  return (
    <article className={`trading-card ${concealStats ? "concealed-card" : card.rarity} ${compact ? "compact" : ""}`}>
      <header className="card-title-row">
        <strong>{card.name}</strong>
        <span className="card-rarity">{concealStats ? "??" : card.rarity}</span>
      </header>
      <div className="card-stars" aria-label={`星${card.stars}`}>
        {concealStats ? <span>登録後に生成</span> : Array.from({ length: card.stars }, (_, index) => <span key={index}>☆</span>)}
      </div>
      <div className="card-image-wrap">
        {card.image ? <img src={card.image} alt="" /> : <div className="image-placeholder">CARD IMAGE</div>}
      </div>
      <p className="card-flavor">{card.flavor}</p>
      <div className="card-stats">
        <span>ATK {concealStats ? "???" : card.atk}</span>
        <span>DEF {concealStats ? "???" : card.def}</span>
      </div>
      <footer className="card-meta">
        <span>{total ? `${card.cardNo}/${total}` : card.cardNo}</span>
        <span>{card.creator}</span>
        <span>{concealStats ? "登録後" : `${card.value.toLocaleString()}円`}</span>
      </footer>
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
