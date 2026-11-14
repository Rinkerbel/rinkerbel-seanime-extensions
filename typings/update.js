const https = require("https");
const path = require("path");
const fs = require("fs");

const CONFIG = {
	owner: "5rahim",
	repo: "seanime",
	branch: "main",
	files: [
		{ sourceDir: "internal/extension_repo/goja_plugin_types", 		filename: ["app.d.ts", "core.d.ts", "plugin.d.ts", "system.d.ts"] },
		{ sourceDir: "internal/extension_repo/goja_manga_test", 		filename: "manga-provider.d.ts" },
		{ sourceDir: "internal/extension_repo/goja_onlinestream_test", 	filename: "onlinestream-provider.d.ts" },
		{ sourceDir: "internal/extension_repo/goja_torrent_test", 		filename: "anime-torrent-provider.d.ts" },
		{ sourceDir: "internal/extension_repo/goja_usermedia_test", 	filename: "custom-source.d.ts" },
	],
	retries: 3,
	timeout: 10_000,
};

/**
 * Fixes applied to the downloaded files, each checked against what Seanime's runtime does (see
 * docs/seanime-api-notes.md). A fix that no longer matches is reported: Seanime changed the file, so check whether
 * it's still needed.
 */
const FIXES = {
	"custom-source.d.ts": [
		{
			why: "the reference points at Seanime's repository layout, not this folder",
			find: '/// <reference path="../goja_plugin_types/app.d.ts" />',
			replace: '/// <reference path="./app.d.ts" />',
		},
		{
			why: "`async` isn't allowed on a method in a declaration (TS1040)",
			find: /^(\s+)async (\w+\()/gm,
			replace: "$1$2",
		},
	],
	"core.d.ts": [
		{
			why: "$await returns the promise's value",
			find: "declare function $await<T>(promise: Promise<T>): void",
			replace: "declare function $await<T>(promise: Promise<T>): T",
		},
		{
			why: "the runtime's global is $unmarshal; $unmarshalJSON doesn't exist",
			find: "declare function $unmarshalJSON(data: any, dst: any): void",
			replace: "declare function $unmarshal(data: any, dst: any): void",
		},
		{
			why: "$store.get and $store.getUnsafe return null for a missing key",
			find: /^(\s+function get(?:Unsafe)?<T = any>\(key: string\)): T$/gm,
			replace: "$1: T | null",
		},
	],
	"plugin.d.ts": [
		{
			why: "$storage.get and $storage.getUnsafe return null for a missing key",
			find: /^(\s+function get(?:Unsafe)?<T = any>\(key: string\)): T \| undefined$/gm,
			replace: "$1: T | null",
		},
		{
			why: "$anilist.deleteEntry takes the list entry's ID too (Seanime's binding is (mediaID, entryId)); without it AniList answers 400",
			find: "function deleteEntry(mediaId: number): void",
			replace: "function deleteEntry(mediaId: number, entryId: number): void",
		},
	],
};

function applyFixes(filename, content) {
	for (const fix of FIXES[filename] ?? []) {
		const matched = typeof fix.find === "string" ? content.includes(fix.find) : content.search(fix.find) !== -1;
		if (!matched) {
			console.log(`⚠️  Fix no longer matches in ${filename} (${fix.why}): check whether it's still needed`);
			continue;
		}
		content = typeof fix.find === "string" ? content.split(fix.find).join(fix.replace) : content.replace(fix.find, fix.replace);
		console.log(`🔧 Fixed ${filename}: ${fix.why}`);
	}
	return content;
}

const currentDir = path.dirname(process.argv[1]);

function downloadFile(filename, attempt = 1, sourceDir) {
	const rawUrl = `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${sourceDir}/${filename}`;

	return new Promise((resolve, reject) => {
		console.log(
			`[Attempt ${attempt}/${CONFIG.retries}] Downloading: ${filename}...`,
		);

		const request = https.get(
			rawUrl,
			{ timeout: CONFIG.timeout },
			(response) => {
				// Handle redirects
				if (response.statusCode === 301 || response.statusCode === 302) {
					console.log(`→ Redirecting to: ${response.headers.location}`);
					return downloadFile(response.headers.location, attempt, sourceDir)
						.then(resolve)
						.catch(reject);
				}

				// Check for successful response
				if (response.statusCode !== 200) {
					if (attempt < CONFIG.retries) {
						console.log(
							`⚠️  Attempt ${attempt} failed (HTTP ${response.statusCode}), retrying...`,
						);
						setTimeout(() => {
							downloadFile(filename, attempt + 1, sourceDir)
								.then(resolve)
								.catch(reject);
						}, 1000 * attempt); // Exponential backoff
					} else {
						reject(
							new Error(
								`Failed after ${CONFIG.retries} attempts: HTTP ${response.statusCode}`,
							),
						);
					}
					return;
				}

				let data = [];
				response.on("data", (chunk) => data.push(chunk));
				response.on("end", () => {
					const content = Buffer.concat(data).toString("utf8");
					console.log(`✅ Downloaded: ${filename} (${content.length} bytes)`);
					resolve(content);
				});
			},
		);

		request.on("error", (err) => {
			if (attempt < CONFIG.retries) {
				console.log(
					`⚠️  Attempt ${attempt} failed (${err.message}), retrying...`,
				);
				setTimeout(() => {
					downloadFile(filename, attempt + 1, sourceDir)
						.then(resolve)
						.catch(reject);
				}, 1000 * attempt);
			} else {
				reject(
					new Error(
						`Network error after ${CONFIG.retries} attempts: ${err.message}`,
					),
				);
			}
		});

		request.on("timeout", () => {
			request.destroy();
			if (attempt < CONFIG.retries) {
				console.log(`⚠️  Attempt ${attempt} timed out, retrying...`);
				setTimeout(() => {
					downloadFile(filename, attempt + 1, sourceDir)
						.then(resolve)
						.catch(reject);
				}, 1000 * attempt);
			} else {
				reject(new Error(`Timeout after ${CONFIG.retries} attempts`));
			}
		});
	});
}

async function downloadAllFiles() {
	console.log(
		`Starting download of .d.ts files from ${CONFIG.repo} repository...\n`,
	);
	const files = CONFIG.files.flatMap(({ filename, sourceDir }) =>
		(Array.isArray(filename) ? filename : [filename]).map((filename) => ({
			filename,
			sourceDir,
		})),
	);
	const sourceDirs = [...new Set(files.map(({ sourceDir }) => sourceDir))];
	console.log(`Sources: ${sourceDirs.map((sourceDir) => `${CONFIG.owner}/${CONFIG.repo}/${sourceDir}`).join(", ")}`);
	console.log(`Destination: ${currentDir}`);
	console.log(`Max retries: ${CONFIG.retries}\n`);

	const results = [];

	for (const { filename, sourceDir } of files) {
		try {
			const content = applyFixes(filename, await downloadFile(filename, 1, sourceDir));
			const filePath = path.join(currentDir, filename);

			const fileExists = fs.existsSync(filePath);
			if (fileExists) {
				const stats = fs.statSync(filePath);
				console.log(
					`⚠️  Overwriting existing file: ${filename} (${stats.size} bytes)`,
				);
			}

			// Write file
			fs.writeFileSync(filePath, content, "utf8");
			console.log(
				`✔️  Saved: ${filename}${fileExists ? " (overwrote)" : ""}\n`,
			);

			results.push({ filename, success: true });
		} catch (error) {
			console.error(`❌  Failed to download ${filename}:`, error.message, "\n");
			results.push({ filename, success: false, error: error.message });
		}
	}

	// Summary
	console.log("=".repeat(60));
	console.log("📊 DOWNLOAD SUMMARY");
	console.log("=".repeat(60));

	const successful = results.filter((r) => r.success).length;
	const failed = results.filter((r) => !r.success).length;

	console.log(`✔️  Successful downloads: ${successful}`);
	if (failed > 0) {
		console.log(`❌ Failed downloads: ${failed}`);
		console.log("\nFailed files:");
		results
			.filter((r) => !r.success)
			.forEach((r) => {
				console.log(`   - ${r.filename}: ${r.error}`);
			});
	}

	console.log(`\n📁 Files saved in: ${currentDir}`);

	if (successful === files.length) {
		console.log("\n✔️  All files downloaded successfully!");
	} else {
		console.log(
			"\n⚠️  Some files failed to download. Check your internet connection and verify the files exist in the repository.",
		);
	}
	console.log("=".repeat(60));
}

// Run the download
downloadAllFiles().catch(console.error);
