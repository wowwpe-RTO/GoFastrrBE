import { getPool } from "../db";

/**
 * Persist Shopify access token (idempotent)
 */
export async function setToken(shop: string, token: string) {
  const pool = getPool();

  await pool.query(
    `
    INSERT INTO shopify_tokens (shop, access_token, updated_at)
    VALUES ($1, $2, now())
    ON CONFLICT (shop)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      updated_at = now()
    `,
    [shop, token]
  );
}

/**
 * Retrieve Shopify access token
 */
export async function getToken(shop: string): Promise<string | null> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT access_token FROM shopify_tokens WHERE shop = $1`,
    [shop]
  );

  if (!result.rowCount) return null;

  return result.rows[0].access_token;
}
