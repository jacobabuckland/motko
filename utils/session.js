/**
 * MotkoAI session token management.
 *
 * Tokens are 64-character hex strings (32 random bytes) stored in the
 * `sessions` Supabase table. They live for 30 days and map a stateless
 * Claude Desktop environment variable back to a merchant UUID.
 *
 * DDL (run once in Supabase SQL editor):
 *
 *   create table sessions (
 *     id          uuid        primary key default gen_random_uuid(),
 *     merchant_id uuid        references merchants(id) not null,
 *     token       text        unique not null,
 *     created_at  timestamptz default now(),
 *     expires_at  timestamptz not null
 *   );
 *
 *   -- Index for fast token lookups
 *   create index sessions_token_idx on sessions(token);
 */

import crypto from 'crypto';
import { getSupabaseClient } from './supabase.js';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Creates a new session token for the given merchant and persists it to Supabase.
 *
 * @param {string} merchantId - UUID from the merchants table
 * @returns {string} A 64-character hex session token
 * @throws if Supabase is not configured or the insert fails
 */
export async function createSession(merchantId) {
  if (!merchantId) throw new Error('merchant_id is required');

  const client = getSupabaseClient();
  if (!client) {
    throw new Error(
      'Supabase is not configured (missing SUPABASE_URL / SUPABASE_SERVICE_KEY). ' +
        'Cannot create session.'
    );
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  const { error } = await client
    .from('sessions')
    .insert({ merchant_id: merchantId, token, expires_at: expiresAt });

  if (error) {
    throw new Error(`Failed to create session: ${error.code ?? error.message}`);
  }

  return token;
}

/**
 * Resolves a session token to a merchant UUID.
 * Validates that the token exists and has not expired.
 *
 * @param {string} token - The 64-character hex session token
 * @returns {string} The merchant UUID associated with this token
 * @throws if the token is missing, not found, or expired
 */
export async function resolveSession(token) {
  if (!token) throw new Error('Session token is required');

  const client = getSupabaseClient();
  if (!client) {
    throw new Error(
      'Supabase is not configured (missing SUPABASE_URL / SUPABASE_SERVICE_KEY). ' +
        'Cannot resolve session.'
    );
  }

  const { data, error } = await client
    .from('sessions')
    .select('merchant_id, expires_at')
    .eq('token', token)
    .single();

  if (error || !data) {
    throw new Error(
      'Session token not found. Please complete MotkoAI onboarding to get a new token.'
    );
  }

  if (new Date(data.expires_at) < new Date()) {
    throw new Error(
      'Session token has expired (tokens are valid for 30 days). ' +
        'Please re-run MotkoAI onboarding to get a new token.'
    );
  }

  return data.merchant_id;
}
