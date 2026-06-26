#!/usr/bin/env node
// backfill-chat-volume.js — fills historical Freshchat chat volume (fcTickets)
// for the Persona/Freshchat chart. Chat tickets = General-queue tickets whose
// subject starts with "conversation with" (same definition as the main fetch).
//
// Processes a few missing months per run (oldest first) to stay under the job
// timeout at the 3s rate limit, then writes css-data.json. Re-run until done.
//
// Env: FRESHDESK_KEY. Optional: FRESHDESK_DOMAIN (default universaltennis),
//      BACKFILL_MAX (months per run, default 4), BACKFILL_WINDOW (months back, default 24).

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));

const FD_KEY     = process.env.FRESHDESK_KEY;
const FD_DOMAIN  = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const MIN_SLEEP  = 3000;                                   // 3s — 20% capacity cap
const MAX_MONTHS = parseInt(process.env.BACKFILL_MAX || '4', 10);
const WINDOW     = parseInt(process.env.BACKFILL_WINDOW || '24', 10);

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const fdAuth = () => 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');

async function fdGet(path, params = {}) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { Authorization: fdAuth() }, signal: AbortSignal.timeout(30000) }); }
    catch (e) { console.warn(`  ${path} failed (${e.name}), retry…`); await sleep((attempt + 1) * 3000); continue; }
    if (res.status === 429) { const w = (+(res.headers.get('retry-after') || 60) + 5) * 1000; console.warn(`  rate limited, waiting ${w/1000}s`); await sleep(w); continue; }
    if (res.status === 503 || res.status === 502) { await sleep((attempt + 1) * 3000); continue; }
    if (!res.ok) throw new Error(`Freshdesk ${path}: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`Freshdesk ${path}: retries exhausted`);
}

async function fdSearch(query, page) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/search/tickets`);
  url.searchParams.set('query', `"${query}"`);
  url.searchParams.set('page', page);
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { Authorization: fdAuth() }, signal: AbortSignal.timeout(30000) }); }
    catch (e) { console.warn(`  search failed (${e.name}), retry…`); await sleep((attempt + 1) * 3000); continue; }
    if (res.status === 429) { const w = (+(res.headers.get('retry-after') || 60) + 5) * 1000; console.warn(`  rate limited, waiting ${w/1000}s`); await sleep(w); continue; }
    if (res.status === 503 || res.status === 502) { await sleep((attempt + 1) * 3000); continue; }
    if (!res.ok) throw new Error(`Freshdesk search: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('Freshdesk search: retries exhausted');
}

// Recursively gather all General-queue tickets in [start,end) into byId (Freshdesk
// search caps each range at 300, so split high-volume ranges by date).
async function searchRange(groupId, start, end, byId, depth = 0) {
  const s = start.toISOString().slice(0, 10), e = end.toISOString().slice(0, 10);
  if (s === e) return;
  const query = `group_id:${groupId} AND created_at:>'${s}' AND created_at:<'${e}'`;
  const first = await fdSearch(query, 1);
  for (const t of (first.results ?? [])) byId.set(t.id, t);
  const total = first.total ?? (first.results ?? []).length;
  if (total > 300 && (end - start) > 86400000) {
    const mid = new Date((start.getTime() + end.getTime()) / 2);
    console.log(`${'  '.repeat(depth)}  ↳ ${s}–${e}: ${total} (>300), splitting…`);
    await sleep(MIN_SLEEP);
    await searchRange(groupId, start, mid, byId, depth + 1);
    await searchRange(groupId, mid, end, byId, depth + 1);
    return;
  }
  const pages = Math.min(10, Math.ceil(total / 30));
  for (let page = 2; page <= pages; page++) {
    await sleep(MIN_SLEEP);
    const data = await fdSearch(query, page);
    for (const t of (data.results ?? [])) byId.set(t.id, t);
    if ((data.results ?? []).length < 30) break;
  }
}

const isChat = t => (t.subject ?? '').trim().toLowerCase().startsWith('conversation with');

async function main() {
  if (!FD_KEY) throw new Error('FRESHDESK_KEY not set');
  const dataPath = join(__dirname, 'css-data.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  data.monthly ??= {};

  const groups = await fdGet('groups');
  const generalId = groups.find(g => g.name === 'General')?.id;
  if (!generalId) throw new Error('General group not found');
  console.log(`General queue id: ${generalId}`);

  // Missing months in the chart window (oldest first), capped per run.
  const now = new Date();
  const candidates = [];
  for (let i = WINDOW - 1; i >= 1; i--) {                         // skip current month (i=0)
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    const m = data.monthly[key];
    const missing = !m || m.fcTickets == null || (m.fcTickets === 0 && (m.ticketsCreated ?? 0) === 0);
    if (missing) candidates.push({ key, start: d, end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) });
  }
  const batch = candidates.slice(0, MAX_MONTHS);
  console.log(`${candidates.length} month(s) need chat volume; processing ${batch.length} this run: ${batch.map(b => b.key).join(', ')}`);
  if (batch.length === 0) { console.log('Nothing to backfill — chat volume complete.'); return; }

  for (const { key, start, end } of batch) {
    const byId = new Map();
    console.log(`\n→ ${key}…`);
    await searchRange(generalId, start, end, byId);
    const tickets = [...byId.values()];
    const fcTickets = tickets.filter(isChat).length;
    data.monthly[key] = { ...(data.monthly[key] || {}), fcTickets, ticketsCreated: data.monthly[key]?.ticketsCreated ?? tickets.length };
    console.log(`  ${key}: ${tickets.length} General tickets, ${fcTickets} chats (fcTickets)`);
    await sleep(MIN_SLEEP);
  }

  writeFileSync(dataPath, JSON.stringify(data, null, 0));
  const remaining = candidates.length - batch.length;
  console.log(`\nWrote css-data.json. ${remaining} month(s) still remaining${remaining ? ' — re-run to continue.' : ' — DONE.'}`);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
