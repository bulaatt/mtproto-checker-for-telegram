const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tdl = require('tdl');

const TEST_APP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tgproxy-checker-home-'));
const ORIGINAL_TGPROXY_HOME = process.env.TGPROXY_HOME;
process.env.TGPROXY_HOME = TEST_APP_HOME;

process.on('exit', () => {
    if (typeof ORIGINAL_TGPROXY_HOME === 'string') {
        process.env.TGPROXY_HOME = ORIGINAL_TGPROXY_HOME;
    } else {
        delete process.env.TGPROXY_HOME;
    }
    fs.rmSync(TEST_APP_HOME, { recursive: true, force: true });
});

const checkerFacade = require('../telegram_proxy_pinger');
const checkerCore = require('../src/checker');
const projectPaths = require('../src/config/project_paths');
const { setActiveUiLanguage } = require('../src/i18n');
const {
    createCancelState,
    requestCancel
} = require('../src/shared/cancel');
const {
    normalizeSecret,
    normalizeConcurrency,
    parseArgs,
    parseProxyUrl,
    buildCanonicalProxyUrl,
    summarizeInput,
    toTdProxy,
    dedupeSupported
} = require('../src/proxy/input');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function forceRawAnsiStdout() {
    const descriptors = new Map();
    for (const key of ['isTTY', 'cursorTo', 'moveCursor', 'clearLine', 'clearScreenDown']) {
        descriptors.set(key, Object.getOwnPropertyDescriptor(process.stdout, key));
    }
    const originalWtSession = process.env.WT_SESSION;

    Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: true
    });
    for (const key of ['cursorTo', 'moveCursor', 'clearLine', 'clearScreenDown']) {
        Object.defineProperty(process.stdout, key, {
            configurable: true,
            writable: true,
            value: undefined
        });
    }
    process.env.WT_SESSION = process.env.WT_SESSION || 'test-terminal';

    return () => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(process.stdout, key, descriptor);
            } else {
                delete process.stdout[key];
            }
        }
        if (typeof originalWtSession === 'string') {
            process.env.WT_SESSION = originalWtSession;
        } else {
            delete process.env.WT_SESSION;
        }
    };
}

const {
    AdaptiveScanCoordinator,
    PreparedProbeQueue,
    STATUS,
    PROGRESS_HINTS,
    ColdRetestScheduler,
    Worker,
    checkDnsStability,
    buildProgressPanel,
    classifyProxyCheck,
    computeConfidence,
    computePreparedProbePriority,
    createProgressHint,
    createProgressHintRotator,
    compareMayWorkCandidates,
    explainEnvironmentError,
    getFinalTimeoutSeconds,
    getMaxColdConfirmationSessions,
    getRequiredColdConfirmations,
    isIpAddress,
    isWarmRescueEligible,
    isSoftDcFailure,
    normalizeProgressHintText,
    resolveColdSchedulerConcurrency,
    resolveColdRetestDisposition,
    resolveProgressHintLanguage,
    resolveProgressHintText,
    resolveWarmCheckSkip,
    rankFalseNegativeShortlist,
    runQueue,
    runProxyCheckPool,
    runScheduledColdRetests,
    summarizeDcSweepOutcome,
    summarizeColdRetests,
    loadInputEntries,
    validateInputFileOrThrow
} = require('../src/checker');

test('telegram_proxy_pinger facade re-exports the checker core API', () => {
    assert.equal(checkerFacade.main, checkerCore.main);
    assert.equal(checkerFacade.runCli, checkerCore.runCli);
    assert.equal(checkerFacade.createProgressHint, checkerCore.createProgressHint);
    assert.equal(checkerFacade.createProgressHintRotator, checkerCore.createProgressHintRotator);
});

test('checker core uses placeholder app credentials by default for pre-auth proxy checks', () => {
    const coreSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'checker', 'core.js'),
        'utf8'
    );

    assert.match(coreSource, /Placeholders: this checker only probes proxies before any user authorization\./);
    assert.match(coreSource, /const DEFAULT_API_ID = 20192049;/);
    assert.match(coreSource, /const DEFAULT_API_HASH = 'All those moments will be lost in time, like tears in rain.';/);
});

test('buildProgressPanel shows May work between Working and Failed', () => {
    const panel = buildProgressPanel({
        title: 'Checking unique proxies...',
        spinnerFrame: '\\',
        completed: 781,
        total: 882,
        elapsedMs: 219000,
        working: 1,
        mayWork: 12,
        failed: 768,
        tip: null,
        tone: 'warning'
    });

    assert.match(panel, /Working: 1/);
    assert.match(panel, /May work: 12/);
    assert.match(panel, /Failed: 768/);
    assert.ok(panel.indexOf('Working: 1') < panel.indexOf('May work: 12'));
    assert.ok(panel.indexOf('May work: 12') < panel.indexOf('Failed: 768'));
});

test('parseProxyUrl parses hex MTProto links', () => {
    const parsed = parseProxyUrl('tg://proxy?server=Example.COM&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.server, 'example.com');
    assert.equal(parsed.value.port, 443);
    assert.equal(parsed.value.secretHex, 'dd8fb807a1ac8c4e95b8a2642e5bedd8fc');
    assert.equal(parsed.value.proxyType, 'dd');
});

test('normalizeSecret accepts base64url secrets', () => {
    const normalized = normalizeSecret('DDBighLLvXrFGRMCBVJdFQ');
    assert.ok(normalized);
    assert.equal(normalized.type, 'classic');
    assert.equal(normalized.hex, '0c30628212cbbd7ac519130205525d15');
});

test('parseProxyUrl rejects bot-only links as unsupported', () => {
    const parsed = parseProxyUrl('https://t.me/proxy?server=ru36.importmsk.ru&port=8443&bot=@mtpro_xyz_bot');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, STATUS.UNSUPPORTED_BOT_LINK);
});

test('parseProxyUrl extracts proxy link from prefixed chat log lines', () => {
    const parsed = parseProxyUrl('[4/10/2026 10:12 AM] voidsignal: tg://proxy?server=abuf7oc6.helper.website&port=443&secret=ee4c161c0ff444b2bbc2f22c6e8d1f6bbf6875796775712e68656c7065723230736d732e7275&channel=@flat447');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.server, 'abuf7oc6.helper.website');
});

test('parseProxyUrl strips trailing markdown decoration and builds canonical output url', () => {
    const parsed = parseProxyUrl('tg://proxy?server=65.109.16.146&port=443&secret=dd104462821249bd7ac519130220c25d09**');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.originalUrl, 'tg://proxy?server=65.109.16.146&port=443&secret=dd104462821249bd7ac519130220c25d09');
    assert.equal(
        parsed.value.canonicalUrl,
        'tg://proxy?server=65.109.16.146&port=443&secret=dd104462821249bd7ac519130220c25d09'
    );
});

