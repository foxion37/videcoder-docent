// 설명 작업 (ADR 0029). 요청 하나 = 작업 하나. 같은 requestId 로 다시 오면 진행 중인 작업에 붙는다.
// 작업은 대기 → 분류 → 설명 → 완료·실패·중단 순서로 흐르고, 구독자에게 줄 단위 이벤트를 보낸다.
import { CancelledError } from "./runner.mjs";

const TERMINAL = new Set(["answer", "error", "cancelled"]);

export function jobRegistry() {
	const jobs = new Map();

	/**
	 * @param {{key: string, signature: string, meta: object, run: (job) => Promise<object>}} options
	 */
	function start({ key, signature, meta, run }) {
		const controller = new AbortController();
		const subscribers = new Set();
		const job = {
			key,
			signature,
			meta,
			stage: "queued",
			text: "",
			steers: [],
			steerHandler: null,
			signal: controller.signal,
			terminal: null,
			emit(line) {
				if (job.terminal) return;
				if (line.type === "delta") job.text += line.text;
				if (line.type === "reset") job.text = "";
				if (line.type === "stage") job.stage = line.stage;
				if (TERMINAL.has(line.type)) job.terminal = line;
				for (const fn of subscribers) fn(line);
			},
			/** 지금까지의 상태를 먼저 받고 이후 이벤트를 받는다. */
			subscribe(fn) {
				if (job.terminal) {
					fn(job.terminal);
					return () => {};
				}
				fn(job.stage === "queued" ? { type: "queued" } : { type: "stage", stage: job.stage });
				if (job.text) fn({ type: "delta", text: job.text });
				subscribers.add(fn);
				return () => subscribers.delete(fn);
			},
			cancel() {
				if (job.terminal) return false;
				controller.abort();
				return true;
			},
			/** 설명 중이면 바로 대화에 넣고, 분류 중이면 설명을 시작할 때 합친다. */
			steer(message) {
				if (job.terminal) return false;
				job.steers.push(message);
				if (job.steerHandler) job.steerHandler(message);
				job.emit({ type: "steer", message });
				return true;
			},
		};
		job.done = (async () => {
			try {
				const answer = await run(job);
				job.emit({ type: "answer", answer });
				return answer;
			} catch (error) {
				if (error instanceof CancelledError || error?.cancelled || controller.signal.aborted) {
					job.emit({ type: "cancelled" });
					throw Object.assign(new CancelledError(), { cancelled: true });
				}
				job.emit({ type: "error", status: error.status ?? 500, error: String(error.message ?? error) });
				throw error;
			} finally {
				jobs.delete(key);
			}
		})();
		job.done.catch(() => {});
		jobs.set(key, job);
		return job;
	}

	return {
		start,
		get: (key) => jobs.get(key),
		/** 세션·프로필의 진행 중 작업 (새로고침 뒤 다시 붙기용). */
		list: (filter) => [...jobs.values()].filter((job) => filter(job.meta)),
	};
}
