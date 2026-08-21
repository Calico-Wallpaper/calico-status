# Slack alerting

> **STATUS: NOT LIVE. Nothing has been posted to Slack and nothing has been
> uploaded to n8n.** Waiting on Justin's okay. Everything here is a reviewed,
> tested draft — see [Going live](#going-live) for the three steps to arm it.

The status board tells you what's broken *when you look at it*. This pushes
the change to Slack so nobody has to look.

## What it does

Every 5 minutes, n8n polls the same nine feeds the board uses and compares them
against the last known state. It posts **only on a change**:

- A service breaks → one message in `#technology`
- It gets worse (degraded → full outage) → a reply in that same thread
- It recovers → a reply in that same thread, with how long it was broken

One thread per incident, so "X is down" and "X is fixed after 47 min" stay
together instead of being two unrelated messages hours apart.

## The noise rules

This is the part that decides whether the channel stays useful or gets muted.

| Signal | Behaviour |
|---|---|
| **Red** — full outage | Alerts immediately, always, every service |
| **Amber** — degraded, on a service where that stops work | Alerts only after it persists **two consecutive checks** (10 min) |
| **Amber** — on Claude or OpenAI | Never alerts. Shows on the board only |
| **Grey** — we couldn't reach the vendor's status feed | **Never alerts**, and never cancels an open alert |
| Already alerted, still broken | Silent. No repeats, even as the vendor rewrites the incident text |

Amber is gated because vendor "degraded" is often a business notice rather than
a broken service — as of writing, ShipStation is amber because of a *Royal Mail
carrier disruption*, which has nothing to do with ShipStation working. Alert on
every amber and the channel gets muted inside a week.

Services where amber *does* alert: Dropbox, Airtable, Salesforce, ShipStation,
WordPress, WooCommerce. Edit `AMBER_MATTERS` in `logic.js` to change that.

Grey never alerting is deliberate: a wobble in n8n's own connectivity would
otherwise fire nine false outages at once.

## Files

| File | What |
|---|---|
| `logic.js` | **The only copy of the decision logic.** Feed adapters, the state diff, message text |
| `dry-run.js` | Hits the live feeds and prints what it *would* post, then runs the scenario tests. Posts nothing |
| `build-workflow.js` | Generates `n8n-workflow.json`, inlining `logic.js` into the Code nodes |
| `n8n-workflow.json` | Generated. Import this into n8n. **Never hand-edit it** |

Change `logic.js`, then:

```sh
node alerts/dry-run.js          # 24 assertions, must stay green
node alerts/build-workflow.js   # regenerate the workflow
```

## Testing without posting

```sh
node alerts/dry-run.js
```

Prints current live state, the messages a cold start would send, and confirms a
second identical cycle stays silent. Then it drives synthetic transitions through
the real logic and asserts the noise rules hold — red is immediate, amber is
held, flaps are silent, grey is inert, escalations thread, recovery reports
duration. All 24 pass as committed.

## Going live

Three steps, all yours to take once Justin agrees:

1. **Invite the bot to the channel.** In `#technology`: `/invite @n8n-Bot`.
   `chat.postMessage` fails if the bot isn't a member — this is the most likely
   reason a first run posts nothing.
2. **Import.** n8n → Workflows → Import from File → `n8n-workflow.json`. Attach
   the existing **`n8n-Bot`** Slack credential to the *Post to #technology* node
   (it's referenced by type, not by id, so n8n will ask).
3. **Test, then activate.** Run it manually once — with nine services healthy it
   should post nothing. To prove the Slack half works, temporarily point a probe
   at a URL that 500s, run again, and check the message lands. Then flip Active.

To change the channel, edit `CHANNEL` in `build-workflow.js` and rebuild.

## Known gotchas

- **Manual runs always look like a cold start.** n8n only persists
  `$getWorkflowStaticData` for production executions, not manual test runs. So a
  manual run may "alert" on something it already alerted on. Expected.
- **First production run is chatty.** It starts with no history, so anything
  currently broken alerts once. Quiet after that.
- **State lives in the workflow.** Deleting or re-importing the workflow resets
  history, so the next run re-alerts on anything still broken.
- The board and the alerter read the same feeds but keep separate state — the
  board is stateless, so they can't disagree about anything except timing.
