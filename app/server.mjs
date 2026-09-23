// 도슨트 로컬 웹앱. 서버는 Node 내장 모듈, 설명 렌더러는 로컬 빌드 자산을 사용한다.
import { execFile } from "node:child_process";
import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractClaudeEvents, normalizeClaudeSession, parseClaudeLines, readClaudeSessionMeta, readClaudeSubagents } from "../scripts/transcript-claude.mjs";
import { extractOmpEvents, normalizeOmpSession, parseOmpLines, readOmpSessionMeta } from "../scripts/transcript-omp.mjs";
import { jevEnabled } from "./jev.mjs";
import { watchSession } from "./live.mjs";
import { extractTerms, filterTerms, glossary } from "./review.mjs";
import { KEYWORD_PROMPT, extractInput, parseExtract, wiki } from "./wiki.mjs";
import { parseAnswer } from "./slots.mjs";
import { parsePeers, peerProvider } from "./peers.mjs";
import { config, favorites, history, saveKeywords, setFavorite } from "./store.mjs";
import { MAX_CHARS, trimTranscript } from "./trim.mjs";
import { extractCitations, prepareEvidence, resolveEvidence, retainEvidence } from "./evidence.mjs";
import { modelCatalog, selectedModel } from "./models.mjs";
import { PLANNING_PROMPT, completeLearning, createProfile, explanationContext, feedback, httpError, idempotentAsk, learningItems, parsePlan, planningContext, planningInput, profile, profiles, resolveDifficulty, sourceScope, updateProfile } from "./learning.mjs";
import { dialogueContext, parseFocus, threadRecords } from "./dialogue.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATIC_ASSETS = new Map([
	["/assets/docent-markdown.js", ["assets/docent-markdown.js", "text/javascript; charset=utf-8"]],
	["/assets/docent-markdown.css", ["assets/docent-markdown.css", "text/css; charset=utf-8"]],
	["/assets/PretendardVariable.woff2", ["assets/PretendardVariable.woff2", "font/woff2", "public, max-age=604800"]],
	["/assets/Pretendard-LICENSE.txt", ["assets/Pretendard-LICENSE.txt", "text/plain; charset=utf-8"]],
]);
const PROMPT = resolve(ROOT, "../prompt/docent.md");
const CONFIG = await config();
const PORT = Number(process.env.DOCENT_PORT ?? CONFIG.port ?? 4747);
const HOST = await resolveHost(process.env.DOCENT_HOST ?? CONFIG.host ?? "127.0.0.1");
const PEERS = parsePeers(process.env.DOCENT_PEERS, CONFIG.peers);
const OMP_BIN = process.env.OMP_BIN ?? "omp";
const OMP_TIMEOUT_MS = 180_000;
const MAX_SESSION_BYTES = 80 * 1024 * 1024;

const HOME = process.env.HOME ?? "";

/** "tailscale" 이면 이 컴퓨터의 테일스케일 IPv4 로. 그 외는 그대로. */
async function resolveHost(host) {
	if (host !== "tailscale") return host;
	const bins = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
	for (const bin of bins) {
		const ip = await new Promise((res) => execFile(bin, ["ip", "-4"], (err, out) => res(err ? null : out.trim().split("\n")[0])));
		if (ip) return ip;
	}
	throw new Error("tailscale ip 를 알 수 없어요. tailscale 이 켜져 있는지 확인하세요.");
}

