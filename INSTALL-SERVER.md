# Pemasangan BISINDO Engine di server UIKA Meet

Dilayani sebagai **subpath**: `https://meet.uika-bogor.ac.id/bisindo/`
Tidak perlu DNS baru.

| | Nilai |
|---|---|
| Lokasi | `/opt/bisindo-engine` |
| Port aplikasi (host) | `127.0.0.1:3100` |
| Port PostgreSQL (host) | `127.0.0.1:55432` |
| Akses publik | lewat Caddy milik kampus-meet, prefix `/bisindo` |

## Yang sudah diubah dari paket asli

Subpath memaksa beberapa perubahan — tanpa ini aplikasi tidak jalan di luar root:

| Berkas | Perubahan | Alasan |
|---|---|---|
| `public/index.html`, `public/collect.html` | 8 path absolut (`/js/…`, `/api/…`) → relatif (`./js/…`) | di subpath, `/js/…` menunjuk ke root domain (aplikasi meet), bukan ke BISINDO |
| `public/index.html` | URL WebSocket dibangun dengan `new URL("./ws/transcribe", location.href)` | agar ikut prefix halaman |
| `public/index.html`, `public/collect.html` | 4 titik `innerHTML` kini di-escape | `POST /api/signs` tidak berautentikasi; nama kosakata ditampilkan mentah → XSS tersimpan. Satu origin dengan UIKA Meet, jadi XSS di sini = pengambilalihan akun meet |
| `docker-compose.yml` | port dikunci `127.0.0.1`, password acak, batas CPU | bawaannya mempublikasikan PostgreSQL ke publik dengan password `bisindo_password` |
| `Dockerfile` | baru | agar tidak perlu memasang Node di host dan port bisa dikunci tanpa mengubah kode server |

## 1. Salin & ekstrak

Dari laptop:

```bash
scp bisindo-sign-engine-deploy.zip root@<server>:/opt/
```

Di server:

```bash
cd /opt && unzip -q bisindo-sign-engine-deploy.zip   # terekstrak menjadi /opt/bisindo-engine
ls /opt/bisindo-engine
```

## 2. Buat .env dengan password acak

```bash
cd /opt/bisindo-engine
cat > .env <<EOF
PGDATABASE=bisindo_engine
PGUSER=bisindo
PGPASSWORD=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
RECOGNITION_CONFIDENCE_THRESHOLD=0.75
STABILITY_FRAMES=8
EOF
chmod 600 .env
```

Password bawaan paket (`bisindo_password`) sengaja tidak dipakai.

## 3. Jalankan database, lalu muat dump

```bash
docker compose --env-file .env up -d bisindo-db
docker compose --env-file .env ps bisindo-db          # tunggu sampai healthy

# skema + 88 kosakata + 47.976 sampel latih (135 MB, perlu beberapa menit)
docker compose --env-file .env exec -T bisindo-db \
  psql -U bisindo -d bisindo_engine < data/bisindo_engine_dump.sql
```

Verifikasi:

```bash
docker compose --env-file .env exec bisindo-db \
  psql -U bisindo -d bisindo_engine \
  -c "SELECT COUNT(*) AS kosakata FROM signs;" \
  -c "SELECT COUNT(*) AS sampel FROM sign_samples;"
```

Harapan: 88 kosakata, ±47.976 sampel.

## 4. Build & jalankan aplikasi

```bash
docker compose --env-file .env up -d --build
sleep 20
curl -s http://127.0.0.1:3100/api/health
```

Harapan: `{"status":"ok","modelReady":true,…}`
`modelReady:false` → model tidak terbaca, cek `data/models/active_model.json`.

## 5. Daftarkan rute /bisindo di Caddy

Butuh kampus-meet yang sudah memuat titik sisip `import conf.d/app-*.caddy`. Pastikan dulu:

```bash
grep -c "conf.d" /opt/kampusmeet/deploy/Caddyfile      # harus > 0
```

Buat berkasnya dengan `printf`, **bukan heredoc** — paste heredoc sering terpotong di
klien SSH dan menyisakan berkas kosong, yang membuat Caddy gagal start (bukan sekadar
peringatan) sehingga seluruh situs meet ikut mati.

```bash
mkdir -p /opt/kampusmeet/deploy/conf.d
printf '%s\n' '@bisindo_write {' '  path /api/signs*' '  method POST PUT PATCH DELETE' '}' '' 'redir /bisindo /bisindo/ 308' '' 'handle_path /bisindo/* {' '  route {' '    respond /api/admin/* 403' '    respond @bisindo_write 403' '    reverse_proxy 127.0.0.1:3100 {' '      header_up -Cookie' '    }' '  }' '}' > /opt/kampusmeet/deploy/conf.d/app-bisindo.caddy
wc -l /opt/kampusmeet/deploy/conf.d/app-bisindo.caddy   # harus 16
```