test('parseProxyUrl accepts mixed-case tg links', () => {
    const parsed = parseProxyUrl('TG://proxy?server=MixedCase.EXAMPLE&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.server, 'mixedcase.example');
});

test('parseProxyUrl accepts mixed-case t.me links', () => {
    const parsed = parseProxyUrl('https://T.ME/Proxy?server=MixedCase.EXAMPLE&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.server, 'mixedcase.example');
});

test('parseProxyUrl rejects private and reserved IP literal servers', () => {
    const unsafeServers = [
        '127.0.0.1',
        '10.0.0.1',
        '172.16.0.1',
        '192.168.0.1',
        '169.254.1.1',
        '::1',
        'fc00::1'
    ];

    for (const server of unsafeServers) {
        const parsed = parseProxyUrl(`tg://proxy?server=${encodeURIComponent(server)}&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc`);
        assert.equal(parsed.ok, false, server);
        assert.equal(parsed.reason, STATUS.INVALID_INPUT, server);
    }
});

test('parseProxyUrl rejects terminal control characters in server names', () => {
    const parsed = parseProxyUrl('tg://proxy?server=%1B%5D52%3Bc%3BaGVsbG8%3D%07.example&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc');

    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, STATUS.INVALID_INPUT);
});

test('parseArgs accepts debug timing and phase stats flags', () => {
    const args = parseArgs([
        'node',
        'telegram_proxy_pinger.js',
        '--file',
        'proxies.txt',
        '--debug-timings',
        '--debug-phase-stats'
    ]);

    assert.equal(args.debugTimings, true);
    assert.equal(args.debugPhaseStats, true);
});

test('parseArgs enables verbose diagnostics when debug mode is requested', () => {
    const args = parseArgs([
        'node',
        'telegram_proxy_pinger.js',
        '--file',
        'proxies.txt',
        '--debug'
    ]);

    assert.equal(args.debug, true);
    assert.equal(args.verbose, true);
});

test('buildCanonicalProxyUrl always serializes a clean tg proxy link', () => {
    assert.equal(
        buildCanonicalProxyUrl({
            server: 'champagne.limoozin.info',
            port: 25565,
            secretHex: 'ee344818749bd7ac519130220c25d090'
        }),
        'tg://proxy?server=champagne.limoozin.info&port=25565&secret=ee344818749bd7ac519130220c25d090'
    );
});

test('validateInputFileOrThrow returns validation details for a valid file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'input-validate-test-'));
    const previousCwd = process.cwd();

    try {
        process.chdir(tempDir);
        projectPaths.ensureDataDirectories();
        fs.writeFileSync(
            'proxies.txt',
            'tg://proxy?server=valid.example&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc\n',
            'utf8'
        );
        fs.writeFileSync(
            projectPaths.getAllSourcesPath(),
            'tg://proxy?server=managed.example&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc\n',
            'utf8'
        );

        const validation = validateInputFileOrThrow('proxies.txt');
        assert.equal(validation.ok, true);
        assert.equal(validation.stats.uniqueSupported, 1);

        const managedValidation = validateInputFileOrThrow('data/runtime/github_source_all.txt');
        assert.equal(managedValidation.ok, true);
        assert.equal(managedValidation.resolvedPath, projectPaths.getAllSourcesPath());
        assert.equal(loadInputEntries(managedValidation.resolvedPath).length, 1);
    } finally {
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('main fails before worker init when input file is invalid', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-input-invalid-test-'));
    const previousCwd = process.cwd();
    const originalInit = Worker.prototype.init;

    try {
        process.chdir(tempDir);
        Worker.prototype.init = async () => {
            throw new Error('worker init should not run');
        };

        await assert.rejects(
            checkerCore.main(['node', 'telegram_proxy_pinger.js', '--file', 'missing.txt']),
            error => {
                assert.equal(error.message, STATUS.INPUT_INVALID);
                assert.equal(error.userTitle, 'Cannot Start Check');
                return true;
            }
        );
    } finally {
        Worker.prototype.init = originalInit;
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('main surfaces worker initialization cause when all workers fail', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-worker-init-fail-test-'));
    const previousCwd = process.cwd();
    const originalInit = Worker.prototype.init;

    try {
        process.chdir(tempDir);
        projectPaths.ensureDataDirectories();
        fs.writeFileSync(
            'proxies.txt',
            'tg://proxy?server=valid.example&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc\n',
            'utf8'
        );
        Worker.prototype.init = async () => {
            throw new Error('library load disallowed by system policy');
        };

        await assert.rejects(
            checkerCore.main(['node', 'telegram_proxy_pinger.js', '--file', 'proxies.txt']),
            error => {
                assert.equal(error.message, STATUS.CHECKER_INVALID);
                assert.equal(error.userTitle, 'Worker initialization failed');
                assert.match(error.userLines.join('\n'), /TDLib addon/i);
                return true;
            }
        );
    } finally {
        Worker.prototype.init = originalInit;
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('main initializes workers with bounded concurrency', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-worker-init-concurrent-test-'));
    const previousCwd = process.cwd();
    const originalInit = Worker.prototype.init;
    const originalPrepareProxyCheck = Worker.prototype.prepareProxyCheck;
    const originalClose = Worker.prototype.close;
    const originalLog = console.log;
    let activeInits = 0;
    let maxActiveInits = 0;

    try {
        process.chdir(tempDir);
        projectPaths.ensureDataDirectories();
        fs.writeFileSync(
            'proxies.txt',
            'tg://proxy?server=valid.example&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc\n',
            'utf8'
        );
        Worker.prototype.init = async function initStub() {
            void this;
            activeInits += 1;
            maxActiveInits = Math.max(maxActiveInits, activeInits);
            await sleep(20);
            activeInits -= 1;
        };
        Worker.prototype.prepareProxyCheck = async function prepareProxyCheckStub(proxy) {
            return {
                candidate: proxy,
                dcSweep: [
                    { dcId: 2, ok: false, error: 'TEST_FAIL' },
                    { dcId: 4, ok: false, error: 'TEST_FAIL' },
                    { dcId: 5, ok: false, error: 'TEST_FAIL' }
                ],
                warmCheck: null,
                shouldRunStrictRetest: false,
                finalTimeoutSeconds: 6,
                requiredColdSessions: 3,
                maxColdSessions: 3,
                warmCheckSkipped: true,
                skipReason: 'test',
                dcSuccessCount: 0,
                phaseTimings: {
                    dcSweepMs: 1,
                    warmCheckMs: 0
                },
                workerId: this.id
            };
        };
        Worker.prototype.close = async () => {};
        console.log = () => {};

        await checkerCore.main([
            'node',
            'telegram_proxy_pinger.js',
            '--file',
            'proxies.txt',
            '--concurrency',
            '16'
        ]);

        assert.ok(maxActiveInits > 1);
        assert.ok(maxActiveInits <= 8);
    } finally {
        Worker.prototype.init = originalInit;
        Worker.prototype.prepareProxyCheck = originalPrepareProxyCheck;
        Worker.prototype.close = originalClose;
        console.log = originalLog;
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('main stops worker initialization after the first fully failed bounded wave', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-worker-init-fail-fast-test-'));
    const previousCwd = process.cwd();
    const originalInit = Worker.prototype.init;
    let initCalls = 0;

    try {
        process.chdir(tempDir);
        projectPaths.ensureDataDirectories();
        fs.writeFileSync(
            'proxies.txt',
            'tg://proxy?server=valid.example&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc\n',
            'utf8'
        );
        Worker.prototype.init = async () => {
            initCalls += 1;
            await sleep(20);
            throw new Error('library load disallowed by system policy');
        };

        await assert.rejects(
            checkerCore.main([
                'node',
                'telegram_proxy_pinger.js',
                '--file',
                'proxies.txt',
                '--concurrency',
                '16'
            ]),
            error => {
                assert.equal(error.message, STATUS.CHECKER_INVALID);
                assert.equal(error.userTitle, 'Worker initialization failed');
                return true;
            }
        );
        assert.equal(initCalls, 8);
    } finally {
        Worker.prototype.init = originalInit;
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('resolveProgressHintLanguage defaults to english', () => {
    assert.equal(resolveProgressHintLanguage(), 'en');
});

test('resolveProgressHintText supports english and russian with english fallback', () => {
    assert.equal(
        resolveProgressHintText({ id: 'coffee', en: 'Coffee time.', ru: 'Время для кофе.' }, 'ru'),
        'Время для кофе'
    );
    assert.equal(
        resolveProgressHintText({ id: 'coffee', en: 'Coffee time.' }, 'ru'),
        'Coffee time'
    );
});

test('normalizeProgressHintText trims a trailing period for display', () => {
    assert.equal(normalizeProgressHintText('Coffee time.'), 'Coffee time');
    assert.equal(normalizeProgressHintText('Время для кофе...'), 'Время для кофе');
    assert.equal(normalizeProgressHintText('No punctuation'), 'No punctuation');
});

test('createProgressHint can pick different phrases on different runs', () => {
    const first = createProgressHint(() => 0.0, 'en');
    const last = createProgressHint(() => 0.999999, 'en');
    assert.notEqual(first.id, last.id);
    assert.equal(first.text, PROGRESS_HINTS[0].en);
    assert.equal(last.text, PROGRESS_HINTS[PROGRESS_HINTS.length - 1].en);
});

test('createProgressHintRotator rotates hints over time and animates ellipsis without immediate repeats', () => {
    const randomValues = [0, 0, 0];
    const rotator = createProgressHintRotator(() => randomValues.shift() ?? 0, 'en');

    const first = rotator.next(0);
    const second = rotator.next(100);
    const third = rotator.next(200);
    const fourth = rotator.next(300);
    const fifth = rotator.next(400);
    const rotated = rotator.next(30_000);

    assert.equal(first.id, PROGRESS_HINTS[0].id);
    assert.equal(first.text, PROGRESS_HINTS[0].en);
    assert.equal(second.text, PROGRESS_HINTS[0].en);
    assert.equal(third.text, `${PROGRESS_HINTS[0].en}.`);
    assert.equal(fourth.text, `${PROGRESS_HINTS[0].en}.`);
    assert.equal(fifth.text, `${PROGRESS_HINTS[0].en}..`);
    assert.notEqual(rotated.id, first.id);
    assert.equal(rotated.text, PROGRESS_HINTS[1].en);
});

test('progress hints only use the approved phrase set without trailing periods', () => {
    assert.equal(PROGRESS_HINTS.length, 15);

    const approvedRu = new Set([
        'Да пребудет с этим списком сила хороших прокси',
        'Пусть проверка идёт, а вы пока займитесь чем-нибудь ещё',
        'Небольшой чайный перерыв сейчас будет очень кстати',
        'Где-то в Матрице пакеты решают свою судьбу',
        'Не каждый прокси выбирает путь джедая',
        'Пакеты ушли в гиперпространство и скоро вернутся',
        'Сетевые боги кидают кубики за этот список',
        'Этот маршрут выглядит подозрительно… значит, возможно, рабочий',
        'Прокси сейчас думает о вечном и немного о пакетах',
        'Идёт тонкая настройка между “почти” и “работает”',
        'Похоже, этот прокси знает короткую дорогу',
        'Прокси либо сработает, либо войдёт в легенды логов',
        'Где-то админ сказал “ну вроде должно работать”',
        'Проверка идёт уверенно, почти как будто по плану',
        'Тут есть энергия “не трогай, оно работает”'
    ]);
    const approvedEn = new Set([
        'May the source be with this proxy list',
        'You can let this run while you do something else',
        'I guess it is time for a tea break',
        'Somewhere in the Matrix, packets are choosing their fate',
        'Not every proxy chooses the Jedi path',
        'Packets jumped to hyperspace and should be back soon',
        'The network gods are rolling dice for this list',
        'This route looks suspicious… which means it might actually work',
        'The proxy is contemplating eternity and a few packets',
        'Fine-tuning the delicate space between almost and working',
        'Looks like this proxy knows a shortcut',
        'This proxy will either work or become legend in the logs',
        'Some admin once said this should probably work',
        'The check proceeds confidently, almost as if by design',
        'This has strong do not touch it, it works energy'
    ]);

    const removedRu = new Set([
        'Результаты ещё вернутся',
        'Прокси-чек не тот квест, который проходится на спидране'
    ]);
    const removedEn = new Set([
        'The results will be back',
        'One does not simply speedrun proxy checks'
    ]);

    for (const hint of PROGRESS_HINTS) {
        assert.ok(approvedRu.has(hint.ru));
        assert.ok(approvedEn.has(hint.en));
        assert.ok(!hint.ru.endsWith('.'));
        assert.ok(!hint.en.endsWith('.'));
        assert.ok(!removedRu.has(hint.ru));
        assert.ok(!removedEn.has(hint.en));
    }
});

test('runQueue rotates hints during a long run while spinner redraws continue', async () => {
    const writes = [];
    const originalWrite = process.stdout.write;
    const originalDateNow = Date.now;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let nowMs = 0;
    const intervalCallbacks = [];
    process.stdout.write = chunk => {
        writes.push(String(chunk));
        return true;
    };

    try {
        Date.now = () => nowMs;
        global.setInterval = callback => {
            intervalCallbacks.push(callback);
            return callback;
        };
        global.clearInterval = () => {};

        const gate = {};
        gate.promise = new Promise(resolve => {
            gate.resolve = resolve;
        });

        const runPromise = runQueue(
            [1],
            1,
            async item => {
                await gate.promise;
                return item;
            },
            {
                progressHintRotator: {
                    next(currentNow) {
                        return currentNow >= 24_000
                            ? { id: 'second', text: 'Second hint.' }
                            : { id: 'first', text: 'First hint.' };
                    }
                }
            }
        );

        assert.equal(intervalCallbacks.length, 1);
        intervalCallbacks[0]();
        nowMs = 24_000;
        intervalCallbacks[0]();
        gate.resolve();
        await runPromise;
    } finally {
        process.stdout.write = originalWrite;
        Date.now = originalDateNow;
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
    }

    const output = writes.join('');
    assert.match(output, /First hint\./);
    assert.match(output, /Second hint\./);
});

test('runQueue throws cancelled when cancellation was requested', async () => {
    await assert.rejects(
        runQueue([1, 2], 1, async item => item, { cancelState: { cancelled: true } }),
        error => error.message === STATUS.CANCELLED
    );
});

test('runQueue stops emitting live progress once cancellation was requested', async () => {
    const writes = [];
    const cancelState = { cancelled: false, listeners: new Set() };
    const restoreStdout = forceRawAnsiStdout();
    const originalWrite = process.stdout.write;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const intervalCallbacks = [];
    const gate = {};
    gate.promise = new Promise(resolve => {
        gate.resolve = resolve;
    });

    process.stdout.write = chunk => {
        writes.push(String(chunk));
        return true;
    };

    try {
        global.setInterval = callback => {
            intervalCallbacks.push(callback);
            return callback;
        };
        global.clearInterval = () => {};

        const runPromise = runQueue(
            [1],
            1,
            async item => {
                await gate.promise;
                return item;
            },
            { cancelState }
        );

        assert.equal(intervalCallbacks.length, 1);
        const writesBeforeCancel = writes.length;
        cancelState.cancelled = true;
        intervalCallbacks[0]();
        gate.resolve();

        await assert.rejects(
            runPromise,
            error => error.message === STATUS.CANCELLED
        );

        const cleanupOutput = writes.slice(writesBeforeCancel).join('');
        assert.match(cleanupOutput, /\x1b\[\d+F\x1b\[J\x1b\[\?25h/);
    } finally {
        process.stdout.write = originalWrite;
        restoreStdout();
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
    }
});

test('runQueue redraws live progress without clearing the remaining screen on each update', async () => {
    const writes = [];
    const restoreStdout = forceRawAnsiStdout();
    const originalWrite = process.stdout.write;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalDateNow = Date.now;
    let now = 1000;

    process.stdout.write = chunk => {
        writes.push(String(chunk));
        return true;
    };

    try {
        setActiveUiLanguage('en');
        global.setInterval = () => 1;
        global.clearInterval = () => {};
        Date.now = () => now;

        await runQueue(
            [1, 2],
            1,
            async item => {
                now += 250;
                return item;
            },
            {
                progressHintRotator: {
                    next: () => null
                }
            }
        );

        const output = writes.join('');
        assert.doesNotMatch(output, /\x1b\[J/);
        assert.match(output, /\x1b\[2K/);
    } finally {
        process.stdout.write = originalWrite;
        restoreStdout();
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        Date.now = originalDateNow;
    }
});

test('runQueue keeps pinned preflight result visible above the next live progress panel', async () => {
    const writes = [];
    const restoreStdout = forceRawAnsiStdout();
    const originalWrite = process.stdout.write;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;

    process.stdout.write = chunk => {
        writes.push(String(chunk));
        return true;
    };

    try {
        global.setInterval = () => 1;
        global.clearInterval = () => {};

        await runQueue(
            [1],
            1,
            async item => item,
            {
                pinnedLivePanels: ['Preflight Result\nWorking: 1\nPassed: 1'],
                progressHintRotator: {
                    next: () => null
                }
            }
        );

        const output = writes.join('');
        assert.match(output, /Preflight Result/);
        assert.match(output, /Preparing checks/);
        assert.ok(output.indexOf('Preflight Result') < output.indexOf('Preparing checks'));
    } finally {
        process.stdout.write = originalWrite;
        restoreStdout();
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        setActiveUiLanguage('en');
    }
});

test('runQueue throttles rapid live redraws while work finishes faster than spinner cadence', async () => {
    const writes = [];
    const restoreStdout = forceRawAnsiStdout();
    const originalWrite = process.stdout.write;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalDateNow = Date.now;

    process.stdout.write = chunk => {
        writes.push(String(chunk));
        return true;
    };

    try {
        global.setInterval = () => 1;
        global.clearInterval = () => {};
        Date.now = () => 1000;

        await runQueue(
            [1, 2, 3],
            1,
            async item => item,
            {
                progressHintRotator: {
                    next: () => null
                }
            }
        );

        const renderCount = (writes.join('').match(/\x1b\[\?25l/gi) || []).length;
        assert.equal(renderCount, 1);
    } finally {
        process.stdout.write = originalWrite;
        restoreStdout();
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        Date.now = originalDateNow;
    }
});

test('rankFalseNegativeShortlist excludes hard-fail markers', () => {
    const shortlist = rankFalseNegativeShortlist([
        {
            server: 'dns.bad',
            port: 443,
            status: STATUS.FAIL,
            debug: { warmCheck: { ok: true } },
            passedColdSessions: 2,
            requiredColdSessions: 4,
            successAttempts: 6,
            pingLatencyMs: 180,
            failurePhase: 'ping_proxy',
            allErrors: ['DC2:DNS_ERROR']
        },
        {
            server: 'good.fail',
            port: 443,
            status: STATUS.FAIL,
            debug: { warmCheck: { ok: true } },
            passedColdSessions: 1,
            requiredColdSessions: 4,
            successAttempts: 4,
            pingLatencyMs: 190,
            failurePhase: 'wait_ready',
            allErrors: ['COLD:TIMEOUT']
        }
    ]);

    assert.equal(shortlist.length, 1);
    assert.equal(shortlist[0].server, 'good.fail');
});

test('rankFalseNegativeShortlist accepts soft dc sweep failures', () => {
    const shortlist = rankFalseNegativeShortlist([
        {
            server: 'soft.dc',
            port: 443,
            status: STATUS.FAIL,
            debug: {
                warmCheck: { ok: true },
                dcSweep: [
                    { dcId: 2, ok: false, error: 'TIMEOUT' },
                    { dcId: 4, ok: true },
                    { dcId: 5, ok: true }
                ]
            },
            passedColdSessions: 1,
            requiredColdSessions: 4,
            successAttempts: 4,
            pingLatencyMs: 200,
            failurePhase: 'dc_sweep',
            allErrors: ['DC2:TIMEOUT']
        }
    ]);

    assert.equal(shortlist.length, 1);
    assert.equal(shortlist[0].server, 'soft.dc');
});

test('rankFalseNegativeShortlist sorts by cold sessions, then success count, then ping', () => {
    const shortlist = rankFalseNegativeShortlist([
        {
            server: 'ping-slower',
            port: 443,
            status: STATUS.FAIL,
            debug: { warmCheck: { ok: true } },
            passedColdSessions: 1,
            requiredColdSessions: 4,
            successAttempts: 5,
            pingLatencyMs: 210,
            failurePhase: 'ping_proxy',
            allErrors: ['COLD:TIMEOUT']
        },
        {
            server: 'best-cold',
            port: 443,
            status: STATUS.FAIL,
            debug: { warmCheck: { ok: true } },
            passedColdSessions: 2,
            requiredColdSessions: 4,
            successAttempts: 4,
            pingLatencyMs: 230,
            failurePhase: 'wait_ready',
            allErrors: ['COLD:READY_TIMEOUT']
        },
        {
            server: 'ping-faster',
            port: 443,
            status: STATUS.FAIL,
            debug: { warmCheck: { ok: true } },
            passedColdSessions: 1,
            requiredColdSessions: 4,
            successAttempts: 5,
            pingLatencyMs: 180,
            failurePhase: 'ping_proxy',
            allErrors: ['COLD:TIMEOUT']
        }
    ], 10);

    assert.deepEqual(
        shortlist.map(item => item.server),
        ['best-cold', 'ping-faster', 'ping-slower']
    );
});

test('rankFalseNegativeShortlist keeps warm transition failures eligible without strong ping evidence', () => {
    const shortlist = rankFalseNegativeShortlist([
        {
            server: 'warm-transition',
            port: 443,
            status: STATUS.FAIL,
            warmReadyReached: true,
            warmSawConnectingToProxy: true,
            successAttempts: 1,
            failAttempts: 1,
            pingLatencyMs: null,
            failurePhase: 'wait_ready',
            allErrors: ['COLD:READY_TIMEOUT']
        }
    ]);

    assert.equal(shortlist.length, 1);
    assert.equal(shortlist[0].server, 'warm-transition');
});

test('compareMayWorkCandidates prioritizes stronger mobile signals over lower ping alone', () => {
    const ordered = [
        {
            server: 'connect-only',
            port: 443,
            networkOk: false,
            readyReached: false,
            sawConnectingToProxy: true,
            forcedReconnect: false,
            passedColdSessions: 0,
            successAttempts: 1,
            failAttempts: 0,
            pingLatencyMs: 140,
            allLatencies: [140],
            failurePhase: 'wait_ready',
            dnsStabilityPassed: true,
            dnsStrongEligible: true
        },
        {
            server: 'network-ready',
            port: 443,
            networkOk: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            passedColdSessions: 1,
            successAttempts: 2,
            failAttempts: 0,
            pingLatencyMs: 220,
            allLatencies: [220, 225],
            failurePhase: 'ping_proxy',
            dnsStabilityPassed: true,
            dnsStrongEligible: true
        },
        {
            server: 'traffic-confirmed',
            port: 443,
            networkOk: true,
            readyReached: true,
            realTrafficOk: true,
            apiProbePassed: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            passedColdSessions: 1,
            successAttempts: 2,
            failAttempts: 0,
            pingLatencyMs: 260,
            allLatencies: [260, 265],
            failurePhase: 'ping_proxy',
            dnsStabilityPassed: true,
            dnsStrongEligible: true
        }
    ].sort(compareMayWorkCandidates);

    assert.deepEqual(
        ordered.map(item => item.server),
        ['traffic-confirmed', 'network-ready', 'connect-only']
    );
});

test('compareMayWorkCandidates prefers warm-ready candidates over connect-only candidates', () => {
    const ordered = [
        {
            server: 'connect-only',
            port: 443,
            warmReadyReached: false,
            sawConnectingToProxy: true,
            successAttempts: 1,
            failAttempts: 0,
            pingLatencyMs: 150,
            allLatencies: [150],
            failurePhase: 'wait_ready',
            dnsStabilityPassed: true,
            dnsStrongEligible: true
        },
        {
            server: 'warm-ready',
            port: 443,
            warmReadyReached: true,
            sawConnectingToProxy: false,
            successAttempts: 1,
            failAttempts: 0,
            pingLatencyMs: 220,
            allLatencies: [220],
            failurePhase: 'wait_ready',
            dnsStabilityPassed: true,
            dnsStrongEligible: true
        }
    ].sort(compareMayWorkCandidates);

    assert.deepEqual(
        ordered.map(item => item.server),
        ['warm-ready', 'connect-only']
    );
});

test('compareMayWorkCandidates penalizes non-soft failures and prefers fewer fail attempts', () => {
    const ordered = [
        {
            server: 'non-soft',
            port: 443,
            networkOk: true,
            readyReached: true,
            successAttempts: 1,
            failAttempts: 0,
            pingLatencyMs: 140,
            allLatencies: [140],
            failurePhase: 'api_probe',
            dnsStabilityPassed: true,
            dnsStrongEligible: true
        },
        {
            server: 'soft-more-fails',
            port: 443,
            networkOk: true,
            readyReached: true,
            successAttempts: 1,
            failAttempts: 3,
            pingLatencyMs: 210,
            allLatencies: [210],
            failurePhase: 'ping_proxy',
            dnsStabilityPassed: true,
            dnsStrongEligible: true
        },
        {
            server: 'soft-fewer-fails',
            port: 443,
            networkOk: true,
            readyReached: true,
            successAttempts: 1,
            failAttempts: 1,
            pingLatencyMs: 260,
            allLatencies: [260],
            failurePhase: 'ping_proxy',
            dnsStabilityPassed: true,
            dnsStrongEligible: true
        }
    ].sort(compareMayWorkCandidates);

    assert.deepEqual(
        ordered.map(item => item.server),
        ['soft-fewer-fails', 'soft-more-fails', 'non-soft']
    );
});

test('compareMayWorkCandidates penalizes dns-unstable candidates without traffic confirmation', () => {
    const ordered = [
        {
            server: 'dns-unstable',
            port: 443,
            networkOk: true,
            readyReached: true,
            successAttempts: 1,
            failAttempts: 0,
            pingLatencyMs: 160,
            allLatencies: [160],
            failurePhase: 'ping_proxy',
            dnsStabilityPassed: false,
            dnsStrongEligible: false
        },
        {
            server: 'dns-healthy',
            port: 443,
            networkOk: true,
            readyReached: true,
            successAttempts: 1,
            failAttempts: 0,
            pingLatencyMs: 200,
            allLatencies: [200],
            failurePhase: 'ping_proxy',
            dnsStabilityPassed: true,
            dnsStrongEligible: true
        }
    ].sort(compareMayWorkCandidates);

    assert.deepEqual(
        ordered.map(item => item.server),
        ['dns-healthy', 'dns-unstable']
    );
});

test('rankFalseNegativeShortlist uses the same mobile-oriented priority as MAY_WORK ordering', () => {
    const shortlist = rankFalseNegativeShortlist([
        {
            server: 'soft-connect',
            port: 443,
            status: STATUS.FAIL,
            warmSawConnectingToProxy: true,
            successAttempts: 1,
            failAttempts: 0,
            pingLatencyMs: 130,
            allLatencies: [130],
            failurePhase: 'wait_ready',
            allErrors: ['COLD:READY_TIMEOUT']
        },
        {
            server: 'traffic-backed',
            port: 443,
            status: STATUS.FAIL,
            warmReadyReached: true,
            networkOk: true,
            readyReached: true,
            realTrafficOk: true,
            apiProbePassed: true,
            passedColdSessions: 1,
            successAttempts: 1,
            failAttempts: 0,
            pingLatencyMs: 280,
            allLatencies: [280, 300],
            failurePhase: 'ping_proxy',
            allErrors: ['COLD:TIMEOUT']
        },
        {
            server: 'network-ready',
            port: 443,
            status: STATUS.FAIL,
            warmReadyReached: true,
            networkOk: true,
            readyReached: true,
            successAttempts: 1,
            failAttempts: 0,
            pingLatencyMs: 190,
            allLatencies: [190, 210],
            failurePhase: 'ping_proxy',
            allErrors: ['COLD:TIMEOUT']
        }
    ], 10);

    assert.deepEqual(
        shortlist.map(item => item.server),
        ['traffic-backed', 'network-ready', 'soft-connect']
    );
});

test('worker clearProxy uses tracked proxy cleanup after initial full cleanup', async () => {
    const worker = new Worker(1);
    const calls = [];
    worker.safeInvoke = async query => {
        calls.push(query);
        if (query._ === 'getProxies') {
            return { proxies: [{ id: 11 }, { id: 12 }] };
        }
        return {};
    };

    await worker.clearProxy();
    assert.deepEqual(
        calls.map(item => item._),
        ['disableProxy', 'getProxies', 'removeProxy', 'removeProxy']
    );
    assert.equal(worker.proxyCleanupInitialized, true);

    calls.length = 0;
    worker.activeProxyId = 99;
    await worker.clearProxy();
    assert.deepEqual(
        calls.map(item => item._),
        ['disableProxy', 'removeProxy']
    );
    assert.equal(worker.activeProxyId, null);
});

test('dedupeSupported removes identical proxies by canonical tuple', () => {
    const entries = [
        parseProxyUrl('tg://proxy?server=example.com&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc'),
        parseProxyUrl('tg://proxy?server=EXAMPLE.com&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc'),
        parseProxyUrl('tg://proxy?server=example.com&port=8443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc')
    ].map((entry, index) => ({ lineNumber: index + 1, raw: `line-${index + 1}`, ...entry }));

    const deduped = dedupeSupported(entries);
    assert.equal(deduped.unique.length, 2);
    assert.equal(deduped.removed, 1);
});

test('computeConfidence classifies stable and unstable sequences', () => {
    assert.deepEqual(computeConfidence([175], [], 1), {
        level: STATUS.WEAK_OK,
        confidence: 0.67
    });

    assert.deepEqual(computeConfidence([120, 130, 125], [], 3), {
        level: STATUS.WORKING,
        confidence: 1
    });

    assert.deepEqual(computeConfidence([120, 900], ['TIMEOUT'], 3), {
        level: STATUS.WEAK_OK,
        confidence: 0.67
    });

    assert.deepEqual(computeConfidence([500], ['TIMEOUT', 'TIMEOUT'], 3), {
        level: STATUS.INIT_ONLY,
        confidence: 0.34
    });
});

test('summarizeInput counts supported, invalid and bot-only links', () => {
    const entries = [
        { ok: true, value: { server: 'a', port: 1, secretHex: 'x' } },
        { ok: false, reason: STATUS.INVALID_INPUT },
        { ok: false, reason: STATUS.UNSUPPORTED_BOT_LINK }
    ];
    const deduped = { unique: [{ server: 'a', port: 1, secretHex: 'x' }], removed: 2 };

    assert.deepEqual(summarizeInput(entries, deduped), {
        invalid: 1,
        botLinks: 1,
        supported: 1,
        duplicatesRemoved: 2,
        uniqueSupported: 1
    });
});

test('toTdProxy maps parsed records to TDLib proxy shape', () => {
    assert.deepEqual(
        toTdProxy({
            server: 'example.com',
            port: 443,
            secretHex: 'dd8fb807a1ac8c4e95b8a2642e5bedd8fc'
        }),
        {
            _: 'proxy',
            server: 'example.com',
            port: 443,
            type: {
                _: 'proxyTypeMtproto',
                secret: 'dd8fb807a1ac8c4e95b8a2642e5bedd8fc'
            }
        }
    );
});

test('parseArgs accepts attempts and required input file', () => {
    const defaultArgs = parseArgs([
        'node',
        'telegram_proxy_pinger.js',
        '--file',
        'proxies.txt'
    ]);
    const args = parseArgs([
        'node',
        'telegram_proxy_pinger.js',
        '--file',
        'proxies.txt',
        '--attempts',
        '5'
    ]);

    assert.equal(defaultArgs.file, 'proxies.txt');
    assert.equal(args.file, 'proxies.txt');
    assert.equal(args.attempts, 5);
});

test('parseArgs clamps unsafe timeout attempts and batch size values', () => {
    const args = parseArgs([
        'node',
        'telegram_proxy_pinger.js',
        '--file',
        'proxies.txt',
        '--timeout',
        '999',
        '--attempts',
        '999',
        '--batch-size',
        '999999'
    ]);

    assert.equal(args.timeout, 10);
    assert.equal(args.attempts, 5);
    assert.equal(args.batchSize, 5000);
});

test('parseArgs defaults to 32 workers and clamps expert concurrency to 128', () => {
    const defaultArgs = parseArgs([
        'node',
        'telegram_proxy_pinger.js',
        '--file',
        'proxies.txt'
    ]);
    assert.equal(defaultArgs.concurrency, 32);
    assert.equal(defaultArgs.concurrencyWasClamped, false);

    const expertArgs = parseArgs([
        'node',
        'telegram_proxy_pinger.js',
        '--file',
        'proxies.txt',
        '--concurrency',
        '999'
    ]);
    assert.equal(expertArgs.concurrency, 128);
    assert.equal(expertArgs.concurrencyWasClamped, true);
});

test('normalizeConcurrency clamps high values to practical maximum', () => {
    assert.equal(normalizeConcurrency(1), 1);
    assert.equal(normalizeConcurrency(4), 4);
    assert.equal(normalizeConcurrency(10), 10);
    assert.equal(normalizeConcurrency(20), 20);
    assert.equal(normalizeConcurrency(40), 40);
    assert.equal(normalizeConcurrency(128), 128);
    assert.equal(normalizeConcurrency(129), 128);
});

test('explainEnvironmentError recognizes macOS Gatekeeper failures', () => {
    const text = explainEnvironmentError(new Error('dlopen(... code signature ... library load disallowed by system policy)'));
    assert.match(text, /macOS blocked the native TDLib addon/);
});

test('classifyProxyCheck demotes missing cold ready state to MAY_WORK when warm signal exists', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: true,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            successAttempts: 0,
            allLatencies: [],
            allErrors: ['READY_TIMEOUT'],
            failurePhase: 'wait_ready',
            coldRetestPassed: false
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.failurePhase, 'wait_ready');
});

test('classifyProxyCheck keeps partial cold confirmations in MAY_WORK even with no success attempts recorded', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            failurePhase: 'enable_proxy'
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            passedColdSessions: 1,
            successAttempts: 0,
            failAttempts: 1,
            allLatencies: [210],
            allErrors: ['TIMEOUT'],
            failurePhase: 'ping_proxy',
            coldRetestPassed: false
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.failurePhase, 'ping_proxy');
});

test('classifyProxyCheck rejects trusted status when cold retest is unstable', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: true,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            readyReached: true,
            sawConnectingToProxy: true,
            forcedReconnect: true,
            successAttempts: 1,
            failAttempts: 1,
            allLatencies: [180],
            allErrors: ['TIMEOUT'],
            failurePhase: 'ping_proxy',
            coldRetestPassed: false
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.notEqual(outcome.status, STATUS.WORKING);
});

test('classifyProxyCheck limits partial dc sweep to weak at most', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: false, error: 'PROTOCOL_MISMATCH' },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: true,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            readyReached: true,
            sawConnectingToProxy: true,
            forcedReconnect: true,
            successAttempts: 2,
            failAttempts: 0,
            allLatencies: [150, 155],
            allErrors: [],
            failurePhase: null,
            coldRetestPassed: true
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.notEqual(outcome.status, STATUS.WORKING);
});

test('classifyProxyCheck allows a single soft dc failure after full cold confirmation', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: false, error: 'TIMEOUT' }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            aggregateLatencyStable: true,
            successAttempts: 8,
            failAttempts: 0,
            allLatencies: [170, 171, 172, 173],
            allErrors: [],
            failurePhase: null
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
});

test('classifyProxyCheck allows warm-timeout rescue when strict cold retest fully passes', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: false,
            error: 'READY_TIMEOUT',
            failurePhase: 'wait_ready',
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            aggregateLatencyStable: true,
            successAttempts: 6,
            failAttempts: 0,
            allLatencies: [172, 173, 171, 174],
            allErrors: [],
            failurePhase: null
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
});

test('classifyProxyCheck restores fully confirmed IP proxies with wider aggregate latency spread', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            forcedReconnect: true,
            coldRetestPassed: true,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            aggregateLatencyStable: false,
            relaxedIpAggregateStable: true,
            successAttempts: 6,
            failAttempts: 0,
            allLatencies: [309, 228, 193, 332, 204, 206],
            allErrors: [],
            failurePhase: 'ping_proxy'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.95);
});

test('classifyProxyCheck promotes fully confirmed hostname proxies with slightly elevated but stable latency', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'clickproxy.online', proxyType: 'classic' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            requiredColdSessions: 4,
            passedColdSessions: 4,
            confirmedTrafficSessions: 4,
            confirmedTrafficAttempts: 8,
            successAttempts: 8,
            failAttempts: 0,
            aggregateLatencyStable: false,
            allLatencies: [332, 334, 342, 330, 336, 354, 342, 338],
            allErrors: [],
            failurePhase: 'ping_proxy'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.95);
    assert.equal(outcome.promoteReason, 'relaxed_confirmed_hostname');
});

test('classifyProxyCheck promotes fully confirmed hostname proxies with one aggregate latency outlier', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'tg.plusonevpn.com', proxyType: 'dd' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            requiredColdSessions: 4,
            passedColdSessions: 4,
            confirmedTrafficSessions: 4,
            confirmedTrafficAttempts: 8,
            successAttempts: 8,
            failAttempts: 0,
            aggregateLatencyStable: false,
            allLatencies: [379, 382, 558, 380, 384, 388, 383, 382],
            allErrors: [],
            failurePhase: 'ping_proxy'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.95);
    assert.equal(outcome.promoteReason, 'relaxed_confirmed_hostname');
});

test('classifyProxyCheck promotes hostname proxies with stable current-route confirmations', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'clickproxy.online', proxyType: 'classic' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            anySignal: true,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 1,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 3,
            successAttempts: 3,
            failAttempts: 1,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            allLatencies: [174, 181, 196],
            allErrors: ['TIMEOUT'],
            failurePhase: 'wait_ready'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.85);
    assert.equal(outcome.promoteReason, 'stable_current_route');
});

