// Mengisi kosakata awal (alfabet, angka, kata umum BISINDO) ke database
const fs = require("fs");
const path = require("path");
const { pool } = require("../db/pool");

async function seed() {
  const seedPath = path.join(__dirname, "..", "db", "seed.sql");
  const sql = fs.readFileSync(seedPath, "utf8");
  console.log("[seed] mengisi kosakata awal ...");
  const client = await pool.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query("SELECT count(*)::int AS n FROM signs");
    console.log(`[seed] selesai. Total kosakata di database: ${rows[0].n}`);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error("[seed] gagal:", err.message);
  process.exit(1);
});
