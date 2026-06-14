// Vercel Serverless API: Email service via Resend
// Path: /api/email
// Features:
//   1. Send runway report to user
//   2. Send 72-hour "calm down" reminder
//   3. Welcome email for new users

const RESEND_API = 'https://api.resend.com/emails';

const FROM_ADDRESS = process.env.RESEND_FROM || 'RunwayAI <onboarding@resend.dev>';

// Rate limit by IP (email abuse protection)
const emailStore = new Map();
const EMAIL_DAILY_LIMIT_PER_IP = 10;

function checkEmailLimit(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const record = emailStore.get(ip);
  if (!record || record.date !== today) {
    emailStore.set(ip, { date: today, count: 0 });
  }
  const current = emailStore.get(ip);
  if (current.count >= EMAIL_DAILY_LIMIT_PER_IP) {
    return { allowed: false, count: current.count };
  }
  current.count += 1;
  return { allowed: true, count: current.count };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function validateEmail(email) {
  if (!email || typeof email !== 'string') return 'Missing email';
  if (email.length > 254) return 'Email too long';
  // RFC 5322 simplified
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(email)) return 'Invalid email format';
  return null;
}

function buildReportEmail({ name, email, reportUrl, runwayDays, runnerId, lang = 'en' }) {
  const isEn = lang === 'en';
  const subject = isEn
    ? `Your RunwayAI Risk Report — ${runwayDays} days`
    : `你的 RunwayAI 风险跑道报告 — ${runwayDays} 天`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:0 auto;padding:2rem 1.5rem">
  <div style="background:#0a0a0a;color:#fff;border-radius:12px;padding:2rem;margin-bottom:1.5rem">
    <p style="font-size:.7rem;letter-spacing:.14em;color:rgba(255,255,255,.4);margin:0 0 1rem">RUNWAYAI — ${runnerId || ''}</p>
    <h1 style="font-family:Georgia,serif;font-size:1.8rem;margin:0 0 .5rem;font-weight:normal">${runwayDays} ${isEn ? 'days' : '天'}</h1>
    <p style="font-size:.85rem;color:rgba(255,255,255,.6);margin:0">${isEn ? 'Your financial runway, calculated.' : '你的风险跑道，已计算完成。'}</p>
  </div>

  <div style="background:#fff;border:1px solid #e2dfd8;border-radius:10px;padding:1.5rem;margin-bottom:1.5rem">
    <p style="font-size:.95rem;color:#0a0a0a;margin:0 0 1rem;line-height:1.6">${isEn ? `Hi ${name || 'there'},` : `你好${name || ''}，`}</p>
    <p style="font-size:.88rem;color:#444;line-height:1.7;margin:0 0 1rem">${isEn ? 'Your risk runway report is ready. Click below to view the full analysis:' : '你的风险跑道报告已生成，点击下方查看完整分析：'}</p>
    <a href="${reportUrl}" style="display:inline-block;padding:.85rem 1.5rem;background:#0a0a0a;color:#fff;text-decoration:none;border-radius:6px;font-size:.9rem">${isEn ? 'View my report →' : '查看我的报告 →'}</a>
  </div>

  <div style="background:#f5f4f0;border-radius:8px;padding:1.25rem;font-size:.78rem;color:#666;line-height:1.7">
    <p style="margin:0 0 .5rem;font-weight:600;color:#0a0a0a">${isEn ? 'Before You Buy:' : '消费冷静：'}</p>
    <p style="margin:0">${isEn ? 'The next time you want to buy something, come back and run it through our AI reflection tool. It will show you how many days of runway that purchase costs.' : '下次你想买什么的时候，回到这里用AI冷静分析一下。它会告诉你这笔消费会缩短多少天跑道。'}</p>
  </div>

  <p style="font-size:.72rem;color:#999;margin-top:1.5rem;text-align:center">RunwayAI · ${isEn ? 'Making money decisions clearer.' : '让消费决策更清晰。'}</p>
</div>
</body>
</html>`;

  return { subject, html };
}

function buildCalmReminderEmail({ name, email, itemName, price, runnerId, lang = 'en' }) {
  const isEn = lang === 'en';
  const subject = isEn
    ? `72 hours later — still want to buy ${itemName}?`
    : `72小时了 —— 还想买「${itemName}」吗？`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:0 auto;padding:2rem 1.5rem">
  <div style="background:#fff;border:1px solid #e2dfd8;border-radius:10px;padding:2rem;margin-bottom:1.5rem">
    <p style="font-size:.7rem;letter-spacing:.12em;color:#999;margin:0 0 1rem">❄️ 72-HOUR COOLING PERIOD — ${runnerId || ''}</p>
    <h1 style="font-family:Georgia,serif;font-size:1.4rem;margin:0 0 1rem;font-weight:normal;color:#0a0a0a">${isEn ? 'It\'s been 3 days.' : '已经过去3天了。'}</h1>
    <p style="font-size:.95rem;color:#444;line-height:1.7;margin:0 0 1.5rem">${isEn
      ? `3 days ago, you froze a purchase decision: <b>${itemName}</b> for <b>$${price}</b>. The cooling period is over.`
      : `3天前，你冷冻了一笔消费决策：<b>${itemName}</b>，价格 <b>$${price}</b>。冷静期已结束。`}</p>

    <div style="background:#f5f4f0;border-radius:8px;padding:1.25rem;margin-bottom:1.5rem">
      <p style="font-size:.85rem;color:#0a0a0a;margin:0 0 .5rem;font-weight:600">${isEn ? 'Three questions to ask yourself:' : '问自己三个问题：'}</p>
      <ol style="font-size:.85rem;color:#444;line-height:1.7;margin:0;padding-left:1.5rem">
        <li>${isEn ? 'Do I still want it as much as I did 3 days ago?' : '我还想当初那么想买它吗？'}</li>
        <li>${isEn ? 'Have I found a better alternative?' : '有没有发现更好的替代品？'}</li>
        <li>${isEn ? 'Is this aligned with my runway goals?' : '这符合我的跑道目标吗？'}</li>
      </ol>
    </div>

    <p style="font-size:.88rem;color:#444;line-height:1.7;margin:0">${isEn
      ? 'You can use the tool again to re-analyze. The decision is yours — we just help you think clearly.'
      : '你可以再次使用工具分析。这个决定是你的——我们只是帮你想清楚。'}</p>
  </div>

  <p style="font-size:.72rem;color:#999;text-align:center">RunwayAI · ${runnerId || ''}</p>
</div>
</body>
</html>`;

  return { subject, html };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit
  const ip = getClientIp(req);
  const limit = checkEmailLimit(ip);
  if (!limit.allowed) {
    return res.status(429).json({
      error: 'Email limit reached',
      message: 'You have sent too many emails today. Try again tomorrow.'
    });
  }

  const { type, email, name, reportUrl, runwayDays, runnerId, itemName, price, lang } = req.body || {};

  // Validate email
  const emailError = validateEmail(email);
  if (emailError) {
    return res.status(400).json({ error: emailError });
  }

  // Validate type
  if (!['report', 'calm_reminder'].includes(type)) {
    return res.status(400).json({ error: 'Invalid email type' });
  }

  // Build email content
  let subject, html;
  if (type === 'report') {
    if (!reportUrl || !runwayDays) {
      return res.status(400).json({ error: 'Missing reportUrl or runwayDays' });
    }
    const built = buildReportEmail({ name, email, reportUrl, runwayDays, runnerId, lang });
    subject = built.subject;
    html = built.html;
  } else if (type === 'calm_reminder') {
    if (!itemName || !price) {
      return res.status(400).json({ error: 'Missing itemName or price' });
    }
    const built = buildCalmReminderEmail({ name, email, itemName, price, runnerId, lang });
    subject = built.subject;
    html = built.html;
  }

  // Send via Resend
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY not set');
    return res.status(500).json({ error: 'Server config error' });
  }

  try {
    const resendRes = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [email],
        subject,
        html
      })
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error('Resend API error:', resendRes.status, errText);
      return res.status(502).json({
        error: 'Email service error',
        message: 'Could not send email. Please try again later.'
      });
    }

    const data = await resendRes.json();
    return res.status(200).json({
      success: true,
      messageId: data.id,
      message: 'Email sent successfully'
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({
      error: 'Server error',
      message: 'Something went wrong. Please try again.'
    });
  }
}
