const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectPaths = require('../src/config/project_paths');

function getExpectedDefaultAppRoot() {
    if (process.platform === 'win32') {
        const appData = String(process.env.APPDATA || '').trim();
        return appData
            ? path.join(appData, 'tgproxy')
            : path.join(os.homedir(), 'AppData', 'Roaming', 'tgproxy');
    }

    return path.join(os.homedir(), '.tgproxy');
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
