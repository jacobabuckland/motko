/**
 * Sprint 2-D: Patch the test merchant row with a valid URL prefix and
 * realistic allowed_actions so the guardrail system gives Claude a
 * meaningful list of permitted actions.
 * Run: node jobs/_test_patch_merchant.js
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const MERCHANT_ID = '53e97748-7f10-44c1-8b4b-4983473e45a8';

async function main() {
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Ensure URL has https:// prefix (stops URL parse crash, lets API return a proper error)
  const { data: merchant } = await client
    .from('merchants')
    .select('shopify_store_url')
    .eq('id', MERCHANT_ID)
    .single();

  let storeUrl = merchant?.shopify_store_url ?? '';
  if (storeUrl && !storeUrl.startsWith('http')) {
    storeUrl = `https://${storeUrl}`;
  }

  const { error } = await client
    .from('merchants')
    .update({
      shopify_store_url: storeUrl,
      // Realistic guardrail config for a new merchant
      allowed_actions: {
        pause_klaviyo_flow:   'approval_required',
        resume_klaviyo_flow:  'approval_required',
        create_draft_order:   'approval_required',
        update_inventory_level: 'off',
        create_discount_code: 'approval_required',
      },
      impact_threshold: 500,
    })
    .eq('id', MERCHANT_ID);

  if (error) throw new Error(`Merchant patch failed: ${error.message}`);

  console.log('Merchant patched:');
  console.log(`  shopify_store_url: ${storeUrl}`);
  console.log('  allowed_actions: pause/resume flow, create draft order, create discount code → approval_required');
  console.log('  impact_threshold: £500');
}

main().catch((err) => {
  console.error('Patch failed:', err.message);
  process.exit(1);
});
