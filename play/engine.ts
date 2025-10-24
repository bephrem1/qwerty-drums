/*
 QWERTY Drum Script (QDS) — TypeScript Engine v0.1
 --------------------------------------------------
 Pure parser + compiler for QDS. No DOM or Puppeteer here.
 Exports:
   - QDSParser     : parse(text) -> { header, sections, order }
   - QDSCompiler   : new(header).compile(sections, order) -> TimedEvent[]
   - Types: Inst, QDSHeader, TimedEvent

 Supports (v0.1):
   Headers: BPM, BARS, GRID (1/8,1/16,1/32), SWING, SEED, %humanize=±Nms
   Tracks: Q/W/E/R/T/Y with '.', 'x','X','g', 'rN', modifiers '^±n', '[p=NN]', '{vel=NN}', '-' (ignored)
   Per‑track: @1/32 (or @GRID=1/32), @LEN=12 (polymeter steps per bar)
   Sections [Name] and finite ORDER: e.g. ORDER: Main x2, Fill x1

 Nice but omitted in v0.1: flam '~', %chance{}, infinite loops.
*/

export type Inst = "Q" | "W" | "E" | "R" | "T" | "Y";

export interface QDSHeader {
	BPM: number;
	BARS: number;
	GRID: "1/8" | "1/16" | "1/32";
	SWING: number; // 50..70 typical
	SEED?: number;
	humanizeMs?: number; // ±N ms
}

export interface TrackMod {
	grid?: "1/8" | "1/16" | "1/32";
	lenSteps?: number; // steps per bar for this track
}

export interface HitToken {
	inst: Inst;
	velocity: number; // 0..127
	prob: number; // 0..100
	microStepsShift: number; // integer micro‑steps (1 step = 4 micro‑steps)
	rolls: number; // 0=no roll, N = number of hits within step
}

export interface TimedEvent {
	t: number; // milliseconds from start
	inst: Inst;
	velocity: number;
}

// --- Utility: seeded RNG (Mulberry32) ---------------------------------------
function mulberry32(seed: number) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// --- Parser -----------------------------------------------------------------
interface Parsed {
	header: QDSHeader;
	sections: Record<string, ParsedTracks>;
	order?: string[]; // names expanded per repeats (finite only)
}

interface ParsedTracks {
	lines: { inst: Inst; mods: TrackMod; pattern: string }[];
}

const DEFAULT_HEADER: QDSHeader = {
	BPM: 92,
	BARS: 1,
	GRID: "1/16",
	SWING: 50,
};

const DEFAULT_VEL = { x: 96, X: 115, g: 60 } as const;

