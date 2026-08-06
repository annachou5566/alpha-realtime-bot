from pathlib import Path

path = Path('index.js')
text = path.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    text = text.replace(old, new, 1)

replace_once(
    "    buildTournamentBoundaries,\n",
    "    buildViewBoundaries,\n    buildTournamentBoundaries,\n",
    'import view boundaries',
)
replace_once(
    "            const boundaries = buildTournamentBoundaries(config);\n            if (!boundaries.length) continue;\n\n            const previous = PRICE_SERIES_CACHE[id] || {};\n",
    "            const views = buildViewBoundaries(config);\n            const boundaries = buildTournamentBoundaries(config);\n            if (!views || !boundaries.length) continue;\n\n            const previous = PRICE_SERIES_CACHE[id] || {};\n",
    'build dual views',
)
replace_once(
    "                version: 2,\n                boundaryModel: 'utc-calendar',\n",
    "                version: 3,\n                boundaryModel: 'dual',\n",
    'series version',
)
replace_once(
    "                endAt: boundaries[boundaries.length - 1].boundaryAt,\n                points: reconcileBoundaryPoints(previous.points, boundaries),\n",
    "                endAt: boundaries[boundaries.length - 1].boundaryAt,\n                views: {\n                    tournamentDay: views.tournamentDay,\n                    utcCalendar: views.utcCalendar,\n                },\n                points: reconcileBoundaryPoints(previous.points, boundaries),\n",
    'store view boundaries',
)
replace_once(
    "            const knownSlots = new Set(existing.points.map(point => Number(point.slot)));\n",
    "            const knownBoundaries = new Set(existing.points.map(point => Number(point.boundaryAt)));\n",
    'timestamp ownership',
)
replace_once(
    "                if (knownSlots.has(boundary.slot) || boundary.boundaryAt > now - 15_000) continue;\n",
    "                if (knownBoundaries.has(boundary.boundaryAt) || boundary.boundaryAt > now - 15_000) continue;\n",
    'skip known boundary',
)
replace_once(
    "                    kind: boundary.kind,\n",
    "                    kind: boundary.owners.length > 1 ? 'shared' : boundary.kinds[boundary.owners[0]],\n                    owners: boundary.owners,\n                    kinds: boundary.kinds,\n                    indices: boundary.indices,\n",
    'point ownership',
)
replace_once(
    "                existing.points.sort((a, b) => a.slot - b.slot);\n                knownSlots.add(boundary.slot);\n",
    "                existing.points.sort((a, b) => Number(a.boundaryAt) - Number(b.boundaryAt));\n                knownBoundaries.add(boundary.boundaryAt);\n",
    'sort by timestamp',
)
replace_once(
    "    res.json({ version: 2, boundaryModel: 'utc-calendar', updatedAt: PRICE_SERIES_LAST_UPDATED_AT || null, data });\n",
    "    res.json({ version: 3, boundaryModel: 'dual', updatedAt: PRICE_SERIES_LAST_UPDATED_AT || null, data });\n",
    'API contract',
)

path.write_text(text, encoding='utf-8')
print(f'patched {path}')
