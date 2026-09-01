/* =====================================================================
   Listing-alert parsers — shared source of truth
   ---------------------------------------------------------------------
   Plain function declarations, no module syntax and no dependencies, so
   this one file is both pasted into Apps Script AND loaded by the Node
   test in importer/test.js. Do not add require/export here.

   WHY PLAIN TEXT AND NOT HTML
   Every listing link in Redfin's HTML part is wrapped in an opaque
   redmail3.redfin.com/u/click tracker — the property id appears zero
   times in the whole HTML body. The text/plain alternative carries the
   direct URLs instead, so it is the only part of the message that says
   which house it is without following an account-tied redirect.
   Plain text is also far more stable than a marketing HTML template.
   ===================================================================== */

/* "Saint-Louis" -> "Saint Louis"; "2817-Nebraska-Ave-63118" -> "2817 Nebraska Ave" + zip */
function slugToWords(slug) {
  return String(slug || '').replace(/-+/g, ' ').trim();
}

function splitAddressSlug(slug) {
  var s = String(slug || '');
  var zip = '';
  var m = s.match(/-(\d{5})$/);
  if (m) { zip = m[1]; s = s.slice(0, -6); }
  return { street: slugToWords(s), zip: zip };
}

/* Redfin quotes "2 Beds · 1 Bath · 1,452 Sq Ft". The separator is a real
   middot in the UTF-8 part; accept any punctuation between the pieces so a
   template tweak to a pipe or a bullet does not silently drop the specs. */
function parseSpecs(chunk) {
  var out = {};
  var bed = chunk.match(/(\d+)\s*Beds?\b/i);
  if (bed) {
    var n = parseInt(bed[1], 10);
    out.beds = n <= 2 ? '2' : n === 3 ? '3' : n === 4 ? '4' : '5+';
  }
  var bath = chunk.match(/([\d.]+)\s*Baths?\b/i);
  if (bath) out.baths = Number(bath[1]);
  var sqft = chunk.match(/([\d,]{3,7})\s*Sq\.?\s*Ft\b/i);
  if (sqft) out.sqft = Number(sqft[1].replace(/,/g, ''));
  return out;
}

/* The largest dollar figure inside the listing's own chunk. Redfin footers
   carry lender-credit figures like $6,000, so this is scoped to the chunk
   rather than run over the whole message, and ignores anything below a
   floor no house in this search will ever be priced under. */
var MIN_PRICE = 10000;

function biggestDollar(chunk) {
  var all = chunk.match(/\$\s?[\d,]{3,10}/g) || [];
  var best = 0, bestAny = 0;
  for (var i = 0; i < all.length; i++) {
    var n = Number(all[i].replace(/[^\d]/g, ''));
    if (n > bestAny) bestAny = n;
    if (n >= MIN_PRICE && n > best) best = n;
  }
  return best || bestAny;
}

/* ---------------------------------------------------------------------
   Redfin. Returns [] when the message is not a Redfin alert, so the caller
   can try each parser in turn without sniffing the sender itself.
   Handles one listing or many: every distinct /home/<id> becomes a record,
   and each one's price and specs are read from the slice of text around it.
   --------------------------------------------------------------------- */
