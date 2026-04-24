const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const projectPaths = require('../src/config/project_paths');
const {
    GITHUB_SOURCE_SELECTIONS,
    GITHUB_PROXY_SOURCES,
    GITHUB_SOURCES_MERGED_FILENAME,
    parseSourceEntries,
    refreshGitHubSources,
    SOURCE_ID_ALL,
    SOURCE_ID_ARGH94,
    SOURCE_ID_SCRAPER,
    SOURCE_ID_SOLISPIRIT,
    fetchTextFromUrl
} = require('../src/sources/github_source_updater');
const { validateProxyListFile } = require('../src/cli/menu_file_helpers');

const PROXY_A = 'tg://proxy?server=alpha.example.com&port=443&secret=dd8fb807a1ac8c4e95b8a2642e5bedd8fc';
const PROXY_B = 'tg://proxy?server=beta.example.com&port=443&secret=dd104462821249bd7ac519130220c25d09';
const PROXY_C = 'tg://proxy?server=gamma.example.com&port=8443&secret=ee4c161c0ff444b2bbc2f22c6e8d1f6bbf6875796775712e68656c7065723230736d732e7275';
const PROXY_D = 'tg://proxy?server=delta.example.com&port=443&secret=dd75eb1306a8c5f6084d1db4d651b80932';

