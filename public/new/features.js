// ✨ What's new: the latest features, newest first. Add new ones at the top. Each has either
// `shot` (a screenshot in /new/img/ and `where` to find it) when a picture is enough, or `page`
// and a walkthrough with the same id in /tour/tours.js that spotlights the real buttons.
// `id` must be unique and never change: the ✨ button at the top right of the home page shows a dot until the newest
// id has been seen on this phone.

export const FEATURES = [
  {
    id: "habits-calendar",
    shot: "/new/img/habits-calendar.jpg", // a screenshot is enough for this one
    where: "🏠 Home, under Today. Tap a day for its details",
    date: "2026-11-25",
    app: "🏠 Home",
    title: "Habits: a ✓ when both are done",
    why: "The home calendar ticks a day when calories stayed within the goal and you pooped (○ when only one), switches between week and month, and shows how many days each habit was kept. Tap Calories or Poop in the progress list to see one habit on its own: ✓ met, ✕ not met, with its success rate.",
  },
  {
    id: "home-redesign",
    shot: "/new/img/home-redesign.jpg",
    where: "🏠 Home",
    date: "2026-11-25",
    app: "🏠 Home",
    title: "A brighter home page on one screen",
    why: "Coloured cards and buttons, everything on one screen, a Home tab in the bottom bar, and the next insurance payment as a line in Spending.",
  },
  {
    id: "shared-switch",
    page: "/", // where its walkthrough (/tour/tours.js) starts
    date: "2026-11-25",
    app: "💸 Expenses",
    title: "Shared expenses from the same Expense form",
    why: "No separate Shared expense button any more: mark any expense as shared while you add it.",
  },
  {
    id: "calorie-overview",
    shot: "/new/img/calorie-overview.jpg", // a screenshot is enough for this one
    where: "🥗 Food → 📈 Progress → Calorie overview",
    date: "2026-11-23",
    app: "🥗 Food & fitness",
    title: "Calorie overview by day, week or month",
    why: "See what you ate and burned over a whole week or month against your goal.",
  },
  {
    id: "make-up-week",
    shot: "/new/img/make-up-week.jpg", // a screenshot is enough for this one
    where: "🥗 Food → 🎯 Goals",
    date: "2026-11-23",
    app: "🥗 Food & fitness",
    title: "Make up for a big day within the week",
    why: "Going over lowers the rest of the week's goal a little, and every Monday starts fresh.",
  },
  {
    id: "exercise-and-alerts",
    shot: "/new/img/exercise-and-alerts.jpg", // a screenshot is enough for this one
    where: "🥗 Food → 🎯 Goals. For the alert, also tap 🔔 → Turn on notifications",
    date: "2026-11-16",
    app: "🥗 Food & fitness",
    title: "Exercise calories and over-the-limit alerts",
    why: "Choose whether exercise earns extra calories, and get a nudge on your phone when you go over.",
  },
  {
    id: "income-surplus",
    page: "/daily/",
    date: "2026-11-15",
    app: "💸 Expenses",
    title: "Income tab: fixed bills, savings and your surplus",
    why: "Work out what's left each month after bills, savings and spending.",
  },
  {
    id: "favourites-recipes",
    page: "/fitness/",
    date: "2026-11-15",
    app: "🥗 Food & fitness",
    title: "Favourites first, and recipes in their own tab",
    why: "Log the things you eat every day in one tap.",
  },
  {
    id: "feedback-screenshots",
    shot: "/new/img/feedback-screenshots.jpg", // a screenshot is enough for this one
    where: "⚙️ Settings → 💬 Feedback",
    date: "2026-11-14",
    app: "⚙️ Settings",
    title: "Feedback with screenshots you can mark up",
    why: "Show exactly what's wrong instead of describing it.",
  },
  {
    id: "today-glance",
    shot: "/new/img/today-glance.jpg", // a screenshot is enough for this one
    where: "🏠 Home, at the top",
    date: "2026-11-14",
    app: "🏠 Home",
    title: "Today at a glance",
    why: "The home page opens on today's calories and spending for both of you.",
  },
  {
    id: "record-income",
    page: "/daily/",
    date: "2026-11-12",
    app: "💸 Expenses",
    title: "Record money coming in",
    why: "Transfers from friends, winnings, pay, gifts and refunds sit next to your spending.",
  },
  {
    id: "who-and-map",
    shot: "/new/img/who-and-map.jpg", // a screenshot is enough for this one
    where: "⚙️ Settings. You can also tap 👤 at the top of any page",
    date: "2026-11-10",
    app: "⚙️ Settings",
    title: "Who's using this phone, light or dark, and the app map",
    why: "Everything you add goes under the right person, and you can always find your way around.",
  },
  {
    id: "cards-accounts",
    page: "/daily/",
    date: "2026-11-10",
    app: "💸 Expenses",
    title: "Cards and accounts, with pictures",
    why: "Bank accounts, PayNow and e-wallets sit alongside cards, and each card can show its real picture.",
  },
  {
    id: "toilet-insurance",
    page: "/",
    date: "2026-11-09",
    app: "🚽 Toilet · 🛡️ Insurance",
    title: "Toilet log and insurance tracker",
    why: "Two new apps on the home page's bottom bar.",
  },
];
