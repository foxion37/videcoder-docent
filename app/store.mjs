// 기존 questions.jsonl 은 기본 프로필의 역사로 보존한다. 새 기록과 학습 상태는 한 번에 원자적으로 저장한다.
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { rowKey } from "./wiki.mjs";

export const DOCENT_HOME = process.env.DOCENT_HOME ?? join(homedir(), ".docent");
const LEGACY_FILE = join(DOCENT_HOME, "questions.jsonl");
const STATE_FILE = join(DOCENT_HOME, "learning.json");
let writes = Promise.resolve();

const emptyState = () => ({
	version: 1,
	profiles: [{ id: "default", name: "기본", defaultDifficulty: "NORMAL", domainDifficulties: {}, model: null }],
	items: [],
	records: [],
	requests: {},
});

/** 이전 v1의 동일한 복사본만 접는다. 참조 원본이 없거나 내용이 다르면 보존한다. */
function compactAnswerCopies(state) {
	const records = new Map(state.records.map((record) => [`${record.profileId}:${record.recordId ?? record.id}`, record]));
	for (const [key, request] of Object.entries(state.requests)) {
		const profileId = request.profileId ?? key.slice(0, key.indexOf(":"));
		const recordId = request.recordId ?? request.answer?.recordId;
		const record = records.get(`${profileId}:${recordId}`);
		if (record?.answer && request.answer && isDeepStrictEqual(request.answer, record.answer)) {
			request.recordId = recordId;
			delete request.answer;
		}
	}
	for (const item of state.items) {
		for (const explanation of item.explanations) {
			const record = records.get(`${item.profileId}:${explanation.recordId}`);
			if (!record?.answer) continue;
			const shared = { sessionId: record.sessionId, ts: record.ts, question: record.question, explanation: record.answer.raw, difficulty: record.answer.difficulty, evidence: record.answer.citations, auto: record.auto, sourceFingerprint: record.sourceFingerprint };
			for (const [field, value] of Object.entries(shared)) {
				if (Object.hasOwn(explanation, field) && isDeepStrictEqual(explanation[field], value)) delete explanation[field];
			}
		}
		const latest = records.get(`${item.profileId}:${item.explanations.at(-1)?.recordId}`);
		if (latest?.answer && Object.hasOwn(item, "evidence") && isDeepStrictEqual(item.evidence, latest.answer.citations)) delete item.evidence;
	}
	return state;
}

export async function readState() {
	let text;
	try {
		text = await readFile(STATE_FILE, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return emptyState();
		throw error;
	}
	const state = JSON.parse(text);
	if (state.version !== 1 || !Array.isArray(state.profiles) || !state.profiles.some((p) => p.id === "default") || !Array.isArray(state.items) || !Array.isArray(state.records) || !state.requests || typeof state.requests !== "object" || Array.isArray(state.requests)) {
		throw new Error("학습 저장 파일 형식이 올바르지 않아요. 기존 파일을 보존하고 읽기를 중단했어요.");
	}
	for (const profile of state.profiles) profile.model ??= null;
	return compactAnswerCopies(state);
}

/** 모든 변경(기록+학습+요청 완료 포함)을 같은 파일에 커밋한다. 실패한 변경은 원본을 건드리지 않는다. */
export function updateState(change) {
	const next = writes.then(async () => {
		const state = await readState();
		const result = await change(state);
		await mkdir(DOCENT_HOME, { recursive: true });
		const temp = `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const file = await open(temp, "wx", 0o600);
			try {
				await file.writeFile(`${JSON.stringify(state)}\n`);
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temp, STATE_FILE);
		} finally {
			await rm(temp, { force: true });
		}
		return result;
	});
	writes = next.catch(() => {});
	return next;
}

export async function history(sessionId, profileId = "default") {
	const state = await readState();
	const rows = state.records.filter((row) => row.profileId === profileId && (!sessionId || row.sessionId === sessionId));
	if (profileId === "default") {
		let text;
		try {
			text = await readFile(LEGACY_FILE, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			text = "";
		}
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const row = JSON.parse(line);
				if (row && (!row.profileId || row.profileId === "default") && (!sessionId || row.sessionId === sessionId)) {
					const keywords = row.keywords ?? state.legacyKeywords?.[rowKey(row)];
					rows.push({ ...row, profileId: "default", ...(keywords ? { keywords } : {}) });
				}
			} catch {
				// 과거 append 중 잘린 줄만 건너뛴다. 학습 상태 파일 오류는 숨기지 않는다.
			}
		}
	}
	return rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/** 용어 추출 결과를 저장한다. 새 문답은 레코드에, 옛 questions.jsonl 줄은 원본을 고치지 않고 따로 보관한다. */
export function saveKeywords(profileId, byId) {
	return updateState((state) => {
		for (const [id, keywords] of Object.entries(byId)) {
			const record = state.records.find((row) => row.profileId === profileId && rowKey(row) === id);
			if (record) record.keywords = keywords;
			else if (profileId === "default") (state.legacyKeywords ??= {})[id] = keywords;
		}
		return Object.keys(byId).length;
	});
}

/** 대화 스레드는 세션과 질문 대상 내용으로 구분한다. 공백 차이는 같은 스레드로 본다. 빈 문자열은 세션 전체 대화. */
export const threadText = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

export async function favorites(profileId, sessionId) {
	const state = await readState();
	return (state.favorites ?? []).filter((entry) => entry.profileId === profileId && (!sessionId || entry.sessionId === sessionId)).map(({ sessionId: id, label, text, ts }) => ({ sessionId: id, label, text, ts }));
}

/** 즐겨찾기 켜기/끄기. 같은 스레드는 한 번만 저장한다. */
export function setFavorite(profileId, sessionId, focus, on) {
	return updateState((state) => {
		const list = (state.favorites ??= []);
		const text = threadText(focus?.text);
		const index = list.findIndex((entry) => entry.profileId === profileId && entry.sessionId === sessionId && threadText(entry.text) === text);
		if (on && index < 0) list.push({ profileId, sessionId, label: focus?.label ?? "세션 전체 대화", text: focus?.text ?? "", ts: new Date().toISOString() });
		if (!on && index >= 0) list.splice(index, 1);
		return { favorite: on };
	});
}

/** ~/.docent/config.json — {host, peers:{이름: URL}}. 없으면 {}. 비밀값은 여기 두지 않는다. */
export async function config() {
	const text = await readFile(join(DOCENT_HOME, "config.json"), "utf8").catch(() => "");
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch (e) {
		console.error(`docent: config.json 을 읽지 못했어요 (${e.message}). 무시하고 계속해요.`);
		return {};
	}
}
