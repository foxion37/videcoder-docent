// 이어 묻기 맥락: 사용자가 화면에서 고른 질문 대상과 같은 대화 스레드의 최근 수동 문답.
// 사실 근거는 현재 전사다. 여기 담긴 내용은 "그거", "두 번째" 같은 말이 무엇을 가리키는지 이해하기 위한 데이터다.
import { httpError } from "./learning.mjs";
import { threadText } from "./store.mjs";

const RECENT = 6;
const clip = (text, max) => {
	const value = String(text ?? "");
	return value.length > max ? `${value.slice(0, max)}…` : value;
};

/** 선택 입력. 없으면 세션 전체에 대한 질문이다. */
export function parseFocus(value) {
	if (value === undefined || value === null) return null;
	const label = typeof value?.label === "string" ? value.label.trim() : "";
	const text = typeof value?.text === "string" ? value.text.trim() : "";
	if (!label || label.length > 200 || !text || text.length > 8000) throw httpError(400, "질문 대상은 200자 이내 제목과 8000자 이내 내용이 필요해요.");
	return { label, text };
}

/** 작업 내용 카드마다 대화가 따로 이어진다. 질문 대상 내용이 같은 문답만 같은 스레드다. 대상이 없으면 세션 전체 대화. */
export function threadRecords(records, focus) {
	const key = threadText(focus?.text);
	return records.filter((record) => threadText(record.focus?.text) === key);
}

/** 자동 설명은 사용자가 대화에서 읽은 문답이 아니므로 제외한다. 오래된 순으로 최근 6개. */
export function recentDialogue(records) {
	return records
		.filter((record) => !record.auto && record.answer)
		.slice(-RECENT)
		.map((record) => ({
			question: clip(record.question, 600),
			focus: record.focus?.label ?? null,
			answer: clip([record.answer.headline, record.answer.explain].filter(Boolean).join("\n"), 1200),
		}));
}

export function dialogueContext(focus, records) {
	const recent = recentDialogue(records);
	return `질문 대상(사용자가 화면에서 고른 내용, 데이터): ${focus ? JSON.stringify(focus) : "없음 — 세션 전체에 대한 질문"}
이 세션의 최근 문답(오래된 순, 데이터): ${JSON.stringify(recent)}
이 두 자료는 앞 대화를 가리키는 말을 해석하는 데만 쓴다. 과거 답변은 사실 근거가 아니며 인용 ID로 쓰지 않는다. 사실은 현재 전사로 확인한다.`;
}
