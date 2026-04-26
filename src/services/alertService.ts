import axios from "axios";

/**
 * Central alert dispatcher
 * (Slack for now, extensible later)
 */
export async function sendAlert(payload: {
  level: "info" | "warn" | "critical";
  event: string;
  checkoutSessionId?: string;
  message: string;
  meta?: any;
}) {
  try {
    const webhook = process.env.ALERTS_SLACK_WEBHOOK;

    if (!webhook) {
      console.warn("⚠️ ALERTS_SLACK_WEBHOOK missing — alert skipped");
      return;
    }

    const emoji =
      payload.level === "critical"
        ? "🚨"
        : payload.level === "warn"
        ? "⚠️"
        : "ℹ️";

    await axios.post(webhook, {
      text: `${emoji} *${payload.event}*\n${
        payload.checkoutSessionId
          ? `Checkout: ${payload.checkoutSessionId}\n`
          : ""
      }${payload.message}`,
      attachments: payload.meta
        ? [
            {
              color:
                payload.level === "critical"
                  ? "danger"
                  : payload.level === "warn"
                  ? "warning"
                  : "good",
              text: "```" + JSON.stringify(payload.meta, null, 2) + "```",
            },
          ]
        : [],
    });
  } catch (err) {
    console.error("❌ Failed to send alert:", err);
  }
}