test('classifyProxyCheck keeps current-route hostname candidates in MAY_WORK when latency samples are missing', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'vavan.online', proxyType: 'dd' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            anySignal: true,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 1,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 3,
            successAttempts: 3,
            failAttempts: 1,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: false,
            allLatencies: [],
            allErrors: ['TIMEOUT'],
            failurePhase: 'wait_ready'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.promoteReason, null);
});

test('classifyProxyCheck keeps repeated READY_TIMEOUT hostnames in MAY_WORK without cold API confirmation', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'akenai.tg', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: false,
            error: 'READY_TIMEOUT',
            failurePhase: 'wait_ready',
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 0,
            confirmedTrafficSessions: 0,
            confirmedTrafficAttempts: 0,
            successAttempts: 1,
            failAttempts: 5,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: false,
            allLatencies: [181],
            allErrors: ['READY_TIMEOUT', 'TIMEOUT', 'READY_TIMEOUT'],
            failurePhase: 'wait_ready'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.promoteReason, null);
});

test('classifyProxyCheck caps volatile current-route hostname candidates at MAY_WORK', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'tg.caxero.ru', proxyType: 'classic' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 1,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 3,
            successAttempts: 3,
            failAttempts: 1,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            allLatencies: [178, 182, 604],
            allErrors: ['TIMEOUT'],
            failurePhase: 'wait_ready'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.volatilityCapped, true);
});

