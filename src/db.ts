import pg from "pg";

const { Pool } = pg;

export function createPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    lock_timeout: 5_000,
    application_name: "tron-seamless-gateway"
  });
}

export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}

export type HeldDatabaseLock = {
  release(): Promise<void>;
};

const GATEWAY_SINGLETON_LOCK_ID = "8073361072184433";

export async function tryAcquireGatewaySingleton(pool: pg.Pool): Promise<HeldDatabaseLock | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [GATEWAY_SINGLETON_LOCK_ID]
    );
    if (result.rows[0]?.acquired !== true) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [GATEWAY_SINGLETON_LOCK_ID]);
      } finally {
        client.release();
      }
    }
  };
}
