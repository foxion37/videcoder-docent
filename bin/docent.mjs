#!/usr/bin/env node
// `docent` — 웹앱을 켜고 브라우저를 연다. 이미 켜져 있으면 브라우저만 연다.
// 옵션: --no-open, --port N, --host <ip|tailscale>, --peer 이름=URL (반복 가능). ~/.docent/config.json 의 host/peers/port 가 기본값.
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("-v") || args.includes("--version")) {
	const { readFileSync } = await import("node:fs");
	console.log(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")).version);
	process.exit(0);
}
if (args.includes("-h") || args.includes("--help")) {
	console.log(
		[
			"usage: docent [--no-open] [--port N] [--host <ip|tailscale>] [--peer 이름=URL ...]",
			"  --host tailscale     이 컴퓨터의 테일스케일 주소에도 열어 다른 컴퓨터의 docent 가 읽어 가게 한다",
			"  --peer book=http://peer-host.example:4747   그 컴퓨터의 세션을 내 목록에 합친다",
			"  ~/.docent/config.json  {\"host\":\"tailscale\",\"peers\":{\"book\":\"http://peer-host.example:4747\"}}",
			"  TYPESAFE_API_KEY     (선택) Jev 판정 사용",
		].join("\n"),
	);
	process.exit(0);
}
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.DOCENT_PORT ?? 4747);
const url = `http://127.0.0.1:${port}/`;
const openBrowser = !args.includes("--no-open");
if (flag("--host")) process.env.DOCENT_HOST = flag("--host");
const peers = args.flatMap((a, i) => (a === "--peer" && args[i + 1] ? [args[i + 1]] : []));
if (peers.length) process.env.DOCENT_PEERS = [process.env.DOCENT_PEERS, ...peers].filter(Boolean).join(",");

// Windows 의 start 는 명령이 아니라 cmd 의 내장 명령이므로 cmd 로 부른다.
const openers = { darwin: ["open"], win32: ["cmd", "/c", "start", ""], linux: ["xdg-open"] };
const opener = openers[process.platform];
const open = () => {
  if (!openBrowser || !opener) return;
  execFile(opener[0], [...opener.slice(1), url], () => {});
};

const alive = await fetch(`${url}api/sessions`).then((r) => r.ok).catch(() => false);
if (alive) {
	console.log(`docent: 이미 켜져 있어요 → ${url}`);
	open();
	process.exit(0);
}

const missing = await new Promise((res) => execFile(process.env.OMP_BIN ?? "omp", ["--version"], (err) => res(Boolean(err))));
if (missing) {
	console.error("docent: omp 를 찾을 수 없어요. 도슨트는 설치된 omp 로 답을 만들어요. https://omp.sh 에서 설치하고 로그인한 뒤 다시 실행하세요.");
	process.exit(1);
}

process.env.DOCENT_PORT = String(port);
process.env.DOCENT_ON_LISTEN = openBrowser ? "open" : "";
await import(resolve(dirname(fileURLToPath(import.meta.url)), "../app/server.mjs"));
