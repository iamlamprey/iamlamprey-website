-- Rating invites and posted ratings for /reviews/. Applied with
-- `npx wrangler d1 migrations apply iamlamprey-ratings --cwd worker`; see the
-- Ratings section of the README.
--
-- Every timestamp in here is unix seconds, UTC.

-- The order IS the proof of purchase: one invite per paid order, and the token
-- in it is the only way to reach the rating form.
CREATE TABLE review_invites (
  order_id   TEXT PRIMARY KEY,   -- polar order id, one invite per order
  email      TEXT NOT NULL,      -- the buyer's address, already lowercased
  product_id TEXT NOT NULL,      -- polar product id, kept for re-resolving
  slug       TEXT NOT NULL,      -- the rating key (config.json ratings_key || slug)
  token      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,            -- null until the cron sends it
  reminded_at INTEGER,           -- null until the one reminder is sent
  used_at    INTEGER             -- non-null once a rating is posted
);
CREATE INDEX review_invites_due ON review_invites (sent_at, created_at);

CREATE TABLE reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  rating     INTEGER NOT NULL,   -- 1..5, the only thing a buyer submits
  email      TEXT NOT NULL,
  order_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER              -- refund, or a support request to remove
);
-- The whole anti-stacking rule: one rating per buyer per product, forever,
-- enforced in the database rather than in code.
CREATE UNIQUE INDEX reviews_one_per_buyer ON reviews (slug, email);
CREATE INDEX reviews_by_slug ON reviews (slug, revoked_at);
