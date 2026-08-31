/* =====================================================================
   Saxton House Hunt — St. Louis
   =====================================================================
   Two things to fill in before this runs. Both are described in README.md.
   ===================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, deleteDoc, updateDoc,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* Firebase project: stl-house-hunt.
   These values are public identifiers, not secrets — they ship in the JS of
   every Firebase web app and are safe in a public repo. Access is decided by
   firestore.rules and by Authentication → Settings → Authorized domains.
   measurementId is omitted: no Analytics here, so nothing to measure. */
const firebaseConfig = {
  apiKey: "AIzaSyCvxSbrDbHfiqoxyep4WR_R8Rr96LQjOTM",
  authDomain: "stl-house-hunt.firebaseapp.com",
  projectId: "stl-house-hunt",
  storageBucket: "stl-house-hunt.firebasestorage.app",
  messagingSenderId: "665711404770",
  appId: "1:665711404770:web:22d8dc3c3b0f996cc020bb"
};

/* The two Google accounts allowed in. This copy only produces a friendly
   "you're not on the list" message — the REAL gate is the identical list in
   firestore.rules, because a check that runs in the browser stops nobody.
   Change one, change the other. Lowercase. */
const ALLOWED = ["jakesaxton0723@gmail.com", "jackisaxton723@gmail.com"];

/* ---- who's rating. Keys are stored in Firestore, so renaming a person
   here does not lose their existing ratings — only the label changes. ---- */
const PEOPLE = [
  { key: "Jake",  label: "Jake"  },
  { key: "Jacki", label: "Jacki" }
];

const configured = !firebaseConfig.apiKey.startsWith("PASTE_");

/* =====================================================================
   THEME  — day / auto / night, remembered per device
   ===================================================================== */
const THEME_KEY = "shh-theme";
function applyTheme(t){
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  document.querySelectorAll("#theme-tog button").forEach(b =>
    b.classList.toggle("on", b.dataset.t === t));
}
function initTheme(){
  let saved = "auto";
  try { saved = localStorage.getItem(THEME_KEY) || "auto"; } catch (e) {}
  applyTheme(saved);
  const tog = document.getElementById("theme-tog");
  if (tog) tog.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    applyTheme(b.dataset.t);
    try { localStorage.setItem(THEME_KEY, b.dataset.t); } catch (e) {}
  });
}
initTheme();

/* =====================================================================
   AUTH
   ===================================================================== */
let app, auth, db, listingsCol, prefsRef, me = null;

const gate      = document.getElementById("gate");
const appEl     = document.getElementById("app");
const gateMsg   = document.getElementById("gate-msg");
const statusEl  = document.getElementById("sync-status");

function gateSay(msg, isError){
  gateMsg.textContent = msg;
  gateMsg.classList.toggle("error", !!isError);
}
function syncSay(msg, isError){
  statusEl.innerHTML = '<i class="ti ti-' + (isError ? "alert-triangle" : "cloud-check") + '"></i><span></span>';
  statusEl.querySelector("span").textContent = msg;
  statusEl.classList.toggle("error", !!isError);
}

/* A Firebase error code is not an instruction. Naming the switch to flip in
   the console is — these are the ones that actually come up in setup. */
function authWhy(code){
  return code === "auth/operation-not-allowed"
      ? "Google sign-in is switched off in Firebase — enable it under Authentication → Sign-in method"
    : code === "auth/unauthorized-domain"
      ? "This site is not in Firebase → Authentication → Settings → Authorized domains"
    : code === "auth/network-request-failed"
      ? "No network — check your connection and try again"
    : code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request"
      ? "Sign-in cancelled"
    : "Sign-in failed (" + code + ")";
}

if (!configured){
  gateSay("Not connected yet — paste your Firebase config into assets/app.js. See README.md.", true);
  document.getElementById("signin-btn").disabled = true;
} else {
  app  = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db   = getFirestore(app);
  listingsCol = collection(db, "listings");
  prefsRef    = doc(db, "prefs", "shared");

  /* Returning from a redirect sign-in. A failure here has to surface: the
     redirect is the fallback path, so it runs on exactly the devices where
     popups do not work, and swallowing it leaves the gate looking untouched. */
  getRedirectResult(auth).catch(e => {
    if (e && e.code) gateSay(authWhy(e.code), true);
  });

  onAuthStateChanged(auth, user => {
    if (!user){ me = null; showGate(); return; }
    if (!ALLOWED.includes((user.email || "").toLowerCase())){
      gateSay(user.email + " is not on the allowlist for this site.", true);
      signOut(auth);
      return;
    }
    me = user;
    showApp();
    startListening();
  });

  document.getElementById("signin-btn").addEventListener("click", doSignIn);
  document.getElementById("signout-btn").addEventListener("click", () => signOut(auth));
}

async function doSignIn(){
  gateSay("Opening Google…");
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (e){
    const code = (e && e.code) || "";
    if (code === "auth/popup-closed-by-user"){ gateSay("Sign-in cancelled"); return; }
    if (code === "auth/popup-blocked" || code === "auth/cancelled-popup-request"
        || code === "auth/operation-not-supported-in-this-environment"){
      await signInWithRedirect(auth, provider);   // navigates away, resumes on return
      return;
    }
    gateSay(authWhy(code), true);
  }
}

function showGate(){ gate.style.display = "flex"; appEl.style.display = "none"; }
function showApp(){
  gate.style.display = "none";
  appEl.style.display = "block";
  document.getElementById("who").textContent = (me.displayName || me.email).split(" ")[0];
}

/* =====================================================================
   DATA
   ===================================================================== */
