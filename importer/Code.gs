/* =====================================================================
   Saxton House Hunt — Gmail -> Firestore importer  (Google Apps Script)
   ---------------------------------------------------------------------
   Runs in the saxtonmove@gmail.com account on a time trigger. Reads the
   alert label, parses each message with parseAlert() from parse.gs.js,
   and writes new homes straight into the same `listings` collection the
   web app reads. The app needs no changes: its live snapshot listener
   makes imported homes appear on both your screens within a second.

   Setup is in importer/README.md. Nothing here is secret except the two
   service-account properties, which live in Script Properties and must
   never be committed.
   ===================================================================== */

var LABEL_IN     = 'HouseHunt/Alerts';     // where Gmail filters deposit alerts
var LABEL_DONE   = 'HouseHunt/Imported';   // successfully parsed and written
var LABEL_STUCK  = 'HouseHunt/Unparsed';   // nothing found — needs a human
var MAX_THREADS  = 40;                     // per run, keeps well inside quota

/* =====================================================================
   ENTRY POINTS
   ===================================================================== */

/* The trigger calls this. */
function importAlerts() { return run(false); }

/* Run by hand from the editor to see what WOULD happen. Writes nothing,
   relabels nothing. Check the execution log. */
function dryRun() { return run(true); }

/* Run once by hand after setting the script properties. */
function installTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'importAlerts') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('importAlerts').timeBased().everyMinutes(30).create();
  getLabel(LABEL_IN); getLabel(LABEL_DONE); getLabel(LABEL_STUCK);
  Logger.log('Trigger installed: importAlerts every 30 minutes. Labels created.');
}

/* =====================================================================
   MAIN
   ===================================================================== */
function run(dry) {
  var props = PropertiesService.getScriptProperties();
  var projectId = props.getProperty('FIREBASE_PROJECT_ID');
  if (!projectId) throw new Error('Set FIREBASE_PROJECT_ID in Script Properties. See README.');

  var inbox = getLabel(LABEL_IN);
  var done  = getLabel(LABEL_DONE);
  var stuck = getLabel(LABEL_STUCK);

  // -label: on both outcomes so a rerun never reprocesses, and so a message
  // parked in Unparsed does not come back every 30 minutes forever.
  var query = 'label:"' + LABEL_IN + '" -label:"' + LABEL_DONE + '" -label:"' + LABEL_STUCK + '"';
  var threads = GmailApp.search(query, 0, MAX_THREADS);

  var token = dry ? null : getAccessToken();
  var added = [], dupes = [], failed = [], unparsed = [];

  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages();
    var foundInThread = 0;

    for (var i = 0; i < msgs.length; i++) {
      var msg = msgs[i];
      var recs;
      try {
        recs = parseAlert(msg.getPlainBody(), msg.getBody());
      } catch (e) {
        failed.push(msg.getSubject() + ' — parser threw: ' + e.message);
        continue;
      }

      for (var r = 0; r < recs.length; r++) {
        var rec = recs[r];
        foundInThread++;
        if (dry) { Logger.log('WOULD WRITE ' + rec.key + '  ' + rec.name + '  $' + rec.price); continue; }

        var res = createListing(projectId, token, rec);
        if (res === 'created')       added.push(rec.key + '  ' + rec.name + '  $' + fmt(rec.price));
        else if (res === 'exists')   dupes.push(rec.key);
        else                         failed.push(rec.key + ' — ' + res);
      }
    }

    if (dry) continue;
    // Label per thread, not per message: Gmail labels are thread-level, and
    // a digest thread with one unparsable message should not be re-read.
    threads[t].addLabel(foundInThread > 0 ? done : stuck);
    if (foundInThread === 0) unparsed.push(threads[t].getFirstMessageSubject());
  }

  var summary = {
    scanned: threads.length, added: added.length,
    duplicates: dupes.length, unparsed: unparsed.length, errors: failed.length
  };
  Logger.log(JSON.stringify(summary));
  if (added.length)    Logger.log('Added:\n  ' + added.join('\n  '));
  if (unparsed.length) Logger.log('Unparsed:\n  ' + unparsed.join('\n  '));
  if (failed.length)   Logger.log('Errors:\n  ' + failed.join('\n  '));

  /* Report only when something needs a human. A parser that quietly stops
     matching after a template change is the most likely way this breaks,
     and silence is exactly how that goes unnoticed for a month. */
  if (!dry && (unparsed.length || failed.length)) notify(summary, unparsed, failed);
  return summary;
}

