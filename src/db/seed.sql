-- =====================================================================
-- Seed data kosakata awal: Alfabet BISINDO (static) + kata umum (dynamic)
-- Catatan: ini hanya metadata kosakata. Model classifier TIDAK otomatis
-- bisa mengenali tanda-tanda ini sampai ada sign_samples (data latih
-- landmark) yang direkam lewat halaman /collect dan model dilatih ulang
-- lewat `npm run train`. Lihat README bagian "Melatih Model".
-- =====================================================================

-- ---------- ALFABET (fingerspelling, 1 tangan, static) ----------
INSERT INTO signs (gloss, sign_language, category, motion_type, hands_required, description)
SELECT letter, 'BISINDO', 'alphabet', 'static', 1,
       'Bentuk tangan statis untuk huruf ' || letter || ' dalam fingerspelling BISINDO.'
FROM unnest(ARRAY['A','B','C','D','E','F','G','H','I','J','K','L','M',
                   'N','O','P','Q','R','S','T','U','V','W','X','Y','Z']) AS letter
ON CONFLICT (gloss, sign_language) DO NOTHING;

-- ---------- ANGKA (static, 1 tangan) ----------
INSERT INTO signs (gloss, sign_language, category, motion_type, hands_required, description)
SELECT num, 'BISINDO', 'number', 'static', 1,
       'Bentuk tangan statis untuk angka ' || num || '.'
FROM unnest(ARRAY['0','1','2','3','4','5','6','7','8','9']) AS num
ON CONFLICT (gloss, sign_language) DO NOTHING;

-- ---------- KOSAKATA DASAR (dynamic, kalimat sehari-hari) ----------
INSERT INTO signs (gloss, sign_language, category, motion_type, hands_required, description, example_sentence) VALUES
  ('HALO',          'BISINDO', 'word', 'dynamic', 1, 'Lambaian tangan terbuka di dekat kepala sebagai salam pembuka.', 'HALO, APA KABAR?'),
  ('APA KABAR',     'BISINDO', 'phrase', 'dynamic', 2, 'Gerakan kedua tangan membentuk pertanyaan ramah tentang keadaan lawan bicara.', 'HALO, APA KABAR?'),
  ('TERIMA KASIH',  'BISINDO', 'word', 'dynamic', 1, 'Telapak tangan menyentuh dagu lalu bergerak ke depan menjauhi wajah.', 'TERIMA KASIH BANYAK.'),
  ('TOLONG',        'BISINDO', 'word', 'dynamic', 2, 'Tangan mengepal di atas telapak tangan lain, terangkat bersama ke atas.', 'TOLONG BANTU SAYA.'),
  ('MAAF',          'BISINDO', 'word', 'dynamic', 1, 'Tangan mengepal digosokkan memutar di dada.', 'MAAF, SAYA TERLAMBAT.'),
  ('YA',            'BISINDO', 'word', 'dynamic', 1, 'Tangan mengepal mengangguk seperti kepala.', 'YA, SAYA MENGERTI.'),
  ('TIDAK',         'BISINDO', 'word', 'dynamic', 1, 'Jari telunjuk & tengah bergerak menyilang menjauh.', 'TIDAK, SAYA TIDAK BISA.'),
  ('SAYA',          'BISINDO', 'word', 'static', 1, 'Telunjuk menunjuk ke dada sendiri.', 'SAYA MAU BELAJAR BISINDO.'),
  ('KAMU',          'BISINDO', 'word', 'static', 1, 'Telunjuk menunjuk ke arah lawan bicara.', 'KAMU SIAPA?'),
  ('NAMA',          'BISINDO', 'word', 'dynamic', 2, 'Dua jari telunjuk saling mengetuk beberapa kali.', 'NAMA SAYA BUDI.'),
  ('SIAPA',         'BISINDO', 'word', 'dynamic', 1, 'Telunjuk bergerak melingkar kecil di depan dagu.', 'NAMA KAMU SIAPA?'),
  ('BELAJAR',       'BISINDO', 'word', 'dynamic', 2, 'Tangan seperti mengambil sesuatu dari telapak lalu diletakkan ke dahi.', 'SAYA BELAJAR BISINDO.'),
  ('BANTU',         'BISINDO', 'word', 'dynamic', 2, 'Kepalan tangan di atas telapak tangan lain terangkat ke atas bersamaan.', 'TOLONG BANTU SAYA.'),
  ('MENGERTI',      'BISINDO', 'word', 'dynamic', 1, 'Telunjuk menyentuh dahi lalu membuka ke depan seperti lampu menyala.', 'SAYA MENGERTI SEKARANG.'),
  ('SELAMAT PAGI',  'BISINDO', 'phrase', 'dynamic', 1, 'Tangan terbuka bergerak dari bawah ke atas seperti matahari terbit.', 'SELAMAT PAGI SEMUA.'),
  ('SELAMAT MALAM', 'BISINDO', 'phrase', 'dynamic', 1, 'Tangan terbuka bergerak dari atas ke bawah seperti matahari terbenam.', 'SELAMAT MALAM, SAMPAI BESOK.'),
  ('RUMAH',         'BISINDO', 'word', 'static', 2, 'Kedua tangan membentuk atap segitiga di atas kepala.', 'SAYA DI RUMAH.'),
  ('MAKAN',         'BISINDO', 'word', 'dynamic', 1, 'Jari-jari mengumpul menyentuh mulut berulang seperti menyuap.', 'SAYA MAU MAKAN.'),
  ('MINUM',         'BISINDO', 'word', 'dynamic', 1, 'Tangan membentuk huruf C didekatkan ke mulut lalu dimiringkan.', 'SAYA HAUS, MAU MINUM.'),
  ('BAIK',          'BISINDO', 'word', 'static', 1, 'Ibu jari mengacung ke atas (jempol).', 'KABAR SAYA BAIK.')
ON CONFLICT (gloss, sign_language) DO NOTHING;

-- ---------- Sinonim umum ----------
INSERT INTO sign_synonyms (sign_id, synonym)
SELECT id, 'MAKASIH' FROM signs WHERE gloss = 'TERIMA KASIH' AND sign_language = 'BISINDO'
ON CONFLICT DO NOTHING;

INSERT INTO sign_synonyms (sign_id, synonym)
SELECT id, 'HAI' FROM signs WHERE gloss = 'HALO' AND sign_language = 'BISINDO'
ON CONFLICT DO NOTHING;

INSERT INTO sign_synonyms (sign_id, synonym)
SELECT id, 'SORRY' FROM signs WHERE gloss = 'MAAF' AND sign_language = 'BISINDO'
ON CONFLICT DO NOTHING;
