import { CheckoutStep } from "./checkoutStates";

const allowedTransitions: Record<CheckoutStep, CheckoutStep[]> = {
  CART: [CheckoutStep.OTP_SENT],

  OTP_SENT: [CheckoutStep.OTP_VERIFIED],

  OTP_VERIFIED: [CheckoutStep.ADDRESS_SAVED],

  ADDRESS_SAVED: [CheckoutStep.PAYMENT_READY],

  PAYMENT_READY: [CheckoutStep.PAYMENT_INITIATED],

  PAYMENT_INITIATED: [
    CheckoutStep.PARTIALLY_PAID,
    CheckoutStep.COMPLETED,
    CheckoutStep.FAILED,
  ],

  PARTIALLY_PAID: [CheckoutStep.COMPLETED, CheckoutStep.FAILED],

  COMPLETED: [],
  FAILED: [],
};

export function assertTransition(
  from: CheckoutStep,
  to: CheckoutStep
) {
  const allowed = allowedTransitions[from] || [];

  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid checkout transition: ${from} → ${to}`
    );
  }
}