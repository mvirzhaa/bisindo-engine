// Menjalankan schema.sql terhadap database yang dikonfigurasi di .env
const fs = require("fs");
const path = require("path");
const { pool } = require("../db/pool");

async function migrate() {
  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  console.log("[migrate] menjalankan schema.sql ...");
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log("[migrate] selesai. Tabel siap dipakai.");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("[migrate] gagal:", err.message);
  process.exit(1);
});
