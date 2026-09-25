import { sourceHash, sourceWriter } from "../scripts/transcript-source.mjs";

const REF_ID = /^s_[a-f0-9]{40}$/;
const CLOSE = "\n<!-- /docent-source -->";
const EXCERPT_MAX = 800;
const SELECTED_MAX = 8000;
const NEIGHBOR_MAX = 1600;
const CITATION_MAX = 12;

export function* frames(md) {
	const start = /^<!-- docent-source (\{[^\n]*\}) -->\r?$/gm;
	let match;
	while ((match = start.exec(md))) {
		let meta;
		try { meta = JSON.parse(match[1]); } catch { continue; }
		if (meta.v !== 1 || !/^[a-f0-9]{64}$/.test(meta.key) || !/^[a-f0-9]{64}$/.test(meta.hash)
			|| !Number.isSafeInteger(meta.length) || meta.length < 1 || meta.length > md.length
			|| typeof meta.role !== "string" || meta.role.length > 100) continue;
		let bodyStart = start.lastIndex + 1;
		const reference = /^\[ref:(s_[a-f0-9]{40})\]\n/.exec(md.slice(bodyStart, bodyStart + 60));
		if (reference) bodyStart += reference[0].length;
		const bodyEnd = bodyStart + meta.length;
		if (!md.startsWith(CLOSE, bodyEnd)) continue;
		const text = md.slice(bodyStart, bodyEnd);
		const end = bodyEnd + CLOSE.length;
		// A valid frame owns its literal body, including apparent headers and markers inside code.
		start.lastIndex = end;
		if (sourceHash(text) !== meta.hash) continue;
		yield { meta, text, start: match.index, end, open: match[0], ref: reference?.[1] };
	}
}

// Old peers may only send plain normalized Markdown. Never invent message UUIDs for it.
// Content + occurrence is stable for unchanged chunks; regrouped/identical legacy records are ambiguous.
function markLegacy(md) {
	const mark = sourceWriter("legacy-transcript");
	const out = [];
	let role = null, chunk = [], fence = null;
	const flush = () => {
		if (!chunk.length) return;
		const text = chunk.join("\n");
		out.push(role && text.trim() ? mark({ type: role }, text, { role, original: { role, text } }) : text);
		chunk = [];
	};
	for (const line of md.split("\n")) {
		const edge = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) {
			chunk.push(line);
			if (edge && edge[1][0] === fence[0] && edge[1].length >= fence.length && line.trim() === edge[1]) fence = null;
			continue;
		}
		if (edge) { fence = edge[1]; chunk.push(line); continue; }
		const heading = /^## (user|assistant|system(?:\s+\([^\n]*\))?)\s*$/.exec(line);
		if (heading) { flush(); role = heading[1].startsWith("system") ? "system" : heading[1]; out.push(line); }
		else if (!line.trim()) { flush(); out.push(line); }
		else chunk.push(line);
	}
	flush();
	return out.join("\n");
}

const refId = (sessionId, meta) => `s_${sourceHash(JSON.stringify([sessionId, meta.key, meta.hash])).slice(0, 40)}`;
const safeMeta = (value, max) => typeof value === "string" ? value.slice(0, max) : undefined;

function sourceFor(frame, sessionId, id, block) {
	const { meta, text } = frame;
	const agent = safeMeta(meta.agent, 256);
	const timestamp = safeMeta(meta.timestamp, 100);
	const roleLabel = { user: "사용자", assistant: "에이전트", tool: "도구 결과", system: "시스템" }[meta.role] ?? meta.role;
	return {
		id, sessionId, label: [agent, roleLabel, timestamp].filter(Boolean).join(", "),
		text, excerpt: text.slice(0, EXCERPT_MAX), role: meta.role,
		...(timestamp ? { timestamp } : {}), ...(agent ? { agent } : {}),
		...(meta.legacy ? { legacy: true } : {}),
		block,
	};
}

