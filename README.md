# 🇯🇵 Japan Trip Budget Tracker

A shared, live-updating expense tracker for the trip, hosted on Netlify.

- **Add expense button:** pick the date, category and price (in ¥ or S$) and it's added to that day's total. The SGD (or yen) equivalent is shown as you type. On phones it's the round ＋ button in the corner.
- **SGD everywhere:** totals, daily averages, budget and each day's total are shown in both ¥ and S$. It follows the live market JPY→SGD rate, which `/api/rate` fetches from Coinbase's exchange-rate feed and refreshes every 5 minutes, so everyone sees the same rate. If Coinbase is unreachable it falls back to the daily ECB reference rate (frankfurter.dev), then open.er-api.com. You can also set a manual rate in Settings. All amounts, past ones included, are converted at the current rate.
- **Paid with:** each expense records 💵 cash (and whose cash) or 💳 card (which card). Cards are added once, inline or in Settings, with their owner and a limit (S$1,000 by default). The **Payments** panel shows each card's spending against its limit and how much each person paid by cash and card.
- **Card limit warnings:** while entering an expense, the dialog shows how much of the card's limit it will use. At 80% you get a warning, after saving and in a banner at the top of the page. Going over the limit needs a second click on Save.
- **Shared card limits:** in Settings, set a card to "Shares limit with" another card (e.g. two cards on one account). They're then tracked against one limit, the lower of the two, with the warnings based on their combined spending.
- **Cash pool & settle up:** records who put how much into the shared cash and who holds it. Cash expenses under the holder's name, and expenses with no payment recorded, come out of the pool. Every expense is split evenly between the people listed in Settings. The panel shows each person's paid amount (cash put in, plus their own cash and card payments), their share, their balance, and the transfers that even it out, with the holder keeping the cash that's left.
- **Edit expenses:** ✏️ in the breakdown changes an expense's date, category, price, note or payment.
- **Daily table:** one row per trip day and one column per category (Food, Transport, Lodging, …). It's read-only: click any amount to see the individual expenses behind it (note, who added it, ¥ and S$), and delete one if it was a mistake. Click a day's total to see everything spent that day. Clicking an empty cell opens Add expense for that day and category.
- **Spending summary:** a big S$ total, a donut chart by category (hover or tap a slice for its amount), app-style category rows with each category's S$ and ¥ total, share and average per day, and a bar for each trip day (tap one to see that day's expenses).
- **Summary:** total spent (in ¥ and S$), average per day, budget left (set in S$) with a suggested daily allowance, your biggest day, and totals, averages and shares per category.
- **Live updates:** every change is saved to the server right away. Everyone who has the page open sees it within about 3 seconds, and the changed cell flashes. The **Recent changes** feed shows who changed what.
- **Settings:** trip name, dates, total budget, and live or manual exchange rate. You can add, rename, reorder or remove categories.
- **Export CSV** to download every expense (date, category, note, ¥, S$, who added it, how it was paid).

## Install on your phone

There are two ways, both linked from **⚙️ Settings → Install on your phone**. Either way you get the same live site, so everyone stays in sync.

- **Install the web app (Android and iPhone, no APK):** on Android, open the site in Chrome and tap **Install app** in Settings, or Chrome's **⋮ → Add to Home screen**. On iPhone, open it in Safari and tap **Share → Add to Home Screen**. This works because of `public/manifest.webmanifest`, the icons in `public/icons/`, and `public/sw.js`. The service worker only shows `offline.html` when there's no connection, and never caches the data.
- **Android app (APK):** download https://japan-trip-budget.netlify.app/downloads/japan-trip-budget.apk (or the [copy on GitHub](https://github.com/KarstinBok/Budget-Tracker/releases/latest/download/japan-trip-budget.apk)) on an Android 8+ phone and open it.
  - **If the download seems stuck at full size:** Chrome is waiting for you to confirm, because the file isn't from the Play Store. Open **⋮ → Downloads** and tap **Download anyway**.
  - **Installing:** if asked, allow Chrome to install unknown apps. New versions install over old ones.

### The Android app

The app (`android/`) is a small native wrapper with no extra libraries. It shows the live site full screen, so it always has the latest data and features and syncs with everyone else. Inside the app, exports (CSV, Markdown, backups) are saved to the phone's **Downloads** folder, and the journal's **Print** opens Android's print dialog, which can also save a PDF. Links to other sites open in the phone's browser.

