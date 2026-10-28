# Engine BISINDO. Dibungkus container agar tidak perlu memasang Node/PostgreSQL di host,
# dan agar port-nya bisa dikunci ke 127.0.0.1 tanpa mengubah kode aplikasi.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
# Model terlatih (±60 MB) ikut masuk image supaya container langsung siap mengenali tanda
COPY data/models ./data/models

USER node
EXPOSE 3000
# /api/health ikut memeriksa koneksi database, jadi healthcheck ini mencakup keduanya
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "src/server.js"]
