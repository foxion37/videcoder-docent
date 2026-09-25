import assert from "node:assert/strict";
import test from "node:test";
import { prepareEvidence } from "../app/evidence.mjs";
import { extractCodexEvents, normalizeCodexSession, parseCodexLines, readCodexSessionMeta } from "../scripts/transcript-codex.mjs";

const jsonl = (entries) => entries.map((entry) => JSON.stringify(entry)).join("\n");

const sessionMeta = {
	type: "session_meta",
	timestamp: "2026-09-20T00:00:00Z",
	payload: { session_id: "codex-session-1", timestamp: "2026-09-20T00:00:00Z", cwd: "/tmp/work", originator: "codex-tui" },
};

const userMessage = (text, extra = []) => ({
	type: "response_item",
	timestamp: "2026-09-20T00:00:01Z",
	payload: {
		type: "message",
		id: `msg-${text}`,
		role: "user",
		content: [...extra, { type: "input_text", text }],
	},
});

const assistantMessage = (text) => ({
	type: "response_item",
	timestamp: "2026-09-20T00:00:02Z",
	payload: { type: "message", id: `amsg-${text.slice(0, 8)}`, role: "assistant", content: [{ type: "output_text", text }] },
});

const execCall = (callId, cmd) => ({
	type: "response_item",
	timestamp: "2026-09-20T00:00:03Z",
	payload: {
		type: "custom_tool_call",
		id: `ctc-${callId}`,
		call_id: callId,
		name: "exec",
		input: `const r = await tools.exec_command({\n  cmd: ${JSON.stringify(cmd)},\n  workdir: "/tmp/work"\n});\ntext(r.output);\n`,
	},
});

const execOutput = (callId, chunks) => ({
	type: "response_item",
	timestamp: "2026-09-20T00:00:04Z",
	payload: { type: "custom_tool_call_output", id: `ctco-${callId}`, call_id: callId, output: chunks.map((text) => ({ type: "input_text", text })) },
});

const fixture = [
	sessionMeta,
	{ type: "turn_context", payload: { turn_id: "turn-1", cwd: "/tmp/work", model: "gpt-9-test" } },
	userMessage("", [{ type: "input_text", text: "<environment_context><cwd>/tmp/work</cwd></environment_context>" }]),
	userMessage("로그 파일에서 에러 찾아줘"),
	{ type: "response_item", payload: { type: "reasoning", summary: [] } },
	assistantMessage("로그를 살펴보겠습니다."),
	execCall("call-1", "tail -50 app.log"),
	execOutput("call-1", ["Script completed\nWall time 0.1 seconds\nOutput:\n", "line one\nline two"]),
	execCall("call-2", "cat missing.txt"),
	execOutput("call-2", ["Script failed\nWall time 0.0 seconds\nOutput:\n", "cat: missing.txt: No such file or directory"]),
	assistantMessage("에러를 찾았습니다."),
	{ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "에러를 찾았습니다." } },
];

