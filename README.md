# 🇯🇵 Japan Trip Budget Tracker

A shared, live-updating expense tracker for the trip, hosted on Netlify.

- **Daily grid:** one row per trip day and one column per category (Food, Transport, Lodging, …). Type a yen amount into any cell. You can enter several items at once, like `1200+850+300`.
- **Summary:** total spent (in ¥ and your home currency), average per day, budget left with a suggested daily allowance, your biggest day, and totals, averages and shares per category.
- **Live updates:** every change is saved to the server right away. Everyone who has the page open sees it within about 3 seconds, and the changed cell flashes. The **Recent changes** feed shows who changed what.
- **Settings:** trip name, dates, total budget, home currency and exchange rate. You can add, rename, reorder or remove categories.
- **Export CSV** to download everything.

## How it works

| Piece | Where |
| --- | --- |
| Static front-end (no build step) | `public/` |
| API: `GET/POST /api/trip` | `netlify/functions/trip.mjs` |
| Storage | [Netlify Blobs](https://docs.netlify.com/blobs/overview/), store `japan-trip` |

The whole trip is stored as one JSON document. Each edit is sent as a small operation, such as "set Food on Nov 3 to ¥3,200". The server applies it to the latest stored copy using an ETag compare-and-swap and retries if another write got there first. That way, two people editing at the same moment don't overwrite each other. Browsers poll for a newer version every 3 seconds (every 20 seconds when the tab is hidden).

## Deploy to Netlify

1. In Netlify, go to **Add new site → Import an existing project** and pick this repo and branch.
   The settings come from `netlify.toml`: publish directory `public`, functions in `netlify/functions`, no build command.
2. Deploy. Netlify Blobs works automatically, with no database to set up.
3. Share the site URL with the group. Everyone enters their name the first time they open it.
4. Open **⚙️ Settings** to set the real trip dates, budget and exchange rate.

### Optional: protect it with a passcode

By default, anyone with the URL can view and edit. To require a shared passcode, go to **Site configuration → Environment variables**, add `TRIP_PASSCODE` with your chosen value, then redeploy. Visitors are asked for it once, and it's remembered on their device.

## Run locally

```bash
npm install
npx netlify-cli dev     # http://localhost:8888, with Functions + Blobs emulated
```
