// Vercel Serverless API: DeepSeek proxy for Before You Buy analysis
// Path: /api/calm
// Security: API key stored in Vercel env var, never exposed to frontend
// Rate limit: 3/day for free, 50/day for paid (by localStorage rrPaid flag)

const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';

// Rate limit: in-memory store (resets on server restart, Vercel KV in production)
// Map<ip, {date: 'YYYY-MM-DD', count: number}>
const rateLimitStore = new Map();

const FREE_DAILY_LIMIT = 3;
const PAID_DAILY_LIMIT = 50;

function getClientIp(req) {
  // Vercel provides real IP in x-forwarded-for
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function checkRateLimit(ip, isPaid) {
  const today = new Date().toISOString().slice(0, 10);
  const limit = isPaid ? PAID_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const record = rateLimitStore.get(ip);

  if (!record || record.date !== today) {
    rateLimitStore.set(ip, { date: today, count: 0 });
  }

  const current = rateLimitStore.get(ip);
  if (current.count >= limit) {
    return {
      allowed: false,
      count: current.count,
      limit,
      remaining: 0
    };
  }

  current.count += 1;
  return {
    allowed: true,
    count: current.count,
    limit,
    remaining: limit - current.count
  };
}

// Validate inputs: prevent injection / abuse
function validateInputs(body) {
  const { itemName, price, buyReason, useMonths, dailyExpense, monthlyIncome } = body;

  if (!itemName || typeof itemName !== 'string') return 'Missing itemName';
  if (itemName.length > 200) return 'itemName too long (max 200)';
  if (itemName.match(/[<>{}]/)) return 'itemName contains invalid characters';

  if (price === undefined || price === null) return 'Missing price';
  const priceNum = parseFloat(price);
  if (isNaN(priceNum) || priceNum <= 0 || priceNum > 10000000) return 'Invalid price';

  if (buyReason !== undefined && buyReason !== null) {
    if (typeof buyReason !== 'string') return 'Invalid buyReason';
    if (buyReason.length > 500) return 'buyReason too long (max 500)';
  }

  const months = parseInt(useMonths);
  if (useMonths !== undefined && (isNaN(months) || months < 0 || months > 600)) {
    return 'Invalid useMonths';
  }

  return null; // OK
}

function buildPrompt({ itemName, price, buyReason, useMonths, dailyExpense, monthlyIncome, runwayDays }) {
  const expenseStr = dailyExpense ? `$${dailyExpense}/day` : 'unknown';
  const incomeStr = monthlyIncome ? `$${monthlyIncome}/month` : 'unknown';
  const reasonStr = buyReason || 'not specified';
  const monthsStr = useMonths ? `${useMonths} months` : 'unspecified';

  // Calculate rough workdays needed
  let workdaysNeeded = 'unknown';
  if (dailyExpense && parseFloat(dailyExpense) > 0) {
    workdaysNeeded = (parseFloat(price) / parseFloat(dailyExpense)).toFixed(1);
  }

  return `You are a neutral, non-judgmental financial reflection assistant. Your job is NOT to recommend whether to buy or not buy. Your job is to help the user think clearly.

# Core principles (strictly follow)
1. Stay NEUTRAL: never say "buy it" or "don't buy it"
2. Don't recommend specific alternative products
3. Show OBJECTIVE numbers (workdays needed, runway impact)
4. Suggest REFLECTION QUESTIONS the user should ask themselves
5. Frame everything around EXTENDING THE USER'S FINANCIAL RUNWAY
6. The only "good" investments you can suggest are: knowledge/learning, health (medical checkups, exercise), genuine emergency preparedness
7. Never moralize. Never shame. Never say "you should".
8. If the item genuinely supports health, learning, or essential safety — acknowledge that
9. If it looks like pure impulse/emotional spending — point that out gently, as a question

# User context
- Item: ${itemName}
- Price: $${price}
- Stated reason: ${reasonStr}
- Expected use period: ${monthsStr}
- Monthly income: ${incomeStr}
- Daily living expense: ${expenseStr}
- Current runway: ${runwayDays || 'unknown'} days
- Workdays needed to afford this (at disposable income): ${workdaysNeeded}

# Output format (strict JSON)
{
  "summary": "1-2 sentence neutral summary acknowledging the user's situation",
  "objective_metrics": {
    "workdays_needed": "${workdaysNeeded}",
    "runway_days_impact": <estimated days this purchase would shorten the runway>,
    "daily_cost_over_use_period": <if useMonths > 0, calculate $/day; otherwise null>
  },
  "neutral_analysis": "3-4 sentences. State what the numbers mean objectively. Example: 'This purchase equals X workdays at your disposable income level.' Don't say 'don't buy' or 'buy it'.",
  "reflection_questions": [
    "Question 1: a thought-provoking question about the decision",
    "Question 2: another angle to consider",
    "Question 3: a forward-looking question (knowledge/health/runway focused)"
  ],
  "knowledge_or_health_framing": "If the item could be reframed as investment in knowledge or health, mention it neutrally. Otherwise null. Example: 'A $200 programming book = 13 days of runway. If it advances your career by 10%, the long-term ROI on runway could be positive.'",
  "verdict_label": "ONE of: 'worth reflection' | 'high cost' | 'moderate cost' | 'knowledge investment' | 'health investment'",
  "disclaimer": "I don't recommend buying or not buying. The decision is yours. These numbers are estimates based on what you provided."
}

# Response language
Respond in English (the product is in English). Keep total response under 400 words. Be warm but factual. No exclamation marks. No emojis.`;
}

export default async function handler(req, res) {
  // CORS: allow your domain
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten in production
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit
  const ip = getClientIp(req);
  const isPaid = req.body && req.body.isPaid === true;
  const rate = checkRateLimit(ip, isPaid);

  res.setHeader('X-RateLimit-Limit', String(rate.limit));
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));

  if (!rate.allowed) {
    return res.status(429).json({
      error: 'Daily limit reached',
      message: isPaid
        ? `You've used ${rate.count}/${rate.limit} AI analyses today. Try again tomorrow.`
        : `Free users get ${rate.limit} AI analyses per day. Upgrade to Pro for ${PAID_DAILY_LIMIT}/day.`,
      count: rate.count,
      limit: rate.limit
    });
  }

  // Validate
  const validationError = validateInputs(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  // Build prompt
  const prompt = buildPrompt(req.body);

  // Call DeepSeek
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('DEEPSEEK_API_KEY not set in env');
    return res.status(500).json({ error: 'Server config error' });
  }

  try {
    const deepseekRes = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: 'You are a neutral, non-judgmental financial reflection assistant. Always respond in valid JSON as specified by the user. Never use emojis or exclamation marks.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      })
    });

    if (!deepseekRes.ok) {
      const errText = await deepseekRes.text();
      console.error('DeepSeek API error:', deepseekRes.status, errText);
      return res.status(502).json({
        error: 'AI service error',
        message: 'The AI is temporarily unavailable. Please try again in a moment.'
      });
    }

    const data = await deepseekRes.json();
    const aiContent = data.choices[0].message.content;

    let parsed;
    try {
      parsed = JSON.parse(aiContent);
    } catch (e) {
      console.error('Failed to parse AI response:', aiContent);
      return res.status(502).json({
        error: 'AI response format error',
        message: 'The AI returned an unexpected response. Please try again.'
      });
    }

    return res.status(200).json({
      success: true,
      data: parsed,
      rateLimit: {
        count: rate.count,
        limit: rate.limit,
        remaining: rate.remaining
      }
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({
      error: 'Server error',
      message: 'Something went wrong. Please try again.'
    });
  }
}