/** `<root>/<dir>/<file>.jsonl` 구조의 세션 폴더 하나를 제공자로. */
function jsonlProvider({ id, root, headBytes, meta, normalize, parse, events }) {
	return {
		id,
		root,
		parse,
		events,
		async list() {
			const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
			const out = [];
			for (const d of dirs) {
				if (!d.isDirectory()) continue;
				const dir = join(root, d.name);
				const files = await readdir(dir).catch(() => []);
				for (const f of files) {
					if (!f.endsWith(".jsonl")) continue;
					const path = join(dir, f);
					const st = await stat(path);
					if (st.size === 0) continue;
					const m = meta(await readHead(path, headBytes));
					if (!m) continue;
					out.push({
						id: `${id}:${d.name}/${f}`,
						provider: id,
						title: m.title,
						project: m.cwd ? basename(m.cwd) : d.name,
						cwd: m.cwd,
						started: m.started,
						updated: st.mtime.toISOString(),
						bytes: st.size,
						first: m.first ?? null,
						host: null,
					});
				}
			}
			return out;
		},
		pathOf(sid) {
			const path = resolve(root, sid.slice(id.length + 1));
			if (!path.startsWith(`${root}/`) || !path.endsWith(".jsonl")) throw httpError(400, "bad session id");
			return path;
		},
		async transcript(sid) {
			const path = this.pathOf(sid);
			const st = await stat(path);
			if (st.size > MAX_SESSION_BYTES) throw httpError(413, "session too large");
			return normalize(await readFile(path, "utf8"), path);
		},
	};
}

// 호스트별 세션 제공자. 새 호스트는 정규화 함수 + 항목 하나. 뒤에 원격 docent(peers)가 붙는다.
const providers = [
	jsonlProvider({
		id: "omp",
		root: join(HOME, ".omp/agent/sessions"),
		headBytes: 256 * 1024, // session_init 의 시스템 프롬프트 뒤에 첫 사용자 발화가 온다
		meta: readOmpSessionMeta,
		normalize: normalizeOmpSession,
		parse: parseOmpLines,
		events: extractOmpEvents,
	}),
	jsonlProvider({
		id: "claude",
		root: join(HOME, ".claude/projects"),
		headBytes: 256 * 1024, // 첫 사용자 발화 앞에 attachment 가 길게 붙을 수 있음
		meta: (head) => {
			const m = readClaudeSessionMeta(head);
			return m.title === "(제목 없음)" ? null : m; // 사용자 발화 없는 세션(로그인 등)은 숨김
		},
		normalize: async (jsonl, path) => normalizeClaudeSession(jsonl, path, await readClaudeSubagents(path)),
		parse: parseClaudeLines,
		events: extractClaudeEvents,
	}),
	...Object.entries(PEERS).map(([name, base]) => peerProvider(name, base)),
];

async function readHead(path, bytes) {
	const fh = await open(path, "r");
	try {
		const buf = Buffer.alloc(bytes);
		const { bytesRead } = await fh.read(buf, 0, bytes, 0);
		// 마지막 불완전한 줄은 파서가 버린다
		return buf.subarray(0, bytesRead).toString("utf8");
	} finally {
		await fh.close();
	}
}

const providerOf = (id) => {
	const p = providers.find((p) => (p.owns ? p.owns(id) : id.startsWith(`${p.id}:`)));
	if (!p) throw httpError(400, "unknown provider");
	return p;
};

function runOmp(transcriptPath, question, instructions = "", systemPrompt = PROMPT, model = null) {
	const prompt = `전사: ${transcriptPath}\n질문(데이터): ${question}\n\n${instructions}`;
	const args = ["-p", "--no-session", "--no-title", "--tools", "read", "--system-prompt", systemPrompt];
	if (model) args.push("--provider", model.provider, "--model", model.selector);
	args.push(prompt);
	return new Promise((res, rej) => {
		const child = execFile(
			OMP_BIN,
			args,
			{ timeout: OMP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, TERM: "dumb" } },
			(err, stdout) => {
				if (err) return rej(httpError(502, `설명 생성기를 실행하지 못했어요 (${err.killed ? "시간 제한 또는 실행 중단" : err.code ?? "실행 오류"}). 요청 내용과 비밀값 보호를 위해 원시 실행 로그는 저장하지 않아요.`));
				// print 모드가 앞에 붙이는 진행 표시줄 제거
				const lines = stdout.split("\n");
				while (lines.length && /^(Working\.\.\.|\s*)$/.test(lines[0])) lines.shift();
				const output = lines.join("\n").trim();
				if (!output) return rej(httpError(502, "설명 생성기가 빈 응답을 반환했어요."));
				res(output);
			},
		);
		// stdin 을 닫아야 omp 가 "piped input" 으로 오인해 EOF 를 기다리지 않는다
		child.stdin?.end();
	});
}

