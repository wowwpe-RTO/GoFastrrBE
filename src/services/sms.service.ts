import axios from "axios";

// FIX #8: this service is now wired into auth.ts as the SMS fallback
// after WA + WA-retry both fail.
//
// Required env vars:
//   SMS_API_URL  — your SMS provider's endpoint (MSG91, TextLocal, etc.)
//   SMS_API_KEY  — provider API key
//
// Errors bubble up — auth.ts handles the fallback chain, not this service.

export async function sendSmsOtp(phone: string, otp: string): Promise<void> {
  const res = await axios.post(process.env.SMS_API_URL!, {
    to: phone,
    message: `Your Wowwpe OTP is ${otp}. Valid for 5 minutes. Do not share.`,
    apiKey: process.env.SMS_API_KEY,
  });

  // Treat non-2xx as failure — axios throws automatically, but guard
  // in case provider returns 200 with an error body
  if (res.data?.error || res.data?.success === false) {
    throw new Error(
      `SMS provider error: ${res.data?.error ?? "unknown"}`
    );
  }
}