import {
  FREE_SHIPPING_THRESHOLD, PINCODE_ZONES
} from "./shippingRules";

import { buildShippingMethods } from "./shippingMethods";

export function calculateShippingMethods(
  subtotalPaise: number,
  postalCode?: string | null
) {

  if (!postalCode) {
    return [];
  }

  // FREE SHIPPING
  
  if (subtotalPaise >= FREE_SHIPPING_THRESHOLD) {
    return [
      {
        id: "FREE",
        title: "Free Delivery",
        pricePaise: 0,
        etaDays: 4
      }
    ]
  }

  /* FIND ZONES */

  const zone = 
  PINCODE_ZONES.find(z =>
    z.prefix === "*" ||
    postalCode.startsWith(z.prefix)
  );

  const basePrice = zone?.standard ?? 7000;

  return buildShippingMethods(basePrice)
}