test("codex normalize renders header, roles, tool call and result lines", () => {
	const md = normalizeCodexSession(jsonl(fixture), "codex:test/rollout.jsonl");
	assert.match(md, /^# 로그 파일에서 에러 찾아줘/);
	assert.ok(md.includes("- 원본: codex:test/rollout.jsonl"));
	assert.ok(md.includes("- 작업 폴더: /tmp/work"));
	assert.ok(md.includes("- 시작: 2026-09-20T00:00:00Z"));
	assert.ok(md.includes("## user"));
	assert.ok(md.includes("## assistant"));
	assert.ok(md.includes("로그 파일에서 에러 찾아줘"));
	assert.ok(md.includes("로그를 살펴보겠습니다."));
	assert.match(md, /→ exec\(tail -50 app\.log\)/);
	assert.match(md, /⇒ exec ok\b.*\d+줄/);
	assert.match(md, /⇒ exec 에러\n {2}Script failed/);
	assert.ok(md.includes("(모델: gpt-9-test)"));
	// 주입 컨텍스트와 reasoning 은 전사에 나오지 않는다
	assert.ok(!md.includes("environment_context"));
	assert.ok(!md.includes("환경 컨텍스트만"));
});

test("codex normalize marks sources citable by prepareEvidence", () => {
	const md = normalizeCodexSession(jsonl(fixture), "codex:test/rollout.jsonl");
	const { sources } = prepareEvidence(md, "codex:test/rollout.jsonl");
	assert.ok(sources.size > 0);
	const utterance = [...sources.values()].find((s) => s.text.includes("로그 파일에서 에러 찾아줘"));
	assert.ok(utterance, "no source contains the user utterance");
});

test("codex meta reads title, cwd, started, first from head", () => {
	const meta = readCodexSessionMeta(jsonl(fixture));
	assert.equal(meta.title, "로그 파일에서 에러 찾아줘");
	assert.equal(meta.cwd, "/tmp/work");
	assert.equal(meta.started, "2026-09-20T00:00:00Z");
	assert.equal(meta.first, "로그 파일에서 에러 찾아줘");
});

test("codex meta returns null without a real user utterance", () => {
	const onlyContext = [sessionMeta, userMessage("", [{ type: "input_text", text: "<environment_context><cwd>/tmp</cwd></environment_context>" }])];
	assert.equal(readCodexSessionMeta(jsonl(onlyContext)), null);
});

test("codex meta unwraps files-mentioned wrapper to the request", () => {
	const wrapped = [
		sessionMeta,
		userMessage("# Files mentioned by the user:\n\n## spec.md: /tmp/spec.md\n\n## My request:\n이 문서 요약해줘"),
	];
	const meta = readCodexSessionMeta(jsonl(wrapped));
	assert.equal(meta.first, "이 문서 요약해줘");
	assert.equal(meta.title, "이 문서 요약해줘");
});

test("codex events extract user, assistant, error and done", () => {
	const events = extractCodexEvents(parseCodexLines(jsonl(fixture)));
	const kinds = events.map((e) => e.kind);
	assert.deepEqual(kinds, ["user", "assistant", "error", "assistant", "done"]);
	assert.equal(events[0].text, "로그 파일에서 에러 찾아줘");
	assert.ok(events[2].text.includes("No such file or directory"));
});

test("codex request_user_input renders question and options", () => {
	const ask = [
		sessionMeta,
		userMessage("로그인 어디서 했어?"),
		{
			type: "response_item",
			payload: {
				type: "function_call",
				id: "fc-ask",
				call_id: "call-ask",
				name: "request_user_input_async",
				arguments: JSON.stringify({ questions: [{ title: "어느 기기에서 로그인했나요?", options: ["맥북", "맥미니", "다른 기기"] }] }),
			},
		},
		{ type: "response_item", payload: { type: "function_call_output", id: "fco-ask", call_id: "call-ask", output: '{"accepted":true}' } },
	];
	const md = normalizeCodexSession(jsonl(ask), "codex:test/ask.jsonl");
	assert.ok(md.includes("→ request_user_input_async("));
	assert.ok(md.includes("어느 기기에서 로그인했나요?"));
	assert.ok(md.includes("맥북"));
	assert.ok(md.includes("다른 기기"));
	const events = extractCodexEvents(parseCodexLines(jsonl(ask)));
	const q = events.find((e) => e.kind === "question");
	assert.equal(q.text, "어느 기기에서 로그인했나요?");
	assert.deepEqual(q.options.map((o) => o.label), ["맥북", "맥미니", "다른 기기"]);
});

test("codex compacted and aborted render as system lines", () => {
	const md = normalizeCodexSession(
		jsonl([
			sessionMeta,
			userMessage("작업해줘"),
			{ type: "compacted", payload: { message: "", replacement_history: [] } },
			{ type: "event_msg", payload: { type: "turn_aborted", turn_id: "t", reason: "interrupted" } },
		]),
	);
	assert.match(md, /이전 대화가 요약.*압축/);
	assert.ok(md.includes("(사용자가 실행을 중단함: interrupted)"));
});

test("codex tool call without result shows pending marker", () => {
	const md = normalizeCodexSession(jsonl([sessionMeta, userMessage("확인해줘"), execCall("call-x", "ls")]));
	assert.ok(md.includes("(결과 없음)"));
});

test("codex parse skips broken lines", () => {
	const entries = parseCodexLines(`${JSON.stringify(sessionMeta)}\n{"broken": \n${JSON.stringify(userMessage("안녕"))}`);
	assert.equal(entries.length, 2);
});
