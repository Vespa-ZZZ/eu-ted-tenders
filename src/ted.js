// Pure helpers for the TED (Tenders Electronic Daily) Search API v3.
// API: https://docs.ted.europa.eu/api/latest/search.html  Reuse: Commission Decision 2011/833/EU.

export const SEARCH_URL = 'https://api.ted.europa.eu/v3/notices/search';
export const SOURCE = 'TED — Tenders Electronic Daily, Publications Office of the European Union';

// Fields requested from the API. Winner / tenderer fields are deliberately not requested
// (they can identify natural persons).
export const FIELDS = [
    'publication-number', 'publication-date', 'notice-type', 'notice-title', 'buyer-name', 'buyer-country',
    'buyer-city', 'classification-cpv', 'contract-nature', 'procedure-type', 'place-of-performance',
    'deadline-receipt-tender-date-lot', 'deadline-receipt-tender-time-lot', 'title-lot', 'estimated-value-proc', 'estimated-value-cur-proc', 'links',
];

export const NOTICE_TYPES = [
    'cn-standard', 'cn-social', 'cn-desg', 'pin-only', 'pin-cfc-standard', 'pin-cfc-social', 'pin-rtl',
    'can-standard', 'can-social', 'can-desg', 'can-tran', 'can-modif', 'veat', 'qu-sy', 'subco', 'pmc', 'corr',
];

export class InputError extends Error {}

const ISO3 = /^[A-Z]{3}$/;
const CPV = /^(\d{8})(-\d)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const ymd = (d) => d.replace(/-/g, '');

