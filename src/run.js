import { setTimeout as delay } from 'node:timers/promises';
import { FIELDS, InputError, SEARCH_URL, buildQuery, normalizeNotice, sanitize } from './ted.js';

const USER_AGENT = 'eu-ted-tenders-actor/1.0';
const PAGE_SIZE = 100;
const SEEN_KEEP_DAYS = 400; // seen entries older than the search window (plus margin) are pruned, not capped
const MAX_WAIT_MS = 120000;

const list = (v) => (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean);
const isoDay = (d) => d.toISOString().slice(0, 10);

function retryAfterMs(res) {
    const h = res.headers.get('retry-after');
    if (!h) return 0;
    if (/^\d+$/.test(h)) return Number(h) * 1000;
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}

function makeSearch({ fetchImpl, sleep, intervalMs, log }) {
    let first = true;
    return async (body) => {
        for (let attempt = 0; attempt <= 3; attempt++) {
            if (!first) await sleep(attempt === 0 ? intervalMs : intervalMs * 2 ** attempt);
            first = false;
            let res;
            let text;
            try {
                res = await fetchImpl(SEARCH_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(90000),
                });
                text = await res.text();
            } catch (err) {
                if (attempt === 3) throw new Error(`Network error: ${err.message}`);
                log.warning('Network error, retrying');
                continue;
            }
            let json = null;
            try { json = JSON.parse(text); } catch { /* not JSON */ }
            if (res.ok && json && Array.isArray(json.notices)) return json;
            const detail = json?.message ?? json?.error ?? (res.ok ? 'unexpected response format' : `HTTP ${res.status}`);
            if (res.ok || (res.status !== 429 && res.status < 500)) throw new Error(`TED API: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
            if (attempt === 3) throw new Error(`TED API: HTTP ${res.status} after retries`);
            const wait = retryAfterMs(res);
            if (wait > MAX_WAIT_MS) throw new Error(`TED API: HTTP ${res.status}; asked to wait ${Math.round(wait / 1000)} s — try again later`);
            if (wait > 0) await sleep(wait);
            log.warning(`TED API: HTTP ${res.status}, retrying`);
        }
        throw new Error('TED API request failed');
    };
}

export async function run({ actor, log, fetchImpl = fetch, sleep = delay, now = () => new Date() }) {
    await actor.init();
    try {
        const input = (await actor.getInput()) ?? {};
        const onlyNew = input.onlyNew ?? false;
        const stateKey = input.stateKey || 'default';
        if (!/^[a-zA-Z0-9_-]{1,50}$/.test(stateKey)) throw new InputError('stateKey may only contain letters, digits, "-" and "_" (max 50).');
        const language = String(input.language || 'eng').toLowerCase();
        if (!/^[a-z]{3}$/.test(language)) throw new InputError('language must be a 3-letter code such as eng, deu, fra.');
        const maxItems = Math.max(1, Math.min(Number(input.maxItems ?? 500), 50000));
        const intervalMs = Math.max(2000, Number(input.requestIntervalMs ?? 2000));
        const onlyOpen = input.onlyOpen ?? false;

        let publishedFrom = input.publishedFrom || null;
        if (!publishedFrom && !input.publishedTo && !input.customQuery) {
            const days = Math.max(1, Math.min(Number(input.daysBack ?? 7), 365));
            publishedFrom = isoDay(new Date(now().getTime() - days * 864e5));
        }
        const query = buildQuery({
            keywords: list(input.keywords),
            cpvCodes: list(input.cpvCodes),
            countries: list(input.countries),
            noticeTypes: list(input.noticeTypes),
            publishedFrom,
            publishedTo: input.publishedTo || null,
            customQuery: input.customQuery,
        });
        log.info(`TED query: ${query}`);

        const store = onlyNew ? await actor.openKeyValueStore('eu-ted-tenders-state') : null;
        // seen: publication number -> publication date. Old arrays (no dates) are migrated with today's date.
        const rawSeen = onlyNew ? ((await store.getValue(`seen-${stateKey}`)) ?? {}) : {};
        const seenMap = new Map(Array.isArray(rawSeen) ? rawSeen.map((id) => [id, isoDay(now())]) : Object.entries(rawSeen));
        const seen = { has: (id) => seenMap.has(id) };
        // Prune only when the search has a known lower date bound; otherwise keep every seen entry.
        const pruneBefore = publishedFrom
            ? isoDay(new Date(Math.min(now().getTime() - SEEN_KEEP_DAYS * 864e5, Date.parse(publishedFrom) - 30 * 864e5)))
            : null;

        const search = makeSearch({ fetchImpl, sleep, intervalMs, log });
        let token = null;
        let pushed = 0;
        let total = null;
        let pages = 0;
        do {
            const body = { query, fields: FIELDS, limit: PAGE_SIZE, paginationMode: 'ITERATION', ...(token ? { iterationNextToken: token } : {}) };
            const page = await search(body);
            pages++;
            if (total === null) {
                total = page.totalNoticeCount ?? null;
                log.info(`${total ?? '?'} notices match.`);
            }
            // A timed-out search is incomplete: fail instead of reporting "no new notices".
            if (page.timedOut) throw new Error('TED reported that the search timed out, so results are incomplete. Narrow the filters (shorter date window, CPV or country) and run again.');
            const out = [];
            for (const n of page.notices) {
                const rec = normalizeNotice(n, { language });
                if (seen.has(rec.publicationNumber)) continue;
                if (onlyOpen && !rec.deadlines.some((d) => Date.parse(d) >= now().getTime())) continue;
                out.push(rec);
                if (pushed + out.length >= maxItems) break;
            }
            if (out.length) {
                await actor.pushData(out);
                pushed += out.length;
                // Marked seen in memory only; the state is saved after the whole search completed, so a run
                // that fails on a later page (e.g. a time-out) does not hide its earlier notices from the next run.
                for (const r of out) seenMap.set(r.publicationNumber, r.publicationDate ?? isoDay(now()));
            }
            token = page.notices.length ? page.iterationNextToken : null;
        } while (token && pushed < maxItems);

        if (onlyNew) {
            if (pruneBefore) for (const [id, d] of seenMap) if (d < pruneBefore) seenMap.delete(id);
            await store.setValue(`seen-${stateKey}`, Object.fromEntries(seenMap));
        }

        await actor.setValue('RUN_SUMMARY', { query, totalMatching: total, pushed, pages });
        if (pushed === 0) log.info(onlyNew ? 'No new notices since the last run.' : 'No notices matched.');
        log.info(`Done. Pushed ${pushed} notices.`);
        await actor.exit();
    } catch (err) {
        const msg = sanitize(err.message);
        log.error(err instanceof InputError ? `Invalid input: ${msg}` : msg);
        await actor.fail(msg);
    }
}
