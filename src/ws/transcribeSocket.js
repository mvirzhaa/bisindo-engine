// =====================================================================
// WebSocket endpoint /ws/transcribe
//
// Protokol pesan JSON (client -> server):
//   { type: "start", displayName?, signLanguage? }
//   { type: "frame", hands: [{handedness, landmarks:[[x,y,z],...21]}] }
//   { type: "commit_word" }      // paksa tutup huruf fingerspelling yg sedang dirangkai
//   { type: "stop" }
//
// Pesan server -> client:
//   { type: "ready", sessionId }
//   { type: "recognition", event: "letter"|"word", gloss, confidence, transcriptSoFar }
//   { type: "transcript_update", transcriptSoFar }
//   { type: "error", message }
// =====================================================================

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { SessionEngine } = require("../engine/sessionEngine");

function attachTranscribeSocket(wss, classifier) {
  wss.on("connection", (ws) => {
    let engine = null;
    let sessionId = null;
    let sequenceIndex = 0;

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Payload bukan JSON valid" }));
        return;
      }

      try {
        switch (msg.type) {
          case "start": {
            if (!classifier.isReady()) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message:
                    "Model belum dilatih. Rekam data lewat /collect.html lalu jalankan `npm run train`.",
                })
              );
            }
            engine = new SessionEngine(classifier);
            sequenceIndex = 0;
            const { rows } = await pool.query(
              `INSERT INTO sessions (display_name, sign_language) VALUES ($1,$2) RETURNING id`,
              [msg.displayName || null, msg.signLanguage || "BISINDO"]
            );
            sessionId = rows[0].id;
            ws.send(JSON.stringify({ type: "ready", sessionId }));
            break;
          }

          case "frame": {
            if (!engine) return;
            const events = engine.processFrame(msg);
            for (const ev of events) {
              if (ev.type === "letter" || ev.type === "word") {
                sequenceIndex += 1;
                await pool.query(
                  `INSERT INTO transcript_segments
                     (session_id, sign_id, recognized_text, confidence, started_at, ended_at, sequence_index)
                   VALUES ($1,$2,$3,$4, now(), now(), $5)`,
                  [sessionId, ev.signId || null, ev.gloss, ev.confidence, sequenceIndex]
                );
              }
              ws.send(
                JSON.stringify({
                  type: "recognition",
                  event: ev.type,
                  gloss: ev.gloss,
                  confidence: ev.confidence,
                  transcriptSoFar: ev.transcriptSoFar,
                })
              );
            }
            break;
          }

          case "commit_word": {
            if (!engine) return;
            const events = engine.commitCurrentWord();
            for (const ev of events) {
              ws.send(JSON.stringify({ type: "transcript_update", transcriptSoFar: ev.transcriptSoFar }));
            }
            break;
          }

          case "stop": {
            if (sessionId) {
              await pool.query(`UPDATE sessions SET ended_at = now() WHERE id = $1`, [sessionId]);
            }
            engine = null;
            break;
          }

          default:
            ws.send(JSON.stringify({ type: "error", message: `Tipe pesan tidak dikenal: ${msg.type}` }));
        }
      } catch (err) {
        console.error("[ws] error memproses pesan:", err);
        ws.send(JSON.stringify({ type: "error", message: "Terjadi kesalahan di server" }));
      }
    });

    ws.on("close", async () => {
      if (sessionId) {
        try {
          await pool.query(`UPDATE sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL`, [
            sessionId,
          ]);
        } catch (err) {
          console.error("[ws] gagal menutup sesi saat disconnect:", err.message);
        }
      }
    });
  });
}

module.exports = { attachTranscribeSocket };
