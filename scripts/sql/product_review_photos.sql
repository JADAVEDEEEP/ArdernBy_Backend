-- Optional customer photos on product reviews. Additive only: nothing existing
-- is altered. Apply once to the `ardenby` database; until then the reviews
-- feature works without photos and photo uploads are politely refused.
CREATE TABLE IF NOT EXISTS product_review_photos (
  id          CHAR(36)     NOT NULL,
  review_id   VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  url         VARCHAR(2048) NOT NULL,
  public_id   VARCHAR(255) NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_review_photos_review (review_id),
  CONSTRAINT fk_review_photos_review FOREIGN KEY (review_id)
    REFERENCES product_reviews (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
