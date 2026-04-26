import { getPool } from "../db";

export async function cleanupExpiredOtps() {
  const pool = getPool();

  await pool.query(`
    DELETE FROM otp_codes
    WHERE expires_at < now()
       OR consumed_at IS NOT NULL
  `);
}