GitHub Actions (`.github/workflows/android.yml`) builds the APK for every pull request that touches `android/`. On `main` it publishes the APK as a GitHub release and commits it to `public/downloads/`, so Netlify serves it from the site. The APK is signed with a fixed key kept in the repo (`android/app/trip-app.keystore`). It isn't secret: it only keeps the signature the same, so each new version can install over the last. For a Play Store release you'd sign with a private key stored as a GitHub secret instead.

## Backups

Every change to the expenses and the journal is also saved as a timestamped backup in a separate Netlify Blobs store (`japan-trip-backups`). A scheduled function (`backup-daily`) adds one more each day. The newest 300 backups of each are kept, plus the last one of every earlier day.

In **⚙️ Settings → Backups** you can:
- **Back up now** to save a copy immediately.
- **Download all data** to save the current expenses and journal as a JSON file on your device.
- See recent backups of the expenses or the journal, **download** any one, or **restore** it. Restoring replaces the current data for everyone, so it takes a second click. The current state is itself backed up first, so a restore can be undone by restoring the newer backup.

## Trip journal (`/journal.html`)

A second page, linked from the top of the budget page (📒 Journal), for writing up what happened on the trip and what you'd do differently next time.

- **Entries:** each has a date, a topic (Transport, Food & Drinks, Money, Planning & bookings, …), a title and a detailed write-up of any length. Long write-ups collapse behind "Show full write-up". Unsaved new entries are kept on your device, so a long draft isn't lost if you close the dialog.
- **Lessons learned:** attach any number of lessons to an entry, each marked ⚠️ *Avoid*, 💡 *Tip* or ✅ *Do again*. **Lessons to remember** at the top collects every lesson from every entry, filterable by kind and linked back to its entry.
- **Search and filter** entries by text or topic. Entries are grouped by trip day.
- **Shared and live:** everyone sees new and edited entries within a few seconds. If two people edit the same entry, the second save is refused with a message, and their text stays in the dialog so nothing is lost. Deleting an entry takes two clicks.
- **Keep it for next time:** **Export Markdown** downloads the lessons and the whole journal as one file, and **Print** prints every write-up in full.

## How it works

| Piece | Where |
| --- | --- |
| Static front-end (no build step): budget page and journal | `public/` |
| API: `GET/POST /api/trip` | `netlify/functions/trip.mjs` |
| API: `GET /api/rate` (live ¥ per S$1) | `netlify/functions/rate.mjs` |
| API: `GET/POST /api/journal` | `netlify/functions/journal.mjs` |
| API: `GET/POST /api/backups` (list, download, restore, back up now) | `netlify/functions/backups.mjs` |
| Daily scheduled backup | `netlify/functions/backup-daily.mjs` |
| Backup storage and pruning | `netlify/lib/backups.mjs` |
| Shared sync logic for both APIs (ETag compare-and-swap) | `netlify/lib/shared-doc.mjs` |
| Helpers shared by both pages | `public/common.js` |
| Storage | [Netlify Blobs](https://docs.netlify.com/blobs/overview/), store `japan-trip` |

The whole trip is stored as one JSON document, with each expense as its own item. Each change is sent as a small operation, such as "add ¥1,200 to Food on Nov 3". The server applies it to the latest stored copy using an ETag compare-and-swap and retries if another write got there first. That way, two people adding expenses at the same moment don't overwrite each other. Browsers poll for a newer version every 3 seconds (every 20 seconds when the tab is hidden).

## Deploy to Netlify

1. In Netlify, go to **Add new site → Import an existing project** and pick this repo and branch.
   The settings come from `netlify.toml`: publish directory `public`, functions in `netlify/functions`, no build command.
2. Deploy. Netlify Blobs works automatically, with no database to set up.
3. Share the site URL with the group. Everyone enters their name the first time they open it.
4. Open **⚙️ Settings** to set the real trip dates and budget.

### Optional: protect it with a passcode

By default, anyone with the URL can view and edit. To require a shared passcode, go to **Site configuration → Environment variables**, add `TRIP_PASSCODE` with your chosen value, then redeploy. Visitors are asked for it once, and it's remembered on their device.

## Run locally

```bash
npm install
npx netlify-cli dev     # http://localhost:8888, with Functions + Blobs emulated
```
