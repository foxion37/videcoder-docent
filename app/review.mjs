// 선택한 프로필의 문답 역사에서 답 속 용어 링크에 쓸 용어집을 집계한다. 개념 이해 상태는 learning.mjs, 용어 사전 화면은 wiki.mjs가 맡는다.
import { judge } from "./jev.mjs";

// 용어(한국어 풀이). 용어는 ( 바로 앞 토큰, 풀이는 괄호 안, 중첩 없음.
const TERM_RE = /(?:^|[\s"“'(,·])([가-힣A-Za-z][가-힣A-Za-z0-9._/-]{0,23})\(([^()\n]{2,80})\)/g;
const SENTENCE_END = /(요|다|죠)[.!?]?$/;
const HANGUL = /[가-힣]/;
// 숫자로 시작하거나(100명 데이터…), 화살표·쉼표 둘 이상·가운뎃점 셋 이상이면 나열이지 풀이가 아니다
const isList = (g) => /^\d/.test(g) || g.includes("→") || (g.match(/,/g) ?? []).length >= 2 || (g.match(/·/g) ?? []).length >= 3;

/** raw 답에서 {term, gloss} 후보를 규칙으로 뽑는다. */
export function extractTerms(raw) {
	const out = [];
	const seen = new Set();
	for (const m of raw.matchAll(TERM_RE)) {
		const term = m[1];
		const gloss = m[2].trim();
		if (!HANGUL.test(gloss) || isList(gloss) || SENTENCE_END.test(gloss)) continue;
		if (term.length >= 3 && SENTENCE_END.test(term)) continue;
		const key = term.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ term, gloss });
	}
	return out;
}

/** Jev 가 있으면 "앞 단어의 뜻 풀이인가"(noul) 로 거른 결과. Jev 가 없거나 실패하면 null. */
export async function filterTerms(raw, terms) {
	if (!terms.length) return null;
	const questions = {};
	terms.forEach((t, i) => {
		questions[`t${i}`] = { type: "noul", instructions: `"${t.term}(${t.gloss})" — 괄호 안은 "${t.term}" 이라는 용어의 뜻을 풀어 쓴 것이다 (예시·부연·조건이 아니다)` };
	});
	const a = await judge(raw, questions);
	if (!a) return null;
	return terms.filter((_, i) => (a[`t${i}`]?.noul ?? 1) >= 0.5);
}

// Jev 가 거른 것만 저장값을 믿는다. 규칙 결과는 읽을 때 다시 뽑아 규칙 개선이 옛 기록에도 적용되게 한다.
// 학습 분류가 뽑은 핵심 단어(keywords)가 있으면 먼저 쓴다.
const termsOf = (r) => [...(Array.isArray(r.keywords) ? r.keywords : []), ...(r.termsBy === "jev" ? r.terms ?? [] : extractTerms(r.answer?.raw ?? ""))];

/** [{term, gloss, count, lastSeen}] count 내림차순, 같으면 최근순. */
export function glossary(rows) {
	const map = new Map();
	for (const r of rows) {
		const seen = new Set();
		for (const { term, gloss } of termsOf(r)) {
			if (seen.has(term.toLowerCase())) continue;
			seen.add(term.toLowerCase());
			const key = term.toLowerCase();
			const g = map.get(key);
			if (!g) map.set(key, { term, gloss, count: 1, lastSeen: r.ts });
			else {
				g.count++;
				if (r.ts > g.lastSeen) {
					g.lastSeen = r.ts;
					g.gloss = gloss;
				}
			}
		}
	}
	return [...map.values()].sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1));
}
