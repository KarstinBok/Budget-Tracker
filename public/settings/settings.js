// ⚙️ Settings (/settings/): who's using this phone, light or dark mode, and the app map.

import { $, esc, myName, setMyName, personOf, toast } from "/common.js";

const PEOPLE = ["Karstin", "Lilin"];

function renderWho() {
  const me = personOf(myName(), PEOPLE);
  $("#whoPick").innerHTML = PEOPLE.map((p) => `<label><input type="radio" name="who" value="${esc(p)}" ${p === me ? "checked" : ""} /><span>👤 ${esc(p)}</span></label>`).join("");
}
$("#whoPick").addEventListener("change", (e) => {
  setMyName(e.target.value);
  toast(`✅ This phone is ${e.target.value}'s`);
});

const theme = window.appTheme?.get() ?? "auto";
const pick = document.querySelector(`#themePick input[value="${theme}"]`);
if (pick) pick.checked = true;
$("#themePick").addEventListener("change", (e) => window.appTheme?.set(e.target.value));

renderWho();
