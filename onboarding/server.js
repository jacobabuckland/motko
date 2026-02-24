/**
 * MotkoAI — Shopify OAuth onboarding server.
 *
 * Guides a merchant through a 3-step flow:
 *   Step 1  GET  /                       Landing page — enter store domain
 *           GET  /auth/shopify            Initiate Shopify OAuth
 *           GET  /auth/shopify/callback   Exchange code → create merchant in Supabase
 *   Step 2  GET  /connect/klaviyo        Enter Klaviyo private API key
 *           POST /connect/klaviyo        Validate key, activate merchant
 *   Step 3  GET  /success                Show merchant_id with copy button
 *
 * Required env vars (add to .env):
 *   SHOPIFY_CLIENT_ID       — From your Shopify app's API credentials
 *   SHOPIFY_CLIENT_SECRET   — From your Shopify app's API credentials
 *   SHOPIFY_SCOPES          — e.g. read_orders,read_analytics
 *   APP_URL                 — e.g. http://localhost:3000  (no trailing slash)
 *   SESSION_SECRET          — Any long random string
 *   SUPABASE_URL            — Already set for the MCP server
 *   SUPABASE_SERVICE_KEY    — Already set for the MCP server
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT — Run this SQL in your Supabase SQL editor before first use:
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   -- 1. Allow email to be null (OAuth gives us the store URL, not always an email)
 *   ALTER TABLE merchants ALTER COLUMN email DROP NOT NULL;
 *
 *   -- 2. Unique constraint on store URL (enables upsert on reconnect)
 *   ALTER TABLE merchants
 *     ADD CONSTRAINT merchants_shopify_store_url_key UNIQUE (shopify_store_url);
 *
 *   -- 3. merchant_id on leakage_log (if you haven't added it yet)
 *   ALTER TABLE leakage_log
 *     ADD COLUMN IF NOT EXISTS merchant_id UUID REFERENCES merchants(id);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import { getSupabaseClient } from '../utils/supabase.js';
import { createSession } from '../utils/session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the motko project root (one level up from onboarding/)
config({ path: resolve(__dirname, '../.env') });

// ---------------------------------------------------------------------------
// Startup: exit immediately if required env vars are missing
// ---------------------------------------------------------------------------
const REQUIRED_VARS = [
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'SHOPIFY_SCOPES',
  'APP_URL',
  'SESSION_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
];

const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length) {
  console.error('[MotkoAI Onboarding] Missing required environment variables:');
  missing.forEach(v => console.error(`  ${v}`));
  console.error('\nAdd them to your .env file and restart.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Normalises a user-supplied shop input to "store.myshopify.com".
 * Accepts "my-store" or "my-store.myshopify.com".
 * Returns null if the input contains invalid characters.
 */
function normalizeShop(input) {
  const stripped = (input ?? '')
    .replace(/\.myshopify\.com$/i, '')
    .trim()
    .toLowerCase();
  if (!stripped || !/^[a-z0-9-]+$/.test(stripped)) return null;
  return `${stripped}.myshopify.com`;
}

/**
 * Validates Shopify's HMAC signature on the OAuth callback query string.
 * Excludes the `hmac` param itself, sorts the rest, and compares with
 * a constant-time comparison to prevent timing attacks.
 */
function validateHmac(query) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('&');

  const expected = crypto
    .createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmac, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    // Buffers were different lengths — HMAC is invalid
    return false;
  }
}

/**
 * Renders a full HTML page with a 3-step progress indicator.
 * step: 1 | 2 | 3 — the currently active step.
 */