/** Build a TED expert query from structured input. */
export function buildQuery({ keywords = [], cpvCodes = [], countries = [], noticeTypes = [], publishedFrom, publishedTo, customQuery } = {}) {
    const parts = [];
    const kw = keywords.map((k) => String(k).replace(/["\\()]/g, ' ').trim()).filter(Boolean);
    if (kw.length) parts.push(`(${kw.map((k) => `FT ~ ("${k}")`).join(' OR ')})`);
    if (cpvCodes.length) {
        const codes = cpvCodes.map((c) => {
            const m = CPV.exec(String(c).trim());
            if (!m) throw new InputError(`Invalid CPV code "${c}" (expected 8 digits, e.g. 72000000).`);
            return m[1];
        });
        parts.push(`classification-cpv IN (${[...new Set(codes)].join(' ')})`);
    }
    if (countries.length) {
        const cs = countries.map((c) => String(c).trim().toUpperCase());
        const bad = cs.filter((c) => !ISO3.test(c));
        if (bad.length) throw new InputError(`Invalid country code(s): ${bad.join(', ')} (use ISO 3166 alpha-3, e.g. DEU, FRA).`);
        parts.push(`buyer-country IN (${[...new Set(cs)].join(' ')})`);
    }
    if (noticeTypes.length) {
        const bad = noticeTypes.filter((t) => !NOTICE_TYPES.includes(t));
        if (bad.length) throw new InputError(`Unknown notice type(s): ${bad.join(', ')}`);
        parts.push(`notice-type IN (${[...new Set(noticeTypes)].join(' ')})`);
    }
    for (const [name, v, op] of [['publishedFrom', publishedFrom, '>='], ['publishedTo', publishedTo, '<=']]) {
        if (!v) continue;
        if (!DATE.test(v) || Number.isNaN(Date.parse(v)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
            throw new InputError(`${name} must be a valid date YYYY-MM-DD.`);
        }
        parts.push(`publication-date ${op} ${ymd(v)}`);
    }
    if (publishedFrom && publishedTo && publishedFrom > publishedTo) throw new InputError('publishedFrom must not be later than publishedTo.');
    if (customQuery && String(customQuery).trim()) parts.push(`(${String(customQuery).trim()})`);
    if (!parts.length) throw new InputError('Provide at least one filter (keywords, CPV codes, countries, dates or a custom query).');
    return parts.join(' AND ');
}

const uniq = (a) => [...new Set((a ?? []).filter((x) => x !== null && x !== undefined && x !== ''))];

/** Pick a value from a TED language map ({eng: ..., deu: ...}) in the preferred language. */
export function pickLang(map, preferred = 'eng') {
    if (!map || typeof map !== 'object') return { text: null, lang: null };
    const order = [preferred, 'eng', 'mul', ...Object.keys(map)];
    for (const lang of order) {
        const v = map[lang];
        if (v !== undefined && v !== null && (!Array.isArray(v) || v.length)) return { text: v, lang };
    }
    return { text: null, lang: null };
}

const dateOnly = (s) => (typeof s === 'string' ? s.slice(0, 10) : null);

/** Remove e-mail addresses and phone numbers from free text (titles sometimes include a contact). */
export function redactContacts(text) {
    if (typeof text !== 'string') return text ?? null;
    return text
        .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[redacted]')
        .replace(/(?<![\w/])(?:\+\d{1,3}[\s.-]?)?(?:\(0\)[\s.-]?)?0?\d{2,5}[\s.-]\d{3,4}[\s.-]?\d{3,4}(?![\w/])/g, '[redacted]')
        // international numbers without separators, e.g. +33123456789
        .replace(/\+\d{8,15}(?!\d)/g, '[redacted]')
        // French style pairs, e.g. 01 23 45 67 89 / 01.23.45.67.89
        .replace(/(?<!\d)0\d(?:[\s.-]\d{2}){4}(?!\d)/g, '[redacted]')
        // area code in parentheses, e.g. (030) 1234567 or (01) 234 5678
        .replace(/\(\d{2,5}\)[\s.-]?\d{2,5}(?:[\s.-]?\d{2,5}){0,3}/g, '[redacted]');
}

/**
 * Combine lot deadline dates ("2026-12-14+01:00") with times ("12:00:00+01:00") into ISO date-times.
 * Without a time the end of that day in the date's own offset is used.
 */
export function deadlineDateTimes(dates = [], times = []) {
    const out = [];
    (dates ?? []).forEach((d, i) => {
        const m = /^(\d{4}-\d{2}-\d{2})(Z|[+-]\d{2}:\d{2})?$/.exec(String(d ?? ''));
        if (!m) return;
        const t = /^(\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})?$/.exec(String((times ?? [])[i] ?? ''));
        const time = t ? (t[1].length === 5 ? `${t[1]}:00` : t[1]) : '23:59:59';
        const tz = (t && t[2]) || m[2] || 'Z';
        out.push(`${m[1]}T${time}${tz}`);
    });
    return [...new Set(out)].sort((a, b) => Date.parse(a) - Date.parse(b));
}

/** Map an API notice to a flat, documented record. */
export function normalizeNotice(n, { language = 'eng' } = {}) {
    if (!n || typeof n['publication-number'] !== 'string') throw new Error('TED returned a notice without publication-number');
    const title = pickLang(n['notice-title'], language);
    const buyer = pickLang(n['buyer-name'], language);
    const city = pickLang(n['buyer-city'], language);
    const lots = pickLang(n['title-lot'], language);
    const deadlines = deadlineDateTimes(n['deadline-receipt-tender-date-lot'], n['deadline-receipt-tender-time-lot']);
    const html = n.links?.html ?? {};
    const langUpper = language.toUpperCase();
    const pub = n['publication-number'];
    const valueRaw = Array.isArray(n['estimated-value-proc']) ? n['estimated-value-proc'][0] : n['estimated-value-proc'];
    const value = valueRaw === undefined || valueRaw === null || valueRaw === '' ? null : Number(valueRaw);
    const cur = Array.isArray(n['estimated-value-cur-proc']) ? n['estimated-value-cur-proc'][0] : n['estimated-value-cur-proc'];
    return {
        publicationNumber: pub,
        publicationDate: dateOnly(n['publication-date']),
        noticeType: n['notice-type'] ?? null,
        title: redactContacts(typeof title.text === 'string' ? title.text : Array.isArray(title.text) ? title.text[0] : null),
        titleLanguage: title.lang,
        buyerName: Array.isArray(buyer.text) ? buyer.text[0] : buyer.text,
        buyerCountry: uniq(n['buyer-country'])[0] ?? null,
        buyerCity: Array.isArray(city.text) ? city.text[0] : city.text,
        cpvCodes: uniq(n['classification-cpv']),
        contractNature: uniq(n['contract-nature']),
        procedureType: n['procedure-type'] ?? null,
        placeOfPerformance: uniq(n['place-of-performance']),
        deadlines,
        earliestDeadline: deadlines[0] ?? null,
        lotTitles: uniq((Array.isArray(lots.text) ? lots.text : lots.text ? [lots.text] : []).map(redactContacts)),
        estimatedValue: Number.isFinite(value) ? value : null,
        estimatedValueCurrency: Number.isFinite(value) ? (cur ?? null) : null,
        noticeUrl: html[langUpper] ?? html.ENG ?? `https://ted.europa.eu/en/notice/-/detail/${pub}`,
        pdfUrl: n.links?.pdf?.[langUpper] ?? n.links?.pdf?.ENG ?? null,
        xmlUrl: n.links?.xml?.MUL ?? null,
        source: SOURCE,
    };
}

export function sanitize(message) {
    return String(message)
        .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
        .replace(/\/(?:home|Users|root|tmp|var|usr)\/[^\s'"`)]*/g, '<path>');
}
