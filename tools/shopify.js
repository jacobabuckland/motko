/**
 * Shopify Admin REST API integration.
 * Fetches orders for the last 7 days with cursor-based pagination.
 *
 * Credentials are resolved in priority order:
 *  1. merchant_id → Supabase `merchants` table  (production / multi-tenant)
 *  2. SHOPIFY_STORE_URL / SHOPIFY_ACCESS_TOKEN env vars  (local dev fallback)
 */

import { getMerchantCredentials } from '../utils/merchants.js';
import { logAction } from '../utils/supabase.js';

const API_VERSION = '2024-01';

function shopifyHeaders(accessToken) {
  return {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  };
}

/**
 * Resolves Shopify credentials for the given merchant.
 * Falls back to env vars when no merchant_id is supplied.
 */
async function resolveCredentials(merchantId) {
  if (merchantId) {
    const creds = await getMerchantCredentials(merchantId);
    return { storeUrl: creds.shopify_store_url, accessToken: creds.shopify_access_token };
  }

  // Local dev fallback
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!storeUrl || !accessToken) {
    throw new Error(
      'Provide a merchant_id or set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN env vars'
    );
  }
  return { storeUrl, accessToken };
}

/**
 * Fetches all orders across paginated Shopify responses.
 * Shopify uses cursor-based pagination via the Link header.
 */
async function fetchAllOrders(initialUrl, accessToken) {
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  };

  const orders = [];
  let url = initialUrl;

  while (url) {
    const resp = await fetch(url, { headers });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Shopify API error ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    orders.push(...(data.orders ?? []));

    // Shopify provides a Link header with rel="next" for the next page
    const link = resp.headers.get('Link') ?? '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  return orders;
}

/**
 * Returns total revenue, order count, and a per-day revenue breakdown
 * for the last 7 days from the Shopify Admin API.
 *
 * @param {string} [merchantId] - Merchant UUID. Omit to use env var fallback.
 * @returns {object}
 */
export async function getShopifyRevenue(merchantId) {
  const { storeUrl, accessToken } = await resolveCredentials(merchantId);

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);
  startDate.setHours(0, 0, 0, 0);

  const params = new URLSearchParams({
    status: 'any',
    financial_status: 'paid',
    created_at_min: startDate.toISOString(),
    fields: 'id,created_at,total_price,currency,financial_status',
    limit: '250',
  });

  const initialUrl = `${storeUrl}/admin/api/${API_VERSION}/orders.json?${params}`;
  const orders = await fetchAllOrders(initialUrl, accessToken);

  // Aggregate totals
  let totalRevenue = 0;
  const byDay = {};

  for (const order of orders) {
    const price = parseFloat(order.total_price ?? 0);
    totalRevenue += price;

    const date = order.created_at.slice(0, 10); // YYYY-MM-DD
    if (!byDay[date]) {
      byDay[date] = { date, revenue: 0, order_count: 0 };
    }
    byDay[date].revenue += price;
    byDay[date].order_count += 1;
  }

  // Round revenue figures
  const revenueByDay = Object.values(byDay)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      ...d,
      revenue: Math.round(d.revenue * 100) / 100,
    }));

  return {
    period_start: startDate.toISOString().slice(0, 10),
    period_end: endDate.toISOString().slice(0, 10),
    total_revenue: Math.round(totalRevenue * 100) / 100,
    order_count: orders.length,
    currency: orders[0]?.currency ?? 'USD',
    revenue_by_day: revenueByDay,
  };
}

/**
 * Creates a Shopify draft order.
 * Requires shopify_write_enabled on the merchant record.
 *
 * @param {string} merchantId
 * @param {Array<{ variant_id: string, quantity: number }>} lineItems
 */