function renderPage({ step, title, body }) {
  const STEPS = ['Shopify', 'Klaviyo', 'Done'];

  const progress = STEPS.map((label, i) => {
    const n = i + 1;
    const cls = n < step ? 'done' : n === step ? 'active' : '';
    const icon = n < step ? '✓' : String(n);
    const line = n < STEPS.length
      ? '<span class="step-line"></span>'
      : '';
    return `<span class="dot ${cls}">${icon}</span><span class="step-label">${label}</span>${line}`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — MotkoAI</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f7f7f8; color: #111; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
    }
    .card {
      background: #fff; border-radius: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 4px 24px rgba(0,0,0,.07);
      padding: 44px 40px; max-width: 460px; width: calc(100% - 32px); margin: 16px;
    }
    .logo { font-size: 20px; font-weight: 700; color: #5c6ac4; margin-bottom: 28px; }

    /* ── Progress bar ── */
    .progress { display: flex; align-items: center; margin-bottom: 36px; }
    .dot {
      width: 30px; height: 30px; border-radius: 50%;
      background: #e4e4e7; color: #999;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 600; flex-shrink: 0;
    }
    .dot.active { background: #5c6ac4; color: #fff; }
    .dot.done   { background: #22c55e; color: #fff; }
    .step-label { font-size: 11px; color: #aaa; margin: 0 5px; white-space: nowrap; }
    .step-line  { flex: 1; height: 2px; background: #e4e4e7; }

    /* ── Typography ── */
    h2 { font-size: 20px; font-weight: 700; margin-bottom: 10px; }
    p  { color: #555; line-height: 1.65; margin-bottom: 14px; font-size: 15px; }
    .hint { font-size: 13px; color: #999; }
    .hint a { color: #5c6ac4; text-decoration: none; }
    .hint a:hover { text-decoration: underline; }
    .back { display: inline-block; color: #5c6ac4; text-decoration: none; font-size: 14px; }
    .back:hover { text-decoration: underline; }

    /* ── Error banner ── */
    .error-msg {
      background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;
      border-radius: 8px; padding: 10px 14px; margin-bottom: 14px; font-size: 14px;
    }

    /* ── Forms ── */
    form { display: flex; flex-direction: column; gap: 12px; }
    .shop-input {
      display: flex; align-items: stretch;
      border: 1.5px solid #d4d4d8; border-radius: 8px; overflow: hidden;
      transition: border-color .15s;
    }
    .shop-input:focus-within { border-color: #5c6ac4; }
    .shop-input input {
      flex: 1; border: none; padding: 11px 14px; font-size: 15px;
      outline: none; min-width: 0;
    }
    .shop-input .suffix {
      padding: 11px 14px 11px 0; color: #888; font-size: 14px;
      white-space: nowrap; display: flex; align-items: center;
    }
    input[type="text"] {
      width: 100%; border: 1.5px solid #d4d4d8; border-radius: 8px;
      padding: 11px 14px; font-size: 15px; outline: none;
      transition: border-color .15s;
    }
    input[type="text"]:focus { border-color: #5c6ac4; }
    button.primary {
      background: #5c6ac4; color: #fff; border: none; border-radius: 8px;
      padding: 13px; font-size: 15px; font-weight: 600; cursor: pointer;
      transition: background .15s;
    }
    button.primary:hover { background: #4b5baf; }

    /* ── Merchant ID box ── */
    .mid-box {
      display: flex; align-items: center; gap: 12px;
      background: #f4f4f5; border-radius: 8px; padding: 14px 16px;
      margin-bottom: 16px;
    }
    .mid-box code { flex: 1; font-family: monospace; font-size: 13px; word-break: break-all; }
    .mid-box button {
      background: #5c6ac4; color: #fff; border: none; border-radius: 6px;
      padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
      white-space: nowrap; transition: background .15s;
    }
    .mid-box button:hover { background: #4b5baf; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🛒 MotkoAI</div>
    <div class="progress">${progress}</div>
    ${body}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Express app + session middleware
// ---------------------------------------------------------------------------
const app = express();

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 15 * 60 * 1000, // 15 minutes
  },
}));

// ---------------------------------------------------------------------------
// Step 1a — Landing page
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => {
  res.send(renderPage({
    step: 1,
    title: 'Connect your Shopify store',
    body: `
      <h2>Connect your Shopify store</h2>
      <p>Enter your store's subdomain to begin the 3-step setup.</p>
      <form action="/auth/shopify" method="get">
        <div class="shop-input">
          <input
            type="text" name="shop"
            placeholder="your-store"
            autocomplete="off"
            pattern="[a-zA-Z0-9-]+"
            required
          >
          <span class="suffix">.myshopify.com</span>
        </div>
        <button type="submit" class="primary">Connect with Shopify →</button>
      </form>
    `,
  }));
});

// ---------------------------------------------------------------------------
// Step 1b — Initiate Shopify OAuth
// ---------------------------------------------------------------------------
app.get('/auth/shopify', (req, res) => {
  const shop = normalizeShop(req.query.shop);

  if (!shop) {
    return res.status(400).send(renderPage({
      step: 1,
      title: 'Invalid store domain',
      body: `
        <h2>Invalid store domain</h2>
        <p>Please enter a valid Shopify store subdomain (letters, numbers, and hyphens only).</p>
        <a href="/" class="back">← Try again</a>
      `,
    }));
  }

  // Generate a one-time CSRF state token and stash shop in session
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.shop = shop;

  const params = new URLSearchParams({
    client_id: process.env.SHOPIFY_CLIENT_ID,
    scope: process.env.SHOPIFY_SCOPES,
    redirect_uri: `${process.env.APP_URL}/auth/shopify/callback`,
    state,
  });

  res.redirect(`https://${shop}/admin/oauth/authorize?${params}`);
});

// ---------------------------------------------------------------------------
// Step 1c — Shopify OAuth callback
// ---------------------------------------------------------------------------
app.get('/auth/shopify/callback', async (req, res) => {
  try {
    // ── CSRF: validate state token ──────────────────────────────────────────
    if (!req.query.state || req.query.state !== req.session.oauthState) {
      return res.status(403).send(renderPage({
        step: 1,
        title: 'Session expired',
        body: `
          <h2>Session expired</h2>
          <p>Your session may have expired or the request was invalid. Please start over.</p>
          <a href="/" class="back">← Start over</a>
        `,
      }));
    }

    // ── Security: validate Shopify HMAC signature ───────────────────────────
    if (!validateHmac(req.query)) {
      return res.status(403).send(renderPage({
        step: 1,
        title: 'Invalid request',
        body: `
          <h2>Invalid request</h2>
          <p>The request signature could not be verified. Please start over.</p>
          <a href="/" class="back">← Start over</a>
        `,
      }));
    }

    const shop = req.session.shop;
    const { code } = req.query;

    // ── Exchange authorization code for permanent access token ──────────────
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenResp.ok) {
      // Log status only — never log the response body (may contain sensitive data)
      console.error(`[MotkoAI Onboarding] Token exchange failed: HTTP ${tokenResp.status}`);
      throw new Error('Token exchange failed');
    }

    const { access_token: accessToken } = await tokenResp.json();

    // ── Fetch the shop's contact email ─────────────────────────────────────
    // Used to satisfy the merchants.email column. Gracefully falls back to null
    // if the endpoint is unreachable (requires ALTER TABLE email DROP NOT NULL).
    let shopEmail = null;
    try {
      const shopResp = await fetch(
        `https://${shop}/admin/api/2024-01/shop.json?fields=email`,
        { headers: { 'X-Shopify-Access-Token': accessToken } },
      );
      if (shopResp.ok) {
        const { shop: shopData } = await shopResp.json();
        shopEmail = shopData?.email ?? null;
      }
    } catch (e) {
      console.error('[MotkoAI Onboarding] Could not fetch shop email:', e.message);
    }

    // ── Upsert merchant in Supabase ─────────────────────────────────────────
    // onConflict:'shopify_store_url' handles reconnects gracefully, refreshing
    // the access token without creating a duplicate row.
    // Requires: ALTER TABLE merchants ADD CONSTRAINT merchants_shopify_store_url_key UNIQUE (shopify_store_url);
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('merchants')
      .upsert(
        {
          email: shopEmail,
          shopify_store_url: `https://${shop}`,
          shopify_access_token: accessToken,
          klaviyo_api_key: '',  // will be filled in at /connect/klaviyo
          is_active: false,
        },
        { onConflict: 'shopify_store_url' },
      )
      .select('id')
      .single();

    if (error) {
      console.error('[MotkoAI Onboarding] Supabase upsert error:', error.code ?? error.message);
      throw new Error('Could not create merchant record');
    }

    // Store only the merchant UUID in session — never store credentials
    req.session.oauthState = null;  // discard used CSRF token
    req.session.merchantId = data.id;

    res.redirect('/connect/klaviyo');
  } catch (err) {
    console.error('[MotkoAI Onboarding] OAuth callback error:', err.message);
    res.status(500).send(renderPage({
      step: 1,
      title: 'Connection failed',
      body: `
        <h2>Connection failed</h2>
        <p>We couldn't complete the Shopify connection. Please try again.</p>
        <a href="/" class="back">← Start over</a>
      `,
    }));
  }
});

// ---------------------------------------------------------------------------
// Step 2a — Klaviyo key form
// ---------------------------------------------------------------------------
app.get('/connect/klaviyo', (req, res) => {
  if (!req.session.merchantId) return res.redirect('/');

  res.send(renderPage({
    step: 2,
    title: 'Connect Klaviyo',
    body: `
      <h2>Connect your Klaviyo account</h2>
      <p>Create a <strong>Full Access</strong> private API key in Klaviyo and paste it below.</p>
      <form action="/connect/klaviyo" method="post">
        <input
          type="text" name="klaviyo_key"
          placeholder="pk_…"
          autocomplete="off"
          spellcheck="false"
          required
        >
        <button type="submit" class="primary">Connect Klaviyo →</button>
      </form>
      <p class="hint" style="margin-top:12px">
        Find yours at
        <a href="https://www.klaviyo.com/account#api-keys-tab" target="_blank" rel="noopener">
          Klaviyo → Settings → API Keys
        </a>
      </p>
    `,
  }));
});

// ---------------------------------------------------------------------------
// Step 2b — Validate Klaviyo key and activate merchant
// ---------------------------------------------------------------------------
app.post('/connect/klaviyo', express.urlencoded({ extended: false }), async (req, res) => {
  if (!req.session.merchantId) return res.redirect('/');

  const klaviyoKey = (req.body.klaviyo_key ?? '').trim();

  if (!klaviyoKey) {
    return res.status(400).send(renderPage({
      step: 2,
      title: 'Connect Klaviyo',
      body: `
        <h2>Connect your Klaviyo account</h2>
        <div class="error-msg">Please enter your Klaviyo API key.</div>
        <form action="/connect/klaviyo" method="post">
          <input type="text" name="klaviyo_key" placeholder="pk_…" autocomplete="off" required>
          <button type="submit" class="primary">Connect Klaviyo →</button>
        </form>
      `,
    }));
  }

  try {
    // ── Validate key against Klaviyo's accounts endpoint ───────────────────
    // A 200 response means the key is valid and has at least read access.
    const klaviyoResp = await fetch('https://a.klaviyo.com/api/accounts/', {
      headers: {
        Authorization: `Klaviyo-API-Key ${klaviyoKey}`,
        revision: '2024-02-15',
        Accept: 'application/json',
      },
    });

    if (!klaviyoResp.ok) {
      return res.send(renderPage({
        step: 2,
        title: 'Connect Klaviyo',
        body: `
          <h2>Connect your Klaviyo account</h2>
          <div class="error-msg">
            ❌ That API key isn't valid (HTTP ${klaviyoResp.status}).
            Please double-check and try again.
          </div>
          <form action="/connect/klaviyo" method="post">
            <input type="text" name="klaviyo_key" placeholder="pk_…" autocomplete="off" required>
            <button type="submit" class="primary">Try again →</button>
          </form>
          <p class="hint" style="margin-top:12px">
            Find yours at
            <a href="https://www.klaviyo.com/account#api-keys-tab" target="_blank" rel="noopener">
              Klaviyo → Settings → API Keys
            </a>
          </p>
        `,
      }));
    }

    // ── Persist key and activate merchant ──────────────────────────────────
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('merchants')
      .update({ klaviyo_api_key: klaviyoKey, is_active: true })
      .eq('id', req.session.merchantId);

    if (error) {
      console.error('[MotkoAI Onboarding] Supabase update error:', error.code ?? error.message);
      throw new Error('Could not save Klaviyo key');
    }

    // ── Mint a 30-day session token for Claude Desktop ──────────────────────
    const sessionToken = await createSession(req.session.merchantId);
    req.session.sessionToken = sessionToken;

    res.redirect('/success');
  } catch (err) {
    console.error('[MotkoAI Onboarding] Klaviyo step error:', err.message);
    res.status(500).send(renderPage({
      step: 2,
      title: 'Something went wrong',
      body: `
        <h2>Something went wrong</h2>
        <p>We couldn't save your Klaviyo key. Please try again.</p>
        <a href="/connect/klaviyo" class="back">← Try again</a>
      `,
    }));
  }
});

// ---------------------------------------------------------------------------
// Step 3 — Success: display session token + Claude Desktop config
// ---------------------------------------------------------------------------
app.get('/success', (req, res) => {
  const { sessionToken, merchantId } = req.session;
  if (!sessionToken || !merchantId) return res.redirect('/');

  // The exact JSON the merchant needs to paste into claude_desktop_config.json.
  // We use the absolute path style so Claude Desktop can find the file
  // regardless of working directory.
  const configSnippet = JSON.stringify({
    mcpServers: {
      motkoai: {
        command: 'node',
        args: ['/path/to/motko/server.js'],
        env: {
          MOTKO_SESSION_TOKEN: sessionToken,
          SUPABASE_URL: 'your_supabase_url',
          SUPABASE_SERVICE_KEY: 'your_supabase_service_key',
        },
      },
    },
  }, null, 2);

  res.send(renderPage({
    step: 3,
    title: "You're connected!",
    body: `
      <h2>✅ You're all set!</h2>
      <p>Add the config below to <strong>Claude Desktop</strong> to activate MotkoAI.
         You only do this once — every future conversation will know who you are automatically.</p>

      <p style="font-size:14px;font-weight:600;margin-bottom:6px;">
        Your session token (valid 30 days):
      </p>
      <div class="mid-box">
        <code id="token">${sessionToken}</code>
        <button onclick="copyEl('token','copy-token')" id="copy-token">Copy</button>
      </div>

      <p style="font-size:14px;font-weight:600;margin-bottom:6px;margin-top:20px;">
        Paste this into <code style="font-size:13px">claude_desktop_config.json</code>:
        <span style="font-size:12px;font-weight:400;color:#888">
          (macOS: ~/Library/Application Support/Claude/claude_desktop_config.json)
        </span>
      </p>
      <div class="mid-box" style="align-items:flex-start">
        <code id="cfg" style="white-space:pre;line-height:1.5;font-size:12px">${configSnippet.replace(/</g, '&lt;')}</code>
        <button onclick="copyEl('cfg','copy-cfg')" id="copy-cfg" style="align-self:flex-start">Copy</button>
      </div>

      <p class="hint" style="margin-top:16px">
        Replace <code>/path/to/motko/server.js</code> with the actual path on your machine,
        and fill in your Supabase URL and service key.
        Then restart Claude Desktop and type <em>"check my MotkoAI status"</em> to confirm it's working.
      </p>

      <script>
        function copyEl(srcId, btnId) {
          var text = document.getElementById(srcId).textContent;
          navigator.clipboard.writeText(text)
            .then(function() {
              var btn = document.getElementById(btnId);
              var orig = btn.textContent;
              btn.textContent = 'Copied!';
              setTimeout(function() { btn.textContent = orig; }, 2000);
            })
            .catch(function() {
              var range = document.createRange();
              range.selectNode(document.getElementById(srcId));
              window.getSelection().removeAllRanges();
              window.getSelection().addRange(range);
            });
        }
      </script>
    `,
  }));
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? process.env.ONBOARDING_PORT ?? 3000);

app.listen(PORT, () => {
  console.error(`[MotkoAI Onboarding] Server running at ${process.env.APP_URL}`);
  console.error(`[MotkoAI Onboarding] Open ${process.env.APP_URL} in your browser to begin`);
});