function parseRedfin(text) {
  var RE = /https:\/\/www\.redfin\.com\/([A-Z]{2})\/([^\/\s]+)\/([^\/\s]+)\/home\/(\d+)/g;
  var hits = [], m;
  while ((m = RE.exec(text)) !== null) {
    hits.push({ state: m[1], city: m[2], addr: m[3], id: m[4], at: m.index });
  }
  if (!hits.length) return [];

  // one entry per property, remembering where it was first and last seen
  var byId = {};
  for (var i = 0; i < hits.length; i++) {
    var h = hits[i];
    if (!byId[h.id]) byId[h.id] = { first: h.at, last: h.at, h: h };
    else byId[h.id].last = h.at;
  }
  var ids = Object.keys(byId);

  // chunk boundaries: from a little before this listing's first mention to
  // just before the next listing's, so a digest cannot cross-contaminate
  var starts = [];
  for (var k = 0; k < ids.length; k++) starts.push({ id: ids[k], at: byId[ids[k]].first });
  starts.sort(function (a, b) { return a.at - b.at; });

  var out = [];
  for (var j = 0; j < starts.length; j++) {
    var id = starts[j].id;

    /* Chunks partition strictly at listing boundaries. Only the first
       listing gets a lookback: in a digest, reaching back from listing 2
       crosses listing 1's card and steals its price, which is exactly the
       bug this shape invites. Redfin puts the price after the URL anyway,
       so the lookback only exists for a template that puts it before. */
    var from = (j === 0) ? Math.max(0, starts[j].at - 400) : starts[j].at;
    var to = (j + 1 < starts.length) ? starts[j + 1].at : Math.min(text.length, byId[id].last + 400);
    var chunk = text.slice(from, to);

    var h = byId[id].h;
    var addr = splitAddressSlug(h.addr);
    var specs = parseSpecs(chunk);

    var rec = {
      key: 'r-' + id,
      source: 'Redfin email',
      url: 'https://www.redfin.com/' + h.state + '/' + h.city + '/' + h.addr + '/home/' + id,
      name: addr.street,
      neigh: slugToWords(h.city),
      zip: addr.zip,
      state: h.state,
      price: biggestDollar(chunk)
    };
    if (specs.beds) rec.beds = specs.beds;
    if (specs.baths) rec.baths = specs.baths;
    if (specs.sqft) rec.sqft = specs.sqft;
    out.push(rec);
  }
  return out;
}

/* ---------------------------------------------------------------------
   Zillow. NOT CALIBRATED — no sample yet. Written against Zillow's usual
   /homedetails/<slug>/<zpid>_zpid/ URL shape so the pipeline has something
   to run, but treat every field as unverified until a real alert is tested.
   --------------------------------------------------------------------- */
function parseZillow(text) {
  var RE = /https:\/\/www\.zillow\.com\/homedetails\/([^\/\s]+)\/(\d+)_zpid/g;
  var hits = [], m;
  while ((m = RE.exec(text)) !== null) hits.push({ slug: m[1], zpid: m[2], at: m.index });
  if (!hits.length) return [];

  var seen = {}, out = [];
  for (var i = 0; i < hits.length; i++) {
    var h = hits[i];
    if (seen[h.zpid]) continue;
    seen[h.zpid] = true;
    var to = (i + 1 < hits.length) ? hits[i + 1].at : Math.min(text.length, h.at + 500);
    var chunk = text.slice(Math.max(0, h.at - 400), to);
    var addr = splitAddressSlug(h.slug);
    var specs = parseSpecs(chunk);
    var rec = {
      key: 'z-' + h.zpid,
      source: 'Zillow email',
      url: 'https://www.zillow.com/homedetails/' + h.slug + '/' + h.zpid + '_zpid/',
      name: addr.street,
      neigh: '',
      zip: addr.zip,
      state: '',
      price: biggestDollar(chunk),
      unverified: true
    };
    if (specs.beds) rec.beds = specs.beds;
    if (specs.baths) rec.baths = specs.baths;
    if (specs.sqft) rec.sqft = specs.sqft;
    out.push(rec);
  }
  return out;
}

/* Redfin's hero shot is the one property image not behind the click
   tracker. It lives only in the HTML part and is keyed by listingId, not
   propertyId, so it is matched separately and attached best-effort. */
function findRedfinPhoto(html) {
  var m = String(html || '').match(
    /https:\/\/www\.redfin\.com\/stingray\/do\/api-get-listing-hero-shot\/[0-9a-f]+\/\d+[^"'\s]*/);
  return m ? m[0].replace(/&amp;/g, '&') : '';
}

function parseAlert(text, html) {
  var out = parseRedfin(text);
  if (out.length) {
    var photo = findRedfinPhoto(html);
    if (photo && out.length === 1) out[0].photo = photo;   // only safe to attach when unambiguous
    return out;
  }
  return parseZillow(text);
}
