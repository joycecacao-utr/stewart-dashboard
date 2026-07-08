#!/usr/bin/env node
// build-css-dashboard.js — reads css-data.json, writes css-stats-dashboard.html
// Run after fetch-css-data.js. Requires: npm install chart.js
// The output file is fully self-contained — no internet needed to open it.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── LOAD DEPENDENCIES ───────────────────────────────────────────────────────
function loadChartJs() {
  const candidates = [
    join(__dirname, 'node_modules/chart.js/dist/chart.umd.js'),
    '/tmp/node_modules/chart.js/dist/chart.umd.js',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error('chart.js not found. Run: npm install chart.js');
}

const dataPath = join(__dirname, 'css-data.json');
if (!existsSync(dataPath)) {
  console.error('css-data.json not found. Run fetch-css-data.js first.');
  process.exit(1);
}

const data    = JSON.parse(readFileSync(dataPath, 'utf8'));
const chartJs = loadChartJs();

// ─── PERIOD HELPERS ──────────────────────────────────────────────────────────
const monthly = data.monthly ?? {};
const now = new Date();

function moKey(d) { return d.toISOString().slice(0, 7); }

function offsetMo(months) {
  const d = new Date(now);
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  return moKey(d);
}

const CUR_MO  = moKey(now);
const PREV_MO = offsetMo(-1);
const PY_MO   = offsetMo(-12);

function ytdKeys() {
  const keys = [];
  for (let m = 0; m <= now.getMonth(); m++)
    keys.push(`${now.getFullYear()}-${String(m + 1).padStart(2, '0')}`);
  return keys;
}

function getM(key) { return monthly[key] ?? null; }

function sumMonths(keys) {
  const acc = {
    ticketsCreated: 0, ticketsResolved: 0,
    csatHappy: 0, csatTotal: 0,
    frtSum: 0, frtCount: 0,
    frt1Sum: 0, frt1Count: 0, frt2Sum: 0, frt2Count: 0,
    frt3Sum: 0, frt3Count: 0, frt4Sum: 0, frt4Count: 0,
    fcrResolved: 0, fcrEligible: 0,
    fcr2Resolved: 0, fcr2Eligible: 0,
    sessions: 0, engaged: 0, aiResolved: 0,
    aiDeflectPass: 0, aiDeflectFail: 0, aiDeflectNA: 0, aiEvaluated: 0,
    durSum: 0, durCount: 0,
    stewartTickets: 0, fcTickets: 0,
  };
  for (const k of keys) {
    const m = monthly[k];
    if (!m) continue;
    for (const key of Object.keys(acc)) acc[key] += m[key] ?? 0;
  }
  return acc;
}

const curMo  = getM(CUR_MO);
const prevMo = getM(PREV_MO);
const pyMo   = getM(PY_MO);
const ytd    = sumMonths(ytdKeys());

// ─── CSS SHEET METRICS HELPERS (Ticket Volume + CSAT from Google Sheet) ──────
const cssSheet        = data.cssSheetMetrics?.monthly ?? {};
function getSheet(key) { return cssSheet[key] ?? null; }

// YTD: sum ticket volumes / average CSAT across completed months in current year
function cssSheetYTD() {
  const keys = ytdKeys().filter(k => k !== CUR_MO); // exclude current month — not in sheet yet
  let totalTickets = 0, csatSum = 0, csatCount = 0;
  for (const k of keys) {
    const m = cssSheet[k];
    if (!m) continue;
    if (m.ticketVolume != null) totalTickets += m.ticketVolume;
    if (m.csat        != null) { csatSum += m.csat; csatCount++; }
  }
  return { ticketVolume: totalTickets || null, csat: csatCount ? csatSum / csatCount : null };
}
const cssYTD = cssSheetYTD();

function fmtSheetTick(key) {
  if (key === 'ytd') return cssYTD.ticketVolume != null ? cssYTD.ticketVolume.toLocaleString() : 'N/A';
  const m = getSheet(key);
  return m?.ticketVolume != null ? m.ticketVolume.toLocaleString() : 'N/A';
}
function fmtSheetCsat(key) {
  if (key === 'ytd') return cssYTD.csat != null ? cssYTD.csat.toFixed(1) + '%' : 'N/A';
  const m = getSheet(key);
  return m?.csat != null ? m.csat.toFixed(1) + '%' : 'N/A';
}

// ─── REVENUE RECOVERY HELPERS ────────────────────────────────────────────────
const rr        = data.revenueRecovery ?? null;
const rrMonthly = rr?.monthly ?? {};

function getRR(key) { return rrMonthly[key] ?? null; }

function sumRRMonths(keys) {
  let failed = 0, saved = 0, count = 0;
  for (const k of keys) {
    const m = rrMonthly[k];
    if (!m) continue;
    if (m.failed != null) failed += m.failed;
    if (m.saved  != null) saved  += m.saved;
    count++;
  }
  const total = saved + failed;
  return count > 0 ? { failed, saved, rate: total > 0 ? saved / total * 100 : null } : null;
}

const rrCur  = getRR(CUR_MO);
const rrPrev = getRR(PREV_MO);
const rrPY   = getRR(PY_MO);
const rrYTD  = sumRRMonths(ytdKeys());

function fmtDollar(n)   { return n != null ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A'; }
function fmtRate(m)     { return m?.rate  != null ? m.rate.toFixed(1) + '%'  : 'N/A'; }
function fmtFailed(m)   { return m?.failed != null ? fmtDollar(m.failed)     : 'N/A'; }
function fmtSaved(m)    { return m?.saved  != null ? fmtDollar(m.saved)      : 'N/A'; }
function fmtRRYTD(fn)   { return rrYTD ? fn(rrYTD) : 'N/A'; }

// ─── METRIC FORMATTERS ───────────────────────────────────────────────────────
const NA = 'N/A';

function pct(num, den)   { return (den && den > 0) ? ((num / den) * 100).toFixed(1) + '%' : NA; }
function avg(sum, count) { return (count && count > 0) ? (sum / count).toFixed(1) : NA; }
function dollar(n)       { return n != null ? '$' + n.toFixed(2) : NA; }
function num(n)          { return n != null ? n.toLocaleString() : NA; }

// AI resolution = Voiceflow "Deflection rate (strict)": Pass / (Pass + Fail), N/A excluded.
function aiResM(m)  { return m ? pct(m.aiDeflectPass, m.aiDeflectPass + m.aiDeflectFail) : NA; }
// Sessions and cost count engaged sessions only (exclude bounces).
function aiCostM(m) { return m ? dollar(m.engaged * data.vfCostPerSession) : NA; }
function sessM(m)   { return m ? num(m.engaged)                    : NA; }
function tickM(m)   { return m ? num(m.ticketsCreated)              : NA; }
function frtM(m)    { return m ? avg(m.frtSum, m.frtCount) + (m.frtCount ? 'h' : '') : NA; }
function frtPri(m, p) { return m ? avg(m[`frt${p}Sum`], m[`frt${p}Count`]) + (m[`frt${p}Count`] ? 'h' : '') : NA; }
function fcrM(m)    { return m ? pct(m.fcrResolved, m.fcrEligible)   : NA; }
function fcrM2(m)   { return m ? pct(m.fcr2Resolved, m.fcr2Eligible) : NA; }
function csatM(m)   { return m ? pct(m.csatHappy, m.csatTotal)      : NA; }
function durM(m)    { return m ? avg(m.durSum, m.durCount) + (m.durCount ? ' min' : '') : NA; }

// YTD derived
const ytdAiRes  = pct(ytd.aiDeflectPass, ytd.aiDeflectPass + ytd.aiDeflectFail);
const ytdAiCost = dollar(ytd.engaged * data.vfCostPerSession);
const ytdSess   = num(ytd.engaged);
const ytdTick   = num(ytd.ticketsCreated);
const ytdFrt    = avg(ytd.frtSum, ytd.frtCount) + (ytd.frtCount ? 'h' : '');
const ytdFcr    = pct(ytd.fcrResolved,  ytd.fcrEligible);
const ytdFcr2   = pct(ytd.fcr2Resolved, ytd.fcr2Eligible);
const ytdCsat   = pct(ytd.csatHappy, ytd.csatTotal);
const ytdDur    = avg(ytd.durSum, ytd.durCount) + (ytd.durCount ? ' min' : '');

// ─── CHART DATA — full 24-month series, sliced in-browser ────────────────────
function buildSeries(metric) {
  const labels = [], values = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(1); d.setMonth(d.getMonth() - i);
    const key = moKey(d);
    labels.push(d.toLocaleString('default', { month: 'short', year: '2-digit' }));
    const m = monthly[key];
    if (!m) { values.push(metric === 'aiRes' ? null : 0); continue; }
    if (metric === 'aiRes')    values.push(m.engaged > 0 ? +(m.aiResolved / m.engaged * 100).toFixed(1) : null);
    if (metric === 'sessions') values.push(m.fcTickets ?? 0);
  }
  return { labels, values };
}

// Ticket volume + CSAT from Google Sheet for the ticket correlation chart
function buildTicketCsatSeries() {
  const labels = [], ticketValues = [], csatValues = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(1); d.setMonth(d.getMonth() - i);
    const key = moKey(d);
    labels.push(d.toLocaleString('default', { month: 'short', year: '2-digit' }));
    const s = cssSheet[key];
    // The Google Sheet lags ~1 month, so the current month has no sheet row yet —
    // fall back to the Freshdesk-fetched volume for it (same fallback the table uses).
    let tv = s?.ticketVolume ?? null;
    if (tv == null && key === CUR_MO) tv = monthly[key]?.ticketsCreated ?? null;
    ticketValues.push(tv);
    csatValues.push(s?.csat ?? null);
  }
  return { labels, ticketValues, csatValues };
}

