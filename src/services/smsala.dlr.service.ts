import axios from "axios";

const DLR_URL = "https://api2.smsala.com/Whatsapp/GetDlrDetails";

// No changes needed — URL casing matches SMSala docs.
// campaign_id is now correctly persisted in auth.ts (fix #1),
// so DLR lookups will return real data.

export async function getDlr(campaignId: string) {
  try {
    const res = await axios.post(DLR_URL, {
      apiToken: process.env.SMSALA_API_TOKEN,
      WhatsAppCampaignId: campaignId,
    });

    return res.data?.ReturnData;
  } catch (err: any) {
    console.error("DLR fetch failed:", err?.response?.data || err.message);
    throw new Error("DLR fetch failed");
  }
}