// =====================================================================
// SessionEngine: state machine per koneksi WebSocket (satu peserta).
//
// Alur:
//  1. Setiap frame landmark masuk -> dihitung vektor fitur & "kecepatan
//     gerakan" dibanding frame sebelumnya.
//  2. Jika tangan RELATIF DIAM beberapa frame berturut-turut -> dianggap
//     kandidat POSE STATIS -> diklasifikasi sebagai huruf/angka. Dipakai
//     untuk fingerspelling (mengeja kata huruf per huruf).
//  3. Jika tangan sedang BERGERAK -> frame-frame dikumpulkan ke dalam
//     buffer gestur. Begitu gerakan berhenti (kembali diam) -> seluruh
//     buffer diklasifikasi sebagai satu KATA/FRASA dinamis lewat DTW.
//  4. Hasil yang lolos threshold confidence & stability ditambahkan ke
//     transkrip, dengan logika spasi: huruf-huruf fingerspelling
//     digabung jadi satu token sampai ada jeda panjang atau sebuah kata
//     dinamis terdeteksi (yang otomatis dipisah spasi).
// =====================================================================

const { frameToFeatureVector, frameVelocity } = require("./features");

const DEFAULTS = {
  velocityStaticThreshold: 0.012, // di bawah ini dianggap "diam"
  stabilityFrames: Number(process.env.STABILITY_FRAMES) || 8,
  confidenceThreshold: Number(process.env.RECOGNITION_CONFIDENCE_THRESHOLD) || 0.75,
  minDynamicFrames: 10, // minimal panjang buffer gestur dinamis agar layak diklasifikasi
  maxDynamicFrames: 90, // batas atas buffer (±3 detik @30fps) agar tidak membengkak
  idleResetMs: 1500, // tidak ada tangan terdeteksi selama ini -> reset buffer
  // Banyak gestur nyata punya jeda SANGAT singkat di tengah gerakannya (mis.
  // berhenti sejenak antar fase tanda). Tanpa debounce ini, jeda singkat
  // seperti itu bisa salah dianggap "gestur selesai" -> buffer di-flush dan
  // diklasifikasi SEBELUM gestur sungguhan selesai (menghasilkan deteksi
  // ganda/salah). staticDebounceFrames mewajibkan beberapa frame diam
  // BERTURUT-TURUT dulu sebelum gestur dianggap benar-benar berakhir;
  // selama masa tunggu ini frame tetap ditambahkan ke buffer (bukan hilang).
  staticDebounceFrames: 5,
};

class SessionEngine {
  constructor(classifier, options = {}) {
    this.classifier = classifier;
    this.opts = { ...DEFAULTS, ...options };

    this.prevFeatureVec = null;
    this.staticVotes = []; // buffer label untuk voting stabilitas pose statis
    this.lastEmittedStaticGloss = null;

    this.dynamicBuffer = []; // array of feature vectors selama gerakan
    this.isMoving = false;
    this.staticStreak = 0; // jumlah frame diam berturut-turut sejak gerakan terakhir

    this.transcriptTokens = []; // array of {text, type: 'letter'|'word', confidence, t}
    this.currentWordBuffer = ""; // huruf-huruf fingerspelling yang sedang dirangkai

    this.lastHandSeenAt = Date.now();
  }

  /**
   * Proses satu frame landmark dari client.
   * @param {{hands: Array}} payload
   * @returns {Array<{type:string, gloss:string, confidence:number, transcriptDelta:string}>} events
   */
  processFrame(payload) {
    const events = [];
    const hands = payload.hands || [];

    if (hands.length === 0) {
      // Tidak ada tangan terdeteksi di frame ini.
      if (Date.now() - this.lastHandSeenAt > this.opts.idleResetMs) {
        this._flushDynamicBuffer(events);
        this.prevFeatureVec = null;
        this.staticVotes = [];
      }
      return events;
    }
    this.lastHandSeenAt = Date.now();

    const featureVec = frameToFeatureVector(hands);
    const velocity = frameVelocity(this.prevFeatureVec, featureVec);
    this.prevFeatureVec = featureVec;

    const isStaticNow = velocity < this.opts.velocityStaticThreshold;

    if (isStaticNow) {
      if (this.isMoving) {
        // Baru saja diam SETELAH bergerak -- belum tentu gestur benar2 selesai
        // (bisa jeda singkat di tengah gerakan), jadi tetap simpan frame ini ke
        // buffer sambil menghitung streak diam berturut-turut.
        this.staticStreak++;
        this.dynamicBuffer.push(featureVec);
        if (this.dynamicBuffer.length > this.opts.maxDynamicFrames) {
          this.dynamicBuffer.shift();
        }
        if (this.staticStreak >= this.opts.staticDebounceFrames) {
          // Diam cukup lama -> gestur dianggap benar2 selesai, klasifikasi sekarang.
          this._flushDynamicBuffer(events);
          this.isMoving = false;
          this.staticStreak = 0;
          this._handleStaticFrame(featureVec, events);
        }
        // selama masa tunggu debounce, JANGAN jalankan deteksi pose statis dulu
        // (mencegah huruf/key-pose salah terpicu di tengah sebuah gestur kata).
      } else {
        this.staticStreak = 0;
        this._handleStaticFrame(featureVec, events);
      }
    } else {
      this.isMoving = true;
      this.staticStreak = 0;
      this.staticVotes = []; // batalkan voting pose statis, karena tangan sedang bergerak
      this.dynamicBuffer.push(featureVec);
      if (this.dynamicBuffer.length > this.opts.maxDynamicFrames) {
        this.dynamicBuffer.shift();
      }
    }

    return events;
  }

