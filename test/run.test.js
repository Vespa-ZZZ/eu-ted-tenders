import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from '../src/run.js';

const page = JSON.parse(readFileSync(new URL('./fixtures/search-page.json', import.meta.url), 'utf8'));
const NOW = () => new Date('2026-11-03T10:00:00Z');

async function exec(input, respond, state = new Map(), chargeResult, configureActor) {
    const records = [];
    const lifecycle = [];
    const bodies = [];
    const warnings = [];
    const values = new Map();
    let pushes = 0;
    const actor = {
        async init() {},
        async getInput() { return input; },
        async openKeyValueStore() {
            return {
                getValue: async (k) => structuredClone(state.get(k) ?? null),
                setValue: async (k, v) => { state.set(k, structuredClone(v)); },
            };
        },
        async pushData(rows) {
            pushes++;
            records.push(...(chargeResult?.eventChargeLimitReached ? rows.slice(0, chargeResult.chargedCount) : rows));
            return chargeResult;
        },
        async setValue(k, v) { values.set(k, v); },
        async exit() { lifecycle.push('exit'); },
        async fail(m) { lifecycle.push('fail', m); },
    };
    const log = { info() {}, warning(m) { warnings.push(m); }, error() {} };
    const fetchImpl = async (url, init) => {
        const b = JSON.parse(init.body);
        bodies.push(b);
        return respond(b, bodies.length);
    };
    configureActor?.(actor, records);
    await run({ actor, log, fetchImpl, sleep: async () => {}, now: NOW });
    return { records, lifecycle, bodies, state, warnings, pushes, summary: values.get('RUN_SUMMARY') };
}

const ok = (obj) => new Response(JSON.stringify(obj));

test('paginates with iteration tokens and applies a default 7-day window', async () => {
    const r = await exec({ keywords: ['cloud'] }, (b, n) => ok(n === 1
        ? { ...page, iterationNextToken: 'T2' }
        : { notices: [], totalNoticeCount: 3, iterationNextToken: null }));
    assert.deepEqual(r.lifecycle, ['exit']);
    assert.equal(r.records.length, 3);
    assert.match(r.bodies[0].query, /publication-date >= 20261027/);
    assert.equal(r.bodies[0].paginationMode, 'ITERATION');
    assert.equal(r.bodies[1].iterationNextToken, 'T2');
});

test('monitoring mode only returns new notices', async () => {
    const state = new Map();
    const first = await exec({ keywords: ['cloud'], onlyNew: true }, () => ok({ ...page, iterationNextToken: null }), state);
    assert.equal(first.records.length, 3);
    const second = await exec({ keywords: ['cloud'], onlyNew: true }, () => ok({ ...page, iterationNextToken: null }), state);
    assert.equal(second.records.length, 0);
});

test('a partially stored page leaves the remaining notices unseen and stops pagination', async () => {
    const input = { keywords: ['cloud'], onlyNew: true };
    const state = new Map();
    const first = await exec(input, () => ok({ ...page, iterationNextToken: 'MORE' }), state,
        { eventChargeLimitReached: true, chargedCount: 1 });
    assert.deepEqual(first.lifecycle, ['exit']);
    assert.equal(first.bodies.length, 1);
    assert.equal(first.pushes, 1);
    assert.equal(first.summary.pushed, 1);
    assert.match(first.warnings[0], /charge limit reached/i);
    assert.deepEqual(Object.keys(state.get('seen-default')), first.records.map((r) => r.publicationNumber));

    const next = await exec(input, () => ok({ ...page, iterationNextToken: null }), state,
        { eventChargeLimitReached: false, chargedCount: 0 });
    assert.equal(next.summary.pushed, 2);
    assert.ok(next.records.every((r) => r.publicationNumber !== first.records[0].publicationNumber));
});

test('onlyOpen drops notices whose deadlines have passed', async () => {
    const r = await exec({ keywords: ['cloud'], onlyOpen: true }, () => ok({ ...page, iterationNextToken: null }));
    assert.ok(r.records.every((x) => x.deadlines.some((d) => d >= '2026-11-03')));
});

