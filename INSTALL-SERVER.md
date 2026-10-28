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

Butuh kampus-meet yang sudah memuat titik sisip `import conf.d/app-*.caddy`
(ada sejak commit yang menambahkan `deploy/conf.d/`). Pastikan dulu:

```bash
grep -n "conf.d" /opt/kampusmeet/deploy/Caddyfile
```

Lalu:

```bash
mkdir -p /opt/kampusmeet/deploy/conf.d
cat > /opt/kampusmeet/deploy/conf.d/app-bisindo.caddy <<'EOF'
# Engine BISINDO dilayani di /bisindo (aplikasi terpisah di 127.0.0.1:3100).

# Tanpa garis miring akhir, path relatif di halaman akan resolve ke root domain.
redir /bisindo /bisindo/ 308

# Endpoint ini tidak berautentikasi di aplikasinya -> tutup dari publik.
# Muat ulang model dari dalam server:
#   curl -X POST http://127.0.0.1:3100/api/admin/reload-model
@bisindo_admin path /bisindo/api/admin/*
respond @bisindo_admin 403

# Menambah/mengubah kosakata hanya boleh dari dalam server:
# POST /api/signs tidak berautentikasi dan nilainya ditampilkan di halaman.
@bisindo_write {
	path /bisindo/api/signs*
	method POST PUT PATCH DELETE
}
respond @bisindo_write 403

handle_path /bisindo/* {
	reverse_proxy 127.0.0.1:3100 {
		# Cookie sesi UIKA Meet tidak perlu — dan tidak boleh — sampai ke aplikasi lain
		header_up -Cookie
	}
}
EOF

docker compose -f /opt/kampusmeet/deploy/docker-compose.yml --env-file /opt/kampusmeet/.env up -d caddy
docker compose -f /opt/kampusmeet/deploy/docker-compose.yml --env-file /opt/kampusmeet/.env logs --tail=20 caddy
```

Folder `deploy/conf.d/` di-.gitignore, jadi berkas ini **tidak akan tertimpa `git pull`**.

## 6. Uji

```bash
curl -s -o /dev/null -w "redirect  : %{http_code}\n" https://meet.uika-bogor.ac.id/bisindo
curl -s -o /dev/null -w "halaman   : %{http_code}\n" https://meet.uika-bogor.ac.id/bisindo/
curl -s                                              https://meet.uika-bogor.ac.id/bisindo/api/health
curl -s -o /dev/null -w "admin     : %{http_code}\n" -X POST https://meet.uika-bogor.ac.id/bisindo/api/admin/reload-model
curl -s -o /dev/null -w "meet utuh : %{http_code}\n" https://meet.uika-bogor.ac.id/
```

Harapan: `308`, `200`, JSON `status:ok`, `403`, `200`.
Baris terakhir memastikan aplikasi meet tidak terganggu rute baru ini.

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
