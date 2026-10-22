// ─────────────────────────────────────────────────────────────
//  Silana Bot — main.js (deobfuscated & cleaned)
//  100% compatible with: config.js, handler.js, index.js,
//  lib/simple.js, lib/useSQLite.js, lib/database.js, lib/print.js
// ─────────────────────────────────────────────────────────────

import './config.js';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// ── Globals used everywhere in the project ──
global.__filename = function filename(url = import.meta.url, returnAsUrl = process.platform !== 'win32') {
	return returnAsUrl
		? /file:\/\//.test(url)
			? fileURLToPath(url)
			: url
		: pathToFileURL(url).href;
};

global.__dirname = function dirname(url) {
	return path.dirname(global.__filename(url, true));
};

global.__require = function require(url = import.meta.url) {
	return createRequire(url);
};

import fs from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { format } from 'util';
import { parentPort } from 'worker_threads';
import { makeWASocket, protoType, serialize } from './lib/simple.js';
import chalk from 'chalk';
import pino from 'pino';
import syntaxError from 'syntax-error';
import Database from 'better-sqlite3';
import useSQLiteAuthState from './lib/useSQLite.js';
import { Browsers, fetchLatestWaWebVersion, makeCacheableSignalKeyStore } from 'baileys';

protoType();
serialize();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Default prefix (same characters as original) ──
global.prefix = new RegExp('^[' + '‎xzXZ/i!#$%+£¢€¥^°=¶∆×÷π√✓©®:;?&.\\-'.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&') + ']');

// ── Database ──
global.db = { sqlite: null, data: null };

global.loadDatabase = async function () {
	if (!global.db.sqlite) {
		const dbPath = path.resolve('./database.db');
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		global.db.sqlite = new Database(dbPath);
		global.db.sqlite.pragma('journal_mode = WAL');
		global.db.sqlite.pragma('synchronous = NORMAL');
		global.db.sqlite.exec(`CREATE TABLE IF NOT EXISTS database (id INTEGER PRIMARY KEY, data TEXT NOT NULL)`);
	}

	if (global.db.data !== null) return;

	global.db.data = { users: {}, chats: {}, stats: {}, msgs: {}, sticker: {}, settings: {} };

	const row = global.db.sqlite.prepare('SELECT data FROM database WHERE id = 1').get();
	if (row?.data) {
		try {
			Object.assign(global.db.data, JSON.parse(row.data));
		} catch {
			console.error('[DB] Failed to parse database, using empty');
		}
	} else {
		global.db.sqlite.prepare('INSERT OR REPLACE INTO database (id, data) VALUES (1, ?)').run(JSON.stringify(global.db.data));
	}
};

await global.loadDatabase();

// ── Periodic DB save + tmp cleanup (same as original, every 60s) ──
setInterval(() => {
	if (global.db.data && global.db.sqlite) {
		global.db.sqlite.prepare('INSERT OR REPLACE INTO database (id, data) VALUES (1, ?)').run(JSON.stringify(global.db.data));
	}
	if ((global?.support || {}).ffmpeg) {
		[tmpdir(), 'tmp'].forEach(dir => {
			try {
				spawn('find', [dir, '-mtime', '+3', '-type', 'f', '-delete']);
			} catch {}
		});
	}
}, 60 * 1000);

// ── Auth + WA version ──
const { state, saveCreds } = await useSQLiteAuthState('./sessions');
const { version } = await fetchLatestWaWebVersion();

const connectionOptions = {
	auth: {
		creds: state.creds,
		keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
	},
	version,
	logger: pino({ level: 'silent' }),
	browser: Browsers.ubuntu('Chrome'),
	generateHighQualityLinkPreview: true,
	syncFullHistory: false,
	shouldSyncHistoryMessage: () => false,
	markOnlineOnConnect: true,
	connectTimeoutMs: 60_000,
	keepAliveIntervalMs: 30_000,
	retryRequestDelayMs: 250,
	maxMsgRetryCount: 5,
	cachedGroupMetadata: jid => conn.chats[jid],
};

global.conn = makeWASocket(connectionOptions);

