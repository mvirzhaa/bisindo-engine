// =====================================================================
// Import landmark hasil ekstraksi video (lihat kaggle_extract_landmarks.py)
// -- berbeda dari importer lain, file ini berformat LONG (banyak baris per
// video, satu baris = satu frame), dikelompokkan lewat kolom `video_id`
// menjadi SATU sampel per video dengan urutan frame penuh. Inilah yang
// memungkinkan training template DTW gestur dinamis yang sesungguhnya
// (bukan cuma key-pose statis seperti dataset sebelumnya).
//
// Format kolom: video_id, gloss, frame_idx, x0..x125
//   (x0..x125 sama persis seperti dataset_tangan.csv: 2 tangan x 21 titik x 3,
//    interleaved per titik, sudah wrist-relative tapi belum scale-normalized
//    -- scale normalization tetap dihitung ulang oleh engine saat training)
//
// Kosakata yang belum ada di kamus (`signs`) otomatis dibuat sebagai
// category='word', motion_type='dynamic'.
//
// Jalankan: node src/scripts/import_video_landmarks.js <path-ke-csv>
// =====================================================================

const fs = require("fs");
const readline = require("readline");
const { pool } = require("../db/pool");

const POINTS_PER_HAND = 21;

async function ensureSignExists(gloss) {
  const { rows } = await pool.query(
    `SELECT id FROM signs WHERE gloss = $1 AND sign_language = 'BISINDO'`,
    [gloss]
  );
  if (rows.length > 0) return rows[0].id;

  const { rows: inserted } = await pool.query(
    `INSERT INTO signs (gloss, sign_language, category, motion_type, hands_required, description)
     VALUES ($1,'BISINDO','word','dynamic',1,$2)
     ON CONFLICT (gloss, sign_language) DO UPDATE SET gloss = EXCLUDED.gloss
     RETURNING id`,
    [gloss, `Diimpor otomatis dari dataset video (kaggle_extract_landmarks.py).`]
  );
  console.log(`[import] Kosakata baru dibuat: ${gloss} (word/dynamic)`);
  return inserted[0].id;
}

function buildHand(nums, offset) {
  const landmarks = [];
  for (let i = 0; i < POINTS_PER_HAND; i++) {
    const base = offset + i * 3;
    landmarks.push([nums[base], nums[base + 1], nums[base + 2]]);
  }
  return landmarks;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error("Pemakaian: node src/scripts/import_video_landmarks.js <path-ke-csv>");
    process.exit(1);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(csvPath) });
  let header = null;
  let currentVideoId = null;
  let currentGloss = null;
  let currentFrames = []; // [{t, hands}]
  let videosImported = 0;
  let videosSkippedTooShort = 0;
  const signIdCache = new Map();
  const perGlossVideoCount = {};

  async function flushCurrentVideo() {
    if (!currentVideoId || currentFrames.length === 0) return;
    if (currentFrames.length < 2) {
      videosSkippedTooShort++;
      currentFrames = [];
      return;
    }
    if (!signIdCache.has(currentGloss)) {
      signIdCache.set(currentGloss, await ensureSignExists(currentGloss));
    }
    const signId = signIdCache.get(currentGloss);

    await pool.query(
      `INSERT INTO sign_samples (sign_id, landmark_sequence, frame_count, source, contributor_note)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        signId,
        JSON.stringify(currentFrames),
        currentFrames.length,
        "external:kaggle-video-extraction",
        `Diekstrak dari video "${currentVideoId}" (WL-BISINDO atau dataset video serupa) via kaggle_extract_landmarks.py`,
      ]
    );
    videosImported++;
    perGlossVideoCount[currentGloss] = (perGlossVideoCount[currentGloss] || 0) + 1;
    currentFrames = [];
    if (videosImported % 50 === 0) {
      process.stdout.write(`\r[import] ${videosImported} video (sampel urutan gerak) diproses...`);
    }
  }

  for await (const line of rl) {
    if (!header) {
      header = line.split(",");
      continue;
    }
    if (!line.trim()) continue;
    const cols = line.split(",");
    const videoId = cols[0];
    const gloss = cols[1].toUpperCase();
    const frameIdx = Number(cols[2]);
    const nums = cols.slice(3).map(Number);

    if (nums.length < POINTS_PER_HAND * 3 * 2 || nums.some((n) => Number.isNaN(n))) {
      continue;
    }

    if (videoId !== currentVideoId) {
      await flushCurrentVideo();
      currentVideoId = videoId;
      currentGloss = gloss;
    }

    const hand1 = buildHand(nums, 0);
    const hand2raw = buildHand(nums, 63);
    const hand2HasData = hand2raw.some((p) => p.some((v) => Math.abs(v) > 1e-9));
    const hands = [{ handedness: "Right", landmarks: hand1 }];
    if (hand2HasData) hands.push({ handedness: "Left", landmarks: hand2raw });

    currentFrames.push({ t: frameIdx, hands });
  }
  await flushCurrentVideo();

  console.log(
    `\n[import] Selesai. ${videosImported} sampel urutan gerak (video) dimasukkan, ` +
      `${videosSkippedTooShort} dilewati (kurang dari 2 frame valid).`
  );
  console.log("[import] Jumlah video per kosakata:");
  for (const g of Object.keys(perGlossVideoCount).sort()) {
    console.log(`   ${g}: ${perGlossVideoCount[g]}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[import] gagal:", err);
  process.exit(1);
});