test('classifyProxyCheck promotes only pure ping-proxy route-confirmed hostname flaps', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'fast.love-internet.xyz', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 0,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 2,
            successAttempts: 2,
            failAttempts: 2,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            currentRouteReadyRatio: 0.85,
            currentRouteApiRatio: 0.85,
            allLatencies: [176, 184, 178],
            allErrors: ['TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy',
            debug: {
                sessions: [
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    },
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    }
                ]
            }
        },
        attempts: 1
    });

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.8);
    assert.equal(outcome.promoteReason, 'ping_proxy_route_confirmed');
    assert.equal(outcome.volatilityCapped, true);
    assert.equal(outcome.capReason, 'too_many_failures');
    assert.equal(outcome.routeFlapRecoverable, true);
    assert.equal(outcome.candidatePatternClass, 'ping_proxy_only_good_route');
    assert.equal(outcome.readyTimeoutSessions, 0);
    assert.equal(outcome.pingTimeoutOnlySessions, 2);
    assert.equal(outcome.dcSweepFailedSessions, 0);
    assert.equal(outcome.apiConfirmedButUnpassedSessions, 2);
    assert.equal(outcome.warmReadyTimeout, false);
});

test('classifyProxyCheck keeps mixed fast or nitro style route flaps in MAY_WORK', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'nitro.alotaxi.info', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 0,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 2,
            successAttempts: 2,
            failAttempts: 2,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            currentRouteReadyRatio: 1,
            currentRouteApiRatio: 1,
            allLatencies: [171, 176],
            allErrors: ['TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy',
            debug: {
                sessions: [
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    },
                    {
                        failurePhase: 'wait_ready',
                        allErrors: ['READY_TIMEOUT'],
                        networkOk: false,
                        readyReached: false,
                        forcedReconnect: true,
                        realTrafficOk: false,
                        apiProbePassed: false,
                        coldRetestPassed: false
                    }
                ]
            }
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.capReason, 'too_many_failures');
    assert.equal(outcome.routeFlapRecoverable, false);
    assert.equal(outcome.candidatePatternClass, 'mixed_failures');
    assert.equal(outcome.readyTimeoutSessions, 1);
});

test('classifyProxyCheck keeps pure ping-proxy route flaps in MAY_WORK below current-route threshold', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'fast.love-internet.xyz', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: false,
            requiredColdSessions: 4,
            passedColdSessions: 0,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 2,
            successAttempts: 2,
            failAttempts: 2,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            currentRouteReadyRatio: 0.8,
            currentRouteApiRatio: 0.8,
            allLatencies: [176, 182],
            allErrors: ['TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy',
            debug: {
                sessions: [
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    },
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    }
                ]
            }
        },
        attempts: 1
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.routeFlapRecoverable, false);
    assert.equal(outcome.candidatePatternClass, 'ping_proxy_only_good_route');
});

test('classifyProxyCheck blocks ping-proxy route-confirmed promote when ready timeouts exist', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'fast.love-internet.xyz', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 0,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 2,
            successAttempts: 2,
            failAttempts: 2,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            currentRouteReadyRatio: 0.85,
            currentRouteApiRatio: 0.85,
            allLatencies: [176, 184],
            allErrors: ['READY_TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy',
            debug: {
                sessions: [
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    },
                    {
                        failurePhase: 'wait_ready',
                        allErrors: ['READY_TIMEOUT'],
                        networkOk: false,
                        readyReached: false,
                        forcedReconnect: true,
                        realTrafficOk: false,
                        apiProbePassed: false,
                        coldRetestPassed: false
                    }
                ]
            }
        },
        attempts: 1
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.routeFlapRecoverable, false);
    assert.equal(outcome.readyTimeoutSessions, 1);
    assert.equal(outcome.candidatePatternClass, 'mixed_failures');
});

test('classifyProxyCheck blocks ping-proxy route-confirmed promote when dc sweep is unstable', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'nitro.alotaxi.info', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: false, error: 'TIMEOUT' },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 0,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 2,
            successAttempts: 2,
            failAttempts: 2,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            currentRouteReadyRatio: 0.85,
            currentRouteApiRatio: 0.85,
            allLatencies: [176, 182],
            allErrors: ['TIMEOUT', 'TIMEOUT'],
            failurePhase: 'dc_sweep',
            debug: {
                sessions: [
                    {
                        failurePhase: 'dc_sweep',
                        allErrors: ['TIMEOUT'],
                        networkOk: false,
                        readyReached: false,
                        forcedReconnect: false,
                        realTrafficOk: false,
                        apiProbePassed: false,
                        coldRetestPassed: false
                    },
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    }
                ]
            }
        },
        attempts: 1
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.routeFlapRecoverable, false);
    assert.equal(outcome.dcSweepFailedSessions, 1);
    assert.equal(outcome.candidatePatternClass, 'mixed_failures');
});

test('classifyProxyCheck blocks ping-proxy route-confirmed promote when latency exceeds narrow limits', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'fast.love-internet.xyz', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 0,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 2,
            successAttempts: 2,
            failAttempts: 2,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            currentRouteReadyRatio: 0.85,
            currentRouteApiRatio: 0.85,
            allLatencies: [176, 330],
            allErrors: ['TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy',
            debug: {
                sessions: [
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    },
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    }
                ]
            }
        },
        attempts: 1
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.routeFlapRecoverable, false);
    assert.equal(outcome.candidatePatternClass, 'ping_proxy_only_good_route');
});

test('classifyProxyCheck blocks ping-proxy route-confirmed promote when partial cold sessions already exist', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'fast.love-internet.xyz', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 1,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 2,
            successAttempts: 2,
            failAttempts: 2,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            currentRouteReadyRatio: 0.85,
            currentRouteApiRatio: 0.85,
            allLatencies: [176, 184],
            allErrors: ['TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy',
            debug: {
                sessions: [
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: true
                    },
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    }
                ]
            }
        },
        attempts: 1
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.routeFlapRecoverable, false);
    assert.equal(outcome.apiConfirmedButUnpassedSessions, 1);
});

function buildPurePingProxyPartialColdCase(overrides = {}) {
    const coldRetestOverrides = overrides.coldRetest || {};
    const candidateOverrides = overrides.candidate || {};
    const warmCheckOverrides = overrides.warmCheck || {};

    return {
        candidate: {
            server: 'nitro.alotaxi.info',
            proxyType: 'ee',
            ...candidateOverrides
        },
        dcSweep: overrides.dcSweep || [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            ...warmCheckOverrides
        },
        coldRetest: {
            ok: false,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 1,
            confirmedTrafficSessions: 3,
            confirmedTrafficAttempts: 2,
            successAttempts: 2,
            failAttempts: 3,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            currentRouteReadyRatio: 1,
            currentRouteApiRatio: 1,
            allLatencies: [171, 174],
            allErrors: ['TIMEOUT', 'TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy',
            debug: {
                sessions: [
                    {
                        failurePhase: null,
                        allErrors: [],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: true
                    },
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    },
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    },
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    }
                ]
            },
            ...coldRetestOverrides
        },
        attempts: overrides.attempts ?? 2
    };
}

test('classifyProxyCheck promotes pure ping-proxy partial-cold hostnames with valid latency', () => {
    const outcome = classifyProxyCheck(buildPurePingProxyPartialColdCase());

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.82);
    assert.equal(outcome.promoteReason, 'pure_ping_proxy_partial_cold');
    assert.equal(outcome.routeFlapRecoverable, true);
    assert.equal(outcome.candidatePatternClass, 'ping_proxy_only_good_route');
    assert.equal(outcome.hasValidLatencySample, true);
    assert.equal(outcome.latencySampleCount, 2);
    assert.equal(outcome.medianLatency, 174);
});

test('classifyProxyCheck keeps pure ping-proxy candidates without partial cold success out of new promote path', () => {
    const outcome = classifyProxyCheck(buildPurePingProxyPartialColdCase({
        coldRetest: {
            passedColdSessions: 0,
            debug: {
                sessions: [
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    },
                    {
                        failurePhase: 'ping_proxy',
                        allErrors: ['TIMEOUT'],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: false
                    }
                ]
            }
        }
    }));

    assert.notEqual(outcome.promoteReason, 'pure_ping_proxy_partial_cold');
});