export class QDSParser {
	parse(src: string): Parsed {
		const lines = src.replace(/\t/g, "  ").split(/\r?\n/);
		let header: QDSHeader = { ...DEFAULT_HEADER };

		let sections: Record<string, ParsedTracks> = {};
		let currentSection = "Default";
		sections[currentSection] = { lines: [] };

		let order: string[] | undefined;

		for (let raw of lines) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;

			// humanize header
			const humanizeMatch = line.match(/^%humanize=\s*±?(\d+)ms$/i);
			if (humanizeMatch) {
				header.humanizeMs = parseInt(humanizeMatch[1], 10);
				continue;
			}

			// Order
			if (/^ORDER\s*:/.test(line)) {
				const rhs = line.split(":")[1];
				const parts = rhs
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				const expanded: string[] = [];
				for (const p of parts) {
					const m = p.match(/^(.*?)\s+x(\d+|∞)$/i);
					if (!m) continue;
					const name = m[1].trim();
					const countStr = m[2];
					if (countStr === "∞") {
						expanded.push(name); // add once in v0.1
					} else {
						const n = parseInt(countStr, 10);
						for (let i = 0; i < n; i++) expanded.push(name);
					}
				}
				order = expanded;
				continue;
			}

			// Section header
			const secMatch = line.match(/^\[(.+?)\]$/);
			if (secMatch) {
				currentSection = secMatch[1].trim();
				if (!sections[currentSection]) sections[currentSection] = { lines: [] };
				continue;
			}

			// Plain header key: value
			const kv = line.match(/^(BPM|BARS|GRID|SWING|SEED)\s*:\s*(.+)$/i);
			if (kv) {
				const key = kv[1].toUpperCase();
				const val = kv[2].trim();
				switch (key) {
					case "BPM":
						header.BPM = parseFloat(val);
						break;
					case "BARS":
						header.BARS = parseInt(val, 10);
						break;
					case "GRID":
						header.GRID = val as any;
						break;
					case "SWING":
						header.SWING = parseFloat(val);
						break;
					case "SEED":
						header.SEED = parseInt(val, 10);
						break;
				}
				continue;
			}

			// Track line:  R@1/32: x.x.
			const track = line.match(/^([QWERTY])(?:@([^:]+))?\s*:\s*(.+)$/i);
			if (track) {
				const inst = track[1].toUpperCase() as Inst;
				const mods: TrackMod = {};
				const modStr = track[2];
				if (modStr) {
					// support "1/32" shorthand, and GRID=1/32, LEN=12
					const parts = modStr.split(",").map((s) => s.trim());
					for (const p of parts) {
						if (/^\d+\/\d+$/.test(p)) mods.grid = p as any;
						const mg = p.match(/^GRID\s*=\s*(\d+\/\d+)$/i);
						if (mg) mods.grid = mg[1] as any;
						const ml = p.match(/^LEN\s*=\s*(\d+)$/i);
						if (ml) mods.lenSteps = parseInt(ml[1], 10);
					}
				}
				const pattern = track[3].replace(/\s+/g, "");
				sections[currentSection].lines.push({ inst, mods, pattern });
				continue;
			}

			// ignore unknown line
		}

		return { header, sections, order };
	}
}

// --- Compiler: QDS -> TimedEvent[] -----------------------------------------
export class QDSCompiler {
	private rng: () => number = Math.random;

	constructor(private header: QDSHeader) {
		if (typeof header.SEED === "number") this.rng = mulberry32(header.SEED);
	}

	compile(
		sections: Record<string, ParsedTracks>,
		order?: string[],
	): TimedEvent[] {
		const seqSections = order && order.length ? order : Object.keys(sections);

		const events: TimedEvent[] = [];
		let tCursor = 0; // ms from start

		for (const secName of seqSections) {
			const sec = sections[secName];
			if (!sec) continue;

			const trackEvents: TimedEvent[] = [];
			for (const line of sec.lines) {
				const grid = (line.mods.grid || this.header.GRID) as QDSHeader["GRID"];
				const stepsPerBar = line.mods.lenSteps || this.stepsPerBar(grid);
				const stepMs = this.stepMs(grid, this.header.BPM);
				const microMs = stepMs / 4; // 4 micro‑steps per step

				const cells = this.tokenizePattern(line.pattern);
				const totalSteps = cells.length;
				const barsInLine = Math.ceil(totalSteps / stepsPerBar) || 1;
				const barsToUse = Math.max(barsInLine, this.header.BARS);

				for (let bar = 0; bar < barsToUse; bar++) {
					for (let s = 0; s < stepsPerBar; s++) {
						const idx = bar * stepsPerBar + s;
						if (idx >= totalSteps) break;
						const cell = cells[idx];
						if (!cell) continue;

						const swingOffset = this.swingOffsetMs(
							s,
							stepMs,
							this.header.SWING,
						);

						const hits = this.expandCell(line.inst, cell);
						for (const h of hits) {
							if (h.prob < 100 && this.rng() * 100 > h.prob) continue;
							const human = this.header.humanizeMs
								? (this.rng() * 2 - 1) * this.header.humanizeMs
								: 0;
							const micro = h.microStepsShift * microMs;
							const when =
								tCursor +
								bar * stepsPerBar * stepMs +
								s * stepMs +
								swingOffset +
								micro +
								human;
							trackEvents.push({ t: when, inst: h.inst, velocity: h.velocity });
						}
					}
				}
			}

			trackEvents.sort((a, b) => a.t - b.t);
			events.push(...trackEvents);

			const secLenMs =
				this.header.BARS * this.barMs(this.header.GRID, this.header.BPM);
			tCursor += secLenMs;
		}

		const minT = events.length ? Math.min(...events.map((e) => e.t)) : 0;
		if (minT !== 0) events.forEach((e) => (e.t -= minT));

		return events;
	}