let listings = [];
let prefs = {
  priceMin: 320000, priceMax: 475000,
  commuteGood: 15, commuteMax: 35,
  parkGood: 0.25,
  rate: 6.4, down: 20,
  work: "",
  mh: { garage:true, basement:true, yard:true, hoa:true }
};
let prefsLoaded = false;

function startListening(){
  onSnapshot(query(listingsCol, orderBy("added", "desc")),
    snap => {
      listings = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      syncSay("Synced — changes save instantly for both of you.");
      renderApp();
    },
    err => syncSay("Sync error: " + err.message, true));

  onSnapshot(prefsRef,
    snap => {
      if (snap.exists()){
        const d = snap.data();
        prefs = Object.assign({}, prefs, d, { mh: Object.assign({}, prefs.mh, d.mh || {}) });
      }
      prefsLoaded = true;
      writePrefs();
      renderApp();
    },
    err => syncSay("Couldn't load preferences: " + err.message, true));
}

/* =====================================================================
   HELPERS
   ===================================================================== */
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function money(n){ return "$" + Math.round(Number(n) || 0).toLocaleString(); }
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function ppsf(l){ return l.sqft > 0 ? l.price / l.sqft : 0; }

function monthlyCost(l){
  const P = (Number(l.price) || 0) * (1 - prefs.down / 100);
  const r = (prefs.rate / 100) / 12, n = 360;
  const pi  = r > 0 ? P * r * Math.pow(1+r, n) / (Math.pow(1+r, n) - 1) : P / n;
  const tax = (Number(l.taxes) || 0) / 12;
  const ins = ((Number(l.price) || 0) * 0.004) / 12;   // ~0.4%/yr, rough
  const hoa = Number(l.hoa) || 0;
  return { pi, tax, ins, hoa, total: pi + tax + ins + hoa };
}

function avgRating(l){
  const vals = PEOPLE.map(p => Number(l["rating" + p.key]) || 0).filter(v => v > 0);
  return vals.length ? vals.reduce((a,b) => a+b, 0) / vals.length : null;
}
function isLiked(l){ return PEOPLE.some(p => (Number(l["rating" + p.key]) || 0) >= 4); }

const GARAGE_LABEL   = { none:"No garage", "1":"1-car garage", "2":"2-car garage", "3":"3+ car garage" };
const BASEMENT_LABEL = { none:"No basement", unfinished:"Unfinished basement",
                         partial:"Partly finished basement", finished:"Finished basement" };
const BASEMENT_RANK  = { none:0, unfinished:1, partial:2, finished:3 };

/* =====================================================================
   SCORING
   ---------------------------------------------------------------------
   Weights are deliberate: the first pass had six of eight homes inside a
   13-point band because price was pass/fail and park distance was a
   rounding error. Each curve below is shaped to actually use its range.
   ===================================================================== */
const WEIGHTS = { price:5, commute:4, must:3, walk:2, park:1.5, ratings:2 };
const BD_LABEL = { price:"Price fit", commute:"Commute", must:"Must-haves",
                   walk:"Walkability", park:"Park access", ratings:"Your ratings" };

function scoreParts(l){
  // Cheaper is better *within* the band, not a flat pass. Without the slide
  // a $339k and a $449k house tie, which is not how buying works.
  let price = 0;
  const lo = prefs.priceMin, hi = prefs.priceMax, band = Math.max(1, hi - lo);
  if (l.price > 0){
    if (l.price <= lo) price = 1;
    else if (l.price <= hi) price = 1 - 0.35 * ((l.price - lo) / band);
    else price = clamp01(0.65 - 0.65 * ((l.price - hi) / (band * 0.5)));
  }

  let commute = 0;
  if (l.drive != null && l.drive !== ""){
    const g = prefs.commuteGood, m = prefs.commuteMax;
    commute = l.drive <= g ? 1 : (m > g ? clamp01(1 - (l.drive - g) / (m - g)) : 0);
  }

  // Only the must-haves you ticked count, and they renormalise to 1.0
  const checks = [];
  if (prefs.mh.garage)   checks.push(l.garage && l.garage !== "none" ? 1 : 0);
  if (prefs.mh.basement){
    const r = BASEMENT_RANK[l.basement || "none"];
    checks.push(r >= 2 ? 1 : (r === 1 ? 0.5 : 0));
  }
  if (prefs.mh.yard) checks.push(l.yard ? 1 : 0);
  if (prefs.mh.hoa)  checks.push(!l.hoa ? 1 : clamp01(1 - l.hoa / 300));
  const must = checks.length ? checks.reduce((a,b) => a+b, 0) / checks.length : 0;

  // Listings cluster 40-90, so stretch that band rather than dividing by 100
  const walk = clamp01(((Number(l.walk) || 0) - 30) / 55);

  // 1.0 at your ideal distance, 0 by a mile past it. A longer tail made
  // every home in a real list score 0.73+, i.e. no separation at all.
  const park = (l.park == null || l.park === "")
    ? 0 : clamp01(1 - Math.max(0, l.park - prefs.parkGood) / 0.75);

  const avg = avgRating(l);
  const ratings = avg == null ? 0 : avg / 5;

  return { price, commute, must, walk, park, ratings };
}

function totalScore(l){
  const p = scoreParts(l);
  let got = 0, max = 0;
  for (const k in WEIGHTS){ got += WEIGHTS[k] * p[k]; max += WEIGHTS[k]; }
  return Math.round((got / max) * 100);
}

/* =====================================================================
   RENDER PIECES
   ===================================================================== */
const STATUSES = ["needs-review","interested","toured","offer","contract","passed","off-market"];
const STATUS_LABELS = { "needs-review":"Needs review", interested:"Interested", toured:"Toured",
  offer:"Offer made", contract:"Under contract", passed:"Passed", "off-market":"Off market" };

