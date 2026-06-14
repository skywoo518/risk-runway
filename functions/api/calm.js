/**
 * Cloudflare Pages Function: /api/calm
 * Proxies DeepSeek API with rate limiting (Cloudflare KV) + Turnstile + Origin lock.
 *
 * Request body:
 *   itemName, price, buyReason?, useMonths?, dailyExpense?, monthlyIncome?, runwayDays?, isPaid?
 *   turnstileToken: required (verified server-side)
 *
 * Response: { success: true, data: {...} }
 */

import {
  verifyTurnstile, checkRateLimitKV, jsonResponse,
  corsHeaders, getClientIp, getOrigin, isOriginAllowed
} from './_shared.js';

const ALLOWED_ORIGINS = [
  'https://fengxianpaodao.com',
  'https://www.fengxianpaodao.com',
  'https://skywoo518.github.io',
];

const FREE_DAILY_LIMIT = 3;
const PAID_DAILY_LIMIT = 50;

export async function onRequest(context) {
  const { request, env } = context;
  const origin = getOrigin(request);

  // ── 1. CORS preflight ──
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin, ALLOWED_ORIGINS) });
  }

  // ── 2. Method check ──
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, message: 'Method not allowed' }, 405, origin, ALLOWED_ORIGINS);
  }

  // ── 3. ORIGIN LOCK ──
  // Browser: Origin header in allow-list. Curl/server-to-server needs X-Verified-Source (for cron/internal).
  const isServerToServer = request.headers.get('X-Verified-Source') === 'risk-runway-internal';
  if (!isServerToServer && !isOriginAllowed(origin, ALLOWED_ORIGINS)) {
    return jsonResponse({
      success: false,
      message: 'Forbidden: origin not allowed. This API only accepts requests from approved frontends.'
    }, 403, origin, ALLOWED_ORIGINS);
  }

  // ── 4. Parse body ──
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ success: false, message: 'Invalid JSON body' }, 400, origin, ALLOWED_ORIGINS);
  }

  // ── 5. TURNSTILE VERIFY ──
  if (!isServerToServer) {
    const turnstileToken = body.turnstileToken;
    const turnstileSecret = env.TURNSTILE_SECRET_KEY;
    if (!turnstileSecret) {
      console.error('TURNSTILE_SECRET_KEY env var not set');
      return jsonResponse({ success: false, message: 'Server misconfigured: Turnstile secret missing' }, 500, origin, ALLOWED_ORIGINS);
    }
    const ip = getClientIp(request);
    const verify = await verifyTurnstile(turnstileToken, ip, turnstileSecret);
    if (!verify.success) {
      return jsonResponse({
        success: false,
        message: 'Human verification failed. Please refresh the page and try again.',
        codes: verify['error-codes'] || []
      }, 403, origin, ALLOWED_ORIGINS);
    }
  }

  // ── 6. Validate required fields ──
  const { itemName, price } = body;
  if (!itemName || itemName.trim().length === 0) {
    return jsonResponse({ success: false, message: 'Missing itemName' }, 400, origin, ALLOWED_ORIGINS);
  }
  const priceNum = parseFloat(price);
  if (isNaN(priceNum) || priceNum <= 0) {
    return jsonResponse({ success: false, message: 'Invalid price' }, 400, origin, ALLOWED_ORIGINS);
  }

  // ── 7. RATE LIMIT (KV-backed) ──
  const ip = getClientIp(request);
  const isPaid = !!body.isPaid;
  const limit = isPaid ? PAID_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const rl = await checkRateLimitKV(env, ip, 'calm', limit);
  if (!rl.allowed) {
    const msg = isPaid
      ? `Daily AI analysis limit reached (${PAID_DAILY_LIMIT}/day). Resets at midnight UTC.`
      : `Free plan: ${FREE_DAILY_LIMIT} AI analyses per day. Upgrade to Pro for ${PAID_DAILY_LIMIT}/day.`;
    return jsonResponse({ success: false, message: msg, limit: rl.limit }, 429, origin, ALLOWED_ORIGINS);
  }

  // ── 8. Get DeepSeek API key ──
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return jsonResponse({ success: false, message: 'Server misconfigured: missing DeepSeek API key' }, 500, origin, ALLOWED_ORIGINS);
  }

  // ── 9. Build DeepSeek prompt ──
  const buyReason = body.buyReason || '';
  const useMonths = body.useMonths ? parseInt(body.useMonths) : null;
  const dailyExpense = body.dailyExpense ? parseFloat(body.dailyExpense) : 0;
  const monthlyIncome = body.monthlyIncome ? parseFloat(body.monthlyIncome) : 0;
  const runwayDays = body.runwayDays || 0;

  const systemPrompt = `You are a rational consumption coach for the "Risk Runway" financial tool.
Your goal is NOT to tell users what to buy or not to buy.
You are neutral. You help users think clearly about how a purchase affects their financial runway (how many days they can survive without income).

Key principles:
- Never recommend specific products or brands.
- Never say "buy this" or "don't buy this".
- Always frame the purchase in terms of "runway days lost" vs "potential value gained".
- If the item could be an investment in health or knowledge, mention that neutrally.
- End with a neutral question, not a directive.
- Keep responses under 120 words.
- Output ONLY valid JSON (no markdown, no code fences).

Respond in this JSON format:
{
  "verdict_label": "one of: worth reflection | high cost | moderate cost | knowledge investment | health investment",
  "summary": "One sentence neutral summary of this purchase's impact on runway",
  "neutral_analysis": "2-3 sentence objective analysis of the financial and practical aspects",
  "reflection_questions": ["question 1", "question 2"],
  "objective_metrics": {
    "workdays_needed": "X days (based on daily expense)" or "unknown",
    "runway_days_impact": number,
    "daily_cost_over_use_period": "if useMonths provided: $X/day"
  },
  "category_impact": "positive (health/career/long-term knowledge investment) | neutral (general consumption) | negative (impulse/health-damaging/zero-value)",
  "category_reason": "Short 1-sentence reason for the category_impact verdict (e.g. 'Running shoes support long-term cardiovascular health' or 'Generic entertainment with no lasting value')",
  "knowledge_or_health_framing": "If applicable, suggest considering this as an investment in health/knowledge. Otherwise: empty string.",
  "disclaimer": "This is a neutral analysis tool, not financial advice."
}`;

  const userPrompt = `User is considering a purchase:
- Item: ${itemName}
- Price: $${priceNum}
${buyReason ? '- Reason: ' + buyReason : ''}
${useMonths ? '- Expected use: ' + useMonths + ' months' : ''}
- User's daily expense: $${dailyExpense || 'unknown'}
- User's monthly income: $${monthlyIncome || 'unknown'}
- Current runway: ${runwayDays} days

Please analyze this purchase neutrally. How many days of runway will this cost? Is there a health/knowledge investment angle?`;

  // ── 10. Call DeepSeek ──
  try {
    const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }),
    });

    if (!dsRes.ok) {
      const errText = await dsRes.text();
      console.error('DeepSeek API error:', dsRes.status, errText);
      return jsonResponse({ success: false, message: 'AI service temporarily unavailable. Please try again in a moment.' }, 502, origin, ALLOWED_ORIGINS);
    }

    const dsData = await dsRes.json();
    const content = dsData.choices?.[0]?.message?.content;

    if (!content) {
      return jsonResponse({ success: false, message: 'AI returned empty response. Please try again.' }, 502, origin, ALLOWED_ORIGINS);
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      parsed = {
        verdict_label: 'worth reflection',
        summary: 'AI analysis received (non-JSON response)',
        neutral_analysis: content.slice(0, 300),
        reflection_questions: [],
        objective_metrics: {},
        knowledge_or_health_framing: '',
        disclaimer: 'This is a neutral analysis tool, not financial advice.'
      };
    }

    // Calculate metrics server-side for accuracy
    if (dailyExpense > 0 && runwayDays > 0) {
      parsed.objective_metrics = parsed.objective_metrics || {};
      parsed.objective_metrics.workdays_needed = Math.ceil(priceNum / dailyExpense);
      parsed.objective_metrics.runway_days_impact = Math.max(1, Math.round(priceNum / dailyExpense));
      if (useMonths && useMonths > 0) {
        parsed.objective_metrics.daily_cost_over_use_period = '$' + (priceNum / (useMonths * 30)).toFixed(1) + '/day';
      }
    }

    return jsonResponse({
      success: true,
      data: parsed,
      rateLimit: { limit: rl.limit, remaining: rl.remaining }
    }, 200, origin, ALLOWED_ORIGINS);

  } catch (err) {
    console.error('DeepSeek call failed:', err);
    return jsonResponse({ success: false, message: 'Network error connecting to AI service. Please try again.' }, 502, origin, ALLOWED_ORIGINS);
  }
}
