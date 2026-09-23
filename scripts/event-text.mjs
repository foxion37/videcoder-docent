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
