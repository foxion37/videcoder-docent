#!/usr/bin/env node
// Claude Code 세션 jsonl (~/.claude/projects/<dir>/<id>.jsonl) → 사람이 읽는 전사 markdown.
// 출력 모양은 transcript-omp.mjs 와 같다. 도슨트는 둘을 구분하지 않는다.
// 서브에이전트 전사(<dir>/<id>/subagents/**/agent-*.jsonl)는 본 전사 안에 접어 넣는다 (ADR 0013).
// CLI:    scripts/transcript-claude.mjs <session.jsonl> [out.md]
// module: import { normalizeClaudeSession, readClaudeSessionMeta, readClaudeSubagents } from "./transcript-claude.mjs"
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { errorSummary } from "./event-text.mjs";
import { boundSourceBlocks, sourceWriter } from "./transcript-source.mjs";

const ERROR_LINES = 8;
const USER_MAX = 4000;
const TITLE_MAX = 60;
const SUB_PREFIX = "  │ ";
const SUB_PROMPT_MAX = 300; // 서브에이전트가 받은 지시문
const SUB_TEXT_MAX = 400; // 서브에이전트 발화 하나
const SUB_MAX = 8000; // 서브에이전트 블록 하나. 넘치면 가운데를 줄인다
const SUB_HEAD = 3000;
const SUB_TAIL = 4000;
export const parseClaudeLines = (jsonl) => {
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
};

const blockText = (content) =>
	typeof content === "string"
		? content
		: (content ?? [])
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");

const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}\n…(잘림)` : s);

const summarizeInput = (input) => {
	if (!input) return "";
	if (typeof input.description === "string") return input.description;
	const first = Object.values(input).find((v) => typeof v === "string");
	return first ? clip(first.replace(/\s+/g, " "), 100) : "";
};

/** 첫 사용자 발화(메타·도구결과 제외). 제목과 목록용. */
const firstUserText = (entries) => {
	for (const e of entries) {
		if (e.type !== "user" || e.isMeta || e.isSidechain) continue;
		const t = blockText(e.message?.content).trim();
		if (t) return t;
	}
	return null;
};

export function readClaudeSessionMeta(jsonl) {
	const entries = parseClaudeLines(jsonl);
	const withCwd = entries.find((e) => e.cwd);
	const first = firstUserText(entries);
	const title = first ? clip(first.split("\n")[0].replace(/^<command-name>(.*?)<\/command-name>.*/s, "$1"), TITLE_MAX).replace("\n…(잘림)", "…") : "(제목 없음)";
	const flat = first ? first.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
	return { title, cwd: withCwd?.cwd ?? null, started: withCwd?.timestamp ?? entries[0]?.timestamp ?? null, first: flat ? (flat.length > 140 ? `${flat.slice(0, 140)}…` : flat) : null };
}

/**
 * 세션 옆 폴더의 서브에이전트 전사를 읽는다. `<dir>/<sessionId>/subagents/**\/agent-<id>.jsonl` + `.meta.json`.
 * 폴더가 없으면 빈 배열. 각 항목: {id, jsonl, meta:{agentType, description, toolUseId, model}}.
 */
export async function readClaudeSubagents(sessionPath) {
	const root = join(dirname(sessionPath), basename(sessionPath, ".jsonl"), "subagents");
	const out = [];
	const walk = async (dir) => {
		const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const d of ents) {
			const p = join(dir, d.name);
			if (d.isDirectory()) await walk(p);
			else if (/^agent-.*\.jsonl$/.test(d.name)) {
				const id = d.name.slice(6, -6);
				const meta = await readFile(join(dir, `agent-${id}.meta.json`), "utf8")
					.then(JSON.parse)
					.catch(() => ({}));
				out.push({ id, sourceId: relative(root, p), jsonl: await readFile(p, "utf8"), meta });
			}
		}
	};
	await walk(root);
	return out;
}

const toolResults = (entries) => {
	const results = new Map();
	for (const entry of entries) {
		if (entry.type !== "user" || !Array.isArray(entry.message?.content)) continue;
		for (const result of entry.message.content) if (result.type === "tool_result") results.set(result.tool_use_id, { entry, result });
	}
	return results;
};

