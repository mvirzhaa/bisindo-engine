// =====================================================================
// Classifier: memuat model aktif (hasil `npm run train`) dari disk, lalu
// menyediakan dua fungsi utama:
//   classifyStaticPose(featureVec)   -> untuk huruf/angka/"key-pose" kata
//   classifyDynamicWindow(sequence)  -> untuk kata/frasa yang direkam
//                                        sebagai urutan gerak penuh
//
// classifyStaticPose memakai k-Nearest-Neighbour SEBENARNYA (bukan jarak
// ke satu vektor rata-rata) -- membandingkan ke banyak sampel individual
// dan voting mayoritas di antara k tetangga terdekat. Pendekatan rata-rata
// sempat dicoba dan hasilnya buruk (~14% akurasi di data nyata) karena
// variasi antar orang/ukuran tangan membuat rata-rata kehilangan bentuk
// pembeda antar kelas; k-NN menjaga bentuk manifold tiap kelas sehingga
// jauh lebih akurat, dengan trade-off waktu komputasi yang masih sangat
// ringan untuk ukuran dataset BISINDO (puluhan ribu sampel, vektor 126 dim).
//
// classifyDynamicWindow tetap memakai k-NN + Dynamic Time Warping untuk
// sampel yang benar-benar berupa urutan gerak (>=2 frame).
// =====================================================================

const fs = require("fs");
const path = require("path");
const { euclideanDistance } = require("./features");
const { dtwDistance, resampleSequence } = require("./dtw");

const DYNAMIC_RESAMPLE_LENGTH = 24; // jumlah frame standar untuk template dinamis
const DEFAULT_K = 7; // jumlah tetangga terdekat untuk voting pose statis/key-pose

class SignClassifier {
  constructor() {
    this.staticPool = []; // [{ signId, gloss, category, motionType, vector }] -- SEMUA sampel individual
    this.dynamicTemplates = []; // [{ signId, gloss, category, sequence }]
    this.loaded = false;
    this.modelMeta = null;
  }

  /** Muat model dari file JSON hasil training (lihat src/scripts/train.js) */
  loadFromFile(filePath) {
    const raw = fs.readFileSync(filePath, "utf8");
    const model = JSON.parse(raw);
    // Dukung nama field lama (staticTemplates) untuk kompatibilitas model versi sebelumnya.
    this.staticPool = model.staticPool || model.staticTemplates || [];
    this.dynamicTemplates = model.dynamicTemplates || [];
    this.modelMeta = model.meta || null;
    this.loaded = true;
    console.log(
      `[classifier] model dimuat: ${this.staticPool.length} sampel pose statis/key-pose, ` +
        `${this.dynamicTemplates.length} template gestur dinamis (versi: ${model.meta?.versionLabel || "?"})`
    );
  }

  isReady() {
    return this.loaded && (this.staticPool.length > 0 || this.dynamicTemplates.length > 0);
  }

  /**
   * Klasifikasi pose statis (huruf/angka, atau "key-pose" representatif dari
   * sebuah kata/frasa) dari satu vektor fitur frame, memakai k-NN + voting mayoritas.
   * @returns {{gloss:string, signId:string, category:string, motionType:string, confidence:number}|null}
   */
  classifyStaticPose(featureVec, k = DEFAULT_K) {
    if (!this.staticPool.length) return null;

    // Hitung jarak ke semua sampel, ambil k terdekat (brute-force cukup cepat
    // untuk puluhan ribu vektor 126 dimensi pada frekuensi frame webcam).
    const distances = new Array(this.staticPool.length);
    for (let i = 0; i < this.staticPool.length; i++) {
      distances[i] = { d: euclideanDistance(featureVec, this.staticPool[i].vector), entry: this.staticPool[i] };
    }
    distances.sort((a, b) => a.d - b.d);
    const neighbors = distances.slice(0, Math.min(k, distances.length));

    // Voting mayoritas di antara k tetangga, dengan bobot 1/(1+jarak) supaya
    // tetangga yang lebih dekat berpengaruh lebih besar daripada yang agak jauh.
    const votes = new Map(); // gloss -> { weight, entry }
    for (const { d, entry } of neighbors) {
      const w = 1 / (1 + d);
      const cur = votes.get(entry.gloss) || { weight: 0, entry };
      cur.weight += w;
      votes.set(entry.gloss, cur);
    }
    let bestGloss = null, bestWeight = -1, bestEntry = null;
    for (const [gloss, { weight, entry }] of votes) {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestGloss = gloss;
        bestEntry = entry;
      }
    }
    if (!bestGloss) return null;

    const totalWeight = neighbors.reduce((s, n) => s + 1 / (1 + n.d), 0);
    // confidence = proporsi "suara" yang didapat kelas pemenang di antara k tetangga,
    // dikombinasikan dengan seberapa dekat tetangga terdekatnya secara absolut.
    const voteShare = totalWeight > 0 ? bestWeight / totalWeight : 0;
    const nearestDist = neighbors[0].d;
    const closeness = Math.max(0, 1 - nearestDist / 1.2); // 1.2 dikalibrasi dari data nyata
    const confidence = Math.max(0, Math.min(1, voteShare * 0.6 + closeness * 0.4));

    return {
      gloss: bestGloss,
      signId: bestEntry.signId,
      category: bestEntry.category,
      motionType: bestEntry.motionType,
      confidence,
    };
  }

  /**
   * Klasifikasi jendela gestur dinamis (kata/frasa yang direkam sebagai urutan
   * gerak penuh, >=2 frame) dari urutan vektor fitur, memakai k-NN + DTW.
   */
  classifyDynamicWindow(sequence) {
    if (!this.dynamicTemplates.length || sequence.length < 2) return null;
    const resampled = resampleSequence(sequence, DYNAMIC_RESAMPLE_LENGTH);

    let best = null;
    let bestDist = Infinity;
    for (const tmpl of this.dynamicTemplates) {
      const d = dtwDistance(resampled, tmpl.sequence, 6);
      if (d < bestDist) {
        bestDist = d;
        best = tmpl;
      }
    }
    if (!best) return null;
    const confidence = Math.max(0, 1 - bestDist / 1.8);
    return { gloss: best.gloss, signId: best.signId, category: best.category, confidence };
  }
}

/** Cari file model aktif terbaru di direktori data/models/ */
function resolveActiveModelPath(modelsDir) {
  const pointerPath = path.join(modelsDir, "active_model.json");
  if (fs.existsSync(pointerPath)) {
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    const target = path.join(modelsDir, pointer.file);
    if (fs.existsSync(target)) return target;
  }
  return null;
}

module.exports = { SignClassifier, resolveActiveModelPath, DYNAMIC_RESAMPLE_LENGTH, DEFAULT_K };
