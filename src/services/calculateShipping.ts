export function calculateShipping(
  subtotalPaise: number,
  postalCode?: string | null
): number {

  /* FREE SHIPPING RULE */
  if (subtotalPaise >= 300000) {
    return 0;
  }

  /* PINCODE BASED RULES */
  if (postalCode?.startsWith("56")) {
    return 4000;
  }

  return 7000;
}