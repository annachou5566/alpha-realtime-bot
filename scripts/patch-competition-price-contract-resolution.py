from pathlib import Path

path = Path('index.js')
text = path.read_text()

require_anchor = "} = require('./lib/competition-price-series');\n"
require_line = "const { resolveOfficialAlphaToken } = require('./lib/competition-token-config');\n"
if require_line not in text:
    if text.count(require_anchor) != 1:
        raise SystemExit('competition price-series require anchor not found exactly once')
    text = text.replace(require_anchor, require_anchor + require_line, 1)

scope_start = text.index('async function syncActiveConfig()')
block_start = text.index('                if (meta.alphaId) {', scope_start)
block_end = text.index('            });\n            ACTIVE_CONFIG', block_start)

replacement = """                const officialToken = resolveOfficialAlphaToken(BINANCE_TOKEN_LIST, row, meta);
                if (!meta.alphaId && officialToken && officialToken.alphaId) {
                    meta.alphaId = String(officialToken.alphaId);
                }
                if (!meta.alphaId) return;

                if (officialToken) {
                    meta.contract = officialToken.contractAddress || row.contract || meta.contract;
                    meta.chainId = officialToken.chainId;
                } else {
                    meta.contract = row.contract || meta.contract;
                    if (!meta.chainId && meta.chain) {
                        const cMap = {'bsc': 56, 'bnb': 56, 'eth': 1, 'base': 8453, 'arb': 42161, 'op': 10, 'polygon': 137};
                        meta.chainId = cMap[String(meta.chain).toLowerCase()] || 56;
                    }
                }

                if (isActive) {
                    newActive[meta.alphaId] = { ...meta, db_id: row.id };
                    if (!newTokens.includes(meta.alphaId)) newTokens.push(meta.alphaId);
                } else if (HISTORY_CACHE[meta.alphaId]) {
                    if (meta.history) {
                        HISTORY_CACHE[meta.alphaId].history = meta.history;
                        if (!HISTORY_CACHE[meta.alphaId].data) HISTORY_CACHE[meta.alphaId].data = {};
                        HISTORY_CACHE[meta.alphaId].data.history = meta.history;
                    }
                } else {
                    HISTORY_CACHE[meta.alphaId] = { ...meta, db_id: row.id };
                }
"""

text = text[:block_start] + replacement + text[block_end:]
path.write_text(text)
print('patched Competition Price config resolution')
