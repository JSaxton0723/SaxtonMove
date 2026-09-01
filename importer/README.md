# Gmail → Firestore importer

Reads Zillow and Redfin alert emails out of `saxtonmove@gmail.com` and writes
new homes into the same `listings` collection the web app reads. Runs on a
30-minute trigger in Google Apps Script — no server, no hosting, free, and no
credit card (Firebase Cloud Functions would need the Blaze plan).

```
Zillow/Redfin alert → Gmail filter → label HouseHunt/Alerts
                                          ↓  every 30 min
                    Apps Script: parse → dedupe → Firestore
                                          ↓  live snapshot
                              the app, on both your phones
```

## Files

| | |
|---|---|
| `parse.gs.js` | The parsers. Also loaded by `test.js` under Node — **one file, no duplicate to drift**. No `require`/`export`; don't add any. |
| `Code.gs` | Gmail reading, Firestore writing, dedupe, labelling, failure reports. |
| `test.js` | `node importer/test.js [sample.eml …]` — fixtures always, real samples optional. |

## Why it parses plain text, not HTML

Every listing link in Redfin's HTML part is wrapped in an opaque
`redmail3.redfin.com/u/click?…` tracker — the property id appears **zero times**
in the entire HTML body. The `text/plain` alternative carries direct URLs, so
it's the only part of the message that says *which house it is* without
following an account-tied redirect. It's also far more stable than a marketing
HTML template.

The URL earns its keep twice over:
`/MO/Saint-Louis/2817-Nebraska-Ave-63118/home/93691791` yields state, city,
street and ZIP from structure rather than from text layout — and `93691791` is
the dedupe key.

## Setup

### 1 — Gmail filter

Do this **after** step 3's first two sub-steps, so the labels already exist and
you can pick one off a dropdown rather than typing a nested name. Order:
create the Apps Script project → run `createLabels()` → come back here.

In `saxtonmove@gmail.com`: **Settings ⚙ → See all settings → Filters and
Blocked Addresses → Create a new filter**.

In the **Has the words** box (not *From* — see below):

```
from:(redfin.com OR zillow.com)
```

**Create filter** → tick **Apply the label** → choose `HouseHunt/Alerts` →
also tick **Skip the Inbox** and **Also apply filter to matching conversations**
→ **Create filter**.

Two reasons it goes in *Has the words* rather than the *From* box: that box
wants literal addresses and won't take an `OR`, and `from:redfin.com` matches
the whole domain, so it keeps working when Redfin sends from `redmail@`,
`no-reply@` or anything else at `redfin.com`. Your sample arrives from
`Redfin <redmail@redfin.com>`; a filter pinned to that exact address would miss
the others.

### 2 — Service account

The importer writes as a service account, not as a person. **This is why the
importer is not in the app's allowlist**: a service-account token bypasses
`firestore.rules` completely.

1. <https://console.cloud.google.com/iam-admin/serviceaccounts> → select project
   **stl-house-hunt** → **Create service account**, name it `house-hunt-importer`.
2. Grant it the role **Cloud Datastore User**. Nothing else — it never needs
   to read Gmail, and it must not be an owner.
3. On the new account → **Keys → Add key → Create new key → JSON**. Download it.

That JSON file is a **real secret**, unlike the Firebase web config in the app.
It bypasses your rules. Do not commit it, do not paste it into chat, and delete
the download once step 3 is done.

### 3 — The Apps Script project

1. In `saxtonmove@gmail.com`, go to <https://script.google.com> → **New project**.
2. Paste `Code.gs` into the default file. **Add a second file** (＋ → Script)
   named `parse.gs` and paste `parse.gs.js` into it. Apps Script shares one
   global scope across files, so `Code.gs` can call `parseAlert()` directly.
3. Run **`createLabels`** once — it only makes the three labels, nothing else,
   and needs no properties. Now go back and do step 1, then return here.
4. **Project Settings → Script Properties → Add script property**, three of them:

   | Property | Value |
   |---|---|
   | `FIREBASE_PROJECT_ID` | `stl-house-hunt` |
   | `SA_CLIENT_EMAIL` | `client_email` from the JSON |
   | `SA_PRIVATE_KEY` | `private_key` from the JSON — the whole thing, `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----`. Literal `\n` or real newlines both work. |

5. Run **`dryRun`** once. Authorise when prompted (it's your own script, so the
   "unverified app" screen is expected — **Advanced → Go to project**). It
   writes nothing; check **Execution log** for `WOULD WRITE …` lines.
6. When that looks right, run **`installTrigger`** once. Done.

## Running it

| Function | What it does |
|---|---|
| `dryRun()` | Parses and logs, writes nothing, relabels nothing. Safe any time. |
| `importAlerts()` | The real thing. Also what the trigger calls. |
| `createLabels()` | Creates the three labels and nothing else. Run this before making the Gmail filter. |
| `installTrigger()` | Creates the 30-minute trigger (and the labels). Idempotent — safe to re-run. |

## How dedupe works

The Firestore document id **is** the listing key — `r-93691791`. A re-sent alert
collides on create and comes back `409 ALREADY_EXISTS`. No read, no query, no
index, and it can't race itself.

Writes are **create-only, never update**. If a home is already on the list
someone may have rated it, changed its status or written notes; an importer
overwriting that because Redfin re-sent the same alert would be the most
annoying thing this could possibly do. Price changes get picked up by a human
opening the listing.

## What imported homes look like

They arrive as **Needs review**, flagged `autoImported`, and are **held out of
Top picks** until someone fills in drive time, walk score and park distance —
the three fields an email can never supply, which carry 7.5 of the 17.5 points
in the match score. Ranking them without those would punish a house for missing
data rather than for being worse.

Their cards also stay quiet about garage, basement and yard. Those default to
none/false, which on an import means *nobody has looked yet*, not *this house
lacks one* — a red "No garage" there would be inventing a fact.

Top picks shows a count of held homes with a jump link, so they can't be
silently forgotten.

## When it breaks

It will. Zillow and Redfin change their email templates with no notice and no
versioning, and the parser matches on their text.

The failure mode is designed to be loud: a message that yields no listings gets
labelled `HouseHunt/Unparsed` and **you get an email**. Silence means it's
working. If a batch stops parsing, download one of the alerts and run:

```bash
node importer/test.js path/to/message.eml
```

Real samples are gitignored — they carry the recipient's address and
account-linked tracking tokens. Keep them outside the repo and pass the path.

## Status

- **Redfin — calibrated** against a real favourite-nudge alert. Single listings
  verified end to end; multi-listing digests covered by a fixture but not yet by
  a real email.
- **Zillow — unverified.** Written against the usual
  `/homedetails/<slug>/<zpid>_zpid/` URL shape, but no sample has been tested.
  Given Redfin turned out to be the *reverse* of the obvious approach, treat
  every Zillow field as a guess until one is run through `test.js`.
