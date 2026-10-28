# Engine Transkripsi Bahasa Isyarat (BISINDO) — Real-time dari Webcam

Engine ini mendeteksi tangan lewat webcam, mengenali tanda BISINDO (huruf
fingerspelling, angka, dan kata/frasa dinamis), lalu menyusunnya jadi
transkrip teks secara real-time. Dibangun sebagai fondasi untuk aplikasi
meet online yang menjembatani komunikasi penyandang disabilitas dengan
pengguna lain.

## Status implementasi saat ini

✅ **Model sudah terlatih dari data asli dan siap pakai langsung** (termasuk di dalam paket ini):

| | Jumlah | Akurasi (diuji dgn data yang tak pernah dilihat saat training) |
|---|---|---|
| Pose statis (26 huruf, 11 angka, 38 kata/frasa via key-pose) | 75 kosakata, 22.032 sampel | **97.89%** |
| Gestur dinamis penuh (32 kata, via DTW) | 32 kata, 1.600 video | **93.33%** |

**Sumber data latih** (lihat `src/scripts/import_*.js` untuk detail tiap importer):
1. **Alfabet A-Z** (14.493 sampel) — [realtime-bisindo-classification](https://github.com/KrisnaSantosa15/realtime-bisindo-classification) oleh Krisna Santosa, lisensi **MIT**.
2. **Alfabet, angka 1-10, dan 10 kata umum** (31.883 sampel) — dataset yang diunggah pengguna (`dataset_tangan.csv`). *Lisensi sumber belum diverifikasi — cek ulang sebelum dipakai komersial.*
3. **32 kata dinamis WL-BISINDO** (1.600 video, varian Banten, 5 penutur) — [WL-BISINDO](https://github.com/AceKinnn/WL-BISINDO) oleh Kindy, Leonali & Lucky (BINUS University), dataset video di Kaggle, **lisensi CC BY-NC 4.0 (non-komersial)**. Landmark diekstrak dari cache `.npz` yang sudah diproses pengguna sebelumnya (notebook "KawanIsyarat").

⚠️ **Penting soal lisensi**: Sumber #3 (WL-BISINDO) berlisensi **non-komersial**. Kalau aplikasi meet online ini nantinya akan dikomersialkan, 32 kata dinamis dari sumber ini perlu diganti dengan data yang lisensinya mengizinkan pemakaian komersial (rekam sendiri lewat `/collect.html`, atau cari sumber lain). Untuk prototipe/riset/non-komersial, aman dipakai.

✅ Selesai & teruji (arsitektur):
- Skema & database kosakata PostgreSQL (88 kosakata aktif: alfabet, angka, kata, frasa)
- Ekstraksi & normalisasi landmark tangan (translasi + skala invariant)
- Classifier k-NN SEBENARNYA (bukan rata-rata — percobaan awal dengan rata-rata cuma dapat ~14% akurasi di data nyata; k-NN+voting mayoritas atas banyak sampel individual terbukti jauh lebih baik, lihat `src/engine/classifier.js`)
- Session engine real-time dengan **debounce anti-deteksi-ganda**: gestur dengan jeda singkat di tengah gerakannya tidak lagi salah tersegmentasi jadi dua bagian
- Server Express + WebSocket (`/ws/transcribe`) dengan persistensi sesi & transkrip ke database
- Halaman web: demo transkripsi (`/index.html`) & perekam data latih (`/collect.html`), memakai MediaPipe Hands langsung di browser
- Diuji end-to-end lewat simulasi WebSocket dengan data landmark ASLI dari database (bukan cuma data sintetis)

**Paket ini sudah menyertakan**: model terlatih (`data/models/`) DAN dump lengkap database (`data/bisindo_engine_dump.sql`) — lihat bagian Setup untuk cara memuatnya langsung tanpa perlu training ulang.

## Arsitektur

```
Browser (webcam)
  └─ MediaPipe Hands (client-side, via CDN) → 21 landmark/tangan
       └─ WebSocket (/ws/transcribe) → kirim landmark per frame
            └─ SessionEngine (Node.js)
                 ├─ features.js    : normalisasi landmark → vektor fitur
                 ├─ sessionEngine  : state machine diam/gerak, stabilisasi, buffer gestur
                 └─ classifier.js  : k-NN (statis) / k-NN+DTW (dinamis) terhadap model terlatih
                       └─ model JSON hasil `npm run train` dari sign_samples di PostgreSQL
            └─ transcript_segments tersimpan ke PostgreSQL
       └─ hasil dikirim balik ke browser → ditampilkan sebagai transkrip
```

**Kenapa k-NN + DTW, bukan deep learning?** Karena dataset BISINDO yang
terkumpul dari halaman `/collect.html` kemungkinan besar masih kecil
(puluhan–ratusan sampel per kosakata di tahap awal). Pendekatan few-shot
berbasis jarak (k-NN untuk pose statis, Dynamic Time Warping untuk gestur
bergerak) bekerja baik di skala data kecil, mudah dipahami, dan mudah
diperluas — tinggal tambah sampel & `npm run train` ulang, tanpa perlu
infrastruktur pelatihan jaringan saraf. Ketika data sudah banyak (ribuan
sampel per kosakata), arsitektur ini bisa diganti/ditambah dengan model
LSTM/Transformer tanpa mengubah skema database atau alur WebSocket.

## Setup

### 1. Database (PostgreSQL)

Pakai Docker (disarankan):
```bash
docker compose up -d
```
Atau pakai PostgreSQL yang sudah terpasang: buat role & database sesuai `.env.example`.

```bash
cp .env.example .env
npm install
```

**Opsi A — Pakai data & model yang sudah dilatih (disarankan, langsung bisa dipakai):**
```bash
# buat database kosong dulu (ganti nama sesuai .env kalau beda)
createdb -U bisindo bisindo_engine

# muat seluruh skema + 88 kosakata + 47.976 sampel latih sekaligus
psql -U bisindo -d bisindo_engine -f data/bisindo_engine_dump.sql
```
Model di `data/models/` sudah aktif dan ID-nya cocok dengan dump ini — begitu `npm start` dijalankan, engine langsung bisa mengenali tanda tanpa training ulang.

**Opsi B — Mulai dari kosong (tanpa data latih):**
```bash
npm run db:migrate   # buat semua tabel, kosong
npm run db:seed      # isi kosakata dasar saja (tanpa sampel latih)
# classifier belum bisa mengenali apa pun sampai Anda rekam data sendiri
# lewat /collect.html lalu jalankan `npm run train`
```

### 2. Jalankan server

```bash
npm start
# atau npm run dev (auto-restart saat file berubah)
```

Buka:
- `http://localhost:3000/collect.html` — rekam data latih per kosakata
- `http://localhost:3000/index.html` — demo transkripsi real-time

### 3. Melatih model

Setelah merekam cukup sampel (disarankan **minimal 10–20 rekaman per
kosakata**, dengan variasi kecepatan/posisi agar model lebih tahan
terhadap variasi peraga):

```bash
npm run train
```

Lalu beri tahu server yang sedang berjalan untuk memuat ulang model (tanpa
restart):
```bash
curl -X POST http://localhost:3000/api/admin/reload-model
```

## Struktur folder

```
src/
  db/
    schema.sql       # skema lengkap (signs, sign_samples, sessions, transcript_segments, ...)
    seed.sql         # 56 kosakata awal BISINDO
    pool.js          # koneksi PostgreSQL
  engine/
    features.js      # normalisasi landmark → vektor fitur (translation & scale invariant)
    dtw.js            # Dynamic Time Warping untuk membandingkan urutan gestur
    classifier.js     # k-NN statis + k-NN/DTW dinamis, memuat model dari data/models/
    sessionEngine.js  # state machine per sesi: deteksi diam/gerak, stabilisasi, transkrip
  routes/
    signs.js          # CRUD & pencarian kamus kosakata
    samples.js         # simpan sampel landmark latih + rekap progres data collection
    sessions.js         # riwayat sesi & transkrip
  scripts/
    migrate.js / seed.js / train.js
    import_external_dataset.js    # importer dataset alfabet Krisna Santosa (CSV 1-frame)
    import_dataset_tangan.js      # importer dataset_tangan.csv (alfabet+angka+kata, 1-frame)
    import_video_landmarks.js     # importer landmark video (long-format CSV, multi-frame per video)
  ws/
    transcribeSocket.js  # protokol WebSocket real-time
  server.js            # entrypoint Express + WebSocket
public/
  index.html      # demo transkripsi
  collect.html    # perekam data latih
  js/handTracker.js  # wrapper MediaPipe Hands (deteksi landmark di browser)
data/
  models/                     # model terlatih (JSON) -- SUDAH TERISI di paket ini
  bisindo_engine_dump.sql     # dump lengkap database (skema + 88 kosakata + 47.976 sampel)
kaggle_extract_landmarks.py           # skrip ekstraksi landmark dari video WL-BISINDO (Kaggle Notebook)
kaggle_extract_landmarks_generic.py   # versi generik untuk dataset video BISINDO lain
```

## Protokol WebSocket (`/ws/transcribe`)

**Client → Server**
```jsonc
{ "type": "start", "displayName": "Budi", "signLanguage": "BISINDO" }
{ "type": "frame", "hands": [{ "handedness": "Right", "landmarks": [[x,y,z], ... 21 titik] }] }
{ "type": "commit_word" }   // paksa tutup rangkaian huruf fingerspelling saat ini
{ "type": "stop" }
```

**Server → Client**
```jsonc
{ "type": "ready", "sessionId": "..." }
{ "type": "recognition", "event": "letter" | "word", "gloss": "HALO", "confidence": 0.81, "transcriptSoFar": "..." }
{ "type": "transcript_update", "transcriptSoFar": "..." }
{ "type": "error", "message": "..." }
```

## Menambah kosakata baru

**Cara 1 — rekam sendiri** (paling akurat untuk tanda spesifik/belum ada datanya):
1. `POST /api/signs` dengan `gloss`, `category` (`alphabet|number|word|phrase`),
   `motionType` (`static|dynamic`), `handsRequired` — atau tambahkan baris baru di `src/db/seed.sql`.
2. Rekam 10–20 sampel di `/collect.html`.
3. `npm run train` lalu `POST /api/admin/reload-model` (atau restart server).

**Cara 2 — import dataset video publik lain** (untuk menambah banyak kata sekaligus):
1. Jalankan `kaggle_extract_landmarks_generic.py` di Kaggle Notebook pada dataset video BISINDO
   yang ingin ditambahkan (lihat komentar di skrip untuk cara pakai, termasuk mode DRY_RUN
   untuk memverifikasi penebakan nama kata sebelum ekstraksi sungguhan).
2. Download CSV hasilnya, lalu jalankan:
   ```bash
   node src/scripts/import_video_landmarks.js path/ke/hasil.csv
   ```
   Kosakata baru yang belum ada di kamus akan otomatis dibuat (category `word`, motion `dynamic`).
3. `npm run train` lalu `POST /api/admin/reload-model`.

## Roadmap menuju aplikasi meet online

Bagian yang sudah dibangun di sini (engine pengenalan + transkripsi) adalah
fondasi inti. Untuk menjadi aplikasi meet lengkap, langkah selanjutnya:

1. **Signaling & video call**: integrasikan WebRTC (mis. lewat `mediasoup`
   atau `simple-peer`) untuk panggilan video antar peserta; jalur WebSocket
   transkripsi ini berjalan paralel per peserta yang berkomunikasi lewat isyarat.
2. **Autentikasi & profil pengguna**: tabel `users`, preferensi bahasa isyarat
   (BISINDO/SIBI), riwayat kontak.
3. **Teks-ke-ucapan**: hasil transkrip dari peserta Tuli dibacakan otomatis
   ke peserta dengar (mis. Web Speech API atau layanan TTS).
4. **Ucapan-ke-teks + avatar isyarat (arah sebaliknya)**: fitur lanjutan,
   di luar cakupan saat ini.
5. **Perluasan kosakata & akurasi**: kumpulkan data dari lebih banyak
   kontributor Tuli/penerjemah BISINDO bersertifikat untuk memperkaya
   `sign_samples`, lalu evaluasi migrasi ke model deep learning (LSTM/
   Transformer berbasis landmark) begitu dataset cukup besar.

## Catatan etika & akurasi

Engine ini adalah alat bantu, bukan pengganti juru bahasa isyarat
bersertifikat untuk konteks penting (medis, hukum, pendidikan formal).
Akurasi bergantung penuh pada kuantitas & kualitas data latih yang direkam
melalui `/collect.html` — idealnya melibatkan penutur BISINDO asli/komunitas
Tuli dalam proses pengumpulan dan validasi data (`quality_flag` di tabel
`sign_samples` bisa dipakai untuk menandai sampel yang sudah diverifikasi).
