# Risk Runway — Backend Deployment Guide

**Stack:** Vercel Serverless (API) + Resend (Email) + DeepSeek (AI)
**Cost:** $0/month for early stage (all free tiers)

---

## 🎯 Architecture

```
User Browser (GitHub Pages)
    ↓ HTTPS /api/*
Vercel Serverless (Node.js)
    ├─ /api/calm → DeepSeek API (AI analysis)
    ├─ /api/email → Resend API (email delivery)
    └─ In-memory rate limiter (per-IP daily quotas)
```

**Security:** All API keys live in Vercel env vars. Browser never sees them.

---

## 📋 Step 1: Resend Setup (5 minutes)

### 1.1 Create account
1. Go to https://resend.com
2. Click **"Sign Up"** → **"Continue with GitHub"**
3. Verify your email

### 1.2 Create API Key
1. Left menu → **"API Keys"** → **"Create API Key"**
2. Name: `risk-runway-prod`
3. Permission: **"Full Access"**
4. Click **"Add"**
5. **Copy the key** (starts with `re_`) — you'll need it for Vercel

### 1.3 Add sending domain
1. Left menu → **"Domains"** → **"Add Domain"**
2. Enter `fengxianpaodao.com` (or your domain)
3. Resend shows 3 DNS records (TXT/MX type)
4. Go to your DNS provider (Aliyun DNS, Cloudflare, etc.) and add them
5. Wait 5-10 minutes for verification

**Fallback:** If you can't verify a custom domain yet, use Resend's test domain `onboarding@resend.dev` (works immediately, but emails may land in spam).

---

## 📋 Step 2: Vercel Setup (10 minutes)

### 2.1 Create Vercel account
1. Go to https://vercel.com
2. Click **"Sign Up"** → **"Continue with GitHub"**
3. Authorize Vercel to access your GitHub repos

### 2.2 Import project
1. Vercel dashboard → **"Add New..."** → **"Project"**
2. Find your `risk-runway` repo → Click **"Import"**
3. **Configure project:**
   - Framework Preset: **"Other"**
   - Root Directory: **leave blank** (use repo root)
   - Build Command: leave empty
   - Output Directory: leave empty
4. Click **"Deploy"**
5. Vercel gives you a URL like `https://risk-runway-xxx.vercel.app`

### 2.3 Add environment variables
1. Project → **"Settings"** → **"Environment Variables"**
2. Add these 3 variables (for **Production**, **Preview**, **Development**):

| Name | Value | Where to find |
|------|-------|---------------|
| `DEEPSEEK_API_KEY` | `<your-deepseek-key>` (starts with `sk-`) | DeepSeek console |
| `RESEND_API_KEY` | `<your-resend-key>` (starts with `re_`) | Resend dashboard |
| `RESEND_FROM` | `RunwayAI <notice@fengxianpaodao.com>` | Your verified sender |

3. Click **"Save"**
4. Go to **"Deployments"** → Click ⋯ on latest → **"Redeploy"** (so env vars take effect)

### 2.4 Test API endpoints
After redeploy, test:
- `https://risk-runway-xxx.vercel.app/api/calm` (POST with sample data)
- `https://risk-runway-xxx.vercel.app/api/email` (POST with sample data)

---

## 📋 Step 3: Connect Frontend to Backend

The frontend (`report-deep.html`) already calls `/api/calm` and `/api/email`. **No code changes needed.**

But there's a CORS consideration: Vercel API routes don't include CORS headers for security. Since the API and frontend will be on the **same Vercel domain** after deployment, this is not an issue.

---

## 📋 Step 4: Bind Custom Domain (Optional, 5 minutes)

If you want `fengxianpaodao.com` instead of `risk-runway-xxx.vercel.app`:

1. Vercel project → **"Settings"** → **"Domains"**
2. Add `fengxianpaodao.com` and `www.fengxianpaodao.com`
3. Vercel gives you DNS records (usually `A` and `CNAME`)
4. Go to your DNS provider (Aliyun, Cloudflare) and add them
5. Wait 10-30 minutes for propagation

---

## 🛡️ Security Checklist

✅ API keys never in frontend code (only in Vercel env vars)
✅ All inputs validated server-side (item name, price, email)
✅ Rate limiting: 3/day free, 50/day paid (per IP)
✅ HTTPS enforced by Vercel
✅ Email content escaping (no XSS via reflection questions)
✅ CORS wildcard on API (tighten in production by setting `Access-Control-Allow-Origin` to your domain)

---

## 📊 Free Tier Limits

| Service | Free tier | When you'll hit it |
|---------|-----------|-------------------|
| **Vercel Serverless** | 100k requests/day, 10s timeout | ~10k calm analyses/day |
| **Resend** | 3,000 emails/month, 100/day | ~3k users using freeze feature/month |
| **DeepSeek** | Pay-as-you-go (~$0.0014/1k tokens) | 1k calm analyses = ~$0.10 |
| **Vercel KV** (optional for prod) | 30k requests/month, 256MB | Used for rate limit at scale |

**At 100 daily calm users (free tier), monthly cost: ~$3 (just DeepSeek tokens).**

---

## 🚨 Troubleshooting

### "API not found" (404)
- Check Vercel deployment succeeded
- Check URL is `https://your-domain.vercel.app/api/calm` (not relative `/api/calm`)
- For local testing, use `vercel dev` instead of opening HTML directly

### "CORS error" in browser console
- You're calling API from a different domain than Vercel deployment
- Either deploy frontend to Vercel same domain, or set CORS allow-origin

### "Daily limit reached" too soon
- Free limit is 3/day per IP (server-side, not localStorage)
- For testing, use different IPs (mobile vs wifi) or upgrade to Pro

### "Email not arriving"
- Check Resend dashboard → "Logs" for delivery status
- Check spam folder
- Verify sender domain in Resend

---

## 🧪 Local Testing (Optional)

To test API locally before deploying:

```bash
# Install Vercel CLI
npm i -g vercel

# In your project root
cd risk-runway
vercel dev

# Set env vars locally
echo "DEEPSEEK_API_KEY=sk-..." > .env.local
echo "RESEND_API_KEY=re_..." >> .env.local
echo "RESEND_FROM=RunwayAI <notice@fengxianpaodao.com>" >> .env.local

# Run
vercel dev
# API will be at http://localhost:3000/api/calm
```

Then in `report-deep.html`, change:
```javascript
var CALM_API = '/api/calm';
// ↓ for local testing ↓
var CALM_API = 'http://localhost:3000/api/calm';
```

---

## 📅 Deployment Checklist for 6/16 Launch

- [ ] Resend account created, API key generated
- [ ] Domain `fengxianpaodao.com` verified in Resend
- [ ] Vercel project imported from GitHub
- [ ] Env vars (DEEPSEEK_API_KEY, RESEND_API_KEY, RESEND_FROM) added
- [ ] Test `/api/calm` returns proper JSON
- [ ] Test `/api/email` sends a test email
- [ ] Frontend at `report-deep.html` correctly calls API
- [ ] Custom domain (if any) DNS records added
- [ ] Mobile test: click "Freeze 72h", receive email

---

## 📞 Support

- **Vercel docs:** https://vercel.com/docs
- **Resend docs:** https://resend.com/docs
- **DeepSeek docs:** https://platform.deepseek.com/docs

If something breaks during deployment, screenshot the error and ping the team.