test('API errors, bad input and retries', async () => {
    const bad = await exec({ keywords: ['x'] }, () => new Response(JSON.stringify({ message: 'Query syntax error' }), { status: 400 }));
    assert.match(bad.lifecycle[1], /Query syntax error/);
    const input = await exec({ countries: ['DE'] }, () => { throw new Error('no request expected'); });
    assert.match(input.lifecycle[1], /alpha-3/);
    let n = 0;
    const retry = await exec({ keywords: ['x'] }, () => (n++ === 0 ? new Response('busy', { status: 503 }) : ok({ ...page, iterationNextToken: null })));
    assert.deepEqual(retry.lifecycle, ['exit']);
});

test('maxItems stops paging', async () => {
    const r = await exec({ keywords: ['cloud'], maxItems: 2 }, () => ok({ ...page, iterationNextToken: 'MORE' }));
    assert.equal(r.records.length, 2);
    assert.equal(r.bodies.length, 1);
});

test('onlyOpen compares the deadline time, not just the date', async () => {
    const notice = { ...page.notices[0], 'deadline-receipt-tender-date-lot': ['2026-11-03+01:00'], 'deadline-receipt-tender-time-lot': ['10:00:00+01:00'] };
    const r = await exec({ keywords: ['x'], onlyOpen: true }, () => ok({ notices: [notice], iterationNextToken: null }));
    assert.equal(r.records.length, 0, '10:00+01:00 is before 10:00Z on the same day');
});

test('a timed-out page fails the run instead of reporting no new notices', async () => {
    const r = await exec({ keywords: ['x'], onlyNew: true }, (b, n) => ok(n === 1
        ? { ...page, iterationNextToken: 'T2' }
        : { notices: [], timedOut: true, iterationNextToken: null }));
    assert.equal(r.lifecycle[0], 'fail');
    assert.match(r.lifecycle[1], /timed out/);
});

test('seen notices inside the window are never forgotten (no fixed cap)', async () => {
    const state = new Map([['seen-default', Object.fromEntries(Array.from({ length: 60000 }, (_, i) => [`${i}-2026`, '2026-11-01']))]]);
    await exec({ keywords: ['x'], onlyNew: true }, () => ok({ ...page, iterationNextToken: null }), state);
    const seen = state.get('seen-default');
    assert.ok(seen['0-2026'] && seen['757629-2026']);
    assert.equal(Object.keys(seen).length, 60003);
});

test('a later time-out does not mark earlier pages as seen', async () => {
    const state = new Map();
    await exec({ keywords: ['x'], onlyNew: true }, (b, n) => ok(n === 1 ? { ...page, iterationNextToken: 'T2' } : { notices: [], timedOut: true }), state);
    assert.equal(state.get('seen-default'), undefined);
    const again = await exec({ keywords: ['x'], onlyNew: true }, () => ok({ ...page, iterationNextToken: null }), state);
    assert.equal(again.records.length, 3);
});

test('without a lower date bound, old seen entries are kept', async () => {
    const state = new Map([['seen-default', { '757629-2026': '2020-01-01' }]]);
    const r = await exec({ publishedTo: '2026-11-02', onlyNew: true }, () => ok({ ...page, iterationNextToken: null }), state);
    assert.ok(!r.records.some((x) => x.publicationNumber === '757629-2026'));
    assert.equal(state.get('seen-default')['757629-2026'], '2020-01-01');
});

test('prechecks the dataset item budget and allows non-PPE output', async () => {
    for (const [isPayPerEvent, budget] of [[true, 1], [true, 0], [false, 0]]) {
        const configureActor = (actor, records) => {
            actor.getChargingManager = () => ({
                getPricingInfo: () => ({ isPayPerEvent }),
                calculateMaxEventChargeCountWithinLimit(event) {
                    assert.equal(event, 'apify-default-dataset-item');
                    return budget - records.length;
                },
            });
        };
        const result = await exec({ onlyNew: true }, () => ok({ ...page, iterationNextToken: null }), new Map(), undefined, configureActor);
        assert.deepEqual(result.lifecycle, ['exit']);
        assert.equal(result.records.length, isPayPerEvent ? budget : 3);
        assert.equal(result.summary.pushed, result.records.length);
        assert.equal(result.summary.stopReason, isPayPerEvent ? 'spendingLimit' : undefined);
        assert.equal(result.pushes, result.records.length ? 1 : 0);
    }
});
