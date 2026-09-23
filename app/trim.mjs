// 긴 전사 줄이기 (ADR 0009). 전사가 MAX 를 넘으면 앞쪽 턴은 사용자 발화만 남기고 최근 턴은 그대로 둔다.
// 턴 = `## user` 헤딩부터 다음 `## user` 전까지. 제공자(omp/claude)와 무관하게 전사 모양만 본다.
import { frames } from "./evidence.mjs";
export const MAX_CHARS = 120_000;
const RECENT_TURNS = 12;
const MIN_RECENT = 4;
const EARLY_USER_MAX = 500;

const USER_HEAD = /^## user$/;
const ANY_HEAD = /^## /;

function splitTurns(md) {
	const lines = md.split("\n");
	const sourceRanges = [...frames(md)];
	let position = 0, rangeIndex = 0;
	const userHeads = lines.map((line) => {
		while (rangeIndex < sourceRanges.length && sourceRanges[rangeIndex].end <= position) rangeIndex++;
		const range = sourceRanges[rangeIndex];
		const protectedLine = range && position >= range.start && position < range.end;
		position += line.length + 1;
		return !protectedLine && USER_HEAD.test(line);
	});
	const first = userHeads.indexOf(true);
	if (first < 0) return { header: md, turns: [] };
	const header = lines.slice(0, first).join("\n");
	const turns = [];
	let cur = [];
	for (let index = first; index < lines.length; index++) {
		const l = lines[index];
		if (userHeads[index] && cur.length) {
			turns.push(cur);
			cur = [];
		}
		cur.push(l);
	}
	turns.push(cur);
	return { header, turns };
}

// 턴에서 사용자 발화만 (헤딩 다음부터 다음 헤딩 전까지)
function userOnly(turn) {
	const source = [...frames(turn.join("\n"))].find((frame) => frame.meta.role === "user");
	const body = [];
	if (!source) {
		for (const l of turn.slice(1)) {
			if (ANY_HEAD.test(l)) break;
			body.push(l);
		}
	}
	const t = (source?.text ?? body.join("\n")).trim();
	return t.length > EARLY_USER_MAX ? `${t.slice(0, EARLY_USER_MAX)}\n…(잘림)` : t;
}

/** 전사가 max 를 넘으면 줄인다. 안 넘으면 그대로. */
export function trimTranscript(md, max = MAX_CHARS) {
	if (md.length <= max) return md;
	const { header, turns } = splitTurns(md);
	if (turns.length <= MIN_RECENT) return md;
	let recent = Math.min(RECENT_TURNS, turns.length - 1);
	let out;
	for (;;) {
		const cut = turns.length - recent;
		const early = turns.slice(0, cut).map((t) => `## user\n\n${userOnly(t)}`);
		const note = `## system\n\n(전사가 길어서 앞 ${cut}턴은 사용자가 한 말만 남기고 줄였어요. 마지막 ${recent}턴은 그대로예요.)`;
		out = [header, note, ...early, ...turns.slice(cut).map((t) => t.join("\n"))].join("\n\n");
		if (out.length <= max || recent <= MIN_RECENT) break;
		recent = Math.max(MIN_RECENT, Math.floor(recent / 2));
	}
	return `${out}\n`;
}