async function withTempProject(fn) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-refresh-test-'));
    const previousCwd = process.cwd();
    const previousAppHome = process.env.TGPROXY_HOME;

    try {
        process.env.TGPROXY_HOME = path.join(tempDir, 'tgproxy-home');
        process.chdir(tempDir);
        return await fn(tempDir);
    } finally {
        if (typeof previousAppHome === 'string') {
            process.env.TGPROXY_HOME = previousAppHome;
        } else {
            delete process.env.TGPROXY_HOME;
        }
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

test('parseSourceEntries keeps only parseable proxy lines', () => {
    const entries = parseSourceEntries([
        PROXY_A,
        '# comment',
        '',
        'not-a-proxy',
        PROXY_B
    ].join('\n'));

    assert.equal(entries.length, 3);
    assert.equal(entries.filter(entry => entry.ok).length, 2);
    assert.equal(entries.filter(entry => !entry.ok).length, 1);
});

test('refreshGitHubSources exposes both concrete sources and merged all-sources selection', () => {
    assert.deepEqual(
        GITHUB_PROXY_SOURCES.map(source => source.id),
        [SOURCE_ID_ARGH94, SOURCE_ID_SOLISPIRIT, SOURCE_ID_SCRAPER]
    );
    assert.deepEqual(
        GITHUB_SOURCE_SELECTIONS.map(source => source.id),
        [SOURCE_ID_ARGH94, SOURCE_ID_SOLISPIRIT, SOURCE_ID_SCRAPER, SOURCE_ID_ALL]
    );
});

test('refreshGitHubSources merges successful sources and writes a valid merged file', async () => {
    await withTempProject(async () => {
        const result = await refreshGitHubSources({
            sourceId: SOURCE_ID_ALL,
            fetchText: async url => {
                if (url === GITHUB_PROXY_SOURCES[0].rawUrl) {
                    return { statusCode: 200, body: `${PROXY_A}\n${PROXY_B}\n` };
                }
                if (url === GITHUB_PROXY_SOURCES[1].rawUrl) {
                    return { statusCode: 200, body: `${PROXY_B}\n${PROXY_C}\n` };
                }
                if (url === GITHUB_PROXY_SOURCES[2].rawUrl) {
                    return { statusCode: 200, body: `${PROXY_C}\n${PROXY_D}\n` };
                }
                return { statusCode: 200, body: '' };
            }
        });

        assert.equal(result.ok, true);
        assert.equal(result.partial, false);
        assert.equal(result.stats.uniqueSupported, 4);
        assert.equal(result.sourceId, SOURCE_ID_ALL);
        assert.equal(result.relativeOutputPath, path.join('data', 'runtime', GITHUB_SOURCES_MERGED_FILENAME));
        assert.equal(fs.existsSync(projectPaths.getAllSourcesPath()), true);
        assert.equal(validateProxyListFile(result.relativeOutputPath).ok, true);
    });
});

test('refreshGitHubSources writes the Argh94 runtime file when a single source is selected', async () => {
    await withTempProject(async () => {
        const result = await refreshGitHubSources({
            sourceId: SOURCE_ID_ARGH94,
            fetchText: async url => {
                assert.equal(url, GITHUB_PROXY_SOURCES[0].rawUrl);
                return { statusCode: 200, body: `${PROXY_A}\n${PROXY_B}\n` };
            }
        });

        assert.equal(result.ok, true);
        assert.equal(result.sourceId, SOURCE_ID_ARGH94);
        assert.equal(result.relativeOutputPath, path.join('data', 'runtime', projectPaths.GITHUB_SOURCE_FILENAME));
        assert.equal(fs.existsSync(projectPaths.getGithubSourcePath()), true);
    });
});

test('refreshGitHubSources writes the SoliSpirit runtime file when a single source is selected', async () => {
    await withTempProject(async () => {
        const result = await refreshGitHubSources({
            sourceId: SOURCE_ID_SOLISPIRIT,
            fetchText: async url => {
                assert.equal(url, GITHUB_PROXY_SOURCES[1].rawUrl);
                return { statusCode: 200, body: `${PROXY_C}\n${PROXY_B}\n` };
            }
        });

        assert.equal(result.ok, true);
        assert.equal(result.sourceId, SOURCE_ID_SOLISPIRIT);
        assert.equal(result.relativeOutputPath, path.join('data', 'runtime', projectPaths.SOLISPIRIT_SOURCE_FILENAME));
        assert.equal(fs.existsSync(projectPaths.getSoliSpiritSourcePath()), true);
    });
});

test('refreshGitHubSources writes the scraper runtime file when a single source is selected', async () => {
    await withTempProject(async () => {
        const result = await refreshGitHubSources({
            sourceId: SOURCE_ID_SCRAPER,
            fetchText: async url => {
                assert.equal(url, GITHUB_PROXY_SOURCES[2].rawUrl);
                return { statusCode: 200, body: `${PROXY_D}\n${PROXY_A}\n` };
            }
        });

        assert.equal(result.ok, true);
        assert.equal(result.sourceId, SOURCE_ID_SCRAPER);
        assert.equal(result.relativeOutputPath, path.join('data', 'runtime', projectPaths.SCRAPER_SOURCE_FILENAME));
        assert.equal(fs.existsSync(projectPaths.getScraperSourcePath()), true);
    });
});

test('refreshGitHubSources fails cleanly when the only source fetch fails', async () => {
    await withTempProject(async () => {
        const result = await refreshGitHubSources({
            sourceId: SOURCE_ID_ARGH94,
            fetchText: async url => {
                if (url === GITHUB_PROXY_SOURCES[0].rawUrl) {
                    throw new Error('HTTP 503');
                }
            }
        });

        assert.equal(result.ok, false);
        assert.equal(result.partial, false);
        assert.equal(result.sources.filter(source => source.ok).length, 0);
        assert.equal(result.sources.filter(source => !source.ok).length, 1);
        assert.equal(result.stats.uniqueSupported, 0);
    });
});

test('refreshGitHubSources fails cleanly when both sources are unusable and keeps old merged file intact', async () => {
    await withTempProject(async () => {
        const mergedPath = projectPaths.getAllSourcesPath();
        projectPaths.ensureDataDirectories();
        fs.writeFileSync(mergedPath, `${PROXY_A}\n`, 'utf8');

        const before = fs.readFileSync(mergedPath, 'utf8');
        const result = await refreshGitHubSources({
            sourceId: SOURCE_ID_ALL,
            fetchText: async () => ({ statusCode: 200, body: 'not-a-proxy\nstill-not-a-proxy\n' })
        });

        assert.equal(result.ok, false);
        assert.equal(fs.readFileSync(mergedPath, 'utf8'), before);
    });
});

test('refreshGitHubSources stops immediately when cancellation was already requested', async () => {
    let fetchCalled = false;

    await withTempProject(async () => {
        await assert.rejects(
            refreshGitHubSources({
                sourceId: SOURCE_ID_ALL,
                cancelState: { cancelled: true, listeners: new Set() },
                fetchText: async () => {
                    fetchCalled = true;
                    return { statusCode: 200, body: `${PROXY_A}\n` };
                }
            }),
            error => error.message === 'CANCELLED'
        );

        assert.equal(fetchCalled, false);
        assert.equal(fs.existsSync(projectPaths.getAllSourcesPath()), false);
    });
});

test('fetchTextFromUrl rejects oversized source responses before buffering them fully', async () => {
    const server = http.createServer((request, response) => {
        void request;
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.write('x'.repeat(64));
        response.end('x'.repeat(64));
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
        const { port } = server.address();
        await assert.rejects(
            fetchTextFromUrl(`http://127.0.0.1:${port}/source.txt`, {
                maxResponseBytes: 100
            }),
            error => error.message === 'Source response too large'
        );
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
