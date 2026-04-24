/**
 * Telegram MTProto proxy checker built on a strict TDLib verification flow.
 *
 * The checker:
 * - parses tg://proxy and t.me/proxy links
 * - normalizes MTProto secrets to hexadecimal form
 * - verifies proxies through TDLib testProxy/testNetwork/pingProxy
 * - uses a cold confirmation pass on a fresh worker before marking a proxy as trusted
 *
 * Supported platforms: Linux, macOS, Windows
 * Runtime: Node.js + tdl + prebuilt-tdlib
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('node:dns').promises;

const {
    ensureUiLanguageSelected,
    loadStoredUiLanguage,
    setActiveUiLanguage,
    t
} = require('../i18n');
const {
    addCancelListener,
    bindCancelToSigint,
    createCancelledError,
    createCancelState,
    isUserCancelledError,
    throwIfCancelled
} = require('../shared/cancel');
const projectPaths = require('../config/project_paths');
const terminalSession = require('../terminal/terminal_session');
const ui = require('../terminal/ui');
const tdl = require('tdl');
const { getTdjson } = require('prebuilt-tdlib');
const {
    normalizeConcurrency,
    normalizeSecret,
    toTdProxy,
    buildCanonicalProxyUrl,
    parseProxyUrl,
    dedupeSupported,
    loadInputEntries,
    summarizeInput,
    parseArgs
} = require('../proxy/input');
const {
    validateProxyListFile
} = require('../cli/menu_file_helpers');
const {
    saveResults
} = require('./output_persistence');
const {
    PROGRESS_HINTS,
    createProgressHint,
    createProgressHintRotator,
    formatProgressHintLines,
    normalizeProgressHintText,
    resolveProgressHintLanguage,
    resolveProgressHintText
} = require('./progress_phrases');

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[92m',
    yellow: '\x1b[93m',
    red: '\x1b[91m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m'
};

// Placeholders: this checker only probes proxies before any user authorization.
const DEFAULT_API_ID = 20192049;
const DEFAULT_API_HASH = 'All those moments will be lost in time, like tears in rain.';

const API_ID = Number(process.env.TELEGRAM_API_ID || DEFAULT_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH || DEFAULT_API_HASH;

let tdlibConfigured = false;

const STATUS = {
    WORKING: 'WORKING',
    MAY_WORK: 'MAY_WORK',
    WEAK_OK: 'WEAK_OK',
    INIT_ONLY: 'INIT_ONLY',
    FAIL: 'FAIL',
    DC_PARTIAL: 'DC_PARTIAL',
    INVALID_INPUT: 'INVALID_INPUT',
    INPUT_INVALID: 'INPUT_INVALID',
    UNSUPPORTED_BOT_LINK: 'UNSUPPORTED_BOT_LINK',
    CHECKER_INVALID: 'CHECKER_INVALID',
    CANCELLED: 'CANCELLED'
};

const DEFAULT_DC_SWEEP = [2, 4, 5];
const MAX_RECOMMENDED_CONCURRENCY = 128;
const MAX_COLD_SCHEDULER_CONCURRENCY = 32;
const WORKER_INIT_CONCURRENCY = 8;
const DEFAULT_RECONNECT_DELAY_MS = 150;
const REQUIRED_COLD_CONFIRMATIONS = 3;
const REQUIRED_COLD_CONFIRMATIONS_HOSTNAME = 4;
const MAX_COLD_CONFIRMATION_SESSIONS_IP = 6;
const MAX_COLD_CONFIRMATION_SESSIONS_HOSTNAME = 6;
const MIN_COLD_SCHEDULER_CONCURRENCY = 2;
const MAIN_SCAN_PROGRESS_REDRAW_INTERVAL_MS = 320;
const LIVE_PROGRESS_MIN_REDRAW_INTERVAL_MS = 120;
const FINAL_TIMEOUT_FLOOR_SECONDS = 6;
const DNS_LOOKUP_TIMEOUT_MS = 2000;
const DEFAULT_PREPARED_QUEUE_FACTOR = 2;
const TERMINAL_DC_ERRORS = new Set([
    'DNS_ERROR',
    'PROTOCOL_MISMATCH',
    'INVALID_SECRET',
    'Response hash mismatch'
]);

function getShownStatusLabel(status) {
    if (status === STATUS.WORKING) return STATUS.WORKING;
    if (status === STATUS.MAY_WORK) return t('checker.mayWorkLabel');
    return STATUS.FAIL;
}

function normalizePinnedLivePanels(panels) {
    return (Array.isArray(panels) ? panels : [])
        .map(panel => String(panel || '').trimEnd())
        .filter(Boolean);
}

function renderLivePanel(panel, previousLineCount, options = {}) {
    void options.cancelState;
    void options.showCancelHint;
    const pinnedPanels = normalizePinnedLivePanels(options.pinnedPanels);
    const lines = [];
    for (const pinnedPanel of pinnedPanels) {
        if (lines.length > 0) {
            lines.push('');
        }
        lines.push(...pinnedPanel.split('\n'));
    }
    if (lines.length > 0) {
        lines.push('');
    }
    lines.push(...panel.split('\n'));
    lines.push('');
    return terminalSession.renderLive(lines, {
        clearViewportOnFirstRender: previousLineCount === 0
    });
}

function clearLivePanel(previousLineCount) {
    void previousLineCount;
    terminalSession.clearLive();
    return 0;
}

function isCancellationActive(cancelState) {
    return Boolean(cancelState && cancelState.cancelled);
}

function buildInputInvalidUserMessage(filePath, validation) {
    return {
        title: t('run.cannotStartTitle'),
        subtitle: t('checker.inputInvalidSubtitle'),
        lines: [
            t('common.file', { value: filePath }),
            ui.colorize(validation.error, 'danger'),
            '',
            t('run.chooseValidListBeforeStart')
        ]
    };
}

function buildWorkerInitializationFailureMessage(initErrors = []) {
    const uniqueErrors = [...new Set(
        initErrors
            .map(item => String(item || '').trim())
            .filter(Boolean)
    )];

    return {
        title: t('checker.workerInitFailedTitle'),
        subtitle: t('checker.workerInitFailedSubtitle'),
        lines: uniqueErrors.length > 0
            ? uniqueErrors
            : [t('checker.noWorkersInitialized')]
    };
}

function createUserFacingFailure(status, message) {
    const error = new Error(status);
    error.userTitle = message.title;
    error.userSubtitle = message.subtitle;
    error.userLines = message.lines;
    return error;
}

function validateInputFileOrThrow(filePath) {
    const validation = validateProxyListFile(filePath);
    if (validation.ok) {
        return validation;
    }

    throw createUserFacingFailure(
        STATUS.INPUT_INVALID,
        buildInputInvalidUserMessage(filePath, validation)
    );
}

function createTempDir(prefix = 'telegram_proxy_pinger_') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ensureTdlibConfigured() {
    if (tdlibConfigured) return;

    let tdjsonPath;
    try {
        tdjsonPath = getTdjson();
    } catch (error) {
        const details = error && error.message ? error.message : String(error);
        throw new Error(t('checker.tdlibMissingBinary', { details }));
    }

    tdl.configure({
        tdjson: tdjsonPath,
        verbosityLevel: 1
    });

    tdlibConfigured = true;
}

function removeDirSafe(dir) {
    if (!dir) return;
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDurationClock(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const mm = String(minutes % 60).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
    }
    return `${mm}:${ss}`;
}

function buildProgressPanel({ title, spinnerFrame, completed, total, elapsedMs, working, mayWork, failed, tip, tone = 'info' }) {
    const width = ui.getTerminalWidth(60, 74);
    const innerWidth = Math.max(1, width - 4);
    const percent = total > 0 ? Math.floor((completed / total) * 100) : 100;
    const lines = [
        `${spinnerFrame}  ${t('common.checked', { completed, total })}`,
        t('common.progress', { percent }),
        t('common.elapsed', { value: formatDurationClock(elapsedMs) })
    ];

    if (typeof working === 'number' || typeof mayWork === 'number' || typeof failed === 'number') {
        lines.push('');
        if (typeof working === 'number') lines.push(t('common.working', { count: working }));
        if (typeof mayWork === 'number') lines.push(t('common.mayWork', { count: mayWork }));
        if (typeof failed === 'number') lines.push(t('common.failed', { count: failed }));
    }

    if (tip) {
        lines.push(ui.BOX_BREAK);
        const tipLines = Array.isArray(tip)
            ? tip
            : formatProgressHintLines(tip, innerWidth);
        lines.push(...tipLines.map(line => ui.colorize(line, 'dim')));
    }

    return ui.renderBox({
        title,
        lines,
        tone,
        width
    });
}

function buildPreflightPanel({ title, subtitle, lines = [], tone = 'info' }) {
    return ui.renderBox({
        title,
        subtitle,
        lines,
        tone,
        width: ui.getTerminalWidth(60, 74)
    });
}

function hasAuditHardFailMarkers(result) {
    const errors = Array.isArray(result && result.allErrors) ? result.allErrors : [];
    return errors.some(error => {
        const text = String(error || '');
        return (
            text.includes('DNS_ERROR') ||
            text.includes('PROTOCOL_MISMATCH') ||
            text.includes('Response hash mismatch')
        );
    });
}

function isAuditEligibleFailure(result) {
    if (!result || result.status === STATUS.WORKING || result.status === STATUS.MAY_WORK) return false;

    const warmSignals = getWarmSignalState(result);
    const mobileSignals = getMobileSignalSummary(result);
    const enoughSignal =
        mobileSignals.realTrafficOk ||
        mobileSignals.apiProbePassed ||
        mobileSignals.networkOk ||
        mobileSignals.readyReached ||
        mobileSignals.sawConnectingToProxy ||
        mobileSignals.passedColdSessions >= 1 ||
        mobileSignals.successAttempts > 0;

    return (
        (
            warmSignals.ok ||
            warmSignals.readyReached ||
            warmSignals.sawConnectingToProxy ||
            warmSignals.forcedReconnect ||
            mobileSignals.networkOk ||
            mobileSignals.readyReached ||
            mobileSignals.realTrafficOk
        ) &&
        enoughSignal &&
        mobileSignals.softFailure &&
        !hasAuditHardFailMarkers(result)
    );
}

function rankFalseNegativeShortlist(results, limit = 10) {
    return results
        .filter(isAuditEligibleFailure)
        .sort(compareMayWorkCandidates)
        .slice(0, limit);
}

function buildFalseNegativeAudit(results, limit = 10) {
    const currentWorking = results
        .filter(result => result.status === STATUS.WORKING)
        .sort((left, right) => {
            const leftPing = Number.isFinite(left.pingLatencyMs) ? left.pingLatencyMs : Number.POSITIVE_INFINITY;
            const rightPing = Number.isFinite(right.pingLatencyMs) ? right.pingLatencyMs : Number.POSITIVE_INFINITY;
            return leftPing - rightPing;
        });
    const currentMayWork = results
        .filter(result => result.status === STATUS.MAY_WORK)
        .sort(compareMayWorkCandidates);
    const shortlist = rankFalseNegativeShortlist(results, limit);

    return {
        currentWorking,
        currentMayWork,
        shortlist
    };
}

function buildFalseNegativeAuditPanel(results, limit = 10) {
    const audit = buildFalseNegativeAudit(results, limit);
    const lines = [
        t('checker.currentWorking', { count: audit.currentWorking.length }),
        t('checker.currentMayWork', { count: audit.currentMayWork.length })
    ];

    if (audit.currentWorking.length > 0) {
        for (const [index, proxy] of audit.currentWorking.slice(0, limit).entries()) {
            lines.push(`${index + 1}. ${proxy.server}:${proxy.port} | ${proxy.pingLatencyMs}ms`);
        }
    } else {
        lines.push(t('checker.noWorkingThisRun'));
    }

    lines.push(ui.BOX_BREAK);
    if (audit.currentMayWork.length > 0) {
        for (const [index, proxy] of audit.currentMayWork.slice(0, limit).entries()) {
            lines.push(`M${index + 1}. ${proxy.server}:${proxy.port} | ${proxy.pingLatencyMs}ms`);
        }
    } else {
        lines.push(t('checker.noMayWorkThisRun'));
    }

    lines.push(ui.BOX_BREAK);
    lines.push(t('checker.topNearMissFail', { count: audit.shortlist.length }));

    if (audit.shortlist.length > 0) {
        for (const [index, proxy] of audit.shortlist.entries()) {
            lines.push(t('checker.nearMissEntry', {
                index: index + 1,
                host: `${proxy.server}:${proxy.port}`,
                coldPassed: proxy.passedColdSessions || 0,
                coldRequired: proxy.requiredColdSessions || 0,
                success: proxy.successAttempts || 0,
                latency: proxy.pingLatencyMs,
                failure: proxy.failurePhase || t('common.fail')
            }));
        }
    } else {
        lines.push(t('checker.noNearMissCandidates'));
    }

    return buildPreflightPanel({
        title: t('checker.falseNegativeAuditTitle'),
        subtitle: t('checker.falseNegativeAuditSubtitle'),
        tone: 'info',
        lines
    });
}

function isWarmRescueEligible(dcSweep = [], warmCheck = null) {
    if (!warmCheck || warmCheck.ok) return false;
    if (!dcSweep.length || !dcSweep.every(item => item.ok)) return false;

    const timeoutLikeFailure =
        warmCheck.failurePhase === 'wait_ready' ||
        String(warmCheck.error || '').includes('READY_TIMEOUT') ||
        String(warmCheck.error || '').includes('TIMEOUT');

    return timeoutLikeFailure && warmCheck.sawConnectingToProxy !== true;
}

function percentileMedian(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function computeSpreadRatio(values) {
    if (!values || values.length < 2) return 0;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    return avg > 0 ? (max - min) / avg : 0;
}

function computeMaxLatency(values) {
    if (!values || values.length === 0) return null;
    return Math.max(...values);
}

function isIpAddress(value) {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value || '').trim());
}

function getRequiredColdConfirmations(candidate) {
    return isIpAddress(candidate && candidate.server)
        ? REQUIRED_COLD_CONFIRMATIONS
        : REQUIRED_COLD_CONFIRMATIONS_HOSTNAME;
}

function getMaxColdConfirmationSessions(candidate) {
    return isIpAddress(candidate && candidate.server)
        ? MAX_COLD_CONFIRMATION_SESSIONS_IP
        : MAX_COLD_CONFIRMATION_SESSIONS_HOSTNAME;
}

function buildPhaseTimings(base = {}) {
    return {
        dcSweepMs: base.dcSweepMs || 0,
        warmCheckMs: base.warmCheckMs || 0,
        coldQueueWaitMs: base.coldQueueWaitMs || 0,
        coldExecutionMs: base.coldExecutionMs || 0
    };
}

function resolveColdSchedulerConcurrency(scanWorkerCount) {
    const numeric = Number(scanWorkerCount || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return MIN_COLD_SCHEDULER_CONCURRENCY;
    }

    return Math.max(
        MIN_COLD_SCHEDULER_CONCURRENCY,
        Math.min(MAX_COLD_SCHEDULER_CONCURRENCY, Math.floor(numeric))
    );
}

function createColdRetestFailureSession(pass, attempts, error, verbose, debug = {}) {
    return {
        ok: false,
        networkOk: false,
        realTrafficOk: false,
        apiProbePassed: false,
        apiProbeChecks: [],
        coldRetestPassed: false,
        readyReached: false,
        sawConnectingToProxy: false,
        forcedReconnect: false,
        successAttempts: 0,
        failAttempts: attempts,
        pingLatencyMs: null,
        allLatencies: [],
        allErrors: [classifyTdError(error)],
        failurePhase: 'cold_retest',
        debug: verbose ? debug : undefined,
        session: pass
    };
}

function resolveColdRetestDisposition({ successfulSessions, completedSessions, scheduledSessions, requiredSessions, maxSessions }) {
    if (successfulSessions >= requiredSessions) {
        return { locked: true, passed: true };
    }

    const inFlightSessions = Math.max(0, scheduledSessions - completedSessions);
    const unstartedSessions = Math.max(0, maxSessions - scheduledSessions);
    const possibleSuccesses = successfulSessions + inFlightSessions + unstartedSessions;

    if (possibleSuccesses < requiredSessions) {
        return { locked: true, passed: false };
    }

    return { locked: false, passed: false };
}

function normalizeDnsAddresses(records) {
    return [...new Set((records || []).map(item => item.address).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

function isSoftDcFailure(dcSweep = []) {
    const failures = dcSweep.filter(item => !item.ok);
    if (failures.length !== 1) return false;
    return failures.every(item => item.error === 'TIMEOUT' || item.error === 'NETWORK_ERROR');
}

function summarizeDcSweepOutcome(dcSweep = []) {
    const failures = dcSweep.filter(item => !item.ok);
    const successCount = dcSweep.length - failures.length;
    const allFailed = dcSweep.length > 0 && failures.length === dcSweep.length;
    const allDnsFailures = allFailed && failures.every(item => item.error === 'DNS_ERROR');
    const allTerminalFailures = allFailed && failures.every(item => TERMINAL_DC_ERRORS.has(item.error));
    return {
        successCount,
        failureCount: failures.length,
        allFailed,
        allDnsFailures,
        allTerminalFailures
    };
}

function resolveWarmCheckSkip(dcSweep = []) {
    const summary = summarizeDcSweepOutcome(dcSweep);
    if (!summary.allFailed) {
        return {
            skip: false,
            skipReason: null,
            dcSuccessCount: summary.successCount
        };
    }

    if (summary.allDnsFailures) {
        return {
            skip: true,
            skipReason: 'all_dns_failed',
            dcSuccessCount: summary.successCount
        };
    }

    if (summary.allTerminalFailures) {
        return {
            skip: true,
            skipReason: 'all_terminal_dc_failures',
            dcSuccessCount: summary.successCount
        };
    }

    return {
        skip: true,
        skipReason: 'all_dc_checks_failed',
        dcSuccessCount: summary.successCount
    };
}

function resolveDnsLookup(server, lookupFn, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DNS_LOOKUP_TIMEOUT_MS;
    const cancelState = options.cancelState || null;

    return new Promise((resolve, reject) => {
        let settled = false;
        let timeout = null;
        const finish = callback => value => {
            if (settled) return;
            settled = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            offCancel();
            callback(value);
        };
        const offCancel = addCancelListener(cancelState, () => {
            finish(reject)(createCancelledError());
        });

        if (timeoutMs > 0) {
            timeout = setTimeout(() => {
                finish(reject)(new Error(`DNS lookup timeout after ${timeoutMs}ms`));
            }, timeoutMs);
        }

        Promise.resolve()
            .then(() => lookupFn(server, { all: true, verbatim: true }))
            .then(finish(resolve), finish(reject));
    });
}

async function checkDnsStability(server, sampleCount = 3, lookupFn = dns.lookup, options = {}) {
    if (isIpAddress(server)) {
        return {
            ok: true,
            samples: [],
            comparedSets: []
        };
    }

    const samples = [];
    const comparedSets = [];

    for (let index = 0; index < sampleCount; index += 1) {
        try {
            const records = await resolveDnsLookup(server, lookupFn, options);
            const addresses = normalizeDnsAddresses(records);
            if (addresses.length === 0) {
                samples.push({
                    ok: false,
                    error: 'DNS_ERROR'
                });
                return { ok: false, samples, comparedSets };
            }

            samples.push({
                ok: true,
                addresses
            });
            comparedSets.push(addresses.join(','));
        } catch (error) {
            if (isUserCancelledError(error)) {
                throw error;
            }
            samples.push({
                ok: false,
                error: classifyTdError(error)
            });
            return { ok: false, samples, comparedSets };
        }
    }

    const stable = comparedSets.every(item => item === comparedSets[0]);
    const addressCount = samples[0] && samples[0].addresses ? samples[0].addresses.length : 0;
    const sameSubnet24 = stable && samples.every(sample => {
        if (!sample.ok) return false;
        const ipv4Only = (sample.addresses || []).every(address => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address));
        if (!ipv4Only) return false;
        const prefixes = new Set(sample.addresses.map(address => address.split('.').slice(0, 3).join('.')));
        return prefixes.size === 1;
    });
    return {
        ok: stable,
        samples,
        comparedSets,
        singleAddressOnly: stable && comparedSets.every(item => item && !item.includes(',')),
        strongEligible: stable && (addressCount <= 1 || sameSubnet24)
    };
}

function classifyTdError(error) {
    const message = String(error && error.message ? error.message : error || 'UNKNOWN');
    const lower = message.toLowerCase();

    if (lower.includes('timeout') || lower.includes('deadline')) return 'TIMEOUT';
    if (lower.includes('resolve host') || lower.includes('nodename nor servname') || lower.includes('name resolution')) return 'DNS_ERROR';
    if (lower.includes('expected packet size is too big')) return 'PROTOCOL_MISMATCH';
    if (lower.includes('secret') || lower.includes('invalid')) return 'INVALID_SECRET';
    if (lower.includes('proxy') || lower.includes('mtproto')) return 'PROXY_ERROR';
    if (lower.includes('network') || lower.includes('connection')) return 'NETWORK_ERROR';

    return message;
}

function explainEnvironmentError(error) {
    const message = String(error && error.message ? error.message : error || 'UNKNOWN');

    if (message.includes('Could not load @prebuilt-tdlib/')) {
        return t('checker.tdlibMissingPlatformBinary');
    }

    if (
        message.includes('library load disallowed by system policy') ||
        message.includes('code signature')
    ) {
        return t('checker.macosBlockedTdlib');
    }

    return message;
}

function computeConfidence(latencies, errors, attemptsTotal) {
    const successCount = latencies.length;
    const failCount = errors.length;

    if (successCount === 0) {
        return { level: STATUS.FAIL, confidence: 0 };
    }

    if (attemptsTotal <= 1) {
        return { level: STATUS.WEAK_OK, confidence: 0.67 };
    }

    if (successCount === 1 && failCount >= Math.max(1, attemptsTotal - 1)) {
        return { level: STATUS.INIT_ONLY, confidence: 0.34 };
    }

    if (successCount >= 2) {
        const maxLatency = Math.max(...latencies);
        const minLatency = Math.min(...latencies);
        const avgLatency = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
        const spreadRatio = avgLatency > 0 ? (maxLatency - minLatency) / avgLatency : 0;

        if (successCount === attemptsTotal && spreadRatio <= 0.6) {
            return { level: STATUS.WORKING, confidence: 1.0 };
        }

        return { level: STATUS.WEAK_OK, confidence: 0.67 };
    }

    return { level: STATUS.FAIL, confidence: 0 };
}

function getFinalTimeoutSeconds(timeoutSeconds) {
    return Math.max(FINAL_TIMEOUT_FLOOR_SECONDS, Number(timeoutSeconds || 0) + 2);
}

function hasStableAggregateLatency(latencies, options = {}) {
    if (!latencies || latencies.length === 0) return false;

    const spreadRatio = computeSpreadRatio(latencies);
    const maxLatency = computeMaxLatency(latencies);
    const medianLatency = percentileMedian(latencies);
    const maxSpreadRatio = options.maxSpreadRatio ?? 0.35;
    const maxLatencyMs = options.maxLatencyMs ?? 420;
    const maxMedianMs = options.maxMedianMs ?? 320;

    return spreadRatio <= maxSpreadRatio &&
        maxLatency != null &&
        maxLatency <= maxLatencyMs &&
        medianLatency != null &&
        medianLatency <= maxMedianMs;
}

function dropWorstLatency(latencies) {
    if (!Array.isArray(latencies) || latencies.length <= 2) {
        return Array.isArray(latencies) ? [...latencies] : [];
    }
    const sorted = [...latencies].sort((left, right) => left - right);
    sorted.pop();
    return sorted;
}

function hasStrongWorkingTrafficSignal(coldRetest, candidate, attempts, warmCheck = null) {
    if (!coldRetest) return false;
    if (coldRetest.realTrafficOk !== true || coldRetest.apiProbePassed === false) return false;
    if (coldRetest.dnsStabilityPassed === false || coldRetest.dnsStrongEligible === false) return false;

    const allLatencies = Array.isArray(coldRetest.allLatencies) ? coldRetest.allLatencies : [];
    const medianLatency = percentileMedian(allLatencies);
    if (medianLatency == null || medianLatency > 320) return false;

    const requiredSessions = Number(coldRetest.requiredColdSessions || getRequiredColdConfirmations(candidate));
    const passedSessions = Number(coldRetest.passedColdSessions || 0);
    const successAttempts = Number(coldRetest.successAttempts || 0);
    const failAttempts = Number(coldRetest.failAttempts || 0);
    const hasWarmOrColdConfirmation = Boolean(
        warmCheck && warmCheck.ok ||
        (coldRetest.networkOk && coldRetest.readyReached) ||
        (coldRetest.confirmedTrafficSessions || 0) > 0
    );

    if (!hasWarmOrColdConfirmation) return false;

    const candidateIsIp = isIpAddress(candidate && candidate.server);
    if (candidateIsIp) {
        if (!coldRetest.coldRetestPassed) return false;
        if (passedSessions < requiredSessions) return false;
        if (failAttempts > 1) return false;
        if (successAttempts < Math.max(requiredSessions * attempts, requiredSessions)) return false;

        const trimmedMaxLatency = computeMaxLatency(dropWorstLatency(allLatencies));
        const fastEnoughSamples = allLatencies.filter(value => value <= 450).length;
        const fastEnoughRatio = allLatencies.length > 0 ? fastEnoughSamples / allLatencies.length : 0;

        return (
            trimmedMaxLatency != null &&
            trimmedMaxLatency <= 750 &&
            fastEnoughRatio >= 0.75
        );
    }

    return Boolean(
        (coldRetest.confirmedTrafficSessions || 0) >= 2 &&
        (coldRetest.confirmedTrafficAttempts || 0) >= Math.max(attempts + 1, 3) &&
        successAttempts >= Math.max(attempts + 1, 3) &&
        failAttempts <= Math.max(3, successAttempts) &&
        coldRetest.trimmedAggregateLatencyStable === true
    );
}

function hasTrafficOnlyHostnameWorkingSignal(coldRetest, candidate, warmCheck = null) {
    if (!coldRetest || !candidate || isIpAddress(candidate.server)) return false;
    if (!warmCheck || !warmCheck.ok || !warmCheck.readyReached) return false;
    if (!coldRetest.networkOk || !coldRetest.readyReached || !coldRetest.forcedReconnect) return false;
    if (!coldRetest.realTrafficOk || coldRetest.apiProbePassed === false) return false;
    if (coldRetest.dnsStabilityPassed === false || coldRetest.dnsStrongEligible === false) return false;
    if ((coldRetest.successAttempts || 0) !== 0) return false;

    const requiredSessions = Number(coldRetest.requiredColdSessions || getRequiredColdConfirmations(candidate));
    if ((coldRetest.confirmedTrafficSessions || 0) < requiredSessions) return false;

    const failurePhase = coldRetest.failurePhase || null;
    if (!['ping_proxy', null].includes(failurePhase)) return false;

    const errors = Array.isArray(coldRetest.allErrors) ? coldRetest.allErrors : [];
    return errors.length > 0 && errors.every(error => /TIMEOUT/.test(String(error)));
}

function getMayWorkCapReason(coldRetest) {
    if (!coldRetest) return null;
    if (
        coldRetest.coldRetestPassed &&
        (coldRetest.failAttempts || 0) === 0 &&
        coldRetest.realTrafficOk === true &&
        coldRetest.apiProbePassed !== false
    ) {
        return null;
    }
    const allLatencies = Array.isArray(coldRetest.allLatencies)
        ? coldRetest.allLatencies.filter(value => Number.isFinite(value))
        : [];
    const rawMaxLatency = computeMaxLatency(allLatencies);
    const trimmedMaxLatency = computeMaxLatency(dropWorstLatency(allLatencies));
    const medianLatency = percentileMedian(allLatencies);
    const errors = Array.isArray(coldRetest.allErrors) ? coldRetest.allErrors : [];
    const hasNonTimeoutErrors = errors.some(error => !/TIMEOUT/.test(String(error)));

    if (hasNonTimeoutErrors) return 'non_timeout_error';
    if ((coldRetest.failAttempts || 0) > 1) return 'too_many_failures';
    if ((coldRetest.confirmedTrafficSessions || 0) === 0) return 'no_confirmed_traffic';
    if (rawMaxLatency != null && rawMaxLatency > 550) return 'raw_latency_spike';
    if (trimmedMaxLatency != null && trimmedMaxLatency > 450) return 'trimmed_latency_spike';
    if (medianLatency != null && medianLatency > 320) return 'high_median_latency';
    return null;
}

function getLatencyDiagnostics(coldRetest) {
    const samples = Array.isArray(coldRetest && coldRetest.allLatencies)
        ? coldRetest.allLatencies.filter(value => Number.isFinite(value))
        : [];
    const medianLatency = percentileMedian(samples);
    const rawMaxLatency = computeMaxLatency(samples);
    const trimmedMaxLatency = computeMaxLatency(dropWorstLatency(samples));

    return {
        hasValidLatencySample: samples.length > 0,
        latencySampleCount: samples.length,
        medianLatency: Number.isFinite(medianLatency) ? medianLatency : null,
        rawMaxLatency: Number.isFinite(rawMaxLatency) ? rawMaxLatency : null,
        trimmedMaxLatency: Number.isFinite(trimmedMaxLatency) ? trimmedMaxLatency : null
    };
}

function collectFailureTypeDiagnostics(coldRetest, warmCheck = null, dcSweep = []) {
    const sessions = Array.isArray(coldRetest && coldRetest.debug && coldRetest.debug.sessions)
        ? coldRetest.debug.sessions
        : [];
    let readyTimeoutSessions = 0;
    let pingTimeoutOnlySessions = 0;
    let dcSweepFailedSessions = 0;
    let apiConfirmedButUnpassedSessions = 0;

    for (const session of sessions) {
        const phase = session && session.failurePhase ? session.failurePhase : null;
        const errors = Array.isArray(session && session.allErrors) ? session.allErrors : [];
        const timeoutOnly = errors.length > 0 && errors.every(error => /TIMEOUT/.test(String(error)));

        if (phase === 'wait_ready') readyTimeoutSessions += 1;
        if (phase === 'ping_proxy' && timeoutOnly) pingTimeoutOnlySessions += 1;
        if (phase === 'dc_sweep') dcSweepFailedSessions += 1;
        if (
            session &&
            session.networkOk &&
            session.readyReached &&
            session.forcedReconnect &&
            session.realTrafficOk &&
            session.apiProbePassed !== false &&
            !session.coldRetestPassed
        ) {
            apiConfirmedButUnpassedSessions += 1;
        }
    }

    if (sessions.length === 0 && coldRetest) {
        const errors = Array.isArray(coldRetest.allErrors) ? coldRetest.allErrors : [];
        const timeoutOnly = errors.length > 0 && errors.every(error => /TIMEOUT/.test(String(error)));
        if ((coldRetest.failurePhase || null) === 'wait_ready') readyTimeoutSessions = 1;
        if ((coldRetest.failurePhase || null) === 'ping_proxy' && timeoutOnly) pingTimeoutOnlySessions = 1;
        if ((coldRetest.failurePhase || null) === 'dc_sweep') dcSweepFailedSessions = 1;
        if (
            coldRetest.networkOk &&
            coldRetest.readyReached &&
            coldRetest.forcedReconnect &&
            coldRetest.realTrafficOk &&
            coldRetest.apiProbePassed !== false &&
            !coldRetest.coldRetestPassed
        ) {
            apiConfirmedButUnpassedSessions = Math.max(1, Number(coldRetest.confirmedTrafficSessions || 0));
        }
    }

    if (dcSweepFailedSessions === 0 && Array.isArray(dcSweep) && dcSweep.some(item => item && !item.ok)) {
        dcSweepFailedSessions = 1;
    }

    const warmReadyTimeout = Boolean(
        warmCheck &&
        !warmCheck.ok &&
        !warmCheck.skipped &&
        String(warmCheck.error || '') === 'READY_TIMEOUT'
    );
    const hasReadyPattern = readyTimeoutSessions > 0 || warmReadyTimeout;
    const hasPingPattern = pingTimeoutOnlySessions > 0;
    const hasDcPattern = dcSweepFailedSessions > 0;
    let candidatePatternClass = 'mixed_failures';

    if (coldRetest && coldRetest.coldRetestPassed) {
        candidatePatternClass = 'cold_confirmed_working';
    } else if (hasPingPattern && !hasReadyPattern && !hasDcPattern) {
        candidatePatternClass = 'ping_proxy_only_good_route';
    } else if (hasReadyPattern && !hasPingPattern && !hasDcPattern) {
        candidatePatternClass = 'wait_ready_dominant';
    } else if (hasDcPattern && !hasReadyPattern && !hasPingPattern) {
        candidatePatternClass = 'dc_sweep_unstable';
    }

    return {
        candidatePatternClass,
        readyTimeoutSessions,
        pingTimeoutOnlySessions,
        dcSweepFailedSessions,
        apiConfirmedButUnpassedSessions,
        warmReadyTimeout
    };
}

function hasPingProxyRouteConfirmedWorkingSignal(coldRetest, candidate, warmCheck = null, diagnostics = null) {
    if (!coldRetest || !candidate || isIpAddress(candidate.server)) return false;
    if (!warmCheck || warmCheck.ok !== true || warmCheck.readyReached !== true) return false;
    if (coldRetest.dnsStabilityPassed === false || coldRetest.dnsStrongEligible === false) return false;
    if (String(candidate.proxyType || '').toLowerCase() === 'dd') return false;
    if (coldRetest.dnsSingleAddressOnly === false) return false;

    const patternDiagnostics = diagnostics || collectFailureTypeDiagnostics(coldRetest, warmCheck);
    if (patternDiagnostics.candidatePatternClass !== 'ping_proxy_only_good_route') return false;
    if ((coldRetest.failurePhase || null) !== 'ping_proxy') return false;
    if (patternDiagnostics.readyTimeoutSessions !== 0) return false;
    if (patternDiagnostics.dcSweepFailedSessions !== 0) return false;
    if ((coldRetest.passedColdSessions || 0) !== 0) return false;
    if ((coldRetest.currentRouteReadyRatio || 0) < 0.85) return false;
    if ((coldRetest.currentRouteApiRatio || 0) < 0.85) return false;
    if ((coldRetest.successAttempts || 0) < 2) return false;
    if ((coldRetest.confirmedTrafficAttempts || 0) < 2) return false;

    const errors = Array.isArray(coldRetest.allErrors) ? coldRetest.allErrors : [];
    if (!(errors.length > 0 && errors.every(error => /TIMEOUT/.test(String(error))))) return false;

    const allLatencies = Array.isArray(coldRetest.allLatencies)
        ? coldRetest.allLatencies.filter(value => Number.isFinite(value))
        : [];
    if (allLatencies.length === 0) return false;

    const medianLatency = percentileMedian(allLatencies);
    const rawMaxLatency = computeMaxLatency(allLatencies);
    const trimmedMaxLatency = computeMaxLatency(dropWorstLatency(allLatencies));

    return Boolean(
        medianLatency != null &&
        medianLatency <= 220 &&
        rawMaxLatency != null &&
        rawMaxLatency <= 320 &&
        trimmedMaxLatency != null &&
        trimmedMaxLatency <= 220
    );
}

function hasPurePingProxyPartialColdWorkingSignal(
    coldRetest,
    candidate,
    warmCheck = null,
    diagnostics = null,
    latencyDiagnostics = null
) {
    if (!coldRetest || !candidate || isIpAddress(candidate.server)) return false;
    if (String(candidate.proxyType || '').toLowerCase() === 'dd') return false;
    if (coldRetest.dnsSingleAddressOnly === false) return false;
    if (!warmCheck || warmCheck.ok !== true || warmCheck.readyReached !== true) return false;
    if (coldRetest.dnsStabilityPassed === false || coldRetest.dnsStrongEligible === false) return false;

    const patternDiagnostics = diagnostics || collectFailureTypeDiagnostics(coldRetest, warmCheck);
    if (patternDiagnostics.candidatePatternClass !== 'ping_proxy_only_good_route') return false;
    if ((coldRetest.failurePhase || null) !== 'ping_proxy') return false;
    if (patternDiagnostics.readyTimeoutSessions !== 0) return false;
    if (patternDiagnostics.dcSweepFailedSessions !== 0) return false;
    if (patternDiagnostics.warmReadyTimeout !== false) return false;
    if ((coldRetest.currentRouteReadyRatio || 0) !== 1) return false;
    if ((coldRetest.currentRouteApiRatio || 0) !== 1) return false;

    const passedColdSessions = Number(coldRetest.passedColdSessions || 0);
    const requiredColdSessions = Number(coldRetest.requiredColdSessions || 0);
    if (passedColdSessions < 1) return false;
    if (requiredColdSessions <= 0 || passedColdSessions >= requiredColdSessions) return false;
    if ((patternDiagnostics.apiConfirmedButUnpassedSessions || 0) < 2) return false;
    if ((coldRetest.confirmedTrafficSessions || 0) < 2) return false;
    if ((coldRetest.confirmedTrafficAttempts || 0) < 2) return false;
    if ((coldRetest.successAttempts || 0) < 2) return false;

    const errors = Array.isArray(coldRetest.allErrors) ? coldRetest.allErrors : [];
    if (!(errors.length > 0 && errors.every(error => /TIMEOUT/.test(String(error))))) return false;

    const latency = latencyDiagnostics || getLatencyDiagnostics(coldRetest);
    return Boolean(
        latency.hasValidLatencySample === true &&
        latency.latencySampleCount >= 2 &&
        latency.medianLatency != null &&
        latency.medianLatency <= 220 &&
        latency.trimmedMaxLatency != null &&
        latency.trimmedMaxLatency <= 240 &&
        latency.rawMaxLatency != null &&
        latency.rawMaxLatency <= 320
    );
}

function getDdPartialColdRouteSignal(
    coldRetest,
    candidate,
    warmCheck = null,
    dcSweep = [],
    diagnostics = null,
    latencyDiagnostics = null
) {
    void warmCheck;
    if (!candidate) {
        return { recoverable: false, blockReason: 'missing_candidate' };
    }

    const proxyType = String(candidate.proxyType || '').toLowerCase();
    const appliesToCandidate = proxyType === 'dd' || isIpAddress(candidate.server);
    if (!appliesToCandidate) {
        return { recoverable: false, blockReason: null };
    }

    if (!coldRetest) {
        return { recoverable: false, blockReason: 'missing_cold_retest' };
    }

    const patternDiagnostics = diagnostics || collectFailureTypeDiagnostics(coldRetest, warmCheck, dcSweep);
    if ((patternDiagnostics.dcSweepFailedSessions || 0) !== 0) {
        return { recoverable: false, blockReason: 'dc_sweep_unstable' };
    }
    if (coldRetest.dnsStabilityPassed === false || coldRetest.dnsStrongEligible === false) {
        return { recoverable: false, blockReason: 'dns_unstable' };
    }

    const passedColdSessions = Number(coldRetest.passedColdSessions || 0);
    const requiredColdSessions = Number(coldRetest.requiredColdSessions || getRequiredColdConfirmations(candidate));
    if (passedColdSessions < 1) {
        return { recoverable: false, blockReason: 'no_partial_cold_confirmation' };
    }
    if (requiredColdSessions > 0 && passedColdSessions >= requiredColdSessions) {
        return { recoverable: false, blockReason: 'full_cold_confirmation' };
    }
    if ((patternDiagnostics.readyTimeoutSessions || 0) > 1) {
        return { recoverable: false, blockReason: 'ready_timeout_dominant' };
    }
    if ((patternDiagnostics.apiConfirmedButUnpassedSessions || 0) < 2) {
        return { recoverable: false, blockReason: 'weak_api_confirmation' };
    }
    if ((coldRetest.currentRouteReadyRatio || 0) < 0.8 || (coldRetest.currentRouteApiRatio || 0) < 0.8) {
        return { recoverable: false, blockReason: 'weak_current_route' };
    }
    if ((coldRetest.successAttempts || 0) < 6) {
        return { recoverable: false, blockReason: 'weak_success_attempts' };
    }
    if ((coldRetest.failAttempts || 0) > 4) {
        return { recoverable: false, blockReason: 'too_many_failures' };
    }
    const failurePhase = coldRetest.failurePhase || null;
    if (!['ping_proxy', 'wait_ready', null].includes(failurePhase)) {
        return { recoverable: false, blockReason: 'unsupported_failure_phase' };
    }

    const errors = Array.isArray(coldRetest.allErrors) ? coldRetest.allErrors : [];
    if (errors.some(error => !/TIMEOUT/.test(String(error)))) {
        return { recoverable: false, blockReason: 'non_timeout_error' };
    }

    const latency = latencyDiagnostics || getLatencyDiagnostics(coldRetest);
    if (latency.hasValidLatencySample !== true || latency.latencySampleCount < 4) {
        return { recoverable: false, blockReason: 'no_valid_latency' };
    }
    if (latency.medianLatency == null || latency.medianLatency > 280) {
        return { recoverable: false, blockReason: 'high_median_latency' };
    }
    if (latency.trimmedMaxLatency == null || latency.trimmedMaxLatency > 650) {
        return { recoverable: false, blockReason: 'trimmed_latency_spike' };
    }
    if (latency.rawMaxLatency == null || latency.rawMaxLatency > 1200) {
        return { recoverable: false, blockReason: 'raw_latency_spike' };
    }

    return { recoverable: true, blockReason: null };
}

function hasDdPartialColdRouteWorkingSignal(
    coldRetest,
    candidate,
    warmCheck = null,
    dcSweep = [],
    diagnostics = null,
    latencyDiagnostics = null
) {
    return getDdPartialColdRouteSignal(
        coldRetest,
        candidate,
        warmCheck,
        dcSweep,
        diagnostics,
        latencyDiagnostics
    ).recoverable === true;
}

function hasStableCurrentRouteWorkingSignal(coldRetest, candidate, attempts, warmCheck = null, dcSweep = []) {
    if (!coldRetest || !candidate || isIpAddress(candidate.server)) return false;
    if (!warmCheck || warmCheck.ok !== true || warmCheck.readyReached !== true) return false;
    if (coldRetest.dnsStabilityPassed === false || coldRetest.dnsStrongEligible === false) return false;

    const isMultiAddressDdOrEeHostname =
        ['dd', 'ee'].includes(String(candidate.proxyType || '').toLowerCase()) &&
        coldRetest.dnsSingleAddressOnly === false;
    if (isMultiAddressDdOrEeHostname) return false;

    if ((coldRetest.confirmedTrafficSessions || 0) < 2) return false;
    if ((coldRetest.confirmedTrafficAttempts || 0) < Math.max(3, attempts + 1)) return false;
    if ((coldRetest.successAttempts || 0) < 2) return false;
    if ((coldRetest.failAttempts || 0) > 1) return false;

    const failurePhase = coldRetest.failurePhase || null;
    const allowedFailurePhase =
        ['wait_ready', 'ping_proxy', null].includes(failurePhase) ||
        (failurePhase === 'dc_sweep' && isSoftDcFailure(dcSweep));
    if (!allowedFailurePhase) return false;

    const allLatencies = Array.isArray(coldRetest.allLatencies)
        ? coldRetest.allLatencies.filter(value => Number.isFinite(value))
        : [];
    if (allLatencies.length === 0) return false;
    if (coldRetest.trimmedAggregateLatencyStable !== true) return false;

    const medianLatency = percentileMedian(allLatencies);
    const trimmedMaxLatency = computeMaxLatency(dropWorstLatency(allLatencies));

    return Boolean(
        medianLatency != null &&
        medianLatency <= 320 &&
        trimmedMaxLatency != null &&
        trimmedMaxLatency <= 450
    );
}

function hasRelaxedFullyConfirmedHostnameWorkingSignal(coldRetest, candidate) {
    if (!coldRetest || !candidate || isIpAddress(candidate.server)) return false;
    if (!coldRetest.coldRetestPassed) return false;
    if (!coldRetest.realTrafficOk || coldRetest.apiProbePassed === false) return false;
    if (coldRetest.dnsStabilityPassed === false || coldRetest.dnsStrongEligible === false) return false;
    if ((coldRetest.failAttempts || 0) !== 0) return false;

    const allLatencies = Array.isArray(coldRetest.allLatencies) ? coldRetest.allLatencies : [];
    const rawMaxLatency = computeMaxLatency(allLatencies);
    if (rawMaxLatency == null || rawMaxLatency > 650) return false;

    return hasStableAggregateLatency(dropWorstLatency(allLatencies), {
        maxSpreadRatio: 0.22,
        maxLatencyMs: 450,
        maxMedianMs: 420
    });
}

function summarizeColdRetests(coldRetests = [], attempts, requiredSessions = REQUIRED_COLD_CONFIRMATIONS, options = {}) {
    if (!coldRetests.length) return null;

    const allowNearTrusted = options.allowNearTrusted !== false;
    const successfulSessions = coldRetests.filter(item => item.coldRetestPassed).length;
    const confirmedTrafficSessions = coldRetests.filter(item =>
        item.networkOk &&
        item.readyReached &&
        item.forcedReconnect &&
        item.realTrafficOk &&
        item.apiProbePassed !== false
    );
    const anySignal = coldRetests.some(item =>
        item.networkOk || item.readyReached || (item.successAttempts || 0) > 0
    );
    const firstFailure = coldRetests.find(item => item.failurePhase);
    const allLatencies = coldRetests.flatMap(item => item.allLatencies || []);
    const allErrors = coldRetests.flatMap(item => item.allErrors || []);
    const successAttempts = coldRetests.reduce((sum, item) => sum + (item.successAttempts || 0), 0);
    const failAttempts = coldRetests.reduce((sum, item) => sum + (item.failAttempts || 0), 0);
    const confirmedTrafficAttempts = confirmedTrafficSessions.reduce(
        (sum, item) => sum + (item.successAttempts || 0),
        0
    );
    const readyReachedSessions = coldRetests.filter(item => item.readyReached).length;
    const nearTrusted = allowNearTrusted &&
        coldRetests.every(item => item.networkOk && item.readyReached && item.forcedReconnect && item.realTrafficOk) &&
        successAttempts >= (attempts * requiredSessions) - 1 &&
        failAttempts <= 1 &&
        computeSpreadRatio(allLatencies) <= 0.25;
    const apiProbeChecks = coldRetests.map(item => ({
        session: item.session,
        checks: item.apiProbeChecks || item.apiChecks || []
    }));

    return {
        ok: coldRetests.every(item => item.ok),
        networkOk: coldRetests.every(item => item.networkOk),
        realTrafficOk: coldRetests.every(item => item.realTrafficOk),
        apiProbePassed: coldRetests.every(item => item.apiProbePassed !== false && item.realTrafficOk),
        apiProbeChecks,
        readyReached: coldRetests.every(item => item.readyReached),
        sawConnectingToProxy: coldRetests.some(item => item.sawConnectingToProxy),
        forcedReconnect: coldRetests.every(item => item.forcedReconnect),
        coldRetestPassed: successfulSessions >= requiredSessions,
        nearTrusted,
        successfulSessions,
        confirmedTrafficSessions: confirmedTrafficSessions.length,
        confirmedTrafficAttempts,
        currentRouteReadyRatio: coldRetests.length > 0 ? readyReachedSessions / coldRetests.length : 0,
        currentRouteApiRatio: coldRetests.length > 0 ? confirmedTrafficSessions.length / coldRetests.length : 0,
        requiredSessions,
        passedColdSessions: successfulSessions,
        requiredColdSessions: requiredSessions,
        almostPassedColdSessions: successfulSessions >= Math.max(1, requiredSessions - 1),
        successAttempts,
        failAttempts,
        pingLatencyMs: percentileMedian(
            allLatencies
        ),
        allLatencies,
        allErrors,
        aggregateLatencyStable: hasStableAggregateLatency(allLatencies),
        relaxedIpAggregateStable: hasStableAggregateLatency(allLatencies, {
            maxSpreadRatio: 0.65,
            maxLatencyMs: 700,
            maxMedianMs: 320
        }),
        trimmedAggregateLatencyStable: hasStableAggregateLatency(dropWorstLatency(allLatencies), {
            maxSpreadRatio: 0.45,
            maxLatencyMs: 420,
            maxMedianMs: 320
        }),
        failurePhase: firstFailure ? firstFailure.failurePhase : null,
        anySignal,
        debug: {
            sessions: coldRetests,
            attempts
        }
    };
}

function hasWarmRecoverableSignal(warmCheck) {
    if (!warmCheck) return false;

    return Boolean(
        warmCheck.ok ||
        warmCheck.readyReached ||
        warmCheck.sawConnectingToProxy ||
        warmCheck.forcedReconnect
    );
}

function hasColdRecoverableSignal(coldRetest) {
    if (!coldRetest) return false;

    return Boolean(
        coldRetest.anySignal ||
        coldRetest.networkOk ||
        coldRetest.readyReached ||
        coldRetest.realTrafficOk ||
        coldRetest.apiProbePassed === true ||
        (coldRetest.successAttempts || 0) > 0 ||
        (coldRetest.passedColdSessions || 0) > 0
    );
}

function getWarmSignalState(result) {
    const warmCheck = result && result.debug && result.debug.warmCheck
        ? result.debug.warmCheck
        : null;

    return {
        ok: Boolean(
            result &&
            (
                result.warmOk ||
                (warmCheck && warmCheck.ok)
            )
        ),
        readyReached: Boolean(
            result &&
            (
                result.warmReadyReached ||
                (warmCheck && warmCheck.readyReached)
            )
        ),
        sawConnectingToProxy: Boolean(
            result &&
            (
                result.warmSawConnectingToProxy ||
                (warmCheck && warmCheck.sawConnectingToProxy)
            )
        ),
        forcedReconnect: Boolean(
            result &&
            (
                result.warmForcedReconnect ||
                (warmCheck && warmCheck.forcedReconnect)
            )
        )
    };
}

function isSoftRecoverableFailure(result) {
    if (!result) return false;

    if (['wait_ready', 'ping_proxy'].includes(result.failurePhase)) {
        return true;
    }

    return Boolean(
        result.failurePhase === 'dc_sweep' &&
        result.debug &&
        Array.isArray(result.debug.dcSweep) &&
        isSoftDcFailure(result.debug.dcSweep)
    );
}

function getMobileSignalSummary(result) {
    const warm = getWarmSignalState(result);
    const allLatencies = Array.isArray(result && result.allLatencies) ? result.allLatencies : [];
    const medianLatency = percentileMedian(allLatencies);
    const trimmedMaxLatency = computeMaxLatency(dropWorstLatency(allLatencies));
    const pingLatencyMs = Number.isFinite(result && result.pingLatencyMs)
        ? result.pingLatencyMs
        : Number.POSITIVE_INFINITY;
    const networkOk = Boolean(result && result.networkOk);
    const readyReached = Boolean(result && result.readyReached) || warm.readyReached;
    const sawConnectingToProxy = Boolean(result && result.sawConnectingToProxy) || warm.sawConnectingToProxy;
    const forcedReconnect = Boolean(result && result.forcedReconnect) || warm.forcedReconnect;

    return {
        realTrafficOk: Boolean(result && result.realTrafficOk),
        apiProbePassed: result && result.apiProbePassed === true,
        networkOk,
        readyReached,
        forcedReconnect,
        warmReadyReached: warm.readyReached,
        sawConnectingToProxy,
        passedColdSessions: Number(result && result.passedColdSessions) || 0,
        successAttempts: Number(result && result.successAttempts) || 0,
        failAttempts: Number(result && result.failAttempts) || 0,
        softFailure: isSoftRecoverableFailure(result),
        nonSoftFailure: Boolean(result && result.failurePhase) && !isSoftRecoverableFailure(result),
        dnsHealthy: Boolean(
            result &&
            result.dnsStabilityPassed !== false &&
            result.dnsStrongEligible !== false
        ),
        hasAnyMobileSignal: Boolean(
            result &&
            (
                result.realTrafficOk ||
                result.apiProbePassed === true ||
                networkOk ||
                readyReached ||
                forcedReconnect ||
                sawConnectingToProxy ||
                (Number(result.passedColdSessions) || 0) > 0 ||
                (Number(result.successAttempts) || 0) > 0
            )
        ),
        pingLatencyMs,
        medianLatency: Number.isFinite(medianLatency) ? medianLatency : Number.POSITIVE_INFINITY,
        trimmedMaxLatency: Number.isFinite(trimmedMaxLatency) ? trimmedMaxLatency : Number.POSITIVE_INFINITY,
        acceptableLatency: Boolean(
            Number.isFinite(pingLatencyMs) ||
            Number.isFinite(medianLatency) ||
            Number.isFinite(trimmedMaxLatency)
        )
    };
}

function compareMayWorkCandidates(left, right) {
    const leftSignals = getMobileSignalSummary(left);
    const rightSignals = getMobileSignalSummary(right);

    const leftTraffic = Number(leftSignals.realTrafficOk || leftSignals.apiProbePassed);
    const rightTraffic = Number(rightSignals.realTrafficOk || rightSignals.apiProbePassed);
    if (leftTraffic !== rightTraffic) return rightTraffic - leftTraffic;

    const leftNetworkReady = Number(leftSignals.networkOk && leftSignals.readyReached);
    const rightNetworkReady = Number(rightSignals.networkOk && rightSignals.readyReached);
    if (leftNetworkReady !== rightNetworkReady) return rightNetworkReady - leftNetworkReady;

    if (leftSignals.forcedReconnect !== rightSignals.forcedReconnect) {
        return Number(rightSignals.forcedReconnect) - Number(leftSignals.forcedReconnect);
    }

    if (leftSignals.warmReadyReached !== rightSignals.warmReadyReached) {
        return Number(rightSignals.warmReadyReached) - Number(leftSignals.warmReadyReached);
    }

    if (leftSignals.sawConnectingToProxy !== rightSignals.sawConnectingToProxy) {
        return Number(rightSignals.sawConnectingToProxy) - Number(leftSignals.sawConnectingToProxy);
    }

    const leftColdConfirmed = Number(leftSignals.passedColdSessions > 0);
    const rightColdConfirmed = Number(rightSignals.passedColdSessions > 0);
    if (leftColdConfirmed !== rightColdConfirmed) {
        return rightColdConfirmed - leftColdConfirmed;
    }

    if (leftSignals.passedColdSessions !== rightSignals.passedColdSessions) {
        return rightSignals.passedColdSessions - leftSignals.passedColdSessions;
    }

    const leftSucceeded = Number(leftSignals.successAttempts > 0);
    const rightSucceeded = Number(rightSignals.successAttempts > 0);
    if (leftSucceeded !== rightSucceeded) {
        return rightSucceeded - leftSucceeded;
    }

    if (leftSignals.successAttempts !== rightSignals.successAttempts) {
        return rightSignals.successAttempts - leftSignals.successAttempts;
    }

    if (leftSignals.softFailure !== rightSignals.softFailure) {
        return Number(rightSignals.softFailure) - Number(leftSignals.softFailure);
    }

    if (leftSignals.nonSoftFailure !== rightSignals.nonSoftFailure) {
        return Number(leftSignals.nonSoftFailure) - Number(rightSignals.nonSoftFailure);
    }

    if (leftSignals.hasAnyMobileSignal !== rightSignals.hasAnyMobileSignal) {
        return Number(rightSignals.hasAnyMobileSignal) - Number(leftSignals.hasAnyMobileSignal);
    }

    const leftDnsPenalty = Number(!leftSignals.dnsHealthy && !leftTraffic);
    const rightDnsPenalty = Number(!rightSignals.dnsHealthy && !rightTraffic);
    if (leftDnsPenalty !== rightDnsPenalty) {
        return leftDnsPenalty - rightDnsPenalty;
    }

    if (leftSignals.acceptableLatency !== rightSignals.acceptableLatency) {
        return Number(rightSignals.acceptableLatency) - Number(leftSignals.acceptableLatency);
    }

    if (leftSignals.dnsHealthy !== rightSignals.dnsHealthy) {
        return Number(rightSignals.dnsHealthy) - Number(leftSignals.dnsHealthy);
    }

    if (leftSignals.failAttempts !== rightSignals.failAttempts) {
        return leftSignals.failAttempts - rightSignals.failAttempts;
    }

    if (leftSignals.medianLatency !== rightSignals.medianLatency) {
        return leftSignals.medianLatency - rightSignals.medianLatency;
    }

    if (leftSignals.trimmedMaxLatency !== rightSignals.trimmedMaxLatency) {
        return leftSignals.trimmedMaxLatency - rightSignals.trimmedMaxLatency;
    }

    if (leftSignals.pingLatencyMs !== rightSignals.pingLatencyMs) {
        return leftSignals.pingLatencyMs - rightSignals.pingLatencyMs;
    }

    return `${left.server}:${left.port}`.localeCompare(`${right.server}:${right.port}`);
}

function classifyProxyCheck({ candidate, dcSweep, warmCheck, coldRetest, attempts }) {
    const dcSuccessCount = dcSweep.filter(item => item.ok).length;
    const hasDnsFailure = dcSweep.some(item => item.error === 'DNS_ERROR');
    const warmHasSignal = hasWarmRecoverableSignal(warmCheck);
    const coldHasSignal = hasColdRecoverableSignal(coldRetest);
    const hasRecoverableSignal = dcSuccessCount > 0 && !hasDnsFailure && (warmHasSignal || coldHasSignal);
    const multiAddressDdOrEeHostname =
        Boolean(
            candidate &&
            candidate.server &&
            !isIpAddress(candidate.server) &&
            ['dd', 'ee'].includes(String(candidate.proxyType || '').toLowerCase()) &&
            coldRetest &&
            coldRetest.dnsSingleAddressOnly === false
        );
    const capReason = getMayWorkCapReason(coldRetest);
    const volatilityCapped = capReason != null;
    const failureTypeDiagnostics = collectFailureTypeDiagnostics(coldRetest, warmCheck, dcSweep);
    const latencyDiagnostics = getLatencyDiagnostics(coldRetest);
    const ddPartialColdRouteSignal = getDdPartialColdRouteSignal(
        coldRetest,
        candidate,
        warmCheck,
        dcSweep,
        failureTypeDiagnostics,
        latencyDiagnostics
    );
    const outcomeBase = {
        volatilityCapped,
        capReason,
        routeFlapRecoverable: false,
        ddPartialColdRouteRecoverable: ddPartialColdRouteSignal.recoverable,
        ddPartialColdRouteBlockReason: ddPartialColdRouteSignal.blockReason,
        candidatePatternClass: failureTypeDiagnostics.candidatePatternClass,
        readyTimeoutSessions: failureTypeDiagnostics.readyTimeoutSessions,
        pingTimeoutOnlySessions: failureTypeDiagnostics.pingTimeoutOnlySessions,
        dcSweepFailedSessions: failureTypeDiagnostics.dcSweepFailedSessions,
        apiConfirmedButUnpassedSessions: failureTypeDiagnostics.apiConfirmedButUnpassedSessions,
        warmReadyTimeout: failureTypeDiagnostics.warmReadyTimeout,
        hasValidLatencySample: latencyDiagnostics.hasValidLatencySample,
        latencySampleCount: latencyDiagnostics.latencySampleCount,
        medianLatency: latencyDiagnostics.medianLatency
    };

    if (dcSuccessCount === 0) {
        return {
            isAlive: false,
            status: STATUS.FAIL,
            confidence: 0,
            failurePhase: 'dc_sweep',
            promoteReason: null,
            ...outcomeBase
        };
    }

    if (hasDnsFailure) {
        return {
            isAlive: false,
            status: STATUS.FAIL,
            confidence: 0,
            failurePhase: 'dc_sweep',
            promoteReason: null,
            ...outcomeBase
        };
    }

    if (dcSuccessCount < DEFAULT_DC_SWEEP.length) {
        const partialHasRealTraffic =
            warmCheck &&
            warmCheck.ok &&
            coldRetest &&
            (
                coldRetest.coldRetestPassed ||
                coldRetest.nearTrusted ||
                (coldRetest.passedColdSessions || 0) > 0
            );
        const partialCanTrust =
            partialHasRealTraffic &&
            coldRetest &&
            coldRetest.coldRetestPassed &&
            coldRetest.dnsStabilityPassed !== false &&
            coldRetest.dnsStrongEligible !== false &&
            !multiAddressDdOrEeHostname &&
            hasStableAggregateLatency(coldRetest.allLatencies || [], {
                maxSpreadRatio: 0.6,
                maxLatencyMs: 650,
                maxMedianMs: 320
            }) &&
            isSoftDcFailure(dcSweep);
        const partialNearTrusted =
            partialHasRealTraffic &&
            coldRetest &&
            coldRetest.almostPassedColdSessions &&
            (coldRetest.failAttempts || 0) <= 1 &&
            coldRetest.failurePhase === 'ping_proxy' &&
            hasStableAggregateLatency(coldRetest.allLatencies || [], {
                maxSpreadRatio: 0.18,
                maxLatencyMs: 340,
                maxMedianMs: 260
            }) &&
            coldRetest.dnsStabilityPassed !== false &&
            coldRetest.dnsStrongEligible !== false &&
            !multiAddressDdOrEeHostname &&
            isSoftDcFailure(dcSweep);
        const partialCurrentPathHostnameWorking =
            coldRetest &&
            !volatilityCapped &&
            hasStableCurrentRouteWorkingSignal(coldRetest, candidate, attempts, warmCheck, dcSweep);

        if (partialCanTrust) {
            return {
                isAlive: true,
                status: STATUS.WORKING,
                confidence: 0.95,
                failurePhase: null,
                promoteReason: 'partial_strict_cold',
                ...outcomeBase
            };
        }

        if (partialNearTrusted) {
            return {
                isAlive: true,
                status: STATUS.WORKING,
                confidence: 0.9,
                failurePhase: null,
                promoteReason: 'partial_near_trusted',
                ...outcomeBase
            };
        }

        if (partialCurrentPathHostnameWorking) {
            return {
                isAlive: true,
                status: STATUS.WORKING,
                confidence: 0.85,
                failurePhase: null,
                promoteReason: 'stable_current_route',
                ...outcomeBase
            };
        }

        return {
            isAlive: partialHasRealTraffic || warmHasSignal || coldHasSignal,
            status: (partialHasRealTraffic || warmHasSignal || coldHasSignal) ? STATUS.MAY_WORK : STATUS.FAIL,
            confidence: (partialHasRealTraffic || warmHasSignal || coldHasSignal) ? 0.5 : 0,
            failurePhase: 'dc_sweep',
            promoteReason: null,
            ...outcomeBase
        };
    }

    if (!warmCheck) {
        return {
            isAlive: false,
            status: STATUS.FAIL,
            confidence: 0,
            failurePhase: 'enable_proxy',
            promoteReason: null,
            ...outcomeBase
        };
    }

    if (!warmCheck.ok && !coldRetest) {
        return {
            isAlive: warmHasSignal,
            status: warmHasSignal ? STATUS.MAY_WORK : STATUS.FAIL,
            confidence: warmHasSignal ? 0.5 : 0,
            failurePhase: warmCheck.failurePhase ? warmCheck.failurePhase : 'enable_proxy',
            promoteReason: null,
            ...outcomeBase
        };
    }

    if (!coldRetest) {
        return {
            isAlive: hasRecoverableSignal,
            status: hasRecoverableSignal ? STATUS.MAY_WORK : STATUS.FAIL,
            confidence: hasRecoverableSignal ? 0.5 : 0,
            failurePhase: 'cold_retest',
            promoteReason: null,
            ...outcomeBase
        };
    }

    const nearWorking =
        coldRetest.nearTrusted &&
        coldRetest.failurePhase === 'ping_proxy' &&
        coldRetest.dnsStabilityPassed !== false &&
        coldRetest.dnsStrongEligible !== false &&
        !multiAddressDdOrEeHostname &&
        hasStableAggregateLatency(coldRetest.allLatencies || [], {
            maxSpreadRatio: 0.18,
            maxLatencyMs: 340,
            maxMedianMs: 260
        });

    const ipFullWorking =
        coldRetest.coldRetestPassed &&
        coldRetest.dnsStabilityPassed !== false &&
        coldRetest.dnsStrongEligible !== false &&
        !multiAddressDdOrEeHostname &&
        coldRetest.relaxedIpAggregateStable === true;

    const softOutlierWorking =
        coldRetest.almostPassedColdSessions &&
        coldRetest.failurePhase === 'ping_proxy' &&
        coldRetest.dnsStabilityPassed !== false &&
        coldRetest.dnsStrongEligible !== false &&
        !multiAddressDdOrEeHostname &&
        coldRetest.failAttempts === 0 &&
        (coldRetest.passedColdSessions || 0) > 0 &&
        coldRetest.forcedReconnect &&
        coldRetest.trimmedAggregateLatencyStable === true &&
        computeMaxLatency(coldRetest.allLatencies || []) <= 900;

    const recoverableIpWorking =
        coldRetest.requiredColdSessions === REQUIRED_COLD_CONFIRMATIONS &&
        (coldRetest.passedColdSessions || 0) >= 1 &&
        coldRetest.dnsStabilityPassed !== false &&
        coldRetest.dnsStrongEligible !== false &&
        !multiAddressDdOrEeHostname &&
        ['wait_ready', 'ping_proxy', null].includes(coldRetest.failurePhase || null) &&
        (coldRetest.successAttempts || 0) >= 4 &&
        (coldRetest.failAttempts || 0) <= 4 &&
        percentileMedian(coldRetest.allLatencies || []) != null &&
        percentileMedian(coldRetest.allLatencies || []) <= 260 &&
        computeMaxLatency(coldRetest.allLatencies || []) <= 650;

    const almostWorkingIp =
        coldRetest.requiredColdSessions === REQUIRED_COLD_CONFIRMATIONS &&
        (coldRetest.passedColdSessions || 0) >= Math.max(1, REQUIRED_COLD_CONFIRMATIONS - 1) &&
        coldRetest.dnsStabilityPassed !== false &&
        coldRetest.dnsStrongEligible !== false &&
        !multiAddressDdOrEeHostname &&
        coldRetest.failurePhase === 'ping_proxy' &&
        (coldRetest.successAttempts || 0) >= 6 &&
        (coldRetest.failAttempts || 0) <= 2 &&
        (coldRetest.allErrors || []).every(error => /TIMEOUT/.test(String(error))) &&
        percentileMedian(coldRetest.allLatencies || []) != null &&
        percentileMedian(coldRetest.allLatencies || []) <= 220 &&
        computeMaxLatency(dropWorstLatency(coldRetest.allLatencies || [])) <= 420;

    const strongWorkingTraffic =
        hasStrongWorkingTrafficSignal(coldRetest, candidate, attempts, warmCheck) &&
        !multiAddressDdOrEeHostname;
    const trafficOnlyHostnameWorking =
        hasTrafficOnlyHostnameWorkingSignal(coldRetest, candidate, warmCheck);
    const pingProxyRouteConfirmedWorking =
        volatilityCapped &&
        capReason === 'too_many_failures' &&
        hasPingProxyRouteConfirmedWorkingSignal(coldRetest, candidate, warmCheck, failureTypeDiagnostics);
    const purePingProxyPartialColdWorking =
        volatilityCapped &&
        capReason === 'too_many_failures' &&
        hasPurePingProxyPartialColdWorkingSignal(
            coldRetest,
            candidate,
            warmCheck,
            failureTypeDiagnostics,
            latencyDiagnostics
        );
    const ddPartialColdRouteWorking =
        hasDdPartialColdRouteWorkingSignal(
            coldRetest,
            candidate,
            warmCheck,
            dcSweep,
            failureTypeDiagnostics,
            latencyDiagnostics
        );
    const stableCurrentRouteWorking =
        !volatilityCapped &&
        hasStableCurrentRouteWorkingSignal(coldRetest, candidate, attempts, warmCheck, dcSweep);
    const relaxedConfirmedHostnameWorking =
        !volatilityCapped &&
        hasRelaxedFullyConfirmedHostnameWorkingSignal(coldRetest, candidate) &&
        !multiAddressDdOrEeHostname;

    if (strongWorkingTraffic) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: isIpAddress(candidate && candidate.server) ? 0.9 : 0.85,
            failurePhase: null,
            promoteReason: 'strong_working_traffic',
            ...outcomeBase
        };
    }

    if (trafficOnlyHostnameWorking) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 0.8,
            failurePhase: null,
            promoteReason: 'traffic_only_hostname',
            ...outcomeBase
        };
    }

    if (
        coldRetest.coldRetestPassed &&
        coldRetest.dnsStabilityPassed !== false &&
        coldRetest.dnsStrongEligible !== false &&
        !multiAddressDdOrEeHostname &&
        coldRetest.aggregateLatencyStable === true
    ) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 1,
            failurePhase: null,
            promoteReason: 'strict_cold_confirmed',
            ...outcomeBase
        };
    }

    if (purePingProxyPartialColdWorking) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 0.82,
            failurePhase: null,
            promoteReason: 'pure_ping_proxy_partial_cold',
            ...outcomeBase,
            routeFlapRecoverable: true
        };
    }

    if (pingProxyRouteConfirmedWorking) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 0.8,
            failurePhase: null,
            promoteReason: 'ping_proxy_route_confirmed',
            ...outcomeBase,
            routeFlapRecoverable: true
        };
    }

    if (ddPartialColdRouteWorking) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 0.78,
            failurePhase: null,
            promoteReason: 'dd_partial_cold_route_confirmed',
            ...outcomeBase,
            routeFlapRecoverable: true
        };
    }

    if (stableCurrentRouteWorking) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 0.85,
            failurePhase: null,
            promoteReason: 'stable_current_route',
            ...outcomeBase
        };
    }

    if (relaxedConfirmedHostnameWorking) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 0.95,
            failurePhase: null,
            promoteReason: 'relaxed_confirmed_hostname',
            ...outcomeBase
        };
    }

    if (ipFullWorking) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 0.95,
            failurePhase: null,
            promoteReason: 'relaxed_ip_aggregate',
            ...outcomeBase
        };
    }

    if (softOutlierWorking) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 0.9,
            failurePhase: null,
            promoteReason: 'soft_outlier',
            ...outcomeBase
        };
    }

    if (recoverableIpWorking) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 0.8,
            failurePhase: null,
            promoteReason: 'recoverable_ip',
            ...outcomeBase
        };
    }

    if (almostWorkingIp) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 0.85,
            failurePhase: null,
            promoteReason: 'almost_working_ip',
            ...outcomeBase
        };
    }

    if (nearWorking) {
        return {
            isAlive: true,
            status: STATUS.WORKING,
            confidence: 0.9,
            failurePhase: null,
            promoteReason: 'near_working',
            ...outcomeBase
        };
    }

    if (!coldRetest.ok) {
        return {
            isAlive: hasRecoverableSignal,
            status: hasRecoverableSignal ? STATUS.MAY_WORK : STATUS.FAIL,
            confidence: hasRecoverableSignal ? 0.5 : 0,
            failurePhase: coldRetest.failurePhase || 'cold_retest',
            promoteReason: null,
            ...outcomeBase
        };
    }

    if (
        (coldRetest.passedColdSessions || 0) === 0 &&
        (
            !coldRetest.readyReached ||
            !coldRetest.forcedReconnect ||
            !coldRetest.networkOk ||
            !coldRetest.realTrafficOk ||
            coldRetest.apiProbePassed === false
        )
    ) {
        return {
            isAlive: hasRecoverableSignal,
            status: hasRecoverableSignal ? STATUS.MAY_WORK : STATUS.FAIL,
            confidence: hasRecoverableSignal ? 0.5 : 0,
            failurePhase: coldRetest.failurePhase || 'cold_retest',
            promoteReason: null,
            ...outcomeBase
        };
    }

    if (coldRetest.coldRetestPassed && coldRetest.dnsStabilityPassed === false) {
        return {
            isAlive: true,
            status: STATUS.MAY_WORK,
            confidence: 0.5,
            failurePhase: 'dns_stability',
            promoteReason: null,
            ...outcomeBase
        };
    }

    const stability = computeConfidence(
        coldRetest.allLatencies || [],
        coldRetest.allErrors || [],
        Math.max(attempts, coldRetest.successAttempts + coldRetest.failAttempts)
    );

    return {
        isAlive: true,
        status: STATUS.MAY_WORK,
        confidence: Math.max(0.5, stability.confidence || 0.5),
        failurePhase: coldRetest.failurePhase || 'ping_proxy',
        promoteReason: null,
        ...outcomeBase
    };
}

class ColdRetestScheduler {
    constructor(options = {}) {
        this.concurrency = Math.max(1, Number(options.concurrency || MIN_COLD_SCHEDULER_CONCURRENCY));
        this.cancelState = options.cancelState || null;
        this.workerFactory = typeof options.workerFactory === 'function'
            ? options.workerFactory
            : (id => new Worker(id));
        this.sessionRunner = typeof options.sessionRunner === 'function'
            ? options.sessionRunner
            : null;
        this.queue = [];
        this.activeCount = 0;
        this.sequence = 0;
        this.closed = false;
        this.idleResolvers = new Set();
    }

    _resolveIdleIfNeeded() {
        if (this.activeCount !== 0 || this.queue.length !== 0) return;
        for (const resolve of this.idleResolvers) {
            resolve();
        }
        this.idleResolvers.clear();
    }

    async _runScheduledSession(candidate, context = {}) {
        if (this.sessionRunner) {
            return this.sessionRunner(candidate, context);
        }

        const coldWorker = this.workerFactory(`cold-${context.pass}-${context.sequence}-${Date.now()}`);
        coldWorker.setCancelState(this.cancelState);
        const coldInitStartedAt = Date.now();

        try {
            await coldWorker.init(Math.max(12, context.timeoutSeconds + 4));
            const session = await coldWorker.runStrictConfirmation(
                candidate,
                context.timeoutSeconds,
                context.attempts,
                context.verbose
            );
            return {
                ...session,
                session: context.pass
            };
        } catch (error) {
            return createColdRetestFailureSession(
                context.pass,
                context.attempts,
                error,
                context.verbose,
                {
                    initError: classifyTdError(error),
                    attempts: []
                }
            );
        } finally {
            await coldWorker.close();
        }
    }

    _pump() {
        while (!this.closed && this.activeCount < this.concurrency && this.queue.length > 0) {
            const entry = this.queue.shift();
            const sequence = ++this.sequence;
            const startedAt = Date.now();
            const queueWaitMs = startedAt - entry.enqueuedAt;
            this.activeCount += 1;

            Promise.resolve()
                .then(() => this._runScheduledSession(entry.candidate, {
                    ...entry.context,
                    sequence,
                    queueWaitMs
                }))
                .then(result => {
                    entry.resolve({
                        ...result,
                        queueWaitMs,
                        executionMs: Date.now() - startedAt
                    });
                })
                .catch(error => {
                    entry.reject(error);
                })
                .finally(() => {
                    this.activeCount -= 1;
                    this._pump();
                    this._resolveIdleIfNeeded();
                });
        }
    }

    schedule(candidate, context = {}) {
        if (this.closed) {
            return Promise.reject(new Error('Cold scheduler is closed'));
        }

        return new Promise((resolve, reject) => {
            this.queue.push({
                candidate,
                context,
                enqueuedAt: Date.now(),
                resolve,
                reject
            });
            this._pump();
        });
    }

    async waitForIdle() {
        if (this.activeCount === 0 && this.queue.length === 0) {
            return;
        }

        await new Promise(resolve => {
            this.idleResolvers.add(resolve);
        });
    }

    async close() {
        this.closed = true;
        while (this.queue.length > 0) {
            const entry = this.queue.shift();
            entry.reject(new Error('Cold scheduler is closed'));
        }
        this._resolveIdleIfNeeded();
        await this.waitForIdle();
    }
}

async function runScheduledColdRetests(candidate, options = {}) {
    const attempts = options.attempts;
    const verbose = options.verbose === true;
    const requiredColdSessions = options.requiredColdSessions ?? getRequiredColdConfirmations(candidate);
    const maxColdSessions = options.maxColdSessions ?? getMaxColdConfirmationSessions(candidate);
    const finalTimeoutSeconds = options.finalTimeoutSeconds ?? getFinalTimeoutSeconds(options.timeoutSeconds);
    const injectedScheduleColdSession = typeof options.scheduleColdSession === 'function';
    const coldScheduler = options.coldScheduler || new ColdRetestScheduler({
        concurrency: MIN_COLD_SCHEDULER_CONCURRENCY,
        cancelState: options.cancelState || null
    });
    const ownScheduler = !options.coldScheduler && !injectedScheduleColdSession;
    const dnsLookupFn = typeof options.dnsLookupFn === 'function' ? options.dnsLookupFn : dns.lookup;
    const dnsLookupTimeoutMs = options.dnsLookupTimeoutMs ?? DNS_LOOKUP_TIMEOUT_MS;
    const targetParallelism = Math.min(requiredColdSessions, MIN_COLD_SCHEDULER_CONCURRENCY);
    const coldSessions = [];
    const inFlight = new Map();
    const detachedSettlers = [];
    let successfulColdSessions = 0;
    let nextPass = 1;

    const dnsStabilityPromise = checkDnsStability(candidate.server, 3, dnsLookupFn, {
        timeoutMs: dnsLookupTimeoutMs,
        cancelState: options.cancelState || null
    });

    const scheduleColdSession = pass => {
        if (injectedScheduleColdSession) {
            return options.scheduleColdSession(pass);
        }

        return coldScheduler.schedule(candidate, {
            pass,
            attempts,
            timeoutSeconds: finalTimeoutSeconds,
            verbose
        });
    };

    const maybeStartMoreSessions = () => {
        while (inFlight.size < targetParallelism && nextPass <= maxColdSessions) {
            const pass = nextPass;
            nextPass += 1;
            const sessionPromise = Promise.resolve()
                .then(() => scheduleColdSession(pass))
                .then(session => ({
                    pass,
                    session: {
                        ...session,
                        session: session.session || pass
                    }
                }));
            inFlight.set(pass, sessionPromise);
        }
    };

    maybeStartMoreSessions();

    while (inFlight.size > 0) {
        const settled = await Promise.race(
            Array.from(inFlight.entries(), ([pass, promise]) =>
                promise.then(value => ({ pass, value }))
            )
        );
        inFlight.delete(settled.pass);

        const session = settled.value.session;
        coldSessions.push(session);
        if (session.coldRetestPassed) {
            successfulColdSessions += 1;
        }

        const disposition = resolveColdRetestDisposition({
            successfulSessions: successfulColdSessions,
            completedSessions: coldSessions.length,
            scheduledSessions: nextPass - 1,
            requiredSessions: requiredColdSessions,
            maxSessions: maxColdSessions
        });

        if (disposition.locked) {
            if (inFlight.size > 0) {
                detachedSettlers.push(Promise.allSettled(inFlight.values()));
            }
            break;
        }

        maybeStartMoreSessions();
    }

    if (ownScheduler) {
        await Promise.allSettled(detachedSettlers);
        await coldScheduler.close();
    }

    const coldRetest = summarizeColdRetests(coldSessions, attempts, requiredColdSessions, {
        allowNearTrusted: isIpAddress(candidate.server)
    });

    if (!coldRetest) {
        return null;
    }

    const dnsStability = await dnsStabilityPromise;
    coldRetest.dnsStabilityPassed = dnsStability.ok;
    coldRetest.dnsStrongEligible = isIpAddress(candidate.server)
        ? true
        : Boolean(dnsStability.ok && dnsStability.strongEligible);
    coldRetest.dnsSingleAddressOnly = isIpAddress(candidate.server)
        ? true
        : Boolean(dnsStability.ok && dnsStability.singleAddressOnly);
    coldRetest.dnsSamples = dnsStability.samples;
    coldRetest.debug = {
        ...coldRetest.debug,
        dnsStability,
        timings: {
            queueWaitMs: coldSessions.reduce((sum, session) => sum + (session.queueWaitMs || 0), 0),
            executionMs: coldSessions.reduce((sum, session) => sum + (session.executionMs || 0), 0)
        }
    };

    return coldRetest;
}

function buildPreparedProbeResult(candidate, attempts, dcSweep, warmCheck, coldRetest, verbose, phaseTimings = {}, preparation = {}) {
    const outcome = classifyProxyCheck({
        candidate,
        dcSweep,
        warmCheck,
        coldRetest,
        attempts
    });

    const failReasons = [
        ...dcSweep.filter(item => !item.ok).map(item => `DC${item.dcId}:${item.error}`),
        ...((warmCheck && !warmCheck.ok && !warmCheck.skipped) ? [`WARM:${warmCheck.error}`] : []),
        ...((coldRetest && coldRetest.allErrors) || []).map(error => `COLD:${error}`)
    ];
    const latencyDiagnostics = getLatencyDiagnostics(coldRetest);
    const timeoutOnlyErrors = failReasons.length > 0 && failReasons.every(error => /TIMEOUT/.test(String(error)));

    return {
        isAlive: outcome.isAlive,
        status: outcome.status,
        confidence: outcome.confidence,
        successAttempts: coldRetest ? coldRetest.successAttempts : 0,
        failAttempts: coldRetest ? coldRetest.failAttempts : attempts,
        pingLatencyMs: coldRetest ? coldRetest.pingLatencyMs : null,
        allLatencies: coldRetest ? coldRetest.allLatencies : [],
        allErrors: failReasons,
        networkOk: Boolean(coldRetest && coldRetest.networkOk),
        warmOk: Boolean(warmCheck && warmCheck.ok),
        readyReached: Boolean(coldRetest && coldRetest.readyReached),
        sawConnectingToProxy: Boolean(coldRetest && coldRetest.sawConnectingToProxy),
        forcedReconnect: Boolean(coldRetest && coldRetest.forcedReconnect),
        warmReadyReached: Boolean(warmCheck && warmCheck.readyReached),
        warmSawConnectingToProxy: Boolean(warmCheck && warmCheck.sawConnectingToProxy),
        warmForcedReconnect: Boolean(warmCheck && warmCheck.forcedReconnect),
        realTrafficOk: Boolean(coldRetest && coldRetest.realTrafficOk),
        apiProbePassed: Boolean(coldRetest && coldRetest.apiProbePassed),
        apiProbeChecks: coldRetest ? coldRetest.apiProbeChecks : [],
        coldRetestPassed: Boolean(coldRetest && coldRetest.coldRetestPassed),
        dnsStabilityPassed: coldRetest ? coldRetest.dnsStabilityPassed !== false : false,
        dnsStrongEligible: coldRetest ? coldRetest.dnsStrongEligible !== false : false,
        dnsSingleAddressOnly: coldRetest ? coldRetest.dnsSingleAddressOnly !== false : false,
        dnsSamples: coldRetest ? coldRetest.dnsSamples || [] : [],
        requiredColdSessions: coldRetest ? coldRetest.requiredColdSessions : getRequiredColdConfirmations(candidate),
        passedColdSessions: coldRetest ? coldRetest.passedColdSessions || 0 : 0,
        currentRouteReadyRatio: coldRetest ? coldRetest.currentRouteReadyRatio || 0 : 0,
        currentRouteApiRatio: coldRetest ? coldRetest.currentRouteApiRatio || 0 : 0,
        volatilityCapped: Boolean(outcome.volatilityCapped),
        capReason: outcome.capReason || null,
        rawMaxLatency: latencyDiagnostics.rawMaxLatency,
        trimmedMaxLatency: latencyDiagnostics.trimmedMaxLatency,
        timeoutOnlyErrors,
        routeFlapRecoverable: Boolean(outcome.routeFlapRecoverable),
        ddPartialColdRouteRecoverable: Boolean(outcome.ddPartialColdRouteRecoverable),
        ddPartialColdRouteBlockReason: outcome.ddPartialColdRouteBlockReason || null,
        candidatePatternClass: outcome.candidatePatternClass || 'mixed_failures',
        readyTimeoutSessions: Number(outcome.readyTimeoutSessions || 0),
        pingTimeoutOnlySessions: Number(outcome.pingTimeoutOnlySessions || 0),
        dcSweepFailedSessions: Number(outcome.dcSweepFailedSessions || 0),
        apiConfirmedButUnpassedSessions: Number(outcome.apiConfirmedButUnpassedSessions || 0),
        warmReadyTimeout: Boolean(outcome.warmReadyTimeout),
        hasValidLatencySample: Boolean(outcome.hasValidLatencySample),
        latencySampleCount: Number(outcome.latencySampleCount || 0),
        medianLatency: outcome.medianLatency ?? null,
        promoteReason: outcome.promoteReason || null,
        failurePhase: outcome.failurePhase,
        debug: verbose ? {
            dcSweep,
            warmCheck,
            coldRetest,
            preparation: {
                warmCheckSkipped: preparation.warmCheckSkipped === true,
                skipReason: preparation.skipReason || null,
                dcSuccessCount: preparation.dcSuccessCount || 0
            },
            timings: {
                ...buildPhaseTimings(phaseTimings),
                coldQueueWaitMs: coldRetest && coldRetest.debug && coldRetest.debug.timings
                    ? coldRetest.debug.timings.queueWaitMs || 0
                    : phaseTimings.coldQueueWaitMs || 0,
                coldExecutionMs: coldRetest && coldRetest.debug && coldRetest.debug.timings
                    ? coldRetest.debug.timings.executionMs || 0
                    : phaseTimings.coldExecutionMs || 0
            }
        } : undefined
    };
}

class Worker {
    constructor(id) {
        this.id = id;
        this.client = null;
        this.dbDir = null;
        this.alive = false;
        this.cancelState = null;
        this.readyState = null;
        this.connectionState = null;
        this.connectionStateHistory = [];
        this.activeProxyId = null;
        this.proxyCleanupInitialized = false;
    }

    setCancelState(cancelState) {
        this.cancelState = cancelState || null;
        return this;
    }

    async init(timeoutSeconds = 12) {
        ensureTdlibConfigured();

        this.dbDir = createTempDir(`telegram_proxy_worker_${this.id}_`);
        const client = tdl.createClient({
            apiId: API_ID,
            apiHash: API_HASH,
            databaseDirectory: path.join(this.dbDir, 'db'),
            filesDirectory: path.join(this.dbDir, 'files'),
            tdlibParameters: {
                use_message_database: false,
                use_chat_info_database: false,
                use_file_database: false,
                use_secret_chats: false,
                enable_storage_optimizer: false,
                ignore_file_names: true,
                system_language_code: 'en',
                device_model: `ProxyChecker-${os.platform()}`,
                system_version: os.release(),
                application_version: '2.0'
            }
        });
        this.client = client;

        client.on('error', () => {});
        client.on('update', update => {
            if (update._ === 'updateConnectionState') {
                this.connectionState = update.state._;
                this.connectionStateHistory.push({
                    at: Date.now(),
                    state: update.state._
                });
                if (this.connectionStateHistory.length > 50) {
                    this.connectionStateHistory.shift();
                }
            }
        });

        await new Promise((resolve, reject) => {
            let finished = false;
            const cleanup = () => {
                clearTimeout(timeout);
                client.off('update', onUpdate);
            };
            const settle = callback => value => {
                if (finished) return;
                finished = true;
                cleanup();
                callback(value);
            };
            const timeout = setTimeout(() => settle(reject)(new Error('Init timeout')), timeoutSeconds * 1000);

            const onUpdate = update => {
                if (update._ !== 'updateAuthorizationState') return;

                const state = update.authorization_state._;
                this.readyState = state;

                if (
                    state === 'authorizationStateWaitPhoneNumber' ||
                    state === 'authorizationStateReady'
                ) {
                    settle(resolve)();
                }

                if (state === 'authorizationStateClosed') {
                    settle(reject)(new Error('TDLib closed during init'));
                }
            };

            client.on('update', onUpdate);
        });

        this.alive = true;
    }

    async safeInvoke(query, timeoutMs) {
        if (!this.client) {
            throw new Error('Worker is not initialized');
        }
        throwIfCancelled(this.cancelState);

        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = callback => value => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                offCancel();
                callback(value);
            };

            const timeout = setTimeout(() => {
                finish(reject)(new Error(`Timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            const offCancel = addCancelListener(this.cancelState, () => {
                finish(reject)(createCancelledError());
            });

            this.client.invoke(query).then(
                finish(resolve),
                finish(reject)
            );
        });
    }

    async clearProxy(options = {}) {
        const forceFull = options.full === true || !this.proxyCleanupInitialized;
        try {
            await this.safeInvoke({ _: 'disableProxy' }, 2500);
        } catch (_) {}

        if (!forceFull) {
            if (this.activeProxyId != null) {
                try {
                    await this.safeInvoke({ _: 'removeProxy', proxy_id: this.activeProxyId }, 2500);
                    this.activeProxyId = null;
                    return;
                } catch (_) {
                    return this.clearProxy({ full: true });
                }
            } else {
                return;
            }
        }

        try {
            const proxies = await this.safeInvoke({ _: 'getProxies' }, 2500);
            for (const item of proxies.proxies || []) {
                try {
                    await this.safeInvoke({ _: 'removeProxy', proxy_id: item.id }, 2500);
                } catch (_) {}
            }
            this.activeProxyId = null;
        } catch (_) {}
        this.proxyCleanupInitialized = true;
    }

    async waitForConnectionState(targetStates, timeoutMs, stateHistoryStart = 0) {
        throwIfCancelled(this.cancelState);
        const allowed = new Set(targetStates);

        for (const item of this.connectionStateHistory.slice(stateHistoryStart)) {
            if (allowed.has(item.state)) {
                return item.state;
            }
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = callback => value => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                this.client.off('update', onUpdate);
                offCancel();
                callback(value);
            };
            const timeout = setTimeout(() => {
                finish(reject)(new Error('Connection state timeout'));
            }, timeoutMs);
            const offCancel = addCancelListener(this.cancelState, () => {
                finish(reject)(createCancelledError());
            });

            const onUpdate = update => {
                if (update._ !== 'updateConnectionState') return;
                if (!allowed.has(update.state._)) return;

                finish(resolve)(update.state._);
            };

            this.client.on('update', onUpdate);
        });
    }

    async forceReconnect() {
        const stateHistoryStart = this.connectionStateHistory.length;

        await this.safeInvoke(
            { _: 'setNetworkType', type: { _: 'networkTypeNone' } },
            2000
        );
        await sleep(DEFAULT_RECONNECT_DELAY_MS);
        await this.safeInvoke(
            { _: 'setNetworkType', type: { _: 'networkTypeWiFi' } },
            2000
        );

        return {
            forcedReconnect: true,
            stateHistoryStart
        };
    }

    async runDcSweep(candidate, timeoutSeconds) {
        const dcResults = [];

        for (const dcId of DEFAULT_DC_SWEEP) {
            throwIfCancelled(this.cancelState);
            const startedAt = Date.now();
            try {
                await this.safeInvoke(
                    {
                        _: 'testProxy',
                        proxy: toTdProxy(candidate),
                        dc_id: dcId,
                        timeout: timeoutSeconds
                    },
                    timeoutSeconds * 1000 + 1500
                );

                dcResults.push({
                    dcId,
                    ok: true,
                    wallMs: Date.now() - startedAt
                });
            } catch (error) {
                const classifiedError = classifyTdError(error);
                dcResults.push({
                    dcId,
                    ok: false,
                    error: classifiedError,
                    wallMs: Date.now() - startedAt
                });
                if (classifiedError === 'DNS_ERROR') {
                    break;
                }
            }
        }

        return dcResults;
    }

    async probeRealTraffic(timeoutSeconds) {
        throwIfCancelled(this.cancelState);
        const queries = [
            { _: 'getApplicationConfig' },
            { _: 'getCountries' },
            { _: 'getCountryCode' }
        ];
        const settled = await Promise.allSettled(
            queries.map(query => this.safeInvoke(query, timeoutSeconds * 1000))
        );
        const checks = settled.map((entry, index) => {
            const query = queries[index];
            if (entry.status === 'fulfilled') {
                const result = entry.value;
                const ok =
                    query._ !== 'getCountryCode' ||
                    (result && result._ === 'text' && typeof result.text === 'string' && result.text.trim().length === 2);
                return { query: query._, ok, result: ok ? undefined : 'INVALID_RESULT' };
            }

            return {
                query: query._,
                ok: false,
                error: classifyTdError(entry.reason)
            };
        });

        return {
            ok: checks.length > 0 && checks.every(item => item.ok),
            checks
        };
    }

    async exerciseEnabledProxy(candidate, timeoutSeconds, options = {}) {
        throwIfCancelled(this.cancelState);
        await this.clearProxy();

        const tdProxy = toTdProxy(candidate);
        let proxyId = null;
        let failurePhase = 'enable_proxy';
        let forcedReconnect = false;
        let stateHistoryStart = this.connectionStateHistory.length;
        let readyReached = false;
        let reachedState = null;
        const probeRealTraffic = options.probeRealTraffic === true;

        try {
            const added = await this.safeInvoke(
                { _: 'addProxy', proxy: tdProxy, enable: true },
                4000
            );
            proxyId = added.id;
            this.activeProxyId = proxyId;

            try {
                const reconnect = await this.forceReconnect();
                forcedReconnect = reconnect.forcedReconnect;
                stateHistoryStart = reconnect.stateHistoryStart;
            } catch (error) {
                return {
                    ok: false,
                    error: classifyTdError(error),
                    failurePhase,
                    readyReached,
                    sawConnectingToProxy: false,
                    forcedReconnect,
                    reachedState,
                    states: this.connectionStateHistory.slice(stateHistoryStart).map(item => item.state)
                };
            }

            failurePhase = 'wait_ready';
            try {
                reachedState = await this.waitForConnectionState(
                    ['connectionStateReady'],
                    timeoutSeconds * 1000,
                    stateHistoryStart
                );
                readyReached = reachedState === 'connectionStateReady';
            } catch (_) {}

            const states = this.connectionStateHistory
                .slice(stateHistoryStart)
                .map(item => item.state);
            const sawConnectingToProxy = states.includes('connectionStateConnectingToProxy');

            if (!readyReached) {
                return {
                    ok: false,
                    error: 'READY_TIMEOUT',
                    failurePhase,
                    readyReached,
                    sawConnectingToProxy,
                    forcedReconnect,
                    reachedState,
                    states
                };
            }

            failurePhase = 'test_network';
            throwIfCancelled(this.cancelState);
            await this.safeInvoke({ _: 'testNetwork' }, timeoutSeconds * 1000);

            let realTraffic = { ok: false, checks: [] };
            if (probeRealTraffic) {
                failurePhase = 'api_probe';
                realTraffic = await this.probeRealTraffic(timeoutSeconds);
                if (!realTraffic.ok) {
                    return {
                        ok: false,
                        error: realTraffic.checks.map(item => `${item.query}:${item.ok ? 'ok' : item.error}`).join(', '),
                        failurePhase,
                        readyReached,
                        sawConnectingToProxy,
                        forcedReconnect,
                        reachedState,
                        states,
                        realTrafficOk: false,
                        apiProbePassed: false,
                        apiProbeChecks: realTraffic.checks,
                        apiChecks: realTraffic.checks
                    };
                }
            }

            return {
                ok: true,
                failurePhase: null,
                readyReached,
                sawConnectingToProxy,
                forcedReconnect,
                reachedState,
                states,
                realTrafficOk: realTraffic.ok,
                apiProbePassed: realTraffic.ok,
                apiProbeChecks: realTraffic.checks,
                apiChecks: realTraffic.checks
            };
        } catch (error) {
            return {
                ok: false,
                error: classifyTdError(error),
                failurePhase,
                readyReached,
                sawConnectingToProxy: this.connectionStateHistory
                    .slice(stateHistoryStart)
                    .some(item => item.state === 'connectionStateConnectingToProxy'),
                forcedReconnect,
                reachedState: readyReached ? reachedState : this.connectionState,
                states: this.connectionStateHistory.slice(stateHistoryStart).map(item => item.state),
                realTrafficOk: false,
                apiProbePassed: false,
                apiProbeChecks: [],
                apiChecks: []
            };
        } finally {
            try {
                await this.safeInvoke({ _: 'disableProxy' }, 2500);
            } catch (_) {}
            if (proxyId != null) {
                try {
                    await this.safeInvoke({ _: 'removeProxy', proxy_id: proxyId }, 2500);
                    if (this.activeProxyId === proxyId) {
                        this.activeProxyId = null;
                    }
                } catch (_) {
                    await this.clearProxy({ full: true });
                }
            }
        }
    }

    async runPingAttempts(candidate, timeoutSeconds, attempts) {
        const latencies = [];
        const errors = [];
        const attemptDetails = [];

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            throwIfCancelled(this.cancelState);
            const startedAt = Date.now();
            try {
                const result = await this.safeInvoke(
                    { _: 'pingProxy', proxy: toTdProxy(candidate) },
                    timeoutSeconds * 1000
                );

                const latencyMs = Math.max(1, Math.round(Number(result.seconds || 0) * 1000));
                latencies.push(latencyMs);
                attemptDetails.push({
                    attempt,
                    ok: true,
                    latencyMs,
                    wallMs: Date.now() - startedAt
                });
            } catch (error) {
                const classified = classifyTdError(error);
                errors.push(classified);
                attemptDetails.push({
                    attempt,
                    ok: false,
                    error: classified,
                    wallMs: Date.now() - startedAt
                });
            }

            if (attempt < attempts) {
                throwIfCancelled(this.cancelState);
                await sleep(DEFAULT_RECONNECT_DELAY_MS);
            }
        }

        return {
            latencies,
            errors,
            attemptDetails
        };
    }

    async runStrictConfirmation(candidate, timeoutSeconds, attempts, verbose) {
        const networkCheck = await this.exerciseEnabledProxy(candidate, timeoutSeconds, { probeRealTraffic: true });

        if (!networkCheck.ok) {
            return {
                ok: false,
                networkOk: false,
                realTrafficOk: false,
                apiProbePassed: false,
                apiProbeChecks: [],
                coldRetestPassed: false,
                readyReached: Boolean(networkCheck.readyReached),
                sawConnectingToProxy: Boolean(networkCheck.sawConnectingToProxy),
                forcedReconnect: Boolean(networkCheck.forcedReconnect),
                successAttempts: 0,
                failAttempts: attempts,
                pingLatencyMs: null,
                allLatencies: [],
                allErrors: [networkCheck.error],
                failurePhase: networkCheck.failurePhase || 'cold_retest',
                debug: verbose ? { networkCheck, attempts: [] } : undefined
            };
        }

        const { latencies, errors, attemptDetails } = await this.runPingAttempts(candidate, timeoutSeconds, attempts);
        const stability = computeConfidence(latencies, errors, attempts);
        const coldRetestPassed =
            networkCheck.ok &&
            networkCheck.readyReached &&
            networkCheck.forcedReconnect &&
            networkCheck.realTrafficOk &&
            stability.level === STATUS.WORKING;

        return {
            ok: true,
            networkOk: true,
            realTrafficOk: networkCheck.realTrafficOk,
            apiProbePassed: networkCheck.apiProbePassed !== false,
            apiProbeChecks: networkCheck.apiProbeChecks || networkCheck.apiChecks || [],
            coldRetestPassed,
            readyReached: networkCheck.readyReached,
            sawConnectingToProxy: networkCheck.sawConnectingToProxy,
            forcedReconnect: networkCheck.forcedReconnect,
            successAttempts: latencies.length,
            failAttempts: errors.length,
            pingLatencyMs: percentileMedian(latencies),
            allLatencies: latencies,
            allErrors: [
                ...errors,
                ...networkCheck.apiChecks.filter(item => !item.ok).map(item => `${item.query}:${item.error}`)
            ],
            failurePhase: coldRetestPassed ? null : 'ping_proxy',
            debug: verbose ? { networkCheck, attempts: attemptDetails } : undefined
        };
    }

    async prepareProxyCheck(candidate, timeoutSeconds, attempts, verbose) {
        if (!this.alive || !this.client) {
            throw new Error('Worker is not initialized');
        }

        const dcSweepStartedAt = Date.now();
        const dcSweep = await this.runDcSweep(candidate, timeoutSeconds);
        const warmCheckDecision = resolveWarmCheckSkip(dcSweep);
        const warmCheckStartedAt = Date.now();
        const warmCheck = warmCheckDecision.skip
            ? {
                ok: false,
                skipped: true,
                error: 'SKIPPED_AFTER_DC_SWEEP',
                failurePhase: 'dc_sweep',
                readyReached: false,
                sawConnectingToProxy: false,
                forcedReconnect: false,
                reachedState: null,
                states: []
            }
            : await this.exerciseEnabledProxy(candidate, timeoutSeconds);
        const warmCheckFinishedAt = Date.now();
        const candidateIsIp = isIpAddress(candidate && candidate.server);
        const requiredColdSessions = candidateIsIp
            ? REQUIRED_COLD_CONFIRMATIONS
            : REQUIRED_COLD_CONFIRMATIONS_HOSTNAME;
        const maxColdSessions = candidateIsIp
            ? MAX_COLD_CONFIRMATION_SESSIONS_IP
            : MAX_COLD_CONFIRMATION_SESSIONS_HOSTNAME;

        const shouldRunStrictRetest =
            dcSweep.some(item => item.ok) &&
            (warmCheck.ok || isWarmRescueEligible(dcSweep, warmCheck));

        return {
            candidate,
            attempts,
            verbose,
            dcSweep,
            warmCheck,
            shouldRunStrictRetest,
            finalTimeoutSeconds: getFinalTimeoutSeconds(timeoutSeconds),
            requiredColdSessions,
            maxColdSessions,
            warmCheckSkipped: warmCheckDecision.skip,
            skipReason: warmCheckDecision.skipReason,
            dcSuccessCount: warmCheckDecision.dcSuccessCount,
            phaseTimings: buildPhaseTimings({
                dcSweepMs: warmCheckStartedAt - dcSweepStartedAt,
                warmCheckMs: warmCheckDecision.skip ? 0 : warmCheckFinishedAt - warmCheckStartedAt
            }),
            workerId: this.id
        };
    }

    async probeProxy(candidate, timeoutSeconds, attempts, verbose, options = {}) {
        const prepared = await this.prepareProxyCheck(candidate, timeoutSeconds, attempts, verbose);
        let coldRetest = null;

        if (prepared.shouldRunStrictRetest) {
            coldRetest = await runScheduledColdRetests(candidate, {
                attempts,
                verbose,
                cancelState: this.cancelState,
                coldScheduler: options.coldScheduler || null,
                finalTimeoutSeconds: prepared.finalTimeoutSeconds,
                requiredColdSessions: prepared.requiredColdSessions,
                maxColdSessions: prepared.maxColdSessions
            });
        }

        const result = buildPreparedProbeResult(
            candidate,
            attempts,
            prepared.dcSweep,
            prepared.warmCheck,
            coldRetest,
            verbose,
            prepared.phaseTimings,
            prepared
        );

        if (result.debug) {
            result.debug.workerId = this.id;
        }

        return result;
    }

    async close() {
        const client = this.client;
        this.client = null;
        this.alive = false;

        if (client) {
            try {
                await Promise.race([
                    client.close(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(t('checker.closeTimeout'))), 3000))
                ]);
            } catch (_) {}
        }

        removeDirSafe(this.dbDir);
        this.dbDir = null;
    }
}

async function runQueue(items, concurrency, iterator, options = {}) {
    const results = new Array(items.length);
    const cancelState = options.cancelState || null;
    let cursor = 0;
    let completed = 0;
    const startedAt = Date.now();
    const progressHintRotator = options.progressHintRotator || createProgressHintRotator();
    const pinnedLivePanels = normalizePinnedLivePanels(options.pinnedLivePanels);
    const spinnerFrames = ['|', '/', '-', '\\'];
    let spinnerIndex = 0;
    let progressTimer = null;
    let previousLineCount = 0;
    let lastRenderAt = 0;
    const renderProgress = (options = {}) => {
        if (isCancellationActive(cancelState)) return;
        const force = options.force === true;
        const showCancelHint = options.showCancelHint !== false;
        const now = Date.now();
        if (!force && previousLineCount > 0 && (now - lastRenderAt) < LIVE_PROGRESS_MIN_REDRAW_INTERVAL_MS) {
            return;
        }
        lastRenderAt = now;
        const panel = buildProgressPanel({
            title: t('checker.preparingChecksTitle'),
            spinnerFrame: spinnerFrames[spinnerIndex % spinnerFrames.length],
            completed,
            total: items.length,
            elapsedMs: now - startedAt,
            tip: progressHintRotator.next(Date.now()),
            tone: 'info'
        });
        previousLineCount = renderLivePanel(panel, previousLineCount, {
            cancelState,
            showCancelHint,
            pinnedPanels: pinnedLivePanels
        });
    };

    try {
        if (items.length > 0) {
            renderProgress({ force: true });
            progressTimer = setInterval(() => {
                spinnerIndex += 1;
                renderProgress();
            }, 160);
        }

        const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
            while (true) {
                if (cancelState && cancelState.cancelled) break;
                const index = cursor;
                cursor += 1;
                if (index >= items.length) break;

                results[index] = await iterator(items[index], index);
                completed += 1;
                renderProgress();
            }
        });

        await Promise.all(runners);

        if (items.length > 0 && !isCancellationActive(cancelState)) {
            spinnerIndex += 1;
            renderProgress({ force: true, showCancelHint: false });
        }

        throwIfCancelled(cancelState);
        return results;
    } finally {
        if (progressTimer) {
            clearInterval(progressTimer);
        }
        if (isCancellationActive(cancelState)) {
            previousLineCount = clearLivePanel(previousLineCount);
        } else if (previousLineCount > 0) {
            terminalSession.showCursor();
        }
    }
}

function buildProbeFailureResult(proxy, index, attempts, error) {
    const { inputIndex, ...proxyData } = proxy || {};
    const resultIndex = Number.isInteger(inputIndex) ? inputIndex : index;
    return {
        index: resultIndex,
        ...proxyData,
        isAlive: false,
        status: STATUS.FAIL,
        confidence: 0,
        successAttempts: 0,
        failAttempts: attempts,
        pingLatencyMs: null,
        allLatencies: [],
        allErrors: [classifyTdError(error)],
        readyReached: false,
        sawConnectingToProxy: false,
        forcedReconnect: false,
        realTrafficOk: false,
        apiProbePassed: false,
        apiProbeChecks: [],
        coldRetestPassed: false,
        dnsStabilityPassed: false,
        dnsStrongEligible: false,
        dnsSamples: [],
        requiredColdSessions: getRequiredColdConfirmations(proxy),
        passedColdSessions: 0,
        failurePhase: 'cold_retest'
    };
}

function getPreparedProxyGroupKey(candidate) {
    if (!candidate || !candidate.server) {
        return 'unknown';
    }

    if (isIpAddress(candidate.server)) {
        const parts = String(candidate.server).split('.');
        return `ip:${parts.slice(0, 3).join('.')}:${candidate.proxyType || 'unknown'}`;
    }

    const labels = String(candidate.server).toLowerCase().split('.').filter(Boolean);
    const suffix = labels.length >= 2
        ? labels.slice(-2).join('.')
        : labels[0];
    return `host:${suffix}:${candidate.proxyType || 'unknown'}`;
}

function hasTerminalMarker(errors = []) {
    return (errors || []).some(error => TERMINAL_DC_ERRORS.has(String(error || '').replace(/^DC\d+:/, '').replace(/^COLD:/, '')));
}

function isTerminalPreparedFailure(prepared) {
    if (!prepared) return false;
    const outcome = summarizeDcSweepOutcome(prepared.dcSweep || []);
    return outcome.allDnsFailures || outcome.allTerminalFailures;
}

function isTerminalResult(result) {
    if (!result || result.status !== STATUS.FAIL) return false;
    if (result.failurePhase === 'dc_sweep' && hasTerminalMarker(result.allErrors)) {
        return true;
    }
    return hasTerminalMarker(result.allErrors);
}

function computePreparedProbePriority(prepared) {
    if (!prepared) return Number.NEGATIVE_INFINITY;

    const dcSweep = Array.isArray(prepared.dcSweep) ? prepared.dcSweep : [];
    const dcSuccessCount = dcSweep.filter(item => item && item.ok).length;
    const warmCheck = prepared.warmCheck || {};
    const terminalPenalty = isTerminalPreparedFailure(prepared) ? 100 : 0;
    const dnsPenalty = dcSweep.some(item => item && item.error === 'DNS_ERROR') ? 50 : 0;
    const latency = Number.isFinite(warmCheck.pingLatencyMs) ? warmCheck.pingLatencyMs : Number.POSITIVE_INFINITY;
    const latencyBonus = Number.isFinite(latency) ? Math.max(0, 600 - latency) / 1000 : 0;

    return (
        (dcSuccessCount * 10) +
        (warmCheck.ok ? 16 : 0) +
        (warmCheck.readyReached ? 10 : 0) +
        (warmCheck.sawConnectingToProxy ? 6 : 0) +
        (warmCheck.forcedReconnect ? 5 : 0) +
        (warmCheck.realTrafficOk ? 8 : 0) +
        (warmCheck.apiProbePassed ? 8 : 0) +
        latencyBonus -
        terminalPenalty -
        dnsPenalty
    );
}

class AdaptiveScanCoordinator {
    constructor(items = []) {
        this.groups = new Map();
        this.round = 0;

        for (const item of items) {
            const key = getPreparedProxyGroupKey(item);
            if (!this.groups.has(key)) {
                this.groups.set(key, {
                    key,
                    items: [],
                    score: 0,
                    served: 0,
                    lastServedRound: -1
                });
            }
            const group = this.groups.get(key);
            group.items.push(item);
        }
    }

    next() {
        let chosen = null;

        for (const group of this.groups.values()) {
            if (!group.items.length) continue;

            if (!chosen) {
                chosen = group;
                continue;
            }

            if (group.score > chosen.score) {
                chosen = group;
                continue;
            }

            if (group.score === chosen.score) {
                if (group.lastServedRound < chosen.lastServedRound) {
                    chosen = group;
                    continue;
                }
                if (group.lastServedRound === chosen.lastServedRound && group.served < chosen.served) {
                    chosen = group;
                }
            }
        }

        if (!chosen) return null;

        this.round += 1;
        chosen.lastServedRound = this.round;
        chosen.served += 1;
        return chosen.items.shift();
    }

    recordResult(candidate, result) {
        const key = getPreparedProxyGroupKey(candidate);
        const group = this.groups.get(key);
        if (!group || !result) return;

        if (result.status === STATUS.WORKING) {
            group.score += 3;
            return;
        }

        if (result.status === STATUS.MAY_WORK) {
            group.score += 1;
            return;
        }

        if (isTerminalResult(result)) {
            group.score -= 4;
            return;
        }

        if (result.status === STATUS.FAIL) {
            group.score -= 1;
        }
    }

    summarizeGroups() {
        return Array.from(this.groups.values()).map(group => ({
            key: group.key,
            remaining: group.items.length,
            score: group.score,
            served: group.served
        }));
    }
}

class PreparedProbeQueue {
    constructor(options = {}) {
        this.maxSize = Math.max(1, Number(options.maxSize || 1));
        this.items = [];
        this.closed = false;
        this.waitingConsumers = [];
        this.waitingProducers = [];
    }

    _flushConsumers() {
        while (this.waitingConsumers.length > 0 && this.items.length > 0) {
            const resolve = this.waitingConsumers.shift();
            const item = this.items.shift();
            resolve(item);
        }
    }

    _releaseProducer() {
        if (this.waitingProducers.length > 0 && this.items.length < this.maxSize) {
            const resolve = this.waitingProducers.shift();
            resolve();
        }
    }

    async enqueue(item) {
        while (!this.closed && this.items.length >= this.maxSize) {
            await new Promise(resolve => {
                this.waitingProducers.push(resolve);
            });
        }

        if (this.closed) {
            throw new Error('Prepared probe queue is closed');
        }

        this.items.push(item);
        this.items.sort((left, right) => {
            if ((right.priority || 0) !== (left.priority || 0)) {
                return (right.priority || 0) - (left.priority || 0);
            }
            return (left.sequence || 0) - (right.sequence || 0);
        });
        this._flushConsumers();
    }

    async dequeue() {
        if (this.items.length > 0) {
            const item = this.items.shift();
            this._releaseProducer();
            return item;
        }

        if (this.closed) {
            return null;
        }

        return new Promise(resolve => {
            this.waitingConsumers.push(item => {
                this._releaseProducer();
                resolve(item);
            });
        });
    }

    close() {
        this.closed = true;
        while (this.waitingConsumers.length > 0) {
            const resolve = this.waitingConsumers.shift();
            resolve(null);
        }
        while (this.waitingProducers.length > 0) {
            const resolve = this.waitingProducers.shift();
            resolve();
        }
    }
}

function createRunPhaseStats() {
    return {
        preparedCount: 0,
        warmCheckCount: 0,
        coldQueuedCount: 0,
        terminalDcSweepCount: 0,
        failurePhases: new Map(),
        timings: {
            dcSweepMs: [],
            warmCheckMs: [],
            coldQueueWaitMs: [],
            coldExecutionMs: []
        }
    };
}

function pushPhaseTiming(values, value) {
    if (Number.isFinite(value) && value >= 0) {
        values.push(value);
    }
}

function computePercentile(values, percentile) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
    return sorted[index];
}

function summarizeRunPhaseStats(phaseStats, coordinator) {
    const failurePhases = Array.from(phaseStats.failurePhases.entries())
        .sort((left, right) => right[1] - left[1])
        .map(([phase, count]) => ({ phase, count }));

    return {
        preparedCount: phaseStats.preparedCount,
        warmCheckCount: phaseStats.warmCheckCount,
        coldQueuedCount: phaseStats.coldQueuedCount,
        terminalDcSweepCount: phaseStats.terminalDcSweepCount,
        failurePhases,
        timings: {
            dcSweep: {
                median: percentileMedian(phaseStats.timings.dcSweepMs),
                p95: computePercentile(phaseStats.timings.dcSweepMs, 95)
            },
            warmCheck: {
                median: percentileMedian(phaseStats.timings.warmCheckMs),
                p95: computePercentile(phaseStats.timings.warmCheckMs, 95)
            },
            coldQueueWait: {
                median: percentileMedian(phaseStats.timings.coldQueueWaitMs),
                p95: computePercentile(phaseStats.timings.coldQueueWaitMs, 95)
            },
            coldExecution: {
                median: percentileMedian(phaseStats.timings.coldExecutionMs),
                p95: computePercentile(phaseStats.timings.coldExecutionMs, 95)
            }
        },
        groups: coordinator ? coordinator.summarizeGroups() : []
    };
}

function printPhaseStats(summary) {
    const lines = [
        `Prepared candidates: ${summary.preparedCount}`,
        `Reached warm check: ${summary.warmCheckCount}`,
        `Queued for cold retest: ${summary.coldQueuedCount}`,
        `Terminal dc sweep exits: ${summary.terminalDcSweepCount}`
    ];

    const timingLines = [
        ['DC sweep', summary.timings.dcSweep],
        ['Warm check', summary.timings.warmCheck],
        ['Cold queue wait', summary.timings.coldQueueWait],
        ['Cold execution', summary.timings.coldExecution]
    ].map(([label, stats]) =>
        `${label}: median=${stats.median ?? 'n/a'}ms p95=${stats.p95 ?? 'n/a'}ms`
    );

    const failureLines = summary.failurePhases.length > 0
        ? summary.failurePhases.map(item => `${item.phase}: ${item.count}`)
        : ['none'];

    console.log('');
    console.log(buildPreflightPanel({
        title: 'Phase Stats',
        subtitle: 'Current-run scheduler and phase summary',
        tone: 'info',
        lines: [
            ...lines,
            ui.BOX_BREAK,
            ...timingLines,
            ui.BOX_BREAK,
            'Failure phases:',
            ...failureLines
        ]
    }));
}

function buildBootstrapCandidateOrder(candidates, bucketCount) {
    const list = Array.isArray(candidates) ? candidates.slice() : [];
    if (list.length <= 1) return list;

    const buckets = Math.max(1, Math.min(Number(bucketCount || 1), list.length));
    const sliceSize = Math.ceil(list.length / buckets);
    const slices = Array.from({ length: buckets }, (_, index) =>
        list.slice(index * sliceSize, (index + 1) * sliceSize)
    ).filter(slice => slice.length > 0);

    const ordered = [];
    let offset = 0;
    while (ordered.length < list.length) {
        let added = false;
        for (const slice of slices) {
            if (offset < slice.length) {
                ordered.push(slice[offset]);
                added = true;
            }
        }
        if (!added) break;
        offset += 1;
    }

    return ordered;
}

async function runProxyCheckPool(items, workers, args, options = {}) {
    if (!Array.isArray(workers) || workers.length === 0) {
        throw new Error('runProxyCheckPool requires at least one worker');
    }

    const results = new Array(items.length);
    const cancelState = options.cancelState || null;
    const showProgress = options.showProgress !== false;
    const coordinator = options.scanCoordinator || new AdaptiveScanCoordinator(
        buildBootstrapCandidateOrder(items, workers.length || 1)
    );
    const coldScheduler = new ColdRetestScheduler({
        concurrency: resolveColdSchedulerConcurrency(workers.length),
        cancelState
    });
    const runColdRetestsFn = typeof options.runColdRetestsFn === 'function'
        ? options.runColdRetestsFn
        : runScheduledColdRetests;
    const preparedQueue = new PreparedProbeQueue({
        maxSize: Math.max(1, Number(
            options.maxPreparedQueueSize ||
            Math.max(workers.length, workers.length * DEFAULT_PREPARED_QUEUE_FACTOR)
        ))
    });
    const closePreparedQueueOnCancel = addCancelListener(cancelState, () => {
        preparedQueue.close();
    });
    const phaseStats = createRunPhaseStats();
    let preparationSequence = 0;
    let completed = 0;
    let working = 0;
    let mayWork = 0;
    let failed = 0;
    const startedAt = Date.now();
    const progressHintRotator = options.progressHintRotator || createProgressHintRotator();
    const pinnedLivePanels = normalizePinnedLivePanels(options.pinnedLivePanels);
    const spinnerFrames = ['|', '/', '-', '\\'];
    let spinnerIndex = 0;
    let progressTimer = null;
    let previousLineCount = 0;
    let lastRenderAt = 0;
    let activePreparers = workers.length;

    const renderProgress = (options = {}) => {
        if (!showProgress) return;
        if (isCancellationActive(cancelState)) return;
        const force = options.force === true;
        const showCancelHint = options.showCancelHint !== false;
        const now = Date.now();
        if (!force && previousLineCount > 0 && (now - lastRenderAt) < LIVE_PROGRESS_MIN_REDRAW_INTERVAL_MS) {
            return;
        }
        lastRenderAt = now;
        const panel = buildProgressPanel({
            title: t('checker.checkingUniqueProxiesTitle'),
            spinnerFrame: spinnerFrames[spinnerIndex % spinnerFrames.length],
            completed,
            total: items.length,
            elapsedMs: now - startedAt,
            working,
            mayWork,
            failed,
            tip: progressHintRotator.next(Date.now()),
            tone: 'warning'
        });
        previousLineCount = renderLivePanel(panel, previousLineCount, {
            cancelState,
            showCancelHint,
            pinnedPanels: pinnedLivePanels
        });
    };

    const finishResult = (proxy, index, result, prepared = null) => {
        results[index] = result;
        completed += 1;
        if (result && result.status === STATUS.WORKING) {
            working += 1;
        } else if (result && result.status === STATUS.MAY_WORK) {
            mayWork += 1;
        } else {
            failed += 1;
        }
        if (result && result.failurePhase) {
            phaseStats.failurePhases.set(
                result.failurePhase,
                (phaseStats.failurePhases.get(result.failurePhase) || 0) + 1
            );
        }
        if (prepared && prepared.phaseTimings) {
            pushPhaseTiming(phaseStats.timings.dcSweepMs, prepared.phaseTimings.dcSweepMs);
            pushPhaseTiming(phaseStats.timings.warmCheckMs, prepared.phaseTimings.warmCheckMs);
        }
        if (result && result.debug && result.debug.timings) {
            pushPhaseTiming(phaseStats.timings.coldQueueWaitMs, result.debug.timings.coldQueueWaitMs);
            pushPhaseTiming(phaseStats.timings.coldExecutionMs, result.debug.timings.coldExecutionMs);
        }
        coordinator.recordResult(proxy, result);
        renderProgress();
    };

    if (showProgress && items.length > 0) {
        renderProgress({ force: true });
        progressTimer = setInterval(() => {
            spinnerIndex += 1;
            renderProgress();
        }, MAIN_SCAN_PROGRESS_REDRAW_INTERVAL_MS);
    }

    try {
        const runners = workers.map(worker => (async () => {
            while (true) {
                if (cancelState && cancelState.cancelled) break;
                const proxy = coordinator.next();
                if (!proxy) break;

                const resultIndex = Number.isInteger(proxy && proxy.inputIndex) ? proxy.inputIndex : completed;
                let prepared;

                try {
                    prepared = await worker.prepareProxyCheck(proxy, args.timeout, args.attempts, args.verbose);
                    phaseStats.preparedCount += 1;
                    if (!prepared.warmCheckSkipped) {
                        phaseStats.warmCheckCount += 1;
                    }
                    if (isTerminalPreparedFailure(prepared)) {
                        phaseStats.terminalDcSweepCount += 1;
                    }
                } catch (error) {
                    finishResult(proxy, resultIndex, buildProbeFailureResult(proxy, resultIndex, args.attempts, error));
                    continue;
                }

                if (!prepared.shouldRunStrictRetest) {
                    const result = buildPreparedProbeResult(
                        proxy,
                        args.attempts,
                        prepared.dcSweep,
                        prepared.warmCheck,
                        null,
                        args.verbose,
                        prepared.phaseTimings,
                        prepared
                    );

                    if (result.debug) {
                        result.debug.workerId = prepared.workerId;
                    }
                    const { inputIndex, ...proxyData } = proxy || {};
                    finishResult(proxy, resultIndex, {
                        index: resultIndex,
                        ...proxyData,
                        ...result
                    }, prepared);
                    continue;
                }

                phaseStats.coldQueuedCount += 1;
                preparationSequence += 1;
                try {
                    await preparedQueue.enqueue({
                        proxy,
                        resultIndex,
                        prepared,
                        priority: computePreparedProbePriority(prepared),
                        sequence: preparationSequence
                    });
                } catch (error) {
                    if (isCancellationActive(cancelState)) {
                        break;
                    }
                    throw error;
                }
            }
        })().finally(() => {
            activePreparers -= 1;
            if (activePreparers === 0) {
                preparedQueue.close();
            }
        }));

        const finalizers = Array.from({
            length: Math.max(1, Math.min(workers.length, resolveColdSchedulerConcurrency(workers.length)))
        }, () => (async () => {
            while (true) {
                if (cancelState && cancelState.cancelled) break;
                const entry = await preparedQueue.dequeue();
                if (!entry) break;

                const { proxy, resultIndex, prepared } = entry;
                try {
                    const coldRetest = await runColdRetestsFn(proxy, {
                        attempts: args.attempts,
                        verbose: args.verbose,
                        cancelState,
                        coldScheduler,
                        finalTimeoutSeconds: prepared.finalTimeoutSeconds,
                        requiredColdSessions: prepared.requiredColdSessions,
                        maxColdSessions: prepared.maxColdSessions
                    });

                    const result = buildPreparedProbeResult(
                        proxy,
                        args.attempts,
                        prepared.dcSweep,
                        prepared.warmCheck,
                        coldRetest,
                        args.verbose,
                        prepared.phaseTimings,
                        prepared
                    );

                    if (result.debug) {
                        result.debug.workerId = prepared.workerId;
                    }
                    const { inputIndex, ...proxyData } = proxy || {};
                    finishResult(proxy, resultIndex, {
                        index: resultIndex,
                        ...proxyData,
                        ...result
                    }, prepared);
                } catch (error) {
                    finishResult(proxy, resultIndex, buildProbeFailureResult(proxy, resultIndex, args.attempts, error), prepared);
                }
            }
        })());

        await Promise.all([...runners, ...finalizers]);
    } finally {
        if (progressTimer) {
            clearInterval(progressTimer);
        }
        closePreparedQueueOnCancel();
        preparedQueue.close();
        await coldScheduler.close();
        if (isCancellationActive(cancelState)) {
            previousLineCount = clearLivePanel(previousLineCount);
        } else if (previousLineCount > 0) {
            terminalSession.showCursor();
        }
    }

    if (showProgress && items.length > 0 && !isCancellationActive(cancelState)) {
        spinnerIndex += 1;
        renderProgress({ force: true, showCancelHint: false });
    }

    throwIfCancelled(cancelState);
    results.meta = {
        phaseStats: summarizeRunPhaseStats(phaseStats, coordinator)
    };
    return results;
}

async function initializeWorkers(count, initTimeout, options = {}) {
    const verbose = options.verbose === true;
    const cancelState = options.cancelState || null;
    const workers = [];
    const initErrors = [];

    for (let startIndex = 0; startIndex < count;) {
        if (cancelState && cancelState.cancelled) break;

        const waveIndexes = Array.from({
            length: Math.min(WORKER_INIT_CONCURRENCY, count - startIndex)
        }, (_, offset) => startIndex + offset);
        const isFirstWave = startIndex === 0;
        startIndex += waveIndexes.length;

        const waveResults = await Promise.all(waveIndexes.map(async index => {
            if (cancelState && cancelState.cancelled) {
                return { index, worker: null, error: null };
            }

            const worker = new Worker(index + 1).setCancelState(cancelState);
            try {
                await worker.init(initTimeout);
                return { index, worker, error: null };
            } catch (error) {
                const explained = explainEnvironmentError(error);
                if (verbose) {
                    console.log(`Worker #${worker.id} init failed: ${explained}`);
                }
                await worker.close();
                return { index, worker: null, error: explained };
            }
        }));

        waveResults
            .sort((left, right) => left.index - right.index)
            .forEach(result => {
                if (result.worker) {
                    workers.push(result.worker);
                } else if (result.error) {
                    initErrors.push(result.error);
                }
            });

        if (isFirstWave && !waveResults.some(result => result.worker)) {
            break;
        }
    }

    workers.initErrors = initErrors;
    return workers;
}

async function main(argv = process.argv) {
    const storedLanguage = loadStoredUiLanguage();
    if (storedLanguage) {
        setActiveUiLanguage(storedLanguage);
    } else {
        ensureUiLanguageSelected();
    }

    const args = parseArgs(argv);
    const inputValidation = validateInputFileOrThrow(args.file);
    args.file = inputValidation.resolvedPath;
    const overallStartedAt = Date.now();
    const friendlyMode = !args.verbose;
    const cancelState = createCancelState();
    let workers = [];
    const releaseSigint = bindCancelToSigint(cancelState, {
        onCancel: () => {
        for (const worker of workers) {
            void worker.close();
        }
        }
    });

    if (args.debug) {
        console.log(`${colors.cyan}${t('checker.debugMode')}${colors.reset}\n`);
    }

    if (!friendlyMode) {
        if (args.concurrencyWasClamped) {
            console.log(
                `${colors.yellow}${t('checker.concurrencyLimited', {
                    concurrency: args.concurrency,
                    max: MAX_RECOMMENDED_CONCURRENCY
                })}${colors.reset}`
            );
        }
        console.log(t('checker.initializingWorkers', { count: args.concurrency }));
    }
    const workerInitStartedAt = Date.now();
    workers = await initializeWorkers(args.concurrency, args.bootstrapTimeout, {
        verbose: args.verbose,
        cancelState
    });
    const workerInitDurationMs = Date.now() - workerInitStartedAt;
    throwIfCancelled(cancelState);

    if (workers.length === 0) {
        throw createUserFacingFailure(
            STATUS.CHECKER_INVALID,
            buildWorkerInitializationFailureMessage(workers.initErrors || [])
        );
    }

    if (args.verbose) {
        console.log(t('checker.initializedWorkers', {
            initialized: workers.length,
            requested: args.concurrency,
            seconds: (workerInitDurationMs / 1000).toFixed(1)
        }));
    }

    try {
        const entries = loadInputEntries(args.file);
        throwIfCancelled(cancelState);
        const deduped = dedupeSupported(entries);
        const summary = summarizeInput(entries, deduped);
        const limited = args.batchSize > 0 ? deduped.unique.slice(0, args.batchSize) : deduped.unique;

        if (args.verbose) {
            console.log(`${colors.bold}${t('checker.loadingProxiesFrom', { value: args.file })}${colors.reset}`);
            console.log(`${colors.bold}${t('checker.inputSummary')}${colors.reset}`);
            console.log(`   ${t('checker.supportedMtprotoLinks', { count: summary.supported })}`);
            console.log(`   ${t('checker.unsupportedBotLinks', { count: summary.botLinks })}`);
            console.log(`   ${t('checker.invalidLines', { count: summary.invalid })}`);
            console.log(`   ${t('common.duplicatesRemoved', { count: summary.duplicatesRemoved })}`);
            console.log(`   ${t('common.uniqueProxiesToCheck', { count: summary.uniqueSupported })}`);
            if (args.batchSize > 0) {
                console.log(`   ${t('checker.batchSizeLimit', { requested: args.batchSize, running: limited.length })}`);
            }
        }

        if (limited.length === 0) {
            throw new Error(t('checker.noSupportedProxies'));
        }

        const orderedLimited = limited.map((proxy, index) => ({
            ...proxy,
            inputIndex: index
        }));

        const results = await runProxyCheckPool(
            orderedLimited,
            workers.slice(0, Math.min(args.concurrency, workers.length)),
            args,
            { cancelState }
        );

        if (args.debugPhaseStats && results.meta && results.meta.phaseStats) {
            printPhaseStats(results.meta.phaseStats);
        }

        if (args.verbose) {
            console.log('\n' + '='.repeat(96));
            console.log(t('checker.detailedResults'));
            console.log('='.repeat(96));
            for (const result of results) {
                const shownStatus =
                    getShownStatusLabel(result.status);
                console.log(`\n#${result.index + 1} ${result.server}:${result.port} (${result.proxyType})`);
                console.log(`   ${t('checker.resultStatusLine', { shownStatus, confidence: (result.confidence * 100).toFixed(0) })}`);
                console.log(`   ${t('checker.resultAttemptsLine', { successAttempts: result.successAttempts, failAttempts: result.failAttempts, attempts: args.attempts })}`);
                console.log(`   ${t('checker.medianPing', { value: `${result.pingLatencyMs ?? 'n/a'}ms` })}`);
                console.log(`   ${t('checker.readyReached', { value: result.readyReached ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.sawProxyHop', { value: result.sawConnectingToProxy ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.forcedReconnect', { value: result.forcedReconnect ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.realApiTraffic', { value: result.realTrafficOk ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.apiProbePassed', { value: result.apiProbePassed ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.coldRetestPassed', { value: result.coldRetestPassed ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.dnsStabilityPassed', { value: result.dnsStabilityPassed ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.dnsStrongGate', { value: result.dnsStrongEligible ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.currentRouteReadyRatio', { value: result.currentRouteReadyRatio })}`);
                console.log(`   ${t('checker.currentRouteApiRatio', { value: result.currentRouteApiRatio })}`);
                console.log(`   ${t('checker.volatilityCapped', { value: result.volatilityCapped ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.capReason', { value: result.capReason || 'none' })}`);
                console.log(`   ${t('checker.rawMaxLatency', { value: result.rawMaxLatency ?? 'n/a' })}`);
                console.log(`   ${t('checker.trimmedMaxLatency', { value: result.trimmedMaxLatency ?? 'n/a' })}`);
                console.log(`   ${t('checker.hasValidLatencySample', { value: result.hasValidLatencySample ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.latencySampleCount', { value: result.latencySampleCount || 0 })}`);
                console.log(`   ${t('checker.medianLatencyDiagnostic', { value: result.medianLatency ?? 'n/a' })}`);
                console.log(`   ${t('checker.timeoutOnlyErrors', { value: result.timeoutOnlyErrors ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.candidatePatternClass', { value: result.candidatePatternClass || 'mixed_failures' })}`);
                console.log(`   ${t('checker.readyTimeoutSessions', { value: result.readyTimeoutSessions || 0 })}`);
                console.log(`   ${t('checker.pingTimeoutOnlySessions', { value: result.pingTimeoutOnlySessions || 0 })}`);
                console.log(`   ${t('checker.dcSweepFailedSessions', { value: result.dcSweepFailedSessions || 0 })}`);
                console.log(`   ${t('checker.apiConfirmedButUnpassedSessions', { value: result.apiConfirmedButUnpassedSessions || 0 })}`);
                console.log(`   ${t('checker.warmReadyTimeout', { value: result.warmReadyTimeout ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.routeFlapRecoverable', { value: result.routeFlapRecoverable ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.ddPartialColdRouteRecoverable', { value: result.ddPartialColdRouteRecoverable ? t('common.yes') : t('common.no') })}`);
                console.log(`   ${t('checker.ddPartialColdRouteBlockReason', { value: result.ddPartialColdRouteBlockReason || 'none' })}`);
                console.log(`   ${t('checker.promoteReason', { value: result.promoteReason || 'none' })}`);
                console.log(`   ${t('checker.coldSessions', { passed: result.passedColdSessions, required: result.requiredColdSessions })}`);
                console.log(`   ${t('checker.failurePhase', { value: result.failurePhase ?? 'none' })}`);
                if (result.allLatencies.length > 0) console.log(`   ${t('checker.latencies', { value: `${result.allLatencies.join('ms, ')}ms` })}`);
                if (result.allErrors.length > 0) console.log(`   ${t('checker.errors', { value: result.allErrors.join('; ') })}`);
                if (result.debug && result.debug.dcSweep) {
                    console.log(`   ${t('checker.dcSweep', { value: result.debug.dcSweep.map(item => `${item.dcId}:${item.ok ? 'ok' : item.error}`).join(', ') })}`);
                }
                if (result.debug && result.debug.warmCheck) {
                    if (result.debug.warmCheck.skipped) {
                        console.log(`   ${t('checker.warmCheckSkipped', {
                            value: result.debug.preparation && result.debug.preparation.skipReason
                                ? result.debug.preparation.skipReason
                                : 'dc_sweep_hard_fail'
                        })}`);
                    } else {
                    console.log(`   ${t('checker.warmCheck', {
                            result: result.debug.warmCheck.ok ? t('common.ok') : result.debug.warmCheck.error,
                            ready: result.debug.warmCheck.readyReached ? t('common.yes') : t('common.no'),
                            proxyHop: result.debug.warmCheck.sawConnectingToProxy ? t('common.yes') : t('common.no')
                        })}`);
                    }
                }
                if (result.debug && result.debug.timings) {
                        console.log(`   ${t('checker.phaseTiming', {
                            dcSweep: result.debug.timings.dcSweepMs || 0,
                            warmCheck: result.debug.timings.warmCheckMs || 0,
                            coldQueueWait: result.debug.timings.coldQueueWaitMs || 0,
                            coldExecution: result.debug.timings.coldExecutionMs || 0
                        })}`);
                }
                if (result.debug && result.debug.coldRetest) {
                    const cold = result.debug.coldRetest;
                    console.log(`   ${t('checker.coldRetestSummary', {
                        passed: cold.passedColdSessions || 0,
                        required: cold.requiredColdSessions || REQUIRED_COLD_CONFIRMATIONS,
                        ready: cold.readyReached ? t('common.yes') : t('common.no'),
                        proxyHop: cold.sawConnectingToProxy ? t('common.yes') : t('common.no'),
                        forcedReconnect: cold.forcedReconnect ? t('common.yes') : t('common.no'),
                        api: cold.apiProbePassed ? t('common.yes') : t('common.no'),
                        dns: cold.dnsStabilityPassed ? t('common.yes') : t('common.no'),
                        dnsStrong: cold.dnsStrongEligible ? t('common.yes') : t('common.no'),
                        result: cold.coldRetestPassed ? t('common.yes') : t('common.no')
                    })}`);
                    if (cold.dnsSamples && cold.dnsSamples.length > 0) {
                        console.log(`   ${t('checker.dnsSamples', {
                            value: cold.dnsSamples.map(sample => (
                                sample.ok ? `[${(sample.addresses || []).join(',')}]` : `ERR:${sample.error}`
                            )).join(' | ')
                        })}`);
                    }
                    if (cold.debug && cold.debug.timings) {
                        console.log(`   ${t('checker.coldTiming', {
                            queueWait: cold.debug.timings.queueWaitMs || 0,
                            execution: cold.debug.timings.executionMs || 0
                        })}`);
                    }
                    if (cold.debug && cold.debug.sessions) {
                        for (const session of cold.debug.sessions) {
                            console.log(`   ${t('checker.coldSession', {
                                session: session.session,
                                result: session.ok ? t('checker.networkOkLabel') : session.failurePhase || t('common.fail'),
                                ready: session.readyReached ? t('common.yes') : t('common.no'),
                                proxyHop: session.sawConnectingToProxy ? t('common.yes') : t('common.no'),
                                forcedReconnect: session.forcedReconnect ? t('common.yes') : t('common.no'),
                                api: session.apiProbePassed ? t('common.yes') : t('common.no'),
                                passed: session.coldRetestPassed ? t('common.yes') : t('common.no')
                            })}`);
                            if (session.queueWaitMs != null || session.executionMs != null) {
                                console.log(`   ${t('checker.sessionTiming', {
                                    session: session.session,
                                    queueWait: session.queueWaitMs || 0,
                                    execution: session.executionMs || 0
                                })}`);
                            }
                            if (session.apiProbeChecks && session.apiProbeChecks.length > 0) {
                                console.log(`   ${t('checker.sessionApiChecks', {
                                    session: session.session,
                                    value: session.apiProbeChecks
                                        .map(check => `${check.query}:${check.ok ? t('common.ok') : (check.error || check.result || t('common.fail'))}`)
                                        .join(', ')
                                })}`);
                            }
                            if (session.debug && session.debug.attempts) {
                                for (const attempt of session.debug.attempts) {
                                    if (attempt.ok) {
                                        console.log(`   ${t('checker.sessionAttemptOk', {
                                            session: session.session,
                                            attempt: attempt.attempt,
                                            latency: attempt.latencyMs,
                                            wall: attempt.wallMs
                                        })}`);
                                    } else {
                                        console.log(`   ${t('checker.sessionAttemptFail', {
                                            session: session.session,
                                            attempt: attempt.attempt,
                                            error: attempt.error,
                                            wall: attempt.wallMs
                                        })}`);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            console.log('\n' + '='.repeat(96));
        }

        const trustedOk = results
            .filter(result => result.status === STATUS.WORKING)
            .sort((left, right) => left.pingLatencyMs - right.pingLatencyMs);
        const mayWork = results
            .filter(result => result.status === STATUS.MAY_WORK)
            .sort(compareMayWorkCandidates);
        const failed = results.filter(result => result.status !== STATUS.WORKING && result.status !== STATUS.MAY_WORK);

        console.log('\n' + '='.repeat(80));
        console.log(`${colors.bold}${t('checker.resultsTitle')}${colors.reset}`);
        console.log(`   ${t('checker.totalChecked', { count: results.length })}`);
        console.log(`   WORKING: ${trustedOk.length}`);
        console.log(`   ${t('checker.mayWorkStatus', { count: mayWork.length })}`);
        console.log(`   FAIL: ${failed.length}`);

        if (trustedOk.length > 0) {
            console.log(`\n${colors.green}${t('checker.bestWorking')}${colors.reset}`);
            for (const proxy of trustedOk.slice(0, 20)) {
                console.log(
                    `   ${proxy.server}:${proxy.port} | ${proxy.pingLatencyMs}ms | ${proxy.proxyType} | ${proxy.status}`
                );
            }
            if (trustedOk.length > 20) {
                console.log(`   ${t('checker.andMore', { count: trustedOk.length - 20 })}`);
            }
        }

        if (failed.length > 0) {
            console.log(`\n${colors.red}${t('checker.failedProxies')}${colors.reset}`);
            console.log(`   FAIL: ${failed.length}`);
        }

        if (mayWork.length > 0) {
            console.log(`\n${colors.yellow}${t('checker.mayWorkHeading')}${colors.reset}`);
            for (const proxy of mayWork.slice(0, 20)) {
                console.log(
                    `   ${proxy.server}:${proxy.port} | ${proxy.pingLatencyMs}ms | ${proxy.proxyType} | ${t('checker.mayWorkLabel')}`
                );
            }
            if (mayWork.length > 20) {
                console.log(`   ${t('checker.andMore', { count: mayWork.length - 20 })}`);
            }
        }

        const falseNegativeAudit = buildFalseNegativeAudit(results, 10);
        if (args.verbose) {
            console.log(`\n${colors.cyan}${t('checker.falseNegativeAuditHeading')}${colors.reset}`);
            console.log(`   ${t('checker.currentWorking', { count: falseNegativeAudit.currentWorking.length })}`);
            for (const [index, proxy] of falseNegativeAudit.currentWorking.entries()) {
                console.log(`   ${index + 1}. ${proxy.server}:${proxy.port} | ${proxy.pingLatencyMs}ms`);
            }
            console.log(`   ${t('checker.currentMayWork', { count: falseNegativeAudit.currentMayWork.length })}`);
            for (const [index, proxy] of falseNegativeAudit.currentMayWork.entries()) {
                console.log(`   M${index + 1}. ${proxy.server}:${proxy.port} | ${proxy.pingLatencyMs}ms`);
            }
            console.log(`   ${t('checker.topNearMissFail', { count: falseNegativeAudit.shortlist.length })}`);
            for (const [index, proxy] of falseNegativeAudit.shortlist.entries()) {
                console.log(`   ${t('checker.nearMissEntry', {
                    index: index + 1,
                    host: `${proxy.server}:${proxy.port}`,
                    coldPassed: proxy.passedColdSessions || 0,
                    coldRequired: proxy.requiredColdSessions || 0,
                    success: proxy.successAttempts || 0,
                    latency: proxy.pingLatencyMs,
                    failure: proxy.failurePhase || t('common.fail')
                })}`);
            }
        } else {
            console.log('');
            console.log(buildFalseNegativeAuditPanel(results, 10));
        }

        const totalSeconds = (Date.now() - overallStartedAt) / 1000;
        const saved = saveResults(trustedOk, mayWork, {
            totalTimeSeconds: totalSeconds,
            uiLanguage: loadStoredUiLanguage()
        });
        console.log(`\n${t('checker.savedProxyResultsTo', { value: saved.outputPath })}`);
        console.log(`${colors.dim}${t('common.totalTime', { value: totalSeconds.toFixed(1) })}${colors.reset}`);
        if (args.verbose && results.length > 0) {
            console.log(`${colors.dim}${t('common.averagePerProxy', { value: (totalSeconds / results.length).toFixed(2) })}${colors.reset}`);
        }
    } finally {
        releaseSigint();
        const workerCloseStartedAt = Date.now();
        await Promise.allSettled(workers.map(worker => worker.close()));
        if (args.verbose) {
            console.log(`${colors.dim}${t('common.workerCloseTime', { value: Date.now() - workerCloseStartedAt })}${colors.reset}`);
        } else if (args.debugTimings && workers.length > 0) {
            console.log(`${colors.dim}${t('common.workerCloseTime', { value: Date.now() - workerCloseStartedAt })}${colors.reset}`);
        }
    }
}

function runCli() {
    terminalSession.installProcessCleanupHandlers();
    return main().catch(error => {
        terminalSession.dispose();
        if (
            error.message === STATUS.CHECKER_INVALID ||
            error.message === STATUS.INPUT_INVALID
        ) {
            const exitCode = error.message === STATUS.INPUT_INVALID ? 1 : 2;
            if (error.alreadyPresented) {
                process.exit(exitCode);
            }
            if (error.userTitle) {
                console.error(buildPreflightPanel({
                    title: error.userTitle,
                    subtitle: error.userSubtitle || t('common.checkerCouldNotFinish'),
                    tone: 'danger',
                    lines: error.userLines || []
                }));
            } else {
                console.error(`${colors.red}${t('common.checkerCouldNotFinish')}${colors.reset}`);
            }
            process.exit(exitCode);
        }

        if (isUserCancelledError(error)) {
            console.error(buildPreflightPanel({
                title: t('common.checkCancelled'),
                subtitle: t('common.scanStopped'),
                tone: 'warning',
                lines: [
                    t('common.currentWorkStopped')
                ]
            }));
            process.exit(130);
        }

        console.error(`${t('common.fatalPrefix')} ${error.message || error}`);
        process.exit(1);
    });
}

module.exports = {
    AdaptiveScanCoordinator,
    PreparedProbeQueue,
    STATUS,
    MAX_RECOMMENDED_CONCURRENCY,
    PROGRESS_HINTS,
    ColdRetestScheduler,
    Worker,
    buildProgressPanel,
    createProgressHint,
    createProgressHintRotator,
    formatProgressHintLines,
    normalizeProgressHintText,
    classifyTdError,
    classifyProxyCheck,
    explainEnvironmentError,
    getFinalTimeoutSeconds,
    getMaxColdConfirmationSessions,
    getRequiredColdConfirmations,
    isIpAddress,
    checkDnsStability,
    computeConfidence,
    computePreparedProbePriority,
    resolveColdSchedulerConcurrency,
    resolveWarmCheckSkip,
    summarizeDcSweepOutcome,
    resolveProgressHintLanguage,
    resolveProgressHintText,
    dedupeSupported,
    loadInputEntries,
    main,
    normalizeConcurrency,
    normalizeSecret,
    validateInputFileOrThrow,
    parseArgs,
    parseProxyUrl,
    compareMayWorkCandidates,
    rankFalseNegativeShortlist,
    buildCanonicalProxyUrl,
    resolveColdRetestDisposition,
    runQueue,
    runProxyCheckPool,
    runScheduledColdRetests,
    runCli,
    summarizeColdRetests,
    summarizeInput,
    isWarmRescueEligible,
    isSoftDcFailure,
    toTdProxy
};

if (require.main === module) {
    require('../cli/terminal_menu').runCli();
}
