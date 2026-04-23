const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const packageJson = require('../package.json');

function walkFiles(rootDir, relativeDir = '') {
    const currentDir = path.join(rootDir, relativeDir);
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (entry.name === 'node_modules') continue;

        const entryRelativePath = path.join(relativeDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkFiles(rootDir, entryRelativePath));
            continue;
        }

        files.push(entryRelativePath);
    }

    return files;
}

test('src checker index exists and preserves the root checker facade', () => {
    const rootFacade = require('../telegram_proxy_pinger');
    const srcChecker = require('../src/checker');

    assert.equal(rootFacade.main, srcChecker.main);
    assert.equal(rootFacade.runCli, srcChecker.runCli);
});

test('src menu module exists and preserves the root menu exports', () => {
    const rootMenu = require('../proxy_terminal_menu');
    const srcMenu = require('../src/menu/terminal_menu');
    const cliMenu = require('../src/cli/terminal_menu');

    assert.equal(rootMenu.buildArgv, srcMenu.buildArgv);
    assert.equal(rootMenu.buildArgv, cliMenu.buildArgv);
    assert.equal(rootMenu.chooseInputFile, srcMenu.chooseInputFile);
    assert.equal(rootMenu.runFindProxies, srcMenu.runFindProxies);
});

test('shared modules are sourced directly from src entrypoints', () => {
    const rootUi = require('../ui');
    const srcUi = require('../src/shared/ui');
    const terminalUi = require('../src/terminal/ui');
    const srcProjectPaths = require('../src/shared/project_paths');
    const configProjectPaths = require('../src/config/project_paths');
    const srcProxyInput = require('../src/shared/proxy_input');
    const proxyInput = require('../src/proxy/input');
    const srcChecker = require('../src/checker');

    assert.equal(rootUi.renderBox, srcUi.renderBox);
    assert.equal(rootUi.renderBox, terminalUi.renderBox);
    assert.equal(typeof srcProjectPaths.getRuntimeDataDir, 'function');
    assert.equal(srcProjectPaths.getRuntimeDataDir, configProjectPaths.getRuntimeDataDir);
    assert.equal(typeof srcProxyInput.parseProxyUrl, 'function');
    assert.equal(srcProxyInput.parseProxyUrl, proxyInput.parseProxyUrl);
    assert.equal(typeof srcProjectPaths.getLegacyRootFilePath, 'undefined');
    assert.equal(typeof srcProjectPaths.resolveRuntimeFilePath, 'undefined');
    assert.equal(typeof srcProjectPaths.getCheckerCandidatesPath, 'undefined');
    assert.equal(typeof srcProjectPaths.CHECKER_CANDIDATES_FILENAME, 'undefined');
    assert.equal(typeof srcChecker.CONTROL_PROXIES_FILE, 'undefined');
});

test('B-lite source layout keeps compatibility shims thin', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const expectedDirs = [
        'src/checker',
        'src/cli',
        'src/config',
        'src/i18n',
        'src/proxy',
        'src/sources',
        'src/terminal'
    ];

    for (const dirPath of expectedDirs) {
        assert.equal(fs.existsSync(path.join(projectRoot, dirPath)), true);
    }

    const shimFiles = [
        'src/menu/terminal_menu.js',
        'src/shared/ui.js',
        'src/shared/terminal_prompt.js',
        'src/shared/terminal_session.js',
        'src/shared/project_paths.js',
        'src/shared/runtime_settings.js',
        'src/shared/proxy_input.js',
        'src/shared/github_source_updater.js',
        'src/shared/menu_file_helpers.js'
    ];

    for (const shimPath of shimFiles) {
        const source = fs.readFileSync(path.join(projectRoot, shimPath), 'utf8').trim();
        assert.match(source, /^module\.exports = require\(/);
        assert.ok(source.length < 80);
    }
});

