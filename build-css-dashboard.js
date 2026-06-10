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
    sessions: 0, engaged: 0, aiResolved: 0,
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

function aiResM(m)  { return m ? pct(m.aiResolved, m.engaged)      : NA; }
function aiCostM(m) { return m ? dollar(m.sessions * data.vfCostPerSession) : NA; }
function sessM(m)   { return m ? num(m.sessions)                    : NA; }
function tickM(m)   { return m ? num(m.ticketsCreated)              : NA; }
function frtM(m)    { return m ? avg(m.frtSum, m.frtCount) + (m.frtCount ? 'h' : '') : NA; }
function frtPri(m, p) { return m ? avg(m[`frt${p}Sum`], m[`frt${p}Count`]) + (m[`frt${p}Count`] ? 'h' : '') : NA; }
function fcrM(m)    { return m ? pct(m.fcrResolved, m.fcrEligible)  : NA; }
function csatM(m)   { return m ? pct(m.csatHappy, m.csatTotal)      : NA; }
function durM(m)    { return m ? avg(m.durSum, m.durCount) + (m.durCount ? ' min' : '') : NA; }

// YTD derived
const ytdAiRes  = pct(ytd.aiResolved, ytd.engaged);
const ytdAiCost = dollar(ytd.sessions * data.vfCostPerSession);
const ytdSess   = num(ytd.sessions);
const ytdTick   = num(ytd.ticketsCreated);
const ytdFrt    = avg(ytd.frtSum, ytd.frtCount) + (ytd.frtCount ? 'h' : '');
const ytdFcr    = pct(ytd.fcrResolved, ytd.fcrEligible);
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
    if (metric === 'sessions') values.push(m.sessions ?? 0);
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
    ticketValues.push(s?.ticketVolume ?? null);
    csatValues.push(s?.csat ?? null);
  }
  return { labels, ticketValues, csatValues };
}

