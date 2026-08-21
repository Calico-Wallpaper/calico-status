#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   Dry run + test suite for the alert logic. Posts NOTHING to Slack.

     node alerts/dry-run.js          live feeds + scenario tests
     node alerts/dry-run.js --live   live feeds only

   Part 1 hits the real vendor feeds and prints the Slack messages that
   would go out on a first run. Part 2 drives synthetic state transitions
   through the same code and asserts the noise rules actually hold.
   ══════════════════════════════════════════════════════════════════════ */

const { SERVICES, urlFor, evaluate, diff, slackText, AMBER_CONFIRMATIONS } = require('./logic');

const NOW = () => new Date().toISOString();
const line = c => console.log(c.repeat(72));

async function readLive(){
  return Promise.all(SERVICES.map(async svc => {
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), 10000);
    let statusCode = 0, body = null;
    try{
      const res = await fetch(urlFor(svc), { signal: ctl.signal, headers:{ 'user-agent':'calico-status-watcher' } });
      statusCode = res.status;
      if(svc.kind !== 'probe'){ try{ body = await res.json(); }catch{ body = null; } }
    }catch{ /* leave 0 → unk */ }
    finally{ clearTimeout(kill); }
    const reading = evaluate(svc, statusCode, body);
    return { service:svc.name, tag:svc.tag, impact:svc.impact, page:svc.page, ...reading };
  }));
}

/* ── Part 1: live ─────────────────────────────────────────────────────── */
async function partLive(){
  line('═'); console.log('LIVE FEEDS  ' + new Date().toLocaleString()); line('═');
  const readings = await readLive();
  for(const r of readings){
    const pad = r.service.padEnd(12);
    console.log(`  ${r.level.toUpperCase().padEnd(5)} ${pad} ${r.label}${r.detail ? ' — ' + r.detail.slice(0,60) : ''}`);
  }

  // First run from empty state. Amber needs AMBER_CONFIRMATIONS cycles, so
  // feed the same readings through repeatedly to reach steady state.
  let state = {}, alerts = [];
  for(let i = 0; i < AMBER_CONFIRMATIONS; i++){
    const out = diff(readings, state, NOW());
    state = out.state; alerts = out.alerts;
  }
  console.log(`\nWould post ${alerts.length} message(s) to #technology on a cold start:\n`);
  if(!alerts.length) console.log('  (nothing — everything either green or below the alert bar)');
  for(const a of alerts){ line('─'); console.log(slackText(a)); }
  line('─');

  // Third identical cycle must be silent.
  const again = diff(readings, state, NOW());
  console.log(`\nNext identical cycle posts: ${again.alerts.length} message(s)  ` +
              `${again.alerts.length === 0 ? '✅ no repeat spam' : '❌ REPEATING'}`);
  return again.alerts.length === 0;
}

/* ── Part 2: scenario assertions ──────────────────────────────────────── */
const mk = (name, level, extra={}) => ({
  service:name, level, tag:'T', impact:'test impact', page:'https://example.com',
  label:level, detail:'', ...extra,
});

let pass = 0, fail = 0;
function check(desc, got, want){
  const ok = got === want;
  console.log(`  ${ok ? '✅' : '❌'} ${desc}${ok ? '' : `  (got ${got}, wanted ${want})`}`);
  ok ? pass++ : fail++;
}

