const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_APP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tgproxy-menu-home-'));
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

const projectPaths = require('../src/config/project_paths');
const {
    DEFAULT_CONFIG,
    buildArgv,
    buildProxyListChoiceModel,
    formatDurationMinutesSeconds,
    handleRefreshGitHubSources,
    loadConfig,
    menuLine,
    promptBoolean,
    promptConfirm,
    readLastResults,
    runFindProxies,
    saveConfig,
    settingsLine,
    validateProxyListFile
} = require('../src/cli/terminal_menu');
const {
    normalizeUserFilePath
} = require('../src/cli/menu_file_helpers');
const {
    GITHUB_PROXY_SOURCES,
    SOURCE_ID_ALL
} = require('../src/sources/github_source_updater');
const { setActiveUiLanguage } = require('../src/i18n');
const terminalPrompt = require('../src/terminal/terminal_prompt');
const ui = require('../src/terminal/ui');

const PROXY_A = 'tg://proxy?server=alpha.example.com&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc';
const PROXY_B = 'tg://proxy?server=beta.example.com&port=443&secret=dd104462821249bd7ac519130220c25d09';

async function withTempProject(fn) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-menu-test-'));
    const previousCwd = process.cwd();

    try {
        process.chdir(tempDir);
        projectPaths.ensureDataDirectories();
        return await fn(tempDir);
    } finally {
        process.chdir(previousCwd);
        setActiveUiLanguage('en');
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function withTerminalColumns(columns, fn) {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', {
        configurable: true,
        enumerable: descriptor ? descriptor.enumerable : true,
        writable: true,
        value: columns
    });

    try {
        return fn();
    } finally {
        if (descriptor) {
            Object.defineProperty(process.stdout, 'columns', descriptor);
        } else {
            delete process.stdout.columns;
        }
    }
}