function statusSelect(l){
  const cur = l.status || "needs-review";
  return '<select class="status-select st-' + cur + '" data-id="' + l.id + '" data-act="status">' +
    STATUSES.map(s => '<option value="' + s + '"' + (s === cur ? " selected" : "") + '>' +
      STATUS_LABELS[s] + "</option>").join("") + "</select>";
}

function tagsRow(l){
  const t = [];
  if (l.beds || l.baths) t.push('<span class="tag mono">' + esc(l.beds || "?") + " bd · " + esc(l.baths || "?") + " ba</span>");
  if (l.sqft) t.push('<span class="tag mono">' + Number(l.sqft).toLocaleString() + " sqft</span>");
  t.push(l.garage && l.garage !== "none"
    ? '<span class="tag good"><i class="ti ti-check"></i> ' + GARAGE_LABEL[l.garage] + "</span>"
    : '<span class="tag gap">No garage</span>');
  const br = BASEMENT_RANK[l.basement || "none"];
  t.push(br >= 2
    ? '<span class="tag good"><i class="ti ti-check"></i> ' + BASEMENT_LABEL[l.basement] + "</span>"
    : '<span class="tag' + (br === 0 ? " gap" : "") + '">' + BASEMENT_LABEL[l.basement || "none"] + "</span>");
  if (l.yard) t.push('<span class="tag good"><i class="ti ti-check"></i> Fenced yard</span>');
  if (l.drive) t.push('<span class="tag"><i class="ti ti-car"></i> ' + l.drive + " min to work</span>");
  if (l.park !== "" && l.park != null) t.push('<span class="tag"><i class="ti ti-trees"></i> ' + l.park + " mi" + (l.parkName ? " · " + esc(l.parkName) : "") + "</span>");
  if (l.walk) t.push('<span class="tag"><i class="ti ti-walk"></i> Walk ' + l.walk + "</span>");
  if (l.hoa) t.push('<span class="tag gap">HOA ' + money(l.hoa) + "/mo</span>");
  if (l.year) t.push('<span class="tag mono">Built ' + l.year + "</span>");
  if (l.dom) t.push('<span class="tag' + (l.dom > 21 ? " gap" : "") + '"><i class="ti ti-clock"></i> ' + l.dom + "d on market</span>");
  return t.join("");
}

function starsFor(l, key){
  let h = "";
  for (let i = 1; i <= 5; i++){
    const filled = i <= (Number(l["rating" + key]) || 0);
    h += '<svg class="star" data-idx="' + i + '" data-id="' + l.id + '" data-person="' + key + '" viewBox="0 0 24 24">' +
      '<polygon points="12,2 15,9 22,9.5 16.5,14 18.5,21 12,17 5.5,21 7.5,14 2,9.5 9,9" fill="' +
      (filled ? "var(--star)" : "none") + '" stroke="var(--star)" stroke-width="1.2"/></svg>';
  }
  return h;
}
function ratingsBlock(l){
  const avg = avgRating(l);
  return '<div class="ratings">' +
    PEOPLE.map(p => '<div class="rating-row"><span class="rating-label">' + esc(p.label) +
      '</span><div class="stars" role="group" aria-label="' + esc(p.label) + ' rating">' +
      starsFor(l, p.key) + "</div></div>").join("") +
    (avg != null ? '<div class="rating-avg"><i class="ti ti-star-filled"></i> ' + avg.toFixed(1) + " avg</div>" : "") +
    "</div>";
}

function thumbHtml(l){
  return l.photo
    ? '<div class="thumb-wrap"><img src="' + l.photo + '" alt=""></div>'
    : '<div class="thumb-wrap"><i class="ti ti-home"></i></div>';
}

function renderCard(l, rank){
  const score = totalScore(l), m = monthlyCost(l), sel = compareSet.has(l.id);
  return '<div class="listing' + (sel ? " selected" : "") + '" data-status="' + (l.status || "needs-review") + '">' +
    (rank ? '<div class="rank-badge">' + rank + "</div>" : "") +
    '<div class="listing-body">' +
      '<div class="thumb-col">' + thumbHtml(l) +
        '<label class="compare-label"><input type="checkbox" data-act="compare" data-id="' + l.id + '"' +
          (sel ? " checked" : "") + "> Compare</label></div>" +
      '<div class="content-col">' +
        '<div class="row1"><div>' +
          '<p class="name"><a href="#/home/' + l.id + '" class="name-link">' + esc(l.name) + "</a></p>" +
          '<p class="neigh">' + esc(l.neigh || "—") + (l.source ? " · " + esc(l.source) : "") + "</p></div>" +
          '<div class="price-col"><div class="price">' + money(l.price) + "</div>" +
          '<div class="price-sub">' + (l.sqft ? money(ppsf(l)) + "/sqft · " : "") + money(m.total) + "/mo</div></div></div>" +
        '<div class="match"><div class="match-bar"><div class="match-fill" style="width:' + score + '%"></div></div>' +
          '<span class="match-num">' + score + " / 100</span></div>" +
        '<div class="tags">' + tagsRow(l) + "</div>" +
        ratingsBlock(l) +
        (l.notes ? '<p class="notes">' + esc(l.notes) + "</p>" : "") +
        '<div class="status-row"><span class="status-label">Status</span>' + statusSelect(l) + "</div>" +
        '<div class="listing-actions">' +
          '<a class="open-link" href="#/home/' + l.id + '">Details <i class="ti ti-arrow-right"></i></a>' +
          (l.url && l.url !== "#" ? '<a class="open-link" href="' + esc(l.url) + '" target="_blank" rel="noopener">Listing <i class="ti ti-external-link"></i></a>' : "") +
          '<button class="btn btn-ghost btn-danger remove-btn" data-act="remove" data-id="' + l.id +
            '" title="Delete"><i class="ti ti-trash"></i></button>' +
        "</div></div></div></div>";
}