test('classifyProxyCheck keeps fully confirmed pure ping-proxy cases on existing strong paths', () => {
    const outcome = classifyProxyCheck(buildPurePingProxyPartialColdCase({
        coldRetest: {
            coldRetestPassed: true,
            aggregateLatencyStable: true,
            passedColdSessions: 4,
            failAttempts: 0,
            allErrors: [],
            failurePhase: null,
            debug: {
                sessions: [
                    {
                        failurePhase: null,
                        allErrors: [],
                        networkOk: true,
                        readyReached: true,
                        forcedReconnect: true,
                        realTrafficOk: true,
                        apiProbePassed: true,
                        coldRetestPassed: true
                    }
                ]
            }
        }
    }));

    assert.equal(outcome.status, STATUS.WORKING);
    assert.notEqual(outcome.promoteReason, 'pure_ping_proxy_partial_cold');
});

test('classifyProxyCheck keeps pure ping-proxy candidates without valid latency in MAY_WORK', () => {
    const outcome = classifyProxyCheck(buildPurePingProxyPartialColdCase({
        coldRetest: {
            allLatencies: []
        }
    }));

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.hasValidLatencySample, false);
    assert.equal(outcome.latencySampleCount, 0);
    assert.notEqual(outcome.promoteReason, 'pure_ping_proxy_partial_cold');
});

test('classifyProxyCheck blocks pure ping-proxy partial-cold promote below perfect current-route ratios', () => {
    const outcome = classifyProxyCheck(buildPurePingProxyPartialColdCase({
        coldRetest: {
            currentRouteReadyRatio: 0.75,
            currentRouteApiRatio: 1
        }
    }));

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.notEqual(outcome.promoteReason, 'pure_ping_proxy_partial_cold');
});

test('classifyProxyCheck blocks pure ping-proxy partial-cold promote when latency exceeds limits', () => {
    const outcome = classifyProxyCheck(buildPurePingProxyPartialColdCase({
        coldRetest: {
            allLatencies: [171, 330]
        }
    }));

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.hasValidLatencySample, true);
    assert.notEqual(outcome.promoteReason, 'pure_ping_proxy_partial_cold');
});

test('classifyProxyCheck blocks pure ping-proxy partial-cold promote for dd proxies', () => {
    const outcome = classifyProxyCheck(buildPurePingProxyPartialColdCase({
        candidate: {
            server: '65.109.215.115',
            proxyType: 'dd'
        }
    }));

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.notEqual(outcome.promoteReason, 'pure_ping_proxy_partial_cold');
});

test('classifyProxyCheck keeps soft dc hostname candidates in MAY_WORK without cold traffic confirmation', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'tg.plusonevpn.com', proxyType: 'dd' },
        dcSweep: [
            { dcId: 2, ok: false, error: 'TIMEOUT' },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 0,
            confirmedTrafficSessions: 0,
            confirmedTrafficAttempts: 0,
            successAttempts: 0,
            failAttempts: 3,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: false,
            allLatencies: [],
            allErrors: ['READY_TIMEOUT', 'TIMEOUT'],
            failurePhase: 'dc_sweep'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.failurePhase, 'dc_sweep');
});

test('classifyProxyCheck promotes cold-confirmed IP proxies with one timeout outlier', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: '65.109.215.115', proxyType: 'dd' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            requiredColdSessions: 3,
            passedColdSessions: 3,
            successAttempts: 11,
            failAttempts: 1,
            allLatencies: [882, 255, 188, 716, 441, 194, 302, 255, 235, 243, 233],
            allErrors: ['TIMEOUT'],
            aggregateLatencyStable: false,
            relaxedIpAggregateStable: false,
            trimmedAggregateLatencyStable: false,
            failurePhase: 'ping_proxy'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.9);
    assert.notEqual(outcome.promoteReason, 'dd_partial_cold_route_confirmed');
});

test('classifyProxyCheck accepts one soft outlier session when hostname cold confirmation is otherwise clean', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            almostPassedColdSessions: true,
            passedColdSessions: 3,
            successAttempts: 8,
            failAttempts: 0,
            allLatencies: [245, 196, 283, 218, 224, 237, 846, 175],
            allErrors: [],
            failurePhase: 'ping_proxy'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.9);
});

test('classifyProxyCheck promotes recoverable IP proxies when cold success signals are strong enough', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            requiredColdSessions: 3,
            passedColdSessions: 1,
            successAttempts: 4,
            failAttempts: 4,
            allLatencies: [170, 170, 378, 174],
            allErrors: ['READY_TIMEOUT'],
            failurePhase: 'wait_ready'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.8);
});

test('classifyProxyCheck promotes almost-working IP proxies with one extreme outlier', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: true,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            requiredColdSessions: 3,
            passedColdSessions: 2,
            successAttempts: 8,
            failAttempts: 2,
            allLatencies: [171, 171, 191, 173, 382, 170, 171, 1434],
            allErrors: ['TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.85);
});

test('isWarmRescueEligible only accepts clean ready-timeout warm failures after full dc success', () => {
    assert.equal(
        isWarmRescueEligible(
            [{ ok: true }, { ok: true }, { ok: true }],
            { ok: false, error: 'READY_TIMEOUT', failurePhase: 'wait_ready', sawConnectingToProxy: false }
        ),
        true
    );
    assert.equal(
        isWarmRescueEligible(
            [{ ok: true }, { ok: false, error: 'TIMEOUT' }, { ok: true }],
            { ok: false, error: 'READY_TIMEOUT', failurePhase: 'wait_ready', sawConnectingToProxy: false }
        ),
        false
    );
    assert.equal(
        isWarmRescueEligible(
            [{ ok: true }, { ok: true }, { ok: true }],
            { ok: false, error: 'READY_TIMEOUT', failurePhase: 'wait_ready', sawConnectingToProxy: true }
        ),
        false
    );
});

test('classifyProxyCheck allows near-trusted soft partial proxies with one missed cold session', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: false, error: 'TIMEOUT' },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            almostPassedColdSessions: true,
            nearTrusted: true,
            passedColdSessions: 1,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            successAttempts: 7,
            failAttempts: 1,
            allLatencies: [168, 168, 174, 173, 156, 168, 168],
            allErrors: ['TIMEOUT'],
            failurePhase: 'ping_proxy'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
});

test('classifyProxyCheck fails fast on dns errors', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: false, error: 'DNS_ERROR' },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: true,
            forcedReconnect: true
        },
        coldRetest: null,
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.FAIL);
    assert.equal(outcome.failurePhase, 'dc_sweep');
});

test('summarizeColdRetests requires two successful cold sessions for trusted', () => {
    const summary = summarizeColdRetests([
        {
            ok: true,
            networkOk: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            successAttempts: 2,
            failAttempts: 0,
            allLatencies: [150, 160],
            allErrors: [],
            failurePhase: null
        },
        {
            ok: true,
            networkOk: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            successAttempts: 1,
            failAttempts: 1,
            allLatencies: [190],
            allErrors: ['TIMEOUT'],
            failurePhase: 'ping_proxy'
        }
    ], 2, 2);

    assert.equal(summary.coldRetestPassed, false);
    assert.equal(summary.successfulSessions, 1);
    assert.equal(summary.failurePhase, 'ping_proxy');
});

test('summarizeColdRetests marks nearTrusted for one timeout with low jitter', () => {
    const summary = summarizeColdRetests([
        {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            successAttempts: 2,
            failAttempts: 0,
            allLatencies: [170, 174],
            allErrors: [],
            failurePhase: null
        },
        {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            successAttempts: 1,
            failAttempts: 1,
            allLatencies: [168],
            allErrors: ['TIMEOUT'],
            failurePhase: 'ping_proxy'
        }
    ], 2, 2);

    assert.equal(summary.nearTrusted, true);
});

test('summarizeColdRetests tracks confirmed real-traffic sessions separately from strict passes', () => {
    const summary = summarizeColdRetests([
        {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            successAttempts: 2,
            failAttempts: 0,
            allLatencies: [170, 174],
            allErrors: [],
            failurePhase: null
        },
        {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            successAttempts: 1,
            failAttempts: 1,
            allLatencies: [168],
            allErrors: ['TIMEOUT'],
            failurePhase: 'ping_proxy'
        },
        {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            coldRetestPassed: false,
            successAttempts: 0,
            failAttempts: 2,
            allLatencies: [],
            allErrors: ['READY_TIMEOUT'],
            failurePhase: 'wait_ready'
        }
    ], 2, 4);

    assert.equal(summary.confirmedTrafficSessions, 2);
    assert.equal(summary.confirmedTrafficAttempts, 3);
    assert.equal(summary.coldRetestPassed, false);
});

test('summarizeColdRetests keeps counting traffic-confirmed sessions even without ping successes', () => {
    const summary = summarizeColdRetests([
        {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            successAttempts: 0,
            failAttempts: 2,
            allLatencies: [],
            allErrors: ['TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy'
        },
        {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            successAttempts: 0,
            failAttempts: 2,
            allLatencies: [],
            allErrors: ['TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy'
        }
    ], 2, 2);

    assert.equal(summary.confirmedTrafficSessions, 2);
    assert.equal(summary.confirmedTrafficAttempts, 0);
});

test('resolveColdRetestDisposition locks only when outcome is mathematically fixed', () => {
    assert.deepEqual(
        resolveColdRetestDisposition({
            successfulSessions: 3,
            completedSessions: 3,
            scheduledSessions: 4,
            requiredSessions: 3,
            maxSessions: 6
        }),
        { locked: true, passed: true }
    );

    assert.deepEqual(
        resolveColdRetestDisposition({
            successfulSessions: 1,
            completedSessions: 3,
            scheduledSessions: 4,
            requiredSessions: 4,
            maxSessions: 4
        }),
        { locked: true, passed: false }
    );

    assert.deepEqual(
        resolveColdRetestDisposition({
            successfulSessions: 1,
            completedSessions: 2,
            scheduledSessions: 3,
            requiredSessions: 3,
            maxSessions: 6
        }),
        { locked: false, passed: false }
    );
});

test('ColdRetestScheduler caps concurrent cold sessions at two workers', async () => {
    let active = 0;
    let maxActive = 0;
    const scheduler = new ColdRetestScheduler({
        concurrency: 2,
        sessionRunner: async (_candidate, context) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await sleep(20);
            active -= 1;
            return {
                ok: true,
                networkOk: true,
                realTrafficOk: true,
                apiProbePassed: true,
                apiProbeChecks: [],
                coldRetestPassed: true,
                readyReached: true,
                sawConnectingToProxy: false,
                forcedReconnect: true,
                successAttempts: 2,
                failAttempts: 0,
                pingLatencyMs: 170,
                allLatencies: [170, 171],
                allErrors: [],
                failurePhase: null,
                session: context.pass
            };
        }
    });

    try {
        await Promise.all([1, 2, 3, 4].map(pass => scheduler.schedule(
            { server: 'host.test', port: 443 },
            { pass, attempts: 2, timeoutSeconds: 6, verbose: false }
        )));
    } finally {
        await scheduler.close();
    }

    assert.equal(maxActive, 2);
});

test('ColdRetestScheduler.close resolves when queued sessions are still pending', async () => {
    const scheduler = new ColdRetestScheduler({
        concurrency: 1,
        sessionRunner: async (_candidate, context) => {
            await sleep(30);
            return {
                ok: true,
                networkOk: true,
                realTrafficOk: true,
                apiProbePassed: true,
                apiProbeChecks: [],
                coldRetestPassed: true,
                readyReached: true,
                sawConnectingToProxy: false,
                forcedReconnect: true,
                successAttempts: 1,
                failAttempts: 0,
                pingLatencyMs: 170,
                allLatencies: [170],
                allErrors: [],
                failurePhase: null,
                session: context.pass
            };
        }
    });

    const first = scheduler.schedule(
        { server: 'host.test', port: 443 },
        { pass: 1, attempts: 1, timeoutSeconds: 6, verbose: false }
    );
    const second = scheduler.schedule(
        { server: 'host.test', port: 443 },
        { pass: 2, attempts: 1, timeoutSeconds: 6, verbose: false }
    );
    const trackedSecond = second.catch(error => error);

    await assert.doesNotReject(
        Promise.race([
            scheduler.close(),
            sleep(200).then(() => {
                throw new Error('close_timeout');
            })
        ])
    );

    const firstResult = await first;
    const secondError = await trackedSecond;
    assert.equal(firstResult.coldRetestPassed, true);
    assert.match(String(secondError && secondError.message), /closed/i);
});

test('computePreparedProbePriority prefers stronger current-run signals', () => {
    const strong = computePreparedProbePriority({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: true,
            forcedReconnect: true,
            realTrafficOk: true,
            apiProbePassed: true
        }
    });
    const weak = computePreparedProbePriority({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: false, error: 'TIMEOUT' },
            { dcId: 5, ok: false, error: 'NETWORK_ERROR' }
        ],
        warmCheck: {
            ok: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            realTrafficOk: false,
            apiProbePassed: false
        }
    });

    assert.ok(strong > weak);
});

test('AdaptiveScanCoordinator interleaves groups and deprioritizes terminal-failure cohorts', () => {
    const coordinator = new AdaptiveScanCoordinator([
        { server: '10.0.0.1', port: 443, proxyType: 'dd', inputIndex: 0 },
        { server: '10.0.0.2', port: 443, proxyType: 'dd', inputIndex: 1 },
        { server: 'group-b.example', port: 443, proxyType: 'ee', inputIndex: 2 },
        { server: 'group-b.example', port: 8443, proxyType: 'ee', inputIndex: 3 }
    ]);

    const first = coordinator.next();
    const second = coordinator.next();
    assert.notEqual(first.server, second.server);

    coordinator.recordResult(first, {
        status: STATUS.FAIL,
        failurePhase: 'dc_sweep',
        allErrors: ['DC2:PROTOCOL_MISMATCH']
    });

    const third = coordinator.next();
    assert.equal(third.server, 'group-b.example');
});