function notify(summary, unparsed, failed) {
  var lines = ['The house-hunt importer needs a look.', '', JSON.stringify(summary)];
  if (unparsed.length) lines.push('', 'Nothing found in these (labelled ' + LABEL_STUCK + '):', '  ' + unparsed.join('\n  '));
  if (failed.length)   lines.push('', 'Errors:', '  ' + failed.join('\n  '));
  lines.push('', 'If a batch of alerts stopped parsing, the sender probably changed their',
                 'email template. Forward one to whoever maintains importer/parse.gs.js.');
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
    'House hunt importer: ' + unparsed.length + ' unparsed, ' + failed.length + ' errors',
    lines.join('\n'));
}

/* =====================================================================
   FIRESTORE
   ---------------------------------------------------------------------
   The document id IS the listing key (r-93691791), so a re-sent alert
   collides on create and returns 409 ALREADY_EXISTS. That is the whole
   dedupe: no read, no query, no index, and it cannot race itself.

   Deliberately create-only. If a home is already on the list, someone may
   have edited it, rated it or written notes — an importer overwriting
   that because Redfin re-sent the same alert would be the single most
   annoying thing this could do. Price changes are picked up by a human
   opening the listing, not by clobbering.
   ===================================================================== */
function createListing(projectId, token, rec) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + projectId +
            '/databases/(default)/documents/listings?documentId=' + encodeURIComponent(rec.key);

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ fields: toFirestoreFields(rec) }),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  if (code === 200) return 'created';
  if (code === 409) return 'exists';
  return 'HTTP ' + code + ' ' + res.getContentText().slice(0, 300);
}

/* Firestore REST wants every value tagged with its type. Defaults here must
   match the shape assets/app.js writes for a hand-added home, or the two
   kinds of listing behave differently in the UI. */
function toFirestoreFields(rec) {
  var now = new Date();
  var f = {};
  var S = function (k, v) { f[k] = { stringValue: String(v == null ? '' : v) }; };
  var I = function (k, v) { f[k] = { integerValue: String(Math.round(Number(v) || 0)) }; };
  var D = function (k, v) { f[k] = { doubleValue: Number(v) || 0 }; };
  var B = function (k, v) { f[k] = { booleanValue: !!v }; };

  S('name', rec.name);          S('neigh', rec.neigh);
  I('price', rec.price);        S('beds', rec.beds || '3');
  D('baths', rec.baths);        I('sqft', rec.sqft);
  D('lot', 0);                  I('year', 0);
  S('garage', 'none');          S('basement', 'none');   B('yard', false);
  I('hoa', 0);                  I('taxes', 0);

  /* The three the score needs and an email can never supply. drive and walk
     are 0; park is "" because 0 miles and unknown are different answers.
     needsDetails() in the app keys off exactly these. */
  I('drive', 0);                I('walk', 0);
  S('park', '');                S('parkName', '');

  I('dom', 0);
  S('status', 'needs-review');  S('source', rec.source);
  S('url', rec.url);            S('photo', rec.photo || '');
  S('notes', '');               S('zip', rec.zip || '');
  B('autoImported', true);      S('addedBy', 'importer');

  I('ratingJake', 0);           I('ratingJacki', 0);
  S('noteJake', '');            S('noteJacki', '');

  // `added` drives the app's orderBy — a document without it is invisible.
  f.added = { timestampValue: now.toISOString() };
  I('addedMs', now.getTime());
  return f;
}

/* =====================================================================
   AUTH — service account, signed here, no libraries
   ---------------------------------------------------------------------
   A service account token bypasses firestore.rules entirely, which is why
   the importer is not in the allowlist and why this key must stay in
   Script Properties and out of the repo.
   ===================================================================== */
function getAccessToken() {
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty('SA_CLIENT_EMAIL');
  var key   = props.getProperty('SA_PRIVATE_KEY');
  if (!email || !key) throw new Error('Set SA_CLIENT_EMAIL and SA_PRIVATE_KEY in Script Properties. See README.');

  // Pasting the JSON turns real newlines into \n; both forms must work.
  key = key.replace(/\\n/g, '\n');

  var now = Math.floor(Date.now() / 1000);
  var enc = function (o) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  };
  var unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  });
  var signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(unsigned, key)).replace(/=+$/, '');

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + signature
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Token request failed: ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText()).access_token;
}

/* =====================================================================
   SMALL HELPERS
   ===================================================================== */
function getLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
function fmt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
