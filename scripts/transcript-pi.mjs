#!/usr/bin/env node
// pi (pi-mono) 세션 jsonl (~/.pi/agent/sessions/--<경로>--/<ts>_<id>.jsonl) → 사람이 읽는 전사 markdown.
// omp 가 pi-mono 에서 갈라져 나왔고 메시지·도구·압축 엔트리 모양이 같아서
// omp 전사기를 그대로 쓴다. 다른 점 두 개만 여기서 맞춘다:
//   - 세션 이름은 헤더 title 이 아니라 session_info 엔트리의 name 에 있다 → title 엔트리로 변환
//   - model_change 는 {provider, modelId} 다 → omp 의 {model} 로 변환
// pi 에는 omp 의 title 엔트리, ask 도구, session_exit 기록이 없다.
// CLI:    scripts/transcript-pi.mjs <session.jsonl> [out.md]
// module: import { normalizePiSession } from "./transcript-pi.mjs"
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractOmpEvents, normalizeOmpSession, readOmpSessionMeta } from "./transcript-omp.mjs";

/** pi 엔트리를 omp 엔트리 모양으로. 나머지는 그대로 통과한다. */
const adapt = (e) => {
	if (e?.type === "session_info") return { ...e, type: "title", title: e.name };
	if (e?.type === "model_change" && e.model === undefined)
		return { ...e, model: [e.provider, e.modelId].filter(Boolean).join("/") || "?" };
	return e;
};

export function parsePiLines(jsonl) {
	const out = [];
	for (const line of jsonl.split("\n")) {
		if (!line) continue;
		try {
			out.push(adapt(JSON.parse(line)));
		} catch {
			// 잘린 줄 무시
		}
	}
	return out;
}

const adaptJsonl = (jsonl) => parsePiLines(jsonl).map((e) => JSON.stringify(e)).join("\n");

/** jsonl 본문을 전사 markdown 으로. `source` 는 헤더에 적을 원본 표시. */
export const normalizePiSession = (jsonl, source = "") => normalizeOmpSession(adaptJsonl(jsonl), source);
/** 세션 파일 머리만 읽어 목록용 메타를 뽑는다. 사용자 발화가 없으면 null. */
export const readPiSessionMeta = (head) => {
	const m = readOmpSessionMeta(adaptJsonl(head));
	return m?.first ? m : null;
};

/** 새로 추가된 엔트리에서 라이브 이벤트를 뽑는다. {kind, text, options?} */
export const extractPiEvents = (entries) => extractOmpEvents(entries.map(adapt));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [, , input, output] = process.argv;
	if (!input) {
		console.error("usage: transcript-pi.mjs <session.jsonl> [out.md]");
		process.exit(2);
	}
	const md = normalizePiSession(readFileSync(input, "utf8"), input);
	if (output) {
		writeFileSync(output, md);
		console.error(`wrote ${output} (${md.length} chars)`);
	} else process.stdout.write(md);
}
