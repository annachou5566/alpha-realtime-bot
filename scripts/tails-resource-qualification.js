#!/usr/bin/env node
'use strict';

const axios = require('axios');
const { runTailsProducer } = require('../lib/tails-producer');

function envInt(name, fallback, min, max) {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

async function main() {
    if (process.env.TAILS_QUALIFICATION_ONLY !== 'true') {
        console.error('TAILS_QUALIFICATION_GATE=FAIL qualification-only flag required');
        process.exitCode = 64;
        return;
    }

    const rawMaxTokens = Number.parseInt(process.env.TAILS_QUAL_MAX_TOKENS || '24', 10);
    const maxTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens === 0
        ? 0
        : Math.min(64, Math.max(4, Number.isFinite(rawMaxTokens) ? rawMaxTokens : 24));
    const concurrency = envInt('TAILS_QUAL_CONCURRENCY', 2, 1, 4);
    const maxRequests = envInt('TAILS_QUAL_MAX_REQUESTS', 320, 40, 2000);

    const startHr = process.hrtime.bigint();
    const startCpu = process.cpuUsage();
    let peakRss = process.memoryUsage().rss;
    let peakHeapUsed = process.memoryUsage().heapUsed;
    const sampler = setInterval(() => {
        const mem = process.memoryUsage();
        peakRss = Math.max(peakRss, mem.rss);
        peakHeapUsed = Math.max(peakHeapUsed, mem.heapUsed);
    }, 100);
    sampler.unref();

    console.log('=== ORACLE_TAILS_QUALIFICATION_BEGIN ===');
    console.log('MODE=QUALIFICATION_ONLY');
    console.log('R2_MUTATION_ALLOWED=NO');
    console.log(`MAX_TOKENS=${maxTokens}`);
    console.log(`CONCURRENCY=${concurrency}`);
    console.log(`REQUEST_BUDGET=${maxRequests}`);

    try {
        const result = await runTailsProducer({
            http: axios,
            qualificationOnly: true,
            maxTokens,
            concurrency,
            maxRequests,
            logger: console,
        });

        const cpu = process.cpuUsage(startCpu);
        const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
        const finalMem = process.memoryUsage();
        peakRss = Math.max(peakRss, finalMem.rss);
        peakHeapUsed = Math.max(peakHeapUsed, finalMem.heapUsed);

        const summary = {
            boundaryDate: result.boundaryDate,
            fullCohortCount: result.fullCohortCount,
            selectedCohortCount: result.selectedCohortCount,
            selectedBscCount: result.selectedBscCount,
            onlineCount: result.onlineCount,
            offlineProbedCount: result.offlineProbedCount,
            offlineRevivedCount: result.offlineRevivedCount,
            offlineExcludedCount: result.offlineExcludedCount,
            offlineInvalidAddressCount: result.offlineInvalidAddressCount,
            supportedLimitCount: result.supportedLimitCount,
            unsupportedLimitCount: result.unsupportedLimitCount,
            payloadBytes: result.payloadBytes,
            httpRequests: result.http.requests,
            httpRetries: result.http.retries,
            httpContractRetries: result.http.contractRetries,
            httpResponseBytes: result.http.responseBytes,
            httpByKind: result.http.byKind,
            durationMs: Math.round(durationMs),
            cpuUserMs: Math.round(cpu.user / 1000),
            cpuSystemMs: Math.round(cpu.system / 1000),
            peakRssMb: Number((peakRss / 1024 / 1024).toFixed(1)),
            peakHeapUsedMb: Number((peakHeapUsed / 1024 / 1024).toFixed(1)),
            r2WritePerformed: false,
        };

        console.log(`TAILS_QUALIFICATION_SUMMARY=${JSON.stringify(summary)}`);
        console.log('TAILS_QUALIFICATION=PASS');
        console.log('=== ORACLE_TAILS_QUALIFICATION_END ===');
    } catch (error) {
        const cpu = process.cpuUsage(startCpu);
        const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
        const mem = process.memoryUsage();
        peakRss = Math.max(peakRss, mem.rss);
        peakHeapUsed = Math.max(peakHeapUsed, mem.heapUsed);

        console.error(`TAILS_QUALIFICATION_ERROR=${String(error && error.message || error)}`);
        console.error(`TAILS_QUALIFICATION_DURATION_MS=${Math.round(durationMs)}`);
        console.error(`TAILS_QUALIFICATION_CPU_USER_MS=${Math.round(cpu.user / 1000)}`);
        console.error(`TAILS_QUALIFICATION_CPU_SYSTEM_MS=${Math.round(cpu.system / 1000)}`);
        console.error(`TAILS_QUALIFICATION_PEAK_RSS_MB=${(peakRss / 1024 / 1024).toFixed(1)}`);
        console.error('TAILS_QUALIFICATION=FAIL');
        console.error('=== ORACLE_TAILS_QUALIFICATION_END ===');
        process.exitCode = 1;
    } finally {
        clearInterval(sampler);
    }
}

main();
