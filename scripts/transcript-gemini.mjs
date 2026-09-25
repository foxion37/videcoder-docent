#!/usr/bin/env node
// Gemini CLI 세션 jsonl (~/.gemini/tmp/<project>/chats/session-<ts>-<id>.jsonl) → 사람이 읽는 전사 markdown.
// 출력 모양은 transcript-omp.mjs 와 같다. 도슨트는 둘을 구분하지 않는다.
//
// 파일 형식 (packages/core/src/services/chatRecordingService.ts):
//   첫 줄: 메타 {sessionId, projectHash, startTime, lastUpdated, kind, directories?}
//   이후 줄: 메시지 {id, timestamp, type: user|gemini|info|error|warning, content, toolCalls?...}
//            또는 {$set: {...}} 메타 갱신 ($set.messages 는 전체 메시지 체크포인트)
//            또는 {$rewindTo: "<messageId>"} — 그 메시지부터 끝까지 되돌림
//   같은 id 의 메시지가 다시 나오면 최신 것이 이긴다 (도구 결과가 뒤에 채워진다).
// cwd 는 파일 안에 없다. meta.directories(/dir 추가분)가 있으면 쓰고, 아니면
// readGeminiProjectRoot() 가 옆의 .project_root 표시 파일을 읽는다.
// CLI:    scripts/transcript-gemini.mjs <session.jsonl> [out.md]
// module: import { normalizeGeminiSession } from "./transcript-gemini.mjs"
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { askQuestionLines, errorSummary } from "./event-text.mjs";
import { sourceWriter } from "./transcript-source.mjs";

const ERROR_LINES = 8;
const USER_MAX = 4000;
const SYSTEM_MAX = 1500;
const FIRST_MAX = 140;
const EVENT_HEAD = 600;
const ASK_TOOL = "ask_user";

