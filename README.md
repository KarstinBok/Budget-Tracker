# Karstin & Lilin's apps

Shared, live-updating apps hosted on Netlify. The home page (https://japan-trip-budget.netlify.app/) is for everyday use:

- **Quick add:** 💸 Expense, 🤝 Shared expense, 🍽️ Food, ⚖️ Weight and 🏃 Exercise each open the right app straight into its dialog, then come back to the home page with a confirmation. 📷 Food photo opens Claude, which logs it through the Food diary connector.
- **Our apps:** a tab per app, opened with a tap. 💸 Expenses shows each person's spending this month and today, shared spending and who owes whom. 🥗 Food & fitness shows each person's calories left today and weight. 🗾 Japan trip links to the budget and journal. Each tab has links into its app.

- **🔔 Notifications:** whenever either of you adds an expense, shared expense, payment, food, exercise or weight (in the app or through Claude), a one-line summary like "Lilin added 500 kcal of Chicken rice for lunch" goes into the 🔔 list at the top of every page. It also pops up if the app is open, with a red count of what's new to you. In 🔔, **Turn on notifications** sends these to your phone even when the app is closed. Each person gets the other's additions, not their own. On iPhone, add the app to your Home Screen first and turn notifications on from there. This doesn't need setting up on Netlify: the keys are made and kept in Netlify Blobs on first use (`netlify/lib/notify.mjs`).

The apps themselves:

| App | Address |
|---|---|
| 💸 Everyday expenses | `/daily/` |
| 🥗 Food & fitness | `/fitness/` |
| 🗾 Japan trip budget and journal | `/japan/` (journal at `/journal.html`) |

Each app has a 🏠 button back to the home page. Installed on a phone from the home page, it's called **Our Apps**; installed from `/daily/` it's **Our Expenses**, and from `/japan/` it's **Japan Trip Budget**. The Android APK opens the home page.

## 🇯🇵 Japan trip budget (`/japan/`)

- **Add expense button:** pick the date, category and price (in ¥ or S$) and it's added to that day's total. The SGD (or yen) equivalent is shown as you type. On phones it's the round ＋ button in the corner.
- **SGD everywhere:** totals, daily averages, budget and each day's total are shown in both ¥ and S$. It follows the live market JPY→SGD rate, which `/api/rate` fetches from Coinbase's exchange-rate feed and refreshes every 5 minutes, so everyone sees the same rate. If Coinbase is unreachable it falls back to the daily ECB reference rate (frankfurter.dev), then open.er-api.com. You can also set a manual rate in Settings. All amounts, past ones included, are converted at the current rate.
- **Paid with:** each expense records 💵 cash (and whose cash) or 💳 card (which card). Cards are added once, inline or in Settings, with their owner and a limit (S$1,000 by default). The **Payments** panel shows each card's spending against its limit and how much each person paid by cash and card.
- **Card limit warnings:** while entering an expense, the dialog shows how much of the card's limit it will use. At 80% you get a warning, after saving and in a banner at the top of the page. Going over the limit needs a second click on Save.
- **Suica fares for everyone at once:** choose 🚃 **Suica** under "Paid with", enter the fare for one person, and tick whose Suica cards were used (everyone splitting the trip is ticked by default). The same fare is saved on each person's Suica as linked expenses, and the category switches to Transport. Editing one of them changes just that person's fare. Suica fares count as paid by their owner and are split evenly with card spending when settling up, and they don't count toward credit-card limits.
- **Shared card limits:** in Settings, set a card to "Shares limit with" another card (e.g. two cards on one account). They're then tracked against one limit, the lower of the two, with the warnings based on their combined spending.
- **After the trip:** the Budget card becomes **Settle up** (e.g. "¥15,872 · Karstin pays Lilin") when no budget is set, and the card-limit warnings stop. **💳 Cards & Suica** compares each card's recorded spending, including Suica top-ups paid with it, with the bank's **billed** amount (Settings → Cards; Amaze: Karstin S$825.66, Lilin S$1,141.48). It also lists each Suica, what topped it up and what was spent from it. If a card was billed more than recorded, Settle up says how much the owner would be owed if it was trip spending.
- **Cash pool & settle up:** records who put how much into the shared cash and who holds it. All cash expenses come from this pool and are filed under the holder, and so do expenses with no payment recorded. Cash spending, and the cash left at the end, are shared in proportion to what each person put into the pool. Card spending is split evenly between the people listed in Settings. The panel shows each person's share of the pool, their cash and card costs, and the transfers that settle up through the holder, with where each amount comes from. **Suica top-ups:** in Settings → Cash pool, set what each person's Suica was topped up with. Karstin's was topped up from the pool cash, so its fares count as pool cash, shared by pool share. Lilin's was topped up with her Amaze card, so its fares count as Amaze spending, split evenly and counted toward the Amaze limit. **Cash counted left:** enter the cash actually left (¥21,685 at the end of the trip). Settle-up then shares out that amount, and any gap from the recorded spending shows as "Spent but not entered" and is shared by pool share like other cash.
- **Edit expenses:** ✏️ in the breakdown changes an expense's date, category, price, note or payment.
- **Daily table:** one row per trip day and one column per category (Food, Transport, Lodging, …). It's read-only: click any amount to see the individual expenses behind it (note, who added it, ¥ and S$), and delete one if it was a mistake. Click a day's total to see everything spent that day. Clicking an empty cell opens Add expense for that day and category.
- **A short page:** the top cards and the daily table are always shown. The spending summary, payments, settle-up and recent changes each open from a row of buttons (📊 Summary, 💳 Payments, 🤝 Settle up, 🕒 Recent changes), one at a time, and the device remembers the last one opened. Payments shows ⚠️ when a card is near its limit, and the limit warning banner always stays visible.
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
- **Upload a transcript:** in the entry dialog, **📄 Upload transcript** takes a voice-note transcript (e.g. a Fireflies export as .txt, .docx, .pdf or .srt). Claude writes the title, topic and a summary, and sorts the lessons into Avoid, Tip and Do again, ready to check and save. **✨ Sort what I wrote** does the same for text already pasted into "What happened", keeping that text as it is. This needs an `ANTHROPIC_API_KEY` environment variable on Netlify (optionally `CLAUDE_MODEL` to pick the model, default `claude-sonnet-5-5`).
- **Pasted Fireflies notes:** if you paste a recording's **Notes** into "What happened" and save without lessons, each timestamped point, e.g. "Pack one clothing set (00:01)", becomes a lesson with its details attached, sorted into Avoid, Tip or Do again by its wording. This works without `ANTHROPIC_API_KEY` (`netlify/lib/notes.mjs`). Entries saved like this earlier are sorted once, the next time the journal loads.
- **Straight from Fireflies:** after each voice note you record in Fireflies, the journal adds it as an entry by itself, with the summary and sorted lessons, marked *From a Fireflies recording* and linked back to it. Only recordings made during the trip dates (⚙️ Settings on the budget page) **and** judged by Claude to be about the trip are added. Anything else, such as work calls or private conversations, is skipped, and nothing from it is stored apart from its id. **📼 Check Fireflies** picks up any trip recordings the automatic import missed.
- **Search and filter** entries by text or topic. Entries are grouped by trip day.
- **Shared and live:** everyone sees new and edited entries within a few seconds. If two people edit the same entry, the second save is refused with a message, and their text stays in the dialog so nothing is lost. Deleting an entry takes two clicks.
- **Keep it for next time:** **Export Markdown** downloads the lessons and the whole journal as one file, and **Print** prints every write-up in full.

## Everyday expenses (`/daily/`)

A separate tracker for Karstin and Lilin's day-to-day spending in Singapore dollars, built the same way as the trip budget (live sync, category buttons, tap-to-expand table, donut summary, backups). It has no journal and no transcript upload. Install it on a phone from `/daily/` as **Our Expenses**.

- **🏠 Home (what opens first):** the month's spending as a big total, with today and the average per day (or, on Shared, your share and what you paid). Below it, a bar chart of the last 6 months (tap a bar to pick a month), quick buttons for last month and this month, and every expense grouped by day, newest first. Each expense shows its category icon, labels (whose, which card, who paid, the split) and note; tap one to edit or delete it. Settle up appears as a short line when someone owes money. The **＋** button adds an expense. The bottom bar switches between 🏠 Home, 📊 Overview (the cards, summary and daily table), 💳 Cards and ⚙️ Settings.
- **👤 Personal** (`/daily/#personal`): each of you records your own expenses. Everyone can see them; the filter shows yours, the other person's, or both. Cards show the month's total, average per day, top category and the change from last month.
- **🤝 Shared** (`/daily/#shared`): expenses you split. Pick who paid and split equally or by custom %. **Settle up** shows who owes whom across all shared expenses and payments, and **💸 Record a payment** logs money paid back.
- **💳 Cards:** add each card in **⚙️ Settings → Cards** with whose it is and the categories it's for. When you add an expense, the card for that category is picked for you (your own first), and you can change it or pick 💵 Cash / other. Using the other person's card on a **personal** expense means owing them the whole amount, which shows in **Settle up** on both screens. On a **shared** expense, the card's owner counts as the one who paid. The 💳 Cards fold-out shows what each card is for and what went on it this month. A card with expenses on it can't be removed or given to someone else.
- **Daily spending table:** one row per calendar day with **today at the top**, a week at a time. Scroll down within the table for earlier days, across months, back to the first expense. **📅 Go to date** jumps to any day and **⬆ Today** comes back. The footer, which stays in view, totals the last 7 days with the average per day.
- **📥 Import from Spendee:** ⚙️ Settings → **Import from Spendee (CSV)**. In Spendee, use Settings → Export data → CSV, then choose that file. The preview shows how many expenses and their dates, lets you pick whose they are and which wallets to include, and asks for a rate for any other currency (leave it blank to skip those). It also maps each Spendee category to one of ours, or adds it as a new category. Only expenses are imported, not income or transfers. Spendee labels go at the start of the note. Importing the same file again only adds rows that are new, and each import can be undone from Settings with two taps.
- Browse months with ‹ › (for the cards and summary). **⚙️ Settings** renames people (their expenses follow), edits categories, and downloads a CSV or all data. Every change is backed up like the trip data (`daily-v1`).

## Food & fitness (`/fitness/`)

A calorie and macro diary for Karstin and Lilin, in the same app as the everyday expenses (🥗 Food & fitness tab), built like the big calorie-counting apps. Each person has their own diary; you can switch to see the other's.

- **📒 Diary:** each day in four meals (🌅 Breakfast, 🍱 Lunch, 🍎 Snacks, 🍲 Dinner), plus 🏃 Exercise and ⚖️ Weight. The top shows **Goal − Food + Exercise = Remaining** calories, and protein, carbs and fat against their goals. Tap a food to edit, move or delete it.
- **Adding food in the app:** pick the meal, then
  - **🕒 Recent:** foods you logged before, one tap to add again. **✏️ Manual:** type the numbers in.
  - Everything lands in a **Check before logging** list first, where you can untick items, change the portion (× 0.5, × 2) or any number.
- **🎯 Goals:** sex, year of birth, height, current and goal weight, weekly goal (lose or gain up to 1 kg a week) and activity level set the daily calorie goal (Mifflin-St Jeor, never below 1,200 kcal for women or 1,500 for men), or set your own. Macros are a % split of calories (30/40/30 to start).
- **Exercise:** pick an activity and the minutes; calories burned are worked out from your weight, or enter your watch's number. Exercise calories are added back to the day's goal.
- **📈 Progress:** current and goal weight with an estimated date, the daily goal, the last 7 days' average, a weight chart with the goal line (1 month, 3 months, 1 year), calories for the last 14 days against the goal, and every weigh-in.
- **📷 Photos and descriptions go through the Claude app**, with no API key or extra cost. Send Claude a photo of your meal (or its label), or describe it, and say whose meal it is, e.g. "log this to my lunch". Claude splits each dish into ingredients and estimates each one's weight from the photo. It then looks each up per 100 g, scales it to the weight, shows you the breakdown and logs it to the diary through the **Food diary connector** (`netlify/functions/mcp.mjs`). The connector has tools to read a day, log food, weight and exercise, delete a food, and search USDA FoodData Central and Open Food Facts. Foods logged this way show 💬 in the app, with their ingredients and sources. You can also ask things like "how many calories do I have left today?"
- **Setting up the connector (once):**
  1. On Netlify, add the environment variable `FITNESS_MCP_KEY`: a long random password of at least 16 characters (e.g. from a password manager). Optionally add `FDC_API_KEY`, a free USDA key from [api.data.gov](https://api.data.gov/signup/); without it the shared `DEMO_KEY` allows only a few lookups an hour. Then redeploy.
  2. In Claude (claude.ai, **Settings → Connectors → Add custom connector**), name it *Food diary* and give the URL `https://japan-trip-budget.netlify.app/mcp/<your FITNESS_MCP_KEY>`. It then works in the Claude app on your phone too.
  The key in the URL is what protects the diary, so keep the URL private. To change it, set a new `FITNESS_MCP_KEY`, redeploy and update the connector. The diary is backed up like the other data (`fitness-v1`).

## How it works

| Piece | Where |
| --- | --- |
| Static front-end (no build step): budget page and journal | `public/` |
| API: `GET/POST /api/trip` | `netlify/functions/trip.mjs` |
| API: `GET /api/rate` (live ¥ per S$1) | `netlify/functions/rate.mjs` |
| API: `GET/POST /api/journal` | `netlify/functions/journal.mjs` |
| API: `POST /api/categorize` (transcript → entry draft, via Claude) | `netlify/functions/categorize.mjs` |
| Fireflies webhook (`POST /api/fireflies-webhook`), "Check Fireflies" (`POST /api/fireflies-sync`) and the background import | `netlify/functions/fireflies-*.mjs`, `netlify/lib/fireflies.mjs` |
| Claude prompt for turning a transcript into an entry | `netlify/lib/claude.mjs` |
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

### Optional: transcripts and Fireflies

Add these under **Site configuration → Environment variables**, then redeploy:

| Variable | What it's for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude, which writes the summaries and sorts the lessons (console.anthropic.com) |
| `FIREFLIES_API_KEY` | Reading your recordings (Fireflies → Settings → Developer settings → API key) |
| `FIREFLIES_WEBHOOK_SECRET` | Any long random text; the same value goes in the Fireflies webhook below |

Then in Fireflies, open **app.fireflies.ai/integrations/api/webhook** and set:
- **Webhook URL:** `https://japan-trip-budget.netlify.app/api/fireflies-webhook`
- **Signing secret:** the same value as `FIREFLIES_WEBHOOK_SECRET`
- **Event subscriptions:** `meeting.transcribed`

Save and use **Send Test Event**. Then tap **📼 Check Fireflies** on the journal once to bring in recordings made before the webhook was set up.

### Optional: protect it with a passcode

By default, anyone with the URL can view and edit. To require a shared passcode, go to **Site configuration → Environment variables**, add `TRIP_PASSCODE` with your chosen value, then redeploy. Visitors are asked for it once, and it's remembered on their device.

## Run locally

```bash
npm install
npx netlify-cli dev     # http://localhost:8888, with Functions + Blobs emulated
```
