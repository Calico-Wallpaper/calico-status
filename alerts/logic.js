/* ══════════════════════════════════════════════════════════════════════
   Alert decision logic — shared by the n8n workflow and the dry-run test.

   This file is the single source of truth for "should we ping Slack?".
   The n8n "Evaluate + diff" Code node contains a copy of everything below;
   if you change one, change both. dry-run.js exercises this exact file
   against the live feeds so the logic can be tested without posting.
   ══════════════════════════════════════════════════════════════════════ */

/* Which services are worth waking people up for when merely DEGRADED (amber).
   Everything gets alerted on a full outage (red) regardless.
   Rationale: amber on the AI vendors doesn't stop production, and vendor
   "degraded" often means a business notice (e.g. ShipStation flagging a Royal
   Mail carrier disruption) rather than a broken service. */
const AMBER_MATTERS = new Set([
  'Dropbox', 'Airtable', 'Salesforce', 'ShipStation', 'WordPress', 'WooCommerce',
]);

/* An amber must survive this many consecutive checks before it alerts.
   At a 5-minute schedule, 2 = "still bad 10 minutes later". Kills flapping.
   Red is never delayed. */
const AMBER_CONFIRMATIONS = 2;

const SERVICES = [
  { name:'Dropbox',     tag:'Files',    kind:'statuspage', host:'status.dropbox.com',     page:'https://status.dropbox.com',    impact:'Job folders, artwork, print files' },
  { name:'Airtable',    tag:'Ops',      kind:'statuspage', host:'status.airtable.com',    page:'https://status.airtable.com',   impact:'Order board, job tracking, substrate data' },
  { name:'ShipStation', tag:'Ship',     kind:'statuspage', host:'status.shipstation.com', page:'https://status.shipstation.com',impact:'Labels, tracking, outbound shipments' },
  { name:'Salesforce',  tag:'CRM',      kind:'salesforce', instance:'USA602',             page:'https://status.salesforce.com/instances/USA602', impact:'Opportunities, POs, invoicing' },
  { name:'Slack',       tag:'Comms',    kind:'slack',                                     page:'https://slack-status.com',      impact:'Team comms, job threads, alerts' },
  { name:'Claude',      tag:'AI',       kind:'statuspage', host:'status.claude.com',      page:'https://status.claude.com',     impact:'Claude Code, prepress automation' },
  { name:'OpenAI',      tag:'AI',       kind:'statuspage', host:'status.openai.com',      page:'https://status.openai.com',      impact:'GPT-backed tools and scripts' },
  { name:'WordPress',   tag:'Our site', kind:'probe',      url:'https://calicowallpaper.com/wp-json/', page:'https://calicowallpaper.com', impact:'calicowallpaper.com — the public site' },
  { name:'WooCommerce', tag:'Our shop', kind:'probe',      url:'https://calicowallpaper.com/wp-json/wp/v2/product?per_page=1', page:'https://calicowallpaper.com/shop', impact:'Online store, product pages, checkout' },
];

const urlFor = s =>
  s.kind === 'statuspage' ? `https://${s.host}/api/v2/summary.json` :
  s.kind === 'slack'      ? 'https://slack-status.com/api/v2.0.0/current' :
  s.kind === 'salesforce' ? `https://api.status.salesforce.com/v1/instances/${s.instance}/status` :
  s.url;

const strip = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/* ── Feed adapters: raw payload → {level, label, detail} ───────────────
   Mirrors index.html exactly. level is one of ok | warn | down | unk.   */

function readStatuspage(d){
  const ind  = d?.status?.indicator || 'none';
  const inc  = (d?.incidents || []).filter(i => i.status !== 'resolved' && i.status !== 'postmortem');
  const map  = { none:'ok', minor:'warn', major:'down', critical:'down', maintenance:'warn' };
  return { level: map[ind] || 'unk',
           label: d?.status?.description || '',
           detail: inc.map(i => i.name).join(' · ') };
}

function readSlack(d){
  const inc = (d?.active_incidents || []).filter(i => i.status !== 'resolved');
  if(!inc.length) return { level:'ok', label:'All Systems Operational', detail:'' };
  const outage = inc.some(i => String(i.type||'').toLowerCase() === 'outage');
  return { level: outage ? 'down' : 'warn',
           label: outage ? 'Outage' : 'Incident open',
           detail: inc.map(i => strip(i.title)).join(' · ') };
}

function readSalesforce(d){
  const raw  = String(d?.status || '').toUpperCase();
  const live = (d?.Incidents || []).filter(i => String(i.status).toLowerCase() !== 'resolved');
  let level = 'ok';
  if(raw.includes('MAJOR') || raw.includes('UNPLANNED')) level = 'down';
  else if(raw.includes('MINOR') || raw.includes('PERFORMANCE') || raw.includes('DEGRAD') || raw.includes('MAINTENANCE')) level = 'warn';
  else if(raw && raw !== 'OK') level = 'unk';
  if(level === 'ok' && live.length) level = 'warn';
  const pretty = raw === 'OK' ? 'Available'
    : raw.replace(/_/g,' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  const detail = live.map(i => {
    const sev = (i.IncidentImpacts || [])[0]?.severity;
    return [i.type, sev && `(${sev})`].filter(Boolean).join(' ');
  }).join(' · ');
  return { level, label: pretty, detail };
}

