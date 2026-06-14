/**
 * Risk Runway — Before You Buy (Consumption Reflection) module
 * Shared between index.html, report-basic.html, report-deep.html.
 *
 * Exposes: window.RiskRunwayCalm
 *  - .init({ cardId, inputAreaId, resultId, loadingId, rateInfoId, daysPreviewId, itemNameId, itemPriceId, useMonthsId, reasonId, submitBtnId, calmApi, emailApi })
 *  - .submit() — submit the form to AI
 *  - .reset() — clear form
 *  - .updateRateInfo() — refresh rate-info text
 *  - .recordDecision(decision) — record "bought" / "held_off" feedback (returns runway delta)
 *
 * Localstorage keys used:
 *   rrPaid               — "true" if user is paid
 *   rrRunner             — runner id (e.g. "#A3F2")
 *   rrUserEmail          — user email (for freeze + report emails)
 *   rrCalmCount_YYYYMMDD — daily count of AI analyses
 *   rrCalmDecisions      — array of {id, name, price, category, decision, daysDelta, ts}
 */
(function(){
  'use strict';

  var CALM_API_DEFAULT = '/api/calm';
  var EMAIL_API_DEFAULT = '/api/email';

  // ── helpers ──
  function escapeHtml(s){
    if(s === undefined || s === null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttr(s){
    if(s === undefined || s === null) return '';
    return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }
  function todayStr(){
    return new Date().toISOString().slice(0, 10);
  }
  function genDecisionId(){
    return 'd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ── rate limit (client-side, best-effort) ──
  function getDailyCount(){
    return parseInt(localStorage.getItem('rrCalmCount_' + todayStr()) || '0', 10);
  }
  function incrementDailyCount(){
    var n = getDailyCount() + 1;
    localStorage.setItem('rrCalmCount_' + todayStr(), String(n));
    return n;
  }

  // ── decisions log ──
  function loadDecisions(){
    try{ return JSON.parse(localStorage.getItem('rrCalmDecisions') || '[]'); }catch(e){ return []; }
  }
  function saveDecisions(list){
    try{ localStorage.setItem('rrCalmDecisions', JSON.stringify(list)); }catch(e){}
  }

  // ── runway days delta calculation ──
  // Symmetric: positive if positive/neutral purchase, negative if negative impulse
  // For "held off": always positive (you saved the money = +X days)
  function computeRunwayDelta(ai, price, decision, dailyExpense){
    var impact = (ai && ai.objective_metrics && ai.objective_metrics.runway_days_impact) ? ai.objective_metrics.runway_days_impact : 0;
    if(!impact && dailyExpense > 0) impact = Math.max(1, Math.round(price / dailyExpense));
    if(!impact) impact = 1;

    if(decision === 'held_off'){
      // Always positive — you didn't spend the money
      return Math.max(1, impact);
    }
    // decision === 'bought'
    var cat = (ai && ai.category_impact) || 'neutral';
    if(cat === 'positive') return impact;        // bought something good: runway +impact
    if(cat === 'negative') return -impact;        // bought something bad: runway -impact
    return 0;                                     // neutral: no change
  }

  // ── apply delta to local saved runway data ──
  function applyDeltaToReportData(delta){
    try{
      var raw = localStorage.getItem('riskRunwayData');
      if(!raw) return false;
      var data = JSON.parse(raw);
      // Try multiple keys
      if(typeof data.runwayDays === 'number'){
        data.runwayDays = Math.max(0, data.runwayDays + delta);
      }
      if(typeof data.days === 'number'){
        data.days = Math.max(0, data.days + delta);
      }
      localStorage.setItem('riskRunwayData', JSON.stringify(data));
      return true;
    }catch(e){ return false; }
  }

  // ── module instance ──
  var cfg = null;
  var lastAnalysis = null;  // {ai, price, name, decisionId, runwayImpact}

  function el(id){ return document.getElementById(id); }

  function updateRateInfo(){
    if(!cfg || !cfg.rateInfoId) return;
    var info = el(cfg.rateInfoId);
    if(!info) return;
    var isPaid = localStorage.getItem('rrPaid') === 'true';
    var limit = isPaid ? 50 : 3;
    var used = getDailyCount();
    var remaining = Math.max(0, limit - used);
    if(isPaid){
      info.textContent = remaining > 0
        ? 'Pro plan: ' + remaining + ' of ' + limit + ' AI analyses remaining today'
        : 'Pro plan: 0 analyses left today (resets at midnight UTC)';
    } else {
      info.textContent = 'Free plan: ' + remaining + ' of ' + limit + ' AI analyses remaining today. ' +
        (remaining === 0 ? 'Resets tomorrow. Upgrade to Pro for 50/day.' : 'Each analysis helps you think clearer.');
    }
  }

  function setView(view){
    // view: 'input' | 'loading' | 'result'
    if(cfg.inputAreaId) el(cfg.inputAreaId).style.display = (view === 'input') ? 'block' : 'none';
    if(cfg.loadingId)   el(cfg.loadingId).style.display   = (view === 'loading') ? 'block' : 'none';
    if(cfg.resultId)    el(cfg.resultId).style.display    = (view === 'result') ? 'block' : 'none';
  }

  function readForm(){
    return {
      name:  el(cfg.itemNameId).value.trim(),
      priceStr: el(cfg.itemPriceId).value.trim(),
      useMonths: el(cfg.useMonthsId).value.trim(),
      reason: el(cfg.reasonId).value.trim()
    };
  }

  function getUserContext(){
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('riskRunwayData')||'{}'); } catch(e){}
    var dailyExpense = 0, monthlyIncome = 0, runwayDays = 0;
    if(saved){
      dailyExpense = parseFloat(saved.e || saved.dailyExpense || 0) || 0;
      monthlyIncome = parseFloat(saved.s || saved.monthlyIncome || 0) || 0;
      // try multiple runway keys
      runwayDays = parseInt(saved.runwayDays || saved.days || saved.runway_days || 0) || 0;
    }
    // also try DOM if available (report pages)
    if(!runwayDays){
      var rh = document.getElementById('rh-days');
      if(rh){
        var t = rh.textContent.trim();
        runwayDays = t === '∞' ? 9999 : (parseInt(t) || 0);
      }
    }
    return { dailyExpense: dailyExpense, monthlyIncome: monthlyIncome, runwayDays: runwayDays };
  }

  async function submit(){
    if(!cfg) return;
    var f = readForm();
    if(!f.name){ alert('Please enter the item name'); return; }
    if(f.name.length > 200){ alert('Item name is too long (max 200 characters)'); return; }
    if(!f.priceStr){ alert('Please enter the price'); return; }
    var price = parseFloat(f.priceStr);
    if(isNaN(price) || price <= 0){ alert('Please enter a valid price'); return; }
    if(price > 10000000){ alert('Price seems too high. Please double-check.'); return; }
    if(f.useMonths){
      var months = parseInt(f.useMonths);
      if(isNaN(months) || months < 0 || months > 600){ alert('Expected use must be 0-600 months'); return; }
    }

    // Pre-check daily limit (client-side best effort; server is source of truth)
    var isPaid = localStorage.getItem('rrPaid') === 'true';
    if(!isPaid && getDailyCount() >= 3){
      alert('You\'ve used all 3 free AI analyses today. They reset at midnight UTC. Upgrade to Pro for 50/day.');
      return;
    }

    var ctx = getUserContext();

    setView('loading');

    try {
      var apiBase = cfg.calmApi || CALM_API_DEFAULT;
      var res = await fetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemName: f.name,
          price: price,
          buyReason: f.reason || undefined,
          useMonths: f.useMonths || undefined,
          dailyExpense: ctx.dailyExpense || undefined,
          monthlyIncome: ctx.monthlyIncome || undefined,
          runwayDays: ctx.runwayDays,
          isPaid: isPaid
        })
      });

      var data = await res.json();

      if(!res.ok){
        var errMsg = data.message || data.error || 'Something went wrong. Please try again.';
        el(cfg.resultId).innerHTML =
          '<div style="background:#fdf0ee;border:1px solid #f5bcb8;border-radius:8px;padding:1.25rem;text-align:center">' +
          '<p style="font-size:.9rem;color:#c0392b;margin:0 0 .75rem;font-weight:500">' + escapeHtml(errMsg) + '</p>' +
          '<button onclick="window.RiskRunwayCalm.reset()" style="padding:.6rem 1.5rem;background:#fff;color:var(--ink);border:1px solid var(--border);border-radius:6px;font-size:.85rem;cursor:pointer">Try again</button>' +
          '</div>';
        setView('result');
        return;
      }

      incrementDailyCount();
      lastAnalysis = {
        ai: data.data,
        price: price,
        name: f.name,
        decisionId: genDecisionId(),
        dailyExpense: ctx.dailyExpense,
        runwayDays: ctx.runwayDays
      };
      renderResult(data.data, price, f.name);
      updateRateInfo();

    } catch(err){
      console.error('Calm error:', err);
      el(cfg.resultId).innerHTML =
        '<div style="background:#fdf0ee;border:1px solid #f5bcb8;border-radius:8px;padding:1.25rem;text-align:center">' +
        '<p style="font-size:.9rem;color:#c0392b;margin:0 0 .75rem">Network error. Please check your connection and try again.</p>' +
        '<button onclick="window.RiskRunwayCalm.reset()" style="padding:.6rem 1.5rem;background:#fff;color:var(--ink);border:1px solid var(--border);border-radius:6px;font-size:.85rem;cursor:pointer">Try again</button>' +
        '</div>';
      setView('result');
    }
  }

  function renderResult(ai, price, name){
    setView('result');
    var resultEl = el(cfg.resultId);
    if(!resultEl) return;

    var labelColors = {
      'worth reflection': { bg:'#fdf6e8', border:'#f5d99a', text:'#d4840a' },
      'high cost': { bg:'#fdf0ee', border:'#f5bcb8', text:'#c0392b' },
      'moderate cost': { bg:'#fdf6e8', border:'#f5d99a', text:'#d4840a' },
      'knowledge investment': { bg:'#eaf5ef', border:'#b8e8ce', text:'#1a7a4a' },
      'health investment': { bg:'#eaf5ef', border:'#b8e8ce', text:'#1a7a4a' }
    };
    var cs = labelColors[ai.verdict_label] || labelColors['worth reflection'];

    var metrics = ai.objective_metrics || {};
    var metricsHtml = '';
    if(metrics.workdays_needed && metrics.workdays_needed !== 'unknown'){
      metricsHtml += '<div style="flex:1;background:#fff;border-radius:6px;padding:.7rem;text-align:center"><p style="font-size:.62rem;color:var(--dim);letter-spacing:.06em;margin:0 0 .25rem;text-transform:uppercase">Workdays needed</p><p style="font-family:var(--serif);font-size:1.3rem;color:var(--ink);margin:0">' + escapeHtml(metrics.workdays_needed) + '</p></div>';
    }
    if(metrics.runway_days_impact){
      metricsHtml += '<div style="flex:1;background:#fff;border-radius:6px;padding:.7rem;text-align:center"><p style="font-size:.62rem;color:var(--dim);letter-spacing:.06em;margin:0 0 .25rem;text-transform:uppercase">Runway impact</p><p style="font-family:var(--serif);font-size:1.3rem;color:' + cs.text + ';margin:0">-' + metrics.runway_days_impact + 'd</p></div>';
    }
    if(metrics.daily_cost_over_use_period){
      metricsHtml += '<div style="flex:1;background:#fff;border-radius:6px;padding:.7rem;text-align:center"><p style="font-size:.62rem;color:var(--dim);letter-spacing:.06em;margin:0 0 .25rem;text-transform:uppercase">Daily cost</p><p style="font-family:var(--serif);font-size:1.3rem;color:var(--ink);margin:0">$' + escapeHtml(metrics.daily_cost_over_use_period) + '/d</p></div>';
    }

    var questionsHtml = '';
    if(ai.reflection_questions && ai.reflection_questions.length > 0){
      questionsHtml = '<div style="margin-top:1.25rem"><p style="font-size:.7rem;letter-spacing:.08em;color:var(--dim);text-transform:uppercase;margin:0 0 .5rem">Questions to ask yourself</p><ol style="font-size:.85rem;color:var(--ink);line-height:1.7;padding-left:1.25rem;margin:0">';
      ai.reflection_questions.forEach(function(q){
        questionsHtml += '<li style="margin-bottom:.4rem">' + escapeHtml(q) + '</li>';
      });
      questionsHtml += '</ol></div>';
    }

    var khHtml = '';
    if(ai.knowledge_or_health_framing){
      khHtml = '<div style="margin-top:1.25rem;background:#eaf5ef;border:1px solid #b8e8ce;border-radius:8px;padding:1rem"><p style="font-size:.7rem;letter-spacing:.08em;color:#1a7a4a;text-transform:uppercase;margin:0 0 .4rem">A different framing</p><p style="font-size:.85rem;color:var(--ink);line-height:1.65;margin:0">' + escapeHtml(ai.knowledge_or_health_framing) + '</p></div>';
    }

    // Category badge
    var cat = ai.category_impact || 'neutral';
    var catLabel = cat === 'positive' ? '🟢 Investment in you'
                  : cat === 'negative' ? '🔴 Likely impulse'
                  : '🟡 General consumption';
    var catColor = cat === 'positive' ? '#1a7a4a'
                  : cat === 'negative' ? '#c0392b'
                  : '#d4840a';
    var catBg = cat === 'positive' ? '#eaf5ef'
                : cat === 'negative' ? '#fdf0ee'
                : '#fdf6e8';
    var catHtml = '<div style="margin-top:1.25rem;background:' + catBg + ';border:1px solid ' + catBg + ';border-radius:8px;padding:.85rem 1rem"><p style="font-size:.7rem;letter-spacing:.08em;color:' + catColor + ';text-transform:uppercase;margin:0 0 .4rem">Category</p><p style="font-size:.88rem;color:var(--ink);line-height:1.55;margin:0"><b>' + catLabel + '</b> — ' + escapeHtml(ai.category_reason || '') + '</p></div>';

    var equivalents = [
      { name: 'cups of coffee', price: 6 },
      { name: 'takeout lunches', price: 15 },
      { name: 'months of gym', price: 50 },
      { name: 'medical checkups', price: 200 }
    ];
    var equivHtml = '<div style="margin-top:1.25rem"><p style="font-size:.7rem;letter-spacing:.08em;color:var(--dim);text-transform:uppercase;margin:0 0 .5rem">Or you could spend it on...</p><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.5rem">';
    equivalents.forEach(function(e){
      if(price / e.price >= 1){
        var count = Math.floor(price / e.price);
        equivHtml += '<div style="background:var(--paper);border:1px solid var(--border);border-radius:6px;padding:.6rem .75rem;font-size:.78rem;color:var(--ink)">' + count + ' ' + e.name + '</div>';
      }
    });
    equivHtml += '</div></div>';

    var actionHtml = '<div style="display:flex;gap:.5rem;margin-top:1.5rem;flex-wrap:wrap">' +
      '<button onclick="window.RiskRunwayCalm.reset()" style="flex:1;min-width:140px;padding:.75rem;background:#fff;color:var(--ink);border:1px solid var(--border);border-radius:6px;font-size:.85rem;cursor:pointer;font-family:var(--sans)">Analyze another →</button>' +
      '<button onclick="window.RiskRunwayCalm.freeze(\'' + escapeAttr(name) + '\',' + price + ')" style="flex:1;min-width:140px;padding:.75rem;background:#fff;color:#0a66c2;border:1px solid #0a66c2;border-radius:6px;font-size:.85rem;cursor:pointer;font-family:var(--sans)">❄️ Freeze 72h</button>' +
      '</div>' +
      '<p style="font-size:.7rem;color:var(--dim);text-align:center;margin-top:1rem;line-height:1.5"><i>' + escapeHtml(ai.disclaimer || '') + '</i></p>';

    resultEl.innerHTML =
      '<div style="background:' + cs.bg + ';border:1px solid ' + cs.border + ';border-radius:8px;padding:1rem;margin-bottom:1rem;text-align:center">' +
        '<span style="display:inline-block;font-size:.7rem;letter-spacing:.1em;color:' + cs.text + ';font-weight:600;text-transform:uppercase">' + escapeHtml(ai.verdict_label || 'worth reflection') + '</span>' +
        '<p style="font-size:.95rem;color:var(--ink);margin:.4rem 0 0;line-height:1.5">' + escapeHtml(ai.summary || '') + '</p>' +
      '</div>' +
      (metricsHtml ? '<div style="display:flex;gap:.5rem;margin-bottom:1rem">' + metricsHtml + '</div>' : '') +
      '<div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:1rem">' +
        '<p style="font-size:.7rem;letter-spacing:.08em;color:var(--dim);text-transform:uppercase;margin:0 0 .5rem">What the numbers say</p>' +
        '<p style="font-size:.88rem;color:var(--ink);line-height:1.7;margin:0">' + escapeHtml(ai.neutral_analysis || '') + '</p>' +
      '</div>' +
      catHtml +
      questionsHtml +
      khHtml +
      equivHtml +
      actionHtml;
  }

  function reset(){
    if(!cfg) return;
    setView('input');
    el(cfg.itemNameId).value = '';
    el(cfg.itemPriceId).value = '';
    el(cfg.useMonthsId).value = '';
    el(cfg.reasonId).value = '';
    lastAnalysis = null;
    if(cfg.cardId){
      var card = el(cfg.cardId);
      if(card) window.scrollTo({ top: card.offsetTop - 80, behavior: 'smooth' });
    }
  }

  async function freeze(itemName, price){
    if(!confirm('Freeze this decision for 72 hours? You can come back and re-analyze after the cooling period.')) return;
    if(!lastAnalysis){
      // edge case: freeze called without a fresh analysis
      lastAnalysis = { ai: { objective_metrics: {} }, price: price, name: itemName, decisionId: genDecisionId() };
    }

    var runnerId = localStorage.getItem('rrRunner') || '#0000';
    var userEmail = localStorage.getItem('rrUserEmail');

    if(!userEmail){
      userEmail = prompt('Enter your email to receive a 72-hour reminder (optional, click Cancel to skip):');
      if(userEmail){
        userEmail = userEmail.trim();
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)){
          alert('Invalid email format. Skipping email reminder.');
          userEmail = null;
        } else {
          try{ localStorage.setItem('rrUserEmail', userEmail); }catch(e){}
        }
      }
    }

    if(userEmail){
      try {
        var apiBase = cfg.emailApi || EMAIL_API_DEFAULT;
        var res = await fetch(apiBase, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'calm_reminder',
            email: userEmail,
            itemName: itemName,
            price: price,
            runnerId: runnerId,
            decisionId: lastAnalysis.decisionId,
            lang: 'en'
          })
        });
        var data = await res.json();
        if(data.success){
          alert('Frozen. We\'ll email you a reminder in 72 hours.\n\nEmail: ' + userEmail + '\n\nWhen the email arrives, click "Report your decision" to tell us what you decided — and watch your runway update.');
        } else {
          alert('Frozen locally. (Email reminder could not be set: ' + (data.message||'unknown error') + ')');
        }
      } catch(err){
        console.error(err);
        alert('Frozen locally. (Email reminder failed due to network error)');
      }
    } else {
      alert('Frozen. Come back in 72 hours and re-analyze. You can use the tool again anytime.');
    }

    // Save the freeze to decisions log (pending)
    var decisions = loadDecisions();
    decisions.unshift({
      id: lastAnalysis.decisionId,
      name: itemName,
      price: price,
      category: (lastAnalysis.ai && lastAnalysis.ai.category_impact) || 'neutral',
      decision: 'pending',
      daysDelta: 0,
      frozenAt: Date.now()
    });
    // cap at 30 entries
    if(decisions.length > 30) decisions = decisions.slice(0, 30);
    saveDecisions(decisions);
  }

  // ── Record decision: 'bought' or 'held_off' ──
  // Returns: { ok, daysDelta, message }
  function recordDecision(decisionId, decision){
    var decisions = loadDecisions();
    var rec = null;
    for(var i=0;i<decisions.length;i++){
      if(decisions[i].id === decisionId){ rec = decisions[i]; break; }
    }
    if(!rec) return { ok: false, message: 'Decision record not found' };
    if(rec.decision !== 'pending') return { ok: false, message: 'Already recorded' };

    var ai = lastAnalysis && lastAnalysis.ai;
    var dailyExpense = lastAnalysis ? lastAnalysis.dailyExpense : 0;
    var delta = computeRunwayDelta(ai, rec.price, decision, dailyExpense);

    rec.decision = decision;
    rec.daysDelta = delta;
    rec.resolvedAt = Date.now();
    saveDecisions(decisions);
    applyDeltaToReportData(delta);

    return { ok: true, daysDelta: delta, message: 'Recorded' };
  }

  // ── Init the module with DOM ids for one card instance ──
  function init(options){
    cfg = {
      cardId:        options.cardId,
      inputAreaId:   options.inputAreaId   || 'calm-input-area',
      resultId:      options.resultId      || 'calm-result',
      loadingId:     options.loadingId     || 'calm-loading',
      rateInfoId:    options.rateInfoId    || 'calm-rate-info',
      daysPreviewId: options.daysPreviewId || 'calm-days-preview',
      itemNameId:    options.itemNameId    || 'calm-item-name',
      itemPriceId:   options.itemPriceId   || 'calm-item-price',
      useMonthsId:   options.useMonthsId   || 'calm-use-months',
      reasonId:      options.reasonId      || 'calm-buy-reason',
      submitBtnId:   options.submitBtnId   || 'calm-submit-btn',
      calmApi:       options.calmApi       || CALM_API_DEFAULT,
      emailApi:      options.emailApi      || EMAIL_API_DEFAULT
    };

    // wire submit button (if exists)
    var btn = el(cfg.submitBtnId);
    if(btn) btn.addEventListener('click', function(e){ e.preventDefault(); submit(); });

    // wire decision buttons (if exist on page)
    document.querySelectorAll('[data-decision-btn]').forEach(function(b){
      b.addEventListener('click', function(){
        var d = b.getAttribute('data-decision-btn');
        var id = b.getAttribute('data-decision-id') || (lastAnalysis && lastAnalysis.decisionId);
        if(!id){ alert('No active decision. Run an analysis first.'); return; }
        var r = recordDecision(id, d);
        if(r.ok){
          showDecisionResult(d, r.daysDelta);
        } else {
          alert(r.message);
        }
      });
    });

    updateRateInfo();
    // Update runway days preview if element exists
    if(cfg.daysPreviewId){
      var previewEl = el(cfg.daysPreviewId);
      if(previewEl){
        var ctx = getUserContext();
        if(ctx.runwayDays > 0) previewEl.textContent = ctx.runwayDays;
        else {
          var rh = document.getElementById('rh-days');
          if(rh) previewEl.textContent = rh.textContent.trim();
        }
      }
    }
  }

  function showDecisionResult(decision, daysDelta){
    var dEl = document.getElementById('decision-result');
    if(!dEl) return;
    var heldOff = decision === 'held_off';
    var positive = daysDelta > 0;
    var color = positive ? '#1a7a4a' : (daysDelta < 0 ? '#c0392b' : '#888');
    var bg = positive ? '#eaf5ef' : (daysDelta < 0 ? '#fdf0ee' : '#f5f4f0');
    var sign = daysDelta > 0 ? '+' : '';
    var title = heldOff
      ? (positive ? '🎉 You held off. +' + daysDelta + ' days back on your runway.' : 'You held off.')
      : (positive ? '✅ You bought it. +' + daysDelta + ' days runway (good choice).'
      : (daysDelta < 0 ? '🛒 Bought. -' + Math.abs(daysDelta) + ' days runway. We\'ll do better next time.'
      : '🛒 Bought. Neutral impact on runway.'));
    dEl.style.display = 'block';
    dEl.innerHTML =
      '<div style="background:' + bg + ';border:1px solid ' + bg + ';border-radius:8px;padding:1.25rem;text-align:center">' +
        '<p style="font-size:1.05rem;color:' + color + ';font-weight:500;margin:0 0 .4rem">' + escapeHtml(title) + '</p>' +
        '<p style="font-size:.82rem;color:#555;margin:0;line-height:1.55">Your runway number has been updated. Refresh the page to see the new value.</p>' +
      '</div>';
  }

  // ── public API ──
  window.RiskRunwayCalm = {
    init: init,
    submit: submit,
    reset: reset,
    freeze: freeze,
    updateRateInfo: updateRateInfo,
    recordDecision: recordDecision,
    // exposed helpers
    getDailyCount: getDailyCount,
    loadDecisions: loadDecisions,
    computeRunwayDelta: computeRunwayDelta
  };
})();