function writeProxyFile(relativePath, content = `${PROXY_A}\n${PROXY_B}\n`) {
    const targetPath = projectPaths.resolveProjectFilePath(relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
    return targetPath;
}

test('buildArgv renders checker arguments from sanitized menu config', () => {
    const argv = buildArgv({
        ...DEFAULT_CONFIG,
        inputFile: '100proxies.txt',
        concurrency: 12,
        timeout: 5,
        attempts: 3,
        batchSize: 100
    });

    assert.deepEqual(argv, [
        'node',
        'telegram_proxy_pinger.js',
        '--file',
        '100proxies.txt',
        '--concurrency',
        '12',
        '--timeout',
        '5',
        '--attempts',
        '3',
        '--bootstrap-timeout',
        '12',
        '--batch-size',
        '100'
    ]);
});

test('buildArgv clamps unsafe values before launching checker', () => {
    const argv = buildArgv({
        ...DEFAULT_CONFIG,
        inputFile: '',
        concurrency: 999,
        timeout: 999,
        attempts: 99,
        batchSize: 999999
    });

    assert.deepEqual(argv, [
        'node',
        'telegram_proxy_pinger.js',
        '--file',
        'proxies.txt',
        '--concurrency',
        '128',
        '--timeout',
        '10',
        '--attempts',
        '5',
        '--bootstrap-timeout',
        '12',
        '--batch-size',
        '5000'
    ]);
});

test('loadConfig and saveConfig keep only current runtime menu settings', () => withTempProject(() => {
    saveConfig({
        ...DEFAULT_CONFIG,
        inputFile: 'data/runtime/github_source_all.txt',
        selectedSourceId: SOURCE_ID_ALL,
        uiLanguage: 'ru',
        concurrency: 16,
        timeout: 5,
        attempts: 3,
        batchSize: 10,
        obsoleteField: true
    });

    const persisted = JSON.parse(fs.readFileSync(projectPaths.getConfigPath(), 'utf8'));
    assert.equal(persisted.inputFile, 'data/runtime/github_source_all.txt');
    assert.equal(persisted.selectedSourceId, SOURCE_ID_ALL);
    assert.equal(persisted.uiLanguage, 'ru');
    assert.equal(Object.hasOwn(persisted, 'obsoleteField'), false);

    const loaded = loadConfig();
    assert.equal(loaded.inputFile, 'data/runtime/github_source_all.txt');
    assert.equal(loaded.concurrency, 16);
    assert.equal(loaded.timeout, 5);
    assert.equal(loaded.attempts, 3);
    assert.equal(loaded.batchSize, 10);
}));

test('validateProxyListFile accepts readable MTProto files and rejects unusable files', () => withTempProject(() => {
    writeProxyFile('proxies.txt', `${PROXY_A}\nnot a proxy\n${PROXY_A}\n`);

    const valid = validateProxyListFile('proxies.txt');
    assert.equal(valid.ok, true);
    assert.equal(valid.stats.totalLines, 3);
    assert.equal(valid.stats.supported, 2);
    assert.equal(valid.stats.invalid, 1);
    assert.equal(valid.stats.duplicatesRemoved, 1);
    assert.equal(valid.stats.uniqueSupported, 1);

    assert.equal(validateProxyListFile('missing.txt').ok, false);
    assert.equal(validateProxyListFile('notes.md').ok, false);
    writeProxyFile('empty.txt', '');
    assert.equal(validateProxyListFile('empty.txt').ok, false);
}));

test('normalizeUserFilePath supports quoted relative paths and tilde expansion', () => withTempProject(() => {
    const quoted = normalizeUserFilePath('"data/runtime/proxies.txt"');
    assert.equal(quoted.ok, true);
    assert.equal(quoted.storedPath, path.join('data', 'runtime', 'proxies.txt'));

    const home = normalizeUserFilePath('~/custom_proxies.txt');
    assert.equal(home.ok, true);
    assert.equal(home.resolvedPath, path.join(os.homedir(), 'custom_proxies.txt'));
}));

test('buildProxyListChoiceModel shows current file and hides service files', () => withTempProject(() => {
    writeProxyFile('manual.txt');
    writeProxyFile('data/runtime/github_source_all.txt');
    writeProxyFile('data/runtime/working_proxies.txt');

    const model = buildProxyListChoiceModel([
        'manual.txt',
        'data/runtime/github_source_all.txt',
        'data/runtime/working_proxies.txt'
    ], 'manual.txt');

    assert.equal(model.currentExists, true);
    assert.equal(model.current.title, 'Manual');
    assert.equal(model.current.detail, 'manual.txt');
    assert.equal(model.hiddenCount, 0);
    assert.ok(model.sections.some(section => section.kind === 'system'));
    assert.ok(model.sections.some(section => section.kind === 'user'));
}));

test('menu and settings lines stay within compact terminal widths', () => {
    withTerminalColumns(48, () => {
        const menuRows = menuLine(1, 'Refresh Proxy List', 'Fetch a fresh MTProto proxy list');
        const settingsRows = settingsLine(2, 'Wait time', '5', 'Wait longer = fewer misses', 44);

        for (const line of [...menuRows, ...settingsRows]) {
            assert.ok(ui.visibleLength(line) <= 44);
        }
    });
});

test('duration formatter renders compact minutes and seconds', () => {
    assert.equal(formatDurationMinutesSeconds('1336s'), '22min 16s');
    assert.equal(formatDurationMinutesSeconds('n/a'), 'n/a');
});

test('handleRefreshGitHubSources persists successful refresh result', async () => {
    await withTempProject(async () => {
        const rendered = [];
        const config = { ...DEFAULT_CONFIG };

        await handleRefreshGitHubSources(config, {
            renderFn: (title, subtitle, lines, options) => {
                rendered.push({ title, subtitle, lines, options });
            },
            pauseFn: () => {},
            refreshRunner: async () => ({
                ok: true,
                partial: false,
                relativeOutputPath: 'data/runtime/github_source_all.txt',
                sourceId: SOURCE_ID_ALL,
                sourceName: 'All GitHub sources',
                stats: { uniqueSupported: 2 },
                crossSourceDuplicatesRemoved: 1,
                sources: GITHUB_PROXY_SOURCES.map(source => ({
                    name: source.name,
                    ok: true,
                    stats: { uniqueSupported: 1, duplicatesRemoved: 0 }
                }))
            })
        });

        const saved = loadConfig();
        assert.equal(saved.inputFile, 'data/runtime/github_source_all.txt');
        assert.equal(saved.selectedSourceId, SOURCE_ID_ALL);
        assert.equal(rendered.at(-1).title, 'Refresh Complete');
    });
});

test('runFindProxies validates input, launches checker, and renders latest results', async () => {
    await withTempProject(async () => {
        writeProxyFile('proxies.txt');
        fs.writeFileSync(projectPaths.getWorkingResultsPath(), `# Working MTProto proxies (1)\n${PROXY_A}\n`, 'utf8');

        let launchedArgv = null;
        let resultTitle = null;
        const pauseMessages = [];

        await runFindProxies(
            { ...DEFAULT_CONFIG, inputFile: 'proxies.txt' },
            {
                pauseFn: message => {
                    pauseMessages.push(message);
                },
                clearFn: () => {},
                checkerRunner: async argv => {
                    launchedArgv = argv;
                },
                renderResultsFn: (_result, options) => {
                    resultTitle = options.title;
                }
            }
        );

        assert.ok(launchedArgv.includes('--file'));
        assert.ok(launchedArgv.includes('proxies.txt'));
        assert.equal(resultTitle, 'Check Complete');
        assert.equal(pauseMessages[0], 'Press Enter to start checking...');
        assert.equal(pauseMessages.length, 2);
    });
});

test('runFindProxies shows a validation error before launching checker', async () => {
    let launched = false;
    let renderedTitle = null;

    await runFindProxies(
        { ...DEFAULT_CONFIG, inputFile: 'missing.txt' },
        {
            validateFn: () => ({ ok: false, error: 'bad list' }),
            renderFn: title => {
                renderedTitle = title;
            },
            pauseFn: () => {},
            checkerRunner: async () => {
                launched = true;
            }
        }
    );

    assert.equal(launched, false);
    assert.equal(renderedTitle, 'Cannot Start Check');
});

test('readLastResults returns parsed latest output when present', () => withTempProject(() => {
    fs.writeFileSync(
        projectPaths.getWorkingResultsPath(),
        `# Working MTProto proxies (1)\n${PROXY_A}\n# May Work (check in Telegram) MTProto proxies (1)\n${PROXY_B}\n`,
        'utf8'
    );

    const result = readLastResults();
    assert.equal(result.ok, true);
    assert.deepEqual(result.proxies, [PROXY_A, PROXY_B]);
    assert.deepEqual(result.workingProxies, [PROXY_A]);
    assert.deepEqual(result.mayWorkProxies, [PROXY_B]);
}));

test('promptBoolean and promptConfirm accept ascii yes/no shortcuts', () => {
    const originalQuestion = terminalPrompt.question;

    try {
        terminalPrompt.question = () => 'y';
        assert.equal(promptBoolean('Question', false), true);

        terminalPrompt.question = () => 'n';
        assert.equal(promptBoolean('Question', true), false);

        terminalPrompt.question = () => 'y';
        assert.equal(promptConfirm('Question'), true);

        terminalPrompt.question = () => 'n';
        assert.equal(promptConfirm('Question'), false);
    } finally {
        terminalPrompt.question = originalQuestion;
    }
});
