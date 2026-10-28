const express = require("express");
const { pool } = require("../db/pool");

const router = express.Router();

// GET /api/sessions/:id/transcript -> lihat kembali transkrip sebuah sesi
router.get("/:id/transcript", async (req, res) => {
  const { rows: sessionRows } = await pool.query(`SELECT * FROM sessions WHERE id = $1`, [
    req.params.id,
  ]);
  if (sessionRows.length === 0) return res.status(404).json({ error: "Sesi tidak ditemukan" });

  const { rows: segments } = await pool.query(
    `SELECT recognized_text, confidence, started_at, ended_at, sequence_index
     FROM transcript_segments WHERE session_id = $1 ORDER BY sequence_index`,
    [req.params.id]
  );
  res.json({ session: sessionRows[0], segments });
});

// GET /api/sessions -> daftar sesi terbaru
router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, display_name, sign_language, started_at, ended_at
     FROM sessions ORDER BY started_at DESC LIMIT 50`
  );
  res.json({ sessions: rows });
});

module.exports = router;
