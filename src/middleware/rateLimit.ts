import rateLimit from "express-rate-limit";

/**
 * OTP endpoints – very strict
 */
export const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Checkout – more lenient
 */
export const checkoutLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
});
