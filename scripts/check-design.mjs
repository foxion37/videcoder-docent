#!/usr/bin/env node
// 디자인 검사: 실제 Chrome에서 대화 화면을 띄워 글자 크기, 여백, 정렬을 재고 규칙마다 통과 여부를 판정한다.
// 수치 기준은 항상 검사한다. TYPESAFE_API_KEY가 있으면 같은 규칙을 Jev로도 판정하고, 둘 다 통과해야 성공이다.
// 기준 출처: KRDS 타이포그래피와 레이아웃, 토스 TDS, 당근 SEED, WCAG 1.4.8 (CHANGELOG 0.16.6 참고).
// 실행: npm run check:design   Chrome 경로는 CHROME_BIN 으로 바꿀 수 있다.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { jevEnabled, judge } from "../app/jev.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = [
	process.env.CHROME_BIN,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
].find((path) => path && existsSync(path));
const VIEWPORT = { width: 1440, height: 900 };

const spread = (values) => Math.max(...values) - Math.min(...values);
const rgb = (text) => (String(text).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
const zero = (value) => value === "normal" || parseFloat(value) === 0;

/** 규칙 하나 = 사람과 Jev가 읽는 기준 문장(rule) + 같은 기준의 수치 판정(pass) + 보여 줄 값(show). */
const RULES = [
	{ name: "본문 크기", rule: "bodyFontPx 가 14 이상", pass: (m) => m.bodyFontPx >= 14, show: (m) => `${m.bodyFontPx}px` },
	{ name: "행간", rule: "lineHeightRatio 가 1.5 이상 1.7 이하", pass: (m) => m.lineHeightRatio >= 1.5 && m.lineHeightRatio <= 1.7, show: (m) => `${m.lineHeightRatio}` },
	{ name: "문단 사이", rule: "paragraphGapPx 가 16 이상이고, 문단 안 줄 사이 여백 bodyFontPx x (lineHeightRatio - 1) 의 1.5배 이상", pass: (m) => m.paragraphGapPx >= 16 && m.paragraphGapPx >= 1.5 * m.bodyFontPx * (m.lineHeightRatio - 1), show: (m) => `${m.paragraphGapPx}px` },
	{ name: "제목과 본문 사이", rule: "headingToBodyPx 와 boldLeadToBodyPx 가 모두 4 이상이고 paragraphGapPx 의 절반 이하", pass: (m) => Math.min(m.headingToBodyPx, m.boldLeadToBodyPx) >= 4 && Math.max(m.headingToBodyPx, m.boldLeadToBodyPx) <= m.paragraphGapPx / 2, show: (m) => `${m.headingToBodyPx}px, 굵은 소제목 ${m.boldLeadToBodyPx}px` },
	{ name: "묶음 사이", rule: "sectionToHeadingPx 와 sectionToBoldLeadPx 가 모두 headingToBodyPx 의 3배 이상이고 paragraphGapPx 의 1.5배 이상", pass: (m) => Math.min(m.sectionToHeadingPx, m.sectionToBoldLeadPx) >= Math.max(3 * m.headingToBodyPx, 1.5 * m.paragraphGapPx), show: (m) => `${m.sectionToHeadingPx}px, 굵은 소제목 ${m.sectionToBoldLeadPx}px` },
	{ name: "목록 항목 사이", rule: "listItemGapPx 가 8 이상 12 이하", pass: (m) => m.listItemGapPx >= 8 && m.listItemGapPx <= 12, show: (m) => `${m.listItemGapPx}px` },
	{ name: "자간", rule: "bodyLetterSpacing 과 headingLetterSpacing 이 모두 normal 또는 0px", pass: (m) => zero(m.bodyLetterSpacing) && zero(m.headingLetterSpacing), show: (m) => `본문 ${m.bodyLetterSpacing}, 소제목 ${m.headingLetterSpacing}` },
	{ name: "소제목 크기", rule: "headingFontPx 를 bodyFontPx 로 나눈 값이 1.2 이상", pass: (m) => m.headingFontPx / m.bodyFontPx >= 1.2 - 1e-9, show: (m) => `${(m.headingFontPx / m.bodyFontPx).toFixed(2)}배` },
	{ name: "한 줄 글자 수", rule: "approxKoreanCharsPerLine 이 44 이하", pass: (m) => m.approxKoreanCharsPerLine <= 44, show: (m) => `약 ${m.approxKoreanCharsPerLine}자` },
	{ name: "답 아래 영역", rule: "headlineToExplainPx 가 paragraphGapPx 이하이고, explainToDetailsPx 와 detailsToActionsPx 가 paragraphGapPx 보다 크고, actionsToMetaPx 가 12 이상이고, actionButtonGapPx 가 8 이상", pass: (m) => m.headlineToExplainPx <= m.paragraphGapPx && m.explainToDetailsPx > m.paragraphGapPx && m.detailsToActionsPx > m.paragraphGapPx && m.actionsToMetaPx >= 12 && m.actionButtonGapPx >= 8, show: (m) => `${m.headlineToExplainPx}, ${m.explainToDetailsPx}, ${m.detailsToActionsPx}, ${m.actionsToMetaPx}px` },
	{ name: "용어 뜻 찾기 강조", rule: "termButton.background 가 노란색 계열이고 termButton.color 가 검정에 가까움", pass: (m) => { const [r, g, b] = rgb(m.termButton.background), text = rgb(m.termButton.color); return r >= 200 && g >= 150 && b <= 120 && text.slice(0, 3).every((v) => v <= 60); }, show: (m) => `${m.termButton.background} 위 ${m.termButton.color}` },
	{ name: "입력창 한 줄 정렬", rule: "composer.single 에서 textarea, quickQuestion, send 의 centerY 가 서로 1px 이내이고 composer 의 centerY 와도 1.5px 이내", pass: (m) => { const c = m.composer.single; return spread([c.textarea.centerY, c.quickQuestion.centerY, c.send.centerY]) <= 1 && spread([c.composer.centerY, c.send.centerY]) <= 1.5; }, show: (m) => { const c = m.composer.single; return [c.textarea, c.quickQuestion, c.send].map((b) => b.centerY).join(", "); } },
	{ name: "입력창 여러 줄 정렬", rule: "composer.multi 에서 quickQuestion 과 send 의 centerY 가 1px 이내이고, send 의 bottom 이 composer 의 bottom 보다 3px 이상 8px 이하 위", pass: (m) => { const c = m.composer.multi, gap = c.composer.bottom - c.send.bottom; return spread([c.quickQuestion.centerY, c.send.centerY]) <= 1 && gap >= 3 && gap <= 8; }, show: (m) => { const c = m.composer.multi; return `${c.quickQuestion.centerY}, ${c.send.centerY}, 아래 여백 ${Math.round(c.composer.bottom - c.send.bottom)}px`; } },
	{ name: "바로잡기 표시 중 정렬", rule: "composer.steer 에서 textarea, quickQuestion, steer, send 의 centerY 가 모두 1px 이내", pass: (m) => { const c = m.composer.steer; return spread([c.textarea.centerY, c.quickQuestion.centerY, c.steer.centerY, c.send.centerY]) <= 1; }, show: (m) => { const c = m.composer.steer; return [c.textarea, c.quickQuestion, c.steer, c.send].map((b) => b.centerY).join(", "); } },
	{ name: "작은 창 카드 제목", rule: "pipCardTitlePx 가 workCardTitlePx 와 같고 16 이상", pass: (m) => m.pipCardTitlePx === m.workCardTitlePx && m.pipCardTitlePx >= 16, show: (m) => `작은 창 ${m.pipCardTitlePx}px, 본문 카드 ${m.workCardTitlePx}px` },
	{ name: "글자 굵기", rule: "weights 에서 body, headline, cardTitle 이 400 이고 heading 이 550 이고 boldLead 가 600", pass: (m) => { const w = m.weights; return w.body === 400 && w.headline === 400 && w.cardTitle === 400 && w.heading === 550 && w.boldLead === 600; }, show: (m) => { const w = m.weights; return `본문 ${w.body}, 결론 ${w.headline}, 카드 제목 ${w.cardTitle}, 소제목 ${w.heading}, 굵은 글씨 ${w.boldLead}`; } },
];

/** 페이지 안에서 실행된다. renderAnswer 와 같은 구조의 표본 답을 그려 재고, 입력창 버튼 정렬도 잰다. */
async function pageMeasure() {
	const { mountMarkdown } = await import("/assets/docent-markdown.js");
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const md = (cls, text) => { const d = document.createElement("div"); d.className = cls; mountMarkdown(d, text); return d; };
	const a = document.createElement("div"); a.className = "a";
	const head = document.createElement("div"); head.className = "head";
	const badge = document.createElement("span"); badge.className = "badge done"; badge.textContent = "끝남";
	head.append(badge, md("answer-headline", "두 선택지 모두 준비 작업은 같고, 공개 버튼을 누가 누르는지만 달라요."));
	const ex = md("ex", "이 질문에서 정할 일은 공개 전환을 누가, 언제 하느냐예요. 두 선택지 모두 준비 작업과 릴리스는 똑같이 진행해요.\n\n차이는 마지막 단계인 공개 버튼을 AI가 바로 누르는지, 사용자가 직접 확인하고 누르는지예요.\n\n### 1. 바로 공개 전환\n이 선택지를 고르면 정리 작업이 끝난 뒤 AI가 두 가지를 먼저 확인해요. 둘 다 통과하면 AI가 곧바로 저장소를 공개로 바꿔요.\n\n이 방식의 장점은 사용자가 따로 손대지 않아도 끝난다는 점이에요.\n\n**확인하는 것**\n\n- 원격 CI가 통과했는지\n- 릴리스 파일이 만들어졌는지\n- 설명과 토픽이 들어갔는지\n\n### 2. 비공개로 두고 확인 후 전환\n이 선택지를 고르면 AI는 릴리스까지만 하고 멈춰요.");
	const details = document.createElement("details"); details.className = "answer-details"; details.open = true;
	const summary = document.createElement("summary"); summary.textContent = "자세히 보기";
	details.append(summary, md("answer-detail", "**비교**\n\n| 항목 | 바로 공개 | 확인 후 공개 |\n|---|---|---|\n| 손 | 없음 | 한 번 |"));
	const actions = document.createElement("div"); actions.className = "card-actions answer-actions";
	for (const [text, cls] of [["용어 뜻 찾기", "control term-find"], ["원문 보기: 에이전트가 쓴 메시지 (9월 24일 오전 9:11)", "control evidence-link"]]) { const b = document.createElement("button"); b.className = cls; b.textContent = text; actions.append(b); }
	const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = "설명 모드 NORMAL (기본값), 요청 모델: omp 기본 모델, 19초 걸림";
	a.append(head, ex, details, actions, meta);
	document.querySelector("#log").append(a);
	await wait(400);
	const gap = (x, y) => Math.round(y.getBoundingClientRect().top - x.getBoundingClientRect().bottom);
	const cs = (el) => getComputedStyle(el);
	const ps = [...ex.querySelectorAll("p:not(.md-lead)")], h3 = ex.querySelector("h3"), lead = ex.querySelector(".md-lead"), lis = [...ex.querySelectorAll("li")];
	const fs = parseFloat(cs(ps[0]).fontSize), lh = parseFloat(cs(ps[0]).lineHeight);
	const metrics = {
		bodyFontPx: fs, lineHeightRatio: +(lh / fs).toFixed(2), bodyLetterSpacing: cs(ps[0]).letterSpacing,
		headingFontPx: parseFloat(cs(h3).fontSize), headingLetterSpacing: cs(h3).letterSpacing,
		paragraphGapPx: gap(ps[0], ps[1]),
		headingToBodyPx: gap(h3, h3.nextElementSibling), sectionToHeadingPx: gap(h3.previousElementSibling, h3),
		boldLeadToBodyPx: gap(lead, lead.nextElementSibling), sectionToBoldLeadPx: gap(lead.previousElementSibling, lead),
		listItemGapPx: gap(lis[0], lis[1]),
		headlineToExplainPx: gap(head, ex), explainToDetailsPx: gap(ex, details), detailsToActionsPx: gap(details, actions), actionsToMetaPx: gap(actions, meta),
		actionButtonGapPx: Math.round(actions.children[1].getBoundingClientRect().left - actions.children[0].getBoundingClientRect().right),
		// 한 줄 길이는 글 줄(문단) 너비로 잰다. 표와 코드는 답 칸 전체 너비를 쓸 수 있다.
		approxKoreanCharsPerLine: Math.round(ps[0].getBoundingClientRect().width / fs),
		termButton: { background: cs(actions.children[0]).backgroundColor, color: cs(actions.children[0]).color },
		weights: { headline: Number(cs(head.querySelector(".answer-headline")).fontWeight), heading: Number(cs(h3).fontWeight), boldLead: Number(cs(lead.querySelector("strong") ?? lead).fontWeight), body: Number(cs(ps[0]).fontWeight) },
	};
	const pipCard = document.createElement("button"); pipCard.className = "pip-card";
	const pipTitle = document.createElement("span"); pipTitle.className = "pip-card-title"; pipTitle.textContent = "공개 전환을 누가 할지 정해야 해요";
	const workTitle = document.createElement("div"); workTitle.className = "event-title"; workTitle.textContent = pipTitle.textContent;
	pipCard.append(pipTitle); document.body.append(pipCard, workTitle);
	metrics.pipCardTitlePx = parseFloat(cs(pipTitle).fontSize); metrics.workCardTitlePx = parseFloat(cs(workTitle).fontSize); metrics.weights.cardTitle = Number(cs(workTitle).fontWeight);
	a.remove(); pipCard.remove(); workTitle.remove();
	const box = (el) => { const r = el.getBoundingClientRect(); return { centerY: Math.round((r.top + r.height / 2) * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 }; };
	const q = document.querySelector("#q"), form = document.querySelector("#form"), quick = document.querySelector("#explainMenu summary"), send = document.querySelector("#send"), steer = document.querySelector("#steer");
	const composer = () => ({ composer: box(form), textarea: box(q), quickQuestion: box(quick), send: box(send) });
	const single = composer();
	steer.hidden = false;
	const withSteer = { ...composer(), steer: box(steer) };
	steer.hidden = true;
	q.value = "첫 줄\n둘째 줄\n셋째 줄";
	q.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }));
	await wait(100);
	const multi = composer();
	q.value = "";
	q.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
	return { ...metrics, composer: { single, multi, steer: withSteer } };
}

