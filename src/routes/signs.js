const express = require("express");
const { pool } = require("../db/pool");

const router = express.Router();

// GET /api/signs?language=BISINDO&category=word&q=halo
router.get("/", async (req, res) => {
  const { language = "BISINDO", category, q } = req.query;
  const conditions = ["sign_language = $1", "is_active = TRUE"];
  const params = [language];

  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`gloss ILIKE $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT id, gloss, category, motion_type, hands_required, description, example_sentence
     FROM signs WHERE ${conditions.join(" AND ")} ORDER BY category, gloss`,
    params
  );
  res.json({ signs: rows });
});

// GET /api/signs/:id -> detail + jumlah sampel latih yang sudah ada
router.get("/:id", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM signs WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: "Tanda tidak ditemukan" });

  const { rows: sampleCountRows } = await pool.query(
    `SELECT count(*)::int AS n FROM sign_samples WHERE sign_id = $1`,
    [req.params.id]
  );
  res.json({ sign: rows[0], sampleCount: sampleCountRows[0].n });
});

// POST /api/signs -> tambah kosakata baru ke kamus
router.post("/", async (req, res) => {
  const {
    gloss,
    signLanguage = "BISINDO",
    category,
    motionType,
    handsRequired = 1,
    description,
    exampleSentence,
  } = req.body;

  if (!gloss || !category || !motionType) {
    return res.status(400).json({ error: "gloss, category, dan motionType wajib diisi" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO signs (gloss, sign_language, category, motion_type, hands_required, description, example_sentence)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [gloss.toUpperCase(), signLanguage, category, motionType, handsRequired, description, exampleSentence]
    );
    res.status(201).json({ sign: rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Kosakata dengan gloss ini sudah ada" });
    }
    throw err;
  }
});

module.exports = router;
