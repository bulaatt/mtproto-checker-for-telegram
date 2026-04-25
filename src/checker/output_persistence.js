const fs = require('fs');

const { getActiveUiLanguage, t } = require('../i18n');
const projectPaths = require('../config/project_paths');

const RESULT_SECTION_WORKING = 'working';
const RESULT_SECTION_MAY_WORK = 'may_work';
const CHECKER_CANDIDATES_FILENAME = 'checker_candidates.json';
const WORKING_HEADER_TOKENS = [
    'Working MTProto proxies',
    'Рабочие MTProto-прокси'
];
const MAY_WORK_HEADER_TOKENS = [
    'May Work (check in Telegram) MTProto proxies',
    'MTProto-прокси, которые могут работать (проверьте в Telegram)',
    'MTProto-прокси со статусом "может работать"'
];
const TOTAL_TIME_PATTERNS = [
    /^# Total scan time:\s+(\d+(?:\.\d+)?)s$/i,
    /^# Общее время сканирования:\s+(\d+(?:\.\d+)?)\s*с$/i,
    /^# Total scan time:\s+(\d+)min\s+(\d+)s$/i,
    /^# Общее время сканирования:\s+(\d+)мин\s+(\d+)с$/i
];

function parseTotalTimeLine(line) {
    for (const pattern of TOTAL_TIME_PATTERNS) {
        const match = line.match(pattern);
        if (!match) continue;

        if (match.length === 2) {
            return `${match[1]}s`;
        }

        if (match.length === 3) {
            const minutes = Number.parseInt(match[1], 10);
            const seconds = Number.parseInt(match[2], 10);
            if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
                return `${minutes * 60 + seconds}s`;
            }
        }
    }

    return null;
}

function formatSavedTotalTime(totalTimeSeconds, language) {
    const totalSeconds = Math.max(0, Math.round(Number(totalTimeSeconds) || 0));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return t('common.minutesSeconds', { minutes, seconds }, language);
}

function parseSavedResultsText(raw) {
    const workingProxies = [];
    const mayWorkProxies = [];
    let totalTime = null;
    let section = RESULT_SECTION_WORKING;

    for (const rawLine of String(raw || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#')) {
            const parsedTotalTime = parseTotalTimeLine(line);
            if (parsedTotalTime) {
                totalTime = parsedTotalTime;
            }
            if (MAY_WORK_HEADER_TOKENS.some(token => line.includes(token))) {
                section = RESULT_SECTION_MAY_WORK;
            } else if (WORKING_HEADER_TOKENS.some(token => line.includes(token))) {
                section = RESULT_SECTION_WORKING;
            }
            continue;
        }

        if (section === RESULT_SECTION_MAY_WORK) {
            mayWorkProxies.push(line);
        } else {
            workingProxies.push(line);
        }
    }

    return {
        workingProxies,
        mayWorkProxies,
        totalTime
    };
}