const allChartData = {
  sessions:   buildSeries('sessions'),
  ticketCsat: buildTicketCsatSeries(),
};

// ─── DATE LABELS ─────────────────────────────────────────────────────────────
const genDate  = new Date(data.generatedAt ?? now);
const dateLabel = genDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const curMoLabel  = now.toLocaleString('default', { month: 'long', year: 'numeric' });
const prevMoLabel = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  .toLocaleString('default', { month: 'long', year: 'numeric' });
const pyMoLabel   = new Date(now.getFullYear() - 1, now.getMonth(), 1)
  .toLocaleString('default', { month: 'long', year: 'numeric' });

// ─── HTML HELPERS ─────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function metricRow(label, cur, prev, ytdVal, py) {
  const pyCell = py === NA ? `<td class="na">N/A</td>` : `<td>${py}</td>`;
  return `<tr><td class="label">${label}</td><td class="cur">${cur}</td><td>${prev}</td><td>${ytdVal}</td>${pyCell}</tr>`;
}

// Row without the prior-year column (used where PY isn't relevant, e.g. AI Resolution).
function metricRowNoPy(label, cur, prev, ytdVal) {
  return `<tr><td class="label">${label}</td><td class="cur">${cur}</td><td>${prev}</td><td>${ytdVal}</td></tr>`;
}

function sectionHeader(num, title, tag = '') {
  const badge = tag ? `<span class="badge">${tag}</span>` : '';
  return `<div class="section-header"><span class="section-num">${num}</span><h2>${title}${badge}</h2></div>`;
}

function placeholderCard(label) {
  return `<div class="placeholder"><span class="coming-soon">Coming soon</span><p>${label}</p></div>`;
}

// ─── SECTION BUILDERS ────────────────────────────────────────────────────────
function buildChurn() {
  return `
<section id="s1">
  ${sectionHeader('01', 'Churn')}
  <div class="coming-soon-section">
    <div class="cs-icon">⏳</div>
    <div class="cs-label">Churnkey integration in progress</div>
    <div class="cs-sub">Cancel-flow data will appear here once Churnkey is live</div>
    <div class="placeholder-grid">
      ${placeholderCard('# entered cancel flow')}
      ${placeholderCard('% and # who stayed')}
      ${placeholderCard('# cancelled')}
    </div>
    <div class="placeholder-wide">
      <div class="ph-label">Survey response chart</div>
    </div>
    <div class="placeholder-wide">
      <div class="ph-label">AI-generated suggestion summary (2 sentences)</div>
    </div>
  </div>
</section>`;
}

