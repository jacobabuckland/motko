/**
 * MotkoAI Morning Briefing Job
 *
 * Runs once for all active merchants and exits. Schedule externally (cron,
 * GitHub Actions, etc.) to run at 6am daily in the merchant's timezone.
 *
 * For each active merchant:
 *   1. Fetch agent context (store benchmarks, open hypotheses, recent actions, guardrails)
 *   2. Run revenue leakage detection (Shopify + Klaviyo)
 *   3. Send both to Claude claude-sonnet-4-6 with an ops-manager system prompt
 *   4. Parse structured JSON response:
 *        { briefing, issues: [{hypothesis, evidence}], suggested_actions: [{action_type, reason, estimated_impact}] }
 *   5. Store the briefing text in the `briefings` table
 *   6. Create a hypothesis row for each issue
 *   7. Queue each suggested action in `actions_ledger` with status `pending_approval`
 *
 * Required env vars (beyond Supabase):
 *   ANTHROPIC_API_KEY — Anthropic API key
 *
 * Run manually:  node jobs/morning_briefing.js
 * Cron example:  0 6 * * * cd /path/to/motko && node jobs/morning_briefing.js >> logs/briefing.log 2>&1
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

import { getSupabaseClient } from '../utils/supabase.js';
import { logAction } from '../utils/supabase.js';
import { getAgentContext, createHypothesis } from '../utils/context.js';
import { detectRevenueLeakage } from '../tools/leakage.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Merchant list
// ---------------------------------------------------------------------------

async function fetchActiveMerchants() {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured — check SUPABASE_URL and SUPABASE_SERVICE_KEY');

  const { data, error } = await client
    .from('merchants')
    .select('id, shopify_store_url')
    .eq('is_active', true);

  if (error) throw new Error(`Failed to fetch active merchants: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(context) {
  const { guardrails } = context;

  const permittedActions = Object.entries(guardrails.allowed_actions)
    .filter(([, mode]) => mode !== 'off')
    .map(([action]) => action);

  return `You are an expert ecommerce operations manager reviewing the daily performance of an online store. Your job is to identify revenue problems, form hypotheses about their causes, and recommend specific corrective actions.

You will receive a JSON object containing:
- store_context: benchmarks (average daily revenue, order value, email rates) and historical observations
- leakage_findings: cross-referenced Shopify and Klaviyo data from the last 7 days
- open_hypotheses: theories you are already tracking — do not duplicate these
- recent_actions: actions taken in the last 7 days — do not repeat recently executed actions
- guardrails: the merchant's approved action types and impact threshold

Permitted action types for this merchant: ${permittedActions.length > 0 ? permittedActions.join(', ') : 'none configured yet'}
Impact threshold: £${guardrails.impact_threshold} (above this, approval is required even for auto actions)

Your response MUST be a single valid JSON object with this exact structure — no markdown, no explanation, JSON only:

{
  "briefing": "A clear, direct 3-5 sentence morning update written to the merchant. Plain language. Lead with the most important thing. No bullet points.",
  "issues": [
    { "hypothesis": "A specific, testable statement of what you believe is causing a revenue problem", "evidence": "The exact data points from the leakage findings that support this" }
  ],
  "suggested_actions": [
    { "action_type": "one of the permitted action types", "reason": "Why this specific action would address the issue", "estimated_impact": 0 }
  ]
}

Rules:
- briefing: maximum 120 words
- issues: maximum 3 items; only include issues backed by clear evidence in the data; empty array if nothing material
- suggested_actions: maximum 3 items; only suggest permitted action types; estimated_impact is your best estimate in the merchant's currency (use 0 if unknown); empty array if no clear actions
- Do not create hypotheses for issues already in open_hypotheses
- Do not suggest actions already executed in recent_actions`;
}

// ---------------------------------------------------------------------------
// User message
// ---------------------------------------------------------------------------

function buildUserMessage(context, leakage) {
  return JSON.stringify(
    {
      store_context:    context.store,
      leakage_findings: leakage,
      open_hypotheses:  context.open_hypotheses,
      recent_actions:   context.recent_actions,
      guardrails:       context.guardrails,
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Supabase write — briefings table
// ---------------------------------------------------------------------------

async function storeBriefing(merchantId, briefingDate, parsed) {
  const client = getSupabaseClient();

  const { error } = await client.from('briefings').insert({
    merchant_id:   merchantId,
    briefing_date: briefingDate,
    briefing_text: parsed.briefing,
    issues_found:  parsed.issues?.length        ?? 0,
    actions_queued: parsed.suggested_actions?.length ?? 0,
    raw_response:  parsed,
  });

  if (error) throw new Error(`Failed to store briefing: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Per-merchant processing
// ---------------------------------------------------------------------------

async function processMerchant(merchantId, storeUrl, anthropic) {
  console.error(`[MotkoAI] Processing ${storeUrl} (${merchantId})`);

  // 1. Fetch context and leakage in parallel — leakage failure is non-fatal
  const [context, leakageResult] = await Promise.allSettled([
    getAgentContext(merchantId),
    detectRevenueLeakage(merchantId),
  ]);

  if (context.status === 'rejected') {
    throw new Error(`getAgentContext failed: ${context.reason.message}`);
  }

  const leakage = leakageResult.status === 'fulfilled'
    ? leakageResult.value
    : { error: leakageResult.reason.message, findings: {} };

  if (leakageResult.status === 'rejected') {
    console.error(`[MotkoAI] Leakage detection failed for ${merchantId} — proceeding without it:`, leakageResult.reason.message);
  }

  // 2. Call Claude
  const response = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    system:     buildSystemPrompt(context.value),
    messages:   [{ role: 'user', content: buildUserMessage(context.value, leakage) }],
  });

  const rawText = response.content[0]?.text?.trim() ?? '';

  // 3. Parse JSON response — strip markdown code fences if Claude added them
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    console.error(`[MotkoAI] JSON parse failed for ${merchantId}. Raw response:`, rawText.slice(0, 500));
    throw new Error('Claude returned non-JSON response');
  }

  // Log the briefing text so it's visible even if DB storage fails
  console.error(`\n[MotkoAI] ── Briefing for ${storeUrl} ─────────────────────────`);
  console.error(parsed.briefing ?? '(no briefing text)');
  console.error(`[MotkoAI] Issues: ${parsed.issues?.length ?? 0}, Suggested actions: ${parsed.suggested_actions?.length ?? 0}`);
  if (parsed.issues?.length) {
    console.error('[MotkoAI] Issues:');
    parsed.issues.forEach((i, n) => console.error(`  ${n + 1}. ${i.hypothesis}`));
  }
  if (parsed.suggested_actions?.length) {
    console.error('[MotkoAI] Suggested actions:');
    parsed.suggested_actions.forEach((a, n) => console.error(`  ${n + 1}. [${a.action_type}] ${a.reason} (impact: ${a.estimated_impact})`));
  }
  console.error(`[MotkoAI] ─────────────────────────────────────────────────────\n`);

  const today = new Date().toISOString().slice(0, 10);

  // 4. Store briefing
  await storeBriefing(merchantId, today, parsed);

  // 5 + 6. Create hypotheses and queue actions in parallel (fire and forget errors)
  const writes = [
    ...(parsed.issues ?? []).map((issue) =>
      createHypothesis(merchantId, {
        hypothesis: issue.hypothesis,
        evidence:   issue.evidence ?? null,
      }).catch((err) => console.error(`[MotkoAI] createHypothesis failed:`, err.message))
    ),
    ...(parsed.suggested_actions ?? []).map((action) =>
      logAction({
        merchant_id:     merchantId,
        action_type:     action.action_type,
        status:          'pending_approval',
        estimated_impact: action.estimated_impact > 0 ? action.estimated_impact : null,
        source_insight:  action.reason,
      }).catch((err) => console.error(`[MotkoAI] logAction failed:`, err.message))
    ),
  ];

  await Promise.allSettled(writes);

  console.error(
    `[MotkoAI] Done: ${storeUrl} — ` +
    `briefing stored, ${parsed.issues?.length ?? 0} issue(s), ` +
    `${parsed.suggested_actions?.length ?? 0} action(s) queued`
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[MotkoAI] ANTHROPIC_API_KEY is not set. Cannot run morning briefing.');
    process.exit(1);
  }

  const anthropic = new Anthropic();
  const merchants = await fetchActiveMerchants();

  console.error(`[MotkoAI] Morning briefing starting — ${merchants.length} active merchant(s)`);

  // Process sequentially to avoid Anthropic and Shopify/Klaviyo rate limits
  for (const merchant of merchants) {
    try {
      await processMerchant(merchant.id, merchant.shopify_store_url, anthropic);
    } catch (err) {
      // Log and continue — one failed merchant must not block others
      console.error(`[MotkoAI] Failed for ${merchant.shopify_store_url}:`, err.message);
    }
  }

  console.error('[MotkoAI] Morning briefing complete');
}

main().catch((err) => {
  console.error('[MotkoAI] Fatal error:', err);
  process.exit(1);
});