async function until(check, label, ms = 15_000) {
	const deadline = Date.now() + ms;
	for (;;) {
		if (await check().catch(() => false)) return;
		if (Date.now() > deadline) throw new Error(`시간 안에 준비되지 않았어요: ${label}`);
		await delay(100);
	}
}

async function freePort() {
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const { port } = probe.address();
	await new Promise((res) => probe.close(res));
	return port;
}

/** Chrome DevTools Protocol 최소 클라이언트. Node 22 의 내장 WebSocket 을 쓴다. */
async function connect(url) {
	const ws = new WebSocket(url);
	const pending = new Map();
	let seq = 0;
	ws.onmessage = (event) => {
		const message = JSON.parse(event.data);
		const waiter = pending.get(message.id);
		if (!waiter) return;
		pending.delete(message.id);
		message.error ? waiter.rej(new Error(message.error.message)) : waiter.res(message.result);
	};
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("Chrome 에 연결하지 못했어요.")); });
	const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		return result.result.value;
	};
	return { send, evaluate, close: () => ws.close() };
}

async function main() {
	if (!CHROME) throw new Error("Chrome 을 찾지 못했어요. CHROME_BIN 에 Chrome 또는 Chromium 실행 파일 경로를 넣어 주세요.");
	const home = await mkdtemp(join(tmpdir(), "docent-design-"));
	const children = [];
	try {
		const session = join(home, ".claude/projects/project/session.jsonl");
		await mkdir(dirname(session), { recursive: true });
		await mkdir(join(home, "state"));
		await writeFile(session, `${JSON.stringify({ type: "user", uuid: "u1", cwd: "/project", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "디자인 검사용 세션" } })}\n`);
		const port = await freePort();
		const server = spawn(process.execPath, [join(root, "app/server.mjs")], { cwd: root, env: { ...process.env, HOME: home, DOCENT_HOME: join(home, "state"), DOCENT_HOST: "127.0.0.1", DOCENT_PORT: String(port), DOCENT_PEERS: "", DOCENT_ON_LISTEN: "", TYPESAFE_API_KEY: "", OMP_BIN: "/usr/bin/false" }, stdio: ["ignore", "pipe", "ignore"] });
		children.push(server);
		let log = "";
		server.stdout.on("data", (chunk) => { log += chunk; });
		await until(async () => log.includes(`docent: http://127.0.0.1:${port}/`), "도슨트 서버");

		const profile = join(home, "chrome");
		const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "about:blank"], { stdio: "ignore" });
		children.push(chrome);
		const portFile = join(profile, "DevToolsActivePort");
		await until(async () => /^\d+\n/.test(await readFile(portFile, "utf8")), "Chrome");
		const devPort = (await readFile(portFile, "utf8")).split("\n")[0];
		const page = (await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json()).find((target) => target.type === "page");
		const tab = await connect(page.webSocketDebuggerUrl);
		try {
			await tab.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
			await tab.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
			await until(() => tab.evaluate(`!!document.querySelector(".sess")`), "세션 목록");
			await tab.evaluate(`document.querySelector(".sess").click()`);
			await until(() => tab.evaluate(`!!document.querySelector("#sessionThreadBtn") && !document.querySelector("#sessionThreadBtn").closest("[hidden]")`), "세션 열기");
			await tab.evaluate(`document.querySelector("#sessionThreadBtn").click()`);
			await until(() => tab.evaluate(`!document.querySelector("#q").disabled && !document.querySelector("#chatBody").closest("[hidden]")`), "대화 입력창");
			return await tab.evaluate(`(${pageMeasure.toString()})()`);
		} finally {
			tab.close();
		}
	} finally {
		for (const child of children) child.kill("SIGTERM");
		await Promise.all(children.map((child) => (child.exitCode === null && child.signalCode === null ? once(child, "exit") : null)));
		await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
}

