// =====================================================================
// Import dataset landmark tangan BISINDO yang diunggah pengguna
// (31.883 sampel: 26 huruf, 10 angka 1-10, dan 10 kata/frasa dinamis).
//
// Format kolom: label, x0..x125 (126 angka per baris), di mana tiap titik
// landmark memakai 3 kolom berurutan [x,y,z] -- titik 0-20 = tangan
// pertama (21 titik), titik 21-41 = tangan kedua (banyak baris hanya
// mengisi tangan pertama, tangan kedua nol/padding). Koordinat sudah
// relatif terhadap pergelangan tangan (titik 0 = 0,0,0) tapi BELUM
// dinormalisasi skala -- normalisasi skala tetap dilakukan ulang secara
// konsisten oleh engine ini sendiri (src/engine/features.js) saat training,
// supaya sama persis dengan cara fitur dihitung dari kamera langsung.
//
// Kosakata kata/frasa dalam dataset ini yang belum ada di kamus (`signs`)
// otomatis dibuatkan entrinya (kategori word, motion_type dynamic).
//
// Jalankan: node src/scripts/import_dataset_tangan.js <path-ke-csv>
// =====================================================================

const fs = require("fs");
const readline = require("readline");
const { pool } = require("../db/pool");

const POINTS_PER_HAND = 21;

// Pemetaan label dataset -> gloss di kamus kita (uppercase, konsisten dgn seed.sql)
const LABEL_TO_GLOSS = {
  "Bisa": "BISA",
  "Maaf": "MAAF",
  "Tolong": "TOLONG",
  "Belajar": "BELAJAR",
  "Permisi": "PERMISI",
  "Sedikit": "SEDIKIT",
  "Sama sama": "SAMA-SAMA",
  "Teman-teman": "TEMAN-TEMAN",
  "Terimakasih": "TERIMA KASIH",
  "Bahasa isyarat": "BAHASA ISYARAT",
};

// Kosakata baru yang perlu dibuat otomatis jika belum ada di DB
// (gloss -> {category, motionType, description})
const NEW_SIGN_DEFS = {
  "BISA": { category: "word", motionType: "dynamic", description: "Tanda untuk kata \"bisa/mampu\"." },
  "PERMISI": { category: "word", motionType: "dynamic", description: "Tanda untuk kata \"permisi\"." },
  "SEDIKIT": { category: "word", motionType: "dynamic", description: "Tanda untuk kata \"sedikit\"." },
  "SAMA-SAMA": { category: "phrase", motionType: "dynamic", description: "Tanda untuk \"sama-sama\" (balasan terima kasih)." },
  "TEMAN-TEMAN": { category: "word", motionType: "dynamic", description: "Tanda untuk kata \"teman-teman\"." },
  "BAHASA ISYARAT": { category: "phrase", motionType: "dynamic", description: "Tanda untuk frasa \"bahasa isyarat\"." },
  "10": { category: "number", motionType: "static", description: "Bentuk tangan statis untuk angka 10." },
};

function isLetterOrDigitGloss(label) {
  return /^[A-Z]$/.test(label) || /^[0-9]+$/.test(label);
}