test('package metadata is release-oriented and keeps runtime entrypoints stable', () => {
    assert.equal(packageJson.name, 'tgproxy');
    assert.equal(packageJson.releasePackageName, 'mtproto-checker-for-telegram');
    assert.equal(packageJson.main, 'proxy_terminal_menu.js');
    assert.deepEqual(packageJson.bin, {
        tgproxy: 'proxy_terminal_menu.js'
    });
    assert.equal(
        packageJson.description,
        'Update MTProto proxy lists from GitHub and check which Telegram proxies are actually usable'
    );
    assert.equal(packageJson.license, 'MIT');
    assert.equal(packageJson.type, 'commonjs');
    assert.deepEqual(packageJson.optionalDependencies || {}, {});
    assert.equal(packageJson.engines.node, '>=16.20.2');
    assert.ok(Array.isArray(packageJson.files));
    assert.ok(packageJson.files.includes('src/'));
    assert.ok(packageJson.files.includes('telegram_proxy_pinger.js'));
    assert.ok(packageJson.files.includes('proxy_terminal_menu.js'));
    assert.ok(packageJson.files.includes('ui.js'));
    assert.equal(typeof packageJson.scripts.check, 'undefined');
    assert.ok(!packageJson.files.includes('tests/'));
    assert.ok(!packageJson.files.includes('scripts/'));
});

test('root cli entrypoint is executable for npm global installs', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const entrypoint = fs.readFileSync(path.join(projectRoot, 'proxy_terminal_menu.js'), 'utf8');

    assert.match(entrypoint, /^#!\/usr\/bin\/env node/);
});

test('repository ships bilingual GitHub-facing readmes and release notes for v1', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const englishReadme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
    const russianReadme = fs.readFileSync(path.join(projectRoot, 'README.ru.md'), 'utf8');
    const releaseNotes = fs.readFileSync(path.join(projectRoot, 'docs/releases/v1.0.0.md'), 'utf8');

    assert.match(englishReadme, /<div align="center">/);
    assert.match(englishReadme, /<a href="README\.ru\.md">Русский<\/a>/);
    assert.match(englishReadme, /docs\/assets\/readme\/checker-splash-en\.png/);
    assert.match(englishReadme, /npm install -g tgproxy/);
    assert.match(englishReadme, /tgproxy/);
    assert.match(englishReadme, /~\/\.tgproxy\/data\/runtime\/working_proxies\.txt/);
    assert.match(englishReadme, /%AppData%\\tgproxy\\data\\runtime\\working_proxies\.txt/);
    assert.doesNotMatch(englishReadme, /checker_candidates\.json/);
    assert.doesNotMatch(englishReadme, /git clone/);
    assert.doesNotMatch(englishReadme, /npm run check/);

    assert.match(russianReadme, /<div align="center">/);
    assert.match(russianReadme, /<a href="README\.md">English<\/a>/);
    assert.match(russianReadme, /docs\/assets\/readme\/checker-splash-ru\.png/);
    assert.match(russianReadme, /npm install -g tgproxy/);
    assert.match(russianReadme, /tgproxy/);
    assert.match(russianReadme, /~\/\.tgproxy\/data\/runtime\/working_proxies\.txt/);
    assert.match(russianReadme, /%AppData%\\tgproxy\\data\\runtime\\working_proxies\.txt/);
    assert.doesNotMatch(russianReadme, /checker_candidates\.json/);
    assert.doesNotMatch(russianReadme, /git clone/);
    assert.doesNotMatch(russianReadme, /npm run check/);

    assert.match(releaseNotes, /v1\.0\.0/);
    assert.match(releaseNotes, /Node\.js 16\.20\.2\+/);
    assert.match(releaseNotes, /macOS/);
    assert.match(releaseNotes, /Windows/);
    assert.match(releaseNotes, /Linux/);
    assert.doesNotMatch(releaseNotes, /native binaries/i);
});

test('repository keeps README hero screenshots under docs assets', () => {
    const projectRoot = path.resolve(__dirname, '..');

    assert.equal(fs.existsSync(path.join(projectRoot, 'docs/assets/readme/checker-splash-en.png')), true);
    assert.equal(fs.existsSync(path.join(projectRoot, 'docs/assets/readme/checker-splash-ru.png')), true);
});

test('release packaging files keep end-user docs and runtime data scaffolding only', () => {
    const packagedPaths = new Set(packageJson.files);

    assert.ok(packagedPaths.has('README.md'));
    assert.ok(packagedPaths.has('LICENSE'));
    assert.ok(packagedPaths.has('package-lock.json'));
    assert.ok(packagedPaths.has('data/manual/.gitkeep'));
    assert.ok(packagedPaths.has('data/runtime/.gitkeep'));
    assert.ok(!packagedPaths.has('backup_snapshots/'));
    assert.ok(!packagedPaths.has('baseline_artifacts/'));
    assert.ok(!packagedPaths.has('.github/'));
    assert.ok(!packagedPaths.has('tests/'));

    const projectRoot = path.resolve(__dirname, '..');
    assert.equal(path.basename(projectRoot), 'MTProto Checker for Telegram');
});

