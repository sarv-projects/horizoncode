#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const clinePath = resolve(root, "research docs/cline-provider-inventory-2026-10-01.md");
const openCodePath = resolve(root, "research docs/opencode-provider-inventory.md");
const cline = readFileSync(clinePath, "utf8");
const openCode = readFileSync(openCodePath, "utf8");

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function tableRows(source, start, end) {
	const startAt = source.indexOf(start);
	assert(startAt >= 0, `Missing table start: ${start}`);
	const endAt = source.indexOf(end, startAt + start.length);
	assert(endAt >= 0, `Missing table end: ${end}`);
	return source
		.slice(startAt, endAt)
		.split(/\r?\n/)
		.filter((line) => line.startsWith("| ") && !/^\|\s*:?-{3,}/.test(line))
		.slice(1)
		.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

const clineRows = tableRows(
	cline,
	"## Effective provider registry",
	"## Models.dev key and runtime-provider mappings",
);
const clineIds = clineRows.map((row) => row[0]);
assert(clineRows.length === 228, `Expected 228 Cline rows; found ${clineRows.length}`);
assert(new Set(clineIds).size === 228, "Cline provider IDs are not unique");
assert(clineRows.every((row) => row.length === 7 && /\[(generated|runtime)\]/.test(row[6])), "A Cline provider row is missing its source link or expected columns");
assert(clineRows.filter((row) => row[2] === "Models.dev generated").length === 182, "Cline generated-only count changed");
assert(clineRows.filter((row) => row[2] === "generated + Cline override").length === 29, "Cline generated-plus-override count changed");
assert(clineRows.filter((row) => row[2] === "Cline runtime only").length === 17, "Cline runtime-only count changed");
assert(cline.includes("8eee168b80127b0c94bad849323754b5864865e7"), "Cline source pin is missing");
assert(cline.includes("Unknown vendor flow") && cline.includes("no provider doc declared"), "Cline unknown-auth cases must remain explicit");

const mappingRows = tableRows(
	cline,
	"## Models.dev key and runtime-provider mappings",
	"## Authentication and special route notes",
);
assert(mappingRows.length === 45, `Expected 45 Cline mapping rows; found ${mappingRows.length}`);
assert(mappingRows.every((row) => row.length === 3), "A Cline provider-key mapping row has an unexpected shape");

const openCodeIds = tableRows(
	openCode,
	"## Dynamic provider IDs in the OpenCode model feed",
	"## Every named provider section in the pinned documentation",
);
assert(openCodeIds.length === 225, `Expected 225 OpenCode feed IDs; found ${openCodeIds.length}`);
assert(new Set(openCodeIds.map((row) => row[0])).size === 225, "OpenCode provider IDs are not unique");
assert(openCodeIds.every((row) => row.length === 3), "An OpenCode feed provider row has an unexpected shape");
assert(openCode.includes("0112a92c416f5ad833d96e7a8308441f0a875d94"), "OpenCode refreshed source pin is missing");
assert(openCode.includes("448ae274adb22c1b8fdff113a43eaec149a5e4f6b868ac299b5d545d1d465b8d"), "OpenCode refreshed feed digest is missing");
assert(openCode.includes("8,339 model records") && openCode.includes("51 named provider entries"), "OpenCode refresh counts are missing");

const feedPath = process.argv[2];
if (feedPath) {
	const bytes = readFileSync(resolve(feedPath));
	const digest = createHash("sha256").update(bytes).digest("hex");
	assert(digest === "448ae274adb22c1b8fdff113a43eaec149a5e4f6b868ac299b5d545d1d465b8d", `OpenCode feed digest mismatch: ${digest}`);
	const feed = JSON.parse(bytes.toString("utf8"));
	const providerCount = Object.keys(feed).length;
	const modelCount = Object.values(feed).reduce((total, provider) => total + Object.keys(provider.models ?? {}).length, 0);
	assert(providerCount === 225, `Expected 225 feed providers; found ${providerCount}`);
	assert(modelCount === 8339, `Expected 8,339 feed models; found ${modelCount}`);
	const listedIds = openCodeIds.map((row) => row[0].replaceAll("`", "")).sort();
	const feedIds = Object.keys(feed).sort();
	assert(JSON.stringify(listedIds) === JSON.stringify(feedIds), "OpenCode feed IDs differ from the committed provider-ID table");
}

console.log(`Provider inventory document structure passed: Cline ${clineRows.length} registrations / ${mappingRows.length} mappings; OpenCode ${openCodeIds.length} provider IDs.`);
if (feedPath) console.log("Optional OpenCode feed digest and record counts passed.");