test('PreparedProbeQueue applies priority ordering and backpressure', async () => {
    const queue = new PreparedProbeQueue({ maxSize: 1 });
    const enqueueOrder = [];

    await queue.enqueue({ id: 'low', priority: 1 });
    const blocked = queue.enqueue({ id: 'high', priority: 10 }).then(() => {
        enqueueOrder.push('high-enqueued');
    });

    await sleep(20);
    assert.deepEqual(enqueueOrder, []);

    const first = await queue.dequeue();
    assert.equal(first.id, 'low');
    await blocked;

    const second = await queue.dequeue();
    assert.equal(second.id, 'high');
});

test('runProxyCheckPool completes strict-cold candidates and records phase stats', async () => {
    const items = [
        { server: '10.0.0.1', port: 443, proxyType: 'dd', inputIndex: 0 },
        { server: 'stable.example', port: 443, proxyType: 'ee', inputIndex: 1 }
    ];
    const workers = [
        {
            id: 'w1',
            prepareProxyCheck: async proxy => ({
                candidate: proxy,
                dcSweep: [
                    { dcId: 2, ok: true },
                    { dcId: 4, ok: true },
                    { dcId: 5, ok: true }
                ],
                warmCheck: {
                    ok: proxy.server === 'stable.example',
                    readyReached: proxy.server === 'stable.example',
                    sawConnectingToProxy: proxy.server === 'stable.example',
                    forcedReconnect: true
                },
                shouldRunStrictRetest: true,
                finalTimeoutSeconds: 6,
                requiredColdSessions: 3,
                maxColdSessions: 3,
                warmCheckSkipped: false,
                skipReason: null,
                dcSuccessCount: 3,
                phaseTimings: {
                    dcSweepMs: 10,
                    warmCheckMs: 20,
                    coldQueueWaitMs: 0,
                    coldExecutionMs: 0
                },
                workerId: 'w1'
            })
        }
    ];

    const results = await runProxyCheckPool(items, workers, {
        attempts: 2,
        verbose: true,
        timeout: 4
    }, {
        showProgress: false,
        runColdRetestsFn: async proxy => ({
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            apiProbeChecks: [],
            coldRetestPassed: proxy.server === 'stable.example',
            readyReached: true,
            sawConnectingToProxy: true,
            forcedReconnect: true,
            successAttempts: proxy.server === 'stable.example' ? 3 : 1,
            failAttempts: proxy.server === 'stable.example' ? 0 : 1,
            pingLatencyMs: 170,
            allLatencies: proxy.server === 'stable.example' ? [170, 171, 172] : [170],
            allErrors: proxy.server === 'stable.example' ? [] : ['TIMEOUT'],
            failurePhase: proxy.server === 'stable.example' ? null : 'ping_proxy',
            requiredColdSessions: 3,
            passedColdSessions: proxy.server === 'stable.example' ? 3 : 0,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            aggregateLatencyStable: proxy.server === 'stable.example',
            relaxedIpAggregateStable: proxy.server === 'stable.example',
            trimmedAggregateLatencyStable: proxy.server === 'stable.example',
            debug: {
                timings: {
                    queueWaitMs: 5,
                    executionMs: 15
                }
            }
        })
    });

    assert.equal(results.length, 2);
    assert.equal(results[1].status, STATUS.WORKING);
    assert.equal(results.meta.phaseStats.preparedCount, 2);
    assert.equal(results.meta.phaseStats.coldQueuedCount, 2);
    assert.equal(results.meta.phaseStats.timings.coldQueueWait.median, 5);
});

test('runProxyCheckPool rejects promptly when no workers are available', async () => {
    await assert.rejects(
        Promise.race([
            runProxyCheckPool(
                [{ server: 'x.example', port: 443, secretHex: 'dd1', proxyType: 'dd', inputIndex: 0 }],
                [],
                {
                    attempts: 1,
                    verbose: false,
                    timeout: 4
                },
                { showProgress: false }
            ),
            sleep(100).then(() => {
                throw new Error('runProxyCheckPool zero-worker timeout');
            })
        ]),
        error => error.message === 'runProxyCheckPool requires at least one worker'
    );
});

test('runProxyCheckPool stops emitting live progress once cancellation was requested', async () => {
    const writes = [];
    const cancelState = { cancelled: false, listeners: new Set() };
    const restoreStdout = forceRawAnsiStdout();
    const originalWrite = process.stdout.write;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const intervalCallbacks = [];
    const gate = {};
    gate.promise = new Promise(resolve => {
        gate.resolve = resolve;
    });

    process.stdout.write = chunk => {
        writes.push(String(chunk));
        return true;
    };

    try {
        global.setInterval = callback => {
            intervalCallbacks.push(callback);
            return callback;
        };
        global.clearInterval = () => {};

        const runPromise = runProxyCheckPool(
            [{ server: 'late.example', port: 443, secretHex: 'dd1', proxyType: 'dd', inputIndex: 0 }],
            [{
                id: 'w1',
                prepareProxyCheck: async proxy => {
                    await gate.promise;
                    return {
                        candidate: proxy,
                        dcSweep: [
                            { dcId: 2, ok: true },
                            { dcId: 4, ok: true },
                            { dcId: 5, ok: true }
                        ],
                        warmCheck: {
                            ok: true,
                            networkOk: true,
                            realTrafficOk: true,
                            apiProbePassed: true,
                            apiProbeChecks: [],
                            readyReached: true,
                            sawConnectingToProxy: false,
                            forcedReconnect: true
                        },
                        shouldRunStrictRetest: false,
                        finalTimeoutSeconds: 6,
                        requiredColdSessions: 3,
                        maxColdSessions: 3,
                        warmCheckSkipped: false,
                        skipReason: null,
                        dcSuccessCount: 3,
                        phaseTimings: {
                            dcSweepMs: 10,
                            warmCheckMs: 20,
                            coldQueueWaitMs: 0,
                            coldExecutionMs: 0
                        },
                        workerId: 'w1'
                    };
                }
            }],
            {
                attempts: 1,
                verbose: false,
                timeout: 4
            },
            { cancelState }
        );

        assert.equal(intervalCallbacks.length, 1);
        const writesBeforeCancel = writes.length;
        cancelState.cancelled = true;
        intervalCallbacks[0]();
        gate.resolve();

        await assert.rejects(
            runPromise,
            error => error.message === STATUS.CANCELLED
        );

        const cleanupOutput = writes.slice(writesBeforeCancel).join('');
        assert.match(cleanupOutput, /\x1b\[\d+F\x1b\[J\x1b\[\?25h/);
    } finally {
        process.stdout.write = originalWrite;
        restoreStdout();
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
    }
});

test('runProxyCheckPool unwinds blocked prepared producers when cancellation is requested', async () => {
    const cancelState = createCancelState();
    const items = Array.from({ length: 6 }, (_, index) => ({
        server: `queued-${index}.example`,
        port: 443,
        secretHex: `dd${index}`,
        proxyType: 'dd',
        inputIndex: index
    }));
    const workers = Array.from({ length: 3 }, (_, index) => ({
        id: `w${index + 1}`,
        prepareProxyCheck: async proxy => ({
            candidate: proxy,
            dcSweep: [
                { dcId: 2, ok: true },
                { dcId: 4, ok: true },
                { dcId: 5, ok: true }
            ],
            warmCheck: {
                ok: true,
                networkOk: true,
                realTrafficOk: true,
                apiProbePassed: true,
                apiProbeChecks: [],
                readyReached: true,
                sawConnectingToProxy: true,
                forcedReconnect: true
            },
            shouldRunStrictRetest: true,
            finalTimeoutSeconds: 6,
            requiredColdSessions: 3,
            maxColdSessions: 3,
            warmCheckSkipped: false,
            skipReason: null,
            dcSuccessCount: 3,
            phaseTimings: {
                dcSweepMs: 1,
                warmCheckMs: 1,
                coldQueueWaitMs: 0,
                coldExecutionMs: 0
            },
            workerId: `w${index + 1}`
        })
    }));

    const runPromise = runProxyCheckPool(items, workers, {
        attempts: 1,
        verbose: false,
        timeout: 4
    }, {
        cancelState,
        maxPreparedQueueSize: 1,
        showProgress: false,
        runColdRetestsFn: async () => {
            requestCancel(cancelState);
            await sleep(20);
            throw new Error('cancelled cold retest should not decide the final result');
        }
    });

    await assert.rejects(
        Promise.race([
            runPromise,
            sleep(500).then(() => {
                throw new Error('runProxyCheckPool cancellation timeout');
            })
        ]),
        error => error.message === STATUS.CANCELLED
    );
});

test('resolveColdSchedulerConcurrency scales with scan workers but stays within safe bounds', () => {
    assert.equal(resolveColdSchedulerConcurrency(0), 2);
    assert.equal(resolveColdSchedulerConcurrency(1), 2);
    assert.equal(resolveColdSchedulerConcurrency(2), 2);
    assert.equal(resolveColdSchedulerConcurrency(4), 4);
    assert.equal(resolveColdSchedulerConcurrency(6), 6);
    assert.equal(resolveColdSchedulerConcurrency(12), 12);
    assert.equal(resolveColdSchedulerConcurrency(20), 20);
    assert.equal(resolveColdSchedulerConcurrency(40), 32);
});

test('summarizeDcSweepOutcome and resolveWarmCheckSkip detect hard dead dc sweep patterns', () => {
    const dnsSweep = [
        { dcId: 2, ok: false, error: 'DNS_ERROR' },
        { dcId: 4, ok: false, error: 'DNS_ERROR' },
        { dcId: 5, ok: false, error: 'DNS_ERROR' }
    ];
    const terminalSweep = [
        { dcId: 2, ok: false, error: 'PROTOCOL_MISMATCH' },
        { dcId: 4, ok: false, error: 'INVALID_SECRET' },
        { dcId: 5, ok: false, error: 'Response hash mismatch' }
    ];
    const mixedSuccessSweep = [
        { dcId: 2, ok: true },
        { dcId: 4, ok: false, error: 'TIMEOUT' },
        { dcId: 5, ok: false, error: 'NETWORK_ERROR' }
    ];

    assert.deepEqual(summarizeDcSweepOutcome(dnsSweep), {
        successCount: 0,
        failureCount: 3,
        allFailed: true,
        allDnsFailures: true,
        allTerminalFailures: true
    });
    assert.deepEqual(resolveWarmCheckSkip(dnsSweep), {
        skip: true,
        skipReason: 'all_dns_failed',
        dcSuccessCount: 0
    });
    assert.deepEqual(resolveWarmCheckSkip(terminalSweep), {
        skip: true,
        skipReason: 'all_terminal_dc_failures',
        dcSuccessCount: 0
    });
    assert.deepEqual(resolveWarmCheckSkip(mixedSuccessSweep), {
        skip: false,
        skipReason: null,
        dcSuccessCount: 1
    });
});

test('prepareProxyCheck skips warm check after hard dead dc sweep', async () => {
    const worker = new Worker(1);
    worker.alive = true;
    worker.client = {};
    let warmCheckCalls = 0;
    worker.runDcSweep = async () => ([
        { dcId: 2, ok: false, error: 'DNS_ERROR' },
        { dcId: 4, ok: false, error: 'DNS_ERROR' },
        { dcId: 5, ok: false, error: 'DNS_ERROR' }
    ]);
    worker.exerciseEnabledProxy = async () => {
        warmCheckCalls += 1;
        return { ok: true };
    };

    const prepared = await worker.prepareProxyCheck(
        { server: 'dead.example', port: 443, proxyType: 'ee' },
        4,
        2,
        false
    );

    assert.equal(warmCheckCalls, 0);
    assert.equal(prepared.warmCheckSkipped, true);
    assert.equal(prepared.skipReason, 'all_dns_failed');
    assert.equal(prepared.dcSuccessCount, 0);
    assert.equal(prepared.warmCheck.skipped, true);
    assert.equal(prepared.phaseTimings.warmCheckMs, 0);
    assert.equal(prepared.shouldRunStrictRetest, false);
});

test('prepareProxyCheck keeps warm check when dc sweep has a successful dc', async () => {
    const worker = new Worker(2);
    worker.alive = true;
    worker.client = {};
    let warmCheckCalls = 0;
    worker.runDcSweep = async () => ([
        { dcId: 2, ok: true },
        { dcId: 4, ok: false, error: 'TIMEOUT' },
        { dcId: 5, ok: false, error: 'NETWORK_ERROR' }
    ]);
    worker.exerciseEnabledProxy = async () => {
        warmCheckCalls += 1;
        return {
            ok: false,
            error: 'READY_TIMEOUT',
            failurePhase: 'wait_ready',
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: true
        };
    };

    const prepared = await worker.prepareProxyCheck(
        { server: 'mixed.example', port: 443, proxyType: 'ee' },
        4,
        2,
        false
    );

    assert.equal(warmCheckCalls, 1);
    assert.equal(prepared.warmCheckSkipped, false);
    assert.equal(prepared.skipReason, null);
    assert.equal(prepared.dcSuccessCount, 1);
    assert.equal(prepared.warmCheck.skipped, undefined);
});

test('runScheduledColdRetests handles out-of-order success completion and stops scheduling after success lock', async () => {
    const scheduled = [];
    const deferredBySession = new Map();
    const stableDnsLookup = async () => [{ address: '1.1.1.1' }];

    const makeSession = (pass, passed) => ({
        ok: true,
        networkOk: true,
        realTrafficOk: true,
        apiProbePassed: true,
        apiProbeChecks: [],
        coldRetestPassed: passed,
        readyReached: true,
        sawConnectingToProxy: false,
        forcedReconnect: true,
        successAttempts: passed ? 2 : 1,
        failAttempts: passed ? 0 : 1,
        pingLatencyMs: 170,
        allLatencies: passed ? [170, 172] : [170],
        allErrors: passed ? [] : ['TIMEOUT'],
        failurePhase: passed ? null : 'ping_proxy',
        session: pass,
        queueWaitMs: 5,
        executionMs: 10
    });

    const runPromise = runScheduledColdRetests(
        { server: 'hostname.example', port: 443, proxyType: 'ee' },
        {
            attempts: 2,
            finalTimeoutSeconds: 6,
            requiredColdSessions: 3,
            maxColdSessions: 6,
            dnsLookupFn: stableDnsLookup,
            scheduleColdSession: pass => {
                scheduled.push(pass);
                return new Promise(resolve => {
                    deferredBySession.set(pass, resolve);
                });
            }
        }
    );

    await sleep(0);
    assert.deepEqual(scheduled, [1, 2]);

    deferredBySession.get(2)(makeSession(2, true));
    await sleep(0);
    assert.deepEqual(scheduled, [1, 2, 3]);

    deferredBySession.get(3)(makeSession(3, true));
    await sleep(0);
    assert.deepEqual(scheduled, [1, 2, 3, 4]);

    deferredBySession.get(1)(makeSession(1, true));
    const summary = await runPromise;
    deferredBySession.get(4)(makeSession(4, true));
    await sleep(0);

    assert.equal(summary.coldRetestPassed, true);
    assert.equal(summary.successfulSessions, 3);
    assert.deepEqual(scheduled, [1, 2, 3, 4]);
});

test('runScheduledColdRetests stops scheduling once failure is guaranteed', async () => {
    const scheduled = [];
    const deferredBySession = new Map();
    const stableDnsLookup = async () => [{ address: '1.1.1.1' }];

    const makeFailure = pass => ({
        ok: true,
        networkOk: true,
        realTrafficOk: true,
        apiProbePassed: true,
        apiProbeChecks: [],
        coldRetestPassed: false,
        readyReached: true,
        sawConnectingToProxy: false,
        forcedReconnect: true,
        successAttempts: 1,
        failAttempts: 1,
        pingLatencyMs: 170,
        allLatencies: [170],
        allErrors: ['TIMEOUT'],
        failurePhase: 'ping_proxy',
        session: pass,
        queueWaitMs: 5,
        executionMs: 10
    });

    const runPromise = runScheduledColdRetests(
        { server: 'hostname.example', port: 443, proxyType: 'ee' },
        {
            attempts: 2,
            finalTimeoutSeconds: 6,
            requiredColdSessions: 3,
            maxColdSessions: 4,
            dnsLookupFn: stableDnsLookup,
            scheduleColdSession: pass => {
                scheduled.push(pass);
                return new Promise(resolve => {
                    deferredBySession.set(pass, resolve);
                });
            }
        }
    );

    await sleep(0);
    assert.deepEqual(scheduled, [1, 2]);

    deferredBySession.get(1)(makeFailure(1));
    await sleep(0);
    assert.deepEqual(scheduled, [1, 2, 3]);

    deferredBySession.get(2)(makeFailure(2));
    const summary = await runPromise;
    deferredBySession.get(3)(makeFailure(3));
    await sleep(0);

    assert.equal(summary.coldRetestPassed, false);
    assert.deepEqual(scheduled, [1, 2, 3]);
});

test('runScheduledColdRetests marks DNS stability false when lookup hangs past timeout', async () => {
    const summary = await runScheduledColdRetests(
        { server: 'hanging.example', port: 443, proxyType: 'ee' },
        {
            attempts: 2,
            finalTimeoutSeconds: 6,
            requiredColdSessions: 3,
            maxColdSessions: 3,
            dnsLookupTimeoutMs: 20,
            dnsLookupFn: async () => new Promise(() => {}),
            scheduleColdSession: async pass => ({
                ok: true,
                networkOk: true,
                realTrafficOk: true,
                apiProbePassed: true,
                apiProbeChecks: [],
                coldRetestPassed: true,
                readyReached: true,
                sawConnectingToProxy: false,
                forcedReconnect: true,
                successAttempts: 2,
                failAttempts: 0,
                pingLatencyMs: 170,
                allLatencies: [170],
                allErrors: [],
                failurePhase: null,
                session: pass,
                queueWaitMs: 1,
                executionMs: 1
            })
        }
    );

    assert.equal(summary.coldRetestPassed, true);
    assert.equal(summary.dnsStabilityPassed, false);
    assert.equal(summary.dnsSamples[0].error, 'TIMEOUT');
});

test('runScheduledColdRetests cancels while DNS lookup is hanging', async () => {
    const cancelState = { cancelled: false, listeners: new Set() };
    setTimeout(() => {
        cancelState.cancelled = true;
        for (const listener of cancelState.listeners) {
            listener();
        }
    }, 20);

    await assert.rejects(
        runScheduledColdRetests(
            { server: 'hanging.example', port: 443, proxyType: 'ee' },
            {
                attempts: 2,
                finalTimeoutSeconds: 6,
                requiredColdSessions: 3,
                maxColdSessions: 3,
                dnsLookupTimeoutMs: 1000,
                dnsLookupFn: async () => new Promise(() => {}),
                cancelState,
                scheduleColdSession: async pass => ({
                    ok: true,
                    networkOk: true,
                    realTrafficOk: true,
                    apiProbePassed: true,
                    apiProbeChecks: [],
                    coldRetestPassed: true,
                    readyReached: true,
                    sawConnectingToProxy: false,
                    forcedReconnect: true,
                    successAttempts: 2,
                    failAttempts: 0,
                    pingLatencyMs: 170,
                    allLatencies: [170],
                    allErrors: [],
                    failurePhase: null,
                    session: pass,
                    queueWaitMs: 1,
                    executionMs: 1
                })
            }
        ),
        error => error.message === STATUS.CANCELLED
    );
});

test('getFinalTimeoutSeconds softens final timeout relative to screening timeout', () => {
    assert.equal(getFinalTimeoutSeconds(4), 6);
    assert.equal(getFinalTimeoutSeconds(8), 10);
});

test('hostname proxies require more cold confirmations than IP proxies', () => {
    assert.equal(isIpAddress('84.201.181.143'), true);
    assert.equal(isIpAddress('ru36.importmsk.ru'), false);
    assert.equal(getRequiredColdConfirmations({ server: '84.201.181.143' }), 3);
    assert.equal(getRequiredColdConfirmations({ server: 'ru36.importmsk.ru' }), 4);
    assert.equal(getMaxColdConfirmationSessions({ server: '84.201.181.143' }), 6);
    assert.equal(getMaxColdConfirmationSessions({ server: 'ru36.importmsk.ru' }), 6);
});

test('classifyProxyCheck keeps incomplete real-traffic confirmation in MAY_WORK', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: false,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            successAttempts: 4,
            failAttempts: 0,
            allLatencies: [170, 171, 172, 173],
            allErrors: [],
            failurePhase: null
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
});

test('classifyProxyCheck promotes partial dc sweep candidates with warm transition signal to MAY_WORK', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: false, error: 'TIMEOUT' },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: false,
            readyReached: false,
            sawConnectingToProxy: true,
            forcedReconnect: false,
            failurePhase: 'enable_proxy'
        },
        coldRetest: null,
        attempts: 1
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.failurePhase, 'dc_sweep');
});