// ── Pairing code ──
if (!conn.authState.creds.registered) {
	console.log(chalk.yellowBright('Bot not registered — generating pairing code...'));
	setTimeout(async () => {
		try {
			let code = await conn.requestPairingCode(global.pairingNumber);
			code = code?.match(/.{1,4}/g)?.join('-') || code;
			console.log(chalk.gray(chalk.yellowBright('Pairing code:')), chalk.yellowBright(code));
		} catch (e) {
			console.error('Pairing failed:', e);
			fs.rmSync('./sessions', { recursive: true, force: true });
			parentPort?.postMessage('restart');
		}
	}, 3000);
}

// ── Connection update ──
async function connectionUpdate({ receivedPendingNotifications, connection, lastDisconnect, isOnline }) {
	if (connection === 'connecting') return console.log(chalk.yellowBright('Connecting...'));

	if (connection === 'open') {
		console.log(chalk.greenBright('Connected to WhatsApp!'));
		return;
	}

	if (isOnline === true) console.log(chalk.greenBright('Online'));
	else if (isOnline === false) console.log(chalk.redBright('Offline'));

	if (receivedPendingNotifications) console.log(chalk.yellowBright('Pending notifications received'));

	if (connection === 'close') {
		const statusCode = lastDisconnect?.error?.output?.statusCode;
		const reason = lastDisconnect?.error?.output?.payload?.message || 'Unknown';

		if (statusCode === 401) {
			console.log(chalk.redBright('Logged out! Deleting session & restarting...'));
			fs.rmSync('./sessions', { recursive: true, force: true });
			parentPort?.postMessage('restart');
			return;
		}

		if (statusCode === 440) {
			console.log(chalk.redBright('Session conflict — exiting.'));
			process.exit(0);
		}

		if (statusCode === 403) {
			console.log(chalk.redBright('Banned: ' + reason));
			return;
		}

		console.log(chalk.redBright(`Disconnected (${statusCode}): ${reason}`));
		await global.reloadHandler(true); // auto-reconnect
	}
}

// ── Load handler.js ──
let handler = await import('./handler.js');

function registerHandlers() {
	// Unbind old listeners (if any)
	if (conn.handler) {
		try { conn.ev.off('messages.upsert', conn.handler); } catch {}
		try { conn.ev.off('group-participants.update', conn.participantsUpdate); } catch {}
		try { conn.ev.off('groups.update', conn.groupsUpdate); } catch {}
		try { conn.ev.off('message.delete', conn.onDelete); } catch {}
		try { conn.ev.off('connection.update', conn.connectionUpdate); } catch {}
		try { conn.ev.off('creds.update', conn.credsUpdate); } catch {}
	}

	// Default strings (used in handler.js)
	conn.welcome = 'Welcome, @user!';
	conn.bye = 'Goodbye, @user!';
	conn.spromote = '@user is now Admin!';
	conn.sdemote = '@user is no longer Admin!';
	conn.sDesc = 'Description has been changed to @desc';
	conn.sSubject = 'Subject has been changed to @subject';
	conn.sIcon = 'Icon has been changed';
	conn.sRevoke = 'Group link has been changed to @revoke';

	// Bind
	conn.handler = handler.handler.bind(conn);
	conn.participantsUpdate = handler.participantsUpdate.bind(conn);
	conn.groupsUpdate = handler.groupsUpdate.bind(conn);
	conn.onDelete = handler.deleteUpdate.bind(conn);
	conn.connectionUpdate = connectionUpdate.bind(conn);
	conn.credsUpdate = saveCreds.bind(conn, true);

	// Register
	conn.ev.on('messages.upsert', conn.handler);
	conn.ev.on('group-participants.update', conn.participantsUpdate);
	conn.ev.on('groups.update', conn.groupsUpdate);
	conn.ev.on('message.delete', conn.onDelete);
	conn.ev.on('connection.update', conn.connectionUpdate);
	conn.ev.on('creds.update', conn.credsUpdate);
}