Tiga hal yang membuat konfigurasi ini bekerja — ketiganya hasil kesalahan nyata saat
pemasangan pertama:

1. **Blokir harus di DALAM `handle_path`, dibungkus `route`.** Caddy mengurutkan ulang
   direktif: `handle_path` dievaluasi sebelum `respond` di tingkat yang sama, sehingga
   `respond 403` di luar tidak pernah tercapai. `route` mempertahankan urutan penulisan.
2. **Path di dalam `handle_path` sudah dilucuti prefiksnya** — tulis `/api/admin/*`,
   bukan `/bisindo/api/admin/*`.
3. **`redir` tanpa garis miring akhir wajib ada**, kalau tidak path relatif di halaman
   akan resolve ke root domain (aplikasi meet).

Validasi dulu, lalu reload:

```bash
cd /opt/kampusmeet
docker compose -f deploy/docker-compose.yml --env-file .env exec caddy caddy validate --config /etc/caddy/Caddyfile
docker compose -f deploy/docker-compose.yml --env-file .env exec caddy caddy reload --config /etc/caddy/Caddyfile
```

> **`docker compose up -d caddy` TIDAK cukup.** Bila definisi compose tidak berubah,
> container tidak dibuat ulang dan Caddy tetap memakai konfigurasi lama di memori —
> Caddy tidak memantau perubahan berkas. Setiap kali mengubah `deploy/conf.d/*.caddy`,
> jalankan `caddy reload` (tanpa downtime).
>
> Peringatan `No files matching import glob pattern` untuk `site-*.caddy` itu normal —
> glob itu memang belum dipakai.

## 6. Uji

```bash
R="--resolve meet.uika-bogor.ac.id:443:127.0.0.1"; B="https://meet.uika-bogor.ac.id"
for u in "/bisindo" "/bisindo/" "/"; do curl -s -o /dev/null -w "$u -> %{http_code}\n" $R "$B$u"; done
curl -s -o /dev/null -w "health       -> %{http_code}\n" $R "$B/bisindo/api/health"
curl -s -o /dev/null -w "admin (POST) -> %{http_code}\n" $R -X POST "$B/bisindo/api/admin/reload-model"
curl -s -o /dev/null -w "signs tulis  -> %{http_code}\n" $R -X POST -H 'Content-Type: application/json' -d '{}' "$B/bisindo/api/signs"
curl -s -o /dev/null -w "signs baca   -> %{http_code}\n" $R "$B/bisindo/api/signs?language=BISINDO"
```

Harapan:

```
/bisindo -> 308
/bisindo/ -> 200
/ -> 200
health       -> 200
admin (POST) -> 403
signs tulis  -> 403
signs baca   -> 200
```

Baris `/ -> 200` memastikan rute baru tidak mengganggu aplikasi meet.
Dua baris terakhir memastikan jalur XSS tertutup (tulis diblokir) tanpa mematikan
`collect.html` (baca tetap jalan).

Lalu buka `https://meet.uika-bogor.ac.id/bisindo/` di browser dan izinkan kamera.
Perekam data latih: `/bisindo/collect.html`.

## Catatan operasional

- **Satu origin dengan UIKA Meet.** Ini konsekuensi subpath. Kerentanan apa pun di
  BISINDO berjalan di origin `meet.uika-bogor.ac.id`. XSS yang sudah diperbaiki di atas
  adalah contoh nyatanya. Kalau nanti ada tambahan fitur di BISINDO, perlakukan
  keamanannya setara aplikasi meet — atau pindahkan ke subdomain sendiri.
- **CPU**: server 4 core, Egress sudah dibatasi 3. BISINDO dibatasi 1,5 core agar
  rekaman meeting tetap kebagian.
- **MediaPipe dari CDN**: halaman memuat `@mediapipe/tasks-vision` dari jsdelivr dan
  model tangan dari storage.googleapis.com. Karena kini satu origin dengan meet,
  pertimbangkan meng-host sendiri bila kelak ditanam ke dalam halaman meet (CSP meet
  melarang CDN).
- **Menambah kosakata** (diblokir dari publik), dari dalam server:
  ```bash
  curl -X POST http://127.0.0.1:3100/api/signs -H 'Content-Type: application/json' -d '{...}'
  ```
- **Melatih ulang**: `docker compose exec bisindo-app node src/scripts/train.js`, lalu
  `curl -X POST http://127.0.0.1:3100/api/admin/reload-model`.
- **Lisensi**: 32 kata dinamis dari WL-BISINDO, CC BY-NC 4.0 (non-komersial).
