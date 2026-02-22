/**
 * Sprint 2-D preflight check.
 * Verifies env vars, active merchants, and required table presence.
 * Run: node jobs/_test_preflight.js
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const REQUIRED_ENV = [
  'ANTHROPIC_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
];

const REQUIRED_TABLES = [
  'merchants',
  'store_context',
  'hypotheses',
  'actions_ledger',
  'briefings',
];

function check(label, ok, detail = '') {
  const icon = ok ? '✓' : '✗';
  const msg = detail ? `${label}: ${detail}` : label;
  console.log(`  ${icon} ${msg}`);
  return ok;
}

async function main() {
  let allOk = true;

  console.log('\n── Env vars ──────────────────────────────────');
  for (const key of REQUIRED_ENV) {
    const present = Boolean(process.env[key]);
    if (!check(key, present, present ? 'set' : 'MISSING')) allOk = false;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.log('\nCannot proceed without Supabase credentials.\n');
    process.exit(1);
  }

  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  console.log('\n── Tables ────────────────────────────────────');
  for (const table of REQUIRED_TABLES) {
    try {
      const { error } = await client.from(table).select('id').limit(1);
      if (!check(table, !error, error ? error.message : 'reachable')) allOk = false;
    } catch (err) {
      check(table, false, err.message);
      allOk = false;
    }
  }

  console.log('\n── Active merchants ──────────────────────────');
  const { data: merchants, error: merchantErr } = await client
    .from('merchants')
    .select('id, shopify_store_url, allowed_actions, impact_threshold, is_active')
    .eq('is_active', true);

  if (merchantErr) {
    check('merchants query', false, merchantErr.message);
    allOk = false;
  } else if (!merchants?.length) {
    check('active merchants', false, 'none found — insert a test merchant row');
    allOk = false;
  } else {
    for (const m of merchants) {
      const hasAllowedActions = m.allowed_actions && Object.keys(m.allowed_actions).length > 0;
      console.log(`  ✓ ${m.shopify_store_url}`);
      console.log(`      id:               ${m.id}`);
      console.log(`      allowed_actions:  ${hasAllowedActions ? JSON.stringify(m.allowed_actions) : '(empty — will use defaults)'}`);
      console.log(`      impact_threshold: ${m.impact_threshold ?? '(null — will use default 500)'}`);
    }
  }

  console.log('\n── Store context ─────────────────────────────');
  if (merchants?.length) {
    for (const m of merchants) {
      const { data: ctx, error: ctxErr } = await client
        .from('store_context')
        .select('avg_daily_revenue, avg_order_value, currency, notes')
        .eq('merchant_id', m.id)
        .single();

      if (ctxErr?.code === 'PGRST116') {
        console.log(`  ⚠ ${m.shopify_store_url}: no store_context row — benchmarks will be empty`);
      } else if (ctxErr) {
        console.log(`  ✗ ${m.shopify_store_url}: ${ctxErr.message}`);
      } else {
        console.log(`  ✓ ${m.shopify_store_url}:`);
        console.log(`      avg_daily_revenue: ${ctx.avg_daily_revenue ?? '(null)'}`);
        console.log(`      avg_order_value:   ${ctx.avg_order_value ?? '(null)'}`);
        console.log(`      currency:          ${ctx.currency ?? '(null)'}`);
        console.log(`      notes:             ${(ctx.notes ?? []).length} entries`);
      }
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(allOk ? '  Preflight PASSED\n' : '  Preflight FAILED — fix issues above before running briefing\n');

  // Return merchant IDs for the seed step
  if (merchants?.length) {
    console.log('MERCHANT_IDS=' + merchants.map((m) => m.id).join(','));
  }

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('Preflight error:', err.message);
  process.exit(1);
});