function buildAiResolution() {
  const heroVal = aiResM(curMo);
  return `
<section id="s2">
  ${sectionHeader('02', 'AI Resolution')}
  <p class="definition">"Interactions where AI fully solved or answered the user's inquiry"</p>
  <div class="ai-hero">
    <div class="ai-hero-number">${heroVal}</div>
    <div class="ai-hero-label">AI Resolution Rate &mdash; ${curMoLabel} MTD</div>
  </div>
  <div class="table-wrap">
    <table class="metrics-table">
      <thead>
        <tr>
          <th>Metric</th>
          <th>${curMoLabel} (MTD)</th>
          <th>${prevMoLabel}</th>
          <th>YTD</th>
        </tr>
      </thead>
      <tbody>
        ${metricRowNoPy('AI Resolution %',  aiResM(curMo),  aiResM(prevMo),  ytdAiRes)}
        ${metricRowNoPy('Engaged Sessions <span class="rr-tooltip" title="Conversations with real interaction — total Voiceflow sessions minus bounces">ⓘ</span>', sessM(curMo), sessM(prevMo), ytdSess)}
        ${metricRowNoPy('AI Cost',          aiCostM(curMo), aiCostM(prevMo), ytdAiCost)}
      </tbody>
    </table>
  </div>
  <p style="font-size:11px;color:var(--muted);margin-top:8px;">Abandoned chats — where the user left before a clear resolution or handoff — are excluded from the AI Resolution % calculation.</p>
</section>`;
}

function buildAAU() {
  return `
<section id="s3">
  ${sectionHeader('03', 'AAU — AI Assisted Upselling')}
  <div class="coming-soon-section">
    <div class="cs-icon">🔜</div>
    <div class="cs-label">Results expected in 1–2 weeks</div>
    <div class="cs-sub">This section will show AI-assisted upselling conversions and revenue impact</div>
  </div>
</section>`;
}

function buildRevenueRecovery() {
  const lastUpdated = rr?.lastUpdated ? `<span class="rr-updated">Stripe data as of ${rr.lastUpdated}</span>` : '';

  // YTD rate: calculated from YTD saved / YTD failed
  const ytdRateStr = rrYTD?.rate != null ? rrYTD.rate.toFixed(1) + '%' : 'N/A';

  // Stripe Revenue-Recovery data lags ~1 month, so the current month is always
  // empty — omit the current-month (MTD) column entirely. The most recent real
  // month (previous month) gets the emphasized "cur" styling instead.
  const rrRow = (label, prev, ytdVal, py) => {
    const pyCell = py === NA ? `<td class="na">N/A</td>` : `<td>${py}</td>`;
    return `<tr><td class="label">${label}</td><td class="cur">${prev}</td><td>${ytdVal}</td>${pyCell}</tr>`;
  };
  const tableRows = [
    rrRow('Recovery Rate %',
      fmtRate(rrPrev), ytdRateStr, fmtRate(rrPY)),
    rrRow('Total Saved',
      fmtSaved(rrPrev), fmtRRYTD(m => fmtDollar(m.saved)), fmtSaved(rrPY)),
    rrRow('Total Failed',
      fmtFailed(rrPrev), fmtRRYTD(m => fmtDollar(m.failed)), fmtFailed(rrPY)),
  ].join('');

  const unrecov     = rr?.unrecoveredRevenue;
  const unrecovInv  = rr?.unrecoveredInvoices;
  const recov       = rr?.recoveredRevenue;
  const recovInv    = rr?.recoveredInvoices;
  const invSub      = n => n != null ? n.toLocaleString() + ' invoices' : 'Current';

  const statCards = `
  <div class="rr-stat-grid">
    <div class="rr-stat-card">
      <div class="rr-stat-label">
        Unrecovered Revenue
        <span class="rr-tooltip" title="Payment failures that have exhausted recovery attempts">ⓘ</span>
      </div>
      <div class="rr-stat-value">${unrecov != null ? fmtDollar(unrecov) : 'N/A'}</div>
      <div class="rr-stat-sub">${invSub(unrecovInv)}</div>
    </div>
    <div class="rr-stat-card">
      <div class="rr-stat-label">
        Recovered Revenue
        <span class="rr-tooltip" title="Payment failures successfully recovered">ⓘ</span>
      </div>
      <div class="rr-stat-value">${recov != null ? fmtDollar(recov) : 'N/A'}</div>
      <div class="rr-stat-sub">${invSub(recovInv)}</div>
    </div>
  </div>`;

  return `
<section id="s4">
  ${sectionHeader('04', 'Revenue Recovery')}
  ${lastUpdated}
  <div class="table-wrap">
    <table class="metrics-table">
      <thead>
        <tr><th>Metric</th><th>${prevMoLabel}</th><th>YTD</th><th>${pyMoLabel}</th></tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>
  ${statCards}
</section>`;
}

