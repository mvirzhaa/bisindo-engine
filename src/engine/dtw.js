// =====================================================================
// Dynamic Time Warping (DTW) untuk membandingkan dua urutan gestur
// (sequence of feature vectors) yang panjangnya bisa berbeda-beda.
// Dipakai untuk mengenali tanda dinamis (kata/frasa) dengan pendekatan
// k-Nearest-Neighbour terhadap sampel yang sudah direkam, tanpa perlu
// melatih jaringan saraf besar - cocok untuk dataset kecil/menengah
// seperti kosakata BISINDO yang terus bertambah.
// =====================================================================

const { euclideanDistance } = require("./features");

/**
 * Hitung jarak DTW antara dua urutan vektor fitur.
 * @param {number[][]} seqA
 * @param {number[][]} seqB
 * @param {number} [window] - Sakoe-Chiba band width (opsional, mempercepat & membatasi warping)
 * @returns {number} jarak DTW (semakin kecil semakin mirip)
 */
function dtwDistance(seqA, seqB, window) {
  const n = seqA.length;
  const m = seqB.length;
  if (n === 0 || m === 0) return Infinity;

  const w = Math.max(window || Math.max(n, m), Math.abs(n - m));

  const INF = Infinity;
  // matriks n+1 x m+1
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Array(m + 1).fill(INF);
  }
  dp[0][0] = 0;

  for (let i = 1; i <= n; i++) {
    const jStart = Math.max(1, i - w);
    const jEnd = Math.min(m, i + w);
    for (let j = jStart; j <= jEnd; j++) {
      const cost = euclideanDistance(seqA[i - 1], seqB[j - 1]);
      dp[i][j] = cost + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[n][m] / (n + m); // normalisasi terhadap panjang gabungan
}

/**
 * Downsample/resample sebuah sequence ke jumlah frame tetap dengan
 * interpolasi linear, agar perbandingan antar sampel lebih stabil dan
 * perhitungan DTW lebih cepat.
 */
function resampleSequence(seq, targetLength) {
  if (seq.length === targetLength) return seq;
  if (seq.length === 1) return new Array(targetLength).fill(seq[0]);

  const out = [];
  for (let i = 0; i < targetLength; i++) {
    const t = (i / (targetLength - 1)) * (seq.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(seq.length - 1, Math.ceil(t));
    const frac = t - lo;
    if (lo === hi) {
      out.push(seq[lo]);
    } else {
      const blended = seq[lo].map((v, idx) => v * (1 - frac) + seq[hi][idx] * frac);
      out.push(blended);
    }
  }
  return out;
}

module.exports = { dtwDistance, resampleSequence };