const json = (r, code, body) => {
	r.writeHead(code, { "content-type": "application/json; charset=utf-8" });
	r.end(JSON.stringify(body));
};

const readBody = (req) =>
	new Promise((res, rej) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 64 * 1024) {
				chunks.length = 0;
				rej(httpError(413, "요청 본문이 너무 커요."));
			} else chunks.push(chunk);
		});
		req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
		req.on("error", rej);
	});

const tmpRoot = await mkdtemp(join(tmpdir(), "docent-"));
const plannerPrompt = join(tmpRoot, "learning-planner.txt");
await writeFile(plannerPrompt, PLANNING_PROMPT);
const keywordPrompt = join(tmpRoot, "keyword-extractor.txt");
await writeFile(keywordPrompt, KEYWORD_PROMPT);
const extracting = new Map();

/** 아직 단어를 뽑지 않은 문답을 모델 호출 한 번으로 정리한다. 같은 프로필의 동시 요청은 하나로 합친다. */
function extractKeywords(profileId) {
	if (extracting.has(profileId)) return extracting.get(profileId);
	const job = (async () => {
		const current = await profile(profileId);
		const { ids, input } = extractInput(await history(undefined, profileId));
		if (!ids.length) return { updated: 0 };
		const model = await selectedModel(current.model);
		let byId;
		try {
			byId = parseExtract(await runOmp("(없음)", input, "위 문답 목록에서 용어를 뽑아 형식대로 출력한다.", keywordPrompt, model), ids);
		} catch (error) {
			if (error.status) throw error;
			throw httpError(502, "용어 추출 결과를 읽지 못했어요. 다시 시도해 주세요.");
		}
		return { updated: await saveKeywords(profileId, byId) };
	})();
	extracting.set(profileId, job);
	job.finally(() => extracting.delete(profileId)).catch(() => {});
	return job;
}

