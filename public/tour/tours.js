// The walkthrough for each feature in ✨ What's new (/new/features.js has the same ids).
// Loaded on every page a walkthrough visits, after tour.js. Steps only open forms, switch
// tabs and fill in example amounts: nothing is ever saved.
(function () {
  "use strict";
  var T = window.AppTour, click = T.click, wait = T.wait, closeDialogs = T.closeDialogs;
  var $ = function (s) { return document.querySelector(s); };
  function fill(sel, value) { var el = $(sel); if (el) { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); } return wait(100); }
  function pick(sel) { var el = $(sel); if (el && !el.checked) el.click(); return wait(120); }
  var dailyView = function (v) { return function () { closeDialogs(); return click('[data-view-btn="' + v + '"]'); }; };
  var fitnessScreen = function (s) { return function () { closeDialogs(); if (location.hash !== "#" + s) location.hash = s; return wait(250); }; };

  // ---------------------------------------------------------------- 💸 Expenses

  function openExpense() {
    if ($("#addDlg").open) return wait(0);
    return click('.screen-tabs a[data-screen="personal"]').then(function () { return click('.fab[data-add]'); });
  }
  T.define("shared-switch", [
    { page: "/", sel: '.quick[href^="/daily/?add=personal"]', title: "Start an expense", text: "Quick add 💸 Expense, or ＋ in Expenses." },
    { page: "/daily/", sel: "#sharedSwitch", title: "Shared? switch", text: "Every expense now has this switch.", before: function () { return openExpense().then(function () { return pick('input[name="entryShared"][value="personal"]'); }); } },
    { page: "/daily/", sel: "#sharedSwitch", title: "Tap 🤝 Shared", text: "The title changes to Add shared expense.", before: function () { return openExpense().then(function () { return pick('input[name="entryShared"][value="shared"]'); }); } },
    { page: "/daily/", sel: "#payerPick", title: "Who paid", text: "Skipped when you pick a card: its owner paid.", before: function () { return openExpense().then(function () { pick('input[name="entryShared"][value="shared"]'); return pick('input[name="card"][value=""]'); }); } },
    { page: "/daily/", sel: '#addForm fieldset.pay-edit[data-kind="shared"]', title: "How to split", text: "Equally, or set custom percentages.", before: function () { return fill('#addForm input[name="amount"]', "20"); } },
    { page: "/daily/", sel: "#splitPreview", title: "Each person's share", text: "Here, S$20 split equally." },
    { page: "/daily/", sel: "#addSubmit", title: "Add it", text: "It goes into 🤝 Shared and who owes whom." },
    { page: "/daily/", sel: "#txList", title: "Change it later", text: "Tap an expense and flip Shared? to move it.", before: function () { closeDialogs(); return wait(100); } },
  ], { title: "Shared expenses", cleanup: closeDialogs });

  T.define("income-surplus", [
    { page: "/daily/", sel: '[data-view-btn="income"]', title: "💰 Income tab", text: "In the bottom bar of Expenses.", before: function () { closeDialogs(); return wait(100); } },
    { page: "/daily/", sel: ".surplus", title: "Your surplus", text: "Income − fixed − savings − spending.", before: dailyView("income") },
    { page: "/daily/", sel: "#addIncomeBtn", title: "Money in", text: "Pay, transfers, gifts and refunds.", before: dailyView("income") },
    { page: "/daily/", sel: 'section:has([data-add-budget="fixed"])', title: "Fixed expenses", text: "Monthly bills like rent, or a one-off.", before: dailyView("income") },
    { page: "/daily/", sel: 'section:has([data-add-budget="saving"])', title: "Savings", text: "Set aside before the surplus.", before: dailyView("income") },
  ], { title: "Income & surplus", cleanup: function () { closeDialogs(); var b = $('[data-view-btn="home"]'); if (b) b.click(); } });

  T.define("record-income", [
    { page: "/", sel: '.quick[href^="/daily/?add=income"]', title: "Quick add income", text: "Straight into the income form." },
    { page: "/daily/", sel: "#kindSwitch", title: "Or from ＋", text: "Switch the expense form to 💰 Income.", before: openExpense },
    { page: "/daily/", sel: "#incomeSources", title: "What it is", text: "Transfer, winnings, pay, gift, refund.", before: function () { return openExpense().then(function () { return click('#kindSwitch input[value="income"]'); }); } },
    { page: "/daily/", sel: '#incomeForm input[name="from"]', title: "Who it's from", text: "Optional, like a friend paying you back." },
    { page: "/daily/", sel: "#incomeAccounts", title: "Received into", text: "Which account the money landed in." },
    { page: "/daily/", sel: "#incomeSubmit", title: "Add it", text: "Shows in green, with the month's Net." },
  ], { title: "Record income", cleanup: closeDialogs });

  T.define("cards-accounts", [
    { page: "/daily/", sel: '[data-view-btn="cards"]', title: "💳 Cards tab", text: "Cards and accounts for both of you.", before: function () { closeDialogs(); return wait(100); } },
    { page: "/daily/", sel: "#cardList", title: "Spend on each", text: "This month's total on every card.", before: dailyView("cards") },
    { page: "/daily/", sel: '.head-actions:has(#addCardBtn)', title: "Add a card or account", text: "Bank accounts, PayNow and e-wallets too.", before: dailyView("cards") },
    { page: "/daily/", sel: "#cardPreview", title: "Live preview", text: "Name, last 4 digits, owner and colour.", before: function () { return $("#cardDlg").open ? null : click("#addCardBtn"); } },
    { page: "/daily/", sel: 'label:has(#cardArtInput)', title: "Card picture", text: "Use the card's image from the bank's app." },
    { page: "/daily/", sel: 'details:has(#cardCats)', title: "Auto-pick it", text: "Suggested for these categories." },
    { page: "/daily/", sel: "#cardGuide", title: "Which card for what", text: "A readable list for each person.", before: dailyView("cards") },
  ], { title: "Cards & accounts", cleanup: function () { closeDialogs(); var b = $('[data-view-btn="home"]'); if (b) b.click(); } });

  // ---------------------------------------------------------------- 🥗 Food & fitness

  function openGoals() { return $("#goalsDlg").open ? wait(0) : click("#goalsBtn"); }
  T.define("calorie-overview", [
    { page: "/fitness/", sel: '.screen-tabs a[data-screen="progress"]', title: "📈 Progress tab", text: "Charts and the calorie overview." },
    { page: "/fitness/", sel: "#ovMode", title: "Day, week or month", text: "Pick the period to total up.", before: fitnessScreen("progress") },
    { page: "/fitness/", sel: "#ovStats", title: "The totals", text: "Eaten, burned, goal, over or under.", before: fitnessScreen("progress") },
    { page: "/fitness/", sel: '.cal-head:has(#ovPrev)', title: "Other periods", text: "‹ › steps back or forward." },
    { page: "/fitness/", sel: "#ovRows", title: "Open a day", text: "Tap a row to open its diary." },
  ], { title: "Calorie overview" });

  T.define("make-up-week", [
    { page: "/fitness/", sel: "#goalsBtn", title: "🎯 Goals", text: "Your calorie settings live here.", before: fitnessScreen("diary") },
    { page: "/fitness/", sel: 'label:has([name="makeUp"])', title: "Make up for big days", text: "Going over trims the rest of the week.", before: openGoals },
    { page: "/fitness/", sel: 'label:has([name="makeUp"])', title: "Mondays start fresh", text: "Never below 1,500 / 1,200 kcal a day." },
    { page: "/fitness/", sel: '#goalsForm button[type="submit"]', title: "Save", text: "Tick it, then save." },
  ], { title: "Make up within the week", cleanup: closeDialogs });

  T.define("exercise-and-alerts", [
    { page: "/fitness/", sel: "#goalsBtn", title: "🎯 Goals", text: "Both options are in your goals.", before: fitnessScreen("diary") },
    { page: "/fitness/", sel: 'label:has([name="addExercise"])', title: "Exercise calories", text: "Untick so exercise doesn't add calories.", before: openGoals },
    { page: "/fitness/", sel: 'label:has([name="overAlert"])', title: "Over-limit alert", text: "A nudge on your phone when you go over.", before: openGoals },
    { page: "/fitness/", sel: ".bell", title: "Turn on notifications", text: "Tap 🔔, then Turn on notifications.", before: function () { closeDialogs(); return wait(100); } },
  ], { title: "Exercise & alerts", cleanup: closeDialogs });

  function openFood() { return $("#foodDlg").open ? wait(0) : click(".fab[data-add-food]"); }
  T.define("favourites-recipes", [
    { page: "/fitness/", sel: ".fab[data-add-food]", title: "Add food", text: "The round ＋, or ＋ under a meal.", before: fitnessScreen("diary") },
    { page: "/fitness/", sel: "#recentList .star-btn", title: "☆ Make a favourite", text: "Favourites stay at the top.", before: function () { return openFood().then(function () { return pick('.src-tabs input[value="recent"]'); }); } },
    { page: "/fitness/", sel: "#recentList", title: "Most-logged first", text: "Tap a food to log it in one go." },
    { page: "/fitness/", sel: ".src-tabs", title: "📖 Recipes tab", text: "Recipes and saved foods you share.", before: function () { return openFood().then(function () { return pick('.src-tabs input[value="recipes"]'); }); } },
    { page: "/fitness/", sel: "#recipeList", title: "Log a serving", text: "Open Recipe to see what's in it." },
  ], { title: "Favourites & recipes", cleanup: closeDialogs });

  // ---------------------------------------------------------------- 🏠 Home

  T.define("home-calendar", [
    { page: "/", sel: ".home-cal", title: "📅 Calendar", text: "A month at a glance, on the home page." },
    { page: "/", sel: "#calWho", title: "Whose month", text: "Switch between Karstin and Lilin." },
    { page: "/", sel: "#calGrid", title: "🍔 and 💩", text: "🍔 within calories, 💩 pooped." },
    { page: "/", sel: '.home-cal .cal-head', title: "Change month", text: "‹ › for earlier months." },
    { page: "/", sel: "#calDay", title: "Tap a day", text: "Its calories, toilet visits and spending.", before: function () { return click("#calGrid [data-day].today"); } },
  ], { title: "Home calendar" });

  T.define("today-glance", [
    { page: "/", sel: "#glance", title: "Today", text: "Today's numbers for both of you." },
    { page: "/", sel: "#gFood", title: "Calories", text: "Left or over for each of you." },
    { page: "/", sel: "#gSpend", title: "Spending", text: "This month, and who owes whom." },
    { page: "/", sel: "#gToilet", title: "Toilet", text: "Today's log at a glance." },
    { page: "/", sel: "#glance", title: "Tap to open", text: "Each card opens its app." },
  ], { title: "Today at a glance" });

  // ---------------------------------------------------------------- ⚙️ Settings

  T.define("feedback-screenshots", [
    { page: "/settings/", sel: '#feedbackForm .seg', title: "What kind", text: "A problem, an idea or anything else." },
    { page: "/settings/", sel: '#feedbackForm textarea[name="text"]', title: "Say what to change", text: "Which part, and what you'd like." },
    { page: "/settings/", sel: ".fb-photos-field", title: "Add screenshots", text: "Up to 4. Tap one to circle the problem." },
    { page: "/settings/", sel: '#feedbackForm button[type="submit"]', title: "Send it", text: "It's gone through and fixed." },
    { page: "/settings/", sel: "#feedbackList", title: "Sent so far", text: "Each one's status and any reply." },
  ], { title: "Feedback" });

  T.define("who-and-map", [
    { page: "/", sel: "#whoBtn", title: "Who's using this phone", text: "Everything you add goes under this name." },
    { page: "/settings/", sel: "#whoPick", title: "Change it here too", text: "In ⚙️ Settings, at the top." },
    { page: "/settings/", sel: "#themePick", title: "Light or dark", text: "Auto follows your phone." },
    { page: "/settings/", sel: ".flow-map", title: "App map", text: "Every page and how to get there." },
  ], { title: "Settings" });

  // ---------------------------------------------------------------- 🚽 Toilet · 🛡️ Insurance

  T.define("toilet-insurance", [
    { page: "/", sel: '.quick[href^="/toilet/"]', title: "Log a poop", text: "From Quick add on the home page." },
    { page: "/toilet/", sel: "#bristolPick", title: "Pick the type", text: "The Bristol stool scale, drawn.", before: function () { return $("#bowelDlg").open ? null : click(".fab[data-add-bowel]"); } },
    { page: "/toilet/", sel: 'details:has(#bristolGuide)', title: "What types mean", text: "Open it for the scale explained.", before: function () { closeDialogs(); return wait(100); } },
    { page: "/insurance/", sel: "#fab", title: "Add a plan", text: "Insurer, cost, how it's paid, next date." },
    { page: "/insurance/", sel: 'section:has(#dueList)', title: "Payments due", text: "Tap ✓ Paid and the next date moves on." },
    { page: "/insurance/", sel: 'section:has(#planList)', title: "All plans", text: "Totals and a cover check for each of you." },
  ], { title: "Toilet & insurance", cleanup: closeDialogs });

  T.boot();
})();
