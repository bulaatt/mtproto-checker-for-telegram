#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { parseSavedResultsText } = require('../src/checker/output_persistence');

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        baseline: null,
        current: null
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if ((arg === '--baseline' || arg === '-b') && argv[index + 1]) {
            args.baseline = argv[index + 1];
            index += 1;
            continue;
        }
        if ((arg === '--current' || arg === '-c') && argv[index + 1]) {
            args.current = argv[index + 1];
            index += 1;
        }
    }

    if (!args.baseline || !args.current) {
        throw new Error('Usage: node scripts/benchmark_report.js --baseline <file> --current <file>');
    }

    return args;
}

function parseSeconds(value) {
    if (!value) return null;
    const match = String(value).match(/^(\d+(?:\.\d+)?)s$/i);
    if (!match) return null;
    return Number.parseFloat(match[1]);
}

function formatSeconds(value) {
    if (!Number.isFinite(value)) return 'n/a';
    return `${value.toFixed(1)}s`;
}

function formatDelta(value) {
    if (!Number.isFinite(value) || value === 0) return '0';
    const prefix = value > 0 ? '+' : '';
    return `${prefix}${value}`;
}

function buildSummary(label, parsed, filePath) {
    return {
        label,
        filePath,
        working: parsed.workingProxies.length,
        mayWork: parsed.mayWorkProxies.length,
        totalSeconds: parseSeconds(parsed.totalTime)
    };
}

function compareRuns(baseline, current) {
    const timeDelta = (
        Number.isFinite(current.totalSeconds) &&
        Number.isFinite(baseline.totalSeconds)
    ) ? current.totalSeconds - baseline.totalSeconds : null;

    return {
        baseline,
        current,
        deltas: {
            working: current.working - baseline.working,
            mayWork: current.mayWork - baseline.mayWork,
            totalSeconds: timeDelta
        }
    };
}

function renderReport(report) {
    const lines = [
        'Benchmark report',
        `Baseline: ${report.baseline.filePath}`,
        `Current: ${report.current.filePath}`,
        '',
        `Working: ${report.baseline.working} -> ${report.current.working} (${formatDelta(report.deltas.working)})`,
        `May work: ${report.baseline.mayWork} -> ${report.current.mayWork} (${formatDelta(report.deltas.mayWork)})`,
        `Total time: ${formatSeconds(report.baseline.totalSeconds)} -> ${formatSeconds(report.current.totalSeconds)} (${formatSeconds(report.deltas.totalSeconds)})`
    ];

    if (report.deltas.working < 0) {
        lines.push('Guardrail: working count regressed.');
    }
    if (report.deltas.mayWork < 0) {
        lines.push('Guardrail: may-work count regressed.');
    }
    if (Number.isFinite(report.deltas.totalSeconds)) {
        lines.push(report.deltas.totalSeconds < 0
            ? 'Timing: current run is faster than baseline.'
            : report.deltas.totalSeconds > 0
                ? 'Timing: current run is slower than baseline.'
                : 'Timing: current run matches baseline.'
        );
    }

    return `${lines.join('\n')}\n`;
}

function readSavedResults(filePath) {
    const absolutePath = path.resolve(filePath);
    const raw = fs.readFileSync(absolutePath, 'utf8');
    return {
        absolutePath,
        parsed: parseSavedResultsText(raw)
    };
}

function main() {
    const args = parseArgs();
    const baseline = readSavedResults(args.baseline);
    const current = readSavedResults(args.current);
    const report = compareRuns(
        buildSummary('baseline', baseline.parsed, baseline.absolutePath),
        buildSummary('current', current.parsed, current.absolutePath)
    );
    process.stdout.write(renderReport(report));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error.message || error}\n`);
        process.exit(1);
    }
}

module.exports = {
    buildSummary,
    compareRuns,
    formatDelta,
    formatSeconds,
    parseArgs,
    parseSeconds,
    renderReport
};
