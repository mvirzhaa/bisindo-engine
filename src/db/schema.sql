-- =====================================================================
-- Skema database: Engine Pengenalan & Transkripsi Bahasa Isyarat (BISINDO)
-- =====================================================================
-- Catatan desain:
--   * "signs" adalah kamus/kosakata pusat: huruf (fingerspelling) & kata/frasa.
--   * "sign_samples" menyimpan data latih berupa urutan landmark tangan
--     (hasil MediaPipe Hands) yang dipakai untuk melatih classifier.
--   * "model_versions" mencatat riwayat model yang sudah dilatih dari sampel.
--   * "sessions" & "transcript_segments" mencatat hasil transkripsi real-time,
--     siap dipakai nanti oleh aplikasi meet online (banyak sesi, banyak user).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- untuk gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- untuk pencarian teks kosakata (trigram)

-- ---------------------------------------------------------------------
-- ENUM
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE sign_language_t AS ENUM ('BISINDO', 'SIBI', 'ASL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_category_t AS ENUM ('alphabet', 'number', 'word', 'phrase');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_motion_t AS ENUM ('static', 'dynamic');
  -- static  = satu pose tangan (umumnya huruf fingerspelling)
  -- dynamic = gestur bergerak berurutan (umumnya kata/frasa)
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- KOSAKATA / KAMUS TANDA (vocabulary dictionary)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gloss              TEXT NOT NULL,                 -- label/kata yang direpresentasikan, mis. "HALO", "A", "TERIMA KASIH"
  sign_language      sign_language_t NOT NULL DEFAULT 'BISINDO',
  category           sign_category_t NOT NULL,
  motion_type        sign_motion_t NOT NULL,
  hands_required      SMALLINT NOT NULL DEFAULT 1 CHECK (hands_required IN (1,2)),
  description        TEXT,                          -- deskripsi gerakan untuk dokumentasi/pelatih baru
  example_sentence   TEXT,                          -- contoh pemakaian dalam kalimat
  reference_image_url TEXT,
  reference_video_url TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gloss, sign_language)
);

CREATE INDEX IF NOT EXISTS idx_signs_language_category ON signs (sign_language, category);
CREATE INDEX IF NOT EXISTS idx_signs_gloss_trgm ON signs USING gin (gloss gin_trgm_ops);

-- sinonim / variasi penulisan agar pencarian kosakata lebih fleksibel
CREATE TABLE IF NOT EXISTS sign_synonyms (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sign_id   UUID NOT NULL REFERENCES signs(id) ON DELETE CASCADE,
  synonym   TEXT NOT NULL,
  UNIQUE (sign_id, synonym)
);

-- ---------------------------------------------------------------------
-- SAMPEL DATA LATIH (landmark sequences dari MediaPipe Hands)
-- ---------------------------------------------------------------------
-- Setiap sampel adalah satu rekaman peragaan tanda oleh seorang kontributor.
-- landmark_sequence berbentuk JSONB array of frames, tiap frame berisi
-- array landmark (x,y,z) per tangan yang terdeteksi, dinormalisasi relatif
-- terhadap pergelangan tangan agar invarian terhadap posisi & skala.
CREATE TABLE IF NOT EXISTS sign_samples (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sign_id           UUID NOT NULL REFERENCES signs(id) ON DELETE CASCADE,
  landmark_sequence JSONB NOT NULL,       -- [{ t: ms, hands: [{handedness, landmarks:[[x,y,z],...21]}] }, ...]
  frame_count       INTEGER NOT NULL,
  contributor_name  TEXT,                 -- opsional: nama perekam/penutur BISINDO
  contributor_note  TEXT,
  source            TEXT NOT NULL DEFAULT 'manual_capture', -- manual_capture | imported | synthetic
  quality_flag      TEXT NOT NULL DEFAULT 'unverified',     -- unverified | verified | rejected
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_samples_sign_id ON sign_samples (sign_id);
CREATE INDEX IF NOT EXISTS idx_sign_samples_quality ON sign_samples (quality_flag);

-- ---------------------------------------------------------------------
-- VERSI MODEL YANG SUDAH DILATIH
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_label   TEXT NOT NULL UNIQUE,     -- mis. "2026-10-28_v1"
  algorithm       TEXT NOT NULL,            -- mis. "knn-dtw", "mlp"
  sign_language   sign_language_t NOT NULL DEFAULT 'BISINDO',
  trained_sample_count INTEGER NOT NULL,
  training_accuracy    REAL,
  validation_accuracy  REAL,
  artifact_path   TEXT NOT NULL,            -- path file model di data/models/
  is_active       BOOLEAN NOT NULL DEFAULT FALSE,
  trained_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_versions_one_active
  ON model_versions (sign_language)
  WHERE is_active = TRUE;

-- ---------------------------------------------------------------------
-- SESI TRANSKRIPSI (untuk nantinya dipakai aplikasi meet online)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT,                 -- nama user/peserta (opsional, belum ada sistem auth)
  sign_language sign_language_t NOT NULL DEFAULT 'BISINDO',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  model_version_id UUID REFERENCES model_versions(id)
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sign_id        UUID REFERENCES signs(id),     -- NULL jika tidak match / dibawah threshold
  recognized_text TEXT NOT NULL,                -- teks yang ditambahkan ke transkrip (huruf atau kata)
  confidence     REAL NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ NOT NULL,
  sequence_index INTEGER NOT NULL               -- urutan dalam transkrip sesi ini
);

CREATE INDEX IF NOT EXISTS idx_transcript_segments_session ON transcript_segments (session_id, sequence_index);
