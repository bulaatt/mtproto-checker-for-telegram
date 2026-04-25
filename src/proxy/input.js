const fs = require('fs');
const net = require('net');
const {
    sanitizeAttempts,
    sanitizeBatchSize,
    sanitizeTimeoutSeconds
} = require('../config/runtime_settings');

const MAX_RECOMMENDED_CONCURRENCY = 128;
const DEFAULT_CONCURRENCY = 32;

function normalizeConcurrency(value) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric)) return 1;
    return Math.min(MAX_RECOMMENDED_CONCURRENCY, Math.max(1, numeric));
}

function sanitizeSecretCandidate(raw) {
    if (!raw || typeof raw !== 'string') return '';

    let text = raw.trim();

    try {
        text = decodeURIComponent(text);
    } catch (_) {}

    text = text.trim();

    if (/^(?:0x)?[0-9a-fA-F]+$/i.test(text)) {
        return text.replace(/^0x/i, '');
    }

    const base64Prefix = text.match(/^[A-Za-z0-9+/_=-]+/);
    return base64Prefix ? base64Prefix[0] : text;
}

function base64ToBuffer(secret) {
    const normalized = secret
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .replace(/\s+/g, '');

    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64');
}

function validateSecretBuffer(buffer, hex) {
    const normalizedHex = hex.toLowerCase();
    const length = buffer.length;

    if (length === 16) {
        return { hex: normalizedHex, type: 'classic', byteCount: length };
    }

    if (length === 17 && buffer[0] === 0xdd) {
        return { hex: normalizedHex, type: 'dd', byteCount: length };
    }

    if (length >= 18 && buffer[0] === 0xee) {
        return { hex: normalizedHex, type: 'ee', byteCount: length };
    }

    return null;
}

function normalizeSecret(raw) {
    if (!raw || typeof raw !== 'string') return null;

    const candidate = sanitizeSecretCandidate(raw);
    if (!candidate) return null;

    const hexCandidate = candidate.replace(/^0x/i, '');
    if (/^[0-9a-fA-F]+$/.test(hexCandidate) && hexCandidate.length >= 32 && hexCandidate.length % 2 === 0) {
        const buffer = Buffer.from(hexCandidate, 'hex');
        const validated = validateSecretBuffer(buffer, hexCandidate);
        if (validated) return validated;
    }

    try {
        const buffer = base64ToBuffer(candidate);
        if (buffer.length >= 16) {
            const validated = validateSecretBuffer(buffer, buffer.toString('hex'));
            if (validated) return validated;
        }
    } catch (_) {}

    return null;
}

function toCanonicalServer(server) {
    return String(server || '').trim().toLowerCase();
}

function hasTerminalControlChars(value) {
    return /[\u0000-\u001f\u007f-\u009f]/u.test(String(value || ''));
}

function parseIpv4Literal(value) {
    const text = String(value || '').trim();
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return null;

    const parts = text.split('.').map(part => Number.parseInt(part, 10));
    if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
        return null;
    }

    return parts;
}

function isUnsafeIpv4Literal(parts) {
    const [first, second, third, fourth] = parts;

    return first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 0 && third === 0) ||
        (first === 192 && second === 0 && third === 2) ||
        (first === 192 && second === 88 && third === 99) ||
        (first === 192 && second === 168) ||
        (first === 198 && (second === 18 || second === 19)) ||
        (first === 198 && second === 51 && third === 100) ||
        (first === 203 && second === 0 && third === 113) ||
        first >= 224 ||
        (first === 255 && second === 255 && third === 255 && fourth === 255);
}

function isUnsafeIpv6Literal(value) {
    const text = String(value || '').trim().toLowerCase();
    const mappedIpv4 = text.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);

    if (mappedIpv4) {
        const parts = parseIpv4Literal(mappedIpv4[1]);
        return !parts || isUnsafeIpv4Literal(parts);
    }

    return text === '::' ||
        text === '::1' ||
        text.startsWith('fc') ||
        text.startsWith('fd') ||
        /^fe[89ab]:/u.test(text) ||
        text.startsWith('ff') ||
        text.startsWith('2001:db8:');
}