test('classifyProxyCheck promotes warm-ready candidates to MAY_WORK when cold retest is unavailable', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: false,
            readyReached: true,
            sawConnectingToProxy: true,
            forcedReconnect: true,
            failurePhase: 'wait_ready'
        },
        coldRetest: null,
        attempts: 1
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.failurePhase, 'wait_ready');
});

test('classifyProxyCheck keeps zero-signal candidates in FAIL', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            failurePhase: 'enable_proxy'
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            coldRetestPassed: false,
            successAttempts: 0,
            failAttempts: 1,
            allLatencies: [],
            allErrors: ['TIMEOUT'],
            failurePhase: 'ping_proxy'
        },
        attempts: 1
    });

    assert.equal(outcome.status, STATUS.FAIL);
    assert.equal(outcome.failurePhase, 'ping_proxy');
});

test('classifyProxyCheck demotes dns-unstable strong candidates to weak', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            dnsStabilityPassed: false,
            dnsStrongEligible: true,
            aggregateLatencyStable: true,
            successAttempts: 8,
            failAttempts: 0,
            allLatencies: [170, 171, 172, 173],
            allErrors: [],
            failurePhase: null
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.failurePhase, 'dns_stability');
});

test('classifyProxyCheck keeps multi-subnet hostname candidates out of working', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            dnsStabilityPassed: true,
            dnsStrongEligible: false,
            aggregateLatencyStable: true,
            successAttempts: 8,
            failAttempts: 0,
            allLatencies: [193, 194, 195, 196],
            allErrors: [],
            failurePhase: null
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
});

test('classifyProxyCheck keeps dd hostname candidates with multi-address dns out of working', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'tg.hellohiro.ru', proxyType: 'dd' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: false,
            aggregateLatencyStable: true,
            successAttempts: 8,
            failAttempts: 0,
            allLatencies: [180, 177, 200, 229, 233, 201, 176, 185],
            allErrors: [],
            failurePhase: null
        },
        attempts: 2
    });

    assert.notEqual(outcome.status, STATUS.WORKING);
});

test('classifyProxyCheck promotes hostname proxies with repeated confirmed traffic even when pingProxy stays flaky', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'akenai.tg', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            confirmedTrafficSessions: 4,
            confirmedTrafficAttempts: 0,
            passedColdSessions: 0,
            successAttempts: 0,
            failAttempts: 8,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: false,
            allLatencies: [],
            allErrors: ['TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.8);
});

test('classifyProxyCheck keeps flaky hostname current-path candidates in MAY_WORK', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'vavan.online', proxyType: 'dd' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 2,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 3,
            successAttempts: 3,
            failAttempts: 5,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            allLatencies: [167, 166, 172],
            allErrors: ['READY_TIMEOUT', 'TIMEOUT'],
            failurePhase: 'wait_ready'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.volatilityCapped, true);
});

test('classifyProxyCheck keeps IP current-path candidates below WORKING without IP-specific confirmation', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: '65.109.16.139', proxyType: 'dd' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 0,
            confirmedTrafficSessions: 4,
            confirmedTrafficAttempts: 4,
            successAttempts: 4,
            failAttempts: 0,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            allLatencies: [163, 165, 182, 192],
            allErrors: [],
            failurePhase: null
        },
        attempts: 1
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
});

