// =====================================================================
// Melatih ulang model dari seluruh sign_samples yang ada di database.
//
// Strategi:
//   - Pose STATIS (huruf/angka, atau "key-pose" representatif kata/frasa
//     yang hanya punya sampel 1-frame): setiap frame individual dari semua
//     sampel dijadikan satu entri di `staticPool`, dibatasi maksimum
//     MAX_STATIC_PER_SIGN per kosakata (diacak) agar ukuran model & waktu
//     inferensi k-NN tetap terkendali. Diklasifikasi lewat k-NN + voting
//     (lihat src/engine/classifier.js) -- PENTING: bukan dirata-ratakan
//     jadi satu vektor, karena itu terbukti jauh kurang akurat pada data
//     nyata (variasi antar orang/ukuran tangan menghilangkan bentuk
//     pembeda saat dirata-ratakan).
//   - Gestur DINAMIS (kata/frasa dengan sampel >=2 frame / urutan gerak
//     penuh): tiap sampel di-resample ke panjang tetap lalu disimpan
//     sebagai template sequence individual untuk dicocokkan lewat DTW.
//
// Catatan: sebuah kosakata bisa punya KEDUANYA sekaligus -- misalnya kata
// yang punya sampel 1-frame (dari dataset key-pose) DAN sampel multi-frame
// (dari rekaman gerak penuh lewat /collect.html) akan otomatis masuk ke
// staticPool maupun dynamicTemplates, dan sessionEngine akan mencocokkan
// lewat jalur manapun yang terpicu lebih dulu saat pemakaian nyata.
//
// Jalankan: npm run train
// =====================================================================

const fs = require("fs");
const path = require("path");
const { pool } = require("../db/pool");
const { resampleSequence } = require("../engine/dtw");
const { DYNAMIC_RESAMPLE_LENGTH } = require("../engine/classifier");
const { frameToFeatureVector } = require("../engine/features");

const MODELS_DIR = path.join(__dirname, "..", "..", "data", "models");
const MAX_STATIC_PER_SIGN = Number(process.env.MAX_STATIC_SAMPLES_PER_SIGN) || 300;

async function fetchSamplesWithSignInfo() {
  const { rows } = await pool.query(`
    SELECT s.id AS sample_id, s.landmark_sequence, sg.id AS sign_id,
           sg.gloss, sg.category, sg.motion_type, sg.sign_language
    FROM sign_samples s
    JOIN signs sg ON sg.id = s.sign_id
    WHERE s.quality_flag != 'rejected' AND sg.is_active = TRUE
    ORDER BY sg.gloss
  `);
  return rows;
}

function sampleToFeatureSequence(landmarkSequence) {
  return landmarkSequence.map((frame) => frameToFeatureVector(frame.hands || []));
}

/** Pilih acak maksimal `limit` elemen dari array (tanpa mengubah array asli) */
function randomSample(arr, limit) {
  if (arr.length <= limit) return arr;
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, limit);
}

async function train() {
  console.log("[train] mengambil sampel dari database ...");
  const rows = await fetchSamplesWithSignInfo();
  if (rows.length === 0) {
    console.warn(
      "[train] Belum ada sign_samples di database. Rekam data lewat halaman /collect.html " +
        "lalu jalankan `npm run train` lagi."
    );
  }

  const bySign = new Map();
  for (const row of rows) {
    if (!bySign.has(row.sign_id)) {
      bySign.set(row.sign_id, {
        signId: row.sign_id,
        gloss: row.gloss,
        category: row.category,
        motionType: row.motion_type,
        samples: [],
      });
    }
    bySign.get(row.sign_id).samples.push(row.landmark_sequence);
  }

  const staticPool = [];
  const dynamicTemplates = [];

  for (const entry of bySign.values()) {
    // --- Kumpulkan SEMUA frame individual (dari sampel apa pun, 1-frame atau multi-frame)
    //     sebagai kandidat untuk k-NN pose statis / key-pose. ---
    const allFrameVectors = [];
    for (const seq of entry.samples) {
      const vecs = sampleToFeatureSequence(seq);
      allFrameVectors.push(...vecs);
    }
    if (allFrameVectors.length > 0) {
      const sampled = randomSample(allFrameVectors, MAX_STATIC_PER_SIGN);
      for (const vector of sampled) {
        staticPool.push({
          signId: entry.signId,
          gloss: entry.gloss,
          category: entry.category,
          motionType: entry.motionType,
          vector,
        });
      }
    }

    // --- Sampel yang punya >=2 frame (urutan gerak sungguhan) juga dijadikan
    //     template DTW untuk gestur dinamis. ---
    for (const seq of entry.samples) {
      const vecs = sampleToFeatureSequence(seq);
      if (vecs.length < 2) continue;
      dynamicTemplates.push({
        signId: entry.signId,
        gloss: entry.gloss,
        category: entry.category,
        sequence: resampleSequence(vecs, DYNAMIC_RESAMPLE_LENGTH),
      });
    }
  }

  const versionLabel = new Date().toISOString().replace(/[:.]/g, "-");
  const model = {
    meta: {
      versionLabel,
      trainedAt: new Date().toISOString(),
      sampleCount: rows.length,
      staticPoolSize: staticPool.length,
      staticSignCount: new Set(staticPool.map((e) => e.signId)).size,
      dynamicTemplateCount: dynamicTemplates.length,
      dynamicSignCount: new Set(dynamicTemplates.map((e) => e.signId)).size,
    },
    staticPool,
    dynamicTemplates,
  };

  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
  const fileName = `model_${versionLabel}.json`;
  fs.writeFileSync(path.join(MODELS_DIR, fileName), JSON.stringify(model));
  fs.writeFileSync(
    path.join(MODELS_DIR, "active_model.json"),
    JSON.stringify({ file: fileName, versionLabel }, null, 2)
  );

  await pool.query(`UPDATE model_versions SET is_active = FALSE WHERE sign_language = 'BISINDO'`);
  await pool.query(
    `INSERT INTO model_versions
       (version_label, algorithm, sign_language, trained_sample_count, artifact_path, is_active, notes)
     VALUES ($1, $2, 'BISINDO', $3, $4, TRUE, $5)`,
    [
      versionLabel,
      "k-NN+voting (pose statis/key-pose) + k-NN/DTW (gestur dinamis)",
      rows.length,
      path.join("data", "models", fileName),
      `${model.meta.staticSignCount} kosakata dgn pose statis (${staticPool.length} sampel), ` +
        `${model.meta.dynamicSignCount} kosakata dgn gestur dinamis (${dynamicTemplates.length} template)`,
    ]
  );

  console.log(
    `[train] selesai. Model "${versionLabel}" disimpan di data/models/${fileName}\n` +
      `         Pose statis/key-pose: ${model.meta.staticSignCount} kosakata, ${staticPool.length} sampel\n` +
      `         Gestur dinamis (DTW): ${model.meta.dynamicSignCount} kosakata, ${dynamicTemplates.length} template\n` +
      `         (dari ${rows.length} total sampel di database)`
  );
  await pool.end();
}

train().catch((err) => {
  console.error("[train] gagal:", err);
  process.exit(1);
});
