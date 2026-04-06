export const CheckoutStep = {
  CART: "CART",
  OTP_SENT: "OTP_SENT",
  OTP_VERIFIED: "OTP_VERIFIED",
  ADDRESS_SAVED: "ADDRESS_SAVED",
  PAYMENT_READY: "PAYMENT_READY",
  PAYMENT_INITIATED: "PAYMENT_INITIATED",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type CheckoutStep =
  typeof CheckoutStep[keyof typeof CheckoutStep];