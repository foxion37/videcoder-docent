// 다른 컴퓨터의 docent 를 세션 제공자로 (ADR 0011). 세션 목록·전사·라이브만 그쪽 API 에서 받아 온다.
// 답은 여기 omp 가 만든다. 원격 세션 id 는 `@<이름>/<원래 id>`.
// 원격 프로필 ID는 로컬 사용자와 동일인임을 보장하지 않으므로 문답 역사는 가져오지 않는다.
const LIST_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 30_000;

export function peerProvider(name, base) {
	const prefix = `@${name}/`;
	const url = (path, sid) => `${base.replace(/\/$/, "")}${path}?id=${encodeURIComponent(sid.slice(prefix.length))}`;
	const get = async (u, ms) => {
		const r = await fetch(u, { signal: AbortSignal.timeout(ms) });
		if (!r.ok) throw new Error(`${name}: ${r.status}`);
		return r;
	};
	return {
		id: `@${name}`,
		host: name,
		owns: (sid) => sid.startsWith(prefix),
		async list() {
			try {
				const r = await get(`${base.replace(/\/$/, "")}/api/sessions`, LIST_TIMEOUT_MS);
				return (await r.json()).filter((s) => !s.host).map((s) => ({ ...s, id: prefix + s.id, host: name }));
			} catch (e) {
				console.error(`docent: ${name} 세션 목록을 못 받았어요 (${e.message})`);
				return [];
			}
		},
		async transcript(sid) {
			return (await get(url("/api/transcript", sid), FETCH_TIMEOUT_MS)).text();
		},
		/** 원격 SSE 를 그대로 흘려보낸다. stop 을 돌려준다. */
		live(sid, send) {
			const ctl = new AbortController();
			(async () => {
				try {
					const r = await fetch(url("/api/live", sid), { signal: ctl.signal });
					if (!r.ok || !r.body) throw new Error(`${name}: ${r.status}`);
					let buf = "";
					for await (const chunk of r.body) {
						buf += Buffer.from(chunk).toString("utf8");
						let nl;
						while ((nl = buf.indexOf("\n\n")) >= 0) {
							const frame = buf.slice(0, nl);
							buf = buf.slice(nl + 2);
							const data = frame.split("\n").find((l) => l.startsWith("data: "));
							if (data) send(JSON.parse(data.slice(6)));
						}
					}
				} catch (e) {
					if (!ctl.signal.aborted) send({ kind: "warn", text: `${name} 연결이 끊겼어요: ${e.message}`, at: new Date().toISOString() });
				}
			})();
			return () => ctl.abort();
		},
	};
}

/** "이름=URL,이름=URL" 문자열과 config.peers 를 합친다. */
export function parsePeers(env, fromConfig) {
	const peers = { ...(fromConfig ?? {}) };
	for (const part of (env ?? "").split(",")) {
		const [name, ...rest] = part.split("=");
		if (name?.trim() && rest.length) peers[name.trim()] = rest.join("=").trim();
	}
	return peers;
}
