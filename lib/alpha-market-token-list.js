'use strict';

function selectFreshAlphaTokenList(currentList, aggregateList) {
    if (!Array.isArray(aggregateList) || aggregateList.length === 0) {
        return Array.isArray(currentList) ? currentList : [];
    }
    return aggregateList;
}

module.exports = {
    selectFreshAlphaTokenList,
};
