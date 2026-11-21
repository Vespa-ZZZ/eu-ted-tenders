import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildQuery, normalizeNotice, pickLang, FIELDS, InputError, sanitize } from '../src/ted.js';

const page = JSON.parse(readFileSync(new URL('./fixtures/search-page.json', import.meta.url), 'utf8'));

test('buildQuery combines filters into a TED expert query', () => {
    const q = buildQuery({
        keywords: ['cloud', 'data "lake"'], cpvCodes: ['72000000-5', '48000000'], countries: ['deu', 'FRA'],
        noticeTypes: ['cn-standard'], publishedFrom: '2026-11-01', publishedTo: '2026-11-20',
    });
    assert.equal(q, '(FT ~ ("cloud") OR FT ~ ("data  lake")) AND classification-cpv IN (72000000 48000000) AND buyer-country IN (DEU FRA) AND notice-type IN (cn-standard) AND publication-date >= 20261101 AND publication-date <= 20261120');
    assert.equal(buildQuery({ customQuery: 'buyer-city = Wien' }), '(buyer-city = Wien)');
});

test('buildQuery validates input', () => {
    assert.throws(() => buildQuery({}), InputError);
    assert.throws(() => buildQuery({ cpvCodes: ['7200'] }), /Invalid CPV/);
    assert.throws(() => buildQuery({ countries: ['DE'] }), /alpha-3/);
    assert.throws(() => buildQuery({ noticeTypes: ['foo'] }), /Unknown notice type/);
    assert.throws(() => buildQuery({ publishedFrom: '2026/11/01' }), /YYYY-MM-DD/);
});

test('no winner / tenderer fields are requested', () => {
    assert.ok(!FIELDS.some((f) => /winner|tenderer/.test(f)));
});

test('pickLang prefers the requested language, then English, then any', () => {
    assert.deepEqual(pickLang({ deu: 'a', eng: 'b' }, 'deu'), { text: 'a', lang: 'deu' });
    assert.deepEqual(pickLang({ deu: 'a', eng: 'b' }, 'fra'), { text: 'b', lang: 'eng' });
    assert.deepEqual(pickLang({ deu: 'a' }, 'fra'), { text: 'a', lang: 'deu' });
    assert.deepEqual(pickLang(undefined), { text: null, lang: null });
});

test('normalizeNotice flattens a real notice', () => {
    const r = normalizeNotice(page.notices[0], { language: 'eng' });
    assert.equal(r.publicationNumber, '757629-2026');
    assert.equal(r.publicationDate, '2026-11-02');
    assert.equal(r.noticeType, 'cn-standard');
    assert.equal(r.titleLanguage, 'eng');
    assert.ok(r.title.length > 5);
    assert.equal(r.buyerName, 'Dataport AöR');
    assert.equal(r.buyerCountry, 'DEU');
    assert.equal(r.buyerCity, 'Altenholz');
    assert.deepEqual(r.cpvCodes, ['72000000']);
    assert.deepEqual(r.contractNature, ['services']);
    assert.deepEqual(r.deadlines, ['2026-11-04T23:59:59+01:00']);
    assert.equal(r.earliestDeadline, '2026-11-04T23:59:59+01:00');
    assert.ok(r.lotTitles.length >= 7);
    assert.equal(r.estimatedValue, null);
    assert.match(r.noticeUrl, /^https:\/\/ted\.europa\.eu\/en\/notice\/-\/detail\/757629-2026$/);
    assert.match(r.xmlUrl, /757629-2026\/xml$/);
    const de = normalizeNotice(page.notices[0], { language: 'deu' });
    assert.equal(de.titleLanguage, 'deu');
    assert.match(de.noticeUrl, /\/de\/notice\//);
});

test('estimated value and malformed notices', () => {
    const r = normalizeNotice({ 'publication-number': '1-2026', 'estimated-value-proc': ['125000.5'], 'estimated-value-cur-proc': ['EUR'] });
    assert.equal(r.estimatedValue, 125000.5);
    assert.equal(r.estimatedValueCurrency, 'EUR');
    assert.throws(() => normalizeNotice({}), /publication-number/);
});

test('sanitize', () => {
    const p = ['C:', 'Users', 'someone', 'x'].join('\\');
    assert.equal(sanitize(`ENOENT ${p}`), 'ENOENT <path>');
});

test('deadlines combine date and time with offsets', async () => {
    const { deadlineDateTimes } = await import('../src/ted.js');
    assert.deepEqual(deadlineDateTimes(['2026-12-14+01:00', '2026-12-10+01:00'], ['12:00:00+01:00', '09:30+01:00']),
        ['2026-12-10T09:30:00+01:00', '2026-12-14T12:00:00+01:00']);
    assert.deepEqual(deadlineDateTimes(['2026-12-14Z'], []), ['2026-12-14T23:59:59Z']);
    assert.deepEqual(deadlineDateTimes(undefined, undefined), []);
});

test('contact details in titles are redacted', () => {
    const r = normalizeNotice({
        'publication-number': '2-2026',
        'notice-title': { eng: 'Cleaning – contact jane.doe@example.org or +49 30 1234 5678' },
        'title-lot': { eng: ['Lot 1 – call 030 1234 5678'] },
    });
    assert.doesNotMatch(JSON.stringify(r), /jane\.doe|1234 5678/);
});

test('invalid or reversed dates are rejected', () => {
    assert.throws(() => buildQuery({ publishedFrom: '2026-02-30' }), /valid date/);
    assert.throws(() => buildQuery({ publishedFrom: '2026-11-20', publishedTo: '2026-11-01' }), /not be later/);
});

test('more phone formats are redacted in titles and lot titles', () => {
    for (const phone of ['+33123456789', '01 23 45 67 89', '01.23.45.67.89', '(030) 1234567', '(01) 234 5678']) {
        const r = normalizeNotice({ 'publication-number': '3-2026', 'notice-title': { eng: `Works – tel ${phone}` }, 'title-lot': { eng: [`Lot 1 ${phone}`] } });
        assert.ok(!JSON.stringify(r).includes(phone), phone);
    }
    const keep = normalizeNotice({ 'publication-number': '4-2026', 'notice-title': { eng: 'Lot 2 – 2026-2027 – CPV 72000000 – 15 sites' } });
    assert.equal(keep.title, 'Lot 2 – 2026-2027 – CPV 72000000 – 15 sites');
});
