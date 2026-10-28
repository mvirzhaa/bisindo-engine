// =====================================================================
// Ekstraksi & normalisasi fitur dari landmark tangan (MediaPipe Hands).
//
// MediaPipe Hands mengembalikan 21 titik (x, y, z) per tangan yang
// terdeteksi. Agar classifier invarian terhadap posisi tangan di layar,
// jarak ke kamera, dan sedikit rotasi, kita normalisasi setiap frame:
//   1. Geser (translate) semua titik supaya landmark 0 (pergelangan
//      tangan / wrist) menjadi origin (0,0,0).
//   2. Skalakan semua titik dengan jarak wrist -> ujung jari tengah
//      (landmark 9), supaya ukuran tangan di layar tidak berpengaruh.
// Hasilnya adalah vektor fitur sepanjang 21*3 = 63 angka per tangan.
// Jika dua tangan terdeteksi, fitur digabung jadi 126 angka, dengan
// urutan tetap: tangan kiri dulu baru kanan (berdasarkan "handedness").
// =====================================================================

const LANDMARKS_PER_HAND = 21;
const WRIST_IDX = 0;
const MIDDLE_MCP_IDX = 9;

function distance3(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = (a[2] || 0) - (b[2] || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
}

/**
 * Normalisasi satu set landmark (21 titik) milik satu tangan.
 * @param {Array<[number,number,number]>} landmarks - 21 titik [x,y,z]
 * @returns {Array<number>} vektor fitur panjang 63, flattened
 */
function normalizeHandLandmarks(landmarks) {
  if (!landmarks || landmarks.length !== LANDMARKS_PER_HAND) {
    return null;
  }
  const wrist = landmarks[WRIST_IDX];
  const scaleRef = landmarks[MIDDLE_MCP_IDX];
  const scale = distance3(wrist, scaleRef);

  const out = [];
  for (let i = 0; i < LANDMARKS_PER_HAND; i++) {
    const p = landmarks[i];
    out.push((p[0] - wrist[0]) / scale);
    out.push((p[1] - wrist[1]) / scale);
    out.push(((p[2] || 0) - (wrist[2] || 0)) / scale);
  }
  return out;
}

/**
 * Bangun vektor fitur satu frame dari payload yang dikirim client.
 * payload.hands: [{ handedness: 'Left'|'Right', landmarks: [[x,y,z],...21] }]
 * Selalu menghasilkan vektor panjang 126 (2 tangan x 63), dengan slot
 * tangan yang tidak terdeteksi diisi nol agar dimensi konsisten.
 */
function frameToFeatureVector(hands) {
  const left = new Array(63).fill(0);
  const right = new Array(63).fill(0);

  for (const hand of hands || []) {
    const norm = normalizeHandLandmarks(hand.landmarks);
    if (!norm) continue;
    if ((hand.handedness || "").toLowerCase().startsWith("l")) {
      for (let i = 0; i < 63; i++) left[i] = norm[i];
    } else {
      for (let i = 0; i < 63; i++) right[i] = norm[i];
    }
  }
  return [...left, ...right];
}

/** Jarak Euclidean antara dua vektor fitur sepanjang sama */
function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - (b[i] || 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Estimasi "kecepatan gerakan" antar dua frame berurutan, untuk deteksi
 * apakah tangan sedang diam (pose statis) atau sedang bergerak (gestur dinamis).
 * Dihitung sebagai RMS (root-mean-square) perubahan per dimensi fitur, bukan
 * dibagi rata dengan jumlah dimensi mentah -- pembagian linear membuat sinyal
 * nyaris hilang karena sebagian besar dari 126 dimensi (tangan yang tidak
 * terdeteksi, titik yang nyaris tidak bergerak) bernilai tetap/nol. */
function frameVelocity(prevFeatureVec, currFeatureVec) {
  if (!prevFeatureVec) return 0;
  const dist = euclideanDistance(prevFeatureVec, currFeatureVec);
  return dist / Math.sqrt(Math.max(1, currFeatureVec.length));
}

module.exports = {
  LANDMARKS_PER_HAND,
  normalizeHandLandmarks,
  frameToFeatureVector,
  euclideanDistance,
  frameVelocity,
};
