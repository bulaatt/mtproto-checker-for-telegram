const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectPaths = require('../src/config/project_paths');

function getExpectedDefaultAppRoot() {
    return path.join(os.homedir(), 'tgproxy');
}

function getExpectedLegacyAppRoot() {
    if (process.platform === 'win32') {
        const appData = String(process.env.APPDATA || '').trim();
        return appData
            ? path.join(appData, 'tgproxy')
            : path.join(os.homedir(), 'AppData', 'Roaming', 'tgproxy');
    }

    return path.join(os.homedir(), '.tgproxy');
}

function withTempHome(fn) {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'project-paths-home-'));
    const originalHomeDir = os.homedir;
    const previousAppData = process.env.APPDATA;

    try {
        os.homedir = () => tempHome;
        process.env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
        return fn(tempHome);
    } finally {
        os.homedir = originalHomeDir;
        if (typeof previousAppData === 'string') {
            process.env.APPDATA = previousAppData;
        } else {
            delete process.env.APPDATA;
        }
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
}

function toRealPath(targetPath) {
    try {
        return fs.realpathSync.native(targetPath);
    } catch (_) {
        return path.resolve(targetPath);
    }
}

function pathsReferToSameLocation(actualPath, expectedPath) {
    assert.equal(toRealPath(actualPath), toRealPath(expectedPath));
}

test('managed files default to a dedicated user tgproxy directory while cwd stays the project root', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-paths-default-'));
    const previousCwd = process.cwd();
    const previousAppHome = process.env.TGPROXY_HOME;

    try {
        delete process.env.TGPROXY_HOME;
        process.chdir(tempDir);

        pathsReferToSameLocation(projectPaths.getProjectRoot(), tempDir);
        assert.equal(projectPaths.getAppRoot(), getExpectedDefaultAppRoot());
        assert.equal(
            projectPaths.getWorkingResultsPath(),
            path.join(getExpectedDefaultAppRoot(), 'data', 'runtime', 'working_proxies.txt')
        );
        assert.equal(
            path.dirname(projectPaths.resolveProjectFilePath('proxies.txt')),
            projectPaths.getProjectRoot()
        );
        assert.equal(path.basename(projectPaths.resolveProjectFilePath('proxies.txt')), 'proxies.txt');
    } finally {
        if (typeof previousAppHome === 'string') {
            process.env.TGPROXY_HOME = previousAppHome;
        } else {
            delete process.env.TGPROXY_HOME;
        }
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('TGPROXY_HOME overrides the managed data root and keeps app-relative labels', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-paths-override-'));
    const appHome = path.join(tempDir, 'tgproxy-home');
    const workspace = path.join(tempDir, 'workspace');
    const previousCwd = process.cwd();
    const previousAppHome = process.env.TGPROXY_HOME;

    try {
        fs.mkdirSync(workspace, { recursive: true });
        process.env.TGPROXY_HOME = appHome;
        process.chdir(workspace);
        projectPaths.ensureDataDirectories();
        fs.mkdirSync(path.join(workspace, 'data', 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'data', 'runtime', projectPaths.ALL_SOURCES_FILENAME), '', 'utf8');
        fs.writeFileSync(projectPaths.getAllSourcesPath(), '', 'utf8');

        const workingResultsPath = projectPaths.getWorkingResultsPath();
        assert.equal(
            workingResultsPath,
            path.join(appHome, 'data', 'runtime', 'working_proxies.txt')
        );
        assert.equal(
            projectPaths.toProjectRelative(workingResultsPath),
            path.join('data', 'runtime', 'working_proxies.txt')
        );
        assert.equal(
            projectPaths.resolveProjectFilePath(path.join('data', 'runtime', projectPaths.ALL_SOURCES_FILENAME)),
            projectPaths.getAllSourcesPath()
        );
        assert.equal(fs.existsSync(path.join(appHome, 'data', 'runtime')), true);
        assert.equal(fs.existsSync(path.join(appHome, 'data', 'manual')), true);
    } finally {
        if (typeof previousAppHome === 'string') {
            process.env.TGPROXY_HOME = previousAppHome;
        } else {
            delete process.env.TGPROXY_HOME;
        }
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('default app root migrates legacy managed data into the visible tgproxy directory', () => {
    withTempHome(() => {
        const previousAppHome = process.env.TGPROXY_HOME;

        try {
            delete process.env.TGPROXY_HOME;
            const legacyRoot = getExpectedLegacyAppRoot();
            const legacyRuntime = path.join(legacyRoot, 'data', 'runtime');
            const legacyManual = path.join(legacyRoot, 'data', 'manual');
            fs.mkdirSync(legacyRuntime, { recursive: true });
            fs.mkdirSync(legacyManual, { recursive: true });
            fs.writeFileSync(path.join(legacyRuntime, projectPaths.WORKING_RESULTS_FILENAME), 'old results\n', 'utf8');
            fs.writeFileSync(path.join(legacyRuntime, projectPaths.CHECKER_CONFIG_FILENAME), '{}\n', 'utf8');
            fs.writeFileSync(path.join(legacyManual, 'custom.txt'), 'manual list\n', 'utf8');

            projectPaths.ensureDataDirectories();

            assert.equal(projectPaths.getAppRoot(), getExpectedDefaultAppRoot());
            assert.equal(
                fs.readFileSync(projectPaths.getWorkingResultsPath(), 'utf8'),
                'old results\n'
            );
            assert.equal(
                fs.readFileSync(projectPaths.getManualFilePath('custom.txt'), 'utf8'),
                'manual list\n'
            );
            assert.equal(fs.existsSync(legacyRoot), true);
        } finally {
            if (typeof previousAppHome === 'string') {
                process.env.TGPROXY_HOME = previousAppHome;
            } else {
                delete process.env.TGPROXY_HOME;
            }
        }
    });
});
