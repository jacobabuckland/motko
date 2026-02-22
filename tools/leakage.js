/**
 * Revenue leakage detection.
 *
 * Identifies three patterns:
 *  1. ZERO_REVENUE_FLOW    — A flow sent emails but generated $0 attributed revenue.
 *  2. UNEXPLAINED_DROP     — A day where Shopify revenue fell >30 % below the 7-day
 *                            average AND no Klaviyo flow was active that day.
 *  3. FLOW_STOPPED_MID_WEEK — A flow that sent emails in the first part of the window
 *                              but went silent for the final 2+ days.
 *
 * All findings are logged to Supabase and returned as structured JSON.
 */

import { getShopifyRevenue } from './shopify.js';
import { getKlaviyoFlowPerformance } from './klaviyo.js';
import { logLeakage } from '../utils/supabase.js';

// Revenue drop threshold: flag a day if its revenue is below this fraction of the average.
const DROP_THRESHOLD = 0.70;

// Minimum emails sent before we consider a flow "active" (filters noise).
const MIN_EMAILS_FOR_ACTIVE_FLOW = 5;

// A flow is considered to have "stopped" if the last N days all have zero sends.
const SILENT_TAIL_DAYS = 2;

/**
 * Returns true if the flow sent emails in its first half of the window
 * but was completely silent for the final SILENT_TAIL_DAYS days.
 */
function didFlowStopMidWeek(dailySends) {
  if (!dailySends || dailySends.length < SILENT_TAIL_DAYS + 1) return false;

  const sorted = [...dailySends].sort((a, b) => a.date.localeCompare(b.date));
  const tail = sorted.slice(-SILENT_TAIL_DAYS);
  const head = sorted.slice(0, sorted.length - SILENT_TAIL_DAYS);

  const tailSilent = tail.every((d) => d.value === 0);
  const headActive = head.some((d) => d.value >= 1);

  return tailSilent && headActive;
}

/**
 * Formats a dollar amount as a human-readable impact string.
 */