global.reloadHandler = async function (restatConn) {
	try {
		const Handler = await import(`./handler.js?update=${Date.now()}`).catch(console.error);
		if (Object.keys(Handler || {}).length) handler = Handler;
	} catch (e) {
		console.error(e);
	}

	if (restatConn) {
		const oldChats = global.conn.chats;
		try { global.conn.ws.close(); } catch {}
		global.conn.ev.removeAllListeners();
		global.conn = makeWASocket(connectionOptions, { chats: oldChats });
	}

	registerHandlers();
	return true;
};

// ── Plugins loader ──
const pluginFolder = path.join(__dirname, 'plugins');
const pluginFilter = filename => /\.js$/.test(filename);
global.plugins = {};

async function filesInit() {
	for (const filename of fs.readdirSync(pluginFolder).filter(pluginFilter)) {
		try {
			const file = global.__filename(path.join(pluginFolder, filename));
			const module = await import(file);
			global.plugins[filename] = module.default || module;
		} catch (e) {
			console.error(`Error loading plugin '${filename}':`, e);
			delete global.plugins[filename];
		}
	}
}

filesInit()
	.then(() => console.log(`Loaded ${Object.keys(global.plugins).length} plugins`))
	.catch(console.error);

// ── Plugin hot-reload watcher ──
global.reload = async (_ev, filename) => {
	if (!pluginFilter(filename)) return;

	const dir = path.join(pluginFolder, filename);

	if (!(filename in global.plugins)) {
		console.log(`Loading new plugin '${filename}'`);
	} else if (!fs.existsSync(dir)) {
		console.log(`Deleted plugin '${filename}'`);
		delete global.plugins[filename];
		return;
	} else {
		console.log(`Reloading plugin '${filename}'`);
	}

	const err = syntaxError(fs.readFileSync(dir), filename, {
		sourceType: 'module',
		allowAwaitOutsideFunction: true,
	});

	if (err) {
		console.error(`Syntax error in '${filename}':\n${format(err)}`);
		return;
	}

	try {
		const module = await import(`${pathToFileURL(dir).href}?update=${Date.now()}`);
		global.plugins[filename] = module.default || module;
	} catch (e) {
		console.error(`Error requiring '${filename}':\n${format(e)}`);
	} finally {
		global.plugins = Object.fromEntries(Object.entries(global.plugins).sort(([a], [b]) => a.localeCompare(b)));
	}
};

Object.freeze(global.reload);
fs.watch(pluginFolder, global.reload);

// ── Initial handler registration ──
await global.reloadHandler();

// ── Quick dependency test ──
async function _quickTest() {
	const test = await Promise.all(
		[
			spawn('ffmpeg'),
			spawn('ffprobe'),
			spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-filter_complex', 'color', '-frames:v', '1', '-f', 'webp', '-']),
			spawn('convert'),
			spawn('magick'),
			spawn('gm'),
			spawn('find', ['--version']),
		].map(p =>
			Promise.race([
				new Promise(resolve => p.on('close', code => resolve(code !== 127))),
				new Promise(resolve => p.on('error', _ => resolve(false))),
			])
		)
	);

	const [ffmpeg, ffprobe, ffmpegWebp, convert, magick, gm, find] = test;
	const s = (global.support = { ffmpeg, ffprobe, ffmpegWebp, convert, magick, gm, find });
	Object.freeze(global.support);

	if (!s.ffmpeg) console.warn('⚠️ Install ffmpeg (needed for audio/video conversion)');
	if (s.ffmpeg && !s.ffmpegWebp) console.warn('⚠️ ffmpeg has no webp support — animated stickers will fail');
	if (!s.convert && !s.magick && !s.gm) console.warn('⚠️ No image converter — stickers may not work');
}

_quickTest()
	.then(() => console.log('Quick test done'))
	.catch(console.error);

// ── Graceful shutdown ──
function closeDB() {
	try {
		if (global.db?.sqlite) {
			global.db.sqlite.close();
			console.log('Database closed');
		}
	} catch (e) {
		console.error(e);
	}
}

process.on('uncaughtException', console.error);
process.on('SIGINT', () => { closeDB(); process.exit(0); });
process.on('SIGTERM', () => { closeDB(); process.exit(0); });
process.on('exit', closeDB);
