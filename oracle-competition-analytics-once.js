#!/usr/bin/env node
'use strict';

const { runCompetitionAnalyticsPhase1 } = require('./lib/competition-analytics-phase1');

console.log('=== COMPETITION_ANALYTICS_ONCE_BEGIN ===');

runCompetitionAnalyticsPhase1()
    .then(result => {
        console.log(`PROCESSED=${Number(result.processed || 0)}`);
        console.log(`TOTAL_ELIGIBLE=${Number(result.totalEligible || 0)}`);
        console.log(`STORED=${Number(result.stored || 0)}`);
        console.log(`READY=${Number(result.ready || 0)}`);
        console.log('COMPETITION_ANALYTICS_ONCE=PASS');
        console.log('=== COMPETITION_ANALYTICS_ONCE_END ===');
    })
    .catch(error => {
        console.error(`COMPETITION_ANALYTICS_ONCE_ERROR=${String(error && error.message || error)}`);
        console.error('COMPETITION_ANALYTICS_ONCE=FAIL');
        process.exitCode = 1;
    });
