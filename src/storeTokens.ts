// In-memory store (OK for dev)
// Replace with DB later

export const storeTokens = new Map<string, string>();

export function getToken(shop: string) {
  return storeTokens.get(shop);
}

export function setToken(shop: string, token: string) {
  storeTokens.set(shop, token);
}