test('lib directory has been removed from the repository layout', () => {
    const projectRoot = path.resolve(__dirname, '..');

    assert.equal(fs.existsSync(path.join(projectRoot, 'lib')), false);
});

test('repository tree does not keep tracked .DS_Store files', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const files = walkFiles(projectRoot);

    assert.equal(files.some(filePath => path.basename(filePath) === '.DS_Store'), false);
});

test('release builder creates clean macOS, Windows, and Linux user packages', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const { buildReleaseTree, RELEASE_TARGETS } = require('../scripts/build_release');

    const { releaseRoot, packageName } = buildReleaseTree(projectRoot);

    assert.deepEqual(
        RELEASE_TARGETS.map(target => target.id),
        ['macos', 'windows', 'linux']
    );

    for (const target of RELEASE_TARGETS) {
        const targetRoot = path.join(releaseRoot, `${packageName}-${target.id}`);
        assert.equal(fs.existsSync(targetRoot), true);
        assert.equal(fs.existsSync(path.join(targetRoot, 'package.json')), true);
        assert.equal(fs.existsSync(path.join(targetRoot, 'package-lock.json')), true);
        assert.equal(fs.existsSync(path.join(targetRoot, 'README.md')), true);
        assert.equal(fs.existsSync(path.join(targetRoot, 'README_PLATFORM.md')), true);
        assert.equal(fs.existsSync(path.join(targetRoot, 'tests')), false);
        assert.equal(fs.existsSync(path.join(targetRoot, 'scripts')), false);
        assert.equal(fs.existsSync(path.join(targetRoot, 'data/runtime/working_proxies.txt')), false);
        assert.equal(fs.existsSync(path.join(targetRoot, 'Start.command')), false);
        assert.equal(fs.existsSync(path.join(targetRoot, 'Start.bat')), false);
        assert.equal(fs.existsSync(path.join(targetRoot, 'start.sh')), false);
        assert.equal(fs.existsSync(path.join(releaseRoot, `${packageName}-${target.id}${target.archiveExt}`)), true);

        const releaseReadme = fs.readFileSync(path.join(targetRoot, 'README.md'), 'utf8');
        assert.match(releaseReadme, /## Quick Start/);
        assert.match(releaseReadme, /npm install/);
        assert.doesNotMatch(releaseReadme, /npm install --omit=dev/);
        assert.match(releaseReadme, /npm start/);
        assert.match(releaseReadme, /~\/\.tgproxy\/data\/runtime\/working_proxies\.txt/);
        assert.match(releaseReadme, /%AppData%\\tgproxy\\data\\runtime\\working_proxies\.txt/);
        assert.doesNotMatch(releaseReadme, /## Development/);

        const platformReadme = fs.readFileSync(path.join(targetRoot, 'README_PLATFORM.md'), 'utf8');
        assert.match(platformReadme, /npm install/);
        assert.doesNotMatch(platformReadme, /npm install --omit=dev/);
        assert.match(platformReadme, /npm start/);
        assert.match(platformReadme, /~\/\.tgproxy\/data\/runtime\/working_proxies\.txt/);
        assert.match(platformReadme, /%AppData%\\tgproxy\\data\\runtime\\working_proxies\.txt/);
    }
});

test('release builder creates Linux tarball with portable archive settings', () => {
    const {
        RELEASE_TARGETS,
        buildArchiveCommand
    } = require('../scripts/build_release');
    const linuxTarget = RELEASE_TARGETS.find(target => target.id === 'linux');

    const command = buildArchiveCommand('/tmp/release.tar.gz', 'release-dir', linuxTarget);

    assert.equal(command.command, 'tar');
    assert.deepEqual(command.args, [
        '-czf',
        '/tmp/release.tar.gz',
        '--format',
        'ustar',
        '--exclude',
        '.DS_Store',
        '--exclude',
        '._*',
        'release-dir'
    ]);
    assert.equal(command.options.env.COPYFILE_DISABLE, '1');
});
