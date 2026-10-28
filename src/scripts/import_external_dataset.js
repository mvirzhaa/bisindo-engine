// =====================================================================
// Import dataset publik eksternal: landmark tangan alfabet BISINDO
// (26 huruf, 14.493 sampel) dari repository open-source berikut:
//
//   Krisna Santosa (2024), "realtime-bisindo-classification"
//   https://github.com/KrisnaSantosa15/realtime-bisindo-classification
//   Lisensi: MIT
//   Dataset gambar sumber: "Bahasa Isyarat Indonesia (BISINDO) Alphabets"
//   oleh Achmad Noer di Kaggle (https://www.kaggle.com/datasets/achmadnoer/alfabet-bisindo),
//   landmark sudah diekstrak ke CSV oleh Krisna Santosa memakai MediaPipe Hands.
//
// Format CSV sumber: kolom `label` + 126 kolom fitur bernama
//   hand_{0..41}_x, lalu hand_{0..41}_y, lalu hand_{0..41}_z
// di mana indeks 0-20 = landmark tangan pertama (21 titik), 21-41 = tangan
// kedua (diisi nol jika hanya satu tangan terdeteksi -- yang terjadi untuk
// hampir semua huruf BISINDO karena fingerspelling pakai satu tangan).
//
// Script ini membaca CSV tsb, merekonstruksi landmark [x,y,z] per titik,
// lalu menyimpannya sebagai sign_samples (1 frame per baris CSV) untuk
// huruf yang sesuai di tabel `signs`, memakai pipeline normalisasi milik
// engine ini sendiri (lihat src/engine/features.js) saat nanti dilatih
// lewat `npm run train` -- BUKAN memakai normalisasi/model asli dari
// repo sumber, karena kita hanya mengambil data mentahnya.
//
// Jalankan: node src/scripts/import_external_dataset.js <path-ke-csv>
// =====================================================================

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { pool } = require("../db/pool");

const POINTS_PER_HAND = 21;

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error(
      "Pemakaian: node src/scripts/import_external_dataset.js <path-ke-bisindo_features.csv>"
    );
    process.exit(1);
  }

  const { rows: signs } = await pool.query(
    `SELECT id, gloss FROM signs WHERE sign_language = 'BISINDO' AND category = 'alphabet'`
  );
  const signByGloss = new Map(signs.map((s) => [s.gloss.toUpperCase(), s.id]));

  const rl = readline.createInterface({ input: fs.createReadStream(csvPath) });
  let header = null;
  let xIdx = [], yIdx = [], zIdx = [];
  let lineNo = 0;
  let inserted = 0;
  let skipped = 0;
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

  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    const cols = line.split(",");

    if (!header) {
      header = cols;
      header.forEach((name, idx) => {
        if (/^hand_\d+_x$/.test(name)) xIdx.push(idx);
        else if (/^hand_\d+_y$/.test(name)) yIdx.push(idx);
        else if (/^hand_\d+_z$/.test(name)) zIdx.push(idx);
      });
      if (xIdx.length !== 42 || yIdx.length !== 42 || zIdx.length !== 42) {
        console.error("Format CSV tidak sesuai dugaan (diharapkan 42 kolom per sumbu x/y/z).");
        process.exit(1);
      }
      continue;
    }

    const label = cols[0].trim().toUpperCase();
    const signId = signByGloss.get(label);
    if (!signId) {
      skipped++;
      continue;
    }

    // Rekonstruksi 21 landmark tangan PERTAMA saja (cukup untuk huruf 1-tangan;
    // slot tangan kedua pada dataset sumber umumnya nol/padding).
    // Catatan: sebagian baris sumber tidak punya nilai Z (kosong) -- diperlakukan
    // sebagai 0 (data 2D saja), karena X/Y sudah cukup merepresentasikan bentuk
    // tangan dan nilai Z dari MediaPipe secara umum lebih berisik/kurang andal.
    const landmarks = [];
    for (let i = 0; i < POINTS_PER_HAND; i++) {
      const x = parseFloat(cols[xIdx[i]]);
      const y = parseFloat(cols[yIdx[i]]);
      const zRaw = parseFloat(cols[zIdx[i]]);
      const z = Number.isNaN(zRaw) ? 0 : zRaw;
      if (Number.isNaN(x) || Number.isNaN(y)) {
        landmarks.length = 0;
        break;
      }
      landmarks.push([x, y, z]);
    }
    if (landmarks.length !== POINTS_PER_HAND) {
      skipped++;
      continue;
    }

    const landmarkSequence = [{ t: 0, hands: [{ handedness: "Right", landmarks }] }];

    batch.push({
      signId,
      landmarkSequence: JSON.stringify(landmarkSequence),
      frameCount: 1,
      source: "external:krisnasantosa15-realtime-bisindo-classification",
      note: "Diimpor dari dataset publik (MIT) github.com/KrisnaSantosa15/realtime-bisindo-classification",
    });
    perLabelCount[label] = (perLabelCount[label] || 0) + 1;
    inserted++;

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
      process.stdout.write(`\r[import] ${inserted} sampel diproses...`);
    }
  }
  await flushBatch();

  console.log(`\n[import] Selesai. ${inserted} sampel dimasukkan, ${skipped} baris dilewati (label tak dikenal/data rusak).`);
  console.log("[import] Jumlah sampel per huruf:");
  for (const letter of Object.keys(perLabelCount).sort()) {
    console.log(`   ${letter}: ${perLabelCount[letter]}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[import] gagal:", err);
  process.exit(1);
});
