CREATE TABLE IF NOT EXISTS packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  image_data_url TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('N', 'HN', 'R', 'HR', 'SR', 'SSR', 'UR')),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 8),
  atk TEXT NOT NULL,
  def TEXT NOT NULL,
  flavor TEXT NOT NULL,
  card_no TEXT NOT NULL,
  creator TEXT NOT NULL,
  twitter TEXT NOT NULL DEFAULT '',
  twitter_url TEXT NOT NULL DEFAULT '',
  sale_value INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
