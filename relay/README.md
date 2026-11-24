# Pulse ↔ WHOOP relay (official API)

Pulse can read your daily **recovery, resting heart rate, HRV, sleep and strain** from WHOOP's official API. It uses this to:
- update your resting heart rate automatically;
- show how you slept and recovered on each session and meeting;
- let the AI analysis take a bad night into account.

**Why a relay?** WHOOP's API needs a *client secret* that must never sit inside a web app, and WHOOP doesn't accept calls from browsers. This tiny Cloudflare Worker keeps the secret, handles sign-in, and forwards read-only requests **from your Pulse app only**. It stores nothing. Your WHOOP password is only ever typed on WHOOP's own page. The free Cloudflare plan is plenty.

> WHOOP's official API has no minute-by-minute heart rate. Live heart rate still comes from your strap over Bluetooth.

## 1. Create the Worker (about 5 min)
1. Sign up or log in at https://dash.cloudflare.com (free).
2. Go to **Workers & Pages → Create → Create Worker**, name it `pulse-whoop`, then click **Deploy**.
3. Click **Edit code**, delete everything, paste the contents of [`worker.js`](worker.js) and click **Deploy**.
4. Note the Worker's address, e.g. `https://pulse-whoop.<you>.workers.dev`.

## 2. Register a WHOOP app (about 3 min)
1. Open https://developer-dashboard.whoop.com and sign in with your WHOOP account.
2. Create a team if asked, then **Create App**.
3. Fill in the app:
   - **Scopes:** `read:recovery`, `read:cycles`, `read:sleep`, `read:profile` (and allow offline/refresh).
   - **Redirect URL:** `https://pulse-whoop.<you>.workers.dev/callback`
4. Copy the **Client ID** and **Client Secret**.

## 3. Give the Worker its settings
In Cloudflare open **Worker → Settings → Variables and secrets** and add:

| Name | Type | Value |
|---|---|---|
| `WHOOP_CLIENT_ID` | Secret | your Client ID |
| `WHOOP_CLIENT_SECRET` | Secret | your Client Secret |
| `APP_URL` | Text | `https://joelmadeira26.github.io/stress-tracking-whoop/` |

Click **Deploy** again.

## 4. Connect Pulse
In Pulse open **Settings → WHOOP account**:
1. Paste the Worker address into **Relay URL**.
2. Tap **Connect** and sign in on WHOOP's page.

You'll come back to Pulse and the last 30 days sync. After that it syncs automatically about every 6 hours.

To stop at any time, tap **Disconnect** in Pulse. You can also delete the app in the WHOOP developer dashboard.