export async function createDraftOrder(merchantId, lineItems, estimatedImpact = 0) {
  const creds = await getMerchantCredentials(merchantId);

  if (!creds.shopify_write_enabled) {
    return {
      requires_approval: true,
      reason: 'Shopify write access is not enabled for this merchant. Enable it in the MotkoAI dashboard to allow order management.',
    };
  }

  const { storeUrl, accessToken } = {
    storeUrl: creds.shopify_store_url,
    accessToken: creds.shopify_access_token,
  };

  const resp = await fetch(
    `${storeUrl}/admin/api/${API_VERSION}/draft_orders.json`,
    {
      method: 'POST',
      headers: shopifyHeaders(accessToken),
      body: JSON.stringify({
        draft_order: {
          line_items: lineItems.map((item) => ({
            variant_id: item.variant_id,
            quantity: item.quantity,
          })),
        },
      }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Shopify create draft order ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const order = data.draft_order;

  await logAction({
    merchant_id: merchantId,
    action_type: 'create_draft_order',
    status: 'executed',
    pre_metric_label: 'line_item_count',
    pre_metric_value: String(lineItems.length),
    estimated_impact: estimatedImpact > 0 ? estimatedImpact : null,
    source_insight: `Draft order #${order.id} created via MotkoAI`,
  });

  return {
    success: true,
    draft_order_id: order.id,
    name: order.name,
    status: order.status,
    total_price: order.total_price,
    currency: order.currency,
    invoice_url: order.invoice_url ?? null,
    line_items: order.line_items?.map((li) => ({
      variant_id: String(li.variant_id),
      title: li.title,
      quantity: li.quantity,
      price: li.price,
    })) ?? [],
  };
}

/**
 * Sets the available inventory quantity for a variant at its primary location.
 * Requires shopify_write_enabled on the merchant record.
 *
 * @param {string} merchantId
 * @param {string} variantId  - Shopify variant ID
 * @param {number} quantity   - New available quantity
 */
export async function updateInventoryLevel(merchantId, variantId, quantity, estimatedImpact = 0) {
  const creds = await getMerchantCredentials(merchantId);

  if (!creds.shopify_write_enabled) {
    return {
      requires_approval: true,
      reason: 'Shopify write access is not enabled for this merchant. Enable it in the MotkoAI dashboard to allow inventory management.',
    };
  }

  const { storeUrl, accessToken } = {
    storeUrl: creds.shopify_store_url,
    accessToken: creds.shopify_access_token,
  };
  const h = shopifyHeaders(accessToken);

  // 1. Get inventory_item_id from variant
  const variantResp = await fetch(
    `${storeUrl}/admin/api/${API_VERSION}/variants/${variantId}.json?fields=id,inventory_item_id,title`,
    { headers: h }
  );
  if (!variantResp.ok) {
    const text = await variantResp.text();
    throw new Error(`Shopify variant fetch ${variantResp.status}: ${text}`);
  }
  const variantData = await variantResp.json();
  const inventoryItemId = variantData.variant?.inventory_item_id;
  const variantTitle = variantData.variant?.title ?? variantId;
  if (!inventoryItemId) throw new Error(`No inventory_item_id for variant ${variantId}`);

  // 2. Get current inventory level (location_id + prior quantity)
  const levelsResp = await fetch(
    `${storeUrl}/admin/api/${API_VERSION}/inventory_levels.json?inventory_item_ids=${inventoryItemId}&limit=1`,
    { headers: h }
  );
  if (!levelsResp.ok) {
    const text = await levelsResp.text();
    throw new Error(`Shopify inventory levels fetch ${levelsResp.status}: ${text}`);
  }
  const levelsData = await levelsResp.json();
  let locationId = levelsData.inventory_levels?.[0]?.location_id ?? null;
  const priorQuantity = levelsData.inventory_levels?.[0]?.available ?? null;

  // 3. Fall back to primary location if no level exists yet
  if (!locationId) {
    const locResp = await fetch(
      `${storeUrl}/admin/api/${API_VERSION}/locations.json?limit=1`,
      { headers: h }
    );
    if (!locResp.ok) {
      const text = await locResp.text();
      throw new Error(`Shopify locations fetch ${locResp.status}: ${text}`);
    }
    const locData = await locResp.json();
    locationId = locData.locations?.[0]?.id ?? null;
    if (!locationId) throw new Error('No Shopify locations found for this store');
  }

  // 4. Set inventory level
  const setResp = await fetch(
    `${storeUrl}/admin/api/${API_VERSION}/inventory_levels/set.json`,
    {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        inventory_item_id: inventoryItemId,
        location_id: locationId,
        available: quantity,
      }),
    }
  );
  if (!setResp.ok) {
    const text = await setResp.text();
    throw new Error(`Shopify set inventory ${setResp.status}: ${text}`);
  }
  const setData = await setResp.json();

  await logAction({
    merchant_id: merchantId,
    action_type: 'update_inventory_level',
    status: 'executed',
    pre_metric_label: 'previous_quantity',
    pre_metric_value: priorQuantity !== null ? String(priorQuantity) : 'unknown',
    estimated_impact: estimatedImpact > 0 ? estimatedImpact : null,
    source_insight: `Inventory for variant "${variantTitle}" set to ${quantity} via MotkoAI`,
  });

  return {
    success: true,
    variant_id: variantId,
    variant_title: variantTitle,
    inventory_item_id: inventoryItemId,
    location_id: locationId,
    previous_quantity: priorQuantity,
    new_quantity: setData.inventory_level?.available ?? quantity,
  };
}

/**
 * Creates a Shopify price rule and a reusable discount code.
 * Requires shopify_write_enabled on the merchant record.
 *
 * @param {string} merchantId
 * @param {object} config
 * @param {string} config.title          - Internal name for the price rule
 * @param {'percentage'|'fixed_amount'} config.discount_type
 * @param {number} config.value          - Positive number (e.g. 10 for 10% or $10)
 * @param {string} config.code           - Discount code customers will use
 * @param {number} [config.usage_limit]  - Max redemptions; omit for unlimited
 */
export async function createDiscountCode(merchantId, { title, discount_type, value, code, usage_limit }, estimatedImpact = 0) {
  const creds = await getMerchantCredentials(merchantId);

  if (!creds.shopify_write_enabled) {
    return {
      requires_approval: true,
      reason: 'Shopify write access is not enabled for this merchant. Enable it in the MotkoAI dashboard to allow discount management.',
    };
  }

  const { storeUrl, accessToken } = {
    storeUrl: creds.shopify_store_url,
    accessToken: creds.shopify_access_token,
  };
  const h = shopifyHeaders(accessToken);

  // 1. Create price rule (value must be negative in Shopify's API)
  const priceRuleBody = {
    price_rule: {
      title,
      target_type: 'line_item',
      target_selection: 'all',
      allocation_method: 'across',
      value_type: discount_type,
      value: `-${Math.abs(value)}`,
      customer_selection: 'all',
      starts_at: new Date().toISOString(),
      ...(usage_limit != null ? { usage_limit } : {}),
    },
  };

  const ruleResp = await fetch(
    `${storeUrl}/admin/api/${API_VERSION}/price_rules.json`,
    { method: 'POST', headers: h, body: JSON.stringify(priceRuleBody) }
  );
  if (!ruleResp.ok) {
    const text = await ruleResp.text();
    throw new Error(`Shopify create price rule ${ruleResp.status}: ${text}`);
  }
  const ruleData = await ruleResp.json();
  const priceRuleId = ruleData.price_rule?.id;
  if (!priceRuleId) throw new Error('Shopify did not return a price rule ID');

  // 2. Create discount code under the price rule
  const codeResp = await fetch(
    `${storeUrl}/admin/api/${API_VERSION}/price_rules/${priceRuleId}/discount_codes.json`,
    {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ discount_code: { code } }),
    }
  );
  if (!codeResp.ok) {
    const text = await codeResp.text();
    throw new Error(`Shopify create discount code ${codeResp.status}: ${text}`);
  }
  const codeData = await codeResp.json();

  const displayValue = discount_type === 'percentage'
    ? `${value}% off`
    : `$${value} off`;

  await logAction({
    merchant_id: merchantId,
    action_type: 'create_discount_code',
    status: 'executed',
    pre_metric_label: 'discount_value',
    pre_metric_value: displayValue,
    estimated_impact: estimatedImpact > 0 ? estimatedImpact : null,
    source_insight: `Discount code "${code}" (${displayValue}) created via MotkoAI`,
  });

  return {
    success: true,
    price_rule_id: priceRuleId,
    discount_code_id: codeData.discount_code?.id,
    code: codeData.discount_code?.code ?? code,
    discount_type,
    value: displayValue,
    usage_limit: usage_limit ?? null,
  };
}
