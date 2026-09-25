// 라이브 이벤트 본문 다듬기. omp·Claude Code 추출기가 같이 쓴다.
const ERROR_LINE = /error|fail|fatal|exception|rejected|denied|not found|no such|cannot|can't|unable|timed? ?out|command not found|traceback|panic/i;
const FALSE_ALARM = /\b0 (failed|errors?)\b|no errors?\b/i;
const GENERIC = /^(command exited with code \d+|wall time:)/i; // 원인이 아니라 결과 표시. 다른 단서가 없을 때만
const MAX_LINES = 4;

/**
 * 도구 실패 본문에서 실제 문제를 말하는 줄을 앞에 세운다.
 * 테스트 요약("126 passed") 뒤에 진짜 에러(git 거부 등)가 붙는 경우 카드 첫 줄이 엉뚱해지는 것을 막는다.
 * 에러 줄이 없으면 마지막 줄들(대개 원인이 끝에 온다).
 */
export function errorSummary(text, max) {
	const lines = text
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim());
	let picked = lines.filter((l) => ERROR_LINE.test(l) && !FALSE_ALARM.test(l) && !GENERIC.test(l));
	if (picked.length > MAX_LINES) picked = picked.slice(-MAX_LINES);
	if (!picked.length) picked = lines.filter((l) => !GENERIC.test(l)).slice(-MAX_LINES);
	const rest = lines.filter((l) => !picked.includes(l));
	return [...picked, ...rest].join("\n").slice(0, max);
}

const QUESTION_MAX = 1500;
const OPTION_DESC_MAX = 400;

/**
 * ask/AskUserQuestion 호출의 질문과 선택지를 들여쓴 줄로. 호출 줄 아래 같은 source 안에 붙는다.
 * 이게 빠지면 전사에 "→ ask(...)"만 남아 도슨트가 무엇을 물었는지 모르고 엉뚱한 답을 한다.
 */
export function askQuestionLines(questions) {
	const out = [];
	for (const q of questions ?? []) {
		if (!q || typeof q !== "object") continue;
		const head = typeof q.header === "string" && q.header ? `[${q.header}] ` : "";
		const multi = q.multi === true || q.multiSelect === true ? " (여러 개 선택)" : "";
		out.push(`  질문: ${head}${String(q.question ?? "").slice(0, QUESTION_MAX)}${multi}`);
		const recommended = Number.isSafeInteger(q.recommended) ? q.recommended : -1;
		for (const [index, o] of (q.options ?? []).entries()) {
			if (!o || typeof o !== "object") continue;
			const desc = typeof o.description === "string" && o.description ? ` — ${o.description.slice(0, OPTION_DESC_MAX)}` : "";
			out.push(`    - ${String(o.label ?? "")}${desc}${index === recommended ? " (추천)" : ""}`);
		}
	}
	return out;
}