/* statusCode + parsed body → reading. Never throws. */
function evaluate(svc, statusCode, body){
  if(svc.kind === 'probe'){
    if(statusCode >= 200 && statusCode < 300) return { level:'ok',   label:'Responding', detail:'' };
    if(statusCode >= 500)                     return { level:'down', label:'Server error', detail:`HTTP ${statusCode}` };
    if(statusCode > 0)                        return { level:'warn', label:`HTTP ${statusCode}`, detail:'Answered, but not healthily' };
    return { level:'unk', label:'No answer', detail:'Could not reach it' };
  }
  if(!(statusCode >= 200 && statusCode < 300) || body == null){
    // The vendor's STATUS PAGE is unreachable — that is not the same as the
    // vendor being down, and must never alert.
    return { level:'unk', label:'Status feed unreachable', detail:`HTTP ${statusCode || 0}` };
  }
  try{
    if(svc.kind === 'statuspage') return readStatuspage(body);
    if(svc.kind === 'slack')      return readSlack(body);
    if(svc.kind === 'salesforce') return readSalesforce(body);
  }catch(e){
    return { level:'unk', label:'Unreadable response', detail:String(e.message || e) };
  }
  return { level:'unk', label:'Unknown kind', detail:svc.kind };
}

/* ── The diff: readings + previous state → alerts + next state ─────────

   state shape, per service name:
     { alerting: 'warn'|'down'|null,   // what we have already told Slack
       pending: number,                // consecutive ambers not yet confirmed
       since: ISO string,              // when the current alerting run began
       thread: string|null }           // Slack ts of the alert, for threading

   Returns { alerts: [...], state } — alerts is empty on a quiet cycle.     */

function diff(readings, prevState, nowISO){
  const state  = JSON.parse(JSON.stringify(prevState || {}));
  const alerts = [];

  for(const r of readings){
    const name = r.service;
    const st   = state[name] || (state[name] = { alerting:null, pending:0, since:null, thread:null });

    // 'unk' is deliberately inert: hold whatever we last knew, alert nothing.
    if(r.level === 'unk') continue;

    const isRed    = r.level === 'down';
    const isAmber  = r.level === 'warn';
    const amberOK  = isAmber && AMBER_MATTERS.has(name);

    if(isRed || amberOK){
      const target = isRed ? 'down' : 'warn';

      // Red alerts immediately. Amber has to prove it is not a blip.
      if(isRed) st.pending = AMBER_CONFIRMATIONS;
      else      st.pending = Math.min(st.pending + 1, AMBER_CONFIRMATIONS);

      const confirmed = isRed || st.pending >= AMBER_CONFIRMATIONS;
      if(!confirmed) continue;

      // Already told Slack about this exact level? Stay quiet — no repeat spam
      // even as the vendor rewrites the incident text.
      if(st.alerting === target) continue;

      const escalation = st.alerting === 'warn' && target === 'down';
      if(!escalation) st.since = nowISO;
      st.alerting = target;

      alerts.push({
        type: escalation ? 'escalation' : 'new',
        service:name, level:target, tag:r.tag, impact:r.impact, page:r.page,
        label:r.label, detail:r.detail, since:st.since, thread:st.thread,
      });

    } else {
      // Green, or an amber on a service where amber doesn't matter.
      st.pending = 0;
      if(st.alerting){
        alerts.push({
          type:'recovery', service:name, level:'ok', tag:r.tag, impact:r.impact,
          page:r.page, label:r.label || 'Operational', detail:'',
          since:st.since, thread:st.thread,
          downtimeMin: st.since ? Math.max(1, Math.round((Date.parse(nowISO) - Date.parse(st.since)) / 60000)) : null,
        });
        st.alerting = null; st.since = null; st.thread = null;
      }
    }
  }
  return { alerts, state };
}

/* ── Slack message text ───────────────────────────────────────────────── */
function slackText(a){
  if(a.type === 'recovery'){
    const dur = a.downtimeMin != null ? ` after ${fmtDur(a.downtimeMin)}` : '';
    return `:white_check_mark: *${a.service}* is back to normal${dur}.`;
  }
  const icon = a.level === 'down' ? ':rotating_light:' : ':warning:';
  const head = a.type === 'escalation'
    ? `${icon} *${a.service}* has got worse — now a full outage`
    : a.level === 'down'
      ? `${icon} *${a.service}* is down`
      : `${icon} *${a.service}* is degraded`;
  const lines = [head];
  if(a.label)  lines.push(`> ${a.label}`);
  if(a.detail) lines.push(`> ${a.detail}`);
  lines.push(`*Affects:* ${a.impact}`);
  lines.push(`<${a.page}|Vendor status page>  ·  <https://calico-wallpaper.github.io/calico-status/|Our board>`);
  lines.push('_Not our systems — no need to go hunting._');
  return lines.join('\n');
}

const fmtDur = m => m < 60 ? `${m} min` : `${Math.floor(m/60)}h ${m%60}m`;

module.exports = { SERVICES, AMBER_MATTERS, AMBER_CONFIRMATIONS, urlFor, evaluate, diff, slackText, fmtDur };
