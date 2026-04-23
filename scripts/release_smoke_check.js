#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const packageJson = require('../package.json');
const { logger } = require('../src/shared/logger');

function ensureParentDir(targetPath) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function copyEntry(projectRoot, stagingRoot, entry) {
    const sourcePath = path.join(projectRoot, entry);
    const targetPath = path.join(stagingRoot, entry);

    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Missing packaged path: ${entry}`);
    }

    ensureParentDir(targetPath);
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
        fs.cpSync(sourcePath, targetPath, { recursive: true });
        return;
    }

    fs.copyFileSync(sourcePath, targetPath);
}

function stagePackage(projectRoot) {
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mtproto-checker-release-'));
    for (const entry of packageJson.files || []) {
        copyEntry(projectRoot, stagingRoot, entry);
    }

    const nodeModulesPath = path.join(projectRoot, 'node_modules');
    if (fs.existsSync(nodeModulesPath)) {
        fs.symlinkSync(nodeModulesPath, path.join(stagingRoot, 'node_modules'));
    }

    return stagingRoot;
}

function verifyStagedPackage(stagingRoot) {
    const checker = require(path.join(stagingRoot, 'telegram_proxy_pinger.js'));
    const menu = require(path.join(stagingRoot, 'proxy_terminal_menu.js'));
    const ui = require(path.join(stagingRoot, 'ui.js'));

    assert.equal(typeof checker.parseArgs, 'function');
    assert.equal(typeof checker.runCli, 'function');
    assert.equal(typeof menu.buildArgv, 'function');
    assert.equal(typeof menu.runFindProxies, 'function');
    assert.equal(typeof ui.renderBox, 'function');

    const parsed = checker.parseArgs([
        'node',
        'telegram_proxy_pinger.js',
        '--file',
        'proxies.txt',
        '--timeout',
        '4',
        '--attempts',
        '2'
    ]);
    assert.equal(parsed.file, 'proxies.txt');
    assert.equal(parsed.timeout, 4);
    assert.equal(parsed.attempts, 2);

    const argv = menu.buildArgv({
        inputFile: 'proxies.txt',
        timeout: 4,
        attempts: 2,
        batchSize: 0,
        verbose: false
    });
    assert.ok(argv.includes('--file'));
    assert.ok(argv.includes('proxies.txt'));

    assert.equal(fs.existsSync(path.join(stagingRoot, 'tests')), false);
    assert.equal(fs.existsSync(path.join(stagingRoot, 'scripts')), false);
    assert.equal(fs.existsSync(path.join(stagingRoot, 'backup_snapshots')), false);
}

function main() {
    const projectRoot = path.resolve(__dirname, '..');
    logger.info('Staging release whitelist into a temporary directory');
    const stagingRoot = stagePackage(projectRoot);

    try {
        verifyStagedPackage(stagingRoot);
        logger.info(`Release smoke check passed: ${stagingRoot}`);
    } finally {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        logger.error(error && error.stack ? error.stack : String(error));
        process.exit(1);
    }
}

module.exports = {
    copyEntry,
    stagePackage,
    verifyStagedPackage
};
