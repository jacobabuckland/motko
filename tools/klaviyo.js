/**
 * Klaviyo v3 API integration.
 *
 * Strategy:
 *  1. Fetch all active flows.
 *  2. Fetch metric IDs for "Sent Email", "Opened Email", "Clicked Email",
 *     and "Placed Order" (for revenue attribution).
 *  3. Query metric aggregates grouped by $flow / $attributed_flow with
 *     interval=day so we get daily breakdowns.
 *  4. Merge everything into a per-flow result set.
 *
 * Note: Klaviyo metric aggregate dimension values are flow *names*, not IDs,
 * when using `by: ["$flow"]`. Revenue attribution uses `by: ["$attributed_flow"]`.
 *
 * Credentials are resolved in priority order:
 *  1. merchant_id → Supabase `merchants` table  (production / multi-tenant)
 *  2. KLAVIYO_API_KEY env var                    (local dev fallback)
 */

import { getMerchantCredentials } from '../utils/merchants.js';
import { logAction } from '../utils/supabase.js';

const BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-02-15';

/**
 * Resolves the Klaviyo API key for the given merchant.
 * Falls back to the KLAVIYO_API_KEY env var when no merchant_id is supplied.
 */
async function resolveApiKey(merchantId) {
  if (merchantId) {
    const creds = await getMerchantCredentials(merchantId);
    return creds.klaviyo_api_key;
  }

  const apiKey = process.env.KLAVIYO_API_KEY;
  if (!apiKey) {
    throw new Error('Provide a merchant_id or set the KLAVIYO_API_KEY env var');
  }
  return apiKey;
}

function headers(apiKey) {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: REVISION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/** Headers for Klaviyo mutation endpoints (JSON:API format required). */
function writeHeaders(apiKey) {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: REVISION,
    'Content-Type': 'application/vnd.api+json',
    Accept: 'application/json',
  };
}

/** Follows Klaviyo cursor pagination (links.next). */
async function fetchAllPages(url, apiKey) {
  const items = [];
  let next = url;

  while (next) {
    const resp = await fetch(next, { headers: headers(apiKey) });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Klaviyo GET ${resp.status}: ${body}`);
    }
    const json = await resp.json();
    items.push(...(json.data ?? []));
    next = json.links?.next ?? null;
  }

  return items;
}

/** Returns all metric objects from this Klaviyo account. */
async function fetchMetrics(apiKey) {
  return fetchAllPages(`${BASE}/metrics/?fields[metric]=name`, apiKey);
}

/**
 * Queries the metric-aggregate endpoint.
 *
 * @param {string}   apiKey
 * @param {string}   metricId
 * @param {Date}     startDate
 * @param {Date}     endDate
 * @param {string[]} by           - grouping dimensions, e.g. ['$flow']
 * @param {string[]} measurements - e.g. ['count'] or ['sum_value']
 */
async function queryAggregate(apiKey, metricId, startDate, endDate, by, measurements = ['count']) {
  const body = {
    data: {
      type: 'metric-aggregate',
      attributes: {
        metric_id: metricId,
        filter: [
          `greater-or-equal(datetime,${startDate.toISOString()})`,
          `less-than(datetime,${endDate.toISOString()})`,
        ],
        measurements,
        interval: 'day',
        by,
        timezone: 'UTC',
        page_size: 500,
      },
    },
  };

  const resp = await fetch(`${BASE}/metric-aggregates/`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Klaviyo metric-aggregate ${resp.status}: ${text}`);
  }

  return resp.json();
}

/**
 * Extracts a { total, daily: [{date, value}] } shape for one flow name
 * from a Klaviyo metric-aggregate response.
 */
function extractFlowMetric(aggregateAttr, flowName, measureKey = 'count') {
  const dates = aggregateAttr.dates ?? [];
  const rows = aggregateAttr.data ?? [];

  const row = rows.find((r) => r.dimensions?.[0] === flowName);
  if (!row) return { total: 0, daily: dates.map((d) => ({ date: d.slice(0, 10), value: 0 })) };

  const values = row.measurements?.[measureKey] ?? [];
  const total = values.reduce((s, v) => s + (v ?? 0), 0);
  const daily = dates.map((d, i) => ({
    date: d.slice(0, 10),
    value: values[i] ?? 0,
  }));

  return { total, daily };
}

