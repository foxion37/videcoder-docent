// 세션 파일을 폴링해 새 줄만 읽고 이벤트로 바꾼다. SSE 연결 하나당 watcher 하나.
import { open, stat } from "node:fs/promises";
import { EVENT_QUESTIONS, jevEnabled, judge } from "./jev.mjs";

const POLL_MS = 1000;
const REPLAY_BYTES = 512 * 1024; // 구독 시 꼬리에서 다시 보여 줄 범위. 도구 결과가 커서 64KB 로는 이벤트가 거의 안 잡힌다
const REPLAY_MAX = 5;
const EVENT_STATE_MAX = 12_000;
const OMITTED = "\n\n[중간 기록 생략]\n\n";
const EVENT_EDGE = Math.floor((EVENT_STATE_MAX - OMITTED.length) / 2);

/** 재생과 새 이벤트에 같은 의미 필터를 적용한다. 원문은 설명의 근거로 보존한다. */
async function filterEvent(ev, warnReduced) {
	if (ev.kind === "question") return { ...ev, sub: "question" };
	if (ev.kind !== "assistant") return null;
	const state = ev.text.length > EVENT_STATE_MAX ? `${ev.text.slice(0, EVENT_EDGE)}${OMITTED}${ev.text.slice(-EVENT_EDGE)}` : ev.text;
	const answer = await judge(state, EVENT_QUESTIONS);
	const probability = answer?.notable?.noul;
	const category = answer?.kind?.choice;
	if (!Number.isFinite(probability) || probability < 0 || probability > 1 || !["question", "result", "plan", "routine"].includes(category)) {
		warnReduced();
		return null;
	}
	if (probability < 0.6 || category === "routine") return null;
	return { ...ev, sub: category, by: "jev", p: probability };
}

/** 파일 꼬리의 최근 이벤트를 past 표시로 먼저 보낸다 (ADR 0012). */
async function replay(path, size, provider, send, warnReduced) {
	const start = Math.max(0, size - REPLAY_BYTES);
	const fh = await open(path, "r");
	let chunk;
	try {
		const buf = Buffer.alloc(size - start);
		const { bytesRead } = await fh.read(buf, 0, buf.length, start);
		chunk = buf.subarray(0, bytesRead).toString("utf8");
	} finally {
		await fh.close();
	}
	if (start > 0) chunk = chunk.slice(chunk.indexOf("\n") + 1); // 잘린 첫 줄 버림
	const kept = [];
	for (const ev of provider.events(provider.parse(chunk))) {
		const selected = await filterEvent(ev, warnReduced);
		if (selected) kept.push(selected);
	}
	const at = new Date().toISOString();
	for (const ev of kept.slice(-REPLAY_MAX)) send({ ...ev, past: true, at });
}

/**
 * @param {string} path 세션 jsonl
 * @param {{parse:(s:string)=>any[], events:(entries:any[])=>any[]}} provider
 * @param {(ev:object)=>void} send
 * @returns {() => void} stop
 */
export function watchSession(path, provider, send) {
	let offset = -1; // -1: 첫 stat 에서 꼬리를 재생하고 EOF 로 맞춤
	let remainder = Buffer.alloc(0); // 아직 줄이 끝나지 않은 바이트. 글자 중간에서 잘려도 다음 읽기와 합쳐 디코딩한다
	let stopped = false;
	let busy = false;
	let reducedReported = false;
	const warnReduced = () => {
		if (reducedReported || stopped) return;
		reducedReported = true;
		send({
			kind: "warn",
			code: "classifier-unavailable",
			text: "의미 분류를 사용할 수 없어 분류하지 못한 메시지는 건너뛰어요. 명시적인 질문 도구로 보낸 질문은 계속 보이지만, 일반 문장의 질문·작업 결과·계획은 빠질 수 있어요.",
			at: new Date().toISOString(),
		});
	};

	const tick = async () => {
		if (stopped || busy) return;
		busy = true;
		if (!jevEnabled) warnReduced();
		try {
			const st = await stat(path).catch(() => null);
			if (!st) return;
			if (offset < 0) {
				offset = st.size;
				await replay(path, st.size, provider, send, warnReduced);
				send({ kind: "hello", text: "이 세션을 지켜보고 있어요", at: new Date().toISOString() });
				return;
			}
			if (st.size < offset) {
				offset = 0; // 파일이 새로 쓰였음
				remainder = Buffer.alloc(0);
			}
			if (st.size === offset) return;
			const fh = await open(path, "r");
			let chunk;
			try {
				const buf = Buffer.alloc(st.size - offset);
				const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
				chunk = Buffer.concat([remainder, buf.subarray(0, bytesRead)]);
				offset += bytesRead;
			} finally {
				await fh.close();
			}
			// 줄바꿈 바이트(0x0a)는 여러 바이트 글자 안에 나오지 않으므로 여기서 자르면 글자가 깨지지 않는다.
			const nl = chunk.lastIndexOf(0x0a);
			remainder = nl >= 0 ? chunk.subarray(nl + 1) : chunk;
			const complete = nl >= 0 ? chunk.subarray(0, nl + 1).toString("utf8") : "";
			if (!complete) return;
			for (const ev of provider.events(provider.parse(complete))) {
				const selected = await filterEvent(ev, warnReduced);
				if (selected) send({ ...selected, at: new Date().toISOString() });
			}
		} catch (e) {
			send({ kind: "warn", text: String(e.message ?? e), at: new Date().toISOString() });
		} finally {
			busy = false;
		}
	};

	const timer = setInterval(tick, POLL_MS);
	tick();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
