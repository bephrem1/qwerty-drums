#!/usr/bin/env ts-node
/**
 * QWERTY DRUMS — CLI player (puppeteer-core) with pretty select + multi-sequence
 *
 * Features:
 *  - If no args or missing pattern: shows a colored single-select prompt (4 suggestions)
 *  - If multiple args: plays them in order; loops the entire sequence (use --once to stop after one cycle)
 *  - Connects to existing Chrome or launches system Chrome (no Chromium download)
 *  - Gapless looping, optional --reseed per loop if SEED not set
 *
 * Install:
 *   npm i puppeteer-core prompts chalk
 */

import fs from "fs";
import path from "path";
import chalk from "chalk";
import process from "process";
import prompts from "prompts";
import puppeteer, { Browser, Page } from "puppeteer-core";
import { QDSCompiler, QDSHeader, QDSParser, TimedEvent } from "./play/engine";

// ---------------- arg parsing ----------------
const [, , maybeArg, ...rest] = process.argv;
function flag(name: string, fallback?: string) {
	const i = rest.findIndex((x) => x === `--${name}`);
	if (i >= 0 && rest[i + 1]) return rest[i + 1];
	const kv = rest.find((x) => x.startsWith(`--${name}=`));
	if (kv) return kv.split("=")[1];
	return fallback;
}
function hasFlag(name: string) {
	return rest.includes(`--${name}`);
}

const url = flag("url", "https://ikeadrift.com/");
const headless = flag("headless", "false") === "true";
const once = hasFlag("once");
const reseed = hasFlag("reseed");
const chromePath =
	flag("chrome") ||
	(process.platform === "darwin"
		? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		: process.platform === "win32"
			? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
			: "/usr/bin/google-chrome");
const debugPort = parseInt(flag("port", "9222")!, 10);

// ---------- file utils ----------
const qdsDir = path.resolve("./score/lib");
function listQDS(dir: string): string[] {
	try {
		return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".qds"));
	} catch {
		return [];
	}
}
const baseNoExt = (f: string) => f.replace(/\.qds$/i, "");

// ---------- fuzzy top-4 suggestions ----------
function levenshtein(a: string, b: string) {
	const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
		Array(b.length + 1).fill(0),
	);
	for (let i = 0; i <= a.length; i++) dp[i][0] = i;
	for (let j = 0; j <= b.length; j++) dp[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i][j] = Math.min(
				dp[i - 1][j] + 1,
				dp[i][j - 1] + 1,
				dp[i - 1][j - 1] + cost,
			);
		}
	}
	return dp[a.length][b.length];
}
function top4Suggestions(query: string | undefined, dir: string): string[] {
	const files = listQDS(dir);
	if (!files.length) return [];
	const names = files.map(baseNoExt);
	if (!query) return names.sort().slice(0, 4);
	const q = query.toLowerCase();
	const scored = names.map((n) => {
		const includes = n.toLowerCase().includes(q) ? -1000 : 0;
		const dist = levenshtein(n.toLowerCase(), q);
		return { n, score: includes + dist };
	});
	scored.sort((a, b) => a.score - b.score);
	return scored.slice(0, 4).map((s) => s.n);
}

// ---------- helpers ----------
function loopLenMs(bpm: number, bars: number): number {
	return Math.round(bars * 4 * (60000 / bpm));
}
function compileFrom(
	parsed: ReturnType<QDSParser["parse"]>,
	headerOverride?: Partial<QDSHeader>,
): TimedEvent[] {
	const header: QDSHeader = { ...parsed.header, ...headerOverride };
	const compiler = new QDSCompiler(header);
	return compiler.compile(parsed.sections, parsed.order);
}
async function connectOrLaunch(): Promise<Browser> {
	try {
		return await puppeteer.connect({
			browserURL: `http://127.0.0.1:${debugPort}`,
		});
	} catch {
		return puppeteer.launch({
			headless,
			executablePath: chromePath,
			args: [
				`--remote-debugging-port=${debugPort}`,
				"--autoplay-policy=no-user-gesture-required",
				"--disable-features=PreloadMediaEngagementData,AutoplayIgnoreWebAudio",
				"--no-first-run",
				"--no-default-browser-check",
			],
			defaultViewport: null,
		});
	}
}

const keyForInst: Record<string, string> = {
	Q: "q",
	W: "w",
	E: "e",
	R: "r",
	T: "t",
	Y: "y",
};

