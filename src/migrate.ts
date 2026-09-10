import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createPool, closePool } from "./db.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = createPool(databaseUrl);
const client = await pool.connect();
try {
  const sqlDirectory = path.resolve(process.cwd(), "sql");
  const migrations = (await readdir(sqlDirectory))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  await client.query("SELECT pg_advisory_lock(8073361072184431::bigint)");
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  for (const file of migrations) {
    const version = file.slice(0, -4);
    const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    if ((applied.rowCount ?? 0) > 0) continue;
    const sql = await readFile(path.join(sqlDirectory, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      process.stdout.write(`Applied migration ${version}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(8073361072184431::bigint)").catch(() => undefined);
  client.release();
  await closePool(pool);
}
