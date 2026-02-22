/**
 * MotkoAI Guardrail Enforcement
 *
 * Errors thrown by checkGuardrails carry a `code` property so callers can
 * distinguish rejection types without string-parsing:
 *   'blocked'           — action is off; never permitted
 *   'pending_approval'  — action requires merchant approval before executing
 *
 * Layer 1 — Scope: checks allowed_actions map on the merchant row.
 *   Modes per action: "auto" | "approval_required" | "off"
 *
 * Layer 2 — Impact Threshold: if the action's estimated_impact exceeds the
 *   merchant's impact_threshold (default £500), it also requires approval,
 *   even if the action mode is "auto".
 *
 * Throws a descriptive error on any guardrail violation. The MCP server
 * catches these and surfaces them as isError responses so Claude can relay
 * them conversationally to the merchant.
 *
 * Supabase schema required (run migration SQL before use):
 *
 *   ALTER TABLE merchants
 *     ADD COLUMN IF NOT EXISTS allowed_actions JSONB DEFAULT '{
 *       "pause_klaviyo_flow":    "approval_required",
 *       "resume_klaviyo_flow":   "approval_required",
 *       "create_draft_order":    "approval_required",
 *       "update_inventory_level":"approval_required",
 *       "create_discount_code":  "approval_required"
 *     }'::jsonb,
 *     ADD COLUMN IF NOT EXISTS impact_threshold INTEGER DEFAULT 500;
 */

import { getSupabaseClient } from './supabase.js';

/** Creates an Error with a machine-readable code for caller inspection. */
function guardrailError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const DEFAULT_ALLOWED_ACTIONS = {
  pause_klaviyo_flow:     'approval_required',
  resume_klaviyo_flow:    'approval_required',
  create_draft_order:     'approval_required',
  update_inventory_level: 'approval_required',
  create_discount_code:   'approval_required',
};

const DEFAULT_IMPACT_THRESHOLD = 500;

/**
 * Enforces guardrails before any write action is executed.
 *
 * @param {string} merchantId       - Merchant UUID (startup-resolved, never from tool args)
 * @param {string} action_type      - Must match a key in the allowed_actions map
 * @param {number} [estimated_impact=0] - Claude's estimated revenue impact in merchant currency
 *
 * @throws {Error} If the action is off, requires approval, or exceeds the impact threshold.
 * @returns {void}  Resolves silently when the action is permitted.
 */
export async function checkGuardrails(merchantId, action_type, estimated_impact = 0) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase is not configured. Cannot verify guardrail settings.');
  }

  const { data, error } = await client
    .from('merchants')
    .select('allowed_actions, impact_threshold')
    .eq('id', merchantId)
    .single();

  if (error || !data) {
    throw new Error('Guardrail check failed: could not load merchant settings from Supabase.');
  }

  const allowed   = data.allowed_actions   ?? DEFAULT_ALLOWED_ACTIONS;
  const threshold = data.impact_threshold  ?? DEFAULT_IMPACT_THRESHOLD;
  const mode      = allowed[action_type];

  // Layer 1 — Scope check
  if (!mode || mode === 'off') {
    throw guardrailError(
      `Action "${action_type}" is not permitted by your guardrail settings. ` +
      `To enable it, update your allowed_actions in MotkoAI.`,
      'blocked'
    );
  }

  if (mode === 'approval_required') {
    throw guardrailError(
      `Action "${action_type}" requires your approval before it can be executed. ` +
      `Reply with "approve" to confirm, or "cancel" to skip.`,
      'pending_approval'
    );
  }

  // Layer 2 — Impact threshold check (only reached when mode === 'auto')
  if (estimated_impact > threshold) {
    throw guardrailError(
      `Action "${action_type}" has an estimated impact of £${estimated_impact}, ` +
      `which exceeds your approval threshold of £${threshold}. ` +
      `Reply with "approve" to confirm, or "cancel" to skip.`,
      'pending_approval'
    );
  }

  // Guardrails passed — action is auto-approved and within threshold.
}
