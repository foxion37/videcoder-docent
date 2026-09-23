import { createHash } from "node:crypto";

export const sourceHash = (value) => createHash("sha256").update(value).digest("hex");

/** One writer per transcript/agent. Message IDs survive appends; content versions never alias. */
export function sourceWriter(namespace, agent = null) {
	const occurrences = new Map();
	return (entry, body, { role, part = "message", original = entry.message ?? entry, timestamp = entry.timestamp } = {}) => {
		if (!body?.trim()) return "";
		const messageId = entry.uuid ?? entry.id ?? entry.message?.id;
		const version = sourceHash(JSON.stringify(original));
		const identity = JSON.stringify([namespace, agent, messageId ?? version, part]);
		// Some hosts persist multiple fragments under one message UUID. Keep each distinct.
		const variant = `${identity}:${version}`;
		const occurrence = occurrences.get(variant) ?? 0;
		occurrences.set(variant, occurrence + 1);
		const metadata = {
			v: 1,
			key: sourceHash(JSON.stringify([identity, version, occurrence])),
			length: body.length,
			hash: sourceHash(body),
			role: role ?? entry.message?.role ?? entry.type ?? "unknown",
			...(timestamp != null ? { timestamp: String(timestamp) } : {}),
			...(agent ? { agent: String(agent) } : {}),
			...(!messageId ? { legacy: true } : {}),
		};
		const json = JSON.stringify(metadata).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
		return `<!-- docent-source ${json} -->\n${body}\n<!-- /docent-source -->`;
	};
}

/** Keep complete source blocks when shortening an embedded agent, never half a marker. */
export function boundSourceBlocks(blocks, max, headMax, tailMax) {
	if (blocks.reduce((sum, block) => sum + block.length + 1, 0) <= max) return blocks;
	let first = 0, head = 0;
	for (; first < blocks.length && head + blocks[first].length + 1 <= headMax; first++) head += blocks[first].length + 1;
	let last = blocks.length, tail = 0;
	for (; last > first && tail + blocks[last - 1].length + 1 <= tailMax; last--) tail += blocks[last - 1].length + 1;
	return [...blocks.slice(0, first), `…(가운데 ${last - first}개 기록 줄임)…`, ...blocks.slice(last)];
}
