const express = require("express");
const { pool } = require("../db/pool");

const router = express.Router();

// POST /api/samples -> simpan satu rekaman landmark untuk melatih sebuah tanda
// body: { signId, landmarkSequence: [{t, hands:[...]}], contributorName?, contributorNote? }
router.post("/", async (req, res) => {
  const { signId, landmarkSequence, contributorName, contributorNote } = req.body;

  if (!signId || !Array.isArray(landmarkSequence) || landmarkSequence.length === 0) {
    return res.status(400).json({ error: "signId dan landmarkSequence (array frame) wajib diisi" });
  }

  const { rows: signRows } = await pool.query(`SELECT id FROM signs WHERE id = $1`, [signId]);
  if (signRows.length === 0) return res.status(404).json({ error: "signId tidak ditemukan" });

  const { rows } = await pool.query(
    `INSERT INTO sign_samples (sign_id, landmark_sequence, frame_count, contributor_name, contributor_note)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, recorded_at`,
    [signId, JSON.stringify(landmarkSequence), landmarkSequence.length, contributorName || null, contributorNote || null]
  );

  res.status(201).json({ sample: rows[0] });
});

// GET /api/samples/counts -> rekap jumlah sampel per kosakata (buat dashboard progres data collection)
router.get("/counts", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT sg.id AS sign_id, sg.gloss, sg.category, sg.motion_type, count(ss.id)::int AS sample_count
    FROM signs sg
    LEFT JOIN sign_samples ss ON ss.sign_id = sg.id
    WHERE sg.is_active = TRUE
    GROUP BY sg.id, sg.gloss, sg.category, sg.motion_type
    ORDER BY sg.category, sg.gloss
  `);
  res.json({ counts: rows });
});

module.exports = router;
