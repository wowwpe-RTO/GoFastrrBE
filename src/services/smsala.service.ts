import axios from "axios";

const SEND_OTP_URL = "https://api2.smsala.com/whatsapp/SendOtp";

export async function sendWhatsAppOtp(
  phone: string,
  otp: string
): Promise<number> {
  const response = await axios.post(SEND_OTP_URL, {
    PhoneNumber: `91${phone}`, // IMPORTANT: include country code
    OtpCode: otp,
    ApiToken: process.env.SMSALA_API_TOKEN,
    TemplateId: Number(process.env.SMSALA_OTP_TEMPLATE_ID ),

    // Only send callback in production (https)
    ...(process.env.API_BASE_URL &&
      process.env.API_BASE_URL.startsWith("https://") && {
        CallbackUrl: `${process.env.API_BASE_URL}/auth/webhooks/whatsapp-dlr`,
      }),
  });

  if (!response.data?.IsSuccess) {
    const error: any = new Error(
      `SMSala rejected OTP send: ${
        response.data?.ErrorDescription ?? "unknown error"
      }`
    );

    // attach raw response for debugging
    error.response = { data: response.data };

    
    throw error;
  }

  return response.data.ReturnData as number;
}