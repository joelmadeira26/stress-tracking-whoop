# Pulse go-live checklist (Android app, version 1.1)

Work through it in order. Each step says where to do it. ⏱ = about how long it takes.

## 1. Install or update the app (⏱ 2 min)
- [ ] On the phone, open https://joelmadeira26.github.io/stress-tracking-whoop/download/pulse.apk and open the downloaded file.
- [ ] If asked, allow **Install unknown apps** for Chrome, then tap **Install** (or **Update**). Version 1.1 installs over 1.0 and keeps your data.
- [ ] Open Pulse and allow **Nearby devices** and **Notifications**. Without Notifications, recording stops when the screen turns off.

## 2. Phone settings so recording never stops (⏱ 3 min). Important on Xiaomi, Redmi and POCO
In Android Settings → Apps → Pulse:
- [ ] **Battery saver → No restrictions.**
- [ ] **Autostart → On** (Xiaomi only).
- [ ] **Pause app activity if unused → Off.**
- [ ] In recent apps, long-press Pulse and tap **Lock** (the padlock).
- [ ] Bluetooth stays on. You don't need location.

## 3. WHOOP strap (⏱ 1 min)
- [ ] In the WHOOP app: Device settings → **Heart Rate Broadcast → On**.
- [ ] In Pulse: Settings → Heart-rate strap → **Connect**, and choose your WHOOP.
- [ ] The strap talks to one app at a time. Close any Pulse tab still open in Chrome.

## 4. Bring your history over (⏱ 1 min, only if you used Pulse in Chrome)
- [ ] In Chrome, Pulse → Settings → **Export all data** (saves a .json file).
- [ ] In the app: Settings → **Restore from an export** → pick that file.

## 5. You and display (⏱ 1 min)
- [ ] **Resting heart rate:** copy it from WHOOP Recovery, or let the WHOOP account fill it in (step 9).
- [ ] **Personal stress scale:** leave it on. It adapts after 8 recordings.
- [ ] Choose **Theme** and **Text size**.

## 6. Sport (⏱ 2 min)
- [ ] Settings → Live sport data → **Teams, competitions, drivers → Edit**. Add or remove teams, leagues and F1 drivers.
- [ ] **Stream delay:** leave it at 60 s. During a game, tap **Sync stream** and type the match clock or lap you see on your stream. Pulse then sets the real delay.
- [ ] Optional: get a free key at dashboard.api-football.com and paste it in **Backup live scores**. It's only used if ESPN is down, and is capped well below the free 100 calls a day.
- [ ] F1 needs nothing: moments fill in right after the race.

## 7. AI analysis (⏱ 5 min). The only paid part
- [ ] Go to console.anthropic.com → sign up → **Billing**: add $5 credit. Also set a **monthly spend limit**, for example $5.
- [ ] **API keys → Create key.** Paste it in Pulse → Settings → AI analysis. It stays only on this phone.
- [ ] **Model:**
  - Sonnet (≈3–5¢ an analysis) is recommended.
  - Haiku (≈0.2¢) is the cheapest.
- [ ] **Depth:** Quick is fine. Thorough costs more.
- [ ] **Analyse automatically:** on, so every saved session gets its write-up.

## 8. Calendar for meeting stress (⏱ 2 min)
- [ ] In Google Calendar on a computer: Settings → click your work calendar → **Secret address in iCal format** → copy it.
  - If your company blocks this, the field is missing. Add meetings by hand instead with **Meeting** on Home.
- [ ] Pulse → Settings → Calendar: paste it into **Private iCal address**.
- [ ] Fill in **Your email**, so you're left out of attendee lists and declined meetings are skipped.
- [ ] Tap **Connect**. You should see how many meetings were found today.
- [ ] Turn on **Keep calendar in sync**.
- [ ] Google sign-in only works in Chrome. In the app, the iCal address is all you need.

## 9. WHOOP account: recovery, sleep, resting HR (⏱ 10 min, once)
Follow [relay/README.md](../relay/README.md):
- [ ] Cloudflare (free): create the Worker `pulse-whoop`, paste `relay/worker.js`, then **Deploy**.
- [ ] developer-dashboard.whoop.com: **Create App**.
  - Scopes: recovery, cycles, sleep, profile and offline.
  - Redirect URL: `https://pulse-whoop.<you>.workers.dev/callback`.
- [ ] In the Worker, set `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` (both as secrets) and `APP_URL` = `https://joelmadeira26.github.io/stress-tracking-whoop/`. Then **Deploy**.
- [ ] Pulse → Settings → WHOOP account:
  - paste the Worker address;
  - tap **Connect** and sign in on WHOOP's page. Since 1.1 it returns straight to the app;
  - turn on **Update resting heart rate from WHOOP**.

## 10. Meeting privacy (⏱ 1 min)
- [ ] **Hide names by default:** on, if you'll share screenshots.
- [ ] **Lock meetings:** set a PIN, then **Fingerprint / face unlock → Set up**.

## 11. Test before it matters (⏱ 15 min)
- [ ] Settings → Demos: load the football, F1 and meeting demos. Check the charts, captions and **Share** (Post and Story).
- [ ] **Screen-off test:**
  1. Home → **Other match** (or **Meeting**). Check the bpm is moving.
  2. Lock the phone for 10 minutes. The "Pulse is recording" notification must stay.
  3. Unlock → **End** → **Save**. The chart must have no gaps (no "NOT RECORDING" shading).
- [ ] **Live game:** start from the game on Home, then use **Sync stream** once. Afterwards check that goals, cards and chances show at the right moments.
- [ ] **AI:** open the saved session. The write-up and captions appear within about 30 s.
- [ ] **Work day:** Home → meeting stress → **Start work day**. At the end, each meeting gets a score.

## If something fails
| Symptom | Fix |
|---|---|
| Strap not found | Heart Rate Broadcast on? Close WHOOP's other connections (Chrome tab, gym equipment). Toggle Bluetooth. |
| Gaps while the screen is off | Redo step 2 (battery **No restrictions** + Autostart + lock in recents). |
| No "Pulse is recording" notification | Android Settings → Apps → Pulse → Notifications → allow. |
| AI error 401 / 400 | Key mistyped, or no credit left in the Anthropic console. |
| Calendar error 404 | The secret address was reset. Copy it again. |
| WHOOP Connect opens Chrome | You still have version 1.0. Install the APK again (step 1). |
| Score stuck | Leave the game screen and open it again. Scores refresh on their own; if ESPN is down, add the API-Football key (step 6). |