/* =====================================================================
   FILTER + SORT
   ===================================================================== */
function val(id){ const e = document.getElementById(id); return e ? e.value.trim() : ""; }
function num(id){ const v = val(id); return v === "" ? null : Number(v); }
function chk(id){ const e = document.getElementById(id); return e ? e.checked : false; }

function getFiltered(){
  const st = val("filter-status"), likedOnly = chk("filter-liked");
  const pMin = num("f-price-min"), pMax = num("f-price-max"), bMin = num("f-baths"),
        sMin = num("f-sqft"), dMax = num("f-drive"), wMin = num("f-walk");
  const neigh = val("f-neigh").toLowerCase(), base = val("f-basement");
  const beds = Array.from(document.querySelectorAll(".f-beds:checked")).map(c => c.value);

  const out = listings.filter(l => {
    if (st !== "all" && (l.status || "needs-review") !== st) return false;
    if (likedOnly && !isLiked(l)) return false;
    if (pMin != null && (l.price || 0) < pMin) return false;
    if (pMax != null && (l.price || 0) > pMax) return false;
    if (bMin != null && (l.baths || 0) < bMin) return false;
    if (sMin != null && (l.sqft || 0) < sMin) return false;
    if (dMax != null && (l.drive || 999) > dMax) return false;
    if (wMin != null && (l.walk || 0) < wMin) return false;
    if (neigh && !String(l.neigh || "").toLowerCase().includes(neigh)) return false;
    if (beds.length && !beds.includes(String(l.beds))) return false;
    if (base !== "any"){
      const need = base === "finished" ? 3 : base === "partial" ? 2 : 1;
      if (BASEMENT_RANK[l.basement || "none"] < need) return false;
    }
    if (chk("f-garage") && (!l.garage || l.garage === "none")) return false;
    if (chk("f-yard")   && !l.yard) return false;
    if (chk("f-nohoa")  && l.hoa) return false;
    return true;
  });

  const by = {
    added:        (a,b) => (b.addedMs || 0) - (a.addedMs || 0),
    score:        (a,b) => totalScore(b) - totalScore(a),
    "price-asc":  (a,b) => (a.price||0) - (b.price||0),
    "price-desc": (a,b) => (b.price||0) - (a.price||0),
    ppsf:         (a,b) => (ppsf(a)||1e9) - (ppsf(b)||1e9),
    monthly:      (a,b) => monthlyCost(a).total - monthlyCost(b).total,
    commute:      (a,b) => (a.drive||999) - (b.drive||999),
    dom:          (a,b) => (a.dom||999) - (b.dom||999)
  };
  return out.sort(by[val("sort")] || by.added);
}

/* =====================================================================
   RENDER
   ===================================================================== */
let compareSet = new Set();

function render(){
  const rows = getFiltered();
  document.getElementById("list").innerHTML = rows.length
    ? rows.map(l => renderCard(l)).join("")
    : '<div class="empty"><i class="ti ti-home-search"></i>' +
      (listings.length ? "No homes match these filters." : "Nothing here yet — paste a listing link above to start.") + "</div>";
  document.getElementById("count").textContent = rows.length + " of " + listings.length + " shown";
  document.getElementById("hero-count").textContent =
    listings.length + (listings.length === 1 ? " home tracked" : " homes tracked");

  const eligible = listings.filter(l => l.status !== "passed" && l.status !== "off-market");
  const ranked = eligible.slice().sort((a,b) => totalScore(b) - totalScore(a)).slice(0, 10);
  document.getElementById("top-list").innerHTML = ranked.length
    ? ranked.map((l,i) => renderCard(l, i+1)).join("")
    : '<div class="empty"><i class="ti ti-list-search"></i>No active homes to rank yet.</div>';

  renderCompare();
  renderPrefsSummary();
}

function renderPrefsSummary(){
  document.getElementById("prefs-summary").textContent =
    money(prefs.priceMin) + "–" + money(prefs.priceMax) + " · ≤" + prefs.commuteMax + " min · " + prefs.rate + "%";
}

/* =====================================================================
   COMPARE
   ===================================================================== */
const CMP_ROWS = [
  ["Price",          l => money(l.price),                     "min"],
  ["$/sq ft",        l => l.sqft ? money(ppsf(l)) : "—",      "min"],
  ["Est. monthly",   l => money(monthlyCost(l).total),        "min"],
  ["Beds / baths",   l => (l.beds||"?") + " / " + (l.baths||"?"), null],
  ["Sq ft",          l => l.sqft ? Number(l.sqft).toLocaleString() : "—", "max"],
  ["Lot (acres)",    l => l.lot || "—",                       "max"],
  ["Year built",     l => l.year || "—",                      "max"],
  ["Garage",         l => GARAGE_LABEL[l.garage || "none"],   null],
  ["Basement",       l => BASEMENT_LABEL[l.basement || "none"], null],
  ["Fenced yard",    l => l.yard ? "Yes" : "No",              null],
  ["Taxes / yr",     l => l.taxes ? money(l.taxes) : "—",     "min"],
  ["HOA / mo",       l => l.hoa ? money(l.hoa) : "None",      "min"],
  ["Drive to work",  l => l.drive ? l.drive + " min" : "—",   "min"],
  ["Nearest park",   l => (l.park != null && l.park !== "") ? l.park + " mi" : "—", "min"],
  ["Walk score",     l => l.walk || "—",                      "max"],
  ["Days on market", l => l.dom || "—",                       null],
  ["Match",          l => totalScore(l) + " / 100",           "max"]
];
const CMP_NUM = {
  "Price": l=>l.price, "$/sq ft": l=>ppsf(l), "Est. monthly": l=>monthlyCost(l).total,
  "Sq ft": l=>l.sqft, "Lot (acres)": l=>l.lot, "Year built": l=>l.year, "Taxes / yr": l=>l.taxes,
  "HOA / mo": l=>l.hoa, "Drive to work": l=>l.drive, "Nearest park": l=>l.park,
  "Walk score": l=>l.walk, "Match": l=>totalScore(l)
};