	private stepsPerBar(grid: QDSHeader["GRID"]): number {
		const denom = parseInt(grid.split("/")[1], 10);
		const stepsPerBeat = denom / 4; // e.g., 1/16 -> 4 steps per beat
		return stepsPerBeat * 4; // 4 beats per bar (4/4)
	}

	private stepMs(grid: QDSHeader["GRID"], bpm: number): number {
		const denom = parseInt(grid.split("/")[1], 10);
		const beatMs = 60000 / bpm;
		const stepsPerBeat = denom / 4;
		return beatMs / stepsPerBeat;
	}

	private barMs(grid: QDSHeader["GRID"], bpm: number): number {
		return this.stepMs(grid, bpm) * this.stepsPerBar(grid);
	}

	private swingOffsetMs(
		stepIndex: number,
		stepMs: number,
		swing: number,
	): number {
		if (swing <= 50) return 0;
		if (stepIndex % 2 === 1) {
			const amt = (swing - 50) / 50; // 0..1
			return amt * (stepMs * 0.5); // delay up to 50% of step
		}
		return 0;
	}

	private tokenizePattern(p: string): (string | null)[] {
		const cleaned = p.replace(/\|/g, "");
		const out: (string | null)[] = [];
		let i = 0;
		while (i < cleaned.length) {
			const ch = cleaned[i];
			if (ch === ".") {
				out.push(null);
				i++;
				continue;
			}
			if (ch === "-") {
				out.push(null);
				i++;
				continue;
			}
			if (ch === "x" || ch === "X" || ch === "g" || ch === "r") {
				let token = ch;
				i++;
				if (ch === "r") {
					const m = cleaned.slice(i).match(/^(\d+)/);
					if (m) {
						token += m[1];
						i += m[1].length;
					} else {
						token = "x";
					}
				}
				let mods = "";
				while (i < cleaned.length) {
					const ahead = cleaned.slice(i);
					const m = ahead.match(/^(\^[-+]?\d+|\{[^}]*\}|\[p=\d+\]|-)/);
					if (!m) break;
					mods += m[1];
					i += m[1].length;
				}
				out.push(token + mods);
				continue;
			}
			i++; // unknown char
		}
		return out;
	}

	private expandCell(inst: Inst, cell: string | null): HitToken[] {
		if (!cell) return [];
		const base = cell.match(/^(x|X|g|r\d+)/);
		if (!base) return [];
		const head = base[1];

		let vel = head.startsWith("r")
			? DEFAULT_VEL.x
			: DEFAULT_VEL[head as "x" | "X" | "g"];
		let prob = 100;
		let micro = 0;
		let rolls = head.startsWith("r") ? parseInt(head.slice(1), 10) : 0;

		const mods = cell.slice(head.length);
		if (mods) {
			const mShift = mods.match(/\^([+-]?\d+)/);
			if (mShift) micro = parseInt(mShift[1], 10);
			const mProb = mods.match(/\[p=(\d+)\]/i);
			if (mProb) prob = Math.max(0, Math.min(100, parseInt(mProb[1], 10)));
			const mVel = mods.match(/\{[^}]*vel\s*=\s*(\d+)[^}]*\}/i);
			if (mVel) vel = Math.max(0, Math.min(127, parseInt(mVel[1], 10)));
		}

		if (rolls && rolls > 1) {
			const arr: HitToken[] = [];
			for (let i = 0; i < rolls; i++) {
				const microPer = Math.round((i * 4) / Math.max(1, rolls));
				arr.push({
					inst,
					velocity: vel,
					prob,
					microStepsShift: micro + microPer,
					rolls,
				});
			}
			return arr;
		}

		return [{ inst, velocity: vel, prob, microStepsShift: micro, rolls: 0 }];
	}
}