const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}\n…(잘림)` : s);

/** PartListUnion → part 배열. 문자열 하나, part 하나, part 배열 모두 온다. */
const parts = (content) => {
	if (typeof content === "string") return content ? [{ text: content }] : [];
	if (Array.isArray(content)) return content;
	return content && typeof content === "object" ? [content] : [];
};

/** 텍스트 part 만 이어 붙인다. thought·functionCall·inlineData 는 전사에서 빼거나 따로 그린다. */
const partText = (content) =>
	parts(content)
		.filter((p) => typeof p?.text === "string" && !p.thought)
		.map((p) => p.text)
		.join("\n");

/** 주입 컨텍스트(세션/훅 프리앰블)는 사용자 발화가 아니다. */
const isInjected = (t) => {
	const s = t.trimStart();
	return s.startsWith("<session_context>") || s.startsWith("<hook_context>");
};

/** 목록의 '첫 발화' 후보에서 제외 — gemini-cli 의 isIgnoredUserContent 와 같다. */
const isIgnoredUser = (t) => {
	const s = t.trim();
	return !s || s.startsWith("/") || s.startsWith("?") || isInjected(s);
};

const summarizeArgs = (args) => {
	if (!args || typeof args !== "object") return "";
	const first = Object.values(args).find((v) => typeof v === "string");
	return first ? clip(first.replace(/\s+/g, " "), 100) : "";
};

/** ToolResultDisplay 는 문자열이거나 {fileDiff}|{fileContent} 객체다. */
const displayText = (d) => {
	if (typeof d === "string") return d;
	if (d && typeof d === "object") return d.fileDiff ?? d.fileContent ?? "";
	return "";
};

const resultText = (call) => partText(call.result) || displayText(call.resultDisplay);

/**
 * gemini 메시지의 도구 호출 목록. 최신 기록은 msg.toolCalls 에 있고,
 * 일부는 content 안의 functionCall part 로만 남는다 (결과 없는 호출).
 */
const toolCallsOf = (m) => {
	if (m.toolCalls?.length) return m.toolCalls;
	return parts(m.content)
		.filter((p) => p?.functionCall)
		.map((p, i) => ({
			id: p.functionCall.id ?? `${p.functionCall.name}:${i}`,
			name: p.functionCall.name,
			args: p.functionCall.args,
			status: "executing",
		}));
};

/**
 * 레코드 열을 접어 최종 대화로. $set.messages 체크포인트는 전체를 갈아끼우고,
 * $rewindTo 는 그 메시지부터 끝까지 지운다. 같은 id 는 최신 레코드가 이긴다.
 */
const foldGeminiEntries = (entries) => {
	const meta = {};
	const messages = new Map();
	const putAll = (list) => {
		for (const m of list ?? []) if (typeof m?.id === "string") messages.set(m.id, m);
	};
	for (const e of entries) {
		if (typeof e?.$rewindTo === "string") {
			let found = false;
			for (const id of [...messages.keys()]) {
				if (id === e.$rewindTo) found = true;
				if (found) messages.delete(id);
			}
			if (!found) messages.clear();
		} else if (e?.$set && typeof e.$set === "object") {
			const { messages: ms, ...rest } = e.$set;
			Object.assign(meta, rest);
			if (Array.isArray(ms)) {
				messages.clear();
				putAll(ms);
			}
		} else if (typeof e?.id === "string" && typeof e?.type === "string") {
			messages.set(e.id, e);
		} else if (typeof e?.sessionId === "string") {
			// 헤더. 레거시 한 줄짜리 파일은 messages 도 함께 든다.
			const { messages: ms, ...rest } = e;
			Object.assign(meta, rest);
			if (Array.isArray(ms)) putAll(ms);
		}
	}
	return { meta, messages: [...messages.values()] };
};

export function parseGeminiLines(jsonl) {
	const out = [];
	for (const line of jsonl.split("\n")) {
		if (!line) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// 잘린 줄 무시
		}
	}
	return out;
}

/** jsonl 본문을 전사 markdown 으로. `source` 는 헤더에 적을 원본 표시, `projectRoot` 는 .project_root 표시 파일의 작업 폴더. */
export function normalizeGeminiSession(jsonl, source = "", projectRoot = null) {
	const { meta, messages } = foldGeminiEntries(parseGeminiLines(jsonl));
	const mark = sourceWriter(`gemini:${meta.sessionId ?? ""}`);

	const toolLines = (msg, call, part) => {
		const questions = call.name === ASK_TOOL ? askQuestionLines(call.args?.questions) : [];
		const line = [`→ ${call.name}(${summarizeArgs(call.args)})`, ...questions].join("\n");
		const out = [mark(msg, line, { role: "assistant", part })];
		const resultPart = `${call.id ?? part}:result`;
		if (call.status === "error" || call.status === "cancelled") {
			const body = resultText(call) || "(취소됨)";
			out.push(mark(msg, `⇒ ${call.name} 에러\n  ${body.split("\n").slice(0, ERROR_LINES).join("\n  ")}`, { role: "tool", part: resultPart }));
		} else if (call.status === "success") {
			const body = resultText(call);
			const summary =
				call.name === ASK_TOOL
					? `⇒ ${call.name} 사용자 답:\n  ${clip(body, USER_MAX).split("\n").join("\n  ")}`
					: `⇒ ${call.name} ok · ${body ? body.split("\n").length : 0}줄`;
			out.push(mark(msg, summary, { role: "tool", part: resultPart }));
		} else {
			out.push("  (결과 없음)");
		}
		return out;
	};

	const out = [
		`# ${meta.summary ?? "(제목 없음)"}`,
		"",
		`- 원본: ${source}`,
		`- 작업 폴더: ${meta.directories?.[0] ?? projectRoot ?? "?"}`,
		`- 시작: ${meta.startTime ?? "?"}`,
		"",
	];
	let lastRole = null;
	const section = (role) => {
		if (role !== lastRole) out.push("", `## ${role}`, "");
		lastRole = role;
	};

	for (const m of messages) {
		if (m.type === "user") {
			const t = partText(m.content);
			if (!t.trim() || isInjected(t)) continue;
			section("user");
			out.push(mark(m, clip(t, USER_MAX), { role: "user" }));
		} else if (m.type === "gemini") {
			const t = partText(m.content).trim();
			const calls = toolCallsOf(m);
			if (!t && !calls.length) continue;
			section("assistant");
			if (t) out.push(mark(m, t, { role: "assistant", part: "text" }));
			for (const [i, call] of calls.entries()) out.push(...toolLines(m, call, `tool:${call.id ?? i}`));
		} else if (m.type === "info" || m.type === "warning" || m.type === "error") {
			const t = partText(m.content).trim();
			if (!t) continue;
			section("system");
			out.push(mark(m, clip(t, SYSTEM_MAX), { role: "system" }));
		}
	}

	return `${out.join("\n")}\n`;
}