function renderCompare(){
  const card = document.getElementById("compare-card");
  const picked = listings.filter(l => compareSet.has(l.id));
  if (picked.length < 2){ card.style.display = "none"; return; }
  card.style.display = "block";

  let html = '<table class="cmp-table"><tr><th></th>' +
    picked.map(l => "<th>" + esc(l.name) + "</th>").join("") + "</tr>";
  CMP_ROWS.forEach(([label, fn, better]) => {
    let bestIdx = -1;
    if (better && CMP_NUM[label]){
      const vals = picked.map(CMP_NUM[label]).map(v => Number(v) || 0);
      if (new Set(vals).size > 1){
        const target = better === "min"
          ? Math.min(...vals.filter(v => v > 0))
          : Math.max(...vals);
        bestIdx = vals.indexOf(target);
      }
    }
    html += "<tr><th>" + label + "</th>" +
      picked.map((l,i) => "<td" + (i === bestIdx ? ' class="best"' : "") + ">" + esc(fn(l)) + "</td>").join("") + "</tr>";
  });
  document.getElementById("compare-body").innerHTML = html + "</table>";
}

/* =====================================================================
   DETAIL
   ===================================================================== */
function detailHtml(l){
  const p = scoreParts(l), m = monthlyCost(l), score = totalScore(l);
  const bd = Object.keys(WEIGHTS).map(k =>
    '<div class="bd-row"><span class="bd-label">' + BD_LABEL[k] + "</span>" +
    '<div class="bd-track"><div class="bd-fill" style="width:' + Math.round(p[k]*100) + '%"></div></div>' +
    '<span class="bd-val">' + (WEIGHTS[k]*p[k]).toFixed(1) + " / " + WEIGHTS[k] + "</span></div>").join("");

  const spec = (dt, dd) => '<div class="spec"><dt>' + dt + "</dt><dd>" + dd + "</dd></div>";

  return '<button class="back-link" data-act="back"><i class="ti ti-arrow-left"></i> Back to all homes</button>' +
  '<div class="detail-card">' +
    (l.photo
      ? '<img class="detail-photo" src="' + l.photo + '" alt="">'
      : '<div class="detail-photo detail-photo-empty"><i class="ti ti-home"></i></div>') +
    '<div class="detail-header"><div>' +
      '<h2 class="detail-name">' + esc(l.name) + "</h2>" +
      '<p class="neigh">' + esc(l.neigh || "—") + (l.source ? " · " + esc(l.source) : "") +
        (l.dom ? " · " + l.dom + " days on market" : "") + "</p></div>" +
      '<div class="price-col"><div class="price">' + money(l.price) + "</div>" +
      (l.sqft ? '<div class="price-sub">' + money(ppsf(l)) + "/sqft</div>" : "") + "</div></div>" +

    '<div class="match" style="margin-top:16px;"><div class="match-bar">' +
      '<div class="match-fill" style="width:' + score + '%"></div></div>' +
      '<span class="match-num">' + score + " / 100</span></div>" +

    '<dl class="spec-grid">' +
      spec("Bedrooms", esc(l.beds || "—")) +
      spec("Bathrooms", esc(l.baths || "—")) +
      spec("Square feet", l.sqft ? Number(l.sqft).toLocaleString() : "—") +
      spec("Lot", l.lot ? l.lot + " ac" : "—") +
      spec("Year built", l.year || "—") +
      spec("Garage", l.garage && l.garage !== "none" ? l.garage + " car" : "None") +
      spec("Basement", (BASEMENT_LABEL[l.basement || "none"] || "").replace(" basement","")) +
      spec("Fenced yard", l.yard ? "Yes" : "No") +
      spec("Drive to work", l.drive ? l.drive + " min" : "—") +
      spec(esc(l.parkName || "Nearest park"), (l.park != null && l.park !== "") ? l.park + " mi" : "—") +
      spec("Walk score", l.walk || "—") +
      spec("HOA", l.hoa ? money(l.hoa) + "/mo" : "None") +
    "</dl>" +

    '<div class="cost-box"><p class="cost-title"><i class="ti ti-calculator"></i> Estimated monthly cost</p>' +
      '<div class="cost-row"><span>Principal &amp; interest</span><span>' + money(m.pi) + "</span></div>" +
      '<div class="cost-row"><span>Property taxes</span><span>' + (l.taxes ? money(m.tax) : "—") + "</span></div>" +
      '<div class="cost-row"><span>Homeowners insurance (est.)</span><span>' + money(m.ins) + "</span></div>" +
      '<div class="cost-row"><span>HOA</span><span>' + (m.hoa ? money(m.hoa) : "—") + "</span></div>" +
      '<div class="cost-row total"><span>Total</span><span>' + money(m.total) + "</span></div>" +
      '<p class="cost-note">' + prefs.down + "% down at " + prefs.rate + "% over 30 years. Insurance estimated at 0.4% " +
        "of price per year. Rough planning figure — not a lender quote, and it excludes PMI and closing costs.</p></div>" +

    '<div class="breakdown"><p class="bd-title"><i class="ti ti-chart-bar"></i> Where the ' + score + " came from</p>" + bd + "</div>" +

    ratingsBlock(l) +
    '<div class="status-row"><span class="status-label">Status</span>' + statusSelect(l) + "</div>" +

    '<div class="notes-section">' +
      PEOPLE.map(p =>
        '<div class="notes-block"><label class="notes-label">' + esc(p.label) + "'s notes" +
        '<span class="notes-saved" id="saved-' + p.key + '"></span></label>' +
        '<textarea class="notes-textarea" data-act="note" data-person="note' + p.key + '" data-id="' + l.id + '">' +
        esc(l["note" + p.key] || "") + "</textarea></div>").join("") +
    "</div>" +
    (l.url && l.url !== "#" ? '<a class="open-link" href="' + esc(l.url) +
      '" target="_blank" rel="noopener" style="padding-left:0;">Open the listing <i class="ti ti-external-link"></i></a>' : "") +
  "</div>";
}

