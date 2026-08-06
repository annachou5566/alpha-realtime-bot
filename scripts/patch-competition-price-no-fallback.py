from pathlib import Path


def replace_between(text, start, end, replacement, label):
    start_index = text.find(start)
    end_index = text.find(end, start_index)
    if start_index < 0 or end_index < 0:
        raise SystemExit(f'{label}: markers not found')
    return text[:start_index] + replacement + text[end_index:]


lib_path = Path('lib/competition-price-series.js')
source = lib_path.read_text()
source = replace_between(
    source,
    'function getCompetitionMultipliers(config) {',
    'function buildTournamentBuckets(config) {',
    """function getCompetitionMultipliers(config) {
    if (!Array.isArray(config && config.multipliers) || !config.multipliers.length) return [];
    const values = config.multipliers.map(value => Number(value));
    return values.every(value => Number.isFinite(value) && value > 0) ? values : [];
}

""",
    'official multipliers only',
)
old_export = """    normalizeUtcTime,
    parseUtcBoundary,
    getCompetitionMultipliers,
"""
if old_export not in source:
    export_anchor = """    normalizeUtcTime,
    parseUtcBoundary,
"""
    if source.count(export_anchor) != 1:
        raise SystemExit('export anchor not found')
    source = source.replace(export_anchor, old_export, 1)
lib_path.write_text(source)

test_path = Path('test/competition-price-series.test.js')
test_source = test_path.read_text()
import_anchor = """    DAY_MS,
    buildTournamentBuckets,
"""
import_replacement = """    DAY_MS,
    getCompetitionMultipliers,
    buildTournamentBuckets,
"""
if 'getCompetitionMultipliers,' not in test_source:
    if test_source.count(import_anchor) != 1:
        raise SystemExit('test import anchor not found')
    test_source = test_source.replace(import_anchor, import_replacement, 1)

contract = r"""

test('missing official multipliers produces no DAY series or dual boundaries', () => {
    const missing = {
        start: '2026-08-04', startTime: '13:00',
        end: '2026-08-11', endTime: '13:00',
        earlyBird: '1.4x',
    };
    assert.deepEqual(getCompetitionMultipliers(missing), []);
    assert.deepEqual(buildTournamentDayBuckets(missing), []);
    assert.equal(buildViewBoundaries(missing), null);
    assert.deepEqual(buildTournamentBoundaries(missing), []);
});

test('invalid multiplier arrays fail closed instead of coercing values to one', () => {
    const invalid = {
        start: '2026-08-04', startTime: '13:00',
        end: '2026-08-11', endTime: '13:00',
        multipliers: [2, '', null, 1],
    };
    assert.deepEqual(getCompetitionMultipliers(invalid), []);
    assert.deepEqual(buildTournamentDayBuckets(invalid), []);
});
"""
if "missing official multipliers produces no DAY series" not in test_source:
    test_source = test_source.rstrip() + contract + '\n'
test_path.write_text(test_source)

print('patched Price v3 to use only official multiplier arrays')
