from pathlib import Path

runtime_path = Path('index.js')
runtime = runtime_path.read_text(encoding='utf-8')
required_runtime_contracts = [
    'buildViewBoundaries,',
    "version: 3,\n                boundaryModel: 'dual',",
    'knownBoundaries = new Set(existing.points.map(point => Number(point.boundaryAt)))',
    "res.json({ version: 3, boundaryModel: 'dual'",
]
missing = [contract for contract in required_runtime_contracts if contract not in runtime]
if missing:
    raise SystemExit(f'dual Price runtime is incomplete: {missing}')

lib_path = Path('lib/competition-price-series.js')
lib = lib_path.read_text(encoding='utf-8')
old = """    return [...ownersByTimestamp.values()]
        .sort((a, b) => a.boundaryAt - b.boundaryAt)
        .map((boundary, slot) => ({ ...boundary, slot }));
"""
new = """    return [...ownersByTimestamp.values()]
        .sort((a, b) => a.boundaryAt - b.boundaryAt)
        .map((boundary, slot) => ({
            ...boundary,
            slot,
            kind: boundary.owners.length > 1
                ? 'shared'
                : boundary.kinds[boundary.owners[0]],
        }));
"""
if old in lib:
    lib_path.write_text(lib.replace(old, new, 1), encoding='utf-8')
elif new not in lib:
    raise SystemExit('dual Price boundary ownership block is not recognized')

print('validated dual Price runtime and patched boundary ownership if needed')
