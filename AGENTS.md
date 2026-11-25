# calico-status

This folder holds a one-page live status board for the services that Calico production uses.

## Inputs

- Vendor status feeds: Dropbox, Airtable, ShipStation, Salesforce (instance USA602), Slack, Claude, OpenAI.
- Direct probes of WordPress and WooCommerce.

## Process

- `index.html` fetches every feed in the browser. It refreshes every 5 minutes.
- To add a service, add one line to the `SERVICES` array in `index.html`.
- The page has no server, no build step, and no API keys.

## Outputs

- The page at https://calico-wallpaper.github.io/calico-status/.

## Rules

- Grey means the page could not reach a feed. Do not show grey as down.
- Do not paint a service red on a guess.
- Green does not prove that the service works for Calico. If green and broken, the fault is probably local.
