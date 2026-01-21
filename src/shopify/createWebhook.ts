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

  const res = await fetch(
    `https://${shop}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    }
  );

  const json = await res.json();

  console.log(
  "Webhook create response:",
  JSON.stringify(json, null, 2)
);

  if (
    json.errors ||
    json.data.webhookSubscriptionCreate.userErrors.length
  ) {
    console.error(
      "Webhook registration failed:",
      JSON.stringify(json, null, 2)
    );
    throw new Error("Webhook creation failed");
  }

  return json.data.webhookSubscriptionCreate.webhookSubscription.id;
}
