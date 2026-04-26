export async function registerOrdersCreateWebhook(
  shop: string,
  accessToken: string,
  appUrl: string
) {
  const query = `
    mutation webhookSubscriptionCreate {
      webhookSubscriptionCreate(
        topic: ORDERS_CREATE,
        webhookSubscription: {
          callbackUrl: "${appUrl}/webhooks/orders-create",
          format: JSON
        }
      ) {
        webhookSubscription {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const res = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const json = await res.json();

  console.log("Webhook create response:", JSON.stringify(json, null, 2));

  // Hard GraphQL errors (network / auth / etc)
  if (json.errors) {
    console.error("❌ Shopify GraphQL errors:", JSON.stringify(json.errors, null, 2));
    throw new Error("Webhook creation failed");
  }

  const result = json?.data?.webhookSubscriptionCreate;
  const userErrors = result?.userErrors ?? [];

  if (userErrors.length > 0) {
    const alreadyExists = userErrors.some((e: any) =>
      e.message?.includes("Address for this topic has already been taken")
    );

    // ✅ Idempotent success: webhook already registered
    if (alreadyExists) {
      console.log("ℹ️ Webhook already exists — continuing");
      return null;
    }

    // ❌ Real error
    console.error("❌ Webhook registration failed:", JSON.stringify(json, null, 2));
    throw new Error("Webhook creation failed");
  }

  return result.webhookSubscription?.id ?? null;
}
