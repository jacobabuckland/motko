/**
 * MotkoAI Agent Context — store_context + hypotheses
 *
 * store_context  — one row per merchant. Holds computed benchmarks and a
 *   JSONB array of agent observations. Upserted by the morning briefing job
 *   after each data fetch. Read by get_agent_context() to build the system
 *   prompt sent to Claude.
 *
 * hypotheses — append-only log of agent theories, one row per hypothesis.
 *   Created by detect_revenue_leakage and the morning briefing job.
 *   Closed out (status → confirmed | dismissed) by ROI measurement jobs.
 *
 * Supabase DDL (run migration SQL before use — see Sprint 2-A output).
 */

import { getSupabaseClient } from './supabase.js';

// ---------------------------------------------------------------------------
// Agent context assembly
// ---------------------------------------------------------------------------

/**
 * Assembles a structured context object for a merchant, used by the morning
 * briefing job to build the Claude system prompt.
 *
 * Fetches four data sources in parallel:
 *   1. store_context  — benchmarks and agent observations
 *   2. hypotheses     — open/testing theories being tracked
 *   3. actions_ledger — last 7 days of actions (executed + pending)
 *   4. merchants      — guardrail settings (allowed_actions, impact_threshold)
 *
 * @param {string} merchantId
 * @returns {{
 *   store: object,
 *   open_hypotheses: object[],
 *   recent_actions: object[],
 *   guardrails: { allowed_actions: object, impact_threshold: number }
 * }}
 */
export async function getAgentContext(merchantId) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [store, hypotheses, actionsResult, merchantResult] = await Promise.all([
    getStoreContext(merchantId),
    getOpenHypotheses(merchantId),
    client
      .from('actions_ledger')
      .select('action_type, status, estimated_impact, source_insight, proposed_at, executed_at')
      .eq('merchant_id', merchantId)
      .gte('proposed_at', sevenDaysAgo)
      .order('proposed_at', { ascending: false })
      .limit(20),
    client
      .from('merchants')
      .select('allowed_actions, impact_threshold')
      .eq('id', merchantId)
      .single(),
  ]);

  if (merchantResult.error) {
    throw new Error(`getAgentContext: merchant fetch failed: ${merchantResult.error.message}`);
  }
  if (actionsResult.error) {
    console.error(`[MotkoAI] getAgentContext: actions_ledger fetch failed: ${actionsResult.error.message}`);
  }

  return {
    store:            store ?? {},
    open_hypotheses:  hypotheses,
    recent_actions:   actionsResult.data ?? [],
    guardrails: {
      allowed_actions:  merchantResult.data?.allowed_actions  ?? {},
      impact_threshold: merchantResult.data?.impact_threshold ?? 500,
    },
  };
}

// ---------------------------------------------------------------------------
// store_context
// ---------------------------------------------------------------------------

/**
 * Returns the store_context row for a merchant, or null if none exists yet.
 *
 * @param {string} merchantId
 * @returns {object|null}
 */
export async function getStoreContext(merchantId) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const { data, error } = await client
    .from('store_context')
    .select('*')
    .eq('merchant_id', merchantId)
    .single();

  if (error?.code === 'PGRST116') return null; // no row yet — not an error
  if (error) throw new Error(`getStoreContext failed: ${error.message}`);
  return data;
}

/**
 * Upserts scalar fields on store_context. Safe to call with a partial payload.
 * Does NOT touch the notes array — use appendStoreContextNote for that.
 *
 * @param {string} merchantId
 * @param {object} fields - any subset of scalar store_context columns,
 *   e.g. { store_name, industry, avg_daily_revenue, avg_order_value,
 *           currency, avg_open_rate, avg_click_rate }
 */
export async function upsertStoreContext(merchantId, fields) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const { error } = await client
    .from('store_context')
    .upsert(
      { merchant_id: merchantId, ...fields, updated_at: new Date().toISOString() },
      { onConflict: 'merchant_id' }
    );

  if (error) throw new Error(`upsertStoreContext failed: ${error.message}`);
}

/**
 * Appends a structured observation to the notes JSONB array.
 * Fetches the current array, appends, then upserts — safe for infrequent writes.
 *
 * @param {string} merchantId
 * @param {{ date?: string, observation: string }} note
 *   date defaults to today (YYYY-MM-DD) if omitted.
 *
 * Example note: { observation: 'Revenue dropped 30% on Tuesdays consistently' }
 */
export async function appendStoreContextNote(merchantId, note) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const dated = {
    date:        note.date ?? new Date().toISOString().slice(0, 10),
    observation: note.observation,
  };

  const existing = await getStoreContext(merchantId);
  const notes    = [...(existing?.notes ?? []), dated];

  await upsertStoreContext(merchantId, { notes });
}

// ---------------------------------------------------------------------------
// hypotheses
// ---------------------------------------------------------------------------

/**
 * Creates a new hypothesis with status 'open'.
 *
 * @param {string} merchantId
 * @param {{ hypothesis: string, evidence?: string }} params
 * @returns {string} The new hypothesis UUID
 */
export async function createHypothesis(merchantId, { hypothesis, evidence = null }) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const { data, error } = await client
    .from('hypotheses')
    .insert({ merchant_id: merchantId, hypothesis, evidence })
    .select('id')
    .single();

  if (error) throw new Error(`createHypothesis failed: ${error.message}`);
  return data.id;
}

/**
 * Patches a hypothesis row. Typical use: update status after testing,
 * record what action was taken, or log the outcome after measurement.
 *
 * @param {string} hypothesisId
 * @param {{ status?: string, evidence?: string, action_taken?: string, outcome?: string }} updates
 *   status must be one of: 'open' | 'testing' | 'confirmed' | 'dismissed'
 */
export async function updateHypothesis(hypothesisId, updates) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const { error } = await client
    .from('hypotheses')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', hypothesisId);

  if (error) throw new Error(`updateHypothesis failed: ${error.message}`);
}

/**
 * Returns all open or in-progress hypotheses for a merchant, newest first.
 * Used by get_agent_context() to include active theories in the system prompt.
 *
 * @param {string} merchantId
 * @returns {Array<{ id, hypothesis, status, evidence, action_taken, created_at }>}
 */
export async function getOpenHypotheses(merchantId) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const { data, error } = await client
    .from('hypotheses')
    .select('id, hypothesis, status, evidence, action_taken, created_at')
    .eq('merchant_id', merchantId)
    .in('status', ['open', 'testing'])
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getOpenHypotheses failed: ${error.message}`);
  return data ?? [];
}
