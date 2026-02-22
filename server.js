/**
 * MotkoAI — MCP server entry point.
 *
 * Exposes four tools to Claude:
 *   • get_motko_status             — confirm connection, see store details
 *   • get_shopify_revenue          — last 7 days revenue breakdown
 *   • get_klaviyo_flow_performance — flow metrics for the last 7 days
 *   • detect_revenue_leakage       — cross-reference Shopify + Klaviyo for gaps
 *
 * No tool requires any parameters from the user. The merchant is identified
 * once at startup via the MOTKO_SESSION_TOKEN environment variable.
 *
 * Transport: stdio (standard MCP convention for Claude Desktop).
 *
 * To configure Claude Desktop, add to claude_desktop_config.json:
 *
 *   {
 *     "mcpServers": {
 *       "motkoai": {
 *         "command": "node",
 *         "args": ["/path/to/motko/server.js"],
 *         "env": {
 *           "MOTKO_SESSION_TOKEN": "<your token from onboarding>",
 *           "SUPABASE_URL": "<your supabase url>",
 *           "SUPABASE_SERVICE_KEY": "<your supabase service key>"
 *         }
 *       }
 *     }
 *   }
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { resolveSession } from './utils/session.js';
import { getMerchantProfile } from './utils/merchants.js';
import { getSupabaseClient } from './utils/supabase.js';
import { logAction } from './utils/supabase.js';
import { checkGuardrails } from './utils/guardrails.js';
import { getShopifyRevenue, createDraftOrder, updateInventoryLevel, createDiscountCode } from './tools/shopify.js';
import { getKlaviyoFlowPerformance, getKlaviyoFlowList, pauseKlaviyoFlow, resumeKlaviyoFlow } from './tools/klaviyo.js';
import { detectRevenueLeakage } from './tools/leakage.js';

// ---------------------------------------------------------------------------
// Merchant identity — resolved once at startup from the session token.
// All tool handlers read this variable; it is never modified after startup.
// ---------------------------------------------------------------------------
let merchantId;

// ---------------------------------------------------------------------------
// Guardrail rejection logger
// Logs blocked / pending_approval actions to actions_ledger before re-throw.
// Uses err.code set by checkGuardrails to pick the correct ledger status.
// ---------------------------------------------------------------------------
async function logGuardrailRejection(action_type, estimated_impact, err, source_insight) {
  const status = err.code === 'blocked' ? 'blocked' : 'pending_approval';
  await logAction({
    merchant_id: merchantId,
    action_type,
    status,
    estimated_impact: estimated_impact > 0 ? estimated_impact : null,
    source_insight,
  }).catch(() => {}); // never mask the original guardrail error
}

// ---------------------------------------------------------------------------
// Tool definitions — no merchant_id parameter on any tool
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'get_motko_status',
    description:
      'Returns MotkoAI connection status: the connected Shopify store URL, whether Klaviyo is connected, the date the merchant joined MotkoAI, and the total number of revenue leakage findings logged to date. Call this first to confirm MotkoAI is set up correctly.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_shopify_revenue',
    description:
      'Fetches all paid Shopify orders from the last 7 days and returns total revenue, order count, store currency, and a day-by-day revenue breakdown.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_klaviyo_flow_performance',
    description:
      'Fetches all active Klaviyo email flows and returns, for each flow: name, emails sent, open rate, click rate, and revenue attributed — all over the last 7 days. Also includes a daily sends breakdown for trend analysis.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'detect_revenue_leakage',
    description:
      'Cross-references Shopify revenue and Klaviyo flow data for the last 7 days to identify revenue leakage. Detects: (1) flows that were active but generated $0 attributed revenue, (2) days where Shopify revenue dropped >30% below the daily average with no Klaviyo activity, and (3) flows that stopped sending mid-week. All findings are logged to Supabase.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_klaviyo_flow_list',
    description:
      'Returns all Klaviyo flows for this merchant (any status: active, draft, manual) with their flow ID, name, status, and trigger type. Use this before pausing or resuming a flow to get the correct flow_id.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'pause_klaviyo_flow',
    description:
      'Pauses a Klaviyo flow by setting its status to draft. The flow will stop sending emails until resumed. Requires the flow_id from get_klaviyo_flow_list. Guardrails are enforced automatically — provide estimated_impact so the merchant\'s impact threshold can be checked.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: {
          type: 'string',
          description: 'The Klaviyo flow ID to pause. Get flow IDs from get_klaviyo_flow_list.',
        },
        estimated_impact: {
          type: 'number',
          description: 'Your estimated revenue impact of this action in the merchant\'s currency (e.g. 200 = £200). Used for impact threshold guardrail checks. Omit or pass 0 if unknown.',
        },
      },
      required: ['flow_id'],
    },
  },
  {
    name: 'resume_klaviyo_flow',
    description:
      'Resumes a paused Klaviyo flow by setting its status to live. The flow will begin sending emails again. Requires the flow_id from get_klaviyo_flow_list. Guardrails are enforced automatically — provide estimated_impact so the merchant\'s impact threshold can be checked.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: {
          type: 'string',
          description: 'The Klaviyo flow ID to resume. Get flow IDs from get_klaviyo_flow_list.',
        },
        estimated_impact: {
          type: 'number',
          description: 'Your estimated revenue impact of this action in the merchant\'s currency (e.g. 200 = £200). Used for impact threshold guardrail checks. Omit or pass 0 if unknown.',
        },
      },
      required: ['flow_id'],
    },
  },
  {
    name: 'create_draft_order',
    description:
      'Creates a Shopify draft order from a list of variant IDs and quantities. Draft orders are not charged immediately — they generate an invoice link and can be completed or cancelled later. Guardrails are enforced automatically — provide estimated_impact so the merchant\'s impact threshold can be checked.',
    inputSchema: {
      type: 'object',
      properties: {
        line_items: {
          type: 'array',
          description: 'Items to include in the draft order.',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'string', description: 'Shopify variant ID.' },
              quantity: { type: 'integer', description: 'Quantity to order.' },
            },
            required: ['variant_id', 'quantity'],
          },
        },
        estimated_impact: {
          type: 'number',
          description: 'Your estimated revenue impact of this action in the merchant\'s currency. Used for impact threshold guardrail checks. Omit or pass 0 if unknown.',
        },
      },
      required: ['line_items'],
    },
  },
  {
    name: 'update_inventory_level',
    description:
      'Sets the available inventory quantity for a specific Shopify product variant at the store\'s primary location. Guardrails are enforced automatically — provide estimated_impact so the merchant\'s impact threshold can be checked.',
    inputSchema: {
      type: 'object',
      properties: {
        variant_id: {
          type: 'string',
          description: 'The Shopify variant ID whose inventory to update.',
        },
        quantity: {
          type: 'integer',
          description: 'The new available quantity to set.',
        },
        estimated_impact: {
          type: 'number',
          description: 'Your estimated revenue impact of this action in the merchant\'s currency. Used for impact threshold guardrail checks. Omit or pass 0 if unknown.',
        },
      },
      required: ['variant_id', 'quantity'],
    },
  },
  {
    name: 'create_discount_code',
    description:
      'Creates a reusable Shopify discount code (e.g. "SAVE10" for 10% off) backed by a price rule. The code can be embedded in Klaviyo email flows for targeted promotions. Guardrails are enforced automatically — provide estimated_impact so the merchant\'s impact threshold can be checked.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Internal name for the price rule (not shown to customers).',
        },
        discount_type: {
          type: 'string',
          enum: ['percentage', 'fixed_amount'],
          description: '"percentage" for % off, "fixed_amount" for a flat $ discount.',
        },
        value: {
          type: 'number',
          description: 'Positive discount amount. For percentage: 10 = 10% off. For fixed_amount: 5 = $5 off.',
        },
        code: {
          type: 'string',
          description: 'The discount code string customers will enter at checkout (e.g. "SAVE10").',
        },
        usage_limit: {
          type: 'integer',
          description: 'Maximum number of times the code can be used. Omit for unlimited.',
        },
        estimated_impact: {
          type: 'number',
          description: 'Your estimated revenue impact of this action in the merchant\'s currency. Used for impact threshold guardrail checks. Omit or pass 0 if unknown.',
        },
      },
      required: ['title', 'discount_type', 'value', 'code'],
    },
  },
];

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------
const server = new Server(
  { name: 'motkoai', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Call tools
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  try {
    let result;

    switch (name) {
      case 'get_motko_status': {
        const profile = await getMerchantProfile(merchantId);

        // Count leakage findings logged for this merchant
        let leakageFindingsTotal = 0;
        const supabase = getSupabaseClient();
        if (supabase) {
          const { count } = await supabase
            .from('leakage_log')
            .select('*', { count: 'exact', head: true })
            .eq('merchant_id', merchantId);
          leakageFindingsTotal = count ?? 0;
        }

        result = {
          store_url: profile.shopify_store_url,
          klaviyo_connected: profile.klaviyo_connected,
          member_since: profile.created_at.slice(0, 10),
          leakage_findings_total: leakageFindingsTotal,
        };
        break;
      }

      case 'get_shopify_revenue':
        result = await getShopifyRevenue(merchantId);
        break;

      case 'get_klaviyo_flow_performance':
        result = await getKlaviyoFlowPerformance(merchantId);
        break;

      case 'detect_revenue_leakage':
        result = await detectRevenueLeakage(merchantId);
        break;

      case 'get_klaviyo_flow_list':
        result = await getKlaviyoFlowList(merchantId);
        break;

      case 'pause_klaviyo_flow': {
        const { flow_id, estimated_impact = 0 } = request.params.arguments ?? {};
        if (!flow_id) throw new Error('flow_id is required');
        try {
          await checkGuardrails(merchantId, 'pause_klaviyo_flow', estimated_impact);
        } catch (err) {
          await logGuardrailRejection('pause_klaviyo_flow', estimated_impact, err, `Attempted to pause flow ${flow_id}`);
          throw err;
        }
        result = await pauseKlaviyoFlow(merchantId, flow_id, estimated_impact);
        break;
      }

      case 'resume_klaviyo_flow': {
        const { flow_id, estimated_impact = 0 } = request.params.arguments ?? {};
        if (!flow_id) throw new Error('flow_id is required');
        try {
          await checkGuardrails(merchantId, 'resume_klaviyo_flow', estimated_impact);
        } catch (err) {
          await logGuardrailRejection('resume_klaviyo_flow', estimated_impact, err, `Attempted to resume flow ${flow_id}`);
          throw err;
        }
        result = await resumeKlaviyoFlow(merchantId, flow_id, estimated_impact);
        break;
      }

      case 'create_draft_order': {
        const { line_items, estimated_impact = 0 } = request.params.arguments ?? {};
        if (!Array.isArray(line_items) || line_items.length === 0) {
          throw new Error('line_items must be a non-empty array');
        }
        try {
          await checkGuardrails(merchantId, 'create_draft_order', estimated_impact);
        } catch (err) {
          await logGuardrailRejection('create_draft_order', estimated_impact, err, `Attempted to create draft order (${line_items.length} line items)`);
          throw err;
        }
        result = await createDraftOrder(merchantId, line_items, estimated_impact);
        break;
      }

      case 'update_inventory_level': {
        const { variant_id, quantity, estimated_impact = 0 } = request.params.arguments ?? {};
        if (!variant_id) throw new Error('variant_id is required');
        if (quantity == null) throw new Error('quantity is required');
        try {
          await checkGuardrails(merchantId, 'update_inventory_level', estimated_impact);
        } catch (err) {
          await logGuardrailRejection('update_inventory_level', estimated_impact, err, `Attempted to set inventory for variant ${variant_id} to ${quantity}`);
          throw err;
        }
        result = await updateInventoryLevel(merchantId, variant_id, quantity, estimated_impact);
        break;
      }

      case 'create_discount_code': {
        const { title, discount_type, value, code, usage_limit, estimated_impact = 0 } = request.params.arguments ?? {};
        if (!title) throw new Error('title is required');
        if (!discount_type) throw new Error('discount_type is required');
        if (value == null) throw new Error('value is required');
        if (!code) throw new Error('code is required');
        try {
          await checkGuardrails(merchantId, 'create_discount_code', estimated_impact);
        } catch (err) {
          await logGuardrailRejection('create_discount_code', estimated_impact, err, `Attempted to create discount code "${code}"`);
          throw err;
        }
        result = await createDiscountCode(merchantId, { title, discount_type, value, code, usage_limit }, estimated_impact);
        break;
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: "${name}"` }),
            },
          ],
          isError: true,
        };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: message }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start — resolve session token before accepting any requests
// ---------------------------------------------------------------------------
async function main() {
  const token = process.env.MOTKO_SESSION_TOKEN;

  if (!token) {
    console.error('[MotkoAI] ❌  MOTKO_SESSION_TOKEN is not set.');
    console.error('[MotkoAI]    Complete onboarding to get your token:');
    console.error(`[MotkoAI]    ${process.env.APP_URL ?? 'http://localhost:3000'}`);
    console.error('[MotkoAI]    Then add it to your claude_desktop_config.json under env.MOTKO_SESSION_TOKEN');
    process.exit(1);
  }

  try {
    merchantId = await resolveSession(token);
  } catch (err) {
    console.error('[MotkoAI] ❌  Session token invalid or expired.');
    console.error(`[MotkoAI]    ${err.message}`);
    console.error('[MotkoAI]    Re-run onboarding to get a fresh token:');
    console.error(`[MotkoAI]    ${process.env.APP_URL ?? 'http://localhost:3000'}`);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — stdout is reserved for the MCP stdio protocol
  console.error('[MotkoAI] MCP server running on stdio');
  console.error(`[MotkoAI] Session active for merchant ${merchantId}`);
}

main().catch((err) => {
  console.error('[MotkoAI] Fatal startup error:', err);
  process.exit(1);
});
