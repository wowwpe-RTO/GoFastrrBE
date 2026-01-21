export const CheckoutStep = {
  PHONE_ENTERED: "PHONE_ENTERED",
  OTP_VERIFIED: "OTP_VERIFIED",
  ADDRESS_SAVED: "ADDRESS_SAVED",
  PAYMENT_INITIATED: "PAYMENT_INITIATED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED"
} as const;

export type CheckoutStep =
  typeof CheckoutStep[keyof typeof CheckoutStep];
