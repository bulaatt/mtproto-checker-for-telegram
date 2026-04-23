const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readlineSync = require('readline-sync');

const TEST_APP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tgproxy-i18n-home-'));
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

const ui = require('../src/terminal/ui');
const projectPaths = require('../src/config/project_paths');
const {
    ensureUiLanguageSelected,
    loadStoredUiLanguage,
    t,
    setActiveUiLanguage
} = require('../src/i18n');
const {
    formatSavedTotalTime,
    parseSavedResultsText,
    saveResults
} = require('../src/checker/output_persistence');

const PROXY_A = 'tg://proxy?server=alpha.example.com&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc';
const PROXY_B = 'tg://proxy?server=beta.example.com&port=443&secret=dd104462821249bd7ac519130220c25d09';

test('ensureUiLanguageSelected prompts once and persists the chosen language', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-i18n-test-'));
    const previousCwd = process.cwd();
    const originalQuestion = readlineSync.question;
    const originalClear = ui.clearScreen;
    const originalLog = console.log;
    const originalWrite = process.stdout.write;

    try {
        process.chdir(tempDir);
        readlineSync.question = () => '2';
        ui.clearScreen = () => {};
        console.log = () => {};
        process.stdout.write = () => true;

        const first = ensureUiLanguageSelected({ interactive: true });
        assert.equal(first.language, 'ru');
        assert.equal(first.prompted, true);
        assert.equal(loadStoredUiLanguage(), 'ru');

        readlineSync.question = () => {
            throw new Error('language prompt should not repeat after persistence');
        };

        const second = ensureUiLanguageSelected({ interactive: true });
        assert.equal(second.language, 'ru');
        assert.equal(second.prompted, false);
    } finally {
        process.chdir(previousCwd);
        readlineSync.question = originalQuestion;
        ui.clearScreen = originalClear;
        console.log = originalLog;
        process.stdout.write = originalWrite;
        setActiveUiLanguage('en');
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('saveResults writes localized headers without meta lines and parseSavedResultsText reads them back', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-i18n-results-'));
    const previousCwd = process.cwd();

    try {
        process.chdir(tempDir);
        projectPaths.ensureDataDirectories();
        setActiveUiLanguage('ru');

        saveResults(
            [{ originalUrl: PROXY_A, canonicalUrl: PROXY_A }],
            [{ originalUrl: PROXY_B, canonicalUrl: PROXY_B }],
            { totalTimeSeconds: 12.3, uiLanguage: 'ru' }
        );

        const raw = fs.readFileSync(projectPaths.getWorkingResultsPath(), 'utf8');
        assert.match(raw, /# Рабочие MTProto-прокси \(1\)/);
        assert.match(raw, /# MTProto-прокси, которые могут работать \(проверьте в Telegram\) \(1\)/);
        assert.match(raw, /# Общее время сканирования: 0мин 12с/);
        assert.doesNotMatch(raw, /# meta /);

        const parsed = parseSavedResultsText(raw);
        assert.deepEqual(parsed.workingProxies, [PROXY_A]);
        assert.deepEqual(parsed.mayWorkProxies, [PROXY_B]);
        assert.equal(parsed.totalTime, '12s');
    } finally {
        process.chdir(previousCwd);
        setActiveUiLanguage('en');
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('formatSavedTotalTime uses localized compact minutes and seconds', () => {
    assert.equal(formatSavedTotalTime(1336.4, 'ru'), '22мин 16с');
    assert.equal(formatSavedTotalTime(1336.4, 'en'), '22min 16s');
});

test('parseSavedResultsText reads both numeric and compact total scan time formats', () => {
    const numericRu = parseSavedResultsText('# Общее время сканирования: 1336.4 с\n');
    const compactRu = parseSavedResultsText('# Общее время сканирования: 22мин 16с\n');
    const compactEn = parseSavedResultsText('# Total scan time: 22min 16s\n');

    assert.equal(numericRu.totalTime, '1336.4s');
    assert.equal(compactRu.totalTime, '1336s');
    assert.equal(compactEn.totalTime, '1336s');
});

test('localized values after colons use lowercase wording in both languages', () => {
    setActiveUiLanguage('en');
    assert.equal(t('common.source', { value: t('common.allSources') }), 'Source: all sources');
    assert.equal(t('common.status', { value: t('proxyList.readyToUse') }), 'Status: ready to use');
    assert.equal(t('common.workingProxiesFound', { count: 1 }), 'Working proxy found: 1');

    setActiveUiLanguage('ru');
    assert.equal(t('common.source', { value: t('common.allSources') }), 'Источник: все источники');
    assert.equal(t('common.status', { value: t('proxyList.readyToUse') }), 'Статус: готов к использованию');
    assert.equal(t('common.workingProxiesFound', { count: 1 }), 'Найден рабочий прокси: 1');

    setActiveUiLanguage('en');
});

test('boolean prompt suffixes use ascii y/n in both languages', () => {
    setActiveUiLanguage('en');
    assert.equal(t('prompts.confirmSuffixYes'), 'y');
    assert.equal(t('prompts.confirmSuffixNo'), 'n');

    setActiveUiLanguage('ru');
    assert.equal(t('prompts.confirmSuffixYes'), 'y');
    assert.equal(t('prompts.confirmSuffixNo'), 'n');

    setActiveUiLanguage('en');
});

test('preflight start prompt is localized for both languages', () => {
    setActiveUiLanguage('en');
    assert.equal(t('run.pressEnterToStart'), 'Press Enter to start checking...');

    setActiveUiLanguage('ru');
    assert.equal(t('run.pressEnterToStart'), 'Нажмите Enter, чтобы начать проверку...');

    setActiveUiLanguage('en');
});

test('language choice descriptions stay localized in each catalog', () => {
    setActiveUiLanguage('en');
    assert.equal(t('prompts.languageDescriptionEnglish'), 'Use the program in English');
    assert.equal(t('prompts.languageDescriptionRussian'), 'Use the program in Russian');

    setActiveUiLanguage('ru');
    assert.equal(t('prompts.languageDescriptionEnglish'), 'Использовать программу на английском');
    assert.equal(t('prompts.languageDescriptionRussian'), 'Использовать программу на русском');

    setActiveUiLanguage('en');
});

test('i18n module does not export unused translator helpers', () => {
    const i18n = require('../src/i18n');

    assert.equal(typeof i18n.createTranslator, 'undefined');
    assert.equal(typeof i18n.resolveUiLanguage, 'undefined');
});