function saveResults(working, mayWork = [], meta = {}) {
    projectPaths.ensureDataDirectories();

    const outputPath = projectPaths.getWorkingResultsPath();
    const language = meta.uiLanguage || getActiveUiLanguage();
    const lines = [
        `# ${t('output.workingHeader', { count: working.length }, language)}`
    ];

    if (meta.totalTimeSeconds != null) {
        const totalTimeValue = formatSavedTotalTime(meta.totalTimeSeconds, language);
        lines.push(`# ${t('output.totalScanTime', { value: totalTimeValue }, language)}`);
    }

    lines.push(`# ${t('output.noteAvailability', {}, language)}`);
    lines.push('');

    if (working.length > 0) {
        for (const proxy of working) {
            lines.push(proxy.canonicalUrl || proxy.originalUrl);
        }
        lines.push('');
    }

    lines.push(`# ${t('output.mayWorkHeader', { count: mayWork.length }, language)}`);
    lines.push('');

    if (mayWork.length > 0) {
        for (const proxy of mayWork) {
            lines.push(proxy.canonicalUrl || proxy.originalUrl);
        }
        lines.push('');
    }

    fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');

    return { outputPath };
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function normalizeCandidateDiagnostic(proxy) {
    const server = String(proxy && proxy.server || '');
    const port = proxy && proxy.port != null ? Number(proxy.port) : null;

    return {
        endpoint: port ? `${server}:${port}` : server,
        canonicalUrl: proxy && (proxy.canonicalUrl || proxy.originalUrl) || null,
        server,
        port,
        proxyType: proxy && proxy.proxyType || null,
        status: proxy && proxy.status || null,
        promoteReason: proxy && proxy.promoteReason || null,
        candidatePatternClass: proxy && proxy.candidatePatternClass || 'mixed_failures',
        failurePhase: proxy && proxy.failurePhase || null,
        route: {
            currentReadyRatio: finiteOrNull(proxy && proxy.currentRouteReadyRatio),
            currentApiRatio: finiteOrNull(proxy && proxy.currentRouteApiRatio)
        },
        cold: {
            passedSessions: Number(proxy && proxy.passedColdSessions || 0),
            requiredSessions: Number(proxy && proxy.requiredColdSessions || 0),
            apiConfirmedButUnpassedSessions: Number(proxy && proxy.apiConfirmedButUnpassedSessions || 0),
            warmReadyTimeout: Boolean(proxy && proxy.warmReadyTimeout),
            readyTimeoutSessions: Number(proxy && proxy.readyTimeoutSessions || 0),
            pingTimeoutOnlySessions: Number(proxy && proxy.pingTimeoutOnlySessions || 0),
            dcSweepFailedSessions: Number(proxy && proxy.dcSweepFailedSessions || 0)
        },
        latency: {
            hasValidSample: Boolean(proxy && proxy.hasValidLatencySample),
            sampleCount: Number(proxy && proxy.latencySampleCount || 0),
            median: finiteOrNull(proxy && proxy.medianLatency),
            trimmedMax: finiteOrNull(proxy && proxy.trimmedMaxLatency),
            rawMax: finiteOrNull(proxy && proxy.rawMaxLatency),
            ping: finiteOrNull(proxy && proxy.pingLatencyMs)
        },
        blocks: {
            capReason: proxy && proxy.capReason || null,
            ddPartialColdRouteBlockReason: proxy && proxy.ddPartialColdRouteBlockReason || null,
            volatilityCapped: Boolean(proxy && proxy.volatilityCapped),
            routeFlapRecoverable: Boolean(proxy && proxy.routeFlapRecoverable),
            ddPartialColdRouteRecoverable: Boolean(proxy && proxy.ddPartialColdRouteRecoverable)
        },
        diagnostics: {
            dnsStabilityPassed: Boolean(proxy && proxy.dnsStabilityPassed),
            dnsStrongEligible: Boolean(proxy && proxy.dnsStrongEligible),
            dnsSingleAddressOnly: Boolean(proxy && proxy.dnsSingleAddressOnly),
            timeoutOnlyErrors: Boolean(proxy && proxy.timeoutOnlyErrors),
            allErrors: Array.isArray(proxy && proxy.allErrors) ? proxy.allErrors : []
        }
    };
}

function saveCandidateDiagnostics(candidates = [], meta = {}) {
    projectPaths.ensureDataDirectories();

    const outputPath = projectPaths.getRuntimeFilePath(CHECKER_CANDIDATES_FILENAME);
    const payload = {
        generatedAt: new Date().toISOString(),
        runMode: meta.runMode || 'debug',
        total: candidates.length,
        candidates: candidates.map(normalizeCandidateDiagnostic)
    };

    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    return { outputPath };
}

module.exports = {
    formatSavedTotalTime,
    parseSavedResultsText,
    RESULT_SECTION_MAY_WORK,
    RESULT_SECTION_WORKING,
    saveCandidateDiagnostics,
    saveResults
};