function buildVolumeResponse() {
  const frtPriRows = [1, 2, 3, 4].map(p => {
    const pn = data.priorityNames?.[p] ?? `Priority ${p}`;
    return metricRow(
      `First Response Time — ${pn}`,
      frtPri(curMo, p), frtPri(prevMo, p),
      avg(ytd[`frt${p}Sum`], ytd[`frt${p}Count`]) + (ytd[`frt${p}Count`] ? 'h' : ''),
      frtPri(pyMo, p)
    );
  }).join('');

  return `
<section id="s5">
  ${sectionHeader('05', 'Volume & Response Time')}

  <h3 class="sub-heading">Freshchat</h3>
  <div class="table-wrap">
    <table class="metrics-table">
      <thead>
        <tr><th>Metric</th><th>${curMoLabel} (MTD)</th><th>${prevMoLabel}</th><th>YTD</th><th>${pyMoLabel}</th></tr>
      </thead>
      <tbody>
        ${metricRow('Chat Volume (Freshchat)',   num(curMo?.fcTickets),  num(prevMo?.fcTickets),  num(ytd.fcTickets), num(pyMo?.fcTickets))}
      </tbody>
    </table>
  </div>
  <div class="chart-wrap">
    <canvas id="sessionChart" height="120"></canvas>
  </div>

  <h3 class="sub-heading">Tickets — Freshdesk</h3>
  <div class="priority-legend">
    <span class="pl-label">Priority:</span>
    <span class="pl-item">🔴 Urgent</span>
    <span class="pl-item">🟠 High</span>
    <span class="pl-item">🟡 Medium</span>
    <span class="pl-item">🟢 Low</span>
    <span class="prio-info" tabindex="0" role="img" aria-label="Priority definitions">ⓘ
      <span class="prio-tooltip">
        <span class="pt-row"><b>🔴 Urgent</b> — Freshchat conversations converted to ticket, merge requests from UTR employees, and customers canceling their Power subscription who reached out directly to success@</span>
        <span class="pt-row"><b>🟠 High</b> — Power users, VIP clubs, and HS accounts</span>
        <span class="pt-row"><b>🟡 Medium</b> — Free users</span>
        <span class="pt-row"><b>🟢 Low</b> — Missing scores or direct emails to success@</span>
      </span>
    </span>
  </div>
  <div class="table-wrap">
    <table class="metrics-table">
      <thead>
        <tr><th>Metric</th><th>${curMoLabel} (MTD)</th><th>${prevMoLabel}</th><th>YTD</th><th>${pyMoLabel}</th></tr>
      </thead>
      <tbody>
        ${metricRow('Ticket Volume',            fmtSheetTick(CUR_MO) !== 'N/A' ? fmtSheetTick(CUR_MO) : (curMo ? tickM(curMo) : '0'), fmtSheetTick(PREV_MO), fmtSheetTick('ytd'), fmtSheetTick(PY_MO))}
        ${frtPriRows}
        ${metricRow('First Contact Resolution', fcrM(curMo),   fcrM(prevMo),   ytdFcr,  fcrM(pyMo))}
        ${metricRow('FCR — Medium Priority',    fcrM2(curMo),  fcrM2(prevMo),  ytdFcr2, fcrM2(pyMo))}
        ${metricRow('Controllable CSAT',        fmtSheetCsat(CUR_MO) !== 'N/A' ? fmtSheetCsat(CUR_MO) : csatM(curMo), fmtSheetCsat(PREV_MO), fmtSheetCsat('ytd'), fmtSheetCsat(PY_MO))}
      </tbody>
    </table>
    ${(data.sampledMonths ?? []).length > 0 ? `<p style="font-size:11px;color:var(--muted);margin-top:4px;">* ${data.sampledMonths.join(', ')} FRT/FCR based on sample (500-ticket cap)</p>` : ''}
    <p class="metric-defs">
      <b>First Response Time</b> — how quickly the team replied to the customer.<br>
      <b>First Contact Resolution</b> — whether the issue was fully resolved in the first interaction, without the customer needing to follow up.
    </p>
  </div>
  <div class="chart-wrap">
    <canvas id="ticketChart" height="120"></canvas>
  </div>
</section>`;
}

function buildHappyThoughts() {
  const quotes = data.happyThoughts ?? [];
  const cards = quotes.length > 0
    ? quotes.map(q => `
      <div class="quote-card">
        <div class="quote-mark">&ldquo;</div>
        <blockquote>${q.quote}</blockquote>
        <div class="quote-context">${q.context ?? ''}</div>
      </div>`).join('')
    : `<p class="empty-state">No 5-star CSAT comments found in this period.</p>`;

  return `
<section id="s6">
  ${sectionHeader('06', 'Happy Thoughts')}
  <div class="quotes-grid">
    ${cards}
  </div>
</section>`;
}

// Curated first-person "collective voice" per persona — synthesized from real
// transcripts (reviewed for authenticity; not auto-generated each run).
const PERSONA_VOICE = {
  'Club customers': {
    quote: "Running an event is nonstop — draws, courts, registrations, a dozen little fires at once. The thing that actually eats my time is tracking down results from outside tournaments that never make it onto our players' profiles. When a match is missing, the parents come to me about it — not the tournament that dropped the ball.",
    themes: 'Running tournaments · missing matches from outside sources · registration · email opt-out',
  },
  'Power subscribers': {
    quote: "I pay for this, so it stings when a match doesn't count or my rating slides for no reason I can see. My UTR is how I know whether I'm improving — if I can't trust the number, what am I even paying for?",
    themes: 'Missing scores despite paying · sudden rating drops · wanting a human · ticket follow-up',
  },
  'College': {
    quote: "Most of my season is dual matches, and those are exactly the results that decide where I sit against everyone else. When they don't post, my rating undersells how I'm actually playing — and at this level, coaches and opponents notice that gap.",
    themes: 'Profile merges from name variants · missing college dual-match scores',
  },
  'High school': {
    quote: "Matches start this afternoon and I'm still wrestling the bracket. Courts won't assign, the draw won't lock, and there's no 'we'll sort it tomorrow' — the kids are already warming up. When the clock's running, I just need it to hold together.",
    themes: 'Time-pressured event setup · court & draw issues · missing HS matches · claiming a school',
  },
  'Parents': {
    quote: "I've got two playing, so I'm the one keeping the whole picture straight — their matches, who they've beaten, what's coming up next weekend. What throws me is when a result shows up under some second profile I never made, and suddenly their record looks half as full as it really is. I just want everything they've worked for in one place.",
    themes: "Kids' duplicate-profile merges · DOB corrections · multiple children",
  },
  'Free users': {
    quote: "Honestly, I'm still figuring out how all of this works — mostly I just want my matches to show up and to understand what my number actually means. When results I know I played aren't there, it makes me second-guess the whole thing before I'd ever think about paying for more.",
    themes: 'Learning how ratings work · matches not showing · what the number means · weighing whether to upgrade',
  },
};

