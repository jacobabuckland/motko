/**
 * MotkoAI ROI Measurement Job
 *
 * Runs once and exits. Schedule externally (cron, GitHub Actions, etc.) to run
 * a few times per day — it is idempotent and safe to re-run.
 *
 * For each executed action that does not yet have a measurement at the current
 * window milestone (24h / 7d / 30d), the job:
 *   1. Fetches Shopify revenue for the 7 days BEFORE the action (pre_value).
 *   2. Fetches Shopify revenue for the window period AFTER the action (post_value).
 *   3. Computes avg daily revenue delta = (post_value - pre_value) / window.days.
 *   4. Writes the result to `roi_measurements`.
 *   5. Layer 3 check: if delta > 0 and the merchant has ≥ LAYER3_THRESHOLD positive
 *      measurements for that action_type, appends a note to store_context.
 *
 * Measurement window tolerance (hours):
 *   24h  → eligible 20–28 h after executed_at
 *   7d   → eligible 144–192 h (6–8 days)
 *   30d  → eligible 672–768 h (28–32 days)
 *
 * Run manually:  node jobs/measure_roi.js
 * Cron example:  0 */6 * * * cd /path/to/motko && node jobs/measure_roi.js >> logs/roi.log 2>&1
 */

import 'dotenv/config';

import { getSupabaseClient } from '../utils/supabase.js';
import { appendStoreContextNote } from '../utils/context.js';
import { getMerchantCredentials } from '../utils/merchants.js';

const API_VERSION = '2024-01';
const LAYER3_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Measurement windows
// ---------------------------------------------------------------------------

const WINDOWS = [
  { name: '24h', days: 1,  minHours: 20,  maxHours: 28  },
  { name: '7d',  days: 7,  minHours: 144, maxHours: 192 },
  { name: '30d', days: 30, minHours: 672, maxHours: 768 },
];

// ---------------------------------------------------------------------------
// Shopify revenue fetch (inline — date-range aware)
// ---------------------------------------------------------------------------

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

    const link = resp.headers.get('Link') ?? '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  return orders;
}

/**
 * Returns the average daily revenue (total / days) for the given date range.
 * days = number of days in the window (divisor for the average).
 *
 * @param {string} storeUrl
 * @param {string} accessToken
 * @param {Date}   startDate   - inclusive window start
 * @param {Date}   endDate     - exclusive window end (capped at now if in future)
 * @param {number} days        - window length in days (used as the divisor)
 * @returns {number} avg daily revenue, rounded to 2 decimal places
 */