  _handleStaticFrame(featureVec, events) {
    if (!this.classifier.isReady()) return;
    const result = this.classifier.classifyStaticPose(featureVec);
    if (!result || result.confidence < this.opts.confidenceThreshold) {
      this.staticVotes = [];
      return;
    }

    this.staticVotes.push(result.gloss);
    if (this.staticVotes.length > this.opts.stabilityFrames) {
      this.staticVotes.shift();
    }

    const allSame =
      this.staticVotes.length >= this.opts.stabilityFrames &&
      this.staticVotes.every((g) => g === result.gloss);

    if (allSame && result.gloss !== this.lastEmittedStaticGloss) {
      this.lastEmittedStaticGloss = result.gloss;

      // Sebuah kata/frasa (motionType 'dynamic') yang terdeteksi lewat jalur
      // pose statis berarti dikenali dari satu "key-pose" representatif
      // (mis. dari dataset yang hanya punya snapshot, bukan rekaman gerak
      // penuh). Itu tetap diperlakukan sebagai SATU KATA UTUH -- bukan
      // ikut dirangkai ke buffer fingerspelling huruf per huruf.
      if (result.motionType === "dynamic") {
        this._commitWordBuffer();
        this.transcriptTokens.push({
          text: result.gloss,
          type: "word",
          confidence: result.confidence,
          t: Date.now(),
        });
        events.push({
          type: "word",
          gloss: result.gloss,
          signId: result.signId,
          confidence: result.confidence,
          transcriptDelta: " " + result.gloss,
          transcriptSoFar: this._renderTranscript(),
        });
      } else {
        this.currentWordBuffer += result.gloss;
        events.push({
          type: "letter",
          gloss: result.gloss,
          signId: result.signId,
          confidence: result.confidence,
          transcriptDelta: result.gloss,
          transcriptSoFar: this._renderTranscript(),
        });
      }
      this.staticVotes = [];
    } else if (!allSame) {
      // reset agar huruf yang sama bisa dikenali lagi setelah tangan diubah sebentar
      if (this.staticVotes.length === 0) this.lastEmittedStaticGloss = null;
    }
  }

  _flushDynamicBuffer(events) {
    if (this.dynamicBuffer.length >= this.opts.minDynamicFrames && this.classifier.isReady()) {
      const result = this.classifier.classifyDynamicWindow(this.dynamicBuffer);
      if (result && result.confidence >= this.opts.confidenceThreshold) {
        this._commitWordBuffer(); // tutup dulu huruf fingerspelling yang sedang dirangkai
        this.transcriptTokens.push({
          text: result.gloss,
          type: "word",
          confidence: result.confidence,
          t: Date.now(),
        });
        events.push({
          type: "word",
          gloss: result.gloss,
          signId: result.signId,
          confidence: result.confidence,
          transcriptDelta: " " + result.gloss,
          transcriptSoFar: this._renderTranscript(),
        });
      }
    }
    this.dynamicBuffer = [];
  }

  _commitWordBuffer() {
    if (this.currentWordBuffer.length > 0) {
      this.transcriptTokens.push({
        text: this.currentWordBuffer,
        type: "fingerspelled",
        confidence: null,
        t: Date.now(),
      });
      this.currentWordBuffer = "";
      this.lastEmittedStaticGloss = null;
    }
  }

  /** Tutup huruf yang sedang dirangkai, dipanggil mis. saat user menekan "spasi/selesai kata" */
  commitCurrentWord() {
    const events = [];
    this._commitWordBuffer();
    events.push({ type: "commit", transcriptSoFar: this._renderTranscript() });
    return events;
  }

  _renderTranscript() {
    const parts = this.transcriptTokens.map((tok) => tok.text);
    if (this.currentWordBuffer) parts.push(this.currentWordBuffer);
    return parts.join(" ").trim();
  }

  getTranscript() {
    return this._renderTranscript();
  }

  reset() {
    this.prevFeatureVec = null;
    this.staticVotes = [];
    this.lastEmittedStaticGloss = null;
    this.dynamicBuffer = [];
    this.isMoving = false;
    this.transcriptTokens = [];
    this.currentWordBuffer = "";
  }
}

module.exports = { SessionEngine };