async function scheduleOnePass(
	page: Page,
	parsed: ReturnType<QDSParser["parse"]>,
	reseedFlag: boolean,
): Promise<number> {
	const hdrOverride: Partial<QDSHeader> =
		reseedFlag && parsed.header.SEED === undefined
			? { SEED: Math.floor(Math.random() * 1e9) }
			: {};
	const events = compileFrom(parsed, hdrOverride);
	const start = Date.now() + 120;
	for (const ev of events) {
		const k = keyForInst[ev.inst];
		if (!k) continue;
		const delay = Math.max(0, start + ev.t - Date.now());
		setTimeout(async () => {
			try {
				await page.keyboard.down(k);
				await page.keyboard.up(k);
			} catch {}
		}, delay);
	}
	return loopLenMs(
		(parsed.header.BPM as number) || 120,
		(parsed.header.BARS as number) || 1,
	);
}

// ---------------- main ----------------
(async () => {
	const allFiles = listQDS(qdsDir);
	if (!allFiles.length) {
		console.error(chalk.red(`❌ No .qds files found in ${qdsDir}`));
		process.exit(1);
	}

	// --- get positional args (multi-score sequence) ---
	const positional = [
		maybeArg,
		...rest.filter((a) => a && !a.startsWith("--")),
	].filter(Boolean) as string[];
	let selections: string[] = [];

	if (positional.length > 0) {
		for (const name of positional) {
			const candidate = path.join(qdsDir, `${name}.qds`);
			if (fs.existsSync(candidate)) {
				selections.push(name);
				continue;
			}
			const sugg = top4Suggestions(name, qdsDir);
			if (!sugg.length) continue;
			const ans = await prompts({
				type: "select",
				name: "pick",
				message: `${chalk.yellow("Looks like I couldn’t find")} ${chalk.cyan(`"${name}"`)} — ${chalk.green("want to try one of these?")}`,
				choices: sugg.map((s) => ({ title: s, value: s })),
				hint: "↑↓ to move, Enter to confirm",
				instructions: false,
			});
			if (ans.pick !== undefined) selections.push(ans.pick);
		}
		if (!selections.length) {
			console.log(chalk.dim("No valid selections — exiting."));
			process.exit(0);
		}
	} else {
		const sugg = top4Suggestions(undefined, qdsDir);
		const ans = await prompts({
			type: "select",
			name: "pick",
			message: chalk.green("Pick something to play:"),
			choices: sugg.map((s) => ({ title: s, value: s })),
			hint: "↑↓ to move, Enter to play",
			instructions: false,
		});
		if (ans.pick === undefined) {
			console.log(chalk.dim("No selection — exiting."));
			process.exit(0);
		}
		selections = [ans.pick];
	}

	// --- browser setup ---
	let browser: Browser | null = null;
	try {
		browser = await connectOrLaunch();
		const pages = await browser.pages();
		const page = pages[0] ?? (await browser.newPage());

		await page.goto(url, { waitUntil: "domcontentloaded" });
		await page.bringToFront();
		await page.evaluate(() => document.body?.focus());
		try {
			await page.mouse.click(10, 10);
		} catch {}

		const loadParsed = (name: string) => {
			const fp = path.join(qdsDir, `${name}.qds`);
			const txt = fs.readFileSync(fp, "utf8");
			const parser = new QDSParser();
			const parsed = parser.parse(txt);
			console.log(
				`\n🎵 ${chalk.bold(name)}  →  ${chalk.underline(url)}\n` +
					`   BPM=${parsed.header.BPM}  GRID=${parsed.header.GRID}  SWING=${parsed.header.SWING}  BARS=${parsed.header.BARS}`,
			);
			return parsed;
		};

		let stopRequested = false;
		const cleanup = async () => {
			stopRequested = true;
			console.log(chalk.yellow("🛑 Stopping..."));
			if (browser) await browser.close().catch(() => {});
			process.exit(0);
		};
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);

		// preload for speed
		const parsedCache = new Map<string, ReturnType<QDSParser["parse"]>>();
		for (const n of selections) parsedCache.set(n, loadParsed(n));

		// play sequence
		do {
			for (const n of selections) {
				if (stopRequested) break;
				const parsed = parsedCache.get(n)!;
				console.log(`▶️  Playing ${chalk.cyan(n)}…`);
				const totalMs = await scheduleOnePass(page, parsed, reseed);
				await new Promise((res) => setTimeout(res, totalMs));
			}
		} while (!once && !stopRequested);

		await cleanup();
	} catch (err) {
		console.error(chalk.red("Runner error:"), err);
		if (browser) await browser.close().catch(() => {});
		process.exit(1);
	}
})();