const toolBlocks = (entry, call, results, mark, prefix = "") => {
	const out = [mark(entry, `${prefix}→ ${call.name}(${summarizeInput(call.input)})`, { role: "assistant", part: `tool:${call.id}` })];
	const found = results.get(call.id);
	if (!found) return [...out, `${prefix}  (결과 없음)`];
	const r = found.result;
	const body = blockText(r.content);
	const n = body ? body.split("\n").length : 0;
	let summary;
	if (r.is_error) summary = `⇒ ${call.name} 에러\n  ${body.split("\n").slice(0, ERROR_LINES).join("\n  ")}`;
	else if (call.name === "AskUserQuestion") summary = `⇒ ${call.name} 사용자 답:\n  ${clip(body, USER_MAX).split("\n").join("\n  ")}`;
	else summary = `⇒ ${call.name} ok · ${n}줄`;
	out.push(mark(found.entry, summary.split("\n").map((line) => prefix + line).join("\n"), { role: "tool", part: `result:${call.id}`, original: r }));
	return out;
};

/** Embedded agents keep their own source identity without introducing user turn headings. */
function subagentBlock(sub, namespace) {
	const entries = parseClaudeLines(sub.jsonl);
	const results = toolResults(entries);
	const { agentType, description, model } = sub.meta;
	const who = [agentType ?? "서브에이전트", model ? `(${model})` : ""].join("");
	const mark = sourceWriter(`${namespace}:agent:${sub.sourceId ?? sub.id}`, `${agentType ?? "서브에이전트"} (${sub.id})`);
	const blocks = [];
	let first = true;
	for (const e of entries) {
		if (e.type === "user") {
			if (e.isMeta) continue;
			const t = blockText(e.message?.content).trim();
			if (!t) continue;
			const body = first ? `(지시) ${clip(t.replace(/\s+/g, " "), SUB_PROMPT_MAX)}` : `(사용자) ${clip(t, SUB_TEXT_MAX)}`;
			blocks.push(mark(e, body.split("\n").map((line) => SUB_PREFIX + line).join("\n"), { role: "user" }));
			first = false;
		} else if (e.type === "assistant") {
			for (const [index, b] of (e.message?.content ?? []).entries()) {
				if (b.type === "text" && b.text.trim()) {
					const body = clip(b.text.trim(), SUB_TEXT_MAX).split("\n").map((line) => SUB_PREFIX + line).join("\n");
					blocks.push(mark(e, body, { role: "assistant", part: `text:${index}` }));
				} else if (b.type === "tool_use") blocks.push(...toolBlocks(e, b, results, mark, SUB_PREFIX));
			}
		}
	}
	return [
		`${SUB_PREFIX}서브에이전트 ${who}${description ? ` 「${description}」` : ""} 이 한 일:`,
		...boundSourceBlocks(blocks, SUB_MAX, SUB_HEAD, SUB_TAIL),
	];
}

const firstTimestamp = (jsonl) => {
	const nl = jsonl.indexOf("\n");
	try {
		return JSON.parse(nl < 0 ? jsonl : jsonl.slice(0, nl)).timestamp ?? "";
	} catch {
		return "";
	}
};

/**
 * @param {string} jsonl 본 세션
 * @param {string} source 헤더에 적을 원본 표시
 * @param {Awaited<ReturnType<typeof readClaudeSubagents>>} subagents 접어 넣을 서브에이전트. `Agent` 호출에 매인 것(meta.toolUseId)은 그 호출 줄 아래에,
 *   나머지(워크플로 등)는 시작 시각 순으로 본 전사 사이에 끼운다.
 */