async function ensureSignsExist(labels) {
  const { rows: existing } = await pool.query(
    `SELECT gloss FROM signs WHERE sign_language = 'BISINDO'`
  );
  const existingSet = new Set(existing.map((r) => r.gloss.toUpperCase()));

  for (const label of labels) {
    const gloss = LABEL_TO_GLOSS[label] || (isLetterOrDigitGloss(label) ? label.toUpperCase() : label.toUpperCase());
    if (existingSet.has(gloss)) continue;

    const def = NEW_SIGN_DEFS[gloss];
    if (!def) {
      console.warn(`[import] Melewati label tak dikenal tanpa definisi kosakata: "${label}" (gloss: ${gloss})`);
      continue;
    }
    await pool.query(
      `INSERT INTO signs (gloss, sign_language, category, motion_type, hands_required, description)
       VALUES ($1,'BISINDO',$2,$3,1,$4) ON CONFLICT (gloss, sign_language) DO NOTHING`,
      [gloss, def.category, def.motionType, def.description]
    );
    existingSet.add(gloss);
    console.log(`[import] Kosakata baru dibuat: ${gloss} (${def.category}/${def.motionType})`);
  }
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error("Pemakaian: node src/scripts/import_dataset_tangan.js <path-ke-csv>");
    process.exit(1);
  }

  // --- Pass 1: kumpulkan label unik untuk memastikan semua kosakata ada di DB ---
  console.log("[import] Memindai label unik ...");
  const uniqueLabels = new Set();
  {
    const rl = readline.createInterface({ input: fs.createReadStream(csvPath) });
    let first = true;
    for await (const line of rl) {
      if (first) { first = false; continue; }
      if (!line.trim()) continue;
      uniqueLabels.add(line.slice(0, line.indexOf(",")));
    }
  }
  console.log(`[import] ${uniqueLabels.size} label unik ditemukan.`);
  await ensureSignsExist(uniqueLabels);

  const { rows: signs } = await pool.query(
    `SELECT id, gloss FROM signs WHERE sign_language = 'BISINDO'`
  );
  const signByGloss = new Map(signs.map((s) => [s.gloss.toUpperCase(), s.id]));

  // --- Pass 2: import tiap baris sebagai 1 sampel (1 frame) ---
  const rl2 = readline.createInterface({ input: fs.createReadStream(csvPath) });
  let header = null;
  let inserted = 0, skipped = 0;
  const perLabelCount = {};
  const BATCH_SIZE = 500;
  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;
    const values = [];
    const params = [];
    batch.forEach((row, i) => {
      const base = i * 5;
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
      params.push(row.signId, row.landmarkSequence, row.frameCount, row.source, row.note);
    });
    await pool.query(
      `INSERT INTO sign_samples (sign_id, landmark_sequence, frame_count, source, contributor_note)
       VALUES ${values.join(",")}`,
      params
    );
    batch = [];
  }

  for await (const line of rl2) {
    if (!header) { header = line.split(","); continue; }
    if (!line.trim()) continue;
    const cols = line.split(",");
    const label = cols[0];
    const gloss = LABEL_TO_GLOSS[label] || label.toUpperCase();
    const signId = signByGloss.get(gloss);
    if (!signId) { skipped++; continue; }

    const nums = cols.slice(1).map(Number);
    if (nums.length < POINTS_PER_HAND * 3 * 2 || nums.some((n) => Number.isNaN(n))) {
      skipped++;
      continue;
    }

    function buildHand(offset) {
      const landmarks = [];
      for (let i = 0; i < POINTS_PER_HAND; i++) {
        const base = offset + i * 3;
        landmarks.push([nums[base], nums[base + 1], nums[base + 2]]);
      }
      return landmarks;
    }

    const hand1 = buildHand(0);
    const hand2raw = buildHand(63);
    const hand2HasData = hand2raw.some((p) => p.some((v) => Math.abs(v) > 1e-9));

    const hands = [{ handedness: "Right", landmarks: hand1 }];
    if (hand2HasData) hands.push({ handedness: "Left", landmarks: hand2raw });

    batch.push({
      signId,
      landmarkSequence: JSON.stringify([{ t: 0, hands }]),
      frameCount: 1,
      source: "external:user-upload-dataset_tangan",
      note: "Diimpor dari dataset landmark tangan yang diunggah pengguna (dataset_tangan.csv)",
    });
    perLabelCount[gloss] = (perLabelCount[gloss] || 0) + 1;
    inserted++;

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
      process.stdout.write(`\r[import] ${inserted} sampel diproses...`);
    }
  }
  await flushBatch();

  console.log(`\n[import] Selesai. ${inserted} sampel dimasukkan, ${skipped} baris dilewati.`);
  console.log("[import] Jumlah sampel per kosakata:");
  for (const g of Object.keys(perLabelCount).sort()) {
    console.log(`   ${g}: ${perLabelCount[g]}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[import] gagal:", err);
  process.exit(1);
});
