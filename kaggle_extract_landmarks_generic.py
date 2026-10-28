# =====================================================================
# Skrip ekstraksi landmark tangan — VERSI GENERIK (untuk dataset Kaggle
# apa pun selain WL-BISINDO, mis. "BISINDO 39 Kata mp4", karena struktur
# nama file/foldernya belum diketahui pasti).
# =====================================================================
# Cara pakai:
#   1. Buka dataset di Kaggle (mis. kaggle.com/datasets/anggiyohanespardede/bisindo-39-kata)
#   2. Klik "New Notebook"
#   3. Cell pertama: !pip install mediapipe -q
#   4. Cell kedua: paste seluruh isi file ini, lalu Run
#   5. PENTING: skrip ini jalan 2 tahap --
#        TAHAP 1 (DRY RUN): cuma mencetak daftar video & label yang
#        BERHASIL DITEBAK dari nama file/folder, TANPA memproses video
#        sama sekali (cepat, untuk verifikasi). Cek hasilnya dulu --
#        kalau label yang tertebak sudah benar, ubah DRY_RUN = False
#        lalu jalankan ulang cell untuk ekstraksi sungguhan.
#   6. Setelah selesai, download "bisindo_generic_landmarks.csv" dari
#      panel Output, lalu upload ke chat ini.
# =====================================================================

import os
import re
import glob
import csv
import cv2
import mediapipe as mp

# ======= UBAH INI SETELAH DRY RUN TERLIHAT BENAR =======
DRY_RUN = True
# =========================================================

OUTPUT_CSV = "/kaggle/working/bisindo_generic_landmarks.csv"
POINTS_PER_HAND = 21
HEADER = (
    ["video_id", "gloss", "frame_idx"]
    + [f"x{i}" for i in range(POINTS_PER_HAND * 3 * 2)]
)

mp_hands = mp.solutions.hands


def find_all_videos():
    return glob.glob("/kaggle/input/**/*.mp4", recursive=True) + \
           glob.glob("/kaggle/input/**/*.MP4", recursive=True) + \
           glob.glob("/kaggle/input/**/*.mov", recursive=True) + \
           glob.glob("/kaggle/input/**/*.avi", recursive=True)


def guess_gloss(video_path):
    """Coba tebak nama kata (gloss) dari path video, dengan beberapa strategi
    berurutan -- pakai yang pertama berhasil memberi hasil masuk akal."""
    parts = video_path.split(os.sep)
    filename = os.path.splitext(parts[-1])[0]

    # Strategi 1: video ada di dalam subfolder yang namanya adalah kata itu sendiri
    # mis. .../BISINDO 39 Kata/Makan/video1.mp4 -> gloss = "Makan"
    # (lewati folder-folder generik seperti nama dataset/kaggle/input)
    SKIP_FOLDER_NAMES = {"kaggle", "input", "working", "train", "test", "val",
                          "videos", "video", "data", "dataset"}
    for part in reversed(parts[:-1]):
        cleaned = part.strip()
        if cleaned.lower() in SKIP_FOLDER_NAMES:
            continue
        if re.search(r"[a-zA-Z]", cleaned) and len(cleaned) <= 40:
            return cleaned.strip(), "folder_name"

    # Strategi 2: nama file berisi huruf di awal sebelum angka/underscore/strip
    # mis. "Makan_01.mp4", "makan-sample3.mp4", "Makan1.mp4"
    m = re.match(r"^([A-Za-z][A-Za-z\s]*?)[\s_\-]*\d*$", filename)
    if m and m.group(1).strip():
        return m.group(1).strip(), "filename_prefix"

    # Strategi 3: kalau ada pola label<N> seperti dataset WL-BISINDO
    m2 = re.search(r"label(\d+)", filename, re.IGNORECASE)
    if m2:
        return f"LABEL_{m2.group(1)}", "label_number"

    return None, "gagal"


def dry_run_report():
    videos = find_all_videos()
    print(f"Ditemukan {len(videos)} file video total.\n")
    if not videos:
        print("Tidak ada video ditemukan. Cek isi /kaggle/input/ dengan:")
        print("  import os; print(os.listdir('/kaggle/input'))")
        return

    gloss_counts = {}
    failed = []
    for v in videos:
        gloss, strategy = guess_gloss(v)
        if gloss is None:
            failed.append(v)
        else:
            gloss_counts.setdefault(gloss, []).append((v, strategy))

    print(f"=== {len(gloss_counts)} kata/label unik berhasil ditebak ===")
    for gloss in sorted(gloss_counts):
        examples = gloss_counts[gloss]
        strategy = examples[0][1]
        print(f"  '{gloss}' -- {len(examples)} video (metode: {strategy})")
        print(f"      contoh path: {examples[0][0]}")

    if failed:
        print(f"\n=== {len(failed)} video GAGAL ditebak labelnya (contoh 5 pertama) ===")
        for v in failed[:5]:
            print(f"  {v}")

    print(
        "\n>>> Jika daftar kata di atas SUDAH BENAR, ubah DRY_RUN = False di atas "
        "lalu jalankan ulang cell ini untuk mulai ekstraksi sungguhan.\n"
        ">>> Jika SALAH (banyak yang gagal/aneh), beri tahu Claude contoh struktur "
        "nama file/foldernya (copy beberapa baris dari daftar di atas) supaya pola "
        "tebakannya bisa diperbaiki."
    )


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
                    flat.extend([lm.x - wrist.x, lm.y - wrist.y, lm.z - wrist.z])
                if hand_i == 0:
                    hand1 = flat
                else:
                    hand2 = flat

        frames_out.append((frame_idx, hand1 + hand2))
        frame_idx += 1

    cap.release()
    return frames_out


def full_extraction():
    videos = find_all_videos()
    print(f"Mengekstrak {len(videos)} video...")

    with open(OUTPUT_CSV, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(HEADER)

        with mp_hands.Hands(
            static_image_mode=False, max_num_hands=2,
            min_detection_confidence=0.5, min_tracking_confidence=0.5
        ) as hands_detector:
            for i, video_path in enumerate(videos):
                gloss, _ = guess_gloss(video_path)
                if gloss is None:
                    continue
                gloss = gloss.upper()
                video_id = f"{os.path.splitext(os.path.basename(video_path))[0]}_{i}"

                try:
                    frames = extract_video_landmarks(video_path, hands_detector)
                    for frame_idx, features in frames:
                        writer.writerow([video_id, gloss, frame_idx] + features)
                except Exception as e:
                    print(f"  GAGAL {video_path}: {e}")

                if (i + 1) % 50 == 0:
                    print(f"  {i + 1}/{len(videos)} video diproses...")

    print(f"\nSelesai! Hasil tersimpan di: {OUTPUT_CSV}")
    print("Download file ini dari panel Output Kaggle Notebook, lalu upload ke chat ini.")


if __name__ == "__main__":
    if DRY_RUN:
        dry_run_report()
    else:
        full_extraction()