/** Normalize once before trimming. IDs bind the source identity AND its exact content version. */
export function prepareEvidence(md, sessionId) {
	if (typeof md !== "string" || typeof sessionId !== "string" || !sessionId) throw new TypeError("transcript and sessionId are required");
	const input = md.includes("<!-- docent-source ") ? md : markLegacy(md);
	const sources = new Map();
	const out = [];
	let cursor = 0;
	for (const frame of frames(input)) {
		const id = refId(sessionId, frame.meta);
		const block = `${frame.open}\n[ref:${id}]\n${frame.text}${CLOSE}`;
		out.push(input.slice(cursor, frame.start), block);
		cursor = frame.end;
		// Repeated source IDs are ambiguous, even if a malformed external producer repeats them.
		if (sources.has(id)) sources.set(id, null);
		else sources.set(id, sourceFor(frame, sessionId, id, block));
	}
	out.push(input.slice(cursor));
	for (const [id, source] of sources) if (!source) sources.delete(id);
	return { transcript: out.join(""), sources };
}

/** Keep only complete, byte-identical frames supplied to the model, not an untrimmed source map. */
export function retainEvidence(prepared, transcript) {
	const sources = new Map();
	for (const frame of frames(transcript)) {
		const source = prepared.sources.get(frame.ref);
		if (source && source.block === transcript.slice(frame.start, frame.end)) sources.set(source.id, source);
	}
	return { transcript, sources };
}

const citationFor = ({ id, sessionId, label, excerpt, role, timestamp, agent }) => ({
	id, sessionId, label, excerpt, role, ...(timestamp ? { timestamp } : {}), ...(agent ? { agent } : {}),
});

/** A machine footer is not prose or a code sample. Only complete standalone trailing footers count. */
export function extractCitations(raw, prepared) {
	const lines = String(raw).split("\n");
	let fence = null;
	const eligible = lines.map((line) => {
		const edge = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (edge && edge[1][0] === fence[0] && edge[1].length >= fence.length && line.trim() === edge[1]) fence = null;
			return false;
		}
		if (edge) { fence = edge[1]; return false; }
		return true;
	});
	let end = lines.length - 1;
	while (end >= 0 && !lines[end].trim()) end--;
	const citations = [];
	const seen = new Set();
	if (end >= 0 && eligible[end] && /^\s*근거\s*:/.test(lines[end])) {
		for (const match of lines[end].matchAll(/\[ref:([^\]\s]+)\]/g)) {
			const id = match[1];
			const source = REF_ID.test(id) ? prepared.sources.get(id) : null;
			if (!source || seen.has(id) || !prepared.transcript.includes(source.block)) continue;
			seen.add(id);
			citations.push(citationFor(source));
			if (citations.length >= CITATION_MAX) break;
		}
		lines.splice(end);
	}
	return { raw: lines.join("\n").trim(), citations };
}

function contextSource(source, max) {
	return {
		id: source.id, text: source.text.slice(0, max), role: source.role,
		...(source.timestamp ? { timestamp: source.timestamp } : {}),
		...(source.agent ? { agent: source.agent } : {}),
		...(source.text.length > max ? { truncated: true } : {}),
	};
}

/** Resolve only within the caller-supplied session; never opens paths or accepts URL/file references. */
export function resolveEvidence(md, sessionId, ref) {
	const missing = { available: false, selected: null, before: [], after: [], message: "이 원문 기록을 찾을 수 없어요. 기록이 바뀌었거나 줄어들었을 수 있어요." };
	if (!REF_ID.test(ref)) return missing;
	const { sources } = prepareEvidence(md, sessionId);
	const source = sources.get(ref);
	if (!source) return missing;
	const ordered = [...sources.values()];
	const index = ordered.indexOf(source);
	const result = {
		available: true, selected: contextSource(source, SELECTED_MAX),
		before: ordered.slice(Math.max(0, index - 2), index).map((item) => contextSource(item, NEIGHBOR_MAX)),
		after: ordered.slice(index + 1, index + 3).map((item) => contextSource(item, NEIGHBOR_MAX)),
	};
	if (source.legacy) result.message = "메시지 ID가 없는 이전 기록이라 내용과 등장 순서로 찾았어요. 동일한 기록이 재배치되면 위치를 구별할 수 없어요.";
	if (source.text.length > SELECTED_MAX) result.message = `${result.message ? `${result.message} ` : ""}선택한 기록이 길어 앞 ${SELECTED_MAX}자만 보여요.`;
	return result;
}
