#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   Generates alerts/n8n-workflow.json from logic.js.

     node alerts/build-workflow.js

   The n8n Code nodes get their logic inlined from logic.js at build time,
   so there is exactly one copy of the decision-making to maintain. Change
   logic.js, re-run this, re-import. Never hand-edit the JSON.
   ══════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const CHANNEL = 'C07MZHCA9R6';            // #technology
const CHANNEL_NAME = '#technology';
const INTERVAL_MINUTES = 5;

// Inline logic.js minus its module.exports tail — Code nodes can't require().
const logicSrc = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8')
  .replace(/\nmodule\.exports[\s\S]*$/, '\n');

const buildListCode = `${logicSrc}
/* ── n8n driver ─────────────────────────────────────────────────────── */
// One item per service, carrying the URL for the HTTP node to call.
return SERVICES.map(s => ({ json: { service: s.name, url: urlFor(s) } }));
`;

const evaluateCode = `${logicSrc}
/* ── n8n driver ─────────────────────────────────────────────────────── */
const CHANNEL = ${JSON.stringify(CHANNEL)};   // ${CHANNEL_NAME}

const responses = $input.all();
const metas     = $('Build check list').all().map(i => i.json);
const nowISO    = new Date().toISOString();

// The HTTP node preserves input order, so index pairs response → service.
const readings = responses.map((it, idx) => {
  const meta = metas[idx] || {};
  const svc  = SERVICES.find(s => s.name === meta.service);
  if (!svc) return null;

  const statusCode = Number(it.json?.statusCode) || 0;
  let body = it.json?.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }

  return { service: svc.name, tag: svc.tag, impact: svc.impact, page: svc.page,
           ...evaluate(svc, statusCode, body) };
}).filter(Boolean);

// Static data persists between PRODUCTION executions. Note: n8n does NOT
// persist it for manual test runs, so a manual run always behaves like a
// cold start. That is expected, not a bug.
const store = $getWorkflowStaticData('global');
const prev  = store.serviceState || {};

const { alerts, state } = diff(readings, prev, nowISO);

store.serviceState = state;
store.lastRun      = nowISO;
store.lastReadings = readings.map(r => r.service + '=' + r.level).join(',');

// Zero alerts on a quiet cycle → nothing downstream runs → no Slack post.
return alerts.map(a => ({
  json: {
    ...a,
    slackBody: {
      channel: CHANNEL,
      text: slackText(a),
      unfurl_links: false,
      unfurl_media: false,
      // Escalations and recoveries thread under the original alert.
      ...(a.thread ? { thread_ts: a.thread } : {}),
    },
  },
}));
`;

const saveThreadCode = `/* Remember each alert's Slack message id so the recovery can reply in-thread. */
const store = $getWorkflowStaticData('global');
const state = store.serviceState || {};
const posts = $('Evaluate + diff').all().map(i => i.json);

$input.all().forEach((it, idx) => {
  const post = posts[idx];
  const ts   = it.json?.ts;
  if (!post || !ts || !it.json?.ok) return;
  // Only opening alerts own the thread; a recovery closes it out.
  if (post.type !== 'recovery' && state[post.service]) state[post.service].thread = ts;
});

store.serviceState = state;
return $input.all();
`;

const wf = {
  name: 'Service Status → Slack alerts',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    {
      id: 'trigger',
      name: `Every ${INTERVAL_MINUTES} minutes`,
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: INTERVAL_MINUTES }] } },
    },
    {
      id: 'buildlist',
      name: 'Build check list',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [220, 0],
      parameters: { mode: 'runOnceForAllItems', jsCode: buildListCode },
    },
    {
      id: 'fetch',
      name: 'Fetch status feeds',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: [440, 0],
      // neverError + fullResponse: a 500 from a vendor is DATA, not a failure.
      // continueRegularOutput: a timeout must not kill the other eight checks.
      onError: 'continueRegularOutput',
      parameters: {
        url: '={{ $json.url }}',
        options: {
          timeout: 10000,
          response: { response: { fullResponse: true, neverError: true } },
        },
      },
    },
    {
      id: 'evaluate',
      name: 'Evaluate + diff',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [660, 0],
      parameters: { mode: 'runOnceForAllItems', jsCode: evaluateCode },
    },
    {
      id: 'post',
      name: `Post to ${CHANNEL_NAME}`,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: [880, 0],
      parameters: {
        method: 'POST',
        url: 'https://slack.com/api/chat.postMessage',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'slackApi',
        sendBody: true,
        contentType: 'raw',
        rawContentType: 'application/json; charset=utf-8',
        body: '={{ JSON.stringify($json.slackBody) }}',
        options: {},
      },
    },
    {
      id: 'savets',
      name: 'Save thread id',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1100, 0],
      parameters: { mode: 'runOnceForAllItems', jsCode: saveThreadCode },
    },
  ],
  connections: {
    [`Every ${INTERVAL_MINUTES} minutes`]: { main: [[{ node: 'Build check list', type: 'main', index: 0 }]] },
    'Build check list':                    { main: [[{ node: 'Fetch status feeds', type: 'main', index: 0 }]] },
    'Fetch status feeds':                  { main: [[{ node: 'Evaluate + diff', type: 'main', index: 0 }]] },
    'Evaluate + diff':                     { main: [[{ node: `Post to ${CHANNEL_NAME}`, type: 'main', index: 0 }]] },
    [`Post to ${CHANNEL_NAME}`]:           { main: [[{ node: 'Save thread id', type: 'main', index: 0 }]] },
  },
};

const out = path.join(__dirname, 'n8n-workflow.json');
fs.writeFileSync(out, JSON.stringify(wf, null, 2) + '\n');
console.log(`wrote ${out}`);
console.log(`  nodes: ${wf.nodes.length}   active: ${wf.active}   channel: ${CHANNEL_NAME} (${CHANNEL})`);
console.log(`  schedule: every ${INTERVAL_MINUTES} min`);
