const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildSummary,
    compareRuns,
    parseArgs,
    parseSeconds,
    renderReport
} = require('../scripts/benchmark_report');

test('benchmark_report parses required baseline and current flags', () => {
    const args = parseArgs(['--baseline', 'baseline.txt', '--current', 'current.txt']);
    assert.equal(args.baseline, 'baseline.txt');
    assert.equal(args.current, 'current.txt');
});

test('benchmark_report compares working may-work and total time deltas', () => {
    const baseline = buildSummary('baseline', {
        workingProxies: ['a', 'b'],
        mayWorkProxies: ['c'],
        totalTime: '120s'
    }, '/tmp/baseline.txt');
    const current = buildSummary('current', {
        workingProxies: ['a', 'b', 'd'],
        mayWorkProxies: ['c'],
        totalTime: '90s'
    }, '/tmp/current.txt');

    const report = compareRuns(baseline, current);

    assert.equal(report.deltas.working, 1);
    assert.equal(report.deltas.mayWork, 0);
    assert.equal(report.deltas.totalSeconds, -30);
});

test('benchmark_report renders guardrails and timing summary', () => {
    const report = renderReport({
        baseline: {
            filePath: '/tmp/baseline.txt',
            working: 3,
            mayWork: 2,
            totalSeconds: 180
        },
        current: {
            filePath: '/tmp/current.txt',
            working: 2,
            mayWork: 1,
            totalSeconds: 210
        },
        deltas: {
            working: -1,
            mayWork: -1,
            totalSeconds: 30
        }
    });

    assert.match(report, /Guardrail: working count regressed\./);
    assert.match(report, /Guardrail: may-work count regressed\./);
    assert.match(report, /Timing: current run is slower than baseline\./);
});

test('benchmark_report parses saved total time seconds values', () => {
    assert.equal(parseSeconds('133.5s'), 133.5);
    assert.equal(parseSeconds(null), null);
});