const metrics = await main();
let answers = null;
if (jevEnabled) {
	const questions = Object.fromEntries(RULES.map((rule, i) => [`r${i}`, { type: "noul", instructions: `측정값(metrics)이 다음 기준을 만족하는가? 기준: ${rule.rule}` }]));
	answers = await judge(JSON.stringify({ metrics }), questions);
	if (!answers) {
		console.error("Jev 판정을 받지 못했어요. 키와 네트워크를 확인한 뒤 다시 실행해 주세요.");
		process.exit(2);
	}
}
let failed = 0;
console.log(`디자인 검사 (${VIEWPORT.width}x${VIEWPORT.height}, ${jevEnabled ? "수치 기준 + Jev" : "수치 기준만, TYPESAFE_API_KEY 없음"})\n`);
for (const [i, rule] of RULES.entries()) {
	const byNumber = rule.pass(metrics);
	const p = answers?.[`r${i}`]?.noul;
	const byJev = answers ? Number.isFinite(p) && p >= 0.5 : true;
	const ok = byNumber && byJev;
	if (!ok) failed++;
	console.log(`${ok ? "통과" : "실패"}  ${rule.name}: ${rule.show(metrics)}${answers ? `  (Jev ${Number.isFinite(p) ? p.toFixed(2) : "응답 없음"})` : ""}${byNumber ? "" : "  [수치 기준 어긋남]"}`);
	if (!ok) console.log(`      기준: ${rule.rule}`);
}
console.log(`\n${RULES.length}개 중 ${RULES.length - failed}개 통과`);
process.exit(failed ? 1 : 0);
