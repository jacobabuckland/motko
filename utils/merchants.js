/**
 * Multi-tenant credential resolution.
 *
 * Fetches per-merchant API credentials from the `merchants` Supabase table.
 * Credentials are never logged — only IDs and status flags are written to stderr.
 *
 * DDL (run once in Supabase SQL editor):
 *
 *   create table merchants (
 *     id                   uuid primary key default gen_random_uuid(),
 *     created_at           timestamptz default now(),
 *     email                text unique not null,
 *     shopify_store_url    text not null,
 *     shopify_access_token text not null,
 *     klaviyo_api_key      text not null,
 *     is_active            boolean default true
 *   );
 *
 * -- Test merchant insert
 * insert into merchants (email, shopify_store_url, shopify_access_token, klaviyo_api_key)
 * values ('test@example.com', 'your-store.myshopify.com', 'your_token', 'your_klaviyo_key');
 */

import { getSupabaseClient } from './supabase.js';

/**
 * Fetches public profile fields for a merchant (no credentials).
 * Used by the get_motko_status tool.
 *
 * @param {string} merchantId - UUID from the `merchants` table
 * @returns {{ shopify_store_url: string, klaviyo_connected: boolean, created_at: string }}
 */
export async function getMerchantProfile(merchantId) {
  if (!merchantId) throw new Error('merchant_id is required');

  const client = getSupabaseClient();
  if (!client) {
    throw new Error(
      'Supabase is not configured (missing SUPABASE_URL / SUPABASE_SERVICE_KEY).'
    );
  }

  const { data, error } = await client
    .from('merchants')
    .select('shopify_store_url, klaviyo_api_key, created_at')
    .eq('id', merchantId)
    .single();

  if (error) {
    throw new Error(`Profile lookup failed for id=${merchantId}: ${error.code ?? error.message}`);
  }

  if (!data) {
    throw new Error(`Merchant not found: ${merchantId}`);
  }

  return {
    shopify_store_url: data.shopify_store_url,
    klaviyo_connected: Boolean(data.klaviyo_api_key),
    created_at: data.created_at,
  };
}

/**
 * Fetches credentials for a merchant by UUID.
 *
 * @param {string} merchantId - UUID from the `merchants` table
 * @returns {{ shopify_store_url: string, shopify_access_token: string, klaviyo_api_key: string }}
 * @throws if the merchant is not found, inactive, or Supabase is not configured
 */
export async function getMerchantCredentials(merchantId) {
  if (!merchantId) {
    throw new Error('merchant_id is required');
  }

  const client = getSupabaseClient();
  if (!client) {
    throw new Error(
      'Supabase is not configured (missing SUPABASE_URL / SUPABASE_SERVICE_KEY). ' +
        'Cannot resolve merchant credentials.'
    );
  }

  const { data, error } = await client
    .from('merchants')
    .select('shopify_store_url, shopify_access_token, klaviyo_api_key, is_active, klaviyo_write_enabled, shopify_write_enabled')
    .eq('id', merchantId)
    .single();

  if (error) {
    // Log only the Postgres error code / hint — never the row data
    throw new Error(`Merchant lookup failed for id=${merchantId}: ${error.code ?? error.message}`);
  }

  if (!data) {
    throw new Error(`Merchant not found: ${merchantId}`);
  }

  if (!data.is_active) {
    throw new Error(`Merchant ${merchantId} is inactive`);
  }

  return {
    shopify_store_url: data.shopify_store_url,
    shopify_access_token: data.shopify_access_token,
    klaviyo_api_key: data.klaviyo_api_key,
    klaviyo_write_enabled: data.klaviyo_write_enabled ?? false,
    shopify_write_enabled: data.shopify_write_enabled ?? false,
  };
}