const allChartData = {
  aiRes:      buildSeries('aiRes'),
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
          <th>${pyMoLabel}</th>
        </tr>
      </thead>
      <tbody>
        ${metricRow('AI Resolution %',  aiResM(curMo),  aiResM(prevMo),  ytdAiRes,  aiResM(pyMo))}
        ${metricRow('Sessions',         sessM(curMo),   sessM(prevMo),   ytdSess,   sessM(pyMo))}
        ${metricRow('AI Cost',          aiCostM(curMo), aiCostM(prevMo), ytdAiCost, aiCostM(pyMo))}
      </tbody>
    </table>
  </div>
  <div class="chart-wrap">
    <canvas id="aiResChart" height="120"></canvas>
  </div>
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

  const tableRows = [
    metricRow('Recovery Rate %',
      fmtRate(rrCur), fmtRate(rrPrev), ytdRateStr, fmtRate(rrPY)),
    metricRow('Total Saved',
      fmtSaved(rrCur), fmtSaved(rrPrev), fmtRRYTD(m => fmtDollar(m.saved)), fmtSaved(rrPY)),
    metricRow('Total Failed',
      fmtFailed(rrCur), fmtFailed(rrPrev), fmtRRYTD(m => fmtDollar(m.failed)), fmtFailed(rrPY)),
  ].join('');

  const inRecov    = rr?.inRecoveryRevenue;
  const unrecov    = rr?.unrecoveredRevenue;

  const statCards = `
  <div class="rr-stat-grid">
    <div class="rr-stat-card">
      <div class="rr-stat-label">
        Revenue In Recovery
        <span class="rr-tooltip" title="Payment failures still in recovery process">ⓘ</span>
      </div>
      <div class="rr-stat-value">${inRecov != null ? fmtDollar(inRecov) : 'N/A'}</div>
      <div class="rr-stat-sub">Current</div>
    </div>
    <div class="rr-stat-card">
      <div class="rr-stat-label">
        Unrecovered Revenue
        <span class="rr-tooltip" title="Payment failures that have exhausted recovery attempts">ⓘ</span>
      </div>
      <div class="rr-stat-value">${unrecov != null ? fmtDollar(unrecov) : 'N/A'}</div>
      <div class="rr-stat-sub">Current</div>
    </div>
  </div>`;

  return `
<section id="s4">
  ${sectionHeader('04', 'Revenue Recovery')}
  ${lastUpdated}
  <div class="table-wrap">
    <table class="metrics-table">
      <thead>
        <tr><th>Metric</th><th>${curMoLabel} (MTD)</th><th>${prevMoLabel}</th><th>YTD</th><th>${pyMoLabel}</th></tr>
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

  <h3 class="sub-heading">Chat — Voiceflow / Freshchat</h3>
  <div class="table-wrap">
    <table class="metrics-table">
      <thead>
        <tr><th>Metric</th><th>${curMoLabel} (MTD)</th><th>${prevMoLabel}</th><th>YTD</th><th>${pyMoLabel}</th></tr>
      </thead>
      <tbody>
        ${metricRow('Chat Volume (sessions)',   sessM(curMo),  sessM(prevMo),  ytdSess, sessM(pyMo))}
        ${metricRow('Avg Session Duration',     durM(curMo),   durM(prevMo),   ytdDur,  durM(pyMo))}
        ${metricRow('CSAT',                     csatM(curMo),  csatM(prevMo),  ytdCsat, csatM(pyMo))}
      </tbody>
    </table>
  </div>
  <div class="chart-wrap">
    <canvas id="sessionChart" height="120"></canvas>
  </div>

  <h3 class="sub-heading">Tickets — Freshdesk</h3>
  <div class="table-wrap">
    <table class="metrics-table">
      <thead>
        <tr><th>Metric</th><th>${curMoLabel} (MTD)</th><th>${prevMoLabel}</th><th>YTD</th><th>${pyMoLabel}</th></tr>
      </thead>
      <tbody>
        ${metricRow('Ticket Volume',            fmtSheetTick(CUR_MO) !== 'N/A' ? fmtSheetTick(CUR_MO) : (curMo ? tickM(curMo) : '0'), fmtSheetTick(PREV_MO), fmtSheetTick('ytd'), fmtSheetTick(PY_MO))}
        ${frtPriRows}
        ${metricRow('First Contact Resolution', fcrM(curMo),   fcrM(prevMo),   ytdFcr,  fcrM(pyMo))}
        ${metricRow('CSAT',                     fmtSheetCsat(CUR_MO) !== 'N/A' ? fmtSheetCsat(CUR_MO) : csatM(curMo), fmtSheetCsat(PREV_MO), fmtSheetCsat('ytd'), fmtSheetCsat(PY_MO))}
      </tbody>
    </table>
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

function buildPersonaSentiment() {
  const ps = data.personaSentiment ?? {};
  const personas = ['Club customers', 'Power subscribers', 'College', 'High school', 'Parents'];
  const cards = personas.map(name => {
    const summary = ps[name] ?? 'Not enough data from this period.';
    return `
    <div class="persona-card">
      <div class="persona-name">${name}</div>
      <div class="persona-summary">&ldquo;${summary}&rdquo;</div>
    </div>`;
  }).join('');

  return `
<section id="s7">
  ${sectionHeader('07', 'Persona Sentiment')}
  <div class="persona-grid">
    ${cards}
  </div>
</section>`;
}

const VF_PROJECT_ID = '69ebd4159a532921bd258f8d';

function buildInteractionExamples() {
  const examples = data.interactionExamples ?? [];
  const cards = examples.length > 0
    ? examples.map((ex, i) => {
        const date = ex.date ? new Date(ex.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const status = ex.resolved
          ? `<span class="tag resolved">AI Resolved</span>`
          : `<span class="tag escalated">Escalated</span>`;
        const vfUrl = ex.transcriptId
          ? `https://creator.voiceflow.com/project/${VF_PROJECT_ID}/transcripts/${ex.transcriptId}`
          : null;
        const transcriptLink = vfUrl
          ? `<a class="transcript-link" href="${vfUrl}" target="_blank" rel="noopener">View transcript ↗</a>`
          : '';

        const turns = ex.turns ?? [];
        const userTurns = turns.filter(t => t.role === 'user');
        const aiTurns   = turns.filter(t => t.role === 'ai');

        // Topic = first user message, truncated
        const topic = userTurns[0]?.text?.trim() ?? '';
        const topicDisplay = topic.length > 140 ? topic.slice(0, 137) + '…' : topic;

        // Last AI message as the resolution note
        const lastAi = aiTurns[aiTurns.length - 1]?.text?.trim() ?? '';
        const resolutionDisplay = lastAi.length > 140 ? lastAi.slice(0, 137) + '…' : lastAi;

        const turnCount = turns.length;

        return `
      <div class="example-card">
        <div class="example-header">
          <span class="example-num">Example ${i + 1}</span>
          ${date ? `<span class="example-date">${date}</span>` : ''}
          ${status}
          ${transcriptLink}
        </div>
        <div class="example-summary">
          <div class="summary-row">
            <span class="summary-label">User asked</span>
            <span class="summary-text">${escHtml(topicDisplay)}</span>
          </div>
          ${resolutionDisplay ? `<div class="summary-row">
            <span class="summary-label">AI replied</span>
            <span class="summary-text">${escHtml(resolutionDisplay)}</span>
          </div>` : ''}
          <div class="summary-meta">${turnCount} message${turnCount !== 1 ? 's' : ''} total</div>
        </div>
      </div>`;
      }).join('')
    : `<p class="empty-state">No Voiceflow transcripts found for this period.</p>`;

  return `
<section id="s8">
  ${sectionHeader('08', 'Interaction Examples')}
  <p class="section-note">3 representative live chat interactions from this period</p>
  <div class="examples-grid">
    ${cards}
  </div>
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
            order: 2,
          },
          {
            type: 'line',
            label: 'CSAT %',
            data: series.csatValues,
            borderColor: CYAN,
            backgroundColor: CYAN_FAINT,
            borderWidth: 2.5,
            pointRadius: 4,
            pointHoverRadius: 6,
            fill: false,
            tension: 0.3,
            spanGaps: true,
            yAxisID: 'yCsat',
            order: 1,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: {
          legend: { display: true, labels: { color: TICK, font: { size: 12 } } },
          tooltip: {
            callbacks: {
              label: ctx => ctx.dataset.label === 'CSAT %'
                ? (ctx.parsed.y != null ? ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + '%' : 'N/A')
                : (ctx.parsed.y != null ? ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString() : 'N/A'),
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
          yCsat: {
            type: 'linear', position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { color: TICK, font: { size: 13 }, callback: v => v + '%' },
            min: 0, max: 100,
            title: { display: true, text: 'CSAT %', color: TICK, font: { size: 11 } },
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
    ['aiResChart', 'sessionChart', 'ticketChart'].forEach(id => {
      if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    });
    charts.aiResChart   = makeLineChart('aiResChart',   slice(ALL.aiRes,    n), '%',  CYAN, CYAN_FAINT);
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
    display: grid; grid-template-columns: 180px 1fr; gap: 20px; align-items: start;
  }
  .persona-name {
    font-size: 14px; font-weight: 700; padding-top: 3px;
    background: var(--gradient); -webkit-background-clip: text;
    -webkit-text-fill-color: transparent; background-clip: text;
  }
  .persona-summary { font-size: 17px; color: var(--ink); font-style: italic; line-height: 1.6; }

  /* Interaction Examples */
  .examples-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 24px; }
  .example-card { background: var(--card2); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .example-header {
    padding: 14px 18px; background: rgba(255,255,255,0.02);
    display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border);
  }
  .example-num { font-size: 13px; font-weight: 700; color: var(--muted); }
  .example-date { font-size: 13px; color: var(--muted); margin-left: auto; }
  .tag { font-size: 12px; font-weight: 600; border-radius: 20px; padding: 2px 10px; }
  .tag.resolved { background: rgba(34,197,94,0.12); color: var(--green); }
  .tag.escalated { background: rgba(239,68,68,0.12); color: var(--red); }
  .example-summary { padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
  .summary-row { display: flex; gap: 10px; font-size: 14px; line-height: 1.5; }
  .summary-label {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
    flex-shrink: 0; padding-top: 2px; min-width: 64px; color: var(--muted);
  }
  .summary-text { color: var(--ink); }
  .summary-meta { font-size: 12px; color: var(--muted); padding-top: 4px; }
  .transcript-link {
    margin-left: auto; font-size: 12px; font-weight: 600;
    color: var(--cyan); text-decoration: none; white-space: nowrap;
  }
  .transcript-link:hover { text-decoration: underline; }

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
