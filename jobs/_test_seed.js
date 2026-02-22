/**
 * Sprint 2-D: Seed realistic store_context for the test merchant.
 * Run: node jobs/_test_seed.js
 */
import 'dotenv/config';
import { upsertStoreContext, appendStoreContextNote } from '../utils/context.js';

const MERCHANT_ID = '53e97748-7f10-44c1-8b4b-4983473e45a8';

async function main() {
  console.log('Seeding store_context for', MERCHANT_ID);

  await upsertStoreContext(MERCHANT_ID, {
    store_name:        'Motko Test Store',
    industry:          'Health & Wellness',
    avg_daily_revenue: 1420.00,   // ~£43k/month
    avg_order_value:   68.50,
    currency:          'GBP',
    avg_open_rate:     31.2,      // % — slightly above industry average
    avg_click_rate:    3.8,       // %
  });

  // Seed a couple of historical observations so Claude has narrative context
  await appendStoreContextNote(MERCHANT_ID, {
    date: '2026-02-10',
    observation: 'Post-Valentines slump observed. Revenue dropped ~22% for 3 days after 14 Feb — likely seasonal, not structural.',
  });

  await appendStoreContextNote(MERCHANT_ID, {
    date: '2026-02-17',
    observation: 'Welcome flow had a broken discount code link for 4 days (fixed 17 Feb). Estimated lost conversions: 40-60 orders.',
  });

  console.log('store_context seeded successfully.');
  console.log('Benchmarks:');
  console.log('  avg_daily_revenue: £1,420');
  console.log('  avg_order_value:   £68.50');
  console.log('  avg_open_rate:     31.2%');
  console.log('  avg_click_rate:    3.8%');
  console.log('  notes:             2 historical observations');
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
