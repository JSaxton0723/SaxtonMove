# Saxton House Hunt — St. Louis

A shared house-hunting shortlist for two people. Google sign-in, live sync,
and a match score you can argue with.

Static site: three files and no build step. Hosted free on GitHub Pages,
backed by Firebase (Firestore + Google auth).

---

## Setup

### Done already

- Firebase project `stl-house-hunt` created, Firestore enabled, Google
  sign-in switched on.
- Config wired into the top of [`assets/app.js`](assets/app.js). These
  values are **not secret** — they ship in the JavaScript of every Firebase
  web app and are safe in a public repo. Access is controlled by the rules,
  not by hiding them.
- Both Google accounts listed in `ALLOWED` in `assets/app.js` **and** in
  `allowed()` in [`firestore.rules`](firestore.rules). The rules are the
  real gate; the copy in `app.js` only makes a wrong account say "you're not
  on the allowlist" instead of throwing permission errors.
  **Change one, change the other.**

### Still to do

**1 — Publish the rules.** Firebase console → Firestore Database → **Rules**
tab → replace everything with the contents of `firestore.rules` → **Publish**.
Until this is done, every read fails with `permission-denied`.

**2 — GitHub Pages.**

1. Create a repo on GitHub — **public** is fine and required for free Pages.
2. Push this folder to it.
3. Repo **Settings → Pages** → Source: **Deploy from a branch** →
   Branch `main`, folder `/ (root)` → Save.
4. Wait a minute. Your site is at `https://<user>.github.io/<repo>/`.

**3 — Let Firebase trust the site.**

Firebase → **Authentication → Settings → Authorized domains** →
**Add domain** → `<user>.github.io`.

Skip this and sign-in fails with `auth/unauthorized-domain`. `localhost` is
authorized automatically, so it works locally before you ever deploy — which
is exactly why this step is easy to forget. The app names the fix on screen
if it happens.

---

## Using it

**Quick add** — paste a Zillow/Redfin/MLS link, optionally an address and
price. Everything else can be filled in later.

**Full details** — the whole record, plus two screenshot drop zones:

- *Listing info* runs OCR (Tesseract, loaded on demand) and fills price,
  beds, baths, sq ft, lot, year, taxes, HOA and days on market. Always
  check what it read before saving.
- *Listing photo* becomes the card image. It's downscaled to 640px and
  stored inside the Firestore document, which is capped at 1 MiB.

**Ratings** — five stars each. Click the same star again to clear it.

**Status** — Needs review → Interested → Toured → Offer made → Under
contract, plus Passed and Off market. The last two are excluded from
Top picks.

**Compare** — tick two or more cards; a table appears with the best value
in each row highlighted.

**Appearance** — sun / monitor / moon in the header. Monitor follows your
device's light-dark setting. Remembered per device, so you two can differ.

---

## The match score

Six weighted factors, normalised to 100. Open any home to see the
per-factor breakdown — every point is attributable.

| Factor | Weight | Full marks at |
|---|---|---|
| Price fit | 5 | At or below your floor, sliding to 0.65 at your ceiling |
| Commute | 4 | At or under your "great commute" minutes |
| Must-haves | 3 | Whichever of garage / basement / yard / no-HOA you ticked |
| Walkability | 2 | Walk score 85+ |
| Park access | 1.5 | Within your target distance |
| Your ratings | 2 | Both of you at five stars |

Weights and curves live in `WEIGHTS` and `scoreParts()` in `assets/app.js`.

**The curves are shaped, not linear, and that was the point.** A first pass
scored price as pass/fail inside the band and put six of eight test homes
within 13 points of each other — a ranking that ranks nothing. Price now
rewards cheaper *within* budget, walk score is stretched across the 30–90
range listings actually occupy, and park access zeroes out a mile past your
target instead of trailing off over three. If you widen a threshold far
enough that everything scores full marks on it, you've deleted the factor.

Everything in **What we're looking for** is shared and saved to Firestore —
change it and it changes for both of you, and every score re-ranks live.

---

## Files

```
index.html            markup and the sign-in gate
assets/styles.css     Warm study theme; light on :root, dark overrides
assets/app.js         auth, sync, scoring, rendering, OCR
firestore.rules       THE security boundary — paste into the console
```

## Notes

- Firebase's free Spark plan covers this comfortably.
- Deleting a home removes it for both of you. There's a confirm, no undo.
- `#/home/<id>` links to a single house, so you can text each other a link
  to one place.
