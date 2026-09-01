/* Node test for the alert parsers.
   Loads parse.gs.js by eval so Apps Script and this test share one source
   file with no module syntax between them.

   Usage:  node importer/test.js  [path/to/message.eml ...]
   With no arguments it runs the built-in fixtures only. Real .eml samples
   are deliberately NOT committed — they carry account-linked tracking
   tokens and the recipient's address. Keep them outside the repo and pass
   the path in. */

const fs = require('fs');
const path = require('path');

eval(fs.readFileSync(path.join(__dirname, 'parse.gs.js'), 'utf8'));

/* ---- .eml -> { text, html } ---- */
function readEml(file) {
  const raw = fs.readFileSync(file, 'latin1');
  const parts = raw.split(/\r?\n--[-\w]+/);
  let html = '', text = '';
  for (const p of parts) {
    const i = p.search(/\r?\n\r?\n/);
    if (i < 0) continue;
    const hdr = p.slice(0, i);
    let body = p.slice(i).replace(/^\r?\n\r?\n/, '');
    if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(hdr)) {
      body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi,
        (m, h) => String.fromCharCode(parseInt(h, 16)));
    }
    body = Buffer.from(body, 'latin1').toString('utf8');
    if (/Content-Type:\s*text\/html/i.test(hdr)) html = body;
    else if (/Content-Type:\s*text\/plain/i.test(hdr)) text = body;
  }
  return { text, html };
}

let failures = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label +
    (ok ? '  = ' + got : '  expected ' + want + ', got ' + got));
}

/* ---- fixture: the shape of a Redfin favourite nudge ---- */
const REDFIN_ONE = `
 Ready to see this home in person?
Schedule a tour
<https://www.redfin.com/myredfin/next-tour/add-with-login?listingId=222734826&propertyId=93691791>
<https://www.redfin.com/MO/Saint-Louis/2817-Nebraska-Ave-63118/home/93691791?utm_channel=img>
 $214,000  <>
 2 Beds · 1 Bath · 1,452 Sq Ft  <>
2817 Nebraska Ave
<https://www.redfin.com/MO/Saint-Louis/2817-Nebraska-Ave-63118/home/93691791?utm_channel=addr>
Saint Louis, MO 63118
 lender-paid credit of 0.75% of the loan amount, up to $6,000.
`;

/* ---- fixture: a two-listing digest, to prove chunking ---- */
const REDFIN_MANY = `
New listings matching Saint Louis
<https://www.redfin.com/MO/Kirkwood/412-W-Adams-Ave-63122/home/11111111?utm_channel=img>
 $449,000
 3 Beds · 2.5 Baths · 1,980 Sq Ft
<https://www.redfin.com/MO/Maplewood/2915-Sutton-Blvd-63143/home/22222222?utm_channel=img>
 $339,000
 3 Beds · 2 Baths · 1,560 Sq Ft
 up to $6,000 lender credit
`;

console.log('\nRedfin — single listing');
let r = parseRedfin(REDFIN_ONE);
check('count', r.length, 1);
check('key', r[0].key, 'r-93691791');
check('address', r[0].name, '2817 Nebraska Ave');
check('city', r[0].neigh, 'Saint Louis');
check('zip', r[0].zip, '63118');
check('price', r[0].price, 214000);
check('beds', r[0].beds, '2');
check('baths', r[0].baths, 1);
check('sqft', r[0].sqft, 1452);
check('url clean', /^https:\/\/www\.redfin\.com\/MO\/Saint-Louis\/.*\/home\/93691791$/.test(r[0].url), true);
check('footer $6,000 not taken as price', r[0].price !== 6000, true);

console.log('\nRedfin — two-listing digest (chunking must not bleed)');
r = parseRedfin(REDFIN_MANY);
check('count', r.length, 2);
check('#1 key', r[0].key, 'r-11111111');
check('#1 price', r[0].price, 449000);
check('#1 sqft', r[0].sqft, 1980);
check('#2 key', r[1].key, 'r-22222222');
check('#2 price', r[1].price, 339000);
check('#2 sqft', r[1].sqft, 1560);
check('#2 city', r[1].neigh, 'Maplewood');

console.log('\nNon-matching input');
check('empty text -> []', parseRedfin('').length, 0);
check('unrelated text -> []', parseRedfin('hello there').length, 0);
check('parseAlert falls through to Zillow', parseAlert('no listings here', '').length, 0);

/* ---- real samples passed on the command line ---- */
const files = process.argv.slice(2);
for (const f of files) {
  console.log('\nReal sample: ' + path.basename(f));
  const { text, html } = readEml(f);
  const recs = parseAlert(text, html);
  console.log('  parsed ' + recs.length + ' listing(s)');
  recs.forEach(x => console.log('  ' + JSON.stringify(x, null, 2).replace(/\n/g, '\n  ')));
  if (!recs.length) { failures++; console.log('  FAIL — nothing parsed'); }
}

console.log(failures ? '\n' + failures + ' check(s) failed\n' : '\nall checks pass\n');
process.exit(failures ? 1 : 0);
