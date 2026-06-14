/**
 * Cloudflare Pages Function: Shared helpers
 * Imported by calm.js, email.js, and any future API endpoint.
 */

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function getToday() {
  return new Date().toISOString().slice(0, 10);
}

export function getHourKey() {
  const d = new Date();
  return d.toISOString().slice(0, 13);
}

export function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         'unknown';
}

export function getOrigin(request) {
  return request.headers.get('Origin') || request.headers.get('Referer')?.replace(/\/$/, '') || '';
}

export function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return false;
  for (const allowed of allowedOrigins) {
    if (origin === allowed) return true;
    // Allow subpath on github.io
    if (allowed.startsWith('https://skywoo518.github.io') && origin.startsWith('https://skywoo518.github.io/')) return true;
  }
  return false;
}

export function corsHeaders(origin, allowedOrigins) {
  const allowOrigin = isOriginAllowed(origin, allowedOrigins) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export function jsonResponse(data, status, origin, allowedOrigins) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, allowedOrigins || []) }
  });
}

export async function verifyTurnstile(token, ip, secret) {
  if (!token || !secret) {
    return { success: false, 'error-codes': ['missing-input'] };
  }
  try {
    const body = new URLSearchParams();
    body.append('secret', secret);
    body.append('response', token);
    if (ip && ip !== 'unknown') body.append('remoteip', ip);
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json();
    return data;
  } catch (e) {
    console.error('Turnstile verify failed:', e);
    return { success: false, 'error-codes': ['internal-error'] };
  }
}

// ─── RATE LIMITS (KV-backed with in-memory fallback) ───

export async function checkRateLimitKV(env, ip, kind, limit) {
  const today = getToday();
  const key = `rl:${kind}:${ip}:${today}`;

  if (env.RATE_LIMIT_KV) {
    const current = parseInt(await env.RATE_LIMIT_KV.get(key) || '0', 10);
    if (current >= limit) {
      return { allowed: false, limit, remaining: 0, current };
    }
    await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 172800 });
    return { allowed: true, limit, remaining: limit - current - 1, current: current + 1 };
  }

  // In-memory fallback
  const gKey = '__rr_rl_' + kind;
  if (!globalThis[gKey]) globalThis[gKey] = new Map();
  const map = globalThis[gKey];
  const rec = map.get(key) || { date: today, count: 0 };
  if (rec.date !== today) { rec.date = today; rec.count = 0; }
  if (rec.count >= limit) return { allowed: false, limit, remaining: 0, current: rec.count };
  rec.count++;
  map.set(key, rec);
  return { allowed: true, limit, remaining: limit - rec.count, current: rec.count };
}

export async function checkEmailRateLimit(env, ip) {
  const today = getToday();
  const hour = getHourKey();
  const dayKey = `rl:email:day:${ip}:${today}`;
  const hourKey = `rl:email:hour:${ip}:${hour}`;
  const EMAIL_HOURLY_LIMIT = 5;
  const EMAIL_DAILY_LIMIT = 20;

  if (env.RATE_LIMIT_KV) {
    const dayCount = parseInt(await env.RATE_LIMIT_KV.get(dayKey) || '0', 10);
    if (dayCount >= EMAIL_DAILY_LIMIT) {
      return { allowed: false, reason: 'daily', limit: EMAIL_DAILY_LIMIT, current: dayCount };
    }
    const hourCount = parseInt(await env.RATE_LIMIT_KV.get(hourKey) || '0', 10);
    if (hourCount >= EMAIL_HOURLY_LIMIT) {
      return { allowed: false, reason: 'hourly', limit: EMAIL_HOURLY_LIMIT, current: hourCount };
    }
    await env.RATE_LIMIT_KV.put(dayKey, String(dayCount + 1), { expirationTtl: 172800 });
    await env.RATE_LIMIT_KV.put(hourKey, String(hourCount + 1), { expirationTtl: 7200 });
    return { allowed: true };
  }

  if (!globalThis.__rrEmailHits) globalThis.__rrEmailHits = new Map();
  const map = globalThis.__rrEmailHits;
  const rec = map.get(ip) || { day: { date: today, count: 0 }, hour: { key: hour, count: 0 } };
  if (rec.day.date !== today) { rec.day = { date: today, count: 0 }; }
  if (rec.hour.key !== hour) { rec.hour = { key: hour, count: 0 }; }
  if (rec.day.count >= EMAIL_DAILY_LIMIT) return { allowed: false, reason: 'daily', limit: EMAIL_DAILY_LIMIT, current: rec.day.count };
  if (rec.hour.count >= EMAIL_HOURLY_LIMIT) return { allowed: false, reason: 'hourly', limit: EMAIL_HOURLY_LIMIT, current: rec.hour.count };
  rec.day.count++;
  rec.hour.count++;
  map.set(ip, rec);
  return { allowed: true };
}

// ─── BLOCKED EMAIL DOMAINS (anti-abuse) ───

const BLOCKED_EMAIL_DOMAINS = [
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'throwaway.email', 'yopmail.com', 'trashmail.com', 'fakeinbox.com',
  'dispostable.com', 'maildrop.cc', 'sharklasers.com', 'getnada.com',
  'mintemail.com', 'spamgourmet.com', 'mailcatch.com', 'discard.email',
];

export function isBlockedEmailDomain(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return true;
  return BLOCKED_EMAIL_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}
