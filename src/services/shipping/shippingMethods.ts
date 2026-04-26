export type ShippingMethod = {
  id: string
  title: string
  pricePaise: number
  etaDays: number
}

export function buildShippingMethods(
  basePrice: number
): ShippingMethod[] {
  
  return [
    {
      id: "STANDARD",
      title: "Standard Delivery",
      pricePaise: basePrice,
      etaDays: 4
    },
    {
      id: "EXPRESS",
      title: "Express Delivery",
      pricePaise: basePrice + 3000,
      etaDays: 1
    }
  ];
}