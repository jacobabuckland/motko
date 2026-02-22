import { createClient } from '@supabase/supabase-js';

let _client = null;

/**
 * Returns the shared Supabase client, or null if env vars are absent.
 * Exported so utils/merchants.js can reuse the same singleton.
 */
export function getSupabaseClient() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) return null;

  _client = createClient(url, key);
  return _client;
}

/**
 * Inserts a leakage finding into the `leakage_log` table.
 * Falls back to stderr if Supabase is not configured.
 *
 * DDL for the merchant_id column (run once):
 *   alter table leakage_log
 *   add column merchant_id uuid references merchants(id);
 *
 * @param {object}      entry
 * @param {string}      entry.leakage_type      - e.g. 'zero_revenue_flow'
 * @param {string}      entry.description       - human-readable explanation
 * @param {string}      entry.estimated_impact  - e.g. '$1,200 potential loss'
 * @param {string|null} [entry.merchant_id]     - UUID from merchants table (optional)
 */
export async function logLeakage({ leakage_type, description, estimated_impact, merchant_id = null }) {
  const row = {
    detected_at: new Date().toISOString(),
    leakage_type,
    description,
    estimated_impact: String(estimated_impact ?? ''),
    ...(merchant_id ? { merchant_id } : {}),
  };

  const client = getSupabaseClient();

  if (!client) {
    // Omit row contents from stderr to avoid leaking any sensitive fields
    console.error(
      `[MotkoAI] Supabase not configured — leakage not persisted (type=${leakage_type}, merchant=${merchant_id ?? 'local'})`
    );
    return { success: false, reason: 'Supabase not configured' };
  }

  const { error } = await client.from('leakage_log').insert(row);

  if (error) {
    console.error('[MotkoAI] Supabase insert failed:', error.message);
    return { success: false, reason: error.message };
  }

  return { success: true };
}

/**
 * Inserts an action record into the `actions_ledger` table.
 * Falls back to stderr if Supabase is not configured.
 *
 * @param {object}      entry
 * @param {string}      entry.merchant_id        - UUID from merchants table
 * @param {string}      entry.action_type        - e.g. 'pause_flow', 'resume_flow'
 * @param {string}      [entry.status]           - 'executed' | 'blocked' | 'pending_approval'
 * @param {string|null} [entry.pre_metric_label] - e.g. 'flow_status'
 * @param {string|null} [entry.pre_metric_value] - e.g. 'active'
 * @param {string|null} [entry.estimated_impact] - e.g. '$1,200 potential impact'
 * @param {string|null} [entry.source_insight]   - human-readable context
 */
export async function logAction({
  merchant_id,
  action_type,
  status = 'executed',
  pre_metric_label = null,
  pre_metric_value = null,
  estimated_impact = null,
  source_insight = null,
}) {
  const now = new Date().toISOString();
  const row = {
    merchant_id,
    action_type,
    status,
    proposed_at: now,
    ...(status === 'executed' ? { executed_at: now } : {}),
    pre_metric_label,
    pre_metric_value,
    estimated_impact: estimated_impact ? String(estimated_impact) : null,
    source_insight,
  };

  const client = getSupabaseClient();

  if (!client) {
    console.error(
      `[MotkoAI] Supabase not configured — action not logged (type=${action_type}, merchant=${merchant_id})`
    );
    return { success: false, reason: 'Supabase not configured' };
  }

  const { error } = await client.from('actions_ledger').insert(row);

  if (error) {
    console.error('[MotkoAI] actions_ledger insert failed:', error.message);
    return { success: false, reason: error.message };
  }

  return { success: true };
}
