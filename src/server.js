require("dotenv").config();
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");

const { pool } = require("./db/pool");
const signsRouter = require("./routes/signs");
const samplesRouter = require("./routes/samples");
const sessionsRouter = require("./routes/sessions");
const { attachTranscribeSocket } = require("./ws/transcribeSocket");
const { SignClassifier, resolveActiveModelPath } = require("./engine/classifier");

const PORT = process.env.PORT || 3000;
const MODELS_DIR = path.join(__dirname, "..", "data", "models");

const app = express();
app.use(express.json({ limit: "15mb" })); // sequence landmark bisa cukup besar
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/signs", signsRouter);
app.use("/api/samples", samplesRouter);
app.use("/api/sessions", sessionsRouter);

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", modelReady: classifier.isReady(), modelMeta: classifier.modelMeta });
  } catch (err) {
    res.status(503).json({ status: "db_unreachable", error: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error("[http] unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const classifier = new SignClassifier();
function tryLoadModel() {
  const activePath = resolveActiveModelPath(MODELS_DIR);
  if (activePath) {
    classifier.loadFromFile(activePath);
  } else {
    console.warn(
      "[server] Belum ada model aktif. Rekam data latih di /collect.html lalu jalankan `npm run train`."
    );
  }
}
tryLoadModel();

const server = app.listen(PORT, () => {
  console.log(`[server] BISINDO sign engine berjalan di http://localhost:${PORT}`);
  console.log(`[server] Halaman demo transkripsi : http://localhost:${PORT}/index.html`);
  console.log(`[server] Halaman rekam data latih  : http://localhost:${PORT}/collect.html`);
});

const wss = new WebSocketServer({ server, path: "/ws/transcribe" });
attachTranscribeSocket(wss, classifier);

// Reload model tanpa restart server, dipanggil manual setelah `npm run train`
app.post("/api/admin/reload-model", (req, res) => {
  try {
    tryLoadModel();
    res.json({ status: "reloaded", modelMeta: classifier.modelMeta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

process.on("SIGTERM", async () => {
  server.close();
  await pool.end();
  process.exit(0);
});
