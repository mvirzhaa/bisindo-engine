// =====================================================================
// handTracker.js
// Pembungkus tipis di atas MediaPipe Tasks Vision "HandLandmarker" untuk
// mendeteksi landmark tangan dari webcam langsung di browser (client-side).
// Memakai model & runtime resmi dari Google lewat CDN, tidak perlu build step.
// =====================================================================

import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

export class HandTracker {
  constructor() {
    this.landmarker = null;
    this.lastVideoTime = -1;
  }

  async init({ numHands = 2 } = {}) {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
  }

  /**
   * Deteksi landmark pada frame video saat ini.
   * @param {HTMLVideoElement} videoEl
   * @returns {{hands: Array<{handedness:string, landmarks: number[][]}>}}
   */
  detect(videoEl) {
    if (!this.landmarker || videoEl.currentTime === this.lastVideoTime) {
      return { hands: [] };
    }
    this.lastVideoTime = videoEl.currentTime;
    const result = this.landmarker.detectForVideo(videoEl, performance.now());

    const hands = (result.landmarks || []).map((landmarks, idx) => {
      const handednessInfo = result.handedness?.[idx]?.[0];
      return {
        handedness: handednessInfo ? handednessInfo.categoryName : "Right",
        score: handednessInfo ? handednessInfo.score : 0,
        landmarks: landmarks.map((p) => [p.x, p.y, p.z]),
      };
    });

    return { hands, raw: result };
  }
}

/** Gambar titik & garis landmark ke kanvas overlay untuk feedback visual pengguna. */
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // ibu jari
  [0, 5], [5, 6], [6, 7], [7, 8], // telunjuk
  [5, 9], [9, 10], [10, 11], [11, 12], // tengah
  [9, 13], [13, 14], [14, 15], [15, 16], // manis
  [13, 17], [17, 18], [18, 19], [19, 20], // kelingking
  [0, 17],
];

export function drawLandmarks(ctx, width, height, hands) {
  ctx.clearRect(0, 0, width, height);
  for (const hand of hands) {
    ctx.strokeStyle = hand.handedness === "Left" ? "#38bdf8" : "#f472b6";
    ctx.lineWidth = 3;
    ctx.fillStyle = "#ffffff";

    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = hand.landmarks[a];
      const pb = hand.landmarks[b];
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa[0] * width, pa[1] * height);
      ctx.lineTo(pb[0] * width, pb[1] * height);
      ctx.stroke();
    }
    for (const p of hand.landmarks) {
      ctx.beginPath();
      ctx.arc(p[0] * width, p[1] * height, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