export function normalizeClaudeSession(jsonl, source = "", subagents = []) {
	const entries = parseClaudeLines(jsonl).filter((e) => !e.isSidechain);
	const results = toolResults(entries);
	const namespace = `claude:${entries.find((entry) => entry.sessionId)?.sessionId ?? ""}`;
	const mark = sourceWriter(namespace);

	const toolIds = new Set();
	for (const e of entries) if (e.type === "assistant") for (const b of e.message?.content ?? []) if (b.type === "tool_use") toolIds.add(b.id);
	const linked = new Map();
	const timed = [];
	for (const s of subagents) {
		if (s.meta.toolUseId && toolIds.has(s.meta.toolUseId)) linked.set(s.meta.toolUseId, s);
		else timed.push({ at: firstTimestamp(s.jsonl), sub: s });
	}
	timed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

	const meta = readClaudeSessionMeta(jsonl);
	const out = [`# ${meta.title}`, "", `- 원본: ${source}`, `- 작업 폴더: ${meta.cwd ?? "?"}`, `- 시작: ${meta.started ?? "?"}`, ""];

	let lastRole = null;
	const section = (role) => {
		if (role !== lastRole) out.push("", `## ${role}`, "");
		lastRole = role;
	};
	const flushTimed = (before) => {
		while (timed.length && (!before || timed[0].at <= before)) {
			section("assistant");
			out.push(...subagentBlock(timed.shift().sub, namespace));
		}
	};

	let lastModel = null;
	for (const e of entries) {
		if (e.timestamp) flushTimed(e.timestamp);
		if (e.type === "user") {
			if (e.isMeta) continue;
			const c = e.message?.content;
			const t = blockText(c).trim();
			if (!t) continue; // 순수 tool_result 묶음
			section("user");
			out.push(mark(e, clip(t, USER_MAX), { role: "user" }));
		} else if (e.type === "assistant") {
			const m = e.message;
			if (m?.model && m.model !== lastModel) {
				lastModel = m.model;
				section("system");
				out.push(mark(e, `(모델: ${m.model})`, { role: "system", part: "model", original: { model: m.model } }));
			}
			if (e.isApiErrorMessage) {
				section("system");
				out.push(mark(e, `(API 오류${e.apiErrorStatus ? ` ${e.apiErrorStatus}` : ""})`, { role: "system", part: "api-error" }));
				continue;
			}
			section("assistant");
			for (const [index, b] of (m?.content ?? []).entries()) {
				if (b.type === "text" && b.text.trim()) out.push(mark(e, b.text.trim(), { role: "assistant", part: `text:${index}` }));
				else if (b.type === "tool_use") {
					out.push(...toolBlocks(e, b, results, mark));
					if (linked.has(b.id)) out.push(...subagentBlock(linked.get(b.id), namespace));
				}
			}
		}
	}
	flushTimed(null);

	return `${out.join("\n")}\n`;
}

const EVENT_HEAD = 600;

/** 새로 추가된 엔트리에서 라이브 이벤트를 뽑는다. 사이드체인·메타 제외. */
export function extractClaudeEvents(entries) {
	const out = [];
	for (const e of entries) {
		if (e.isSidechain) continue;
		if (e.type === "user") {
			if (e.isMeta) continue;
			const c = e.message?.content;
			if (Array.isArray(c)) {
				for (const b of c) if (b.type === "tool_result" && b.is_error) out.push({ kind: "error", text: errorSummary(blockText(b.content), EVENT_HEAD) });
			}
			const t = blockText(c).trim();
			if (t) out.push({ kind: "user", text: t.slice(0, EVENT_HEAD) });
		} else if (e.type === "assistant") {
			for (const b of e.message?.content ?? []) {
				if (b.type === "text" && b.text.trim()) out.push({ kind: "assistant", text: b.text.trim() });
				else if (b.type === "tool_use" && b.name === "AskUserQuestion") {
					for (const q of b.input?.questions ?? [])
						out.push({ kind: "question", text: q.question, options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })) });
				}
			}
		}
	}
	return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [, , input, output] = process.argv;
	if (!input) {
		console.error("usage: transcript-claude.mjs <session.jsonl> [out.md]");
		process.exit(2);
	}
	const md = normalizeClaudeSession(readFileSync(input, "utf8"), input, await readClaudeSubagents(input));
	if (output) {
		writeFileSync(output, md);
		console.error(`wrote ${output} (${md.length} chars)`);
	} else process.stdout.write(md);
}