function isValidHostname(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text.length > 253) return false;
    if (text.startsWith('.') || text.endsWith('.')) return false;
    if (/^[\d.]+$/.test(text)) return false;

    return text.split('.').every(label =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    );
}

function isAllowedProxyServer(server) {
    const text = toCanonicalServer(server);
    if (!text || hasTerminalControlChars(text)) return false;

    const ipv4Parts = parseIpv4Literal(text);
    if (ipv4Parts) {
        return !isUnsafeIpv4Literal(ipv4Parts);
    }

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
        return false;
    }

    const ipVersion = net.isIP(text);
    if (ipVersion === 6) {
        return !isUnsafeIpv6Literal(text);
    }
    if (ipVersion === 4) {
        return false;
    }

    if (text.includes(':')) return false;
    return isValidHostname(text);
}

function sanitizeInputLine(rawLine) {
    const line = String(rawLine || '').trim();
    if (!line) return '';

    const directMatch = line.match(/(tg:\/\/proxy\?[^\s]+|https?:\/\/t\.me\/(?:proxy|socks)\?[^\s]+)/i);
    if (directMatch) return directMatch[1].replace(/[*_`)\]}>.,!?:;]+$/g, '');

    return line;
}

function buildCanonicalProxyUrl({ server, port, secretHex }) {
    const params = new URLSearchParams({
        server,
        port: String(port),
        secret: secretHex
    });
    return `tg://proxy?${params.toString()}`;
}

function parseProxyUrl(url) {
    const STATUS = {
        INVALID_INPUT: 'INVALID_INPUT',
        UNSUPPORTED_BOT_LINK: 'UNSUPPORTED_BOT_LINK'
    };

    const originalUrl = sanitizeInputLine(url);
    if (!originalUrl) {
        return { ok: false, reason: STATUS.INVALID_INPUT };
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(originalUrl);
    } catch (_) {
        return { ok: false, reason: STATUS.INVALID_INPUT };
    }

    const protocol = String(parsedUrl.protocol || '').toLowerCase();
    const hostname = String(parsedUrl.hostname || '').toLowerCase();
    const pathname = String(parsedUrl.pathname || '').toLowerCase();
    const isDirectProxyLink = protocol === 'tg:' && hostname === 'proxy';
    const isTelegramProxyPage = (protocol === 'https:' || protocol === 'http:') &&
        hostname === 't.me' &&
        pathname === '/proxy';

    if (!isDirectProxyLink && !isTelegramProxyPage) {
        return { ok: false, reason: STATUS.INVALID_INPUT };
    }

    const server = toCanonicalServer(parsedUrl.searchParams.get('server'));
    const portText = parsedUrl.searchParams.get('port');
    const port = Number.parseInt(portText, 10);
    const secret = parsedUrl.searchParams.get('secret');
    const bot = parsedUrl.searchParams.get('bot');

    if (!isAllowedProxyServer(server) || Number.isNaN(port) || port < 1 || port > 65535) {
        return { ok: false, reason: STATUS.INVALID_INPUT };
    }

    if (secret) {
        const normalized = normalizeSecret(secret);
        if (!normalized) {
            return { ok: false, reason: STATUS.INVALID_INPUT };
        }

        return {
            ok: true,
            value: {
                server,
                port,
                secretHex: normalized.hex,
                proxyType: normalized.type,
                hasSecret: true,
                originalUrl,
                canonicalUrl: buildCanonicalProxyUrl({
                    server,
                    port,
                    secretHex: normalized.hex
                })
            }
        };
    }

    if (bot) {
        return {
            ok: false,
            reason: STATUS.UNSUPPORTED_BOT_LINK,
            value: {
                server,
                port,
                originalUrl
            }
        };
    }

    return { ok: false, reason: STATUS.INVALID_INPUT };
}

function dedupeSupported(entries) {
    const seen = new Set();
    const unique = [];
    let removed = 0;

    for (const entry of entries) {
        if (!entry.ok) continue;

        const proxy = entry.value;
        const key = `${proxy.server}:${proxy.port}:${proxy.secretHex}`;
        if (seen.has(key)) {
            removed += 1;
            continue;
        }

        seen.add(key);
        unique.push(proxy);
    }

    return { unique, removed };
}

function loadInputEntries(filepath) {
    const content = fs.readFileSync(filepath, 'utf8');
    const entries = [];

    for (const [index, line] of content.split(/\r?\n/).entries()) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const parsed = parseProxyUrl(trimmed);
        entries.push({
            lineNumber: index + 1,
            raw: trimmed,
            ...parsed
        });
    }

    return entries;
}

function summarizeInput(entries, deduped) {
    const invalid = entries.filter(entry => !entry.ok && entry.reason === 'INVALID_INPUT').length;
    const botLinks = entries.filter(entry => !entry.ok && entry.reason === 'UNSUPPORTED_BOT_LINK').length;
    const supported = entries.filter(entry => entry.ok).length;

    return {
        invalid,
        botLinks,
        supported,
        duplicatesRemoved: deduped.removed,
        uniqueSupported: deduped.unique.length
    };
}

function toTdProxy(record) {
    return {
        _: 'proxy',
        server: record.server,
        port: record.port,
        type: {
            _: 'proxyTypeMtproto',
            secret: record.secretHex
        }
    };
}

function parseArgs(argv = process.argv) {
    const args = {
        file: null,
        timeout: 8,
        concurrency: DEFAULT_CONCURRENCY,
        bootstrapTimeout: 12,
        attempts: 3,
        batchSize: 0,
        verbose: false,
        debug: false,
        debugTimings: false,
        debugPhaseStats: false
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];

        if ((arg === '--file' || arg === '-f') && argv[i + 1]) args.file = argv[++i];
        else if ((arg === '--timeout' || arg === '-t') && argv[i + 1]) args.timeout = Number.parseFloat(argv[++i]) || args.timeout;
        else if ((arg === '--concurrency' || arg === '-c') && argv[i + 1]) args.concurrency = Number.parseInt(argv[++i], 10) || args.concurrency;
        else if ((arg === '--bootstrap-timeout' || arg === '--init-timeout') && argv[i + 1]) args.bootstrapTimeout = Number.parseFloat(argv[++i]) || args.bootstrapTimeout;
        else if ((arg === '--attempts' || arg === '-a') && argv[i + 1]) args.attempts = Math.max(1, Number.parseInt(argv[++i], 10) || args.attempts);
        else if ((arg === '--batch-size' || arg === '-b') && argv[i + 1]) args.batchSize = Math.max(0, Number.parseInt(argv[++i], 10) || 0);
        else if (arg === '--debug' || arg === '-d') {
            args.debug = true;
            args.verbose = true;
        }
        else if (arg === '--verbose') args.verbose = true;
        else if (arg === '--debug-timings') args.debugTimings = true;
        else if (arg === '--debug-phase-stats') args.debugPhaseStats = true;
    }

    if (!args.file) {
        throw new Error('Error: --file is required');
    }

    const requestedConcurrency = args.concurrency;
    args.timeout = sanitizeTimeoutSeconds(args.timeout, 8);
    args.attempts = sanitizeAttempts(args.attempts, 3);
    args.batchSize = sanitizeBatchSize(args.batchSize, 0);
    args.concurrency = normalizeConcurrency(args.concurrency);
    args.concurrencyWasClamped = requestedConcurrency !== args.concurrency;

    return args;
}

module.exports = {
    normalizeConcurrency,
    sanitizeSecretCandidate,
    base64ToBuffer,
    validateSecretBuffer,
    normalizeSecret,
    toCanonicalServer,
    sanitizeInputLine,
    buildCanonicalProxyUrl,
    parseProxyUrl,
    dedupeSupported,
    loadInputEntries,
    summarizeInput,
    toTdProxy,
    parseArgs
};