/**
 * Fetches all active Klaviyo flows and their 7-day performance metrics.
 *
 * @param {string} [merchantId] - Merchant UUID. Omit to use env var fallback.
 * @returns {object}
 */
export async function getKlaviyoFlowPerformance(merchantId) {
  const apiKey = await resolveApiKey(merchantId);

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);
  startDate.setHours(0, 0, 0, 0);

  // 1. Fetch active flows
  const flows = await fetchAllPages(
    `${BASE}/flows/?filter=equals(status,'active')&fields[flow]=name,status,created,updated`,
    apiKey
  );

  if (flows.length === 0) {
    return {
      period_start: startDate.toISOString().slice(0, 10),
      period_end: endDate.toISOString().slice(0, 10),
      active_flow_count: 0,
      flows: [],
    };
  }

  // 2. Resolve metric IDs (each Klaviyo account has unique UUIDs)
  const allMetrics = await fetchMetrics(apiKey);
  const metricId = (name) => allMetrics.find((m) => m.attributes?.name === name)?.id ?? null;

  const sentId = metricId('Sent Email');
  const openedId = metricId('Opened Email');
  const clickedId = metricId('Clicked Email');
  const orderId = metricId('Placed Order');

  // 3. Query aggregates in parallel (skip metrics with no ID)
  const [sentAgg, openedAgg, clickedAgg, revenueAgg] = await Promise.all([
    sentId
      ? queryAggregate(apiKey, sentId, startDate, endDate, ['$flow'], ['count'])
          .catch((e) => { console.error('sent agg failed:', e.message); return null; })
      : null,
    openedId
      ? queryAggregate(apiKey, openedId, startDate, endDate, ['$flow'], ['count'])
          .catch((e) => { console.error('opened agg failed:', e.message); return null; })
      : null,
    clickedId
      ? queryAggregate(apiKey, clickedId, startDate, endDate, ['$flow'], ['count'])
          .catch((e) => { console.error('clicked agg failed:', e.message); return null; })
      : null,
    orderId
      ? queryAggregate(apiKey, orderId, startDate, endDate, ['$attributed_flow'], ['sum_value'])
          .catch((e) => { console.error('revenue agg failed:', e.message); return null; })
      : null,
  ]);

  const sentAttr    = sentAgg?.data?.attributes    ?? {};
  const openedAttr  = openedAgg?.data?.attributes  ?? {};
  const clickedAttr = clickedAgg?.data?.attributes ?? {};
  const revenueAttr = revenueAgg?.data?.attributes ?? {};

  // 4. Build per-flow result
  const flowPerformance = flows.map((flow) => {
    const name = flow.attributes?.name ?? flow.id;

    const sent    = extractFlowMetric(sentAttr,    name, 'count');
    const opened  = extractFlowMetric(openedAttr,  name, 'count');
    const clicked = extractFlowMetric(clickedAttr, name, 'count');
    const revenue = extractFlowMetric(revenueAttr, name, 'sum_value');

    return {
      flow_id: flow.id,
      flow_name: name,
      status: flow.attributes?.status ?? 'active',
      emails_sent: sent.total,
      open_rate:
        sent.total > 0
          ? Math.round((opened.total / sent.total) * 1000) / 1000
          : null,
      click_rate:
        sent.total > 0
          ? Math.round((clicked.total / sent.total) * 1000) / 1000
          : null,
      revenue_attributed: Math.round(revenue.total * 100) / 100,
      // Daily sends used by detect_revenue_leakage for mid-week drop analysis
      daily_sends: sent.daily,
    };
  });

  return {
    period_start: startDate.toISOString().slice(0, 10),
    period_end: endDate.toISOString().slice(0, 10),
    active_flow_count: flows.length,
    flows: flowPerformance,
  };
}

/**
 * Returns all Klaviyo flows (any status) with id, name, status, and trigger type.
 *
 * @param {string} merchantId - Merchant UUID
 */
export async function getKlaviyoFlowList(merchantId) {
  const creds = await getMerchantCredentials(merchantId);
  const apiKey = creds.klaviyo_api_key;

  const flows = await fetchAllPages(
    `${BASE}/flows/?fields[flow]=name,status,trigger_type&sort=name`,
    apiKey
  );

  return {
    flow_count: flows.length,
    flows: flows.map((f) => ({
      flow_id: f.id,
      flow_name: f.attributes?.name ?? f.id,
      status: f.attributes?.status ?? 'unknown',
      trigger_type: f.attributes?.trigger_type ?? 'unknown',
    })),
  };
}