function partScenarios(){
  line('═'); console.log('SCENARIOS'); line('═');
  let s, r;

  // Red is immediate, once only.
  console.log('\nFull outage (red) on Airtable:');
  s = {};
  r = diff([mk('Airtable','down')], s, NOW()); s = r.state;
  check('alerts on the first check, no delay', r.alerts.length, 1);
  check('message type is "new"', r.alerts[0]?.type, 'new');
  r = diff([mk('Airtable','down')], s, NOW()); s = r.state;
  check('stays quiet while still down', r.alerts.length, 0);
  r = diff([mk('Airtable','ok')], s, NOW()); s = r.state;
  check('posts one recovery when it clears', r.alerts.length, 1);
  check('recovery is typed as recovery', r.alerts[0]?.type, 'recovery');
  r = diff([mk('Airtable','ok')], s, NOW()); s = r.state;
  check('silent once recovered', r.alerts.length, 0);

  // Amber on a service that matters must be held, then alert.
  console.log('\nDegraded (amber) on Dropbox — a service where amber matters:');
  s = {};
  r = diff([mk('Dropbox','warn')], s, NOW()); s = r.state;
  check('silent on the first amber check', r.alerts.length, 0);
  r = diff([mk('Dropbox','warn')], s, NOW()); s = r.state;
  check('alerts once it persists 10 min', r.alerts.length, 1);

  // A flap must never alert.
  console.log('\nFlap — one amber check then green:');
  s = {};
  r = diff([mk('Dropbox','warn')], s, NOW()); s = r.state;
  check('first amber silent', r.alerts.length, 0);
  r = diff([mk('Dropbox','ok')], s, NOW()); s = r.state;
  check('recovers before confirming, so no alert at all', r.alerts.length, 0);
  check('and no phantom recovery message', r.alerts.filter(a=>a.type==='recovery').length, 0);

  // Amber on a service where amber does not matter.
  console.log('\nDegraded (amber) on OpenAI — amber does NOT matter here:');
  s = {};
  for(let i=0;i<4;i++){ r = diff([mk('OpenAI','warn')], s, NOW()); s = r.state; }
  check('never alerts however long it lasts', r.alerts.length, 0);
  console.log('\n  …but a full OpenAI outage still does:');
  r = diff([mk('OpenAI','down')], s, NOW()); s = r.state;
  check('red alerts even on an amber-exempt service', r.alerts.length, 1);

  // Unreachable feed must be inert.
  console.log('\nStatus feed unreachable (grey):');
  s = {};
  for(let i=0;i<4;i++){ r = diff([mk('Dropbox','unk')], s, NOW()); s = r.state; }
  check('never alerts on grey', r.alerts.length, 0);
  console.log('\n  …and grey must not wipe an active alert:');
  s = {};
  r = diff([mk('Airtable','down')], s, NOW()); s = r.state;
  r = diff([mk('Airtable','unk')], s, NOW()); s = r.state;
  check('no bogus recovery when the feed drops out', r.alerts.length, 0);
  check('still considered alerting', s['Airtable'].alerting, 'down');
  r = diff([mk('Airtable','ok')], s, NOW()); s = r.state;
  check('recovers properly once the feed returns green', r.alerts.length, 1);

  // Escalation amber → red.
  console.log('\nEscalation — degraded then fully down:');
  s = {};
  r = diff([mk('Salesforce','warn')], s, NOW()); s = r.state;   // amber 1 of 2, silent
  r = diff([mk('Salesforce','warn')], s, NOW()); s = r.state;   // confirmed → amber alert
  check('amber alert fires first', r.alerts[0]?.type, 'new');
  r = diff([mk('Salesforce','down')], s, NOW()); s = r.state;
  check('posts again when it gets worse', r.alerts.length, 1);
  check('typed as escalation', r.alerts[0]?.type, 'escalation');
  r = diff([mk('Salesforce','down')], s, NOW()); s = r.state;
  check('then quiet while still down', r.alerts.length, 0);
  r = diff([mk('Salesforce','ok')], s, NOW()); s = r.state;
  check('one recovery closes it out', r.alerts.length, 1);

  // Recovery duration.
  console.log('\nRecovery includes how long it was broken:');
  s = {};
  const t0 = new Date(Date.now() - 47*60000).toISOString();
  r = diff([mk('Dropbox','down')], s, t0); s = r.state;
  r = diff([mk('Dropbox','ok')], s, NOW()); s = r.state;
  check('reports ~47 minutes', r.alerts[0]?.downtimeMin, 47);
  console.log('\n  Sample recovery message:');
  console.log('  ' + slackText(r.alerts[0]).replace(/\n/g,'\n  '));
}

(async () => {
  const liveOnly = process.argv.includes('--live');
  const noSpam = await partLive();
  if(!liveOnly){
    partScenarios();
    check('live run does not repeat itself', noSpam, true);
    line('═');
    console.log(`${pass} passed, ${fail} failed`);
    line('═');
    process.exit(fail ? 1 : 0);
  }
})();
