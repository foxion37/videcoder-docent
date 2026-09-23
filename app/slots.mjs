// The visible answer is a conclusion, a free-form explanation, and optional expandable details.
// Machine metadata is never visible. Request sentences are ordinary answer text when the user asks for them.
const STATUS = { "✅": "done", "⏳": "running", "⛔": "blocked" };
const DETAIL_HEAD = /^더 자세히\s*:\s*$/;

// Quoted and nested fences are still literal Markdown, not slot delimiters or metadata.
function fenceEdge(line) {
	const match = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
	return match ? { marker: match[1], closing: !match[2].trim() } : null;
}

function visibleLines(raw) {
	let fence = null, metadata = false;
	const out = [];
	for (const line of String(raw).split("\n")) {
		const edge = fenceEdge(line);
		if (fence) {
			out.push(line);
			if (edge?.closing && edge.marker[0] === fence[0] && edge.marker.length >= fence.length) fence = null;
			continue;
		}
		if (metadata) {
			if (line.includes("-->")) metadata = false;
			continue;
		}
		if (/^\s*<!--\s*\/?docent-(?:learning|source)\b/.test(line)) {
			metadata = !line.includes("-->");
			continue;
		}
		if (edge) { fence = edge.marker; out.push(line); continue; }
		if (/^\s*근거\s*:\s*(?:\[ref:|없음\s*$)/.test(line)) continue;
		// Inline code is literal, not an emitted citation. Strip only ordinary prose markers.
		out.push(line.split(/(`+[^`]*`+)/).map((part, index) => index % 2 ? part : part.replace(/\[ref:[^\]\r\n]+\]/g, "")).join(""));
	}
	return out;
}

export function parseAnswer(raw) {
	const lines = visibleLines(raw);
	let i = 0;
	while (i < lines.length && !lines[i].trim()) i++;

	let status = null;
	let headline = (lines[i] ?? "").trim();
	const first = [...headline][0];
	if (first && STATUS[first]) {
		status = STATUS[first];
		headline = headline.slice(first.length).trim();
	}
	i++;

	const explain = [];
	const details = [];
	let inDetails = false;
	let fence = null;
	for (; i < lines.length; i++) {
		const line = lines[i];
		const edge = fenceEdge(line);
		if (!fence && DETAIL_HEAD.test(line)) {
			inDetails = true;
			details.push([]);
			continue;
		}
		if (inDetails) details[details.length - 1].push(line);
		else explain.push(line);
		if (edge) {
			if (!fence) fence = edge.marker;
			else if (edge.closing && edge.marker[0] === fence[0] && edge.marker.length >= fence.length) fence = null;
		}
	}
	return {
		status, headline, explain: explain.join("\n").trim(),
		details: details.map((section) => section.join("\n").replace(/^\n+|\n+$/g, "")).filter((section) => section.trim()),
	};
}
