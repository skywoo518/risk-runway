/**
 * Cloudflare Pages Function: /api/calm
 * Proxies DeepSeek API with rate limiting (IP-based, uses in-memory store)
 *
 * Request body:
 *   itemName, price, buyReason?, useMonths?, dailyExpense?, monthlyIncome?, runwayDays?, isPaid?
 *
 * Response: { success: true, data: {...} }
 */

// In-memory rate limiter (per-process; Cloudflare Pages functions are ephemeral,
// but repeated requests from same colo may hit same instance. Good enough for demo.
// For production, use Cloudflare KV.)
const ipHits = new Map(); // ip -> { date, count }

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function checkRateLimit(ip, isPaid) {
  const today = getToday();
  const limit = isPaid ? 50 : 3;
  const key = ip + ':' + today;
  const rec = ipHits.get(key) || { date: today, count: 0 };
  if (rec.date !== today) {
    rec.date = today;
    rec.count = 0;
  }
  if (rec.count >= limit) {
    return { allowed: false, limit, remaining: 0 };
  }
  rec.count++;
  ipHits.set(key, rec);
  return { allowed: true, limit, remaining: limit - rec.count };
}

export async function onRequest(context) {
  const { request, env } = context;

  // CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, message: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ success: false, message: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Validate required fields
  const { itemName, price } = body;
  if (!itemName || itemName.trim().length === 0) {
    return new Response(JSON.stringify({ success: false, message: 'Missing itemName' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
  const priceNum = parseFloat(price);
  if (isNaN(priceNum) || priceNum <= 0) {
    return new Response(JSON.stringify({ success: false, message: 'Invalid price' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Rate limit (best-effort IP from headers)
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const isPaid = !!body.isPaid;
  const rl = checkRateLimit(ip, isPaid);
  if (!rl.allowed) {
    const msg = isPaid
      ? 'Daily AI analysis limit reached (50/day). Resets at midnight UTC.'
      : 'Free plan: 3 AI analyses per day. Upgrade to Pro for 50/day.';
    return new Response(JSON.stringify({ success: false, message: msg }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Get API key from env
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ success: false, message: 'Server misconfigured: missing DeepSeek API key' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Build DeepSeek prompt
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

  // Call DeepSeek API
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
      return new Response(JSON.stringify({
        success: false,
        message: 'AI service temporarily unavailable. Please try again in a moment.'
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const dsData = await dsRes.json();
    const content = dsData.choices && dsData.choices[0] && dsData.choices[0].message && dsData.choices[0].message.content;

    if (!content) {
      return new Response(JSON.stringify({
        success: false,
        message: 'AI returned empty response. Please try again.'
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      // If DeepSeek didn't return clean JSON, wrap it
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

    return new Response(JSON.stringify({ success: true, data: parsed }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    console.error('DeepSeek call failed:', err);
    return new Response(JSON.stringify({
      success: false,
      message: 'Network error connecting to AI service. Please try again.'
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