/* =====================================================================
   ROUTING  — #/home/<id> so a link to one house is shareable
   ===================================================================== */
function currentRoute(){
  const m = location.hash.match(/^#\/home\/(.+)$/);
  return m ? { view:"detail", id:m[1] } : { view:"list" };
}
let currentTab = "all";

function renderApp(){
  const r = currentRoute();
  const detailEl = document.getElementById("view-detail");

  if (r.view === "detail"){
    const l = listings.find(x => x.id === r.id);
    if (!l){
      // deleted out from under us, or a stale link
      if (listings.length) { location.hash = ""; return; }
      detailEl.innerHTML = '<button class="back-link" data-act="back"><i class="ti ti-arrow-left"></i> Back</button>' +
        '<div class="empty"><i class="ti ti-home-off"></i>That home is no longer on the list.</div>';
    } else {
      detailEl.innerHTML = detailHtml(l);
    }
    detailEl.style.display = "block";
    document.getElementById("view-all").style.display = "none";
    document.getElementById("view-top").style.display = "none";
    document.getElementById("view-tabs").style.display = "none";
    render();   // keeps counts and compare fresh underneath
    return;
  }

  detailEl.style.display = "none";
  document.getElementById("view-tabs").style.display = "inline-flex";
  document.getElementById("view-all").style.display = currentTab === "all" ? "block" : "none";
  document.getElementById("view-top").style.display = currentTab === "top" ? "block" : "none";
  render();
}
window.addEventListener("hashchange", renderApp);

/* =====================================================================
   WRITES
   ===================================================================== */
async function patch(id, data){
  try { await updateDoc(doc(db, "listings", id), data); }
  catch (e){ syncSay("Couldn't save: " + e.message, true); }
}

async function addListing(data){
  const base = {
    name:"Untitled", neigh:"", price:0, beds:"3", baths:0, sqft:0, lot:0, year:0,
    garage:"none", basement:"none", yard:false, hoa:0, taxes:0,
    drive:0, park:"", parkName:"", walk:0, dom:0,
    status:"needs-review", source:"", url:"", photo:"", notes:"",
    added: serverTimestamp(), addedMs: Date.now(), addedBy: me ? me.email : ""
  };
  PEOPLE.forEach(p => { base["rating" + p.key] = 0; base["note" + p.key] = ""; });
  try { await addDoc(listingsCol, Object.assign(base, data)); }
  catch (e){ syncSay("Couldn't add that: " + e.message, true); }
}

async function savePrefs(){
  try {
    await setDoc(prefsRef, prefs, { merge:true });
    const el = document.getElementById("prefs-saved");
    el.textContent = "Saved for both of you";
    setTimeout(() => { el.textContent = ""; }, 2500);
  } catch (e){ syncSay("Couldn't save preferences: " + e.message, true); }
}

/* =====================================================================
   EVENTS
   ===================================================================== */
document.getElementById("view-tabs").addEventListener("click", e => {
  const b = e.target.closest(".tab-btn"); if (!b) return;
  currentTab = b.dataset.view;
  document.querySelectorAll(".tab-btn").forEach(x => x.classList.toggle("active", x === b));
  renderApp();
});

document.body.addEventListener("click", e => {
  const star = e.target.closest(".star");
  if (star){
    const l = listings.find(x => x.id === star.dataset.id); if (!l) return;
    const key = "rating" + star.dataset.person, idx = Number(star.dataset.idx);
    patch(l.id, { [key]: (Number(l[key]) || 0) === idx ? 0 : idx });   // click the same star to clear
    return;
  }
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;

  if (act === "back"){ location.hash = ""; }
  else if (act === "remove"){
    const l = listings.find(x => x.id === id);
    if (!l) return;
    if (!confirm("Delete " + l.name + "? This removes it for both of you.")) return;
    compareSet.delete(id);
    deleteDoc(doc(db, "listings", id)).catch(err => syncSay("Couldn't delete: " + err.message, true));
    if (currentRoute().id === id) location.hash = "";
  }
  else if (act === "compare"){
    el.checked ? compareSet.add(id) : compareSet.delete(id);
    render();
  }
});

document.body.addEventListener("change", e => {
  const el = e.target.closest("[data-act='status']");
  if (el){ patch(el.dataset.id, { status: el.value }); return; }
  if (e.target.closest("#filters-panel, .toolbar")) render();
});

/* Notes autosave — debounced so a sentence is one write, not thirty */
const noteTimers = {};
document.body.addEventListener("input", e => {
  const note = e.target.closest("[data-act='note']");
  if (note){
    const { id, person } = note.dataset;
    clearTimeout(noteTimers[person]);
    noteTimers[person] = setTimeout(() => {
      patch(id, { [person]: note.value });
      const badge = document.getElementById("saved-" + person.replace("note",""));
      if (badge){ badge.textContent = "Saved"; setTimeout(() => { badge.textContent = ""; }, 1800); }
    }, 700);
    return;
  }
  if (e.target.closest("#filters-panel")) render();
});

function toggle(btnId, panelId, chevId){
  const btn = document.getElementById(btnId); if (!btn) return;
  btn.addEventListener("click", () => {
    const p = document.getElementById(panelId);
    const open = p.style.display === "none" || !p.style.display;
    p.style.display = open ? "block" : "none";
    const c = document.getElementById(chevId);
    if (c) c.className = "ti ti-chevron-" + (open ? "up" : "down");
  });
}
toggle("filters-toggle","filters-panel","filters-chevron");
toggle("full-form-toggle","full-form","full-chevron");
toggle("prefs-toggle","prefs-body","prefs-chevron");

document.getElementById("filters-reset").addEventListener("click", () => {
  document.querySelectorAll("#filters-panel input").forEach(i => {
    if (i.type === "checkbox") i.checked = false; else i.value = "";
  });
  document.getElementById("f-basement").value = "any";
  render();
});
document.getElementById("full-cancel").addEventListener("click", () => {
  document.getElementById("full-form").style.display = "none";
  document.getElementById("full-chevron").className = "ti ti-chevron-down";
  clearFullForm();
});

/* ---- preferences ---- */
function writePrefs(){
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
  const tick = (id, v) => { const e = document.getElementById(id); if (e) e.checked = !!v; };
  set("p-price-min", prefs.priceMin);   set("p-price-max", prefs.priceMax);
  set("p-commute-good", prefs.commuteGood); set("p-commute-max", prefs.commuteMax);
  set("p-park", prefs.parkGood);        set("p-rate", prefs.rate);
  set("p-down", prefs.down);            set("p-work", prefs.work || "");
  tick("p-mh-garage", prefs.mh.garage); tick("p-mh-basement", prefs.mh.basement);
  tick("p-mh-yard", prefs.mh.yard);     tick("p-mh-hoa", prefs.mh.hoa);
}
function readPrefs(){
  prefs.priceMin    = Number(val("p-price-min")) || 0;
  prefs.priceMax    = Number(val("p-price-max")) || 0;
  prefs.commuteGood = Number(val("p-commute-good")) || 0;
  prefs.commuteMax  = Number(val("p-commute-max")) || 0;
  prefs.parkGood    = Number(val("p-park")) || 0;
  prefs.rate        = Number(val("p-rate")) || 0;
  prefs.down        = Number(val("p-down")) || 0;
  prefs.work        = val("p-work");
  prefs.mh = { garage:chk("p-mh-garage"), basement:chk("p-mh-basement"),
               yard:chk("p-mh-yard"),     hoa:chk("p-mh-hoa") };
  renderApp();
}
document.getElementById("prefs-body").addEventListener("input", readPrefs);
document.getElementById("prefs-save").addEventListener("click", savePrefs);

/* ---- add ---- */
document.getElementById("qa-save").addEventListener("click", () => {
  const name = val("qa-name"), url = val("qa-url");
  if (!name && !url){ document.getElementById("qa-name").focus(); return; }
  addListing({ name: name || "Untitled listing", price: Number(val("qa-price")) || 0,
               url: url, source: "Quick add" });
  ["qa-url","qa-name","qa-price"].forEach(i => { document.getElementById(i).value = ""; });
});

document.getElementById("full-save").addEventListener("click", () => {
  addListing({
    name: val("cf-name") || "Untitled", neigh: val("cf-neigh"),
    price: Number(val("cf-price")) || 0, beds: val("cf-beds"),
    baths: Number(val("cf-baths")) || 0, sqft: Number(val("cf-sqft")) || 0,
    lot: Number(val("cf-lot")) || 0, year: Number(val("cf-year")) || 0,
    garage: val("cf-garage"), basement: val("cf-basement"), yard: chk("cf-yard"),
    hoa: Number(val("cf-hoa")) || 0, taxes: Number(val("cf-taxes")) || 0,
    drive: Number(val("cf-drive")) || 0,
    park: val("cf-park") === "" ? "" : Number(val("cf-park")),
    parkName: val("cf-parkname"), walk: Number(val("cf-walk")) || 0,
    dom: Number(val("cf-dom")) || 0, source: val("cf-source") || "Manual",
    url: val("cf-url"), photo: document.getElementById("cf-photo-data").value || ""
  });
  clearFullForm();
  document.getElementById("full-form").style.display = "none";
  document.getElementById("full-chevron").className = "ti ti-chevron-down";
});

function clearFullForm(){
  document.querySelectorAll("#full-form input").forEach(i => {
    if (i.type === "checkbox") i.checked = false; else if (i.type !== "file") i.value = "";
  });
  document.getElementById("cf-photo-data").value = "";
  document.getElementById("cf-shot-photo-preview").style.display = "none";
  document.getElementById("cf-shot-info-status").textContent = "";
  document.getElementById("cf-shot-photo-status").textContent = "";
}

/* =====================================================================
   SCREENSHOT OCR
   ---------------------------------------------------------------------
   Retuned for purchase listings. The Chicago version grabbed the first
   dollar figure it saw, which on a for-sale page is as likely to be the
   HOA dues as the price — so price takes the LARGEST figure instead.
   ===================================================================== */
function parseListingText(text){
  const r = {};
  const nums = (text.match(/\$\s?([\d,]{3,10})/g) || [])
    .map(s => Number(s.replace(/[^\d]/g, ""))).filter(n => n > 0);
  if (nums.length) r.price = Math.max(...nums);

  /* Living area. A for-sale page usually quotes the LOT in square feet too,
     and it is the bigger number — so skip any figure with "lot" attached
     rather than taking the first match and hoping. */
  const sqftRe = /([\d,]{3,7})\s*(?:sq\.?\s?ft\.?|sqft|square feet)/ig;
  for (let m; (m = sqftRe.exec(text)) !== null; ){
    if (/lot/i.test(text.slice(Math.max(0, m.index - 16), m.index))) continue;
    r.sqft = m[1].replace(/,/g, "");
    break;
  }

  const bath = text.match(/(\d+(\.\d)?)\s*(ba\b|baths?\b|bathrooms?\b)/i);
  if (bath) r.baths = bath[1];

  const bed = text.match(/(\d+)\s*(bd\b|beds?\b|bedrooms?\b)/i);
  if (bed){
    const n = parseInt(bed[1], 10);
    r.beds = n <= 2 ? "2" : n === 3 ? "3" : n === 4 ? "4" : "5+";
  }

  // The lot label leads on Zillow ("Lot size 8,276 Sq Ft") and trails elsewhere
  // ("0.42 acre lot"), so try both orders before giving up.
  const lotAc = text.match(/lot[^\d]{0,16}([\d.]+)\s*acres?\b/i) || text.match(/([\d.]+)\s*acres?\b/i);
  if (lotAc) r.lot = lotAc[1];
  else {
    const lotSf = text.match(/lot[^\d]{0,16}([\d,]{3,9})\s*sq/i)
               || text.match(/([\d,]{3,9})\s*sq\.?\s?ft\.?\s*lot/i);
    if (lotSf) r.lot = (Number(lotSf[1].replace(/,/g,"")) / 43560).toFixed(2);
  }

  const year = text.match(/built[^\d]{0,12}((?:18|19|20)\d{2})/i);
  if (year) r.year = year[1];

  const tax = text.match(/tax(?:es)?[^\d$]{0,24}\$?\s?([\d,]{3,8})/i);
  if (tax) r.taxes = tax[1].replace(/,/g, "");

  // Single digit allowed on purpose: "HOA $0" is a real and useful answer.
  const hoa = text.match(/hoa[^\d$]{0,24}\$?\s?([\d,]{1,6})/i);
  if (hoa) r.hoa = hoa[1].replace(/,/g, "");

  const dom = text.match(/(\d+)\s*days?\s*on/i);
  if (dom) r.dom = dom[1];

  return r;
}

let tesseractLoading = null;
function loadTesseract(){
  if (window.Tesseract) return Promise.resolve();
  if (tesseractLoading) return tesseractLoading;
  tesseractLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload = resolve; s.onerror = () => reject(new Error("couldn't load the text recogniser"));
    document.head.appendChild(s);
  });
  return tesseractLoading;
}