async function fetchAvgDailyRevenue(storeUrl, accessToken, startDate, endDate, days) {
  const params = new URLSearchParams({
    status: 'any',
    financial_status: 'paid',
    created_at_min: startDate.toISOString(),
    created_at_max: endDate.toISOString(),
    fields: 'id,created_at,total_price',
    limit: '250',
  });

  const initialUrl = `${storeUrl}/admin/api/${API_VERSION}/orders.json?${params}`;
  const orders = await fetchAllOrders(initialUrl, accessToken);

  const total = orders.reduce((sum, o) => sum + parseFloat(o.total_price ?? 0), 0);
  return Math.round((total / days) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Find actions that need measuring
// ---------------------------------------------------------------------------

/**
 * Returns all executed actions that are still within at least one measurement
 * window's eligibility range and have not yet been measured for that window.
 *
 * Returns an array of objects: { action, window }
 */
async function findUnmeasuredActions() {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const now = new Date();

  // Outer bound: oldest action we could still measure (30d + 32h tolerance)
  const oldestEligible = new Date(now - (WINDOWS.at(-1).maxHours + 24) * 60 * 60 * 1000);

  // Fetch all executed actions within the outer bound
  const { data: actions, error: actionsErr } = await client
    .from('actions_ledger')
    .select('id, merchant_id, action_type, executed_at')
    .eq('status', 'executed')
    .not('executed_at', 'is', null)
    .gte('executed_at', oldestEligible.toISOString())
    .order('executed_at', { ascending: false });

  if (actionsErr) throw new Error(`actions_ledger fetch failed: ${actionsErr.message}`);
  if (!actions?.length) return [];

  // Fetch existing measurements for these actions in one query
  const actionIds = actions.map((a) => a.id);
  const { data: existing, error: measErr } = await client
    .from('roi_measurements')
    .select('action_ledger_id, measurement_window')
    .in('action_ledger_id', actionIds);

  if (measErr) throw new Error(`roi_measurements fetch failed: ${measErr.message}`);

  // Build a Set of "id::window" strings for O(1) lookup
  const done = new Set((existing ?? []).map((m) => `${m.action_ledger_id}::${m.measurement_window}`));

  const candidates = [];

  for (const action of actions) {
    const executedAt = new Date(action.executed_at);
    const hoursElapsed = (now - executedAt) / (1000 * 60 * 60);

    for (const win of WINDOWS) {
      if (hoursElapsed < win.minHours) continue;  // too early
      if (hoursElapsed > win.maxHours) continue;  // window passed
      if (done.has(`${action.id}::${win.name}`)) continue; // already measured

      candidates.push({ action, window: win });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Layer 3 autonomy check
// ---------------------------------------------------------------------------

/**
 * After a positive delta measurement, counts how many positive measurements
 * exist for this merchant + action_type. If the count reaches LAYER3_THRESHOLD
 * and a note hasn't already been appended for this milestone, appends one.
 */
async function checkLayer3(merchantId, actionType) {
  const client = getSupabaseClient();
  if (!client) return;

  const { count, error } = await client
    .from('roi_measurements')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_id', merchantId)
    .eq('action_type', actionType)
    .gt('delta', 0);

  if (error) {
    console.error(`[MotkoAI] Layer 3 count query failed for ${actionType}:`, error.message);
    return;
  }

  if (count < LAYER3_THRESHOLD) return;

  // Check if we've already appended a note for this milestone to avoid duplicates.
  // We embed a sentinel string in the observation text and search store_context.
  const { data: ctx } = await client
    .from('store_context')
    .select('notes')
    .eq('merchant_id', merchantId)
    .single();

  const sentinel = `[autonomy:${actionType}:${LAYER3_THRESHOLD}]`;
  const alreadyNoted = (ctx?.notes ?? []).some((n) => n.observation?.includes(sentinel));
  if (alreadyNoted) return;

  await appendStoreContextNote(merchantId, {
    observation:
      `${sentinel} Action type "${actionType}" has achieved ${count} positive ROI ` +
      `measurements. Consider upgrading its guardrail from "approval_required" to "auto".`,
  });

  console.error(
    `[MotkoAI] Layer 3: ${actionType} reached ${count} positive outcomes for merchant ${merchantId} — note appended.`
  );
}

// ---------------------------------------------------------------------------
// Measure a single action × window pair
// ---------------------------------------------------------------------------

async function measureAction(action, window) {
  const { id, merchant_id, action_type, executed_at } = action;
  const executedAt = new Date(executed_at);
  const now = new Date();

  // Resolve credentials for this merchant
  const creds = await getMerchantCredentials(merchant_id);
  const { shopify_store_url: storeUrl, shopify_access_token: accessToken } = creds;

  // Pre window: 7 calendar days ending at executed_at (exclusive)
  const preEnd   = new Date(executedAt);
  const preStart = new Date(executedAt);
  preStart.setDate(preStart.getDate() - 7);
  const PRE_DAYS = 7;

  // Post window: window.days after executed_at, capped at now
  const postStart = new Date(executedAt);
  const postEnd   = new Date(Math.min(
    executedAt.getTime() + window.days * 24 * 60 * 60 * 1000,
    now.getTime()
  ));
  // Actual elapsed days for the post divisor (may be < window.days if capped)
  const actualPostDays = Math.max(1, (postEnd - postStart) / (1000 * 60 * 60 * 24));

  const [preValue, postValue] = await Promise.all([
    fetchAvgDailyRevenue(storeUrl, accessToken, preStart, preEnd, PRE_DAYS),
    fetchAvgDailyRevenue(storeUrl, accessToken, postStart, postEnd, actualPostDays),
  ]);

  const delta = Math.round((postValue - preValue) * 100) / 100;

  // Write measurement row
  const client = getSupabaseClient();
  const { error } = await client.from('roi_measurements').insert({
    merchant_id,
    action_ledger_id: id,
    action_type,
    measurement_window: window.name,
    pre_value:  preValue,
    post_value: postValue,
    delta,
    measured_at: now.toISOString(),
  });

  if (error) throw new Error(`roi_measurements insert failed: ${error.message}`);

  console.error(
    `[MotkoAI] Measured ${action_type} (${id}) @ ${window.name}: ` +
    `pre=${preValue}, post=${postValue}, delta=${delta > 0 ? '+' : ''}${delta}`
  );

  // Layer 3 check only on positive outcomes
  if (delta > 0) {
    await checkLayer3(merchant_id, action_type).catch((err) =>
      console.error(`[MotkoAI] Layer 3 check failed:`, err.message)
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const client = getSupabaseClient();
  if (!client) {
    console.error('[MotkoAI] Supabase not configured — check SUPABASE_URL and SUPABASE_SERVICE_KEY');
    process.exit(1);
  }

  const candidates = await findUnmeasuredActions();
  console.error(`[MotkoAI] ROI measurement starting — ${candidates.length} measurement(s) to run`);

  let succeeded = 0;
  let failed = 0;

  for (const { action, window } of candidates) {
    try {
      await measureAction(action, window);
      succeeded++;
    } catch (err) {
      failed++;
      console.error(
        `[MotkoAI] Failed to measure ${action.action_type} (${action.id}) @ ${window.name}:`,
        err.message
      );
    }
  }

  console.error(`[MotkoAI] ROI measurement complete — ${succeeded} succeeded, ${failed} failed`);
}

main().catch((err) => {
  console.error('[MotkoAI] Fatal error:', err);
  process.exit(1);
});