async function body(req) {
	let value;
	try {
		value = JSON.parse(await readBody(req));
	} catch (error) {
		if (error.status) throw error;
		throw httpError(400, "JSON 요청 본문이 올바르지 않아요.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "JSON 객체가 필요해요.");
	return value;
}

async function ask(input) {
	const { id, question, difficulty } = input;
	const profileId = input.profileId ?? "default";
	const requestId = input.requestId ?? randomUUID();
	if (typeof id !== "string" || !id || id.length > 2048 || typeof question !== "string" || !question.trim() || question.length > 8000) throw httpError(400, "유효한 세션 id 와 8000자 이내의 질문이 필요해요.");
	if (input.auto !== undefined && typeof input.auto !== "boolean") throw httpError(400, "auto 는 참/거짓이어야 해요.");
	const focus = parseFocus(input.focus);
	const current = await profile(profileId);
	resolveDifficulty(current, [], difficulty);
	const q = question.trim();
	const auto = Boolean(input.auto);
	return idempotentAsk(profileId, requestId, { id, question: q, ...(focus ? { focus } : {}), auto, difficulty: difficulty ?? null }, async (request) => {
		// A replay returns its original answer without resolving the profile's newer selection.
		const model = await selectedModel(current.model);
		const p = providerOf(id);
		const original = await p.transcript(id);
		const source = sourceScope(id, p.host, original);
		const prepared = prepareEvidence(original, id);
		let transcript = trimTranscript(prepared.transcript);
		if (transcript.length > MAX_CHARS) transcript = `## system\n\n(전사가 매우 길어 최근 부분만 제공해요. 잘린 부분은 근거로 인용하지 마세요.)\n\n${transcript.slice(-MAX_CHARS)}`;
		const evidence = retainEvidence(prepared, transcript);
		const file = join(tmpRoot, `${randomUUID()}.txt`);
		const t0 = Date.now();
		try {
			await writeFile(file, evidence.transcript, { mode: 0o600 });
			const context = await planningContext(profileId, source, q, auto, focus);
			let plan;
			try {
				plan = parsePlan(await runOmp(file, planningInput(context), "", plannerPrompt, model), context);
			} catch (error) {
				if (model) throw error;
				plan = { ...parsePlan("", context), warning: "학습 분류를 실행하지 못했어요. 개념·분야를 추측하지 않고 질문별 또는 기본 설명 깊이로 답했어요." };
			}
			const depth = resolveDifficulty(context.profile, plan.domains, difficulty);
			const generated = await runOmp(file, q, `${explanationContext(context, plan, depth)}\n${dialogueContext(focus, threadRecords(await history(id, profileId), focus))}`, PROMPT, model);
			const { raw, citations } = extractCitations(generated, evidence);
			const ruleTerms = extractTerms(raw);
			const jevTerms = await filterTerms(raw, ruleTerms);
			const terms = jevTerms ?? ruleTerms;
			const termsBy = jevTerms ? "jev" : "rule";
			const answer = { raw, ...parseAnswer(raw), ms: Date.now() - t0, ...depth, kind: plan.kind, terms, citations, requestId, model: model?.selector ?? null };
			return await completeLearning(request, context, plan, answer, { provider: p.id, project: source.cwd ? basename(source.cwd) : null, kind: plan.kind, terms, termsBy });
		} finally {
			await rm(file, { force: true }).catch((error) => console.error(`docent: 임시 전사를 지우지 못했어요 (${error.message})`));
		}
	});
}

async function evidenceFor(sessionId, ref, profileId) {
	await profile(profileId);
	if (!sessionId || typeof ref !== "string" || !/^s_[a-f0-9]{40}$/.test(ref)) throw httpError(400, "유효한 세션과 근거 ID가 필요해요.");
	const rows = await history(sessionId, profileId);
	const saved = rows.flatMap((row) => row.answer?.citations ?? []).find((citation) => citation.id === ref && citation.sessionId === sessionId);
	if (!saved) throw httpError(404, "이 프로필이 저장한 근거를 찾을 수 없어요.");
	try {
		const result = resolveEvidence(await providerOf(sessionId).transcript(sessionId), sessionId, ref);
		if (result.available) return result;
	} catch {
		// 원격 오프라인·원본 삭제도 저장된 근거와 구분해서 보여 준다.
	}
	return { available: false, message: "원본 전사가 없거나 변경되어 원문을 열 수 없어요. 아래는 이 프로필의 답변에 저장된 당시 발췌예요.", selected: { id: saved.id, text: saved.excerpt, role: saved.role, timestamp: saved.timestamp, agent: saved.agent }, before: [], after: [] };
}

const handler = async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	try {
		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
			return res.end(await readFile(join(ROOT, "index.html")));
		}
		if (req.method === "GET" && url.pathname === "/favicon.svg") {
			res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" });
			return res.end(await readFile(join(ROOT, "favicon.svg")));
		}
		const asset = STATIC_ASSETS.get(url.pathname);
		if (req.method === "GET" && asset) {
			const content = await readFile(join(ROOT, asset[0]));
			res.writeHead(200, { "content-type": asset[1], "cache-control": asset[2] ?? "no-cache", "x-content-type-options": "nosniff" });
			return res.end(content);
		}
		if (req.method === "GET" && url.pathname === "/api/models") return json(res, 200, await modelCatalog());
		if (req.method === "GET" && url.pathname === "/api/profiles") return json(res, 200, await profiles());
		if (req.method === "POST" && url.pathname === "/api/profiles") return json(res, 201, await createProfile((await body(req)).name));
		const profileRoute = /^\/api\/profiles\/([^/]+)$/.exec(url.pathname);
		if (req.method === "PATCH" && profileRoute) return json(res, 200, await updateProfile(decodeURIComponent(profileRoute[1]), await body(req)));
		if (req.method === "GET" && url.pathname === "/api/learning") return json(res, 200, { items: await learningItems(url.searchParams.get("profileId") ?? "default") });
		const learningRoute = /^\/api\/learning\/([^/]+)$/.exec(url.pathname);
		if (req.method === "PATCH" && learningRoute) {
			const input = await body(req);
			return json(res, 200, await feedback(decodeURIComponent(learningRoute[1]), input.profileId ?? "default", input.status, input.unresolved));
		}
		if (req.method === "GET" && url.pathname === "/api/evidence") {
			return json(res, 200, await evidenceFor(url.searchParams.get("id"), url.searchParams.get("ref"), url.searchParams.get("profileId") ?? "default"));
		}
		if (req.method === "GET" && url.pathname === "/api/sessions") {
			const all = (await Promise.all(providers.map((p) => p.list()))).flat();
			all.sort((a, b) => (a.updated < b.updated ? 1 : -1));
			return json(res, 200, all.slice(0, 200));
		}
		if (req.method === "GET" && url.pathname === "/api/transcript") {
			const id = url.searchParams.get("id") ?? "";
			const md = await providerOf(id).transcript(id);
			res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
			return res.end(md);
		}
		if (req.method === "GET" && url.pathname === "/api/history") {
			const id = url.searchParams.get("id") || undefined;
			const profileId = url.searchParams.get("profileId") ?? "default";
			await profile(profileId);
			// 원격의 같은 이름/ID는 같은 사람이라는 증거가 아니다. 여기서 선택한 프로필의 기록만 읽는다.
			return json(res, 200, await history(id, profileId));
		}
		if (req.method === "GET" && url.pathname === "/api/glossary") {
			const profileId = url.searchParams.get("profileId") ?? "default";
			await profile(profileId);
			return json(res, 200, glossary(await history(undefined, profileId)));
		}
		if (req.method === "GET" && url.pathname === "/api/favorites") {
			const profileId = url.searchParams.get("profileId") ?? "default";
			await profile(profileId);
			return json(res, 200, await favorites(profileId, url.searchParams.get("id") || undefined));
		}
		if (req.method === "POST" && url.pathname === "/api/favorites") {
			const input = await body(req);
			const profileId = input.profileId ?? "default";
			await profile(profileId);
			if (typeof input.id !== "string" || !input.id || input.id.length > 2048 || typeof input.favorite !== "boolean") throw httpError(400, "세션 id와 즐겨찾기 여부가 필요해요.");
			return json(res, 200, await setFavorite(profileId, input.id, parseFocus(input.focus), input.favorite));
		}
		if (req.method === "GET" && url.pathname === "/api/wiki") {
			const profileId = url.searchParams.get("profileId") ?? "default";
			await profile(profileId);
			return json(res, 200, wiki(await history(undefined, profileId)));
		}
		if (req.method === "POST" && url.pathname === "/api/wiki/extract") {
			const profileId = (await body(req)).profileId ?? "default";
			return json(res, 200, await extractKeywords(profileId));
		}
		if (req.method === "GET" && url.pathname === "/api/live") {
			const id = url.searchParams.get("id") ?? "";
			const p = providerOf(id);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(`: jev=${jevEnabled}\n\n`);
			const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
			const stop = p.live ? p.live(id, send) : watchSession(p.pathOf(id), p, send);
			const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
			req.on("close", () => {
				stop();
				clearInterval(ping);
			});
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/ask") {
			return json(res, 200, await ask(await body(req)));
		}
		json(res, 404, { error: "not found" });
	} catch (e) {
		json(res, e.status ?? (e.code === "ENOENT" ? 404 : e instanceof URIError ? 400 : 500), { error: String(e.message ?? e) });
	}
};

// 테일스케일 등 다른 주소에 열어도 이 컴퓨터의 `docent` 명령이 127.0.0.1 로 살아 있는지 확인하므로 loopback 은 항상 연다.
const hosts = HOST === "127.0.0.1" ? [HOST] : [HOST, "127.0.0.1"];
for (const h of hosts) {
	createServer(handler).listen(PORT, h, () => {
		const url = `http://${h}:${PORT}/`;
		const peers = Object.keys(PEERS);
		console.log(`docent: ${url}  (prompt: ${PROMPT}, jev: ${jevEnabled ? "on" : "off"}${peers.length ? `, peers: ${peers.join(" ")}` : ""})`);
		if (h === "127.0.0.1" && process.env.DOCENT_ON_LISTEN === "open") {
			const opener = { darwin: "open", win32: "start", linux: "xdg-open" }[process.platform];
			if (opener) execFile(opener, [url], () => {});
		}
	});
}