function resizeImageToDataUrl(blob, maxWidth){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.6));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("couldn't load that image")); };
    img.src = url;
  });
}

async function runOcr(blob){
  const status = document.getElementById("cf-shot-info-status");
  status.textContent = "Loading text recognition…";
  try {
    await loadTesseract();
    status.textContent = "Reading screenshot…";
    const { data } = await window.Tesseract.recognize(blob, "eng");
    const p = parseListingText(data.text || "");
    const map = { price:"cf-price", sqft:"cf-sqft", baths:"cf-baths", beds:"cf-beds",
                  lot:"cf-lot", year:"cf-year", taxes:"cf-taxes", hoa:"cf-hoa", dom:"cf-dom" };
    const filled = [];
    for (const k in map){
      if (p[k] != null){ document.getElementById(map[k]).value = p[k]; filled.push(k); }
    }
    status.textContent = filled.length
      ? "Filled " + filled.join(", ") + " from the screenshot. Check them before saving."
      : "Couldn't recognise anything in that image — fill the fields in by hand.";
  } catch (err){
    status.textContent = "Couldn't read that image: " + err.message;
  }
}

async function runPhotoCapture(blob){
  const status = document.getElementById("cf-shot-photo-status");
  status.textContent = "Saving photo…";
  try {
    // Firestore caps a document at 1 MiB and the photo rides inside it, so
    // this stays small on purpose rather than storing the original.
    const dataUrl = await resizeImageToDataUrl(blob, 640);
    document.getElementById("cf-photo-data").value = dataUrl;
    document.getElementById("cf-shot-photo-preview-img").src = dataUrl;
    document.getElementById("cf-shot-photo-preview").style.display = "flex";
    status.textContent = "Saved as this home's photo.";
  } catch (err){
    status.textContent = "Couldn't save that image: " + err.message;
  }
}

function wireShotZone(mode){
  const zone = document.getElementById("cf-shot-" + mode + "-zone");
  const file = document.getElementById("cf-shot-" + mode + "-file");
  if (!zone || !file) return;
  const handle = b => mode === "info" ? runOcr(b) : runPhotoCapture(b);

  zone.addEventListener("click", () => file.click());
  zone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); file.click(); } });
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("dragover"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("dragover");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handle(f);
  });
  zone.addEventListener("paste", e => {
    const items = e.clipboardData && e.clipboardData.items; if (!items) return;
    for (const it of items){
      if (it.type.indexOf("image") === 0){ e.preventDefault(); handle(it.getAsFile()); return; }
    }
  });
  file.addEventListener("change", () => { if (file.files && file.files[0]) handle(file.files[0]); });
}
wireShotZone("info");
wireShotZone("photo");

document.getElementById("cf-shot-photo-remove").addEventListener("click", () => {
  document.getElementById("cf-photo-data").value = "";
  document.getElementById("cf-shot-photo-preview").style.display = "none";
  document.getElementById("cf-shot-photo-status").textContent = "Photo removed.";
});
