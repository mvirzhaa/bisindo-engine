const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || "bisindo_engine",
  user: process.env.PGUSER || "bisindo",
  password: process.env.PGPASSWORD || "bisindo_password",
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("[db] unexpected error on idle client", err);
});

module.exports = { pool };
