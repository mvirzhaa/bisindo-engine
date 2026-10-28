# =====================================================================
# Skrip ekstraksi landmark tangan dari video WL-BISINDO (Kaggle Notebook)
# =====================================================================
# Cara pakai:
#   1. Buka dataset di Kaggle: https://www.kaggle.com/datasets/glennleonali/wl-bisindo
#   2. Klik "New Notebook" (dataset otomatis ter-attach, tidak perlu download manual)
#   3. Paste seluruh isi file ini ke satu cell, lalu Run All
#   4. Setelah selesai, download file "wl_bisindo_landmarks.csv" dari panel Output
#      (ukurannya akan JAUH lebih kecil daripada 2GB video aslinya - biasanya
#      cuma beberapa MB karena cuma menyimpan angka landmark, bukan video)
#   5. Upload file csv hasilnya ke chat ini
#
# Install dependency (jalankan di cell terpisah sebelum cell ini jika mediapipe
# belum tersedia di environment Kaggle):
#   !pip install mediapipe -q
# =====================================================================

import os
import glob
import csv
import cv2
import mediapipe as mp

OUTPUT_CSV = "/kaggle/working/wl_bisindo_landmarks.csv"


def find_dataset_root():
    """Cari otomatis folder yang berisi file .mp4 di bawah /kaggle/input/,
    supaya tidak perlu menebak-nebak struktur path Kaggle yang kadang berbeda
    (mis. /kaggle/input/wl-bisindo/ vs /kaggle/input/datasets/<user>/wl-bisindo/)."""
    candidates = glob.glob("/kaggle/input/**/*.mp4", recursive=True)
    if not candidates:
        return None
    # ambil direktori terdekat yang memuat video (induk dari file pertama yang ditemukan,
    # naik satu level jika video ada di dalam subfolder per-signer)
    return os.path.commonpath(candidates)


DATASET_ROOT = find_dataset_root() or "/kaggle/input/wl-bisindo"

# Pemetaan label numerik (dari nama file signerX_labelY_sampleZ.mp4) ke gloss
# BISINDO, sesuai tabel di README dataset WL-BISINDO.
LABEL_TO_GLOSS = {
    0: "AIR", 1: "BELAJAR", 2: "CARI", 3: "HARI", 4: "INGAT",
    5: "LAGI", 6: "MAAF", 7: "MAKAN", 8: "MOTOR", 9: "SAYA",
    10: "TERIMA KASIH", 11: "TULI", 12: "APA", 13: "SIAPA", 14: "KAPAN",
    15: "DI MANA", 16: "MENGAPA", 17: "BAGAIMANA", 18: "MERAH", 19: "KUNING",
    20: "HIJAU", 21: "HITAM", 22: "DENGAR", 23: "BERANGKAT", 24: "DATANG",
    25: "TEMAN", 26: "KELUARGA", 27: "RUMAH", 28: "PAGI", 29: "SIANG",
    30: "SORE", 31: "MALAM",
}

POINTS_PER_HAND = 21
# Sama dengan 1 frame di 1 baris sebelumnya: 42 titik (2 tangan) x 3 (x,y,z)
# tapi sekarang SETIAP FRAME jadi satu baris tersendiri (bukan diringkas jadi
# satu pose), dengan video_id untuk mengelompokkan kembali jadi 1 urutan gerak
# penuh -- supaya bisa dipakai melatih pengenalan GESTUR DINAMIS (DTW), bukan
# cuma pose diam seperti dataset alfabet sebelumnya.
HEADER = (
    ["video_id", "gloss", "frame_idx"]
    + [f"x{i}" for i in range(POINTS_PER_HAND * 3)]       # tangan 1 (63 kolom)
    + [f"x{i}" for i in range(POINTS_PER_HAND * 3, POINTS_PER_HAND * 3 * 2)]  # tangan 2 (63 kolom)
)

mp_hands = mp.solutions.hands


def parse_label_from_filename(filename):
    # format: signer{N}_label{N}_sample{N}.mp4
    base = os.path.basename(filename)
    parts = base.replace(".mp4", "").split("_")
    label_part = [p for p in parts if p.startswith("label")][0]
    return int(label_part.replace("label", ""))


def extract_video_landmarks(video_path, hands_detector):
    cap = cv2.VideoCapture(video_path)
    frames_out = []
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = hands_detector.process(frame_rgb)

        hand1 = [0.0] * (POINTS_PER_HAND * 3)
        hand2 = [0.0] * (POINTS_PER_HAND * 3)

        if results.multi_hand_landmarks:
            detected = results.multi_hand_landmarks[:2]
            for hand_i, hand_landmarks in enumerate(detected):
                wrist = hand_landmarks.landmark[0]
                flat = []
                for lm in hand_landmarks.landmark:
                    # normalisasi translasi di sini (relatif wrist) supaya konsisten
                    # dengan dataset_tangan.csv -- normalisasi SKALA tetap dilakukan
                    # ulang oleh engine saat training (src/engine/features.js).
                    flat.extend([lm.x - wrist.x, lm.y - wrist.y, lm.z - wrist.z])
                if hand_i == 0:
                    hand1 = flat
                else:
                    hand2 = flat

        frames_out.append((frame_idx, hand1 + hand2))
        frame_idx += 1

    cap.release()
    return frames_out


def main():
    video_files = glob.glob(os.path.join(DATASET_ROOT, "**", "*.mp4"), recursive=True)
    print(f"Ditemukan {len(video_files)} file video.")
    if len(video_files) == 0:
        print(f"Tidak ada video ditemukan di {DATASET_ROOT}. Cek path dataset di /kaggle/input/ "
              f"(jalankan: import os; print(os.listdir('/kaggle/input')) untuk melihat nama folder yang benar).")
        return

    with open(OUTPUT_CSV, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(HEADER)

        with mp_hands.Hands(
            static_image_mode=False, max_num_hands=2,
            min_detection_confidence=0.5, min_tracking_confidence=0.5
        ) as hands_detector:
            for i, video_path in enumerate(video_files):
                try:
                    label_num = parse_label_from_filename(video_path)
                    gloss = LABEL_TO_GLOSS.get(label_num)
                    if gloss is None:
                        print(f"  lewati (label tak dikenal {label_num}): {video_path}")
                        continue

                    video_id = os.path.basename(video_path).replace(".mp4", "")
                    frames = extract_video_landmarks(video_path, hands_detector)
                    for frame_idx, features in frames:
                        writer.writerow([video_id, gloss, frame_idx] + features)

                    if (i + 1) % 50 == 0:
                        print(f"  {i + 1}/{len(video_files)} video diproses...")
                except Exception as e:
                    print(f"  GAGAL memproses {video_path}: {e}")

    print(f"\nSelesai! Hasil tersimpan di: {OUTPUT_CSV}")
    print("Download file ini dari panel Output Kaggle Notebook, lalu upload ke chat ini.")


if __name__ == "__main__":
    main()