/** 세션 파일 머리만 읽어 목록용 메타를 뽑는다. 사용자 발화가 없으면 null. */
export function readGeminiSessionMeta(head) {
	const { meta, messages } = foldGeminiEntries(parseGeminiLines(head));
	let first = null;
	for (const m of messages) {
		if (m.type !== "user") continue;
		const t = partText(m.content).replace(/\s+/g, " ").trim();
		if (isIgnoredUser(t)) continue;
		first = t.length > FIRST_MAX ? `${t.slice(0, FIRST_MAX)}…` : t;
		break;
	}
	if (!first) return null;
	return {
		title: meta.summary ?? "(제목 없음)",
		cwd: meta.directories?.[0] ?? null,
		started: meta.startTime ?? null,
		first,
	};
}

/**
 * 세션 파일 옆의 .project_root 표시 파일에서 작업 폴더를 읽는다.
 * chats/<file> 은 한 단계, chats/<parent>/<file> (서브에이전트)는 두 단계 위에 있다.
 * meta 함수는 파일 머리 문자열만 받으므로 경로가 필요한 쪽에서 따로 부른다.
 */
export function readGeminiProjectRoot(sessionPath) {
	let dir = dirname(sessionPath);
	for (let i = 0; i < 3; i++) {
		dir = dirname(dir);
		try {
			const root = readFileSync(join(dir, ".project_root"), "utf8").trim();
			if (root) return root;
		} catch {
			// 한 단계 더 위로
		}
	}
	return null;
}

/** 새로 추가된 레코드에서 라이브 이벤트를 뽑는다. {kind, text, options?} */
export function extractGeminiEvents(entries) {
	const out = [];
	const emit = (m) => {
		if (m.type === "user") {
			const t = partText(m.content).trim();
			if (t && !isInjected(t)) out.push({ kind: "user", text: t.slice(0, EVENT_HEAD) });
		} else if (m.type === "gemini") {
			const t = partText(m.content).trim();
			if (t) out.push({ kind: "assistant", text: t });
			for (const call of toolCallsOf(m)) {
				if (call.name === ASK_TOOL) {
					for (const q of call.args?.questions ?? [])
						out.push({
							kind: "question",
							text: q.question,
							options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })),
						});
				}
				if (call.status === "error") out.push({ kind: "error", tool: call.name, text: errorSummary(resultText(call), EVENT_HEAD) });
			}
		} else if (m.type === "error") {
			const t = partText(m.content).trim();
			if (t) out.push({ kind: "error", text: errorSummary(t, EVENT_HEAD) });
		}
	};
	for (const e of entries) {
		if (Array.isArray(e?.$set?.messages)) for (const m of e.$set.messages) emit(m);
		else if (typeof e?.id === "string" && typeof e?.type === "string") emit(e);
	}
	return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [, , input, output] = process.argv;
	if (!input) {
		console.error("usage: transcript-gemini.mjs <session.jsonl> [out.md]");
		process.exit(2);
	}
	const md = normalizeGeminiSession(readFileSync(input, "utf8"), input);
	if (output) {
		writeFileSync(output, md);
		console.error(`wrote ${output} (${md.length} chars)`);
	} else process.stdout.write(md);
}