// Volume share + trend from rolling windows (last 30d vs prior 30d).
function personaStat(name) {
  const pw = data.personaWindow;
  const cur = pw?.cur;
  if (!cur || cur[name] == null) return null;             // no counts available
  const count = cur[name] || 0;
  const total = cur._total || 0;
  const share = total > 0 ? Math.round((count / total) * 100) : null;
  const prevCount = pw.prev?.[name];
  let trend;
  if (count === 0) trend = null;                          // shown as "no chats this period"
  else if (prevCount == null || prevCount === 0) trend = { glyph: '↑', text: 'new', dir: 'up' };
  else {
    const pct = Math.round(((count - prevCount) / prevCount) * 100);
    trend = { glyph: pct > 0 ? '↑' : pct < 0 ? '↓' : '→', text: Math.abs(pct) + '%', dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
  }
  return { count, share, trend };
}

// Minimum contacts in the current window for a trend % to be meaningful. Below
// this, a ↑/↓ would swing wildly on a handful of chats, so we suppress it.
const MIN_PERSONA_TREND = 10;

function personaMeta(name) {
  const st = personaStat(name);
  if (!st) return '';
  if (st.count === 0) {
    return `<span class="persona-meta">· 0% of contacts (0) · <span class="persona-trend pt-flat">no chats this period</span></span>`;
  }
  const base = `· ${st.share}% of contacts (${st.count})`;
  const trend = (st.count >= MIN_PERSONA_TREND && st.trend)
    ? ` · <span class="persona-trend pt-${st.trend.dir}">${st.trend.glyph} ${st.trend.text}</span>`
    : ` · <span class="persona-trend pt-flat">trend n/a · low volume</span>`;
  return `<span class="persona-meta">${base}${trend}</span>`;
}

function buildPersonaSentiment() {
  const personas = ['Club customers', 'Power subscribers', 'College', 'High school', 'Parents', 'Free users'];
  const cards = personas.map(name => {
    const v = PERSONA_VOICE[name];
    if (!v) return '';
    return `
    <div class="persona-card">
      <div class="persona-top"><span class="persona-name">${name}</span>${personaMeta(name)}</div>
      <blockquote class="persona-summary">&ldquo;${v.quote}&rdquo;</blockquote>
      <div class="persona-themes">${escHtml(v.themes)}</div>
    </div>`;
  }).join('');

  return `
<section id="s7">
  ${sectionHeader('07', 'Persona Sentiment')}
  <p class="section-note">The collective voice of each customer segment — what they appreciate and what they want improved.</p>
  <div class="persona-grid">
    ${cards}
  </div>
  <p class="metric-defs">
    <b>% of contacts (n)</b> — this segment's share of engaged chats over the last 30 days, with the raw count.
    <b>Trend arrow</b> — change in chat volume vs the prior 30 days (↑ rising · ↓ falling · → flat); shown only for
    segments with at least ${MIN_PERSONA_TREND} chats, since smaller segments swing on a handful of contacts (marked <i>low volume</i>).
    Segments are inferred from chat content, so not every chat maps to one and shares don't total 100%.
  </p>
</section>`;
}

const VF_PROJECT_ID = '69ebd4159a532921bd258f8d';

function buildInteractionExamples() {
  const examples = data.interactionExamples ?? [];

  if (examples.length === 0) {
    return `
<section id="s8">
  ${sectionHeader('08', 'Interaction Examples')}
  <p class="section-note">Real live-chat interactions with Stewart</p>
  <p class="empty-state">No Voiceflow transcripts found for this period.</p>
</section>`;
  }

  const clip = (s, n) => { s = (s ?? '').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
  const richClip = (s, n) => escHtml(clip(s, n)).replace(/\n+/g, '<br>');

  // Lightweight topic tag derived from the customer's first message.
  function topicTag(text) {
    const t = (text ?? '').toLowerCase();
    if (/\b(match|utr|rating|result|score)\b/.test(t)) return 'Match & Rating';
    if (/duplicate/.test(t)) return 'Duplicate Profile';
    if (/(profile|location|residence|spelled|date of birth|dob|birthday|\bname\b|gender)/.test(t)) return 'Profile Update';
    if (/(subscription|billing|payment|refund|charge|invoice|power|renew|cancel)/.test(t)) return 'Billing';
    if (/(log ?in|login|account|password|email|sign ?in|verify)/.test(t)) return 'Account Access';
    if (/(club|event|tournament|league|\bteam\b)/.test(t)) return 'Events & Clubs';
    return 'General Support';
  }

  // Show 2 interactions, preferring a resolved + escalated mix.
  const firstEsc = examples.find(e => !e.resolved);
  const firstRes = examples.find(e => e.resolved);
  const chosen = (firstEsc && firstRes) ? [firstEsc, firstRes] : examples.slice(0, 2);
  const vms = chosen.map((ex, i) => {
    const turns = (ex.turns ?? []).filter(t => (t.text ?? '').trim());
    const userTurns = turns.filter(t => t.role === 'user');
    const aiTurns   = turns.filter(t => t.role === 'ai');
    const question  = (userTurns[0]?.text ?? turns[0]?.text ?? '').trim();
    const lastAi    = (aiTurns[aiTurns.length - 1]?.text ?? '').trim();
    const date = ex.date ? new Date(ex.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const vfUrl = ex.transcriptId ? `https://creator.voiceflow.com/project/${VF_PROJECT_ID}/transcripts/${ex.transcriptId}` : null;
    const outcome = ex.resolved
      ? { icon: '✅', label: 'Resolved',  cls: 'resolved' }
      : { icon: '⚡', label: 'Escalated', cls: 'escalated' };
    return { i, turns, userTurns, aiTurns, question, lastAi, date, vfUrl, outcome, topic: topicTag(question) };
  });

  const vfLink = vm => vm.vfUrl
    ? `<a class="transcript-link" href="${vm.vfUrl}" target="_blank" rel="noopener">View full transcript in Voiceflow ↗</a>`
    : '';
  const badge = vm => `<span class="ie-badge ${vm.outcome.cls}">${vm.outcome.icon} ${vm.outcome.label}</span>`;
  const tag   = vm => `<span class="ie-topic">${escHtml(vm.topic)}</span>`;

  // Mini Transcript — key exchanges by default, expandable to the full conversation.
  const miniLine = (t, n) => `
        <div class="ie-mini-line">
          <span class="ie-mini-who ${t.role}">${t.role === 'ai' ? 'Stewart' : 'User'}</span>
          <span class="ie-mini-text">${n ? richClip(t.text, n) : escHtml(t.text).replace(/\n+/g, '<br>')}</span>
        </div>`;
  const cards = vms.map(vm => {
    let picked = vm.turns.slice(0, 4);
    const last = vm.turns[vm.turns.length - 1];
    if (last && !picked.includes(last)) picked = [...vm.turns.slice(0, 3), last];
    const canExpand = vm.turns.length > picked.length;
    return `
    <div class="ie-card">
      <div class="ie-card-head ie-head-d">${tag(vm)}${badge(vm)}<span class="ie-date">${vm.date}</span></div>
      <div class="ie-mini ie-mini-preview">
        ${picked.map(t => miniLine(t, 220)).join('')}
        ${canExpand ? `<button class="ie-toggle" type="button" data-ie-expand>Show full conversation (${vm.turns.length} messages) ▾</button>` : ''}
      </div>
      ${canExpand ? `
      <div class="ie-mini ie-mini-full" hidden>
        ${vm.turns.map(t => miniLine(t, 0)).join('')}
        <button class="ie-toggle" type="button" data-ie-collapse>Hide full conversation ▴</button>
      </div>` : ''}
      <div class="ie-card-foot">${vfLink(vm)}</div>
    </div>`;
  }).join('');

  return `
<section id="s8">
  ${sectionHeader('08', 'Interaction Examples')}
  <p class="section-note">Real live-chat interactions with Stewart — a mix of resolved and escalated</p>
  <div class="ie-grid cols">${cards}</div>
  <script>
  (function(){
    var sec = document.getElementById('s8');
    sec.querySelectorAll('[data-ie-expand]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var card = btn.closest('.ie-card');
        card.querySelector('.ie-mini-preview').hidden = true;
        card.querySelector('.ie-mini-full').hidden = false;
      });
    });
    sec.querySelectorAll('[data-ie-collapse]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var card = btn.closest('.ie-card');
        card.querySelector('.ie-mini-full').hidden = true;
        card.querySelector('.ie-mini-preview').hidden = false;
      });
    });
  })();
  </script>
</section>`;
}

// ─── INLINE CHART INIT ───────────────────────────────────────────────────────
const chartInitJs = `
(function() {
  const CYAN        = '#4DD9E8';
  const CYAN_FAINT  = 'rgba(77,217,232,0.15)';
  const BLUE        = '#3B8BEB';
  const BLUE_FAINT  = 'rgba(59,139,235,0.15)';
  const GRID        = '#e2e4e7';
  const TICK        = '#6b7280';

  const ALL = ${JSON.stringify(allChartData)};

  function slice(series, n) {
    return { labels: series.labels.slice(-n), values: series.values.slice(-n) };
  }
  function sliceTicketCsat(series, n) {
    return {
      labels:       series.labels.slice(-n),
      ticketValues: series.ticketValues.slice(-n),
      csatValues:   series.csatValues.slice(-n),
    };
  }
  function makeTicketCsatChart(id, series) {
    const el = document.getElementById(id);
    if (!el) return null;
    return new Chart(el, {
      type: 'bar',
      data: {
        labels: series.labels,
        datasets: [
          {
            type: 'bar',
            label: 'Ticket Volume',
            data: series.ticketValues,
            backgroundColor: BLUE,
            yAxisID: 'yTickets',
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ctx.parsed.y != null ? 'Ticket Volume: ' + ctx.parsed.y.toLocaleString() : 'N/A',
            },
          },
        },
        scales: {
          x: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 13 } } },
          yTickets: {
            type: 'linear', position: 'left',
            grid: { color: GRID }, ticks: { color: TICK, font: { size: 13 } },
            suggestedMin: 0,
            title: { display: true, text: 'Ticket Volume', color: TICK, font: { size: 11 } },
          },
        },
      },
    });
  }

  const RANGES = { '1mo': 1, '3mo': 3, '6mo': 6, '12mo': 12, '24mo': 24 };
  let activeRange = '24mo';
  const charts = {};

  const axisOpts = {
    x: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 13 } } },
    y: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 13 } }, suggestedMin: 0 },
  };

  function makeLineChart(id, series, suffix, color, faint) {
    const el = document.getElementById(id);
    if (!el) return null;
    return new Chart(el, {
      type: 'line',
      data: {
        labels: series.labels,
        datasets: [{ data: series.values, borderColor: color, backgroundColor: faint,
          borderWidth: 3, pointRadius: 4, pointHoverRadius: 6,
          fill: true, tension: 0.3, spanGaps: true }],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ctx.parsed.y != null ? ctx.parsed.y + suffix : 'N/A' } },
        },
        scales: axisOpts,
      },
    });
  }

  function makeBarChart(id, series, color, faint) {
    const el = document.getElementById(id);
    if (!el) return null;
    return new Chart(el, {
      type: 'bar',
      data: {
        labels: series.labels,
        datasets: [{ data: series.values, backgroundColor: color, borderRadius: 4, borderSkipped: false }],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: TICK, font: { size: 13 } } },
          y: { grid: { color: GRID },    ticks: { color: TICK, font: { size: 13 } }, suggestedMin: 0 },
        },
      },
    });
  }

  function initCharts(n) {
    ['sessionChart', 'ticketChart'].forEach(id => {
      if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    });
    charts.sessionChart = makeBarChart( 'sessionChart', slice(ALL.sessions, n), CYAN);
    charts.ticketChart  = makeTicketCsatChart('ticketChart', sliceTicketCsat(ALL.ticketCsat, n));
  }

  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeRange = btn.dataset.range;
      initCharts(RANGES[activeRange]);
    });
  });

  initCharts(RANGES[activeRange]);
})();
`;

// ─── CSS ─────────────────────────────────────────────────────────────────────
const css = `
  :root {
    --bg:       #ffffff;
    --card:     #f8f9fa;
    --card2:    #f1f3f5;
    --border:   #e2e4e7;
    --ink:      #111111;
    --muted:    #6b7280;
    --cyan:     #4DD9E8;
    --blue:     #3B8BEB;
    --green:    #16a34a;
    --red:      #dc2626;
    --radius:   12px;
    --gradient: linear-gradient(135deg, #4DD9E8, #3B8BEB);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 17px;
    line-height: 1.6;
  }

  /* Header */
  .dashboard-header {
    background: #ffffff;
    border-bottom: 1px solid var(--border);
    padding: 20px 48px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 24px;
    position: sticky; top: 0; z-index: 10;
  }
  .logo-area { display: flex; align-items: center; gap: 16px; }
  .logo-area img { height: 48px; width: auto; display: block; }
  .logo-wordmark {
    font-size: 15px; font-weight: 700; letter-spacing: 0.5px;
    color: var(--ink);
  }
  .logo-wordmark span {
    display: block; font-size: 11px; font-weight: 500;
    background: var(--gradient); -webkit-background-clip: text;
    -webkit-text-fill-color: transparent; background-clip: text;
    letter-spacing: 1px;
  }
  .dashboard-meta { font-size: 14px; color: var(--muted); text-align: right; }
  .dashboard-meta strong { color: var(--ink); display: block; font-size: 15px; }

  /* Layout */
  main { max-width: 1280px; margin: 0 auto; padding: 40px 48px; display: flex; flex-direction: column; gap: 36px; }

  section {
    background: var(--card);
    border-radius: var(--radius);
    border: 1px solid var(--border);
    padding: 36px 40px;
  }

  /* Section header */
  .section-header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
  .section-num {
    font-size: 12px; font-weight: 800; letter-spacing: 1.5px;
    background: var(--gradient); -webkit-background-clip: text;
    -webkit-text-fill-color: transparent; background-clip: text;
    flex-shrink: 0;
  }
  .section-header h2 {
    font-size: 22px; font-weight: 700; color: var(--ink);
    display: flex; align-items: center; gap: 12px;
    background: var(--gradient); -webkit-background-clip: text;
    -webkit-text-fill-color: transparent; background-clip: text;
  }
  .badge {
    font-size: 12px; font-weight: 600; color: var(--muted);
    background: var(--card2); border: 1px solid var(--border);
    border-radius: 20px; padding: 3px 12px;
    -webkit-text-fill-color: var(--muted);
  }

  /* AI Resolution hero number */
  .ai-hero { text-align: center; padding: 28px 0 40px; }
  .ai-hero-number {
    font-size: clamp(56px, 8vw, 96px); font-weight: 900; line-height: 1;
    white-space: nowrap;
    background: var(--gradient); -webkit-background-clip: text;
    -webkit-text-fill-color: transparent; background-clip: text;
    margin-bottom: 10px;
  }
  .ai-hero-label {
    font-size: 13px; font-weight: 700; color: var(--muted);
    text-transform: uppercase; letter-spacing: 1.2px; white-space: nowrap;
  }

  .definition {
    font-size: 15px; color: var(--muted); font-style: italic;
    border-left: 2px solid var(--cyan); padding-left: 14px;
    margin-bottom: 24px;
  }
  .section-note { font-size: 15px; color: var(--muted); margin-bottom: 20px; }
  .sub-heading {
    font-size: 16px; font-weight: 700; letter-spacing: 0.5px;
    color: var(--cyan); margin: 32px 0 16px; text-transform: uppercase;
  }
  .sub-heading:first-of-type { margin-top: 0; }

  /* Priority legend + info tooltip (single icon on the legend line) */
  .priority-legend { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin: -8px 0 16px; font-size: 14px; color: var(--ink); }
  .pl-label { font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; font-size: 12px; }
  .pl-item { display: inline-flex; align-items: center; gap: 4px; }
  .prio-info { position: relative; cursor: help; color: var(--muted); font-size: 15px; line-height: 1; outline: none; }
  .prio-tooltip {
    display: none; position: absolute; left: 0; top: 26px; z-index: 30;
    width: 380px; max-width: 86vw; background: #1f2937; color: #fff;
    border-radius: 8px; padding: 12px 14px; font-size: 13px; line-height: 1.5;
    box-shadow: 0 8px 28px rgba(0,0,0,0.28); font-weight: 400; text-transform: none; letter-spacing: 0;
  }
  .prio-tooltip .pt-row { display: block; margin-bottom: 8px; }
  .prio-tooltip .pt-row:last-child { margin-bottom: 0; }
  .prio-tooltip b { color: #fff; font-weight: 700; }
  .prio-info:hover .prio-tooltip, .prio-info:focus .prio-tooltip { display: block; }

  /* Plain-language metric definitions footnote */
  .metric-defs { font-size: 13px; color: var(--muted); line-height: 1.7; margin-top: 10px; }
  .metric-defs b { color: var(--ink); font-weight: 700; }

  /* Metrics table */
  .table-wrap { overflow-x: auto; margin-bottom: 28px; }
  .metrics-table { width: 100%; border-collapse: collapse; font-size: 16px; }
  .metrics-table th {
    background: var(--card2); color: var(--muted);
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
    padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border);
  }
  .metrics-table td { padding: 14px 16px; border-bottom: 1px solid var(--border); color: var(--ink); }
  .metrics-table tr:last-child td { border-bottom: none; }
  .metrics-table tr:hover td:not(.cur) { background: rgba(255,255,255,0.02); }
  .metrics-table td.label { font-weight: 500; color: var(--muted); font-size: 15px; }
  .metrics-table td.cur {
    font-weight: 800; font-size: 20px;
    background: var(--gradient); -webkit-background-clip: text;
    -webkit-text-fill-color: transparent; background-clip: text;
  }
  .metrics-table td.na { color: #2a2a2a; }

  /* Charts */
  .chart-wrap { padding: 8px 0 4px; }

  /* Coming soon sections */
  .coming-soon-section {
    text-align: center; padding: 40px 20px;
    border: 1px dashed var(--border); border-radius: var(--radius);
  }
  .coming-soon-section.light { padding: 20px; margin-bottom: 24px; }
  .cs-icon { font-size: 32px; margin-bottom: 12px; }
  .cs-label {
    font-size: 18px; font-weight: 700; margin-bottom: 8px;
    background: var(--gradient); -webkit-background-clip: text;
    -webkit-text-fill-color: transparent; background-clip: text;
  }
  .cs-sub { font-size: 15px; color: var(--muted); margin-bottom: 28px; }

  .placeholder-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 16px; }
  .placeholder { background: var(--card2); border: 1px dashed var(--border); border-radius: 8px; padding: 20px; text-align: center; }
  .placeholder p { font-size: 14px; color: var(--muted); }
  .coming-soon {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px;
    background: var(--gradient); -webkit-background-clip: text;
    -webkit-text-fill-color: transparent; background-clip: text;
    display: block; margin-bottom: 6px;
  }
  .placeholder-wide {
    background: var(--card2); border: 1px dashed var(--border); border-radius: 8px;
    padding: 20px; text-align: center; margin-bottom: 12px;
  }
  .placeholder-wide:last-child { margin-bottom: 0; }
  .ph-label { font-size: 14px; color: var(--muted); }

  /* Happy Thoughts */
  .quotes-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px; }
  .quote-card {
    background: var(--card2); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 28px 28px 24px;
    border-top: 2px solid var(--cyan);
  }
  .quote-mark {
    font-size: 52px; line-height: 1; margin-bottom: 8px; opacity: 0.5;
    background: var(--gradient); -webkit-background-clip: text;
    -webkit-text-fill-color: transparent; background-clip: text;
  }
  .quote-card blockquote { font-size: 19px; line-height: 1.6; color: var(--ink); font-style: italic; margin-bottom: 14px; }
  .quote-context { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; }

  /* Persona Sentiment */
  .persona-grid { display: flex; flex-direction: column; gap: 14px; }
  .persona-card {
    background: var(--card2); border: 1px solid var(--border);
    border-radius: 8px; padding: 20px 24px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .persona-top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .persona-name {
    font-size: 15px; font-weight: 700;
    background: var(--gradient); -webkit-background-clip: text;
    -webkit-text-fill-color: transparent; background-clip: text;
  }
  /* Volume/trend support the quote — subtle, never competing with it. */
  .persona-meta { font-size: 13px; color: var(--muted); font-weight: 500; }
  .persona-trend { font-weight: 700; }
  /* Gentle, non-alarming hints — rising volume isn't 'good' or 'bad', just notable */
  .persona-trend.pt-up   { color: #3b82c4; }   /* soft blue */
  .persona-trend.pt-down { color: #b08035; }   /* soft amber */
  .persona-trend.pt-flat { color: #94a3b8; }   /* muted gray */
  .persona-summary { font-size: 19px; color: var(--ink); font-style: italic; line-height: 1.6; margin: 0; }
  .persona-themes { font-size: 12.5px; color: var(--muted); }

  /* Interaction Examples — shared shell */
  .tag { font-size: 12px; font-weight: 600; border-radius: 20px; padding: 2px 10px; }
  .tag.resolved { background: rgba(34,197,94,0.12); color: var(--green); }
  .tag.escalated { background: rgba(239,68,68,0.12); color: var(--red); }
  .transcript-link { font-size: 13px; font-weight: 600; color: var(--cyan); text-decoration: none; }
  .transcript-link:hover { text-decoration: underline; }

  /* Card shell */
  .ie-grid { display: grid; gap: 22px; }
  .ie-grid.cols { grid-template-columns: repeat(auto-fit, minmax(370px, 1fr)); }
  .ie-card { background: var(--card2); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .ie-card-head { display: flex; align-items: center; gap: 10px; padding: 13px 18px; border-bottom: 1px solid var(--border); background: rgba(0,0,0,0.015); }
  .ie-head-d .ie-date, .ie-card-head .ie-date { margin-left: auto; font-size: 13px; color: var(--muted); }
  .ie-topic { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--blue); background: rgba(59,139,235,.1); padding: 3px 10px; border-radius: 6px; }
  .ie-badge { font-size: 12px; font-weight: 700; border-radius: 999px; padding: 3px 12px; white-space: nowrap; }
  .ie-badge.resolved { background: rgba(22,163,74,.12); color: var(--green); }
  .ie-badge.escalated { background: rgba(220,38,38,.12); color: var(--red); }
  .ie-card-foot { padding: 12px 18px; border-top: 1px solid var(--border); }

  /* Mini transcript */
  .ie-mini { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; background: #fff; }
  .ie-mini-line { display: flex; gap: 12px; font-size: 14px; line-height: 1.5; }
  .ie-mini-who { flex-shrink: 0; min-width: 58px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; padding-top: 2px; }
  .ie-mini-who.user { color: var(--blue); }
  .ie-mini-who.ai { color: var(--green); }
  .ie-mini-text { color: var(--ink); }
  .ie-mini-more { font-size: 12px; color: var(--muted); font-style: italic; }
  .ie-mini[hidden] { display: none; }
  .ie-mini-full { max-height: 440px; overflow-y: auto; }
  .ie-toggle { align-self: flex-start; margin-top: 2px; background: none; border: none; padding: 4px 0; font-family: inherit; font-size: 13px; font-weight: 600; color: var(--cyan); cursor: pointer; }
  .ie-toggle:hover { text-decoration: underline; }


  .empty-state { color: var(--muted); font-style: italic; padding: 24px 0; }

  /* Revenue Recovery */
  .rr-updated { font-size: 13px; color: var(--muted); display: block; margin-bottom: 20px; }
  .rr-stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-top: 24px; }
  .rr-stat-card {
    background: var(--card2); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 22px 24px;
    border-top: 2px solid var(--cyan);
  }
  .rr-stat-label { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
  .rr-stat-value { font-size: 28px; font-weight: 800; background: var(--gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
  .rr-stat-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .rr-tooltip { cursor: help; color: var(--muted); font-size: 14px; }
  .rr-tooltip:hover::after {
    content: attr(title);
    position: absolute; background: #222; color: #fff;
    font-size: 12px; padding: 6px 10px; border-radius: 6px;
    white-space: nowrap; margin-left: 8px; font-weight: 400;
    text-transform: none; letter-spacing: 0;
  }

  /* Range selector */
  .range-selector { display: flex; gap: 6px; }
  .range-btn {
    background: transparent; border: 1px solid var(--border);
    color: var(--muted); font-size: 13px; font-weight: 600;
    padding: 6px 16px; border-radius: 20px; cursor: pointer;
    transition: all 0.15s;
  }
  .range-btn:hover { border-color: var(--cyan); color: var(--cyan); }
  .range-btn.active {
    background: var(--gradient); border-color: transparent; color: #000; font-weight: 700;
  }
`;

// ─── FULL HTML ────────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CSS Stats Dashboard — ${dateLabel}</title>
<style>${css}</style>
</head>
<body>

<header class="dashboard-header">
  <div class="logo-area">
    <div class="logo-wordmark">UTR Sports — CSS Stats<span>Customer Success &amp; Support</span></div>
  </div>
  <div class="range-selector">
    <button class="range-btn" data-range="1mo">1 mo</button>
    <button class="range-btn" data-range="3mo">3 mo</button>
    <button class="range-btn" data-range="6mo">6 mo</button>
    <button class="range-btn" data-range="12mo">12 mo</button>
    <button class="range-btn active" data-range="24mo">24 mo</button>
  </div>
  <div class="dashboard-meta">
    <strong>${curMoLabel}</strong>
    Refreshed ${dateLabel}
  </div>
</header>

<main>
  ${buildChurn()}
  ${buildAiResolution()}
  ${buildAAU()}
  ${buildRevenueRecovery()}
  ${buildVolumeResponse()}
  ${buildHappyThoughts()}
  ${buildPersonaSentiment()}
  ${buildInteractionExamples()}
</main>

<script>${chartJs}</script>
<script>${chartInitJs}</script>
</body>
</html>`;

// ─── WRITE OUTPUT ─────────────────────────────────────────────────────────────
const outPath = join(__dirname, 'css-stats-dashboard.html');
writeFileSync(outPath, html);
console.log(`✓ Wrote ${outPath} (${(html.length / 1024).toFixed(0)} KB)`);