function classifyDdPartialColdRoute(overrides = {}) {
    const coldRetest = {
        ok: false,
        networkOk: true,
        realTrafficOk: true,
        apiProbePassed: true,
        readyReached: true,
        sawConnectingToProxy: false,
        forcedReconnect: true,
        coldRetestPassed: false,
        dnsStabilityPassed: true,
        dnsStrongEligible: true,
        requiredColdSessions: 3,
        passedColdSessions: 1,
        confirmedTrafficSessions: 4,
        confirmedTrafficAttempts: 4,
        currentRouteReadyRatio: 0.8,
        currentRouteApiRatio: 0.8,
        successAttempts: 8,
        failAttempts: 3,
        aggregateLatencyStable: false,
        relaxedIpAggregateStable: false,
        trimmedAggregateLatencyStable: false,
        allLatencies: [234, 232, 234, 236, 235, 1066, 566, 240],
        allErrors: ['READY_TIMEOUT', 'TIMEOUT', 'TIMEOUT'],
        failurePhase: 'ping_proxy',
        debug: {
            sessions: [
                {
                    networkOk: false,
                    readyReached: false,
                    forcedReconnect: false,
                    realTrafficOk: false,
                    apiProbePassed: false,
                    coldRetestPassed: false,
                    failurePhase: 'wait_ready',
                    allErrors: ['READY_TIMEOUT']
                },
                {
                    networkOk: true,
                    readyReached: true,
                    forcedReconnect: true,
                    realTrafficOk: true,
                    apiProbePassed: true,
                    coldRetestPassed: true,
                    failurePhase: null,
                    allErrors: []
                },
                {
                    networkOk: true,
                    readyReached: true,
                    forcedReconnect: true,
                    realTrafficOk: true,
                    apiProbePassed: true,
                    coldRetestPassed: false,
                    failurePhase: 'ping_proxy',
                    allErrors: ['TIMEOUT']
                },
                {
                    networkOk: true,
                    readyReached: true,
                    forcedReconnect: true,
                    realTrafficOk: true,
                    apiProbePassed: true,
                    coldRetestPassed: false,
                    failurePhase: 'ping_proxy',
                    allErrors: ['TIMEOUT']
                },
                {
                    networkOk: true,
                    readyReached: true,
                    forcedReconnect: true,
                    realTrafficOk: true,
                    apiProbePassed: true,
                    coldRetestPassed: false,
                    failurePhase: 'ping_proxy',
                    allErrors: ['TIMEOUT']
                }
            ]
        },
        ...(overrides.coldRetest || {})
    };

    return classifyProxyCheck({
        candidate: {
            server: '65.109.215.115',
            proxyType: 'dd',
            ...(overrides.candidate || {})
        },
        dcSweep: overrides.dcSweep || [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: overrides.warmCheck || {
            ok: false,
            error: 'READY_TIMEOUT',
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false
        },
        coldRetest,
        attempts: overrides.attempts ?? 2
    });
}

test('classifyProxyCheck promotes DD partial-cold route-confirmed candidates with bounded latency spikes', () => {
    const outcome = classifyDdPartialColdRoute();

    assert.equal(outcome.status, STATUS.WORKING);
    assert.equal(outcome.confidence, 0.78);
    assert.equal(outcome.promoteReason, 'dd_partial_cold_route_confirmed');
    assert.equal(outcome.routeFlapRecoverable, true);
    assert.equal(outcome.ddPartialColdRouteRecoverable, true);
    assert.equal(outcome.ddPartialColdRouteBlockReason, null);
});

test('classifyProxyCheck keeps DD partial-cold candidates in MAY_WORK without passed cold sessions', () => {
    const outcome = classifyDdPartialColdRoute({
        coldRetest: {
            passedColdSessions: 0,
            debug: {
                sessions: []
            }
        }
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.promoteReason, null);
    assert.equal(outcome.ddPartialColdRouteRecoverable, false);
    assert.equal(outcome.ddPartialColdRouteBlockReason, 'no_partial_cold_confirmation');
});

test('classifyProxyCheck keeps DD partial-cold candidates in MAY_WORK without current-route API proof', () => {
    const outcome = classifyDdPartialColdRoute({
        coldRetest: {
            currentRouteReadyRatio: 0,
            currentRouteApiRatio: 0
        }
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.ddPartialColdRouteRecoverable, false);
    assert.equal(outcome.ddPartialColdRouteBlockReason, 'weak_current_route');
});

test('classifyProxyCheck keeps wait-ready DD candidates without checker latency samples in MAY_WORK', () => {
    const outcome = classifyDdPartialColdRoute({
        candidate: { server: '65.109.16.139', proxyType: 'dd' },
        warmCheck: {
            ok: false,
            error: 'READY_TIMEOUT',
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            anySignal: true,
            readyReached: false,
            forcedReconnect: false,
            passedColdSessions: 0,
            confirmedTrafficSessions: 0,
            confirmedTrafficAttempts: 0,
            currentRouteReadyRatio: 0,
            currentRouteApiRatio: 0,
            successAttempts: 0,
            failAttempts: 4,
            allLatencies: [],
            allErrors: ['READY_TIMEOUT', 'READY_TIMEOUT', 'READY_TIMEOUT', 'READY_TIMEOUT'],
            failurePhase: 'wait_ready',
            debug: {
                sessions: [
                    { failurePhase: 'wait_ready', allErrors: ['READY_TIMEOUT'] },
                    { failurePhase: 'wait_ready', allErrors: ['READY_TIMEOUT'] },
                    { failurePhase: 'wait_ready', allErrors: ['READY_TIMEOUT'] },
                    { failurePhase: 'wait_ready', allErrors: ['READY_TIMEOUT'] }
                ]
            }
        }
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.ddPartialColdRouteRecoverable, false);
});

test('classifyProxyCheck keeps dc-sweep DD candidates below WORKING', () => {
    const outcome = classifyDdPartialColdRoute({
        candidate: { server: 'vavan.online', proxyType: 'dd' },
        dcSweep: [
            { dcId: 2, ok: false, error: 'TIMEOUT' },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        coldRetest: {
            failurePhase: 'dc_sweep',
            debug: {
                sessions: [
                    { failurePhase: 'dc_sweep', allErrors: ['TIMEOUT'] }
                ]
            }
        }
    });

    assert.notEqual(outcome.status, STATUS.WORKING);
    assert.equal(outcome.ddPartialColdRouteRecoverable, false);
    assert.equal(outcome.ddPartialColdRouteBlockReason, 'dc_sweep_unstable');
});

test('classifyProxyCheck keeps DD partial-cold candidates in MAY_WORK on non-timeout errors', () => {
    const outcome = classifyDdPartialColdRoute({
        coldRetest: {
            allErrors: ['TIMEOUT', 'AUTH_KEY_UNREGISTERED']
        }
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.ddPartialColdRouteRecoverable, false);
    assert.equal(outcome.ddPartialColdRouteBlockReason, 'non_timeout_error');
});

test('classifyProxyCheck keeps DD partial-cold candidates in MAY_WORK with repeated ready timeouts', () => {
    const outcome = classifyDdPartialColdRoute({
        coldRetest: {
            debug: {
                sessions: [
                    { failurePhase: 'wait_ready', allErrors: ['READY_TIMEOUT'] },
                    { failurePhase: 'wait_ready', allErrors: ['READY_TIMEOUT'] }
                ]
            }
        }
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
    assert.equal(outcome.ddPartialColdRouteRecoverable, false);
    assert.equal(outcome.ddPartialColdRouteBlockReason, 'ready_timeout_dominant');
});

test('classifyProxyCheck keeps DD partial-cold candidates in MAY_WORK when latency is outside safe bounds', () => {
    const rawSpike = classifyDdPartialColdRoute({
        coldRetest: {
            allLatencies: [234, 232, 234, 236, 235, 1201, 566, 240]
        }
    });
    const trimmedSpike = classifyDdPartialColdRoute({
        coldRetest: {
            allLatencies: [234, 232, 234, 236, 235, 1066, 651, 240]
        }
    });
    const highMedian = classifyDdPartialColdRoute({
        coldRetest: {
            allLatencies: [281, 282, 283, 284, 285, 286, 287, 288]
        }
    });

    assert.equal(rawSpike.status, STATUS.MAY_WORK);
    assert.equal(rawSpike.ddPartialColdRouteBlockReason, 'raw_latency_spike');
    assert.equal(trimmedSpike.status, STATUS.MAY_WORK);
    assert.equal(trimmedSpike.ddPartialColdRouteBlockReason, 'trimmed_latency_spike');
    assert.equal(highMedian.status, STATUS.MAY_WORK);
    assert.equal(highMedian.ddPartialColdRouteBlockReason, 'high_median_latency');
});

test('classifyProxyCheck keeps multi-address current-path hostname candidates in MAY_WORK', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'fast.love-internet.xyz', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: false,
            requiredColdSessions: 4,
            passedColdSessions: 2,
            confirmedTrafficSessions: 5,
            confirmedTrafficAttempts: 7,
            successAttempts: 7,
            failAttempts: 3,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            allLatencies: [167, 173, 166, 189, 215, 285, 168],
            allErrors: ['TIMEOUT', 'TIMEOUT', 'TIMEOUT'],
            failurePhase: 'ping_proxy'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
});

test('classifyProxyCheck keeps soft dc hostname candidates in MAY_WORK without stable route proof', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'alo.acharbashi.info', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: false, error: 'TIMEOUT' },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 1,
            confirmedTrafficSessions: 4,
            confirmedTrafficAttempts: 5,
            successAttempts: 5,
            failAttempts: 3,
            aggregateLatencyStable: true,
            trimmedAggregateLatencyStable: true,
            allLatencies: [167, 167, 172, 170, 166],
            allErrors: ['TIMEOUT', 'TIMEOUT', 'TIMEOUT'],
            failurePhase: 'dc_sweep'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
});

test('classifyProxyCheck keeps soft dc multi-address hostname candidates in MAY_WORK', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'nitro.alotaxi.info', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: false, error: 'TIMEOUT' }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: false,
            requiredColdSessions: 4,
            passedColdSessions: 2,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 4,
            successAttempts: 4,
            failAttempts: 6,
            aggregateLatencyStable: true,
            trimmedAggregateLatencyStable: true,
            allLatencies: [172, 171, 167, 168],
            allErrors: ['TIMEOUT', 'READY_TIMEOUT', 'READY_TIMEOUT', 'READY_TIMEOUT'],
            failurePhase: 'dc_sweep'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
});

test('classifyProxyCheck keeps hostname current-path candidates weak when dns strong gate fails', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'utkapay.life', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            coldRetestPassed: true,
            dnsStabilityPassed: true,
            dnsStrongEligible: false,
            dnsSingleAddressOnly: true,
            requiredColdSessions: 4,
            passedColdSessions: 4,
            confirmedTrafficSessions: 4,
            confirmedTrafficAttempts: 8,
            successAttempts: 8,
            failAttempts: 0,
            aggregateLatencyStable: false,
            trimmedAggregateLatencyStable: true,
            allLatencies: [174, 173, 187, 168, 182, 175, 182, 172],
            allErrors: [],
            failurePhase: 'ping_proxy'
        },
        attempts: 2
    });

    assert.notEqual(outcome.status, STATUS.WORKING);
});

test('classifyProxyCheck keeps multi-address hostname proxies with partial cold success in MAY_WORK', () => {
    const outcome = classifyProxyCheck({
        candidate: { server: 'dedicated.love-internet.xyz', proxyType: 'ee' },
        dcSweep: [
            { dcId: 2, ok: true },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: false,
            networkOk: false,
            realTrafficOk: false,
            apiProbePassed: false,
            readyReached: false,
            sawConnectingToProxy: false,
            forcedReconnect: false,
            coldRetestPassed: false,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            dnsSingleAddressOnly: false,
            requiredColdSessions: 4,
            passedColdSessions: 1,
            confirmedTrafficSessions: 2,
            confirmedTrafficAttempts: 3,
            successAttempts: 3,
            failAttempts: 5,
            aggregateLatencyStable: true,
            trimmedAggregateLatencyStable: true,
            allLatencies: [167, 166, 172],
            allErrors: ['READY_TIMEOUT', 'TIMEOUT', 'READY_TIMEOUT'],
            failurePhase: 'wait_ready'
        },
        attempts: 2
    });

    assert.equal(outcome.status, STATUS.MAY_WORK);
});

test('classifyProxyCheck keeps high-jitter partial proxies out of working', () => {
    const outcome = classifyProxyCheck({
        dcSweep: [
            { dcId: 2, ok: false, error: 'TIMEOUT' },
            { dcId: 4, ok: true },
            { dcId: 5, ok: true }
        ],
        warmCheck: {
            ok: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true
        },
        coldRetest: {
            ok: true,
            networkOk: true,
            realTrafficOk: true,
            apiProbePassed: true,
            readyReached: true,
            sawConnectingToProxy: false,
            forcedReconnect: true,
            coldRetestPassed: true,
            dnsStabilityPassed: true,
            dnsStrongEligible: true,
            aggregateLatencyStable: false,
            successAttempts: 8,
            failAttempts: 0,
            allLatencies: [175, 179, 274, 293, 304, 305, 565, 799],
            allErrors: [],
            failurePhase: null
        },
        attempts: 2
    });

    assert.notEqual(outcome.status, STATUS.WORKING);
});

test('compareMayWorkCandidates ranks traffic-confirmed candidates above dc-sweep-only candidates', () => {
    const trafficConfirmed = {
        server: 'akenai.tg',
        port: 853,
        status: STATUS.MAY_WORK,
        failurePhase: 'ping_proxy',
        warmOk: true,
        warmReadyReached: true,
        networkOk: true,
        readyReached: true,
        realTrafficOk: true,
        apiProbePassed: true,
        successAttempts: 2,
        failAttempts: 2,
        passedColdSessions: 0,
        pingLatencyMs: 178,
        allLatencies: [178, 174],
        dnsStabilityPassed: true,
        dnsStrongEligible: true
    };
    const dcSweepOnly = {
        server: '89.117.63.176',
        port: 443,
        status: STATUS.FAIL,
        failurePhase: 'dc_sweep',
        successAttempts: 0,
        failAttempts: 2,
        passedColdSessions: 0,
        pingLatencyMs: null,
        allLatencies: [],
        allErrors: ['DC2:TIMEOUT', 'DC4:TIMEOUT', 'DC5:TIMEOUT'],
        dnsStabilityPassed: false,
        dnsStrongEligible: false
    };

    assert.equal([dcSweepOnly, trafficConfirmed].sort(compareMayWorkCandidates)[0], trafficConfirmed);
});

test('checkDnsStability flags changing hostname answers as unstable', async () => {
    let call = 0;
    const result = await checkDnsStability(
        'example.com',
        3,
        async () => {
            call += 1;
            if (call === 1) {
                return [{ address: '1.1.1.1' }];
            }
            if (call === 2) {
                return [{ address: '1.1.1.2' }];
            }
            return [{ address: '1.1.1.2' }];
        }
    );

    assert.equal(result.ok, false);
    assert.equal(result.samples.length, 3);
});

test('checkDnsStability keeps stable multi-address hostnames out of strong gate', async () => {
    const result = await checkDnsStability(
        'example.com',
        3,
        async () => [
            { address: '1.1.1.1' },
            { address: '1.1.2.2' }
        ]
    );

    assert.equal(result.ok, true);
    assert.equal(result.strongEligible, false);
});

test('checkDnsStability skips IP literals', async () => {
    const result = await checkDnsStability('84.201.181.143', 3, async () => {
        throw new Error('should not resolve ip literals');
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.samples, []);
});

test('isSoftDcFailure accepts only one timeout-like dc failure', () => {
    assert.equal(isSoftDcFailure([{ ok: true }, { ok: true }, { ok: false, error: 'TIMEOUT' }]), true);
    assert.equal(isSoftDcFailure([{ ok: true }, { ok: false, error: 'PROTOCOL_MISMATCH' }, { ok: true }]), false);
    assert.equal(isSoftDcFailure([{ ok: false, error: 'TIMEOUT' }, { ok: false, error: 'NETWORK_ERROR' }]), false);
});

test('waitForConnectionState ignores stale states before reconnect marker', async () => {
    const worker = new Worker('test');
    worker.client = new EventEmitter();
    worker.connectionStateHistory = [
        { at: 1, state: 'connectionStateReady' }
    ];

    await assert.rejects(
        worker.waitForConnectionState(['connectionStateReady'], 20, 1),
        /Connection state timeout/
    );
});

test('Worker.init removes authorization listener on timeout and late updates stay harmless', async () => {
    const originalCreateClient = tdl.createClient;
    const fakeClient = new EventEmitter();
    let offCalls = 0;
    fakeClient.close = async () => {};
    fakeClient.off = function off(eventName, listener) {
        offCalls += 1;
        return EventEmitter.prototype.off.call(this, eventName, listener);
    };
    tdl.createClient = () => fakeClient;

    const worker = new Worker('timeout-cleanup');
    try {
        await assert.rejects(worker.init(0.01), /Init timeout/);
        worker.client = null;
        fakeClient.emit('update', {
            _: 'updateAuthorizationState',
            authorization_state: { _: 'authorizationStateReady' }
        });
        assert.ok(offCalls >= 1);
    } finally {
        tdl.createClient = originalCreateClient;
        await worker.close();
    }
});
