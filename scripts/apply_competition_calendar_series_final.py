from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


lib_path = Path('lib/competition-price-series.js')
lib = lib_path.read_text()

anchor = "function stableJsonHash(value) {\n"
helper = """function reconcileBoundaryPoints(points, boundaries, toleranceMs = 1000) {
    const expectedBySlot = new Map((Array.isArray(boundaries) ? boundaries : [])
        .map(boundary => [Number(boundary.slot), boundary]));

    return (Array.isArray(points) ? points : [])
        .filter(point => {
            const expected = expectedBySlot.get(Number(point && point.slot));
            const boundaryAt = Number(point && point.boundaryAt);
            const price = Number(point && point.price);
            return !!expected
                && Number.isFinite(boundaryAt)
                && Math.abs(boundaryAt - expected.boundaryAt) <= toleranceMs
                && price > 0;
        })
        .map(point => {
            const expected = expectedBySlot.get(Number(point.slot));
            return {
                ...point,
                boundaryAt: expected.boundaryAt,
                date: expected.date,
                kind: expected.kind,
            };
        })
        .sort((a, b) => Number(a.slot) - Number(b.slot));
}

"""
if helper.strip() not in lib:
    lib = replace_once(lib, anchor, helper + anchor, 'insert reconcileBoundaryPoints')

lib = replace_once(
    lib,
    "    chooseBoundaryPrice,\n    stableJsonHash,\n};\n",
    "    chooseBoundaryPrice,\n    reconcileBoundaryPoints,\n    stableJsonHash,\n};\n",
    'export reconcileBoundaryPoints',
)
lib_path.write_text(lib)

index_path = Path('index.js')
index = index_path.read_text()
index = replace_once(
    index,
    "    chooseBoundaryPrice,\n    stableJsonHash,\n} = require('./lib/competition-price-series');\n",
    "    chooseBoundaryPrice,\n    reconcileBoundaryPoints,\n    stableJsonHash,\n} = require('./lib/competition-price-series');\n",
    'import reconcileBoundaryPoints',
)
index = replace_once(
    index,
    "    let stored = 0;\n    let missing = 0;\n",
    "    let stored = 0;\n    let missing = 0;\n    let migrated = 0;\n",
    'add migrated counter',
)
old_existing = """            const existing = PRICE_SERIES_CACHE[id] || {
                id,
                alphaId: config.alphaId || null,
                symbol: config.symbol || config.name || null,
                startAt: boundaries[0].boundaryAt,
                endAt: boundaries[boundaries.length - 1].boundaryAt,
                points: [],
            };
            const knownSlots = new Set((existing.points || []).map(point => Number(point.slot)));
"""
new_existing = """            const previous = PRICE_SERIES_CACHE[id] || {};
            const existing = {
                ...previous,
                version: 2,
                boundaryModel: 'utc-calendar',
                id,
                alphaId: config.alphaId || previous.alphaId || null,
                symbol: config.symbol || config.name || previous.symbol || null,
                startAt: boundaries[0].boundaryAt,
                endAt: boundaries[boundaries.length - 1].boundaryAt,
                points: reconcileBoundaryPoints(previous.points, boundaries),
            };
            if (stableJsonHash(previous) !== stableJsonHash(existing)) migrated += 1;
            PRICE_SERIES_CACHE[id] = existing;
            const knownSlots = new Set(existing.points.map(point => Number(point.slot)));
"""
index = replace_once(index, old_existing, new_existing, 'replace existing series migration')
index = replace_once(
    index,
    "                    boundaryAt: boundary.boundaryAt,\n                    observedAt: pricePoint.observedAt,\n",
    "                    boundaryAt: boundary.boundaryAt,\n                    date: boundary.date,\n                    kind: boundary.kind,\n                    observedAt: pricePoint.observedAt,\n",
    'store boundary metadata',
)
index = replace_once(
    index,
    "        if (!dryRun && stored > 0) await persistPriceSeriesToR2();\n        return { skipped: false, fetched, stored, missing, series: Object.keys(PRICE_SERIES_CACHE).length };\n",
    "        if (!dryRun && (stored > 0 || migrated > 0)) await persistPriceSeriesToR2();\n        return { skipped: false, fetched, stored, migrated, missing, series: Object.keys(PRICE_SERIES_CACHE).length };\n",
    'persist migrated series',
)
index = replace_once(
    index,
    "    res.json({ version: 1, updatedAt: PRICE_SERIES_LAST_UPDATED_AT || null, data });\n",
    "    res.json({ version: 2, boundaryModel: 'utc-calendar', updatedAt: PRICE_SERIES_LAST_UPDATED_AT || null, data });\n",
    'api version 2',
)
index = replace_once(
    index,
    "        const dryRun = await syncTournamentPriceSeries({ includeHistory: true, maxFetches: 100, dryRun: true });\n",
    "        const dryRun = await syncTournamentPriceSeries({ includeHistory: false, maxFetches: 40, dryRun: true });\n",
    'bound startup dry run',
)
index = replace_once(
    index,
    "            const result = await syncTournamentPriceSeries({ includeHistory: true, maxFetches: 100 });\n",
    "            const result = await syncTournamentPriceSeries({ includeHistory: false, maxFetches: 40 });\n",
    'bound startup backfill',
)
index_path.write_text(index)

test_path = Path('test/competition-price-series.test.js')
test = test_path.read_text()
test = replace_once(
    test,
    "    chooseBoundaryPrice,\n    normalizeKlineRows,\n",
    "    chooseBoundaryPrice,\n    normalizeKlineRows,\n    reconcileBoundaryPoints,\n",
    'import reconcile test helper',
)
extra_test = r"""

test('calendar-series migration drops legacy start-plus-24h points and keeps exact UTC boundaries', () => {
    const boundaries = buildTournamentBoundaries({
        start: '2026-08-04', startTime: '13:00',
        end: '2026-08-11', endTime: '13:00',
    });
    const legacy = [
        { slot: 0, boundaryAt: Date.parse('2026-08-04T13:00:00Z'), price: 1 },
        { slot: 1, boundaryAt: Date.parse('2026-08-05T13:00:00Z'), price: 2 },
        { slot: 2, boundaryAt: Date.parse('2026-08-06T13:00:00Z'), price: 3 },
    ];
    const kept = reconcileBoundaryPoints(legacy, boundaries);
    assert.deepEqual(kept.map(point => point.slot), [0]);
    assert.equal(kept[0].kind, 'start');

    const exact = boundaries.slice(0, 3).map((boundary, index) => ({
        slot: boundary.slot,
        boundaryAt: boundary.boundaryAt,
        price: index + 1,
    }));
    assert.deepEqual(
        reconcileBoundaryPoints(exact, boundaries).map(point => point.date),
        ['2026-08-04', '2026-08-04', '2026-08-05'],
    );
});
"""
if "calendar-series migration drops legacy" not in test:
    test = test.rstrip() + extra_test + "\n"
test_path.write_text(test)
