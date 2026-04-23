#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const packageJson = require('../package.json');
const { logger } = require('../src/shared/logger');

const RELEASE_TARGETS = [
    {
        id: 'macos',
        displayName: 'macOS',
        archiveExt: '.tar.gz'
    },
    {
        id: 'windows',
        displayName: 'Windows',
        archiveExt: '.zip'
    },
    {
        id: 'linux',
        displayName: 'Linux',
        archiveExt: '.tar.gz'
    }
];

function getReleasePackageName(packageJson) {
    return String(packageJson.releasePackageName || packageJson.name);
}

function ensureDir(targetPath) {
    fs.mkdirSync(targetPath, { recursive: true });
}

function ensureParentDir(targetPath) {
    ensureDir(path.dirname(targetPath));
}

function removeIfExists(targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyEntry(projectRoot, targetRoot, entry) {
    const sourcePath = path.join(projectRoot, entry);
    const targetPath = path.join(targetRoot, entry);

    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Missing release path: ${entry}`);
    }

    ensureParentDir(targetPath);

    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
        fs.cpSync(sourcePath, targetPath, { recursive: true });
        return;
    }

    fs.copyFileSync(sourcePath, targetPath);
}

function buildReleaseTree(projectRoot) {
    const packageName = `${getReleasePackageName(packageJson)}-${packageJson.version}`;
    const releaseRoot = path.join(projectRoot, 'release');
    const legacyTargetRoot = path.join(releaseRoot, packageName);
    const legacyArchivePath = path.join(releaseRoot, `${packageName}.tar.gz`);

    ensureDir(releaseRoot);
    removeIfExists(legacyTargetRoot);
    removeIfExists(legacyArchivePath);

    const releases = [];
    for (const target of RELEASE_TARGETS) {
        const targetRoot = path.join(releaseRoot, `${packageName}-${target.id}`);
        const archivePath = path.join(releaseRoot, `${packageName}-${target.id}${target.archiveExt}`);

        removeIfExists(targetRoot);
        removeIfExists(archivePath);
        ensureDir(targetRoot);

        for (const entry of packageJson.files || []) {
            copyEntry(projectRoot, targetRoot, entry);
        }

        writePlatformFiles(targetRoot, target);
        createArchive(releaseRoot, path.basename(targetRoot), archivePath, target);
        releases.push({ target, targetRoot, archivePath });
    }

    return { releaseRoot, releases, packageName };
}

function buildUserReadme(target) {
    return [
        '# MTProto Checker for Telegram',
        '',
        `User release for ${target.displayName}. This is a Node-based desktop CLI archive.`,
        '',
        '## Quick Start',
        '',
        `1. Install Node.js 16.20.2 or newer from https://nodejs.org/ if it is not installed.`,
        '2. Open a terminal in this folder.',
        '3. Run `npm install`.',
        '4. Run `npm start`.',
        '',
        'The checker will open its interactive terminal menu.',
        '',
        '## What You Can Do',
        '',
        '- Refresh built-in MTProto proxy lists from GitHub sources',
        '- Choose or validate a `.txt` list of MTProto proxy links',
        '- Run the interactive checker and save working results',
        '- Use the interface in English or Russian',
        '',
        '## Your Files',
        '',
        '- Put your own `.txt` proxy list in this folder, or choose a custom path from the menu',
        '- Results are saved to `~/tgproxy/data/runtime/working_proxies.txt`',
        '- Settings are saved to `~/tgproxy/data/runtime/checker_config.json`',
        '- Put manual proxy lists in `~/tgproxy/data/manual/`',
        '## Notes',
        '',
        '- Internet access is required for live checks',
        '- Node.js is required on the user machine for all three supported desktop platforms',
        '- The first run may take a bit longer because runtime dependencies are installed locally',
        '- This release package does not include tests, scripts, cached results, or developer files'
    ].join('\n');
}

function buildPlatformReadme(target) {
    return [
        `# MTProto Checker for Telegram - ${target.displayName}`,
        '',
        'Portable archive for the current menu-first desktop CLI release.',
        '',
        '## Start',
        '',
        `1. Install Node.js 16.20.2 or newer from https://nodejs.org/ if it is not installed.`,
        '2. Open a terminal in this folder.',
        '3. Run `npm install`.',
        '4. Run `npm start`.',
        '',
        'After that the checker opens its terminal menu.',
        '',
        '## Important Files',
        '',
        '- `~/tgproxy/data/runtime/working_proxies.txt` - latest saved working results',
        '- `~/tgproxy/data/runtime/checker_config.json` - saved menu settings',
        '- `~/tgproxy/data/runtime/github_source_all.txt` - latest refreshed built-in source list',
        '- `~/tgproxy/data/manual/` - manual proxy lists'
    ].join('\n');
}

function writePlatformFiles(targetRoot, target) {
    fs.writeFileSync(
        path.join(targetRoot, 'README.md'),
        buildUserReadme(target),
        'utf8'
    );

    fs.writeFileSync(
        path.join(targetRoot, 'README_PLATFORM.md'),
        buildPlatformReadme(target),
        'utf8'
    );
}

function runArchiveCommand(command, args, options) {
    const result = spawnSync(
        command,
        args,
        { ...options, encoding: 'utf8' }
    );

    if (result.status !== 0) {
        const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
        throw new Error(`Failed to create archive${details ? `: ${details}` : ''}`);
    }
}

function buildArchiveCommand(archivePath, releaseDirName, target) {
    if (target.archiveExt === '.zip') {
        return {
            command: 'zip',
            args: ['-qr', archivePath, releaseDirName],
            options: {
                env: { ...process.env }
            }
        };
    }

    return {
        command: 'tar',
        args: [
            '-czf',
            archivePath,
            '--format',
            'ustar',
            '--exclude',
            '.DS_Store',
            '--exclude',
            '._*',
            releaseDirName
        ],
        options: {
            env: {
                ...process.env,
                COPYFILE_DISABLE: '1'
            }
        }
    };
}

function createArchive(releaseRoot, releaseDirName, archivePath, target) {
    const archiveCommand = buildArchiveCommand(archivePath, releaseDirName, target);
    runArchiveCommand(
        archiveCommand.command,
        archiveCommand.args,
        {
            ...archiveCommand.options,
            cwd: releaseRoot
        }
    );
}

function main() {
    const projectRoot = path.resolve(__dirname, '..');
    logger.info('Building clean platform release packages');

    const { releases } = buildReleaseTree(projectRoot);

    for (const release of releases) {
        logger.info(`${release.target.displayName} release directory: ${release.targetRoot}`);
        logger.info(`${release.target.displayName} release archive: ${release.archivePath}`);
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
    RELEASE_TARGETS,
    buildArchiveCommand,
    buildReleaseTree,
    buildPlatformReadme,
    buildUserReadme,
    copyEntry,
    createArchive,
    getReleasePackageName,
    writePlatformFiles
};