function fmtRevenue(amount) {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Cross-references Shopify and Klaviyo data to surface revenue leakage.
 *
 * @param {string} [merchantId] - Merchant UUID. Omit to use env var fallback.
 * @returns {object} Structured findings with a summary and per-category arrays.
 */
export async function detectRevenueLeakage(merchantId) {
  // Fetch both datasets in parallel, scoped to the same merchant
  const [shopify, klaviyo] = await Promise.allSettled([
    getShopifyRevenue(merchantId),
    getKlaviyoFlowPerformance(merchantId),
  ]);

  if (shopify.status === 'rejected') {
    throw new Error(`Failed to fetch Shopify data: ${shopify.reason.message}`);
  }
  if (klaviyo.status === 'rejected') {
    throw new Error(`Failed to fetch Klaviyo data: ${klaviyo.reason.message}`);
  }

  const shopifyData = shopify.value;
  const klaviyoData = klaviyo.value;

  const findings = {
    zero_revenue_flows: [],
    unexplained_revenue_drops: [],
    flows_stopped_mid_week: [],
  };

  const logPromises = [];

  // -------------------------------------------------------------------
  // 1. Zero-revenue flows
  //    Active flows (≥ MIN_EMAILS_FOR_ACTIVE_FLOW sent) with $0 attributed.
  // -------------------------------------------------------------------
  for (const flow of klaviyoData.flows) {
    if (flow.emails_sent >= MIN_EMAILS_FOR_ACTIVE_FLOW && flow.revenue_attributed === 0) {
      const finding = {
        flow_id: flow.flow_id,
        flow_name: flow.flow_name,
        emails_sent: flow.emails_sent,
        revenue_attributed: 0,
        estimated_impact: 'Unknown — no revenue attribution found for this active flow',
      };
      findings.zero_revenue_flows.push(finding);

      logPromises.push(
        logLeakage({
          leakage_type: 'zero_revenue_flow',
          description: `Flow "${flow.flow_name}" sent ${flow.emails_sent} emails over the last 7 days but generated $0 in attributed revenue.`,
          estimated_impact: finding.estimated_impact,
          merchant_id: merchantId ?? null,
        })
      );
    }
  }

  // -------------------------------------------------------------------
  // 2. Unexplained revenue drops
  //    Days where Shopify revenue < DROP_THRESHOLD × 7-day average AND
  //    no Klaviyo flow sent any emails that day.
  // -------------------------------------------------------------------
  const revenueByDay = shopifyData.revenue_by_day;
  if (revenueByDay.length > 1) {
    const avgRevenue = shopifyData.total_revenue / revenueByDay.length;

    // Build a date → total_sends map from Klaviyo daily data
    const klaviyoSendsByDate = {};
    for (const flow of klaviyoData.flows) {
      for (const d of flow.daily_sends ?? []) {
        klaviyoSendsByDate[d.date] = (klaviyoSendsByDate[d.date] ?? 0) + d.value;
      }
    }

    for (const day of revenueByDay) {
      const isDropDay = day.revenue < avgRevenue * DROP_THRESHOLD;
      const klaviyoSends = klaviyoSendsByDate[day.date] ?? 0;

      if (isDropDay && klaviyoSends === 0) {
        const revenueShortfall = Math.round((avgRevenue - day.revenue) * 100) / 100;
        const finding = {
          date: day.date,
          shopify_revenue: day.revenue,
          average_daily_revenue: Math.round(avgRevenue * 100) / 100,
          revenue_shortfall: revenueShortfall,
          klaviyo_sends_that_day: 0,
          estimated_impact: fmtRevenue(revenueShortfall),
        };
        findings.unexplained_revenue_drops.push(finding);

        logPromises.push(
          logLeakage({
            leakage_type: 'unexplained_revenue_drop',
            description: `On ${day.date}, Shopify revenue was ${fmtRevenue(day.revenue)} — ${Math.round((1 - day.revenue / avgRevenue) * 100)}% below the 7-day average (${fmtRevenue(Math.round(avgRevenue * 100) / 100)}) — with zero Klaviyo flow activity.`,
            estimated_impact: fmtRevenue(revenueShortfall),
            merchant_id: merchantId ?? null,
          })
        );
      }
    }
  }

  // -------------------------------------------------------------------
  // 3. Flows that stopped sending mid-week
  //    Active flows that went completely silent for the last SILENT_TAIL_DAYS.
  // -------------------------------------------------------------------
  for (const flow of klaviyoData.flows) {
    if (flow.emails_sent >= MIN_EMAILS_FOR_ACTIVE_FLOW && didFlowStopMidWeek(flow.daily_sends)) {
      const lastActiveDay = [...(flow.daily_sends ?? [])]
        .sort((a, b) => a.date.localeCompare(b.date))
        .reverse()
        .find((d) => d.value > 0);

      const finding = {
        flow_id: flow.flow_id,
        flow_name: flow.flow_name,
        emails_sent_in_period: flow.emails_sent,
        last_active_day: lastActiveDay?.date ?? 'unknown',
        silent_for_days: SILENT_TAIL_DAYS,
        estimated_impact: `Potential lost sends — flow went silent ${SILENT_TAIL_DAYS}+ days before the analysis window ended`,
      };
      findings.flows_stopped_mid_week.push(finding);

      logPromises.push(
        logLeakage({
          leakage_type: 'flow_stopped_mid_week',
          description: `Flow "${flow.flow_name}" was active (${flow.emails_sent} sends) but stopped sending ${SILENT_TAIL_DAYS}+ days before the end of the 7-day window. Last active: ${lastActiveDay?.date ?? 'unknown'}.`,
          estimated_impact: finding.estimated_impact,
          merchant_id: merchantId ?? null,
        })
      );
    }
  }

  // Log all findings to Supabase (fire and forget — errors already handled inside logLeakage)
  await Promise.allSettled(logPromises);

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------
  const totalFindings =
    findings.zero_revenue_flows.length +
    findings.unexplained_revenue_drops.length +
    findings.flows_stopped_mid_week.length;

  return {
    analysis_period: {
      start: shopifyData.period_start,
      end: shopifyData.period_end,
    },
    shopify_summary: {
      total_revenue: shopifyData.total_revenue,
      order_count: shopifyData.order_count,
      currency: shopifyData.currency,
    },
    klaviyo_summary: {
      active_flow_count: klaviyoData.active_flow_count,
    },
    total_findings: totalFindings,
    findings,
    logged_to_supabase: logPromises.length > 0,
  };
}
