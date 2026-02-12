import { Router } from "express";
import { getPool } from "../db";

const router = Router();

router.get("/metrics", async (_req, res) => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE step='COMPLETED') AS completed,
      COUNT(*) FILTER (WHERE step='PAYMENT_INITIATED') AS pending_payment,
      COUNT(*) FILTER (WHERE step='ADDRESS_SAVED') AS address_saved,
      COUNT(*) AS total
    FROM checkout_sessions
  `);

  const r = result.rows[0];

  res.type("text/plain").send(`
checkout_total ${r.total}
checkout_completed ${r.completed}
checkout_pending_payment ${r.pending_payment}
checkout_address_saved ${r.address_saved}
`);
});

export default router;
