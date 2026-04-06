import axios from "axios";
import { getToken } from "./shopTokenService";

interface ShopBranding {
  storeName: string | null;
  logoUrl: string | null;
}

const cache = new Map<string, { branding: ShopBranding; fetchedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function getShopBranding(shop: string): Promise<ShopBranding> {
  const now = Date.now();
  const cached = cache.get(shop);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.branding;
  }

  const token = await getToken(shop);
  if (!token) return { storeName: null, logoUrl: null };

  const headers = {
    "X-Shopify-Access-Token": token.trim(),
    "Content-Type": "application/json",
  };

  let storeName: string | null = null;
  let logoUrl: string | null = null;

  // ── Step 1: Store name from shop.json ──
  try {
    const shopRes = await axios.get(
      `https://${shop}/admin/api/2025-01/shop.json`,
      { headers, timeout: 8000 }
    );
    storeName = shopRes.data?.shop?.name || null;
  } catch (err: any) {
    console.error(`[shopBranding] shop.json failed:`, err.message);
  }

  // ── Step 2: GraphQL brand kit ──
  try {
    const gqlRes = await axios.post(
      `https://${shop}/admin/api/2025-01/graphql.json`,
      {
        query: `{
          shop {
            brand {
              logo { image { url } }
              squareLogo { image { url } }
            }
          }
        }`,
      },
      { headers, timeout: 8000 }
    );
    const brand = gqlRes.data?.data?.shop?.brand;
    logoUrl = brand?.logo?.image?.url || brand?.squareLogo?.image?.url || null;
    if (logoUrl) console.log(`[shopBranding] Got logo via brand kit: ${logoUrl}`);
  } catch (err: any) {
    console.error(`[shopBranding] GraphQL brand failed:`, err.message);
  }

  // ── Step 3: Search uploaded files for anything named "logo" ──
  if (!logoUrl) {
    try {
      const filesRes = await axios.post(
        `https://${shop}/admin/api/2025-01/graphql.json`,
        {
          query: `{
            files(first: 20, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  ... on MediaImage {
                    alt
                    image {
                      url
                      width
                      height
                    }
                  }
                }
              }
            }
          }`,
        },
        { headers, timeout: 8000 }
      );

      const edges = filesRes.data?.data?.files?.edges || [];
      console.log(`[shopBranding] Files API returned ${edges.length} files`);

      // Find a file that looks like a logo
      const logoFile = edges.find((e: any) => {
        const url: string = e?.node?.image?.url || "";
        const alt: string = e?.node?.alt || "";
        return (
          url.toLowerCase().includes("logo") ||
          alt.toLowerCase().includes("logo")
        );
      });

      if (logoFile?.node?.image?.url) {
        logoUrl = logoFile.node.image.url;
        console.log(`[shopBranding] Got logo from Files API: ${logoUrl}`);
      } else if (edges.length > 0) {
        // Log all files so we can see what's available
        console.log(`[shopBranding] No logo found in files. Available files:`);
        edges.slice(0, 5).forEach((e: any) => {
          console.log(`  - alt:"${e?.node?.alt}" url:${e?.node?.image?.url}`);
        });
      }
    } catch (err: any) {
      console.error(`[shopBranding] Files API failed:`, err.message);
    }
  }


  const branding: ShopBranding = { storeName, logoUrl };
  cache.set(shop, { branding, fetchedAt: now });
  return branding;
}