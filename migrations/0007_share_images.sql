-- Share cards (worker/share.ts): 1200x630 PNGs drawn in the browser and
-- stored so the Worker can point og:image at a card for one report, one
-- passport or one pet day. One row per key, a newer upload replaces it.
-- Keys: scan:<wallet>, passport:<wallet>, pet:<day>.
CREATE TABLE IF NOT EXISTS share_images (
  key        TEXT    PRIMARY KEY,
  png        BLOB    NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
