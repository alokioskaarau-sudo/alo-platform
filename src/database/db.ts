import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL fehlt.");
}

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

db.on("error", (error) => {
  console.error("PostgreSQL Pool Fehler:", error);
});

export async function testDatabaseConnection() {
  const result = await db.query(
    "SELECT NOW() AS server_time"
  );

  return result.rows[0];
}