/**
 * Pauses a Klaviyo flow by setting its status to 'draft'.
 * Requires klaviyo_write_enabled on the merchant record.
 *
 * @param {string} merchantId - Merchant UUID
 * @param {string} flowId     - Klaviyo flow ID
 */
export async function pauseKlaviyoFlow(merchantId, flowId, estimatedImpact = 0) {
  const creds = await getMerchantCredentials(merchantId);

  if (!creds.klaviyo_write_enabled) {
    return {
      requires_approval: true,
      reason: 'Klaviyo write access is not enabled for this merchant. Enable it in the MotkoAI dashboard to allow flow management.',
    };
  }

  const apiKey = creds.klaviyo_api_key;

  // Fetch current state for pre-metric snapshot
  const flowResp = await fetch(
    `${BASE}/flows/${flowId}/?fields[flow]=name,status`,
    { headers: headers(apiKey) }
  );
  if (!flowResp.ok) {
    const text = await flowResp.text();
    throw new Error(`Klaviyo flow fetch ${flowResp.status}: ${text}`);
  }
  const flowData = await flowResp.json();
  const flowName = flowData.data?.attributes?.name ?? flowId;
  const priorStatus = flowData.data?.attributes?.status ?? 'unknown';

  // Execute pause (draft = paused in Klaviyo)
  const resp = await fetch(`${BASE}/flows/${flowId}/`, {
    method: 'PATCH',
    headers: writeHeaders(apiKey),
    body: JSON.stringify({
      data: { type: 'flow', id: flowId, attributes: { status: 'draft' } },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Klaviyo pause flow ${resp.status}: ${text}`);
  }

  await logAction({
    merchant_id: merchantId,
    action_type: 'pause_klaviyo_flow',
    status: 'executed',
    pre_metric_label: 'flow_status',
    pre_metric_value: priorStatus,
    estimated_impact: estimatedImpact > 0 ? estimatedImpact : null,
    source_insight: `Flow "${flowName}" paused via MotkoAI`,
  });

  return {
    success: true,
    flow_id: flowId,
    flow_name: flowName,
    previous_status: priorStatus,
    new_status: 'draft',
  };
}

/**
 * Resumes a Klaviyo flow by setting its status to 'live'.
 * Requires klaviyo_write_enabled on the merchant record.
 *
 * @param {string} merchantId - Merchant UUID
 * @param {string} flowId     - Klaviyo flow ID
 */
export async function resumeKlaviyoFlow(merchantId, flowId, estimatedImpact = 0) {
  const creds = await getMerchantCredentials(merchantId);

  if (!creds.klaviyo_write_enabled) {
    return {
      requires_approval: true,
      reason: 'Klaviyo write access is not enabled for this merchant. Enable it in the MotkoAI dashboard to allow flow management.',
    };
  }

  const apiKey = creds.klaviyo_api_key;

  // Fetch current state for pre-metric snapshot
  const flowResp = await fetch(
    `${BASE}/flows/${flowId}/?fields[flow]=name,status`,
    { headers: headers(apiKey) }
  );
  if (!flowResp.ok) {
    const text = await flowResp.text();
    throw new Error(`Klaviyo flow fetch ${flowResp.status}: ${text}`);
  }
  const flowData = await flowResp.json();
  const flowName = flowData.data?.attributes?.name ?? flowId;
  const priorStatus = flowData.data?.attributes?.status ?? 'unknown';

  // Execute resume (live = active/sending in Klaviyo)
  const resp = await fetch(`${BASE}/flows/${flowId}/`, {
    method: 'PATCH',
    headers: writeHeaders(apiKey),
    body: JSON.stringify({
      data: { type: 'flow', id: flowId, attributes: { status: 'live' } },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Klaviyo resume flow ${resp.status}: ${text}`);
  }

  await logAction({
    merchant_id: merchantId,
    action_type: 'resume_klaviyo_flow',
    status: 'executed',
    pre_metric_label: 'flow_status',
    pre_metric_value: priorStatus,
    estimated_impact: estimatedImpact > 0 ? estimatedImpact : null,
    source_insight: `Flow "${flowName}" resumed via MotkoAI`,
  });

  return {
    success: true,
    flow_id: flowId,
    flow_name: flowName,
    previous_status: priorStatus,
    new_status: 'live',
  };
}
