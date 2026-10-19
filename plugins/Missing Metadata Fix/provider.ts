/// <reference path="../../typings/plugin.d.ts" />
/// <reference path="../../typings/system.d.ts" />
/// <reference path="../../typings/app.d.ts" />
/// <reference path="../../typings/core.d.ts" />
/// <reference path="./missing-metadata-fix.d.ts" />

// @ts-ignore
function init(): void {
	// Seanime evaluates every $shared factory from its own source text in the runtime that uses it, so nothing from
	// init()'s scope reaches it (or the UI context): helpers they share are $shared modules themselves.

	/** A per-anime record store on disk: every context reads and writes it through $storage. */
	$shared.define("keyedStore", () => <T>(key: string): CEM.KeyedStore<T> => {
		const all = () => ($storage.get(key) ?? {}) as Record<number, T>;
		return {
			all,
			get: (mediaId) => all()[mediaId] as T | undefined,
			set: (mediaId, value) => {
				const obj = all();
				if (value) obj[mediaId] = value;
				else delete obj[mediaId];
				$storage.set(key, obj);
			},
		};
	});
	type KeyedStoreOf = <T>(key: string) => CEM.KeyedStore<T>;

	/** A debug line from the metadata hooks: the plugin's debug panel, and seanime.log with the debug-to-log setting */
	$shared.define("hookDebug", () => (line: string) => {
		$debug.debug(line);
		if ($getUserPreference("debug-to-log") === "true") console.log(`[CEM] [debug] ${line}`);
	});
	/** An episode as the metadata hooks add it to Seanime's list */
	$shared.define("newEpisode", () => (key: string, airDate = "", eid = 0, title = ""): $app.Metadata_EpisodeMetadata => {
		const n = Number(key);
		return {
			anidbId: eid, tvdbId: 0, title, image: "", airDate, length: 0, summary: "", overview: "",
			episodeNumber: n, episode: key, seasonNumber: 1, absoluteEpisodeNumber: n, anidbEid: eid, hasImage: false,
		};
	});
	/**
	 * The AniDB ID to give an anime Seanime has none for, and its match when the match is for that ID. A real AniDB ID
	 * clears Seanime's "metadata retrieval not available" notice and lets AnimeTosho search by AniDB (anime and episode
	 * IDs). Only the user's override or a match whose air dates were checked against AniDB; never a made-up or borrowed
	 * one, since torrent providers search by it.
	 */
	$shared.define("anidbInUse", () => (mediaId: number) => {
		const overrides = ($storage.get("TMDB_OVERRIDES") ?? {}) as Record<number, CEM.TMDBOverrides>;
		const anidb = $shared.use<CEM.AnidbStore>("anidb").get(mediaId);
		const aid = overrides[mediaId]?.anidbId ?? ($getUserPreference("anidb-lookup") !== "false" && anidb?.status === "verified" ? anidb.aid : undefined);
		return { aid, anidb, own: aid && anidb?.aid === aid ? anidb : undefined };
	});
	type AnidbInUse = (mediaId: number) => { aid?: number; anidb?: CEM.AnidbMatch; own?: CEM.AnidbMatch };

	// The custom episode metadata the user (or Bulk Update) saved
	$shared.define("database", (): CEM.SharedDatabase => {
		const store = $shared.use<KeyedStoreOf>("keyedStore")<CEM.CustomEpisodeEntry>("CUSTOM_EPISODE_METADATA_STORAGE_V2");
		const get = (mediaId: number) => store.get(mediaId) ?? { mediaId, data: {} };
		return {
			get,
			save: (mediaId, data) => {
				const entry = get(mediaId);
				entry.data[data.episode] = data;
				store.set(mediaId, entry);
			},
			delete: (mediaId, episode) => {
				const entry = get(mediaId);
				delete entry.data[episode];
				store.set(mediaId, entry);
			},
		};
	});

	// Whether Animap can serve an anime. Kept separate from the custom metadata so it survives deleting all of it.
	$shared.define("animap", () => $shared.use<KeyedStoreOf>("keyedStore")<CEM.AnimapStatus>("ANIMAP_STATUS_V1"));

	// TMDB image size from the settings. Stored stills are TMDB paths, so a new size applies straight away.
	$shared.define("tmdbImage", () => (path: string) => {
		return `https://image.tmdb.org/t/p/${$getUserPreference("image-size") ?? "w1280"}${path}`;
	});

	// The AniDB ID (and episode IDs) used for anime Seanime has no metadata for
	$shared.define("anidb", () => $shared.use<KeyedStoreOf>("keyedStore")<CEM.AnidbMatch>("ANIDB_MATCHES_V1"));

	// How each anime maps onto TMDB and the stills found for it, kept on disk so restarts lose nothing
	$shared.define("thumbnails", () => $shared.use<KeyedStoreOf>("keyedStore")<CEM.ThumbnailRecord>("TMDB_THUMBNAILS_V1"));

	/**
	 * Whether an anime's episode has aired: by the aired count Seanime's entry gives (the UI context keeps it in
	 * CEM_AIRED_<id>; with the LiveChart Schedule plugin it is LiveChart's next episode, which is often right before
	 * AniList is), or by its air date. A date alone is a day behind for Japan's late-night slots (00:30 there is the day
	 * before in UTC), so the count goes first.
	 */
	$shared.define("aired", () => (mediaId: number) => {
		const count = Number($store.get(`CEM_AIRED_${mediaId}`)) || 0;
		const today = new Date().toISOString().slice(0, 10);
		return (key: string, airDate?: string) => /^\d+$/.test(key) && (Number(key) <= count || (!!airDate && airDate <= today));
	});
	type Aired = (mediaId: number) => (key: string, airDate?: string) => boolean;

	// For an anime Animap has no entry for: the episode list onAnimeMetadataRequested supplies, or null when it leaves
	// the request to Animap (nothing to apply: no custom metadata, stills, fill-in data or AniDB ID). The plugin's own
	// metadata requests use it too, so they never ask Seanime for metadata that would fail.
	$shared.define("fallbackSupply", () => (mediaId: number): CEM.FallbackSupply | null => {
		const status = $shared.use<CEM.AnimapStore>("animap").get(mediaId);
		if (!status?.fallback) return null;
		const custom = $shared.use<CEM.SharedDatabase>("database").get(mediaId).data;
		const thumbs = $shared.use<CEM.ThumbnailStore>("thumbnails").get(mediaId);
		const matched = thumbs?.status === "matched";
		const stills = matched && $getUserPreference("tmdb-thumbnails") === "true" ? Object.keys(thumbs.images) : [];
		const filled = matched && $getUserPreference("tmdb-fill-missing") !== "false" ? Object.keys(thumbs.episodes ?? {}) : [];

		const { aid, own } = $shared.use<AnidbInUse>("anidbInUse")(mediaId);
		const eids = own?.eids ?? {};
		// AniDB's air dates date the list (TMDB's only fill in where AniDB has none)
		const airDates = own?.airDates ?? {};

		if (!Object.keys(custom).length && !stills.length && !filled.length && !aid) return null;
		// As many episodes as have aired: by AniList (or LiveChart), or by the dates the custom metadata, TMDB or AniDB
		// give (AniList knows no count for some airing anime: no total and no next episode). Episodes written ahead of
		// airing don't belong in the list yet.
		const aired = $shared.use<Aired>("aired")(mediaId);
		const airedKeys = [
			...Object.keys(custom).filter((k) => !custom[k].airDate || aired(k, custom[k].airDate)),
			...filled.filter((k) => thumbs?.episodes?.[k]?.aired || aired(k, thumbs?.episodes?.[k]?.airDate)),
			...Object.keys(airDates).filter((k) => aired(k, airDates[k])),
		];
		const count = Math.max(status.episodeCount, ...airedKeys.filter((k) => /^\d+$/.test(k)).map(Number), 0);
		return count < 1 ? null : { count, aid, eids, airDates };
	});

	// When Animap has no entry (e.g. AniDB entries that are 18+), Seanime errors out before onAnimeMetadata fires and
	// custom metadata is never applied. For those anime, supply the episode list here instead so Animap is never called;
	// onAnimeMetadata still runs afterwards and merges the custom metadata and TMDB stills. Only anime with custom
	// metadata or matched TMDB stills are taken over, so everything else keeps going to Animap and picks up its entry
	// as soon as it exists.
	$app.onAnimeMetadataRequested((e) => {
		const hookDebug = $shared.use<(line: string) => void>("hookDebug");
		const newEpisode = $shared.use<(key: string, airDate?: string, eid?: number, title?: string) => $app.Metadata_EpisodeMetadata>("newEpisode");
		// Tell the UI context which anime Seanime is loading (entry page, Continue Watching, anywhere), so their TMDB
		// data is fetched or refreshed on demand. Seanime caches metadata for an hour, but only for 100 anime: a page
		// with more keeps evicting them, and the plugin's own checks then refetch them. So an anime checked in the last
		// 10 minutes isn't queued again (that would loop); the entry page still checks it on every visit.
		// Each anime is queued under its own key with the time it was queued: Seanime runs this hook in several runtimes at
		// once, so a shared list written back by each would lose anime when many load in the same moment
		const served = Number($store.get(`CEM_SERVED_${e.mediaId}`)) || 0;
		const recent = Date.now() - served <= 10 * 60 * 1000;
		if (!recent && !(Number($store.get(`CEM_REQ_${e.mediaId}`)) > 0)) {
			$store.set(`CEM_REQ_${e.mediaId}`, Date.now());
			// When the queue last grew: the UI context waits for a page load to settle
			$store.set("CEM_REQUESTED_LAST", Date.now());
		} else if ($debug.enabled && recent) hookDebug(`hook: ${e.mediaId} not queued, checked ${Math.round((Date.now() - served) / 1000)}s ago`);

		// Only for an anime Animap has no entry for (fallbackSupply checks)
		const supply = e.animeMetadata ? $shared.use<(mediaId: number) => CEM.FallbackSupply | null>("fallbackSupply")(e.mediaId) : null;
		if (!supply || !e.animeMetadata) return e.next();
		const { count, aid, eids, airDates } = supply;

		// Assigned objects are stored as copies, so work on what's read back
		if (!e.animeMetadata.episodes) e.animeMetadata.episodes = {};
		const episodes = e.animeMetadata.episodes;
		for (let n = 1; n <= count; n++) episodes[`${n}`] = newEpisode(`${n}`, airDates?.[`${n}`] ?? "", eids[`${n}`] ?? 0, `Episode ${n}`);
		e.animeMetadata.episodeCount = count;
		if ($debug.enabled) hookDebug(`hook: ${e.mediaId} has no Animap entry; supplying ${count} episodes${aid ? `, AniDB ${aid}` : ""}`);
		if (aid) {
			if (!e.animeMetadata.mappings) e.animeMetadata.mappings = {};
			e.animeMetadata.mappings.anidbId = aid;
		}
		e.preventDefault();
		e.next();
	});

	$ui.register((ctx) => {
		// constants
		const REPO_AUTHOR = "rinkerbel";
		const REPO_NAME = "rinkerbel-seanime-extensions";
		const REPO_BRANCH = "main";
		const REPO_PATH = encodeURIComponent("plugins/Missing Metadata Fix");

		const iconUrl = `https://raw.githubusercontent.com/${REPO_AUTHOR}/${REPO_NAME}/${REPO_BRANCH}/${REPO_PATH}/icon.png`;
		const tray = ctx.newTray({ iconUrl, withContent: true, width: "35rem" });

		/**
		 * Logging. Every level goes to the plugin's debug panel ($debug, development plugins only; a no-op otherwise);
		 * info and up also go to seanime.log, prefixed [CEM].
		 * - mark: a section starts (a batch, a page opened, a button pressed, a rebuild). Panel only.
		 * - step: one line per decision or outcome inside a section (scope, fresh or due, matched, rebuild scheduled).
		 * - debug: low-level detail (requests, each candidate tried, cache hits).
		 * - inspect: a whole object to look into (a stored record, an AniDB match, a list of IDs).
		 * - info: outcomes worth keeping (new or changed matches, verified AniDB IDs, rebuilds, setting changes).
		 * - warn: something the user may need to act on. Seanime writes console.warn at its debug level, so the line
		 *   also starts with "Warning:".
		 * - error: unexpected failures. Logged at Seanime's error level.
		 * Building costly arguments is guarded by $debug.enabled, so normal installs don't pay for it.
		 */
		const text = (values: unknown[]) =>
			values.map((v) => (typeof v === "string" ? v : v instanceof Error ? v.message : JSON.stringify(v))).join(" ");
		/**
		 * "Debug lines in the log file" (in the development manifest only): every level also goes to seanime.log, so a
		 * whole session can be read back (the debug panel keeps only the last 500 lines). Off without the field.
		 */
		const toFile = $getUserPreference("debug-to-log") === "true";
		const file = (level: string, values: unknown[]) => {
			if (toFile) console.log(`[CEM] [${level}] ${text(values)}`);
		};
		const timers: Record<string, number> = {};
		const log = {
			mark: (...values: unknown[]) => ($debug.mark(...values), file("mark", values)),
			step: (...values: unknown[]) => ($debug.log(...values), file("log", values)),
			debug: (...values: unknown[]) => ($debug.debug(...values), file("debug", values)),
			inspect: (...values: unknown[]) => ($debug.inspect(...values), file("inspect", values)),
			time: (label: string) => {
				$debug.time(label);
				if (toFile) timers[label] = Date.now();
			},
			timeEnd: (label: string) => {
				$debug.timeEnd(label);
				if (toFile && timers[label] !== undefined) {
					file("debug", [`${label}: ${Date.now() - timers[label]} ms`]);
					delete timers[label];
				}
			},
			info: (...values: unknown[]) => {
				$debug.info(...values);
				console.log(`[CEM] ${text(values)}`);
			},
			warn: (...values: unknown[]) => {
				$debug.warn(...values);
				console.warn(`[CEM] Warning: ${text(values)}`);
			},
			error: (...values: unknown[]) => {
				$debug.error(...values);
				console.error(`[CEM] ${text(values)}`);
			},
		};

		const database = $shared.use<CEM.SharedDatabase>("database");
		const animap = $shared.use<CEM.AnimapStore>("animap");
		const thumbnails = $shared.use<CEM.ThumbnailStore>("thumbnails");

		/**
		 * An anime's metadata as Seanime last built it, from the copy onAnimeMetadata keeps (air dates and IDs only),
		 * while Seanime would still have it cached (an hour). Only asks Seanime when there's none: with a big library its
		 * 100-entry cache has often dropped the anime already, and asking again means another Animap fetch. Throws like
		 * ctx.anime.getAnimeMetadata when Seanime has no metadata. Episodes the plugin added from TMDB are left out.
		 */
		async function loadMetadata(mediaId: number): Promise<$app.Metadata_AnimeMetadata | undefined> {
			const kept = storeJson<{ at: number; metadata: $app.Metadata_AnimeMetadata } | undefined>(`CEM_META_${mediaId}`, undefined);
			// Not older than an hour, and built since the plugin last cleared Seanime's cache (strictly after: one built
			// in the same millisecond as a clear may predate it)
			if (kept && Date.now() - kept.at < HOUR && kept.at > (Number($store.get("CEM_META_CLEARED")) || 0)) return kept.metadata;
			log.debug(`${mediaId}: no usable kept metadata copy, asking Seanime`);
			// Seanime rejects a failed metadata request from outside the plugin's event loop, which can crash the whole
			// server: it's only asked for anime Animap has (or the plugin supplies the episode list for)
			if (mediaId < 0x80000000) {
				if (animap.get(mediaId)?.fallback) {
					// No Animap entry: only the episode list the plugin supplies, if any
					if (!fallbackSupply(mediaId)) return undefined;
				} else if ((await animapHas(mediaId)) === false) throw new Error("not found on Animap");
			}
			return withoutAdded(mediaId, await ctx.anime.getAnimeMetadata("anilist", mediaId));
		}
		/** Animap's answers this session: mediaId -> whether it has an entry, and when that was asked. */
		const animapProbes: Record<number, { has: boolean; at: number }> = {};
		let animapProbeBlocked = false;
		/**
		 * Whether Animap has an entry for this anime, asked directly (as Seanime does). Answers are kept for an hour unless
		 * fresh. undefined: no answer (offline, or the manifest doesn't allow the domain yet).
		 */
		async function animapHas(mediaId: number, fresh = false): Promise<boolean | undefined> {
			const known = animapProbes[mediaId];
			if (known && !fresh && Date.now() - known.at < HOUR) return known.has;
			if (animapProbeBlocked) return undefined;
			try {
				const res = await ctx.fetch(`https://anime.clap.ing/entry?anilist_id=${mediaId}`, {
					timeout: 20,
					noCloudflareBypass: true,
					// Animap's Cloudflare lets Seanime's own requests through (Go's client), not a browser's
					headers: { "User-Agent": "Go-http-client/1.1", "X-Seanime-Version": "Seanime/3.10.4" },
				});
				if (res.status !== 200 && res.status !== 404) return undefined;
				animapProbes[mediaId] = { has: res.status === 200, at: Date.now() };
				log.debug(`${mediaId}: Animap ${res.status === 200 ? "has" : "has no"} entry`);
				return res.status === 200;
			} catch (e) {
				if (/not allowed|permission|domain/i.test(`${e}`)) {
					animapProbeBlocked = true;
					log.warn("The plugin can't ask Animap directly (anime.clap.ing isn't in the manifest's allowed domains); update the plugin's manifest. Until then a failed metadata request can crash Seanime:", e);
				} else log.debug(`${mediaId}: asking Animap failed:`, e);
				return undefined;
			}
		}
		/** The anime's AniList entry and Seanime's metadata; either one undefined when it can't be loaded. */
		async function loadAnime(mediaId: number) {
			let media: $app.AL_BaseAnime | undefined;
			let metadata: $app.Metadata_AnimeMetadata | undefined;
			try {
				media = (await ctx.anime.getAnimeEntry(mediaId)).media;
			} catch {}
			try {
				metadata = await loadMetadata(mediaId);
			} catch {}
			return { media, metadata };
		}
		/** A JSON value the metadata hooks left in $store; empty when there's none (or it doesn't parse). */
		function storeJson<T>(key: string, empty: T): T {
			try {
				return (JSON.parse(`${$store.get(key) ?? ""}`) as T) ?? empty;
			} catch {
				return empty;
			}
		}
		/**
		 * Seanime's metadata as Seanime has it: without the episodes onAnimeMetadata added (from TMDB, AniDB or the custom
		 * metadata), and with the titles and air dates it took from TMDB put back as they were.
		 */
		function withoutAdded(mediaId: number, metadata: $app.Metadata_AnimeMetadata | undefined) {
			const added = storeJson<string[]>(`CEM_ADDED_${mediaId}`, []);
			const filled = storeJson<Record<string, { title?: string; airDate?: string }>>(`CEM_TMDB_FILLED_${mediaId}`, {});
			if (!metadata || !(added.length || Object.keys(filled).length)) return metadata;
			const episodes: Record<string, $app.Metadata_EpisodeMetadata> = {};
			for (const [key, ep] of Object.entries(metadata.episodes ?? {})) {
				if (added.indexOf(key) !== -1) continue;
				episodes[key] = filled[key] ? { ...ep, ...filled[key] } : ep;
			}
			return { ...metadata, episodes };
		}
		/** Clear Seanime's metadata cache (all of it: there's no per-anime clear), and with it the kept copies. */
		function clearMetadataCache() {
			$store.set("CEM_META_CLEARED", Date.now());
			ctx.anime.clearEpisodeMetadataCache();
		}
		const HOUR = 60 * 60 * 1000;
		const DAY = 24 * HOUR;
		/**
		 * JSON with object keys sorted, for "did this change?" checks. Seanime hands stored objects back as Go maps, whose
		 * keys come out in a different order on every read, so plain JSON.stringify sees a change that isn't there.
		 */
		const stableJson = (value: unknown) =>
			JSON.stringify(value, (_key, v) =>
				v && typeof v === "object" && !Array.isArray(v)
					? Object.keys(v)
							.sort()
							.reduce((out, k) => {
								out[k] = (v as Record<string, unknown>)[k];
								return out;
							}, {} as Record<string, unknown>)
					: v,
			);

		/** "1-4, 6" -> [1, 2, 3, 4, 6]; undefined when it isn't a season list. */
		/**
		 * A TMDB ID as entered, Shoko's way: "s1429" a show, "m371371" a movie; also a TMDB page link or a plain number. TV
		 * and movie IDs overlap (s1429 is Attack on Titan, m1429 25th Hour), so a plain number is tried as the type the
		 * anime's format suggests first.
		 */
		function parseTmdbId(value: string): { id: number; type?: "tv" | "movie" } | undefined {
			const v = value.trim();
			const prefixed = v.match(/^([sm])\s*(\d+)$/i);
			if (prefixed) return Number(prefixed[2]) ? { id: Number(prefixed[2]), type: prefixed[1].toLowerCase() === "m" ? "movie" : "tv" } : undefined;
			const m = v.match(/^(?:.*?\b(tv|movie)\/)?(\d+)(?:\D.*)?$/i);
			if (!m || !Number(m[2])) return undefined;
			return { id: Number(m[2]), ...(m[1] ? { type: m[1].toLowerCase() as "tv" | "movie" } : {}) };
		}
		const formatTmdbId = (id: number | undefined, type?: "tv" | "movie") => (id ? `${type === "movie" ? "m" : type === "tv" ? "s" : ""}${id}` : "");
		/** The TMDB ID field of an override into the override; throws on one that isn't an ID */
		function readTmdbIdField(value: string, update: { tmdbId?: number; tmdbType?: "tv" | "movie" }) {
			if (!value.trim().length) return;
			const parsed = parseTmdbId(value);
			if (!parsed) throw new Error(`TMDB ID "${value}" isn't an ID like s1429 (a show), m371371 (a movie) or a TMDB link.`);
			update.tmdbId = parsed.id;
			if (parsed.type) update.tmdbType = parsed.type;
		}
		/** A whole number other than 0 from an offset field, else undefined */
		const nonZeroInt = (value: string) => (value.trim().length && Number.isInteger(Number(value)) && Number(value) !== 0 ? Number(value) : undefined);
		function parseSeasons(value: string): number[] | undefined {
			const out: number[] = [];
			for (const part of value.split(",").map((p) => p.trim()).filter((p) => p.length)) {
				const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
				if (range) {
					const [from, to] = [Number(range[1]), Number(range[2])];
					if (to < from || to - from > 200) return undefined;
					for (let n = from; n <= to; n++) out.push(n);
				} else if (/^\d+$/.test(part)) out.push(Number(part));
				else return undefined;
			}
			return out.length ? out : undefined;
		}
		/**
		 * Episode ranges as entered in the Season field: "S1E2-S1E4", "S1E7", "S1E6-S2" (to the end of season 2), "S3" (all
		 * of season 3), "S1E1-5". They must follow TMDB's order without overlapping; specials (S0) go in episode overrides.
		 * Returns an error message for a wrong one.
		 */
		function parseRanges(value: string): CEM.TMDBRange[] | string {
			const out: CEM.TMDBRange[] = [];
			for (const part of value.split(",").map((p) => p.trim()).filter((p) => p.length)) {
				const m = part.match(/^S(\d+)(?:E(\d+))?(?:\s*-\s*(?:S(\d+))?(?:E?(\d+))?)?$/i);
				const dash = part.indexOf("-") !== -1;
				if (!m || (dash && m[3] === undefined && m[4] === undefined)) return `"${part}" isn't a range like S1E2-S1E4, S1E7 or S1E6-S2.`;
				const season = Number(m[1]);
				const episode = m[2] !== undefined ? Number(m[2]) : 1;
				// "S1E6-S2": to the end of season 2; "S1E1-5": to episode 5 of season 1; "S1E7": just it; "S3": all of it
				const toSeason = m[3] !== undefined ? Number(m[3]) : season;
				const toEpisode = dash ? (m[4] !== undefined ? Number(m[4]) : undefined) : m[2] !== undefined ? episode : undefined;
				if (season < 1 || toSeason < 1) return `"${part}": specials (S0) go in the episode overrides, not a range.`;
				if (episode < 1 || (toEpisode !== undefined && toEpisode < 1)) return `"${part}": episodes start at 1.`;
				if (toSeason < season || (toSeason === season && toEpisode !== undefined && toEpisode < episode)) return `"${part}" ends before it starts.`;
				const last = out[out.length - 1];
				// After the previous range's end: TMDB's order, so no episode is used twice
				if (last && (season < last.toSeason || (season === last.toSeason && (last.toEpisode === undefined || episode <= last.toEpisode))))
					return `"${part}" comes before the end of the range before it: ranges go in TMDB's order and don't overlap.`;
				out.push({ season, episode, toSeason, ...(toEpisode !== undefined ? { toEpisode } : {}) });
			}
			return out.length ? out : "no ranges";
		}
		/** The ranges as the Season field shows them */
		const formatRanges = (ranges: CEM.TMDBRange[]) =>
			ranges
				.map((r) => {
					const from = `S${r.season}E${r.episode}`;
					if (r.toEpisode === undefined) return r.toSeason === r.season && r.episode === 1 ? `S${r.season}` : `${from}-S${r.toSeason}`;
					return r.toSeason === r.season && r.toEpisode === r.episode ? from : `${from}-S${r.toSeason}E${r.toEpisode}`;
				})
				.join(", ");
		/** [1, 2, 3, 4, 6] -> "1-4, 6" */
		function formatSeasons(seasons: number[]) {
			const parts: string[] = [];
			for (let i = 0; i < seasons.length; i++) {
				let j = i;
				while (j + 1 < seasons.length && seasons[j + 1] === seasons[j] + 1) j++;
				parts.push(j > i + 1 ? `${seasons[i]}-${seasons[j]}` : j === i + 1 ? `${seasons[i]}, ${seasons[j]}` : `${seasons[i]}`);
				i = j;
			}
			return parts.join(", ");
		}
		const currentMedia = ctx.state<{ id: number; banner: string; title: string; type: "tv" | "movie" } | null>(null);
		const currEditedEp = ctx.state<CEM.CustomEpisodeMetadata | null>(null);

		const stillImageSize = $getUserPreference("image-size");

		const tmdb = {
			API_KEY: $getUserPreference("tmdb-api"),
			baseUri: "https://api.themoviedb.org/3",
			/** The action button running (its handler ID), or "" */
			isFetching: ctx.state<string>(""),
			search: async (query: string, type: "tv" | "movie" | "multi") =>
				tmdb.__fetch__<CEM.TMDBSearchResults>(`search/${type}?query=${encodeURIComponent(query)}&include_adult=true&language=en-US&page=1`),
			getDetails: <T extends "tv" | "movie">(tmdbId: number, type: T) =>
				tmdb.__fetch__<T extends "tv" ? CEM.TMDBTVShowDetails : CEM.TMDBMovieDetails>(`${type}/${tmdbId}`),
			/**
			 * Seasons are always read appended to the show details ("tv/1?append_to_response=season/1"), even one: TMDB's
			 * own season and episode pages can lag hours behind for a new episode, the appended copy doesn't.
			 */
			getSeason: async (tmdbId: number, season: number) => {
				const found = (await tmdb.getSeasons(tmdbId, [season]))[season];
				if (!found) throw new Error(`TMDB ${tmdbId} has no season ${season}`);
				return found;
			},
			/** Several seasons in one request: TMDB appends up to 20 "season/N" objects to the show details. fresh: past the CDN's copy. */
			getSeasons: async (tmdbId: number, seasons: number[], fresh?: number) => {
				const result: Record<number, CEM.TMDBSeasonResults> = {};
				for (let i = 0; i < seasons.length; i += 20) {
					const chunk = seasons.slice(i, i + 20);
					const res = await tmdb.__fetch__<Record<string, unknown>>(
						`tv/${tmdbId}?append_to_response=${chunk.map((n) => `season/${n}`).join(",")}${fresh ? `&fresh=${fresh}` : ""}`,
					);
					for (const n of chunk) {
						const season = res[`season/${n}`] as CEM.TMDBSeasonResults | undefined;
						if (season?.episodes) result[n] = season;
					}
				}
				return result;
			},
			__fetch__: async <T>(endpoint: string) => {
				const url = new URL(`${tmdb.baseUri}/${endpoint}`);
				// The API Read Access Token (a JWT, "eyJ...") goes in the Authorization header, out of the URL and the logs; an
				// API key in the URL. TMDB accepts either with the same access.
				const key = `${tmdb.API_KEY ?? ""}`.trim();
				const bearer = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(key);
				if (!bearer) url.searchParams.set("api_key", key);
				url.searchParams.set("language", "en-US");
				const get = () =>
					bearer ? ctx.fetch(url.toString(), { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } }) : ctx.fetch(url.toString());

				// TMDB allows roughly 40 requests a second; on a 429 wait as asked and try again
				log.debug("TMDB request", endpoint);
				let res = await get();
				for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
					const wait = Number(res.headers?.["Retry-After"] ?? res.headers?.["retry-after"]) || 2;
					log.warn(`TMDB rate limit hit, retrying in ${wait}s`);
					await new Promise<void>((resolve) => ctx.setTimeout(() => resolve(), wait * 1000));
					res = await get();
				}

				if (!res.ok) {
					let err = null;
					try {
						err = res.json();
					} catch {
						err = null;
					}
					throw new Error(err?.status_message || err?.message || err?.error || res.statusText);
				}

				return res.json() as T;
			},
			// Seanime drops state-driven re-renders that land within 120ms of the previous one, so the final
			// isFetching="" could be lost and leave the button busy. tray.update() always re-renders.
			setFetching: (value: string) => {
				tmdb.isFetching.set(value);
				tray.update();
			},
			overrides: {
				__id__: "TMDB_OVERRIDES",
				records: () => $storage.get<Record<number, CEM.TMDBOverrides>>(tmdb.overrides.__id__) ?? {},
				get: (mediaId: number) => tmdb.overrides.records()[mediaId] ?? { mediaId, episodeOverrides: [] },
				set: (mediaId: number, override: Partial<Omit<CEM.TMDBOverrides, "mediaId">>, overwrite: boolean = false) => {
					const records = tmdb.overrides.records();
					const oldData = tmdb.overrides.get(mediaId);
					const episodeOverridesMap = new Map([...oldData.episodeOverrides, ...(override.episodeOverrides ?? [])].map((o) => [o.aniDBEpisode, o]));

					records[mediaId] = overwrite
						? { mediaId, episodeOverrides: [], ...override }
						: { ...oldData, ...override, episodeOverrides: Array.from(episodeOverridesMap.values()) };

					$storage.set(tmdb.overrides.__id__, records);
				},
				hasEpisode: (mediaId: number, aniDBEpisode: string) => tmdb.overrides.get(mediaId).episodeOverrides.some((e) => e.aniDBEpisode === aniDBEpisode),
				removeEpisodeOverride: (mediaId: number, aniDBEpisode: string) => {
					const data = tmdb.overrides.get(mediaId);
					const filtered = data.episodeOverrides.filter((x) => x.aniDBEpisode !== aniDBEpisode);

					if (filtered.length === data.episodeOverrides.length) return false;
					tmdb.overrides.set(mediaId, { ...data, episodeOverrides: filtered }, true);
					return true;
				},
				/** Clears the media fields, keeping the episode overrides and the ignore-warnings choice */
				removeMediaOverride: (mediaId: number) => {
					const { episodeOverrides, ignoreWarnings } = tmdb.overrides.get(mediaId);
					tmdb.overrides.set(mediaId, { episodeOverrides, ...(ignoreWarnings ? { ignoreWarnings } : {}) }, true);
				},
				episode: {
					fieldRefs: {
						tmdbId: ctx.fieldRef<string>(""),
						tmdbSeason: ctx.fieldRef<string>(""),
						tmdbEpisode: ctx.fieldRef<string>(""),
					},
					fill: (data: CEM.TMDBOverrides["episodeOverrides"][number]) => {
						tmdb.overrides.episode.fieldRefs.tmdbId.setValue(formatTmdbId(data.tmdbId, data.tmdbType));
						tmdb.overrides.episode.fieldRefs.tmdbSeason.setValue(data.tmdbSeason?.toString() ?? "");
						tmdb.overrides.episode.fieldRefs.tmdbEpisode.setValue(data.tmdbEpisode?.toString() ?? "");
					},
					resetFieldRefs: () => Object.values(tmdb.overrides.episode.fieldRefs).forEach((fr) => fr.setValue("")),
					save: (mediaId: number, aniDBEpisode: string) => {
						const update: CEM.TMDBOverrides["episodeOverrides"][number] = {};
						const tmdbId = tmdb.overrides.episode.fieldRefs.tmdbId.current;
						const tmdbSeason = tmdb.overrides.episode.fieldRefs.tmdbSeason.current;
						const tmdbEpisode = tmdb.overrides.episode.fieldRefs.tmdbEpisode.current;

						readTmdbIdField(tmdbId, update);
						if (update.tmdbType === "movie" && (tmdbSeason.trim() || tmdbEpisode.trim()))
							throw new Error("A TMDB movie is one episode: clear the TMDB Season and Episode, or enter a show's ID (s<id>).");
						if (tmdbSeason.length && !isNaN(Number(tmdbSeason))) update.tmdbSeason = Number(tmdbSeason);
						if (tmdbEpisode.length && !isNaN(Number(tmdbEpisode))) update.tmdbEpisode = Number(tmdbEpisode);

						tmdb.overrides.set(mediaId, { episodeOverrides: [{ aniDBEpisode, ...update }] });
					},
				},
				media: {
					fieldRefs: {
						tmdbId: ctx.fieldRef<string>(""),
						tmdbSeason: ctx.fieldRef<string>(""),
						tmdbOffset: ctx.fieldRef<string>(""),
						anidbId: ctx.fieldRef<string>(""),
						anidbOffset: ctx.fieldRef<string>(""),
					},
					ignoreWarnings: ctx.fieldRef<boolean>(false),
					fill: (data: Omit<CEM.TMDBOverrides, "mediaId" | "episodeOverrides">) => {
						tmdb.overrides.media.fieldRefs.tmdbId.setValue(formatTmdbId(data.tmdbId, data.tmdbType));
						tmdb.overrides.media.fieldRefs.tmdbSeason.setValue(
							data.tmdbRanges?.length ? formatRanges(data.tmdbRanges) : data.tmdbSeasons?.length ? formatSeasons(data.tmdbSeasons) : data.tmdbSeason?.toString() ?? "",
						);
						tmdb.overrides.media.fieldRefs.tmdbOffset.setValue(data.tmdbOffset?.toString() ?? "");
						tmdb.overrides.media.fieldRefs.anidbId.setValue(data.anidbId?.toString() ?? "");
						tmdb.overrides.media.fieldRefs.anidbOffset.setValue(data.anidbOffset?.toString() ?? "");
					},
					resetFieldRefs: () => Object.values(tmdb.overrides.media.fieldRefs).forEach((fr) => fr.setValue("")),
					save: (mediaId: number) => {
						const update: Omit<CEM.TMDBOverrides, "mediaId" | "episodeOverrides"> = {};
						const tmdbId = tmdb.overrides.media.fieldRefs.tmdbId.current;
						const tmdbSeason = tmdb.overrides.media.fieldRefs.tmdbSeason.current;

						readTmdbIdField(tmdbId, update);
						if (tmdbSeason.trim().length) {
							if (update.tmdbType === "movie") throw new Error("A TMDB movie has no seasons: clear the TMDB Season, or enter a show's ID (s<id>).");
							if (/^\s*S/i.test(tmdbSeason)) {
								const ranges = parseRanges(tmdbSeason);
								if (typeof ranges === "string") throw new Error(`TMDB Season: ${ranges}`);
								update.tmdbSeason = ranges[0].season;
								update.tmdbRanges = ranges;
							} else {
								const seasons = parseSeasons(tmdbSeason);
								if (!seasons) throw new Error(`TMDB Season "${tmdbSeason}" isn't a season, a list like "1-4, 6" or ranges like "S1E2-S1E4, S1E7".`);
								update.tmdbSeason = seasons[0];
								if (seasons.length > 1) update.tmdbSeasons = seasons;
							}
						}
						const tmdbOffset = nonZeroInt(tmdb.overrides.media.fieldRefs.tmdbOffset.current);
						if (tmdbOffset !== undefined) update.tmdbOffset = tmdbOffset;
						const anidbId = Number(tmdb.overrides.media.fieldRefs.anidbId.current.trim());
						if (Number.isInteger(anidbId) && anidbId > 0) update.anidbId = anidbId;
						const anidbOffset = nonZeroInt(tmdb.overrides.media.fieldRefs.anidbOffset.current);
						if (anidbOffset !== undefined) update.anidbOffset = anidbOffset;

						// Overwrite so a cleared field actually removes the old value
						const { episodeOverrides, ignoreWarnings } = tmdb.overrides.get(mediaId);
						if (ignoreWarnings) update.ignoreWarnings = true;
						tmdb.overrides.set(mediaId, { ...update, episodeOverrides }, true);
					},
				},
			},
		};

		const fieldRefs = {
			data: {
				title: ctx.fieldRef<string>(""),
				length: ctx.fieldRef<string>(""),
				airDate: ctx.fieldRef<string>(""),
				overview: ctx.fieldRef<string>(""),
				image: ctx.fieldRef<string>(""),
			},
			reset: () => Object.values(fieldRefs.data).forEach((fieldRef) => fieldRef.setValue("")),
			fill: (data: CEM.CustomEpisodeMetadata) =>
				Object.entries(fieldRefs.data).forEach(([k, fieldRef]) => fieldRef.setValue((data[k as keyof typeof fieldRefs.data] ?? "").toString())),
			save: (mediaId: number, aniDBEp: string) => {
				const data = fieldRefs.data;
				const update: CEM.CustomEpisodeMetadata = { episode: aniDBEp };

				const title = data.title.current.trim();
				const length = data.length.current.trim();
				const airDate = data.airDate.current.trim();
				const overview = data.overview.current.trim();
				const image = data.image.current.trim();

				if (title.length) update.title = title;
				if (length.length) {
					if (isNaN(Number(length))) throw new Error(`Field length "${length}" is invalid. Length must be a valid number`);
					update.length = Number(length);
				}
				if (airDate.length) {
					if (!/^\d{4}-(0?[1-9]|1[0-2])-(0?[1-9]|[12][0-9]|3[01])$/.test(airDate))
						throw new Error(`Field airDate "${airDate}" is invalid. Please follow the format (yyyy-mm-dd)`);
					update.airDate = airDate;
				}
				if (overview.length) update.overview = overview;
				if (image.length) {
					if (!/^https?:\/\/[^\s]+\.(jpg|jpeg|png|gif)$/i.test(image)) throw new Error(`Field image is invalid. Please enter a valid image URL.`);
					update.image = image;
				}

				update.hasImage = !!update.image?.length;
				database.save(mediaId, update);
			},
		};

		/**
		 * The episode editor's Auto-fill: this episode's data from the anime's TMDB match and AniDB match, found the same
		 * way as everywhere else (a refresh when they're out of date). TMDB first, AniDB's English title, air date and
		 * length where TMDB has none. Throws when neither has anything.
		 */
		async function episodeAutoFill(mediaId: number, key: string) {
			const data: { title?: string; length?: string; airDate?: string; overview?: string; image?: string } = {};
			const from: string[] = [];
			let why = "";
			if (tmdb.API_KEY?.length) {
				try {
					await refreshAnime(mediaId, false);
				} catch (e) {
					why = (e as Error).message;
				}
				const record = thumbnails.get(mediaId);
				if (record?.status === "failed") why = record.reason ?? "no TMDB match";
				const target = record?.status === "matched" ? record.map[key] : undefined;
				const ep = target ? await tmdbSession().episode(target) : undefined;
				if (ep) {
					if (plainTitle(ep.name)) data.title = ep.name;
					if (ep.runtime) data.length = `${ep.runtime}`;
					if (ep.air_date) data.airDate = ep.air_date;
					if (ep.overview) data.overview = ep.overview;
					if (ep.still_path) data.image = tmdbImage(ep.still_path);
					from.push(target?.movie ? `TMDB movie ${target.tmdbId}` : `TMDB S${target?.season}E${target?.episode}`);
				} else if (record?.status === "matched") why = `TMDB's match has no episode ${key}`;
			} else why = "no TMDB API key";
			if (anidbLookup() || tmdb.overrides.get(mediaId).anidbId) {
				await refreshAnidb(mediaId).catch((e) => log.debug(`${mediaId}: AniDB lookup for Auto-fill failed:`, e));
				const match = anidbStore.get(mediaId);
				const ep = match && match.status !== "none" ? match.episodes?.[key] : undefined;
				const before = Object.keys(data).length;
				if (ep?.title && !data.title && plainTitle(ep.title)) data.title = ep.title;
				if (ep?.length && !data.length) data.length = `${ep.length}`;
				if (ep?.summary && !data.overview) data.overview = ep.summary;
				// AniDB's air dates come first, as everywhere else
				if (ep?.airDate && ep.airDate !== data.airDate) data.airDate = ep.airDate;
				if (Object.keys(data).length > before) from.push(`AniDB ${match?.aid}`);
			}
			if (!from.length) throw new Error(`Nothing to fill for episode ${key}${why ? `: ${why}` : ""}.`);
			return { data, from };
		}

		/** Label widths: the overrides modal's fields, the episode editor's */
		const MODAL_LABEL_WIDTH = "8rem";
		const EDITOR_LABEL_WIDTH = "11.5rem";
		/** Text of the Media tab's description and status lines: how many lines it wraps to, roughly, at the modal's width */
		const MEDIA_TAB_TEXT = "Applies to every episode of this anime, except episodes with their own override. Empty fields keep what the plugin found (shown greyed out).";
		const textLines = (text: string) => Math.max(1, Math.ceil(text.length / 95));

		/**
		 * What the plugin matched by itself, as the override fields' placeholders: the media's TMDB ID, season (or ranges,
		 * when the match spans several parts) and offset, its AniDB ID and offset; an episode's TMDB target.
		 */
		function autoPlaceholders(mediaId: number, episode: string | null) {
			const record = thumbnails.get(mediaId);
			const auto = record?.status === "matched" && record.source !== "override" ? record : undefined;
			const out: Record<"tmdbId" | "tmdbSeason" | "tmdbOffset" | "anidbId" | "anidbOffset" | "epTmdbId" | "epSeason" | "epEpisode", string> = {
				tmdbId: "", tmdbSeason: "", tmdbOffset: "", anidbId: "", anidbOffset: "", epTmdbId: "", epSeason: "", epEpisode: "",
			};
			if (auto?.tmdbId) {
				out.tmdbId = formatTmdbId(auto.tmdbId, auto.tmdbType ?? "tv");
				const runs = episodeRuns(auto);
				// Several parts in TMDB's order, from episode 1, without gaps in this anime's numbers: as ranges
				const ordered = runs.length > 1 && runs[0].from === 1 && runs.every((r, i) => i === 0 || (r.from === runs[i - 1].to + 1 && r.tmdbId === auto.tmdbId && (r.season > runs[i - 1].season || (r.season === runs[i - 1].season && r.first > runs[i - 1].last))));
				if (ordered) out.tmdbSeason = formatRanges(runs.map((r) => ({ season: r.season, episode: r.first, toSeason: r.season, toEpisode: r.last })));
				else if (auto.fallback && auto.tmdbType !== "movie") {
					out.tmdbSeason = `${auto.fallback.season}`;
					if (auto.fallback.offset) out.tmdbOffset = `${auto.fallback.offset}`;
				}
			}
			const match = anidbStore.get(mediaId);
			const seanime = Number($store.get(`CEM_SEANIME_ANIDB_${mediaId}`)) || 0;
			if (match?.status === "verified" && match.aid) {
				out.anidbId = `${match.aid}`;
				if (match.offset) out.anidbOffset = `${match.offset}`;
			} else if (seanime) out.anidbId = `${seanime}`;
			const target = episode !== null && record?.status === "matched" ? record.map[episode] : undefined;
			if (target) {
				out.epTmdbId = formatTmdbId(target.tmdbId, target.movie ? "movie" : "tv");
				if (target.season !== undefined) out.epSeason = `${target.season}`;
				if (target.episode !== undefined) out.epEpisode = `${target.episode}`;
			}
			return out;
		}

		/** A status line of the Media tab, its lead ("TMDB match failed", "AniDB ID") in bold. */
		function statusLine(text: string) {
			const cut = text.indexOf(":");
			return tray.div(
				cut === -1
					? [tray.span(text)]
					: [tray.span(text.slice(0, cut + 1), { className: "font-semibold text-[--foreground]" }), tray.span(text.slice(cut + 1))],
				{ className: "text-sm text-[--muted] break-normal text-pretty" },
			);
		}

		/** Seanime's queries for the open entry page, refreshed after the custom metadata changes */
		const ENTRY_QUERIES = ["ANIME-ENTRIES-get-anime-entry", "ANIME-get-anime-episode-collection"];
		/** After the custom metadata changed: re-check Animap (an anime may no longer need the plugin's episode list), then refresh the page and close the tray */
		async function customChanged(mediaId: number, message: string) {
			await checkAnimap(mediaId);
			ctx.setTimeout(() => {
				$app.invalidateClientQuery(ENTRY_QUERIES);
				ctx.toast.success(message);
				tray.close();
			}, 500);
		}

		/** Whether a media override sets anything (an override can be left with only episode overrides) */
		const hasMediaOverride = (o: CEM.TMDBOverrides) => !!(o.tmdbId || o.tmdbSeason || o.tmdbOffset || o.anidbId || o.anidbOffset);

		/**
		 * A button running a TMDB/AniDB action. While one runs the others are disabled, but never the one clicked: on a
		 * phone Seanime's trays sit in a focus-trapping popover, and a focused button turning disabled drops focus to the
		 * page; the popover's trap then takes focus back on its next re-render (every debug line of a development plugin,
		 * a badge change), and the tray, losing focus, closes with the overrides modal in it. Its label says it's busy.
		 */
		function actionButton(id: string, label: string, busyLabel: string, props: { intent?: $ui.Intent; className?: string; disabled?: boolean }, run: () => Promise<unknown>) {
			const running = tmdb.isFetching.get();
			return tray.button(running === id ? busyLabel : label, {
				intent: "white",
				size: "md",
				...props,
				disabled: !!props.disabled || (!!running && running !== id),
				onClick: ctx.eventHandler(id, async () => {
					if (tmdb.isFetching.get()) return;
					tmdb.setFetching(id);
					try {
						await run();
					} finally {
						tmdb.setFetching("");
					}
				}),
			});
		}

		/** Whether the overrides modal is open */
		const overridesOpen = ctx.state<boolean>(false);
		/**
		 * Delete buttons pressed since the modal opened ("media", "episode"): they stay shown until it opens again, since
		 * the pressed button vanishing drops focus the way a disabled one does (see actionButton) and closes the tray on
		 * a phone
		 */
		const deletePressed = ctx.state<Record<string, boolean>>({});
		/** TMDB overrides modal. Pass the episode being edited, or null from the episode list. */
		function overridesModal(currentMediaData: NonNullable<ReturnType<typeof currentMedia.get>>, episode: string | null, attention = "") {
			const auto = autoPlaceholders(currentMediaData.id, episode);
			const saved = tmdb.overrides.get(currentMediaData.id);
			// Every tab at least as tall as the Media tab, the tallest (its status lines can wrap to several lines each), so
			// the modal keeps its size when switching: Seanime only renders the active tab, so it can't be measured
			const tmdbLine = matchStatus(currentMediaData.id);
			const anidbLine = anidbStatus(currentMediaData.id);
			const mediaHeight = 24 + 1.25 * (textLines(MEDIA_TAB_TEXT) + textLines(tmdbLine) + textLines(anidbLine));
			const pane = (value: string, items: any[]) =>
				tray.tabsContent({
					value,
					className: "mt-2 p-3 border rounded-xl",
					items: [tray.div(items, { className: "flex flex-col gap-3", style: { minHeight: `${mediaHeight}rem` } })],
				});
			const button = tray.button("Overrides", {
				intent: "white",
				// Match the neighbouring buttons: "md" in the editor, default size next to Delete All
				...(episode !== null ? { size: "md" as const } : {}),
			});
			// Something to fix (no TMDB match, no AniDB ID): a notification dot on the button's corner, its halo pinging (still
			// under reduced motion), the reason as the tooltip. The same components either way, the dot only hidden: a
			// changed trigger would remount the modal, closing it (after a refresh, say).
			const dot = { position: "absolute", top: "-0.25rem", right: "-0.25rem", width: "0.625rem", height: "0.625rem", display: attention ? "block" : "none" };
			const trigger = tray.tooltip(
				tray.div(
					[
						tray.css("@media (prefers-reduced-motion: reduce) { .animate-ping { animation: none; opacity: 0; } }"),
						button,
						tray.div([], { className: "rounded-full bg-orange-500 animate-ping pointer-events-none", style: { ...dot, opacity: "0.75" } }),
						tray.div([], { className: "rounded-full bg-orange-500 pointer-events-none", style: dot }),
					],
					{ className: "relative w-fit" },
				),
				{ text: attention || "Correct the TMDB and AniDB matches" },
			);
			return tray.modal({
				trigger,
				// Kept in the plugin: Seanime's modal only reads it when mounted, so one remounted opens again instead of closing
				open: overridesOpen.get(),
				title: "TMDB Overrides",
				// Wider than Seanime's default (max-w-lg) for the status lines; on a phone it's the full width, scrolling when tall
				className: "max-w-3xl max-h-[90vh] overflow-y-auto",
				description: "Correct what the plugin matched for this anime on TMDB and AniDB. Saved overrides are used instead of the automatic match.",
				items: [
					tray.tabs({
						defaultValue: episode !== null ? "episode" : "media",
						items: [
							tray.tabsList({
								items: [
									...(episode !== null ? [tray.tabsTrigger(tray.text("Episode"), { value: "episode" })] : []),
									tray.tabsTrigger(tray.text("Media"), { value: "media" }),
									tray.tabsTrigger(tray.text("Bulk Update"), { value: "bulk-update" }),
								],
							}),
							tray.div([
							...(episode !== null
								? [
									pane("episode", [
											tray.text("Applies to this episode only, over the media override and any range. Enter m<id> to make it a TMDB movie.", {
												className: "text-sm text-[--muted] break-normal text-pretty",
											}),
											styledInput("TMDB ID", {
												fieldRef: tmdb.overrides.episode.fieldRefs.tmdbId,
												placeholder: auto.epTmdbId,
											}),
											styledInput("TMDB Season", {
												fieldRef: tmdb.overrides.episode.fieldRefs.tmdbSeason,
												placeholder: auto.epSeason,
											}),
											styledInput("TMDB Episode", {
												fieldRef: tmdb.overrides.episode.fieldRefs.tmdbEpisode,
												placeholder: auto.epEpisode,
											}),
											tray.div([], { className: "flex-1" }),
											tray.flex(
												[
													tray.button("Delete", {
														intent: "alert",
														size: "md",
														style: { display: tmdb.overrides.hasEpisode(currentMediaData.id, episode) || deletePressed.get().episode ? "block" : "none" },
														onClick: ctx.eventHandler(`modal-del-${currentMediaData.id}-${episode}`, () => {
															deletePressed.set({ ...deletePressed.get(), episode: true });
															if (!tmdb.overrides.hasEpisode(currentMediaData.id, episode)) return ctx.toast.info("This episode has no overrides to delete.");
															const isDeleted = tmdb.overrides.removeEpisodeOverride(currentMediaData.id, episode);
															rematch(currentMediaData.id);
															tmdb.overrides.episode.resetFieldRefs();
															if (isDeleted) {
																ctx.toast.success("Successfully removed this episode's overrides!");
															} else {
																ctx.toast.error("Unable to delete this episode override!");
															}
															tray.update();
														}),
													}),
													tray.button("Save", {
														intent: "primary",
														size: "md",
														onClick: ctx.eventHandler(`modal-save-${currentMediaData.id}-${episode}`, () => {
															try {
																tmdb.overrides.episode.save(currentMediaData.id, episode);
															} catch (e) {
																return ctx.toast.error((e as Error).message);
															}
															rematch(currentMediaData.id);
															ctx.toast.success("Successfully saved this episode's overrides!");
															tray.update();
														}),
													}),
												],
												{ className: "justify-end flex-wrap" },
											),
										]),
									]
								: []),
							pane("media", [
									tray.text(MEDIA_TAB_TEXT, {
										className: "text-sm text-[--muted] break-normal text-pretty",
									}),
									statusLine(tmdbLine),
									styledInput("TMDB ID", {
										fieldRef: tmdb.overrides.media.fieldRefs.tmdbId,
										placeholder: auto.tmdbId,
									}),
									styledInput("TMDB Season", {
										fieldRef: tmdb.overrides.media.fieldRefs.tmdbSeason,
										placeholder: auto.tmdbSeason,
									}),
									styledInput("TMDB Offset", {
										fieldRef: tmdb.overrides.media.fieldRefs.tmdbOffset,
										placeholder: auto.tmdbOffset,
									}),
									statusLine(anidbLine),
									// Real AniDB ID for anime Seanime has no metadata for: clears its "metadata retrieval not available" notice
									styledInput("AniDB ID", { fieldRef: tmdb.overrides.media.fieldRefs.anidbId, placeholder: auto.anidbId }),
									styledInput("AniDB Offset", { fieldRef: tmdb.overrides.media.fieldRefs.anidbOffset, placeholder: auto.anidbOffset }),
									tray.switch("Ignore this anime's warnings (the tray badge and the Overrides button's dot)", {
										fieldRef: tmdb.overrides.media.ignoreWarnings,
										onChange: ctx.eventHandler(`ignore-warnings-${currentMediaData.id}`, ({ value }: { value: boolean }) => {
											const data = tmdb.overrides.get(currentMediaData.id);
											if (value) data.ignoreWarnings = true;
											else delete data.ignoreWarnings;
											tmdb.overrides.set(currentMediaData.id, data, true);
											updateBadge();
											tray.update();
										}),
									}),
									tray.div([], { className: "flex-1" }),
									tray.flex(
										[
											tray.tooltip(
												actionButton(`modal-autofill-${currentMediaData.id}`, "Auto-fill", "Auto-filling…", { disabled: !tmdb.API_KEY?.length }, async () => {
													try {
														log.mark(`Auto-fill: ${currentMediaData.id}`);
														log.time(`autofill ${currentMediaData.id}`);
														await autoFill(currentMediaData.id);
														log.timeEnd(`autofill ${currentMediaData.id}`);
													} catch (e) {
														log.error(`${currentMediaData.id}: Auto-fill failed:`, e);
														ctx.toast.error((e as Error).message);
													}
												}),
												{ text: "Find the TMDB ID, season and offset from Animap or a TMDB search, checked against the air dates" },
											),
											tray.tooltip(
												actionButton(`modal-refresh-${currentMediaData.id}`, "Refresh", "Refreshing…", { disabled: !tmdb.API_KEY?.length }, async () => {
													try {
														ctx.toast.success(await refreshEntry(currentMediaData.id));
													} catch (e) {
														ctx.toast.error((e as Error).message);
													}
												}),
												{ text: "Match this anime again now (TMDB stills, AniDB ID, related anime), even if its data hasn't expired" },
											),
											tray.div([], { className: "flex-1" }),
											tray.button("Delete", {
												intent: "alert",
												size: "md",
												style: { display: hasMediaOverride(saved) || deletePressed.get().media ? "block" : "none" },
												onClick: ctx.eventHandler(`modal-del-${currentMediaData.id}`, () => {
													deletePressed.set({ ...deletePressed.get(), media: true });
													if (!hasMediaOverride(tmdb.overrides.get(currentMediaData.id))) return ctx.toast.info("This media has no overrides to delete.");
													log.mark(`Media override deleted: ${currentMediaData.id}`);
													tmdb.overrides.removeMediaOverride(currentMediaData.id);
													rematch(currentMediaData.id);
													if (anidbStore.get(currentMediaData.id)?.status === "override") {
														void refreshAnidb(currentMediaData.id, true)
															.then(() => scheduleRebuild(false))
															.catch((e) => log.error(`${currentMediaData.id}: AniDB lookup after deleting the override failed:`, e));
													}
													tmdb.overrides.media.resetFieldRefs();
													ctx.toast.success("Successfully removed this media's overrides!");
													tray.update();
												}),
											}),
											tray.button("Save", {
												intent: "primary",
												size: "md",
												onClick: ctx.eventHandler(`modal-save-${currentMediaData.id}`, () => {
													log.mark(`Media override saved: ${currentMediaData.id}`);
													// The media fields as stored, to tell whether saving changed anything
													const mediaFields = () => {
														const o = tmdb.overrides.get(currentMediaData.id);
														return stableJson([o.tmdbId, o.tmdbType, o.tmdbSeason, o.tmdbSeasons, o.tmdbRanges, o.tmdbOffset, o.anidbId, o.anidbOffset]);
													};
													const before = mediaFields();
													try {
														tmdb.overrides.media.save(currentMediaData.id);
													} catch (e) {
														return ctx.toast.error((e as Error).message);
													}
													// Saved as it was: no new match, lookup or rebuild (a long show takes a while to match)
													const record = thumbnails.get(currentMediaData.id);
													const saved = tmdb.overrides.get(currentMediaData.id);
													const applied =
														!!saved.tmdbId === (record?.source === "override") && !!saved.anidbId === (anidbStore.get(currentMediaData.id)?.status === "override");
													if (mediaFields() === before && record && applied) {
														log.step(`${currentMediaData.id}: override saved unchanged`);
														ctx.toast.info("Nothing changed in this media's overrides.");
														return tray.update();
													}
													rematch(currentMediaData.id);
													if (tmdb.overrides.get(currentMediaData.id).anidbId || anidbStore.get(currentMediaData.id)) {
														void detectMissing(currentMediaData.id)
															.then(() => refreshAnidb(currentMediaData.id, true))
															.then(() => scheduleRebuild(false))
															.catch((e) => log.error(`${currentMediaData.id}: AniDB lookup after saving the override failed:`, e));
													}
													clearMetadataCache();
													$app.invalidateClientQuery(ENTRY_QUERIES);
													ctx.toast.success("Successfully saved this media's overrides!");
													tray.update();
												}),
											}),
										],
										{ className: "justify-end flex-wrap" },
									),
								]),
							pane("bulk-update", [
									tray.text(
										"Writes TMDB's data for every episode into your custom metadata, from the TMDB ID, Season and Offset saved in the Media tab (episodes with their own override use that). Only for editing episodes by hand: the stills and fill-in work without it.",
										{ className: "text-sm text-[--muted] text-pretty break-normal" },
									),
									tray.alert({ intent: "warning", description: "This replaces the custom metadata you saved for this anime's episodes." }),
									actionButton(
										`bulk-update-${currentMediaData.id}`,
										"Bulk Update",
										"Updating…",
										{ intent: "success-subtle", className: "w-full", disabled: !tmdb.API_KEY?.length },
										async () => {
											// Bulk Update is manual: it only runs from a saved media override, never from Animap's ID
											const override = tmdb.overrides.get(currentMediaData.id);
											if (!override.tmdbId) return ctx.toast.error("No TMDB ID override saved. Save one in the Media tab first (Auto-fill can find it).");
											const movie = override.tmdbType === "movie" || (currentMediaData.type === "movie" && override.tmdbType !== "tv");
											if (!movie && typeof override.tmdbSeason !== "number")
												return ctx.toast.error("No TMDB Season override saved. Save one in the Media tab first (Auto-fill can find it).");

											let result: RefreshResult;
											try {
												log.mark(`Bulk Update: ${currentMediaData.id}`);
												log.time(`bulk ${currentMediaData.id}`);
												result = await refreshAnime(currentMediaData.id, true, true);
												log.timeEnd(`bulk ${currentMediaData.id}`);
											} catch (error) {
												log.error(`${currentMediaData.id}: Bulk Update failed:`, error);
												return ctx.toast.error((error as Error).message);
											}

											if (!result.record) return ctx.toast.error("This anime can't be refreshed from TMDB.");
											if (result.record.status === "failed") return ctx.toast.error(result.record.reason ?? "Unable to match this anime on TMDB.");
											if (result.missing.length) ctx.toast.warning(`No TMDB episode found for episode(s) ${result.missing.join(", ")}`);
											if (!result.saved) return ctx.toast.warning("TMDB has no episodes for this anime yet.");

											// Bulk update is the one action that closes the tray, so the episode list refreshes
											ctx.setTimeout(() => {
												ctx.toast.success(`Successfully saved metadata for ${result.saved} episode(s)!`);
												tray.close();
											}, 500);
										},
									),
								]),
							]),
						],
					}),
				],
				footer: [
					tray.text("TMDB ID can be found on the TMDB link of the series in the format of: /tv/{tmdbId} or /movie/{tmdbId}. Prefix the ID with s or m to set its type.", {
						className: "break-normal text-[--muted] text-xs",
					}),
				],
				onOpenChange: ctx.eventHandler(`modal-open-${currentMediaData.id}-${episode}`, ({ open }) => {
					tmdb.overrides.episode.resetFieldRefs();
					overridesOpen.set(!!open);
					deletePressed.set({});
					if (!open) {
						if (rebuildPending) armRebuild();
						return;
					}
					// Load what's saved, so the fields are right however the modal was opened
					const saved = tmdb.overrides.get(currentMediaData.id);
					tmdb.overrides.media.fill(saved);
					tmdb.overrides.media.ignoreWarnings.setValue(!!saved.ignoreWarnings);
					const episodeOverride = saved.episodeOverrides.find((e) => e.aniDBEpisode === episode);
					if (episodeOverride) tmdb.overrides.episode.fill(episodeOverride);
				}),
			});
		}

		tray.render(function () {
			const currentMediaData = currentMedia.get();
			const currentEpisodeData = currEditedEp.get();
			if (!currentMediaData) {
				return tray.flex(
					[
						tray.div([], {
							className: "w-10 h-10 bg-center bg-contain bg-no-repeat",
							style: { backgroundImage: `url(${iconUrl})` },
						}),
						tray.stack(
							[
								tray.text("Missing Metadata Fix", { className: "text-lg font-bold" }),
								tray.text("Navigate to an anime page to edit their episode metadata.", { className: "text-sm text-[--muted] break-normal" }),
							],
							{ gap: 0 },
						),
					],
					{ className: "p-2" },
				);
			} else {
				const customEps = Object.values(database.get(currentMediaData.id)?.data ?? {});
				return withBanner(currentMediaData.banner, [
					tray.stack(
						[
							tray.div(
								[
									tray.text("Custom Episode Metadata for", { className: "text-sm" }),
									tray.text(`${currentMediaData.title}`, { className: "font-bold text-xl line-clamp-2 break-normal text-pretty leading-tight" }),
									tray.text(`Episode ${currentEpisodeData?.episode}`, { className: `text-sm`, style: { display: currentEpisodeData ? "block" : "none" } }),
								],
								{ className: "space-y-1 font-semibold h-28" },
							),
							...(currentEpisodeData
								? [
										tray.stack(
											[
												...(
													[
														["Episode Title", "title"],
														["Duration (minutes)", "length"],
														["Airdate (yyyy-mm-dd)", "airDate"],
														["Overview", "overview"],
														["Image URL", "image"],
													] as const
												).map(([label, field]) =>
													tray.stack([
														styledInput(
															label,
															{
																fieldRef: fieldRefs.data[field],
																disabled: !!tmdb.isFetching.get(),
																...(field === "overview" ? { textarea: true, style: { resize: "none" } } : {}),
															},
															EDITOR_LABEL_WIDTH,
														),
													]),
												),
											],
											{ className: "flex-1" },
										),
										tray.flex([
											tray.tooltip(
												actionButton(`episode-autofill-${currentMediaData.id}`, "Auto-fill", "Auto-filling…", {}, async () => {
													try {
														log.mark(`Episode Auto-fill: ${currentMediaData.id} episode ${currentEpisodeData.episode}`);
														const { data, from } = await episodeAutoFill(currentMediaData.id, currentEpisodeData.episode);
														for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== "") fieldRefs.data[k as keyof typeof data].setValue(`${v}`);
														const names: Record<string, string> = { title: "title", length: "duration", airDate: "air date", overview: "overview", image: "image" };
														ctx.toast.success(`Filled the ${Object.keys(data).map((k) => names[k]).join(", ")} from ${from.join(" and ")}. Review and press Save.`);
													} catch (e) {
														log.step(`${currentMediaData.id}: episode Auto-fill found nothing: ${(e as Error).message}`);
														ctx.toast.error((e as Error).message);
													}
												}),
												{ text: "Fill the fields from this episode's TMDB match and AniDB entry, the way the Media tab finds them" },
											),
											overridesModal(currentMediaData, currentEpisodeData.episode),
											tray.div([], { className: "flex-1" }),
											tray.button("Delete", {
												intent: "alert",
												size: "md",
												disabled: !(Object.values(currentEpisodeData).length - 1),
												onClick: ctx.eventHandler(`del-${currentMediaData.id}`, async () => {
													database.delete(currentMediaData.id, currentEpisodeData.episode);
													await customChanged(currentMediaData.id, "Successfully removed episode metadata!");
												}),
											}),
											tray.button("Save", {
												intent: "primary",
												size: "md",
												onClick: ctx.eventHandler(`save-${currentMediaData.id}`, async () => {
													try {
														fieldRefs.save(currentMediaData.id, currentEpisodeData.episode);
														await customChanged(currentMediaData.id, "Successfully saved episode metadata!");
													} catch (err) {
														ctx.toast.error((err as Error).message);
													}
												}),
											}),
										]),
									]
								: [
										tray.div(
											[
												tray.flex(
													[
														tray.text("Episode", { className: "text-sm font-bold w-16" }),
														tray.text("Custom Fields", { className: "text-sm font-bold flex-1" }),
														overridesModal(currentMediaData, null, problemText(problems(currentMediaData.id))),
														...(customEps.length ? [tray.modal({
															trigger: tray.button("Delete All", { intent: "alert" }),
															title: "Delete all custom metadata?",
															description: `Are you sure you want to delete all custom metadata for ${currentMediaData.title}?`,
															footer: [
																tray.button("Delete", {
																	className: "w-full",
																	intent: "alert",
																	size: "md",
																	onClick: ctx.eventHandler(`cem-del-${currentMediaData.id}`, async () => {
																		Object.values(database.get(currentMediaData.id).data).forEach((cem) => database.delete(currentMediaData.id, cem.episode));
																		await customChanged(currentMediaData.id, `Removed all custom metadata for ${currentMediaData.title}!`);
																	}),
																}),
															],
														})] : []),
													],
													{ className: "items-center" },
												),
												tray.div(
													[
														...customEps
															.sort((a, b) => Number(a.episode) - Number(b.episode))
															.map((cem) =>
																tray.flex(
																	[
																		tray.text(`E${cem.episode}`, { className: "w-16 text-center font-semibold" }),
																		tray.text(
																			`${Object.keys(cem)
																				.filter((x) => x !== "episode")
																				.sort()
																				.join(", ")}`,
																			{ className: "flex-1 text-sm text-[--muted]" },
																		),
																		tray.button("Delete", {
																			intent: "alert",
																			onClick: ctx.eventHandler(`cem-${currentMediaData.id}-${cem.episode}`, async () => {
																				database.delete(currentMediaData.id, cem.episode);
																				await customChanged(currentMediaData.id, `Removed custom metadata for episode "${cem.episode}"!`);
																			}),
																		}),
																	],
																	{ className: "justify-center items-center" },
																),
															),
													],
													{ className: "space-y-2" },
												),
												// Nothing listed: the note in the middle of the box
												...(customEps.length
													? []
													: [
															tray.div([tray.text("No custom episode metadata for this anime.", { className: "font-semibold text-[--muted] text-center" })], {
																className: "flex flex-1 items-center justify-center",
															}),
														]),
											],
											{ className: "flex flex-col gap-2 p-2 border rounded-xl bg-gray-800 overflow-scroll", style: { height: "24rem" } },
										),
									]),
						],
						{ className: "p-2 space-y-2 h-full" },
					),
				]);
			}
		});

		tray.onClose(() => {
			currEditedEp.set(null);
			overridesOpen.set(false);
			if (rebuildPending) armRebuild();
		});

		(["library", "torrentstream", "debridstream", "undownloaded", "medialinks", "mediastream"] as const).forEach((type) => {
			const gridItem = ctx.action.newEpisodeGridItemMenuItem({ type, label: "Edit Custom Metadata " });
			gridItem.mount();
			gridItem.onClick(({ episode, type }) => {
				tray.close();
				if (!isAnimeEpisode(episode, type)) return;
				if (!episode.baseAnime) return ctx.toast.error(`Unable to retrieve anime metadata.`);

				const aniDBEpisode = episode.aniDBEpisode ?? episode.fileMetadata?.aniDBEpisode;
				if (!aniDBEpisode) return ctx.toast.error("Unable to process aniDBEpisode.");

				const customEpisodeEntry = database.get(episode.baseAnime.id);
				const customEpisodeMetadata = customEpisodeEntry.data[aniDBEpisode] ?? { episode: aniDBEpisode };
				// The override fields fill when the overrides modal opens
				currEditedEp.set(customEpisodeMetadata);
				ctx.setTimeout(() => tray.open(), 500);
			});
		});

		ctx.effect(() => {
			const currEditedEpData = currEditedEp.get();
			!currEditedEpData ? fieldRefs.reset() : fieldRefs.fill(currEditedEpData);
		}, [currEditedEp]);

		/**
		 * Episodes Seanime shows: aired episodes for airing shows, the total otherwise, none before release. Its entry's
		 * next episode is LiveChart's with the LiveChart Schedule plugin. Kept for the metadata hooks ("aired").
		 */
		function episodeCount(media: $app.AL_BaseAnime | undefined) {
			const next = Number(media?.nextAiringEpisode?.episode) || 0;
			const count = media?.status === "NOT_YET_RELEASED" ? 0 : next ? Math.max(0, next - 1) : Number(media?.episodes) || 0;
			if (media?.id) $store.set(`CEM_AIRED_${media.id}`, count);
			return count;
		}
		/** episodeCount of an anime by its ID; 0 when AniList's entry can't be loaded */
		const entryEpisodeCount = (mediaId: number) => ctx.anime.getAnimeEntry(mediaId).then((entry) => episodeCount(entry.media), () => 0);

		/** Keep a generated episode list (Animap has no entry) in step with newly aired episodes. True when it changed. */
		function syncEpisodeCount(mediaId: number, media: $app.AL_BaseAnime | undefined) {
			const status = animap.get(mediaId);
			const count = episodeCount(media);
			if (!media || !status?.fallback || status.episodeCount === count) return false;
			log.step(`${mediaId}: generated episode list ${status.episodeCount} -> ${count} episodes`);
			animap.set(mediaId, { ...status, episodeCount: count });
			return true;
		}

		// Runs when custom metadata is saved or deleted by hand, and weekly for an anime Animap had no entry for. Asks
		// Seanime for the metadata with our fallback switched off, so any Animap remap (e.g. Custom Anime Metadata's
		// AniDB/AniList ID) is honoured, and remembers whether the hook needs to supply the episode list.
		async function checkAnimap(mediaId: number) {
			const previous = animap.get(mediaId);
			// When Animap was first found to have no entry; a re-check that finds the same keeps it
			const since = previous?.fallback ? previous.since ?? Date.now() : Date.now();
			animap.set(mediaId, null);
			clearMetadataCache();
			if (mediaId >= 0x80000000) return; // custom sources provide their own metadata

			let fallback = false;
			const has = await animapHas(mediaId, true);
			if (has !== undefined) fallback = !has;
			else
				try {
					fallback = !(await ctx.anime.getAnimeMetadata("anilist", mediaId));
				} catch {
					fallback = true;
				}
			if (!fallback) {
				if (previous?.fallback) log.info(`${mediaId}: Animap has an entry for this anime now; Seanime's own metadata is used again`);
				else log.step(`${mediaId}: Animap re-check: has an entry`);
				return animap.set(mediaId, { fallback: false, episodeCount: 0, checkedAt: Date.now() });
			}
			log.step(`${mediaId}: Animap re-check: still no entry`);

			animap.set(mediaId, { fallback: true, episodeCount: await entryEpisodeCount(mediaId), checkedAt: Date.now(), since });
			clearMetadataCache();
		}

		// ---------------------------------------------------------------------------------------------------------
		// TMDB matching, thumbnails and automatic refresh
		//
		// Seanime takes episode thumbnails from Animap (TVDB) and keeps them in a 1 hour in-memory cache. The matcher
		// below maps every anime onto TMDB and stores the result on disk; onAnimeMetadata swaps the stills in whenever
		// Seanime rebuilds its cache. Nothing is kept in timers: whether an anime is due is worked out from the stored
		// timestamps, and an anime is refreshed when Seanime next loads it after its data has expired.
		// ---------------------------------------------------------------------------------------------------------

		type Mapping = Omit<CEM.ThumbnailRecord, "mediaId" | "images" | "refreshedAt" | "lastSeenAt"> & {
			movie?: CEM.TMDBMovieDetails;
			/** Air-date match only: the (season, offset) runs, in AniDB episode order. */
			segments?: { season: number; offset: number; from: number }[];
			/** Failed for want of a TMDB ID, so a title search may help. */
			noId?: boolean;
		};
		type RefreshResult = { record?: CEM.ThumbnailRecord; saved: number; missing: string[] };
		type TMDBEpisode = CEM.TMDBSeasonResults["episodes"][number];

		// Fill-in is on unless switched off (its default), the stills off unless switched on
		const isOn = (name: "tmdb-thumbnails" | "tmdb-fill-missing") => (name === "tmdb-fill-missing" ? $getUserPreference(name) !== "false" : $getUserPreference(name) === "true");
		/** On unless switched off (also when the setting doesn't exist yet). */
		const anidbLookup = () => $getUserPreference("anidb-lookup") !== "false";
		const hasCustom = (mediaId: number) => Object.keys(database.get(mediaId).data).length > 0;
		/** Seanime has no metadata for this anime and TMDB should fill it in. */
		const fillsMissing = (mediaId: number) => isOn("tmdb-fill-missing") && !!animap.get(mediaId)?.fallback;
		/** Episodes whose overview or thumbnail Seanime's own metadata lacks, as the metadata hook last saw them. */
		const gapKeys = (mediaId: number) => {
			const episodes = storeJson<{ metadata?: { episodes?: Record<string, { gap?: boolean }> } }>(`CEM_META_${mediaId}`, {}).metadata?.episodes ?? {};
			return Object.keys(episodes).filter((k) => episodes[k]?.gap);
		};
		/**
		 * Whether this anime needs a TMDB match at all. Fill-in matches every anime, like the stills: whether an episode
		 * lacks anything (an overview, a thumbnail, the whole episode) only shows once TMDB's episodes are known.
		 */
		const wantsMatch = (_mediaId: number) => isOn("tmdb-thumbnails") || isOn("tmdb-fill-missing");

		/**
		 * How much work an anime gets: "page" when its entry page is open or the user acts on it (everything, at once),
		 * "background" for anime being watched (everything, AniList relation lookups spaced out), or nothing at all.
		 */
		type Scope = "page" | "background";
		let watching: { ids: number[] | null; upcoming: number[]; at: number } = { ids: null, upcoming: [], at: 0 };
		/** The page the user is on ("/" is the home page). */
		let currentPath = "";
		/**
		 * The anime on the user's list as Watching or Rewatching: the ones Continue Watching shows. Read from Seanime's
		 * cached list (AniList, or the local list when not logged in) at most every 5 minutes. null: no list loaded.
		 */
		function watchingIds(): number[] | null {
			const now = Date.now();
			if (now - watching.at < 5 * 60 * 1000) return watching.ids;
			let ids: number[] | null = null;
			const upcoming: number[] = [];
			try {
				const lists = $anilist.getAnimeCollection(false)?.MediaListCollection?.lists;
				if (lists) {
					ids = [];
					for (const list of lists)
						for (const entry of list?.entries ?? []) {
							const status = `${entry?.status ?? ""}`;
							const id = entry?.media?.id;
							if (id && (status === "CURRENT" || status === "REPEATING") && ids.indexOf(id) === -1) ids.push(id);
							// Planned anime that air now or within a week: the home page's Upcoming Episodes shows them too
							const airingAt = Number(entry?.media?.nextAiringEpisode?.airingAt) || 0;
							const airing = `${entry?.media?.status ?? ""}` === "RELEASING" || (airingAt > 0 && airingAt * 1000 - now < 7 * DAY);
							if (id && status === "PLANNING" && airing && upcoming.indexOf(id) === -1) upcoming.push(id);
						}
				}
			} catch (e) {
				log.warn("Couldn't read your anime list; matching every anime Seanime loads until it can be read:", e);
			}
			if (ids === null) log.step("No anime list loaded yet; asking again in 30 seconds");
			else {
				log.step(`Watching list: ${ids.length} anime`);
				log.inspect("watching list", ids);
			}
			// No list yet (still loading, or the read failed): asked again after 30 seconds instead of treating every anime
			// as watched for 5 minutes. Not on every call: without a loaded list, asking can block on AniList.
			watching = { ids, upcoming, at: ids === null ? now - 5 * 60 * 1000 + 30 * 1000 : now };
			return ids;
		}
		/** The background scope of an anime Seanime loaded, or undefined when it's left for its entry page. */
		function backgroundScope(mediaId: number): Scope | undefined {
			const ids = watchingIds();
			// No list (not loaded yet): as before this setting existed
			if (ids === null || ids.indexOf(mediaId) !== -1) return "background";
			// On the home page, its Upcoming Episodes: planned anime airing now or within a week
			if (currentPath === "/" && watching.upcoming.indexOf(mediaId) !== -1) return "background";
			return undefined;
		}
		const tmdbImage = $shared.use<(path: string) => string>("tmdbImage");
		const fallbackSupply = $shared.use<(mediaId: number) => CEM.FallbackSupply | null>("fallbackSupply");
		/**
		 * Seanime keeps the metadata it built in memory for up to an hour, with the stills, fill-in data and AniDB IDs
		 * baked in, so switching a setting showed nothing until a restart. Changing a setting reloads the plugin: when a
		 * setting that changes what the hooks add differs from the last applied one, have Seanime rebuild its metadata
		 * once. The plugin's own TMDB and AniDB data on disk is kept, so nothing is fetched from TMDB again.
		 */
		const displaySettings = JSON.stringify({
			size: stillImageSize ?? "w1280",
			thumbnails: $getUserPreference("tmdb-thumbnails") === "true",
			fill: $getUserPreference("tmdb-fill-missing") !== "false",
			anidb: $getUserPreference("anidb-lookup") !== "false",
		});
		const appliedSettings = $storage.get<string>("CEM_APPLIED_SETTINGS");
		if (appliedSettings !== displaySettings) {
			$storage.set("CEM_APPLIED_SETTINGS", displaySettings);
			// The first run after an update only knew the image size; don't rebuild for that alone
			const firstRun = appliedSettings === undefined;
			if ($storage.get("TMDB_IMAGE_SIZE_APPLIED") !== undefined) $storage.remove("TMDB_IMAGE_SIZE_APPLIED");
			// Nothing matched or looked up yet (a fresh install, wiped storage): nothing for the new settings to change. A
			// rebuild then would only hold back the first batch's rebuild (spaced by REBUILD_GAP).
			const anything = Object.keys(thumbnails.all()).length > 0 || Object.keys(($storage.get("ANIDB_MATCHES_V1") ?? {}) as object).length > 0;
			if (!firstRun && anything) {
				// After the plugin finished loading (the rebuild helper and the web page's queries are ready)
				ctx.setTimeout(() => {
					log.mark("Settings changed");
					log.info(`Settings changed, rebuilding Seanime's episode data (${displaySettings})`);
					scheduleRebuild(true);
				}, 1000);
			}
		}
		log.step(`Settings: ${displaySettings}`);
		if (!tmdb.API_KEY?.length && (isOn("tmdb-thumbnails") || isOn("tmdb-fill-missing") || anidbLookup()))
			log.warn("No TMDB API Read Access Token or API key is set: TMDB stills, fill-in, the automatic refresh and the AniDB lookup stay off until one is entered in the plugin settings");
		const sleep = (ms: number) => new Promise<void>((resolve) => ctx.setTimeout(() => resolve(), ms));
		/** "YYYY-MM-DD" as a day number, so dates compare without timezone trouble. */
		const toDay = (date: string | undefined) => {
			const m = (date ?? "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
			return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : NaN;
		};
		/** An episode title reduced for comparing ("" for a placeholder like "Episode 4"), so punctuation and case don't matter. */
		const plainTitle = (title?: string) => {
			const plain = (title ?? "").toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\u3040-\u30ff\u4e00-\u9fff]+/g, "");
			return plain.length < 4 || /^(episode|ep)\d+$|^第\d+話$/.test(plain) ? "" : plain;
		};

		/** TMDB requests for one refresh. Show details and seasons are fetched once each. */
		function tmdbSession() {
			const seasons: Record<string, Promise<CEM.TMDBSeasonResults>> = {};
			const shown: Record<string, Promise<CEM.TMDBTVShowDetails | CEM.TMDBMovieDetails>> = {};
			const details = <T extends "tv" | "movie">(tmdbId: number, type: T) => {
				const key = `${type}:${tmdbId}`;
				// A show's details come with season 1 appended (most anime need only it): one request instead of two. A failed
				// request isn't kept: the next caller asks again.
				if (!shown[key])
					shown[key] = (
						type === "tv"
							? tmdb.__fetch__<Record<string, unknown>>(`tv/${tmdbId}?append_to_response=season/1`).then((res) => {
									const first = res["season/1"] as CEM.TMDBSeasonResults | undefined;
									if (first?.episodes && !seasons[`${tmdbId}:1`]) seasons[`${tmdbId}:1`] = Promise.resolve(first);
									return res as unknown as CEM.TMDBTVShowDetails;
								})
							: tmdb.getDetails(tmdbId, type)
					).catch((e) => {
						delete shown[key];
						throw e;
					});
				return shown[key] as Promise<T extends "tv" ? CEM.TMDBTVShowDetails : CEM.TMDBMovieDetails>;
			};
			const season = (tmdbId: number, n: number) => {
				const key = `${tmdbId}:${n}`;
				if (!seasons[key]) seasons[key] = tmdb.getSeason(tmdbId, n);
				return seasons[key];
			};
			/** Fetch the seasons not cached yet in one batched request. Any the batch misses fall back to season(). */
			const prefetch = async (tmdbId: number, ns: number[]) => {
				const wanted = ns.filter((n, i) => ns.indexOf(n) === i && !seasons[`${tmdbId}:${n}`]);
				if (!wanted.length) return;
				try {
					const found = await tmdb.getSeasons(tmdbId, wanted);
					for (const n of wanted) if (found[n]) seasons[`${tmdbId}:${n}`] = Promise.resolve(found[n]);
				} catch {
					// season() fetches them one at a time instead
				}
			};
			const episode = async (target: CEM.TMDBTarget): Promise<TMDBEpisode | undefined> => {
				try {
					// A movie as one episode: its details read as an episode, the backdrop as its still
					if (target.movie) {
						const m = await details(target.tmdbId, "movie");
						return { episode_number: 1, name: m.title, overview: m.overview, air_date: m.release_date, runtime: m.runtime, still_path: m.backdrop_path } as TMDBEpisode;
					}
					if (target.season === undefined || target.episode === undefined) return undefined;
					return (await season(target.tmdbId, target.season)).episodes.find((e) => e.episode_number === target.episode);
				} catch {
					return undefined;
				}
			};
			return { season, prefetch, episode, details };
		}

		/** The episodes of several TMDB seasons, in order, as one run. A season TMDB doesn't have adds nothing. */
		async function seasonRun(session: ReturnType<typeof tmdbSession>, tmdbId: number, seasons: number[]) {
			const run: { season: number; episode: number; ep: TMDBEpisode }[] = [];
			for (const season of seasons) {
				let episodes: TMDBEpisode[] = [];
				try {
					episodes = (await session.season(tmdbId, season)).episodes;
				} catch {
					if (seasons.length === 1) throw new Error(`TMDB ${tmdbId} has no season ${season}.`);
				}
				for (const ep of episodes.slice().sort((a, b) => a.episode_number - b.episode_number)) run.push({ season, episode: ep.episode_number, ep });
			}
			return run;
		}

		/**
		 * The episodes TMDB episode ranges pick, in order, then every episode after the last one (later seasons included,
		 * for sequels to come). An error message when a range names an episode or season TMDB doesn't have.
		 */
		async function rangeRun(session: ReturnType<typeof tmdbSession>, tmdbId: number, ranges: CEM.TMDBRange[]) {
			const show = (await session.details(tmdbId, "tv")) as CEM.TMDBTVShowDetails;
			const seasons = (show.seasons ?? [])
				.map((s) => s.season_number)
				.filter((n) => n >= ranges[0].season)
				.sort((a, b) => a - b);
			await session.prefetch(tmdbId, seasons);
			const run = await seasonRun(session, tmdbId, seasons);
			const at = (season: number, episode: number) => run.findIndex((r) => r.season === season && r.episode === episode);
			const runSeasons = run.map((r) => r.season);
			const picked: typeof run = [];
			let end = -1;
			for (const r of ranges) {
				const start = at(r.season, r.episode);
				if (start === -1) return `TMDB ${tmdbId} has no S${r.season}E${r.episode}`;
				end = r.toEpisode !== undefined ? at(r.toSeason, r.toEpisode) : runSeasons.lastIndexOf(r.toSeason);
				if (end === -1) return r.toEpisode !== undefined ? `TMDB ${tmdbId} has no S${r.toSeason}E${r.toEpisode}` : `TMDB ${tmdbId} has no season ${r.toSeason}`;
				picked.push(...run.slice(start, end + 1));
			}
			return picked.concat(run.slice(end + 1));
		}

		/** Work out where every episode of an anime lives on TMDB. Throws on request errors. */
		async function buildMapping(
			mediaId: number,
			media: $app.AL_BaseAnime | undefined,
			metadata: $app.Metadata_AnimeMetadata | undefined,
			session: ReturnType<typeof tmdbSession>,
			override: CEM.TMDBOverrides,
			/** TMDB episodes ("season:episode") other anime have as their own: not for one with a borrowed ID. */
			claimed: Record<string, boolean> = {},
			/** A title search hit whose name is exactly one of this anime's titles: its dates may be a few days off */
			nameMatch = false,
		): Promise<Mapping> {
			const fail = (reason: string): Mapping => ({ status: "failed", reason, map: {} });
			// Its AniDB episodes are a related anime's specials: on a tie, TMDB's specials season is it too
			const anidbMatch = anidbStore.get(mediaId);
			const preferSpecials = anidbMatch?.status === "verified" && !!anidbMatch.specials;
			const episodes = metadata?.episodes ?? {};
			const mainKeys = Object.keys(episodes).filter((k) => /^\d+$/.test(k));
			const highest = Math.max(0, ...mainKeys.map(Number));
			// AniList's total. Seanime hands optional numbers over as wrapped Go pointers, which === never equals.
			const total = Number(media?.episodes) || 0;
			/**
			 * The last AniDB episode to take from a TMDB season, including ones that haven't aired yet. Past it the TMDB
			 * season belongs to another AniList entry (e.g. the next cour). AniList's episode total decides when it's
			 * known; otherwise the first episode TMDB marks as a (mid-)season finale, else everything TMDB lists.
			 */
			const limitFor = (seasonEpisodes: TMDBEpisode[], offset: number) => {
				if (total) return Math.max(highest, total);
				const finale = seasonEpisodes
					.filter((e) => e.episode_number - offset >= Math.max(1, highest) && (e.episode_type === "finale" || e.episode_type === "mid_season"))
					.sort((a, b) => a.episode_number - b.episode_number)[0];
				return finale ? Math.max(highest, finale.episode_number - offset) : Infinity;
			};

			const tmdbId = override.tmdbId ?? (Number((metadata?.mappings?.themoviedbId ?? "").replace(/\D/g, "")) || undefined);
			if (!tmdbId) {
				const where = !metadata
					? "Seanime returned no Animap data for this anime"
					: animap.get(mediaId)?.fallback
						? "Animap has no entry for this anime"
						: `Seanime's Animap data for this anime has no TMDB ID (${Object.keys(episodes).length} episodes, AniDB ${metadata.mappings?.anidbId ?? "none"})`;
				return { ...fail(`No TMDB ID: there's no TMDB ID override and ${where}. Use Auto-fill in the Media tab of Overrides, or enter the TMDB ID there.`), noId: true };
			}

			// A season override can only mean a TV show. Otherwise try the type the AniList format suggests first.
			let tmdbType: "tv" | "movie" = "tv";
			let details: CEM.TMDBTVShowDetails | CEM.TMDBMovieDetails | undefined;
			if (typeof override.tmdbSeason !== "number") {
				const order: ("tv" | "movie")[] = override.tmdbType ? [override.tmdbType] : media?.format?.valueOf() === "MOVIE" ? ["movie", "tv"] : ["tv", "movie"];
				let error: unknown;
				for (const type of order) {
					try {
						details = await session.details(tmdbId, type);
						tmdbType = type;
						break;
					} catch (e) {
						error = e;
					}
				}
				if (!details) {
					const from = override.tmdbId ? "your override" : "Animap";
					throw new Error(`TMDB ID ${tmdbId} (from ${from}) didn't load: ${(error as Error)?.message ?? "unknown error"}`);
				}
			}

			if (tmdbType === "movie") {
				// One episode, the movie: read like any other episode (see tmdbSession's episode)
				return { status: "matched", source: override.tmdbId ? "override" : "auto", tmdbType, tmdbId, map: { "1": { tmdbId, movie: true } }, movie: details as CEM.TMDBMovieDetails };
			}

			const map: Record<string, CEM.TMDBTarget> = {};

			// The media override decides everything, with the episode overrides on top. Several seasons are read as one run
			// of episodes: the offset counts across all of them and season 2 picks up where season 1 ends.
			if (typeof override.tmdbSeason === "number") {
				const offset = override.tmdbOffset ?? 0;
				const ranges = override.tmdbRanges?.length ? override.tmdbRanges : undefined;
				const seasons = ranges ? [override.tmdbSeason] : override.tmdbSeasons?.length ? override.tmdbSeasons : [override.tmdbSeason];
				const multi = !!ranges || seasons.length > 1;
				await session.prefetch(tmdbId, [
					...seasons,
					...override.episodeOverrides.filter((o) => (o.tmdbId ?? tmdbId) === tmdbId && typeof o.tmdbSeason === "number").map((o) => o.tmdbSeason as number),
				]);
				const ranged = ranges ? await rangeRun(session, tmdbId, ranges) : undefined;
				if (typeof ranged === "string") return { ...fail(`Your TMDB Season ranges don't fit: ${ranged}.`), tmdbId };
				const run = ranged ?? (await seasonRun(session, tmdbId, seasons));
				// Position in the run: the TMDB episode number for one season, the running count for several
				const numbered = run.map((r, i) => ({ ...r.ep, episode_number: multi ? i + 1 : r.episode }));
				// Ranges take every later episode on purpose (sequels to come): no stop at a season finale
				const limit = ranges && !total ? Infinity : limitFor(numbered, offset);
				const keys = mainKeys.slice();
				for (const ep of numbered) {
					const n = ep.episode_number - offset;
					if (n >= 1 && n <= limit) keys.push(`${n}`);
				}
				for (const ep of override.episodeOverrides) if (ep.aniDBEpisode) keys.push(ep.aniDBEpisode);

				for (const key of keys) {
					const o = override.episodeOverrides.find((e) => e.aniDBEpisode === key) ?? {};
					const id: number = o.tmdbId ?? tmdbId;
					if (o.tmdbType === "movie" && o.tmdbId) {
						map[key] = { tmdbId: o.tmdbId, movie: true };
						continue;
					}
					const number = key.match(/\d+/);
					if (typeof o.tmdbSeason === "number") {
						const episode = o.tmdbEpisode ?? (number ? parseInt(number[0], 10) : undefined);
						if (episode !== undefined) map[key] = { tmdbId: id, season: o.tmdbSeason, episode };
						continue;
					}
					// The offset only applies to main episodes ("12"), not specials ("S1")
					const n = o.tmdbEpisode ?? (number ? parseInt(number[0], 10) + (/^\d+$/.test(key) ? offset : 0) : undefined);
					if (n === undefined) continue;
					if (!multi || id !== tmdbId) {
						map[key] = { tmdbId: id, season: seasons[0], episode: n };
						continue;
					}
					const hit = run[n - 1];
					if (hit) map[key] = { tmdbId: id, season: hit.season, episode: hit.episode };
				}
				return { status: "matched", source: "override", tmdbType, tmdbId, map, fallback: { season: seasons[0], offset, ...(multi && !ranges ? { seasons } : {}) } };
			}

			// Otherwise match air dates. ±1 day allows for Japan being ahead of the TMDB listing's timezone.
			const today = Math.floor(Date.now() / DAY);
			const allDated = mainKeys.map((k) => ({ n: Number(k), day: toDay(episodes[k].airDate) })).filter((d) => !isNaN(d.day));
			let dated = allDated.filter((d) => d.day <= today + 1);
			// Nothing aired yet: TMDB usually lists upcoming episodes with their dates too
			if (!dated.length) dated = allDated;
			// Without Animap dates, AniList's start date still pins down episode 1
			const start = media?.startDate;
			if (!dated.length && start?.year && start.month && start.day) dated = [{ n: 1, day: Math.round(Date.UTC(start.year, start.month - 1, start.day) / DAY) }];
			if (!dated.length) return { ...fail("There are no air dates to match against yet. Set the TMDB Season in the Media tab of Overrides."), tmdbId };
			// AniDB's air dates (the AniDB entry found or set for this anime), where they say something else: when the
			// anime's own don't line up, the match is tried with AniDB's instead
			let anidbDated: typeof dated | undefined;
			if (anidbMatch && anidbMatch.status !== "none" && anidbMatch.airDates) {
				const days: Record<number, number> = {};
				for (const d of dated) days[d.n] = d.day;
				let differs = false;
				for (const [k, v] of Object.entries(anidbMatch.airDates)) {
					const day = toDay(v);
					if (!/^\d+$/.test(k) || isNaN(day) || day > today + 1 || days[Number(k)] === day) continue;
					days[Number(k)] = day;
					differs = true;
				}
				if (differs) anidbDated = Object.keys(days).map((n) => ({ n: Number(n), day: days[Number(n)] }));
			}

			const first = Math.min(...dated.concat(anidbDated ?? []).map((d) => d.day));
			const last = Math.max(...dated.concat(anidbDated ?? []).map((d) => d.day));
			const show = details as CEM.TMDBTVShowDetails;
			const regular = (show.seasons ?? []).filter((s) => s.season_number > 0).sort((a, b) => a.season_number - b.season_number);
			// Only the seasons that overlap the anime's air dates, plus specials (ONAs and OVAs often live there)
			const wanted = regular
				.filter((s, i) => {
					const start = toDay(s.air_date);
					const next = toDay(regular[i + 1]?.air_date);
					return (isNaN(start) || start <= last + 1) && (isNaN(next) || next >= first - 1);
				})
				.map((s) => s.season_number);
			if ((show.seasons ?? []).some((s) => s.season_number === 0)) wanted.push(0);

			await session.prefetch(tmdbId, wanted);
			const candidates: { season: number; episode: number; day: number }[] = [];
			/** "season:episode" -> TMDB's air day, and which episodes TMDB marks as a season's finale */
			const tmdbDays: Record<string, number> = {};
			const finales: Record<string, boolean> = {};
			for (const n of wanted) {
				for (const ep of (await session.season(tmdbId, n)).episodes) {
					const day = toDay(ep.air_date);
					if (ep.episode_type === "finale") finales[`${n}:${ep.episode_number}`] = true;
					if (isNaN(day) || claimed[`${n}:${ep.episode_number}`]) continue;
					candidates.push({ season: n, episode: ep.episode_number, day });
					tmdbDays[`${n}:${ep.episode_number}`] = day;
				}
			}

			/**
			 * Every dated episode votes for the (season, offset) pairs that line its date up with a TMDB episode. Take the
			 * strongest pair, then repeat for what's left, so an entry spanning two TMDB seasons still maps. shift: how many
			 * days later TMDB dates the episodes (it often lists the TV broadcast, a week after the streaming release).
			 */

			const RUN_GAP = 4;
			// TMDB's episodes by air day: each dated episode only looks at the days around its own (long shows like
			// Doraemon have ~1800 episodes on each side, too many to compare all with all)
			const byDay: Record<number, typeof candidates> = {};
			for (const c of candidates) (byDay[c.day] ??= []).push(c);
			const vote = (shift: number, set: typeof dated) => {
				const minVotes = set.length === 1 ? 1 : 2;
				const map: Record<string, CEM.TMDBTarget> = {};
				const segments: { season: number; offset: number; from: number }[] = [];
				let remaining = set;
				let mapped = 0;
				// TMDB episodes an earlier round took: each goes to one episode only
				const claimedHere: Record<string, boolean> = {};
				while (remaining.length) {
					const score: Record<string, number> = {};
					const votes: Record<string, number> = {};
					const voted: Record<number, Record<string, boolean>> = {};
					for (const d of remaining) {
						const best: Record<string, number> = {};
						for (let diff = -1; diff <= 1; diff++) {
							for (const c of byDay[d.day + shift + diff] ?? []) {
								if (claimedHere[`${c.season}:${c.episode}`]) continue;
								const key = `${c.season}:${c.episode - d.n}`;
								best[key] = Math.max(best[key] ?? 0, diff === 0 ? 2 : 1);
							}
						}
						voted[d.n] = {};
						for (const key of Object.keys(best)) {
							score[key] = (score[key] ?? 0) + best[key];
							votes[key] = (votes[key] ?? 0) + 1;
							voted[d.n][key] = true;
						}
					}
					// Highest score; on a tie prefer a regular season over specials (the other way round when AniDB says these
					// are specials), then the smaller offset
					const specialsLast = (season: number) => ((season === 0) !== preferSpecials ? 1 : 0);
					const ranked = Object.keys(score).sort((a, b) => {
						const [sa, oa] = a.split(":").map(Number);
						const [sb, ob] = b.split(":").map(Number);
						return score[b] - score[a] || specialsLast(sa) - specialsLast(sb) || Math.abs(oa) - Math.abs(ob) || sa - sb;
					});
					const pick = ranked[0];
					if (!pick || votes[pick] < minVotes) break;

					const [season, offset] = pick.split(":").map(Number);
					// Only the pick's longest run of episodes (each at most RUN_GAP after the one before) becomes a part; its
					// other runs can win later rounds. When the two sides date episodes a day or two apart (two a week, e.g.
					// a donghua), other offsets get scattered votes all over: a part for those would split the match into
					// dozens of wrong ones. Such stray episodes follow the part they sit in instead.
					const voters = remaining.filter((d) => voted[d.n][pick]).sort((a, b) => a.n - b.n);
					const runs: (typeof voters)[] = [];
					for (const d of voters) {
						const run = runs[runs.length - 1];
						if (run && d.n - run[run.length - 1].n <= RUN_GAP) run.push(d);
						else runs.push([d]);
					}
					const taken = runs.reduce((a, b) => (b.length > a.length ? b : a));
					remaining = remaining.filter((d) => taken.indexOf(d) === -1);
					if (taken.length < minVotes) continue;
					for (const d of taken) {
						map[`${d.n}`] = { tmdbId, season, episode: d.n + offset };
						claimedHere[`${season}:${d.n + offset}`] = true;
					}
					mapped += taken.length;
					segments.push({ season, offset, from: taken[0].n });
				}
				// What speaks against it: a dated episode its segment puts on a TMDB episode dated elsewhere (e.g. episode 1 of
				// a second cour on the first cour's last episode, months earlier), or an episode on a TMDB finale with the
				// next episode right after it in the same season
				segments.sort((a, b) => a.from - b.from);
				const at = (n: number) => {
					const s = segments.filter((x) => x.from <= n).pop() ?? segments[0];
					return s ? `${s.season}:${n + s.offset}` : "";
				};
				let against = 0;
				for (const d of set) {
					const day = tmdbDays[at(d.n)];
					if (day !== undefined && Math.abs(day - shift - d.day) > 1) against++;
				}
				for (const key of mainKeys) {
					const here = at(Number(key));
					const [season, episode] = here.split(":").map(Number);
					if (finales[here] && episodes[`${Number(key) + 1}`] && at(Number(key) + 1) === `${season}:${episode + 1}`) against++;
				}
				return { map, segments, matched: mapped, against, shift };
			};
			// A week's shift only when it explains the dates better, with nothing at all against it
			const bestFor = (set: typeof dated) => {
				let best = vote(0, set);
				if (!best.segments.length || best.matched < set.length || best.against) {
					for (const shift of [7, -7]) {
						const other = vote(shift, set);
						if (other.segments.length && !other.against && other.matched > (best.segments.length ? best.matched - best.against : 0)) best = other;
					}
				}
				return best;
			};
			let best = bestFor(dated);
			const lines = (b: typeof best, set: typeof dated) => b.segments.length && b.matched * 2 >= set.length;
			if (anidbDated && !lines(best, dated)) {
				const withAnidb = bestFor(anidbDated);
				if (lines(withAnidb, anidbDated)) {
					log.step(`${mediaId}: ${best.matched} of ${dated.length} air dates matched TMDB ${tmdbId}; with AniDB ${anidbMatch?.aid}'s dates ${withAnidb.matched} of ${anidbDated.length} do: matched with those`);
					best = withAnidb;
					dated = anidbDated;
				}
			}
			if (best.shift) {
				log.step(`${mediaId}: TMDB ${tmdbId} dates these episodes ${Math.abs(best.shift)} days ${best.shift > 0 ? "later" : "earlier"} (e.g. the TV broadcast instead of the streaming release); matched with that shift`);
			}
			Object.assign(map, best.map);
			const segments = best.segments;
			const matched = best.matched;
			let byCount = false;
			let byTitle = false;
			let byName = false;
			// Animap's episode titles are often TMDB's word for word (placeholders like "Episode 4" don't count). Each titled
			// episode votes for the (season, offset) pairs that put it on a TMDB episode of the same title.
			const titled = mainKeys.map((k) => ({ n: Number(k), title: plainTitle(episodes[k].title) })).filter((t) => t.title);
			const titleVotes = async (numbers: number[]) => {
				const votes: Record<string, number> = {};
				const titles: Record<string, string> = {};
				for (const n of numbers) {
					for (const ep of (await session.season(tmdbId, n)).episodes) titles[`${n}:${ep.episode_number}`] = plainTitle(ep.name);
				}
				// TMDB's episodes by title, so each titled episode only looks at the ones with its title
				const byTitle: Record<string, string[]> = {};
				for (const key of Object.keys(titles)) if (titles[key]) (byTitle[titles[key]] ??= []).push(key);
				for (const t of titled) {
					const seen: Record<string, boolean> = {};
					for (const key of byTitle[t.title] ?? []) {
						const [season, episode] = key.split(":").map(Number);
						seen[`${season}:${episode - t.n}`] = true;
					}
					for (const key of Object.keys(seen)) votes[key] = (votes[key] ?? 0) + 1;
				}
				// The strongest (season, offset), when at least half the titled episodes agree on it and nothing ties
				const ranked = Object.keys(votes).sort((a, b) => votes[b] - votes[a]);
				const top = ranked[0] && votes[ranked[0]] * 2 >= titled.length && !(ranked[1] && votes[ranked[1]] === votes[ranked[0]]) ? ranked[0] : undefined;
				return { votes, titles, top, best: ranked[0] as string | undefined };
			};
			/** What replaces the air dates' match, when something else decides */
			let pick: { season: number; offset: number } | undefined;
			if (segments.length && matched * 2 >= dated.length && titled.length >= 2) {
				// The dates matched, but titles outrank them: when TMDB's dates run a week off, the dates can point one
				// episode too early with most of them still lining up
				const { votes, titles, top } = await titleVotes(wanted.filter((n) => n > 0));
				const hits = titled.filter((t) => map[`${t.n}`] && titles[`${map[`${t.n}`].season}:${map[`${t.n}`].episode}`] === t.title).length;
				if (top && votes[top] >= 2 && votes[top] > hits) {
					const [season, offset] = top.split(":").map(Number);
					log.step(`${mediaId}: the air dates put ${hits} of ${titled.length} episode titles on TMDB ${tmdbId}'s; matched by title instead (${votes[top]} titles, season ${season}${offset ? ` offset ${offset}` : ""})`);
					pick = { season, offset };
					byTitle = true;
				}
			} else if (!segments.length || matched * 2 < dated.length) {
				// The air dates don't line up: TMDB lists a streaming release (every episode on one day) instead of the
				// Japanese broadcast, or simply wrong dates. Episode titles come next.
				const numbers = regular.map((s) => s.season_number);
				if (titled.length) await session.prefetch(tmdbId, numbers.filter((n) => wanted.indexOf(n) === -1));
				const { votes, top, best } = titled.length ? await titleVotes(numbers) : { votes: {} as Record<string, number>, top: undefined, best: undefined };
				// A show found by this anime's exact title: its one regular season with as many episodes as the anime, every
				// date known within a week of TMDB's for the same episode number (TMDB a few days off, e.g. a release date
				// for the announced one)
				const count = total || highest;
				const nearSeason = () => {
					const fits = regular.filter((s) => s.episode_count === count);
					if (count < 1 || fits.length !== 1) return undefined;
					const n = fits[0].season_number;
					return dated.every((d) => tmdbDays[`${n}:${d.n}`] !== undefined && Math.abs(tmdbDays[`${n}:${d.n}`] - d.day) <= 7) ? n : undefined;
				};
				// Otherwise one regular season with exactly as many episodes as the anime, starting no earlier: episodes
				// then match by number
				const same = regular.filter((s) => s.episode_count === highest && !(toDay(s.air_date) < first - 1));
				const near = nameMatch ? nearSeason() : undefined;
				if (top) {
					const [season, offset] = top.split(":").map(Number);
					pick = { season, offset };
					byTitle = true;
					log.step(`${mediaId}: ${matched} of ${dated.length} air dates matched TMDB ${tmdbId}; matched by episode title instead (${votes[top]} of ${titled.length} titles, season ${season}${offset ? ` offset ${offset}` : ""})`);
				} else if (near !== undefined) {
					pick = { season: near, offset: 0 };
					byName = true;
					log.step(`${mediaId}: ${matched} of ${dated.length} air dates matched TMDB ${tmdbId}; its title is this anime's and its season ${pick.season} has as many episodes, all dated within a week: matched by that`);
				} else if (highest >= 2 && mainKeys.length === highest && same.length === 1) {
					pick = { season: same[0].season_number, offset: 0 };
					byCount = true;
					log.step(`${mediaId}: ${matched} of ${dated.length} air dates matched TMDB ${tmdbId}; matched by episode count instead (season ${same[0].season_number}, ${highest} episodes)`);
				} else {
					const titles = titled.length ? `, ${best ? votes[best] : 0} of ${titled.length} by title` : "";
					return { ...fail(`Only ${matched} of ${dated.length} episodes matched TMDB ${tmdbId} by air date${titles}. Set the TMDB Season and Offset in Overrides.`), tmdbId };
				}
			}
			if (pick) {
				for (const key of Object.keys(map)) delete map[key];
				segments.length = 0;
				segments.push({ ...pick, from: 1 });
			}

			// Undated, unaired or unmatched episodes follow the segment they sit in, but never onto a TMDB episode another
			// episode already matched by its date
			segments.sort((a, b) => a.from - b.from);
			const segmentFor = (n: number) => segments.filter((s) => s.from <= n).pop() ?? segments[0];
			const used: Record<string, boolean> = {};
			for (const key of mainKeys) if (map[key]) used[`${map[key].season}:${map[key].episode}`] = true;
			for (const key of mainKeys) {
				if (map[key]) continue;
				const s = segmentFor(Number(key));
				const episode = Number(key) + s.offset;
				if (episode < 1 || used[`${s.season}:${episode}`]) continue;
				map[key] = { tmdbId, season: s.season, episode };
				used[`${s.season}:${episode}`] = true;
			}
			// Episodes TMDB already lists but Animap doesn't have yet
			const fallback = segments[segments.length - 1];
			const seasonEpisodes = (await session.season(tmdbId, fallback.season)).episodes;
			const limit = limitFor(seasonEpisodes, fallback.offset);
			for (const ep of seasonEpisodes) {
				const n = ep.episode_number - fallback.offset;
				if (n > highest && n <= limit) map[`${n}`] = { tmdbId, season: fallback.season, episode: ep.episode_number };
			}

			// Specials only map on a single, unambiguous date match in TMDB's specials
			for (const key of Object.keys(episodes).filter((k) => /^S\d+$/.test(k))) {
				const day = toDay(episodes[key].airDate);
				if (isNaN(day)) continue;
				const hits = candidates.filter((c) => c.season === 0 && Math.abs(c.day - day) <= 1);
				const exact = hits.filter((c) => c.day === day);
				const hit = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : undefined;
				if (hit) map[key] = { tmdbId, season: 0, episode: hit.episode };
			}

			// Seanime shows AniDB's first special as episode 0 when AniList counts one episode more than AniDB has main
			// episodes. Not dated alike on TMDB: its special called "Episode 0", if there's exactly one.
			if (!map.S1 && episodes.S1 && total === highest + 1 && (show.seasons ?? []).some((s) => s.season_number === 0)) {
				const named = (await session.season(tmdbId, 0)).episodes.filter((ep) => /\b(episode|ep\.?)\s*(0|zero)\b|#0\b/i.test(ep.name ?? ""));
				if (named.length === 1) {
					map.S1 = { tmdbId, season: 0, episode: named[0].episode_number };
					log.step(`${mediaId}: episode 0 (S1) is TMDB S0E${named[0].episode_number} "${named[0].name}"`);
				}
			}

			// Episode overrides always win
			for (const o of override.episodeOverrides) {
				if (!o.aniDBEpisode) continue;
				if (o.tmdbType === "movie" && o.tmdbId) {
					map[o.aniDBEpisode] = { tmdbId: o.tmdbId, movie: true };
					continue;
				}
				const base = map[o.aniDBEpisode];
				const number = o.aniDBEpisode.match(/\d+/);
				const season = o.tmdbSeason ?? base?.season;
				const episode = o.tmdbEpisode ?? base?.episode ?? (number ? parseInt(number[0], 10) : undefined);
				if (season !== undefined && episode !== undefined) map[o.aniDBEpisode] = { tmdbId: o.tmdbId ?? tmdbId, season, episode };
			}

			return { status: "matched", source: "auto", tmdbType, tmdbId, map, fallback: { season: fallback.season, offset: fallback.offset }, segments, ...(byCount ? { byCount } : {}), ...(byTitle ? { byTitle } : {}), ...(byName ? { byName } : {}) };
		}

		const inFlight: Record<number, Promise<RefreshResult>> = {};

		/**
		 * Rematch one anime, store its stills and, when asked, write the TMDB data into its custom metadata
		 * (what Bulk Update does). A forced call waits for a refresh already running instead of reusing it. The scope
		 * says how AniList relation lookups are paced (see Scope); the user's own actions use "page".
		 */
		async function refreshAnime(mediaId: number, writeMetadata: boolean, force = false, scope: Scope = "page"): Promise<RefreshResult> {
			const running = inFlight[mediaId];
			if (running) {
				if (!force) {
					log.step(`${mediaId}: joining the refresh already running`);
					return running;
				}
				await running.catch(() => undefined);
				log.step(`${mediaId}: refreshing again after the running refresh (forced)`);
			}
			const job = doRefresh(mediaId, writeMetadata, force, scope);
			inFlight[mediaId] = job;
			try {
				return await job;
			} finally {
				if (inFlight[mediaId] === job) delete inFlight[mediaId];
			}
		}

		async function doRefresh(mediaId: number, writeMetadata: boolean, force = false, scope: Scope = "page"): Promise<RefreshResult> {
			const result: RefreshResult = { saved: 0, missing: [] };
			if (!tmdb.API_KEY?.length) return result;

			const old = thumbnails.get(mediaId);
			const now = Date.now();
			// Animap may have added an anime it had no entry for; while the flag is set the metadata carries no TMDB ID
			// or air dates. Asking clears Seanime's whole metadata cache, so it's re-checked daily for the first week
			// (the first "no entry" may have been Animap or the network failing), weekly after that, and whenever the
			// user saves overrides or runs Bulk Update.
			const status = animap.get(mediaId);
			const every = now - (status?.since ?? 0) < 7 * DAY ? DAY : 7 * DAY;
			if (status?.fallback && (force || now - (status.checkedAt ?? 0) >= every)) await checkAnimap(mediaId);
			let media: $app.AL_BaseAnime | undefined;
			let metadata: $app.Metadata_AnimeMetadata | undefined;
			try {
				media = (await ctx.anime.getAnimeEntry(mediaId)).media;
			} catch {}
			// Newly aired episodes join the generated list without waiting for the weekly re-check or a page visit
			if (syncEpisodeCount(mediaId, media)) scheduleRebuild(false, mediaId);
			try {
				metadata = await loadMetadata(mediaId);
			} catch {}
			// No Animap data (e.g. 18+ entries): flag it, so onAnimeMetadataRequested can supply the episode list the
			// TMDB stills and custom metadata are applied to
			const flagged = !metadata && !animap.get(mediaId) && mediaId < 0x80000000;
			if (flagged) animap.set(mediaId, { fallback: true, episodeCount: episodeCount(media), checkedAt: now, since: now });

			const session = tmdbSession();
			const override = tmdb.overrides.get(mediaId);
			let mapping: Mapping;
			try {
				mapping = await buildMapping(mediaId, media, metadata, session, override);
				mapping.idFrom = override.tmdbId ? "your override" : "Animap";
				// No ID from the override or Animap: search TMDB by title, each hit checked against the air dates. Air dates
				// from Animap make that check strong, or AniList's full start date for an anime that hasn't aired yet (TMDB
				// has to date its first episode that day), or for a one-episode anime its start year (a movie found has to
				// have come out that year; a show can't line up without dates); anime without any need the fill-in setting.
				const start = media?.startDate;
				const unaired = !!(start?.year && start.month && start.day) && !Object.keys(metadata?.episodes ?? {}).some((k) => /^\d+$/.test(k));
				const single = !!start?.year && (Number(media?.episodes) || 0) <= 1;
				const dated = unaired || single || Object.keys(metadata?.episodes ?? {}).some((k) => !!metadata?.episodes?.[k]?.airDate);
				if (mapping.status === "failed" && !override.tmdbId) {
					const custom = mediaId >= 0x80000000; // custom sources have no mappings, the title is all there is
					const { found, firstValid } = await searchTmdb(
						mediaId, media, metadata, session, undefined, dated || custom || fillsMissing(mediaId), mapping.tmdbId ? [mapping.tmdbId] : [], scope,
					);
					if (found) {
						const again = await buildMapping(mediaId, media, metadata, session, { ...override, tmdbId: found.id, tmdbType: found.mapping.tmdbType }, found.borrowed ? claimedEpisodes(mediaId, found.id) : {});
						mapping = { ...(again.status === "matched" ? again : found.mapping), source: "auto", idFrom: found.from, ...(found.borrowed ? { borrowed: true } : {}) };
					} else if (mapping.noId && firstValid) {
						// Say what was found and why it didn't fit, not just that Animap had nothing
						mapping = { ...mapping, reason: `TMDB ${firstValid.id} (from ${firstValid.from}) didn't line up: ${firstValid.reason ?? "no match"}` };
					}
				}
			} catch (e) {
				// A request error (offline, TMDB down) keeps a good match; the next refresh tries again
				if (old?.status === "matched") {
					log.warn(`${mediaId}: TMDB request failed, keeping the previous match:`, e);
					return { ...result, record: old };
				}
				mapping = { status: "failed", reason: (e as Error).message, map: {} };
			}

			const images: Record<string, string> = {};
			const found: Record<string, TMDBEpisode> = {};
			const today = Math.floor(now / DAY);
			const nextEpisode = Number(media?.nextAiringEpisode?.episode) || 0;
			// A just-aired episode without a still or overview: TMDB's CDN may serve a copy up to 6 hours old, so the
			// season is fetched again past it (episodes from the last 14 days only)
			const freshlyAired = (key: string) => {
				if (!/^\d+$/.test(key)) return false;
				const day = toDay(metadata?.episodes?.[key]?.airDate);
				return isNaN(day) ? Number(key) < nextEpisode && Number(key) >= nextEpisode - 2 : day <= today + 1 && today - day <= 14;
			};
			const lacks = (e: TMDBEpisode) => !e.still_path || !e.overview;
			// What a second copy adds: only fields the first lacks
			const merge = (e: TMDBEpisode, more: TMDBEpisode | undefined, where: string, key: string) => {
				if (!more || !((more.still_path && !e.still_path) || (more.overview && !e.overview))) return e;
				log.step(`${mediaId}: episode ${key}: TMDB's ${where} has more than its cached season list; using it`);
				return { ...e, still_path: e.still_path || more.still_path, overview: e.overview || more.overview, name: plainTitle(e.name) ? e.name : more.name || e.name };
			};
			const fresh: Record<string, Promise<CEM.TMDBSeasonResults | undefined>> = {};
			const freshSeason = (tmdbId: number, season: number) =>
				(fresh[`${tmdbId}:${season}`] ??= tmdb.getSeasons(tmdbId, [season], now).then((r) => r[season], () => undefined));
			for (const [key, target] of Object.entries(mapping.map)) {
				let episode = await session.episode(target);
				if (episode && lacks(episode) && freshlyAired(key) && target.season !== undefined && target.episode !== undefined) {
					const tmdbId = target.tmdbId, season = target.season, number = target.episode;
					episode = merge(episode, (await freshSeason(tmdbId, season))?.episodes?.find((e) => e.episode_number === number), "current season list", key);
				}
				if (!episode) continue;
				found[key] = episode;
				if (episode.still_path?.length) images[key] = episode.still_path;
			}

			// Seanime has no metadata for this anime: keep TMDB's episode data in the background to fill it in. With
			// metadata, only for the episodes (or the movie) it has no overview or thumbnail for.
			let episodes: CEM.ThumbnailRecord["episodes"];
			const gapList = isOn("tmdb-fill-missing") ? gapKeys(mediaId) : [];
			if (isOn("tmdb-fill-missing") && mapping.status === "matched") {
				const all = fillsMissing(mediaId);
				const gaps = all ? [] : gapList;
				// Aired main episodes Animap doesn't list yet count as gaps too. Aired by TMDB's date, or by AniList's next
				// episode when TMDB dates them later (the TV broadcast, a week after streaming)
				const aired = new Date(now).toISOString().slice(0, 10);
				const airedEarly = (key: string) => /^\d+$/.test(key) && Number(key) < nextEpisode && !(found[key].air_date && found[key].air_date <= aired);
				const absent = (key: string) => /^\d+$/.test(key) && !metadata?.episodes?.[key] && ((!!found[key].air_date && found[key].air_date <= aired) || airedEarly(key));
				for (const [key, ep] of Object.entries(found)) {
					if (!all && gaps.indexOf(key) === -1 && !absent(key)) continue;
					// Nothing to fill in: TMDB's placeholder ("Episode 17") without an overview, still or runtime
					if (!all && !plainTitle(ep.name) && !ep.overview && !images[key] && !ep.runtime) continue;
					// A placeholder title isn't kept: it would replace the episode's own number ("Episode 273" on episode 1)
					(episodes ??= {})[key] = {
						...(plainTitle(ep.name) ? { title: ep.name } : {}),
						overview: ep.overview,
						airDate: ep.air_date,
						length: ep.runtime ?? undefined,
						...(airedEarly(key) ? { aired: true } : {}),
					};
				}
			}

			// Next refresh: an hour after the next episode airs (TMDB usually has it by then); while a recent episode still
			// has no still (or, with fill-in, nothing to fill in its missing overview) every 2 hours for its
			// first 2 days, then daily; weekly otherwise. Aired: by Animap's date, a day ahead since it's Japan's (an
			// episode at 00:30 there is the day before in UTC), or by AniList's next episode (Animap may date the TV
			// broadcast a week after the stream)
			const lacking = Object.entries(metadata?.episodes ?? {})
				.filter(([key]) => /^\d+$/.test(key))
				.map(([key, ep]) => {
					const day = toDay(ep.airDate);
					const aired = (!isNaN(day) && day <= today + 1) || Number(key) < nextEpisode;
					const recent = isNaN(day) || today - day <= 30;
					const missing = !images[key] ? isOn("tmdb-thumbnails") || !isOn("tmdb-fill-missing") || gapList.indexOf(key) !== -1 : gapList.indexOf(key) !== -1 && !found[key]?.overview;
					return aired && recent && missing ? (isNaN(day) ? today : Math.min(day, today)) : NaN;
				})
				.filter((day) => !isNaN(day));
			const recentWithoutStill = lacking.length > 0;
			const justAired = lacking.some((day) => today - day <= 2);
			// A failed match: daily for its first week of failing (TMDB may add the anime, or a related one gets matched),
			// weekly after that (e.g. an anime TMDB doesn't list at all). A refresh by hand doesn't restart the week.
			const failedSince = mapping.status === "failed" ? (old?.status === "failed" ? old.failedSince ?? old.refreshedAt : now) : undefined;
			const failedEvery = failedSince !== undefined && now - failedSince >= 7 * DAY ? 7 * DAY : DAY;
			let nextCheckAt = now + (mapping.status === "failed" ? failedEvery : 7 * DAY);
			const airingAt = media?.nextAiringEpisode?.airingAt;
			if (airingAt) nextCheckAt = Math.min(nextCheckAt, Math.max(now + HOUR, airingAt * 1000 + HOUR));
			else if (media?.nextAiringEpisode) nextCheckAt = Math.min(nextCheckAt, now + DAY);
			if (recentWithoutStill) nextCheckAt = Math.min(nextCheckAt, now + (justAired ? 2 * HOUR : DAY));

			const { movie: _movie, segments, noId, ...stored } = mapping;
			const record: CEM.ThumbnailRecord = {
				mediaId,
				...stored,
				images,
				...(episodes ? { episodes } : {}),
				nextCheckAt,
				...(failedSince !== undefined ? { failedSince } : {}),
				refreshedAt: now,
				lastSeenAt: old?.lastSeenAt ?? now,
			};
			thumbnails.set(mediaId, record);
			result.record = record;
			// A movie, or a show's main episodes, belong to one anime: one that borrowed them from a related anime or a search
			// gets matched again once the anime they're the own match of is matched
			if (record.status === "matched" && !record.borrowed) {
				const mine = (r: CEM.ThumbnailRecord) =>
					Object.keys(r.map).filter((k) => /^\d+$/.test(k) && r.map[k].tmdbId === record.tmdbId).map((k) => `${r.map[k].season}:${r.map[k].episode}`);
				const own = mine(record);
				for (const other of Object.values(thumbnails.all())) {
					if (other.mediaId === mediaId || other.tmdbId !== record.tmdbId || other.tmdbType !== record.tmdbType || !other.borrowed || other.nextCheckAt === 1) continue;
					if (record.tmdbType === "tv" && !mine(other).some((t) => own.indexOf(t) !== -1)) continue;
					log.step(`${other.mediaId}: TMDB ${record.tmdbId}${record.tmdbType === "tv" ? "'s episodes are" : " is"} ${mediaId}'s own match; matching ${other.mediaId} again`);
					thumbnails.set(other.mediaId, { ...other, nextCheckAt: 1 }); // due now
				}
			}

			if (writeMetadata && record.status === "matched") {
				const explicit = tmdb.overrides.get(mediaId).episodeOverrides.map((o) => o.aniDBEpisode);
				for (const key of Object.keys(mapping.map)) {
					const episode = found[key];
					if (!episode) {
						// Only worth a warning when the episode should exist by now
						const day = toDay(metadata?.episodes?.[key]?.airDate);
						if (explicit.indexOf(key) !== -1 || (!isNaN(day) && day < today)) result.missing.push(key);
						continue;
					}
					const update: CEM.CustomEpisodeMetadata = { episode: key };
					if (episode.name?.length) update.title = episode.name;
					if (typeof episode.runtime === "number") update.length = episode.runtime;
					if (episode.air_date?.length) update.airDate = episode.air_date;
					if (episode.overview?.length) update.overview = episode.overview;
					if (images[key]) update.image = tmdbImage(images[key]);
					database.save(mediaId, update);
					result.saved++;
				}
			}

			const shown = (r: CEM.ThumbnailRecord | undefined) => (r?.status === "matched" ? stableJson([r.images, r.episodes ?? {}]) : "");
			const imagesChanged = (isOn("tmdb-thumbnails") || fillsMissing(mediaId) || !!record.episodes || !!old?.episodes) && (flagged || shown(old) !== shown(record));
			// Whether Seanime has metadata for it doesn't change with what was written. Not known yet: the metadata loaded
			// above already answers it (without a status the hook didn't supply it), so there's no need to clear Seanime's
			// cache and ask Animap again. Custom sources provide their own metadata and get no status.
			if (result.saved && metadata && !animap.get(mediaId) && mediaId < 0x80000000) animap.set(mediaId, { fallback: false, episodeCount: 0, checkedAt: now });
			if (result.saved || imagesChanged) scheduleRebuild(imagesChanged, mediaId);

			const name = media?.title?.userPreferred ?? `${mediaId}`;
			if (record.status === "failed") {
				if (old?.status !== "failed" || old.reason !== record.reason) log.warn(`${name} (${mediaId}): match failed: ${record.reason}`);
				else log.step(`${name} (${mediaId}): still failing: ${record.reason}`);
			} else {
				const where = record.tmdbType === "movie" ? "movie" : `S${record.fallback?.season ?? "?"}${record.fallback?.offset ? ` offset ${record.fallback.offset}` : ""}`;
				const line = `${name} (${mediaId}): TMDB ${record.tmdbId} ${where}, ID from ${record.idFrom ?? "?"}, ${Object.keys(images).length} stills${result.saved ? `, ${result.saved} episodes written` : ""}`;
				if (imagesChanged || result.saved || old?.tmdbId !== record.tmdbId) log.info(line);
				else log.step(`${line} (unchanged)`);
			}
			const why =
				mapping.status === "failed"
					? `failed${failedEvery > DAY ? " for over a week, weekly" : ", daily"}`
					: recentWithoutStill && record.nextCheckAt === now + (justAired ? 2 * HOUR : DAY)
						? `a recent episode has no still or overview yet, ${justAired ? "every 2 hours" : "daily"}`
						: airingAt
							? "an hour after the next episode airs"
							: media?.nextAiringEpisode
								? "airing, daily"
								: "finished, weekly";
			log.step(`${name} (${mediaId}): next refresh ${new Date(record.nextCheckAt ?? 0).toISOString()} (${why})`);
			if ($debug.enabled) {
				const { episodes: _filled, ...shown } = record;
				log.inspect(`${mediaId}: stored TMDB record`, shown);
			}

			updateBadge();
			return result;
		}

		/**
		 * What's missing for the anime being viewed: a TMDB match (when one is wanted), an AniDB ID (when Seanime has none
		 * and the lookup found none). "Needs a page visit" isn't missing: opening the page resolves it.
		 */
		function problems(mediaId: number) {
			const out: ("TMDB" | "AniDB")[] = [];
			if (tmdb.overrides.get(mediaId).ignoreWarnings) return out;
			const record = thumbnails.get(mediaId);
			if (record?.status === "failed" && wantsMatch(mediaId)) out.push("TMDB");
			const seanime = $store.get(`CEM_SEANIME_ANIDB_${mediaId}`);
			const match = anidbStore.get(mediaId);
			// The lookup only runs for anime Seanime has no AniDB ID for; one Seanime has since got isn't missing
			if (!Number(seanime) && match?.status === "none" && !tmdb.overrides.get(mediaId).anidbId) out.push("AniDB");
			return out;
		}
		const problemText = (missing: ("TMDB" | "AniDB")[]) =>
			missing.length === 2 ? "No TMDB match and no AniDB ID: open Overrides" : missing[0] === "TMDB" ? "No TMDB match: open Overrides" : missing.length ? "No AniDB ID: open Overrides" : "";

		/** Warning badge on the tray: how many of the TMDB match and the AniDB ID the anime being viewed is missing. */
		function updateBadge() {
			const media = currentMedia.get();
			tray.updateBadge({ number: media ? problems(media.id).length : 0, intent: "warning" });
		}

		/** Where the AniDB ID Seanime uses for this anime comes from, for the Media tab. */
		function anidbStatus(mediaId: number) {
			const override = tmdb.overrides.get(mediaId).anidbId;
			if (override) return `AniDB ID: ${override}, your override.`;
			const match = anidbStore.get(mediaId);
			const seanime = Number($store.get(`CEM_SEANIME_ANIDB_${mediaId}`)) || 0;
			// Seanime's own: the AniDB ID in its Animap data (unless it's the one the plugin added)
			if (seanime && !(match?.aid === seanime && match.status === "verified")) return `AniDB ID: ${seanime}, from Seanime's metadata (Animap).`;
			if (match?.status === "verified") {
				const at = match.offset ? `, from its episode ${match.offset + 1}${match.specials ? " of the specials" : ""}` : match.specials ? ", its specials" : "";
				return `AniDB ID: ${match.aid}${at}, found through ${match.from ?? "a lookup"} and checked against AniDB: ${match.reason ?? "air dates line up"}.`;
			}
			if (match?.status === "none") return `AniDB ID: none found${match.reason ? `: ${match.reason}` : ""}.`;
			return anidbLookup() ? "AniDB ID: not looked up yet." : "AniDB ID: the lookup is off.";
		}
		/** One line describing how the anime is matched on TMDB. */
		function matchStatus(mediaId: number) {
			const record = thumbnails.get(mediaId);
			if (!record) return wantsMatch(mediaId) ? "TMDB match: not matched yet." : "TMDB match: thumbnails, fill-in and the automatic refresh are off.";
			if (record.status === "failed") return `TMDB match failed: ${record.reason ?? "unknown error"}`;
			const via = record.source === "override" ? "from the overrides" : `${record.byTitle ? "by episode title (the air dates didn't line up)" : record.byName ? "by its exact title and episode count (TMDB's dates are a few days off)" : record.byCount ? "by episode count (the air dates didn't line up)" : "by air date"}, ID from ${record.idFrom ?? "Animap"}`;
			if (record.tmdbType === "movie") return `TMDB match: movie ${record.tmdbId}, ${via}.`;
			const offset = record.fallback?.offset ?? 0;
			const seasonText = record.fallback?.seasons ? `seasons ${formatSeasons(record.fallback.seasons)}` : `season ${record.fallback?.season}`;
			// Episodes spread over several TMDB seasons (or offsets): each run, e.g. "1-24 S1E1-24; 25-48 S2E1-24"
			const runs = episodeRuns(record);
			const where =
				runs.length > 1
					? `, ${runs.length} parts: ${runs.map((r) => `${r.from === r.to ? r.from : `${r.from}-${r.to}`} S${r.season}E${r.first === r.last ? r.first : `${r.first}-${r.last}`}`).join("; ")}`
					: record.fallback
						? `, ${seasonText}${offset ? `, offset ${offset > 0 ? "+" : ""}${offset}` : ""}`
						: "";
			// Stills of main episodes and of specials (S1, S2: Animap's specials, OVAs and the like)
			const keys = Object.keys(record.images);
			const main = keys.filter((k) => /^\d+$/.test(k)).length;
			const stills = keys.length === main ? `${main} stills` : `${keys.length} stills (${main} episodes, ${keys.length - main} specials)`;
			return `TMDB match: show ${record.tmdbId}${where}, ${via}. ${stills}.`;
		}
		/** The main episodes' TMDB targets as runs: consecutive episodes on the same TMDB season, one after the other. */
		function episodeRuns(record: CEM.ThumbnailRecord) {
			const runs: { from: number; to: number; season: number; first: number; last: number; tmdbId: number }[] = [];
			const keys = Object.keys(record.map)
				.filter((k) => /^\d+$/.test(k))
				.map(Number)
				.sort((a, b) => a - b);
			for (const n of keys) {
				const t = record.map[`${n}`];
				if (t?.season === undefined || t.episode === undefined) continue;
				const run = runs[runs.length - 1];
				if (run && run.to === n - 1 && run.season === t.season && run.tmdbId === t.tmdbId && run.last === t.episode - 1) {
					run.to = n;
					run.last = t.episode;
				} else runs.push({ from: n, to: n, season: t.season, first: t.episode, last: t.episode, tmdbId: t.tmdbId });
			}
			return runs;
		}

		/**
		 * The Refresh button: this anime only, everything at once, even when nothing has expired. Re-checks Animap, the
		 * AniDB ID and the TMDB match (related anime included), then rebuilds Seanime's data for the open page.
		 */
		async function refreshEntry(mediaId: number) {
			log.mark(`Refresh button: ${mediaId}`);
			log.info(`${mediaId}: refreshing by hand (Refresh button)`);
			await detectMissing(mediaId);
			if (await needsAnidb(mediaId)) await refreshAnidb(mediaId, true);
			const result = await refreshAnime(mediaId, false, true);
			scheduleRebuild(true);
			const record = result.record;
			if (!record) return "Refreshed.";
			if (record.status === "failed") throw new Error(record.reason ?? "Couldn't match this anime on TMDB.");
			return `Refreshed: TMDB ${record.tmdbId}, ${Object.keys(record.images).length} stills${result.saved ? `, ${result.saved} episodes written` : ""}.`;
		}

		/** After overrides change: rematch straight away, writing metadata only if the automatic refresh would. */
		function rematch(mediaId: number) {
			if (!wantsMatch(mediaId)) return;
			log.step(`${mediaId}: overrides changed, matching again`);
			refreshAnime(mediaId, false, true)
				.then(() => tray.update())
				.catch((e) => log.error(`${mediaId}: matching again after the overrides changed failed:`, e));
		}

		/** ani.zip's mappings for an anime. Its TMDB coverage is a little better than Animap's. */
		async function anizip(mediaId: number): Promise<{ tmdbId?: number; anidbId?: number }> {
			try {
				const res = await ctx.fetch(`https://api.ani.zip/mappings?anilist_id=${mediaId}`);
				if (!res.ok) return {};
				const mappings = (res.json() as { mappings?: { themoviedb_id?: string | number; anidb_id?: number } }).mappings ?? {};
				const result = { tmdbId: Number(`${mappings.themoviedb_id ?? ""}`.replace(/\D/g, "")) || undefined, anidbId: mappings.anidb_id || undefined };
				log.debug(`${mediaId}: ani.zip`, result);
				return result;
			} catch {
				return {};
			}
		}

		/**
		 * AnimeAPI's mappings. The public instance allows about 30 requests per 10 minutes, so answers (including "has
		 * none") are kept on disk for two weeks and calls are spaced at least 20 seconds apart; a call that would come
		 * too soon is skipped and the anime simply tries again on its next refresh.
		 */
		const ANIMEAPI_KEY = "ANIMEAPI_CACHE_V1";
		let animeapiLastCall = 0;
		async function animeapi(mediaId: number): Promise<{ tmdbId?: number; tmdbType?: "tv" | "movie"; anidbId?: number }> {
			const cache = $storage.get<Record<number, { tmdbId?: number; tmdbType?: "tv" | "movie"; anidbId?: number; at: number }>>(ANIMEAPI_KEY) ?? {};
			const hit = cache[mediaId];
			if (hit && Date.now() - hit.at < 14 * DAY) return hit;
			if (Date.now() - animeapiLastCall < 20 * 1000) {
				log.debug(`${mediaId}: AnimeAPI skipped (rate limit)`);
				return {};
			}
			animeapiLastCall = Date.now();
			try {
				const res = await ctx.fetch(`https://animeapi.my.id/anilist/${mediaId}`, { timeout: 10 });
				if (!res.ok && res.status !== 404) return {};
				const data = (res.ok ? res.json() : {}) as { themoviedb?: number | null; themoviedb_type?: "tv" | "movie" | null; anidb?: number | null };
				const result = { tmdbId: data.themoviedb || undefined, tmdbType: data.themoviedb_type || undefined, anidbId: data.anidb || undefined };
				log.debug(`${mediaId}: AnimeAPI`, result);
				cache[mediaId] = { ...result, at: Date.now() };
				$storage.set(ANIMEAPI_KEY, cache);
				return result;
			} catch (e) {
				log.debug(`${mediaId}: AnimeAPI failed`, e);
				return {};
			}
		}

		const RELATIONS_KEY = "ANILIST_RELATIONS_V1";
		/** The relation steps on disk, read once (only this context uses them) and written through. */
		let relationCache: Record<number, CEM.RelationStep> | undefined;
		const relationSteps = () => (relationCache = relationCache ?? $storage.get<Record<number, CEM.RelationStep>>(RELATIONS_KEY) ?? {});
		/**
		 * One step up from an anime: its parent, else its prequel. Cached on disk for 30 days, so sequels sharing a
		 * prequel and repeat visits don't ask AniList again. $anilist.getAnimeDetails blocks this whole context until
		 * AniList answers, so in the background the calls are spaced out. undefined: AniList couldn't be asked.
		 */
		async function relationStep(mediaId: number, scope: Scope): Promise<CEM.RelationStep["next"] | undefined> {
			const hit = relationSteps()[mediaId];
			// Steps cached before the episode count was kept are asked again
			if (hit && Date.now() - hit.at < 30 * DAY && !(hit.next && hit.next.episodes === undefined)) {
				log.debug(`${mediaId}: parent/prequel (cached): ${hit.next ? `${hit.next.relation} ${hit.next.id}` : "none"}`);
				return hit.next;
			}
			if (scope !== "page") await spaced("anilist-relations", 3000);
			let edges: $app.AL_AnimeDetailsById_Media_Relations_Edges[] = [];
			try {
				const details = $anilist.getAnimeDetails(mediaId);
				// No answer isn't "no relations": don't remember it for 30 days
				if (!details) return undefined;
				edges = details.relations?.edges ?? [];
			} catch (e) {
				log.debug(`${mediaId}: AniList relations unavailable`, e);
				return undefined;
			}
			const edge =
				edges.find((e) => e.relationType?.valueOf() === "PARENT" && e.node?.type?.valueOf() !== "MANGA") ??
				edges.find((e) => e.relationType?.valueOf() === "PREQUEL" && e.node?.type?.valueOf() !== "MANGA");
			const next = edge?.node?.id
				? { id: edge.node.id, title: edge.node.title?.userPreferred ?? `${edge.node.id}`, relation: edge.relationType!.valueOf().toLowerCase(), episodes: Number(edge.node.episodes) || 0 }
				: null;
			log.debug(`${mediaId}: parent/prequel (asked AniList): ${next ? `${next.relation} ${next.id}` : "none"}`);
			const steps = relationSteps();
			const now = Date.now();
			steps[mediaId] = { next, at: now };
			// Drop expired steps while writing
			for (const key of Object.keys(steps)) if (now - steps[Number(key)].at >= 30 * DAY) delete steps[Number(key)];
			$storage.set(RELATIONS_KEY, steps);
			return next;
		}

		/**
		 * The anime's parent and prequels on AniList (specials and later seasons often share their TMDB entry): up to five
		 * steps up (a fifth season's only link may be the first), the parent first, then the prequel chain.
		 */
		async function relatedAnime(mediaId: number, scope: Scope): Promise<NonNullable<CEM.RelationStep["next"]>[]> {
			if (mediaId >= 0x80000000) return [];
			const out: NonNullable<CEM.RelationStep["next"]>[] = [];
			let current = mediaId;
			log.time(`relations ${mediaId}`);
			for (let step = 0; step < 5; step++) {
				const next = await relationStep(current, scope);
				if (!next || next.id === mediaId || out.some((r) => r.id === next.id)) break;
				out.push(next);
				current = next.id;
			}
			log.timeEnd(`relations ${mediaId}`);
			log.step(`${mediaId}: related anime: ${out.length ? out.map((r) => `${r.relation} ${r.id}`).join(" -> ") : "none"}`);
			return out;
		}

		/** TMDB IDs known for an AniList anime, most trusted first: Animap, ani.zip, AnimeAPI. */
		async function knownIds(mediaId: number, metadata?: $app.Metadata_AnimeMetadata) {
			const ids: { id: number; from: string; type?: "tv" | "movie" }[] = [];
			const add = (id: number | undefined, from: string, type?: "tv" | "movie") => {
				if (id && !ids.some((x) => x.id === id)) ids.push({ id, from, ...(type ? { type } : {}) });
			};
			if (metadata === undefined && mediaId < 0x80000000) {
				try {
					metadata = await loadMetadata(mediaId);
				} catch {}
			}
			add(Number((metadata?.mappings?.themoviedbId ?? "").replace(/\D/g, "")) || undefined, "Animap");
			if (mediaId < 0x80000000) {
				add((await anizip(mediaId)).tmdbId, "ani.zip");
				if (!ids.length) {
					const api = await animeapi(mediaId);
					add(api.tmdbId, "AnimeAPI", api.tmdbType === "tv" || api.tmdbType === "movie" ? api.tmdbType : undefined);
				}
			}
			return ids;
		}

		/** Whether TMDB has any still (or a movie backdrop) for a mapping's episodes. Seasons are already cached. */
		async function hasStills(mapping: Awaited<ReturnType<typeof buildMapping>>, session: ReturnType<typeof tmdbSession>) {
			for (const target of Object.values(mapping.map)) if ((await session.episode(target))?.still_path?.length) return true;
			return false;
		}

		/**
		 * The TMDB episodes of a show other anime have as their own main episodes (matched with their own IDs): an anime
		 * borrowing that show's ID doesn't get them. Their specials don't count: a related anime is often those specials.
		 */
		function claimedEpisodes(mediaId: number, tmdbId: number) {
			const claimed: Record<string, boolean> = {};
			for (const r of Object.values(thumbnails.all())) {
				if (r.mediaId === mediaId || r.status !== "matched" || r.tmdbType !== "tv" || r.borrowed) continue;
				for (const [key, t] of Object.entries(r.map)) if (/^\d+$/.test(key) && t.tmdbId === tmdbId && t.season !== undefined) claimed[`${t.season}:${t.episode}`] = true;
			}
			return claimed;
		}

		/**
		 * A title without a season number at the end ("Edgerunners 2", "エッジランナーズ2", "Season 3", "第2期"), then without
		 * its subtitle ("Dacryon - Luna: ...", "ダクリュオン・ルナ ~堕聖母誕生~"), when that leaves something to search for.
		 */
		function shortTitles(title: string) {
			const out: string[] = [];
			const add = (t: string) => {
				t = t.trim().replace(/[\s:：\-~～・]+$/, "");
				if (t.length >= 3 && t !== title && out.indexOf(t) === -1) out.push(t);
			};
			const unnumbered = (t: string) =>
				t
					.replace(/\s*(?:(?:season|part|cour)\s*\d+|\d+(?:st|nd|rd|th)\s+season|第\S+期)$/i, "")
					.replace(/\s+(?:[2-9]|II|III|IV|V)$/, "")
					.replace(/([぀-ヿ一-鿿])[2-9]$/, "$1");
			const subtitle = (t: string) => t.split(/\s+[-–~～]\s*|\s*[~～]\s*|:\s+|：/)[0];
			const bare = unnumbered(title);
			if (bare !== title) add(bare);
			add(subtitle(bare));
			return out;
		}
		/**
		 * Find the anime on TMDB: the given ID only; else Animap's, ani.zip's or AnimeAPI's; else its parent's or a
		 * prequel's; else a TMDB title search. A candidate counts only
		 * when its air dates line up (see buildMapping), so a wrong first search result is skipped.
		 */
		async function searchTmdb(
			mediaId: number,
			media: $app.AL_BaseAnime | undefined,
			metadata: $app.Metadata_AnimeMetadata | undefined,
			session: ReturnType<typeof tmdbSession>,
			only?: { id: number; from: string; type?: "tv" | "movie" },
			titleSearch = true,
			skip: number[] = [],
			scope: Scope = "page",
		): Promise<{ found?: { id: number; from: string; mapping: Mapping; borrowed?: boolean }; firstValid?: { id: number; from: string; reason?: string; type?: "tv" | "movie" } }> {
			/** "123" (either type), "tv123", "movie123" */
			const tried: string[] = [];
			let firstValid: { id: number; from: string; reason?: string; type?: "tv" | "movie" } | undefined;
			// This anime's start date, for checking a movie that has no episodes to line up
			const start = media?.startDate;
			const startDay =
				start?.year && start.month && start.day ? Math.round(Date.UTC(Number(start.year), Number(start.month) - 1, Number(start.day)) / DAY) : toDay(metadata?.episodes?.["1"]?.airDate);
			const startYear = Number(start?.year) || (isNaN(startDay) ? 0 : new Date(startDay * DAY).getUTCFullYear());
			const episodeTotal = Number(media?.episodes) || 0;
			/**
			 * Why a movie ID borrowed from a related anime or a title search doesn't fit: another anime has it as its own
			 * ID (a movie is one AniList entry), or it came out on another date than this anime.
			 */
			const movieProblem = (id: number, movie: CEM.TMDBMovieDetails) => {
				const owner = Object.values(thumbnails.all()).find(
					(r) => r.mediaId !== mediaId && r.status === "matched" && r.tmdbType === "movie" && r.tmdbId === id && !r.borrowed,
				);
				if (owner) return `it's already the match of anime ${owner.mediaId}, from that anime's own IDs`;
				// A movie is one episode: an anime with several needs a show (or one movie per episode, in the overrides)
				if (episodeTotal > 1) return `a movie is one episode, this anime has ${episodeTotal}`;
				const released = toDay(movie.release_date);
				if (isNaN(released)) return undefined;
				// Only the year where either side has no more: AniList gives just the year for many old specials, and TMDB
				// dates such a movie January 1st
				const yearOnly = isNaN(startDay) || /-01-01$/.test(movie.release_date ?? "");
				const year = new Date(released * DAY).getUTCFullYear();
				if (yearOnly && startYear && year !== startYear) return `it came out in ${year}, this anime in ${startYear}`;
				if (!yearOnly && Math.abs(released - startDay) > 7)
					return `it came out ${movie.release_date}, this anime ${new Date(startDay * DAY).toISOString().slice(0, 10)}`;
				return undefined;
			};
			const attempt = async (
				id: number,
				from: string,
				borrowed = false,
				/** Known when the ID came with one (a search result, AnimeAPI): TV and movie IDs overlap */
				type?: "tv" | "movie",
				/** A search result named exactly as this anime (see buildMapping) */
				nameMatch = false,
			): Promise<{ id: number; from: string; mapping: Mapping; borrowed?: boolean } | undefined> => {
				const key = `${type ?? ""}${id}`;
				if (tried.indexOf(key) !== -1 || (type && tried.indexOf(`${id}`) !== -1)) return undefined;
				tried.push(key);
				let mapping: Mapping;
				try {
					mapping = await buildMapping(
						mediaId, media, metadata, session, { mediaId, tmdbId: id, ...(type ? { tmdbType: type } : {}), episodeOverrides: [] }, borrowed ? claimedEpisodes(mediaId, id) : {}, nameMatch,
					);
				} catch {
					return undefined; // not a TMDB entry of either type
				}
				const problem = borrowed && mapping.status === "matched" && mapping.movie ? movieProblem(id, mapping.movie) : undefined;
				if (problem) mapping = { status: "failed", reason: `TMDB movie ${id} doesn't fit: ${problem}`, tmdbType: "movie", map: {} };
				log.debug(`${mediaId}: TMDB ${id} from ${from}: ${mapping.status}${mapping.reason ? ` (${mapping.reason})` : ""}`);
				if (!firstValid) firstValid = { id, from, reason: mapping.reason, ...(mapping.tmdbType ?? type ? { type: mapping.tmdbType ?? type } : {}) };
				if (mapping.status === "matched") return { id, from, mapping, ...(borrowed ? { borrowed } : {}) };
				// A related anime's movie that isn't this one: TMDB has no relations for movies, but its collection (e.g.
				// "Part 1" and "Part 2") may hold the one released when this anime was
				const collection = problem && !isNaN(startDay) ? (await session.details(id, "movie").catch(() => undefined))?.belongs_to_collection : undefined;
				if (!collection) return undefined;
				let parts: { id: number; release_date?: string }[] = [];
				try {
					parts = (await tmdb.__fetch__<{ parts?: { id: number; release_date?: string }[] }>(`collection/${collection.id}`)).parts ?? [];
				} catch {}
				const near = parts.filter((p) => p.id !== id && Math.abs(toDay(p.release_date) - startDay) <= 7);
				log.debug(`${mediaId}: TMDB collection ${collection.id} "${collection.name}": ${near.length ? `TMDB ${near.map((p) => p.id).join(", ")} came out then` : "nothing came out then"}`);
				return near.length === 1 ? attempt(near[0].id, `${from}, its TMDB collection "${collection.name}"`, true, "movie") : undefined;
			};

			if (only) return { found: await attempt(only.id, only.from, false, only.type), firstValid };
			for (const id of skip) tried.push(`${id}`);

			// This anime's own mappings, then its parent's and prequels' (checked against this anime's air dates)
			let found: Awaited<ReturnType<typeof attempt>>;
			for (const candidate of await knownIds(mediaId, metadata)) {
				found = await attempt(candidate.id, candidate.from, false, candidate.type);
				if (found) return { found, firstValid };
			}
			// Related anime need AniList (one blocking request per uncached step, spaced out in the background)
			const related = await relatedAnime(mediaId, scope);
			for (const r of related) {
				// The TMDB ID the user or the plugin already settled on for the related anime (e.g. found by a title
				// search), then the ID databases' entries for it
				const own = thumbnails.get(r.id);
				const theirs = tmdb.overrides.get(r.id);
				const settled = [
					{ id: theirs.tmdbId, from: "its override", type: theirs.tmdbType },
					{ id: own?.status === "matched" ? own.tmdbId : undefined, from: "its TMDB match", type: own?.tmdbType },
				].filter((c): c is { id: number; from: string; type: "tv" | "movie" | undefined } => !!c.id);
				for (const candidate of (settled as { id: number; from: string; type?: "tv" | "movie" }[]).concat(await knownIds(r.id))) {
					found = await attempt(candidate.id, `${r.relation} "${r.title}" (${candidate.from})`, true, candidate.type);
					if (found) return { found, firstValid };
				}
			}
			if (!titleSearch) return { found, firstValid };
			// One episode (a movie, or a special TMDB may keep as a movie): search shows and movies at once. Otherwise only
			// shows, a movie being one episode.
			const preferred = media?.format?.valueOf() === "MOVIE" ? "movie" : "tv";
			const searchType = preferred === "movie" || episodeTotal <= 1 ? "multi" : "tv";
			// This anime's titles, then the related anime's: sequels and OVAs are often episodes of the first entry's show
			// Every title (English and romaji differ between sites; the native one is the most consistent), then each
			// without its subtitle ("Dacryon - Luna: ...", "ダクリュオン・ルナ ~堕聖母誕生~") or season number, which TMDB
			// often leaves out or keeps as a season of the first entry's show
			const titles: { title: string; from: string }[] = [];
			const own = [media?.title?.english, media?.title?.romaji, media?.title?.native, media?.title?.userPreferred, ...((media?.synonyms ?? []) as string[])]
				.map((t) => `${t ?? ""}`.trim())
				.filter((t) => t.length > 1);
			for (const t of own) titles.push({ title: t, from: `a TMDB search for "${t}"` });
			for (const t of own) for (const short of shortTitles(t)) titles.push({ title: short, from: `a TMDB search for "${short}" (from "${t}")` });
			for (const r of related) titles.push({ title: r.title, from: `a TMDB search for ${r.relation} "${r.title}"` });
			const searched: string[] = [];
			for (const { title, from } of titles) {
				if (found) break;
				if (searched.indexOf(title) !== -1) continue;
				// Enough for any anime TMDB has; one it doesn't have costs no more each time it's retried
				if (searched.length >= 10) break;
				searched.push(title);
				let results: CEM.TMDBSearchResults["results"] = [];
				try {
					results = (await tmdb.search(title, searchType)).results.filter((r) => searchType !== "multi" || r.media_type === "tv" || r.media_type === "movie");
				} catch {}
				const typeOf = (r: (typeof results)[number]): "tv" | "movie" => (searchType === "multi" ? (r.media_type as "tv" | "movie") : "tv");
				// TMDB often has duplicate entries. Of the top 3 that match, take one with stills, and of those the oldest
				// entry: TMDB IDs are assigned in order (its API doesn't say when an entry was created), so try the lowest
				// ID first and stop at the first match with stills. The type the format suggests first: the two types'
				// IDs are counted apart.
				let bare: Awaited<ReturnType<typeof attempt>>;
				const top = results.slice(0, 3).sort((a, b) => Number(typeOf(b) === preferred) - Number(typeOf(a) === preferred) || a.id - b.id);
				for (const result of top) {
					// Named exactly as one of this anime's own titles (TMDB's English or original name)
					const named = [result.name, result.original_name, result.title].some((n) => !!plainTitle(n) && own.some((t) => plainTitle(t) === plainTitle(n)));
					const hit = await attempt(result.id, from, true, typeOf(result), named);
					if (!hit) continue;
					if (await hasStills(hit.mapping, session)) {
						found = hit;
						break;
					}
					log.debug(`${mediaId}: TMDB ${result.id} matches but has no stills; trying the other results`);
					bare = bare ?? hit;
				}
				found = found ?? bare;
			}
			return { found, firstValid };
		}

		// ---------------------------------------------------------------------------------------------------------
		// AniDB IDs for anime Seanime has no metadata for (mostly 18+ entries Animap doesn't know). Without one, Seanime
		// shows "Episode metadata retrieval not available" and AnimeTosho can't search by AniDB. A found ID is only used
		// when this anime's own main episodes line up by air date with that AniDB entry's main episodes; never an ID
		// borrowed from a parent or prequel.
		// ---------------------------------------------------------------------------------------------------------

		const anidbStore = $shared.use<CEM.AnidbStore>("anidb");
		const ANIDB_EPISODES_KEY = "ANIDB_EPISODES_V1";
		const lastCalls: Record<string, number> = {};
		/** Keep calls to one service at least `ms` apart. Waits instead of skipping: this runs in the background. */
		async function spaced(service: string, ms: number) {
			const wait = (lastCalls[service] ?? 0) + ms - Date.now();
			if (wait > 0) await sleep(wait);
			lastCalls[service] = Date.now();
		}

		/** animap.id's AniDB ID for an AniList anime. Its data is anime-offline-database's: the ID is in a sources URL. */
		async function animapIdAnidb(mediaId: number): Promise<number | undefined> {
			await spaced("animap.id", 1500);
			try {
				const res = await ctx.fetch(`https://animap.id/api/v1/map/anilist/${mediaId}`, { timeout: 10 });
				if (!res.ok) {
					log.debug(`${mediaId}: animap.id has no entry (${res.status})`);
					return undefined;
				}
				const url = ((res.json() as { sources?: string[] }).sources ?? []).find((u) => /anidb\.net\/anime\/\d+/.test(u));
				const aid = url ? Number((url.match(/anidb\.net\/anime\/(\d+)/) ?? [])[1]) || undefined : undefined;
				log.debug(`${mediaId}: animap.id AniDB candidate: ${aid ?? "none"}`);
				return aid;
			} catch (e) {
				log.debug(`${mediaId}: animap.id request failed`, e);
				return undefined;
			}
		}

		/** Text from AniDB's XML with its entities decoded */
		const xmlText = (text: string) =>
			text
				.replace(/&quot;/g, '"')
				.replace(/&apos;|&#39;/g, "'")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
				.replace(/&amp;/g, "&")
				.trim();
		/** An AniDB episode's English title from its XML, unless it's a placeholder ("Episode 3"). */
		function anidbTitle(episodeXml: string) {
			const titles: Record<string, string> = {};
			const titleRe = /<title\s+xml:lang="([^"]+)">([^<]*)<\/title>/g;
			let t: RegExpExecArray | null;
			while ((t = titleRe.exec(episodeXml))) {
				const text = xmlText(t[2]);
				if (text && !titles[t[1]]) titles[t[1]] = text;
			}
			return titles.en && plainTitle(titles.en) ? titles.en : undefined;
		}
		/** An AniDB episode's summary from its XML (often missing), as AniDB writes it */
		const anidbSummary = (episodeXml: string) => xmlText((episodeXml.match(/<summary>([\s\S]*?)<\/summary>/) ?? [])[1] ?? "") || undefined;
		/**
		 * An AniDB anime's main episodes, from AniDB's HTTP API through proxy.ani.zip. Cached on disk for 14 days.
		 * Returns null when AniDB has no such anime, undefined when it couldn't be fetched right now.
		 */
		async function anidbAnime(aid: number, force = false): Promise<CEM.AnidbAnime | null | undefined> {
			const cache = $storage.get<Record<number, { at: number; anime?: CEM.AnidbAnime }>>(ANIDB_EPISODES_KEY) ?? {};
			const hit = cache[aid];
			if (hit && !force && Date.now() - hit.at < 14 * DAY) return hit.anime ?? null;
			await spaced("proxy.ani.zip", 1500);
			let xml = "";
			try {
				const res = await ctx.fetch(`https://proxy.ani.zip/httpapi?client=animeplugin&clientver=1&protover=1&request=anime&aid=${aid}`, { timeout: 10 });
				if (!res.ok) {
					log.debug(`AniDB ${aid}: proxy.ani.zip answered ${res.status}`);
					return undefined;
				}
				xml = res.text();
			} catch (e) {
				log.debug(`AniDB ${aid}: proxy.ani.zip request failed`, e);
				return undefined;
			}
			let anime: CEM.AnidbAnime | undefined;
			if (/<anime[\s>]/.test(xml)) {
				// Goja has no XML parser; AniDB's anime XML is regular enough for a few patterns
				const main: CEM.AnidbAnime["main"] = [];
				const specials: CEM.AnidbAnime["main"] = [];
				const episodeRe = /<episode\s+id="(\d+)"[^>]*>([\s\S]*?)<\/episode>/g;
				let m: RegExpExecArray | null;
				while ((m = episodeRe.exec(xml))) {
					const epno = m[2].match(/<epno\s+type="(\d+)">\s*([^<]*?)\s*<\/epno>/);
					// Type 1: main episodes ("12"); type 2: specials ("S1")
					const special = epno?.[1] === "2" && /^S\d+$/.test(epno[2]);
					if (!epno || !((epno[1] === "1" && /^\d+$/.test(epno[2])) || special)) continue;
					const airDate = (m[2].match(/<airdate>([^<]+)<\/airdate>/) ?? [])[1];
					const length = Number((m[2].match(/<length>(\d+)<\/length>/) ?? [])[1]) || 0;
					const title = anidbTitle(m[2]);
					const summary = anidbSummary(m[2]);
					(special ? specials : main).push({
						n: Number(epno[2].replace("S", "")),
						eid: Number(m[1]),
						...(airDate ? { airDate } : {}),
						...(length ? { length } : {}),
						...(title ? { title } : {}),
						...(summary ? { summary } : {}),
					});
				}
				main.sort((a, b) => a.n - b.n);
				specials.sort((a, b) => a.n - b.n);
				// Resource type 2 is MyAnimeList
				const malIds: number[] = [];
				const resourceRe = /<resource\s+type="2">([\s\S]*?)<\/resource>/g;
				while ((m = resourceRe.exec(xml))) {
					const idRe = /<identifier>(\d+)<\/identifier>/g;
					let id: RegExpExecArray | null;
					while ((id = idRe.exec(m[1]))) malIds.push(Number(id[1]));
				}
				const episodeCount = Number((xml.match(/<episodecount>(\d+)<\/episodecount>/) ?? [])[1] ?? 0);
				// AniDB's start and end dates are the first and last episodes' air dates: they date those episodes when
				// AniDB has no date of their own (often for old specials, e.g. two episodes a year apart)
				const entryDate = (tag: string) => ((xml.match(new RegExp(`<${tag}>(\\d{4}-\\d{2}-\\d{2})</${tag}>`)) ?? [])[1]);
				const first = main.find((e) => e.n === 1);
				const last = main.find((e) => episodeCount > 1 && e.n === episodeCount);
				if (first && !first.airDate && entryDate("startdate")) first.airDate = entryDate("startdate");
				if (last && !last.airDate && entryDate("enddate")) last.airDate = entryDate("enddate");
				anime = { aid, episodeCount, main, specials, malIds };
			} else if (!/not found/i.test(xml)) {
				log.warn(`AniDB ${aid}: unexpected answer from proxy.ani.zip`, xml.slice(0, 200));
				return undefined; // an error like a ban or maintenance: don't remember it
			}
			log.debug(`AniDB ${aid}: ${anime ? `${anime.main.length} main episodes, ${anime.specials?.length ?? 0} specials` : "not found"}`);
			cache[aid] = { at: Date.now(), ...(anime ? { anime } : {}) };
			$storage.set(ANIDB_EPISODES_KEY, cache);
			return anime ?? null;
		}

		/** Air dates known for this anime's episodes: Seanime's metadata, TMDB fill-in data, custom metadata, AniList. */
		function airDatePoints(mediaId: number, media: $app.AL_BaseAnime | undefined, metadata?: $app.Metadata_AnimeMetadata, tmdbFirst = false) {
			const points: Record<number, number> = {};
			const add = (n: number, day: number) => {
				if (n >= 1 && !isNaN(day) && points[n] === undefined) points[n] = day;
			};
			// The first date for an episode counts: TMDB's ahead of the others when asked (the check with them applied)
			const tmdb = () => {
				for (const [k, d] of Object.entries(thumbnails.get(mediaId)?.episodes ?? {})) if (/^\d+$/.test(k)) add(Number(k), toDay(d.airDate));
			};
			if (tmdbFirst) tmdb();
			// Not the episode list the plugin supplies (no Animap entry): its dates are AniDB's own, no evidence for AniDB
			if (!animap.get(mediaId)?.fallback)
				for (const [k, d] of Object.entries(metadata?.episodes ?? {})) if (/^\d+$/.test(k)) add(Number(k), toDay(d.airDate));
			tmdb();
			for (const [k, d] of Object.entries(database.get(mediaId).data)) if (/^\d+$/.test(k)) add(Number(k), toDay(d.airDate));
			const next = media?.nextAiringEpisode;
			if (next?.episode && next.airingAt) add(next.episode, Math.floor((next.airingAt * 1000) / DAY));
			const start = media?.startDate;
			if (start?.year && start.month && start.day) add(1, Math.round(Date.UTC(start.year, start.month - 1, start.day) / DAY));
			return Object.keys(points).map((n) => ({ n: Number(n), day: points[Number(n)] }));
		}

		/**
		 * Whether an AniDB entry's main episodes are this anime's: every air date we know lines up (±1 day) with an AniDB
		 * main episode under one offset (a later AniList part of a single AniDB entry has a positive offset), and AniDB
		 * has enough main episodes for it.
		 */
		function verifyAnidb(points: { n: number; day: number }[], anime: CEM.AnidbAnime, episodes: number | undefined, duration?: number) {
			const fail = (reason: string) => ({ ok: false, offset: 0, reason });
			if (!points.length) return fail("no air dates for this anime to compare");
			if (!anime.main.length) return fail(`AniDB ${anime.aid} lists no main episodes`);
			const votes: Record<number, number> = {};
			for (const p of points) {
				const seen: Record<number, boolean> = {};
				for (const e of anime.main) {
					// An undated AniDB episode lines up with nothing (NaN fails every comparison, so test it first)
					const day = toDay(e.airDate);
					if (isNaN(day) || Math.abs(day - p.day) > 1) continue;
					const offset = e.n - p.n;
					if (seen[offset]) continue;
					seen[offset] = true;
					votes[offset] = (votes[offset] ?? 0) + 1;
				}
			}
			const ranked = Object.keys(votes)
				.map(Number)
				.sort((a, b) => votes[b] - votes[a] || Math.abs(a) - Math.abs(b));
			if (!ranked.length) return fail(`none of ${points.length} air date(s) line up with AniDB ${anime.aid}'s main episodes`);
			const offset = ranked[0];
			const agree = votes[offset];
			if (offset < 0) return fail(`AniDB ${anime.aid}'s episodes start after this anime's (offset ${offset})`);
			// AniDB often dates episode 1 by an early screening (a premiere event weeks before the broadcast): that date
			// doesn't count against it
			const first = anime.main.find((e) => e.n === 1);
			const premiere =
				offset === 0 && !!first && points.some((p) => p.n === 1 && toDay(first.airDate) < p.day - 1 && p.day - toDay(first.airDate) <= 90);
			const counted = points.length - (premiere ? 1 : 0);
			if (agree < Math.max(1, Math.ceil(counted * 0.8))) return fail(`only ${agree} of ${points.length} air dates line up with AniDB ${anime.aid}`);
			const total = Math.max(anime.episodeCount, anime.main[anime.main.length - 1].n);
			if (episodes && total < offset + episodes) return fail(`AniDB ${anime.aid} has ${total} main episodes, this anime needs ${offset + episodes}`);
			// Same kind of episode: a short (3 min) never matches a full episode (24 min) that aired the same day
			const lengths = anime.main.filter((e) => e.length && e.n - offset >= 1 && (!episodes || e.n - offset <= episodes)).map((e) => e.length as number).sort((a, b) => a - b);
			const typical = lengths[Math.floor(lengths.length / 2)];
			if (duration && typical && (typical > duration * 2 || typical < duration / 2))
				return fail(`AniDB ${anime.aid}'s episodes run ${typical} min, this anime's ${duration} min`);
			return {
				ok: true,
				offset,
				reason: `${agree} of ${points.length} air dates line up${offset ? ` at offset +${offset}` : ""}${premiere ? " (AniDB dates episode 1 by an early screening)" : ""}`,
			};
		}

		/**
		 * For an anime AniList dates by year (or month) only, which an AniDB entry linking its MyAnimeList entry among
		 * others (one AniDB entry, several MAL and AniList ones) it is: the AniDB main episodes that aired then, if they're
		 * exactly as many as this anime has, in a row.
		 */
		function verifyByYear(anime: CEM.AnidbAnime, media: $app.AL_BaseAnime | undefined, episodes: number | undefined, mal: number) {
			const start = media?.startDate;
			const year = Number(start?.year) || 0;
			const month = Number(start?.month) || 0;
			if (!year || start?.day) return undefined; // a full date was compared as an air date
			const then = anime.main.filter((e) => {
				const m = (e.airDate ?? "").match(/^(\d{4})-(\d{2})/);
				return !!m && Number(m[1]) === year && (!month || Number(m[2]) === month);
			});
			const count = episodes ?? then.length;
			if (!then.length || then.length !== count) return undefined;
			const offset = then[0].n - 1;
			if (then.some((e, i) => e.n !== offset + 1 + i)) return undefined;
			const period = month ? `${year}-${`${month}`.padStart(2, "0")}` : `${year}`;
			const which = count > 1 ? `episodes ${offset + 1}-${offset + count}` : `episode ${offset + 1}`;
			return { ok: true, offset, reason: `it links this anime's MyAnimeList entry ${mal}, and only its ${which} aired in ${period}, when this anime did` };
		}

		/** An AniDB entry's specials (S1 as 1) in place of its main episodes, for the checks and lists below. */
		const asSpecials = (anime: CEM.AnidbAnime): CEM.AnidbAnime => ({ aid: anime.aid, episodeCount: anime.specials.length, main: anime.specials, specials: [], malIds: [] });
		/**
		 * The episode IDs, air dates and episode data (title, air date, length) for a match, by this anime's episode
		 * number: from AniDB's specials when the match is to them. Only this anime's count of them, when it's known:
		 * AniDB's later episodes are another AniList entry's (a sequel AniDB keeps in the same entry, a 2-minute extra
		 * after the specials), not episodes to add.
		 */
		const matchEpisodes = (anime: CEM.AnidbAnime, offset: number, specials: boolean, count: number | undefined) => {
			const eids: Record<string, number> = {};
			const airDates: Record<string, string> = {};
			const episodes: NonNullable<CEM.AnidbMatch["episodes"]> = {};
			for (const e of specials ? anime.specials : anime.main) {
				const n = e.n - offset;
				if (n < 1 || (count && n > count)) continue;
				eids[n] = e.eid;
				if (e.airDate) airDates[n] = e.airDate;
				const { title, airDate, length, summary } = e;
				if (title || airDate || length || summary) episodes[n] = { title, airDate, length, summary };
			}
			return { eids, airDates, episodes };
		};

		/**
		 * Try this anime's own AniDB IDs (ani.zip, AnimeAPI, animap.id), then its parent's and prequels' (Animap, ani.zip,
		 * animap.id): a split AniList season is often one AniDB entry, found only through its first part. Every candidate
		 * must verify against this anime's own air dates and episode length; the first that does wins.
		 */
		type AnidbFound =
			| {
					aid: number;
					offset: number;
					eids: Record<string, number>;
					airDates: Record<string, string>;
					episodes: NonNullable<CEM.AnidbMatch["episodes"]>;
					from: string;
					reason: string;
					specials?: boolean;
					transient?: undefined;
			  }
			| { aid?: undefined; reason: string; transient: boolean };
		async function findAnidb(mediaId: number, media: $app.AL_BaseAnime | undefined, metadata?: $app.Metadata_AnimeMetadata, scope: Scope = "page"): Promise<AnidbFound> {
			const points = airDatePoints(mediaId, media, metadata);
			// The same with TMDB's dates (the anime's TMDB match) ahead of the anime's own, where they differ: tried too
			const withTmdb = airDatePoints(mediaId, media, metadata, true);
			const tmdbDiffers = stableJson(withTmdb) !== stableJson(points);
			log.debug(`${mediaId}: AniDB lookup with ${points.length} known air date(s)`);
			log.inspect(`${mediaId}: air dates checked against AniDB`, points);
			const episodes = Number(media?.episodes) || undefined;
			const duration = Number(media?.duration) || undefined;
			const mal = Number(media?.idMal) || 0;
			/** An AniDB entry (or its specials) checked against the anime's own air dates, else with TMDB's ahead of them */
			const verify = (anime: CEM.AnidbAnime) => {
				const check = verifyAnidb(points, anime, episodes, duration);
				if (check.ok || !tmdbDiffers) return check;
				const other = verifyAnidb(withTmdb, anime, episodes, duration);
				return other.ok ? { ...other, reason: `${other.reason} with TMDB's air dates (the anime's own: ${check.reason})` } : check;
			};
			const reasons: string[] = [];
			let transient = false;
			// A related anime's AniDB ID comes with how many episodes that anime has itself (AniList's count, 0 when unknown)
			const sources: [string, () => Promise<number | undefined>, number?][] = [
				["ani.zip", async () => (await anizip(mediaId)).anidbId],
				["AnimeAPI", async () => (await animeapi(mediaId)).anidbId],
				// animap.id is its own site (AniList -> AniDB links), not the Animap behind Seanime's metadata
				["the animap.id site", () => animapIdAnidb(mediaId)],
			];
			// Parent and prequels last, looked up only if this anime's own IDs gave nothing usable
			const own = sources.length;
			const addRelated = async () => {
				for (const related of await relatedAnime(mediaId, scope)) {
					const label = `${related.relation} "${related.title}"`;
					const ownMain = related.episodes ?? 0;
					sources.push(
						[`${label} (Animap)`, async () => {
							try {
								return (await loadMetadata(related.id))?.mappings?.anidbId || undefined;
							} catch {
								return undefined;
							}
						}, ownMain],
						[`${label} (ani.zip)`, async () => (await anizip(related.id)).anidbId, ownMain],
						[`${label} (the animap.id site)`, () => animapIdAnidb(related.id), ownMain],
					);
				}
			};
			const tried: number[] = [];
			for (let i = 0; ; i++) {
				// Only once this anime's own IDs gave nothing usable
				if (i === own) await addRelated();
				if (i >= sources.length) break;
				const [from, get, relatedEpisodes] = sources[i];
				const related = relatedEpisodes !== undefined;
				const aid = await get();
				if (!aid || tried.indexOf(aid) !== -1) continue;
				tried.push(aid);
				const anime = await anidbAnime(aid);
				if (anime === undefined) {
					transient = true;
					reasons.push(`AniDB ${aid} (${from}) couldn't be fetched`);
					continue;
				}
				if (anime === null) {
					reasons.push(`AniDB ${aid} (${from}) doesn't exist`);
					continue;
				}
				let check = verify(anime);
				// This anime's own ID whose AniDB entry links this anime's MyAnimeList entry, and only that one: it is this
				// anime, whatever the air dates say (an early screening, dates a week apart). An entry MAL splits into parts
				// still needs the dates for which part this is.
				if (!related && !check.ok && mal && anime.malIds?.length === 1 && anime.malIds[0] === mal) {
					log.debug(`${mediaId}: AniDB ${aid} from ${from}: ${check.reason}, but it links this anime's MAL entry ${mal}`);
					check = { ok: true, offset: 0, reason: `it links this anime's MyAnimeList entry ${mal} (air dates: ${check.reason})` };
				}
				// An old special AniList dates by year only: the year says which of the entry's episodes it is
				if (!check.ok && mal && anime.malIds.indexOf(mal) !== -1) check = verifyByYear(anime, media, episodes, mal) ?? check;
				// A related anime's main episodes are that anime's own (e.g. a mini anime airing right after each episode of
				// its parent, same dates): this anime may only take ones past them, else AniDB's specials
				const taken = check.ok && related ? (relatedEpisodes as number) : 0;
				if (taken && check.offset < taken) {
					check = { ok: false, offset: 0, reason: `AniDB ${aid}'s main episodes 1-${taken} are ${from.replace(/ \(.*$/, "")}'s own` };
				}
				log.debug(`${mediaId}: AniDB ${aid} from ${from}: ${check.ok ? "verified" : "rejected"}, ${check.reason}`);
				// AniList's count only: one taken from the air dates would cut off an airing anime's later episodes
				if (check.ok) return { aid, offset: check.offset, ...matchEpisodes(anime, check.offset, false, episodes), from, reason: check.reason };
				// A related anime's AniDB entry whose main episodes aren't this anime's: its specials may be (a mini anime,
				// shorts released between the episodes)
				if (related && anime.specials?.length) {
					const count = episodes ?? Math.max(1, ...points.map((p) => p.n));
					const sp = verify(asSpecials(anime));
					log.debug(`${mediaId}: AniDB ${aid}'s specials: ${sp.ok ? "verified" : "rejected"}, ${sp.reason}`);
					if (sp.ok && sp.offset + count <= anime.specials[anime.specials.length - 1].n) {
						const reason = `${sp.reason.replace("air dates line up", "air dates line up with its specials")}${sp.offset ? "" : ` (S1-S${count})`}`;
						return { aid, offset: sp.offset, ...matchEpisodes(anime, sp.offset, true, count), from, reason, specials: true };
					}
				}
				reasons.push(`AniDB ${aid} (${from}): ${check.reason}`);
			}
			return {
				reason: reasons.length ? reasons.join("; ") : "no AniDB ID from ani.zip, AnimeAPI, animap.id or related anime",
				transient,
			};
		}

		/** Writes per anime, so a lookup can tell another one (page vs background) stored a result while it ran. */
		const anidbWrites: Record<number, number> = {};
		const saveAnidb = (mediaId: number, match: CEM.AnidbMatch | null) => {
			anidbWrites[mediaId] = (anidbWrites[mediaId] ?? 0) + 1;
			anidbStore.set(mediaId, match);
		};
		/**
		 * The AniDB ID (and episode IDs) to use for an anime Seanime has no metadata for. The user's override is used as
		 * given; otherwise a verified match, remembered for good (episode IDs refreshed every 14 days), or "none",
		 * remembered for 14 days.
		 */
		async function resolveAnidb(mediaId: number, force = false, scope: Scope = "page"): Promise<CEM.AnidbMatch | undefined> {
			if (mediaId >= 0x80000000) return undefined;
			const override = tmdb.overrides.get(mediaId);
			const existing = anidbStore.get(mediaId);
			const now = Date.now();
			const fresh = (m?: CEM.AnidbMatch) => !!m && now - m.checkedAt < 14 * DAY;

			if (override.anidbId) {
				const offset = override.anidbOffset ?? 0;
				if (!force && existing?.status === "override" && existing.aid === override.anidbId && existing.offset === offset && fresh(existing)) return existing;
				const anime = await anidbAnime(override.anidbId, force);
				// The entry's specials when this anime's air dates fit them and not its main episodes (e.g. a mini anime
				// listed as the parent's specials)
				let specials = false;
				let count: number | undefined;
				if (anime?.specials?.length) {
					const { media, metadata } = await loadAnime(mediaId);
					count = Number(media?.episodes) || undefined;
					const points = airDatePoints(mediaId, media, metadata);
					const duration = Number(media?.duration) || undefined;
					specials = !verifyAnidb(points, anime, count, duration).ok && verifyAnidb(points, asSpecials(anime), count, duration).ok;
					if (specials) log.step(`${mediaId}: your AniDB ${override.anidbId}: the air dates fit its specials, not its main episodes`);
				}
				const match: CEM.AnidbMatch = {
					mediaId, status: "override", aid: override.anidbId, offset,
					...(anime ? matchEpisodes(anime, offset, specials, count) : { eids: {}, airDates: {} }), from: "your override", checkedAt: now,
					...(specials ? { specials } : {}),
				};
				saveAnidb(mediaId, match);
				return match;
			}
			// The override was removed: forget what it set, then look up as if it never existed
			if (existing?.status === "override") {
				saveAnidb(mediaId, null);
				return anidbLookup() ? resolveAnidb(mediaId, force, scope) : undefined;
			}
			if (!anidbLookup()) return undefined;

			if (existing?.status === "verified" && !force) {
				// Kept from before AniDB's English episode titles were stored: refreshed now
				if (fresh(existing)) return existing;
				// The ID stays; only the episode IDs are refreshed (new episodes of an airing anime)
				const anime = await anidbAnime(existing.aid!, true);
				let count: number | undefined;
				if (existing.specials) {
					try {
						count = Number((await ctx.anime.getAnimeEntry(mediaId)).media?.episodes) || undefined;
					} catch {}
				}
				const match = { ...existing, ...(anime ? matchEpisodes(anime, existing.offset ?? 0, !!existing.specials, count) : {}), checkedAt: now };
				saveAnidb(mediaId, match);
				return match;
			}
			// A "none" found without checking related anime is looked up again once they may be checked, and one found with
			// fewer air dates than are known now (e.g. TMDB's, once it matched)
			const tmdbDated = () => {
				const episodes = thumbnails.get(mediaId)?.episodes ?? {};
				return Object.keys(episodes).filter((k) => /^\d+$/.test(k) && episodes[k]?.airDate).length;
			};
			const moreDates = () => tmdbDated() > (existing?.tmdbPoints ?? Infinity);
			if (existing?.status === "none" && !force && fresh(existing) && !moreDates()) return existing;

			const version = anidbWrites[mediaId] ?? 0;
			log.time(`anidb ${mediaId}`);
			// The anime's own air dates too (Animap's, when it has an entry but no AniDB ID)
			const { media, metadata } = await loadAnime(mediaId);
			const found = await findAnidb(mediaId, media, metadata, scope);
			log.timeEnd(`anidb ${mediaId}`);
			const name = media?.title?.userPreferred ?? `${mediaId}`;
			// Another lookup for this anime (its page and the background) stored a result while this one ran. An ID it
			// found stays; this lookup's ID replaces only a "none"; a "none" from this one never replaces anything.
			if ((anidbWrites[mediaId] ?? 0) !== version) {
				const stored = anidbStore.get(mediaId);
				if (!found.aid || (stored && stored.status !== "none")) {
					log.step(`${name} (${mediaId}): another AniDB lookup finished first; keeping its result (${stored?.status ?? "nothing"})`);
					return stored?.status === "none" ? undefined : stored;
				}
			}
			if (found.aid) {
				const match: CEM.AnidbMatch = { mediaId, status: "verified", ...found, checkedAt: now };
				saveAnidb(mediaId, match);
				log.info(`${name} (${mediaId}): AniDB ${found.aid} from ${found.from} verified (${found.reason}), ${Object.keys(found.eids).length} episode IDs`);
				log.inspect(`${mediaId}: AniDB match`, match);
				return match;
			}
			log.step(`${name} (${mediaId}): no verified AniDB ID: ${found.reason}`);
			// A request that failed is retried next time; a real "no" is remembered for 14 days (and no ID is stored)
			if (!found.transient)
				saveAnidb(mediaId, { mediaId, status: "none", reason: found.reason, checkedAt: now, tmdbPoints: tmdbDated() });
			return undefined;
		}

		/**
		 * Whether Seanime lacks an AniDB ID for this anime: no metadata at all, or metadata without one (Animap knows the
		 * anime but not its AniDB entry). An ID the plugin added itself still counts as missing, so it stays maintained.
		 */
		async function needsAnidb(mediaId: number) {
			if (mediaId >= 0x80000000) return false;
			if (animap.get(mediaId)?.fallback) return true;
			if (!anidbLookup() && !tmdb.overrides.get(mediaId).anidbId) return false;
			// Seanime's own ID, as onAnimeMetadata last saw it (before the plugin adds one)
			const seen = $store.get(`CEM_SEANIME_ANIDB_${mediaId}`);
			if (seen !== undefined && seen !== null) return !Number(seen);
			try {
				const id = (await loadMetadata(mediaId))?.mappings?.anidbId;
				const ours = anidbStore.get(mediaId)?.aid; // undefined for "none"
				return !id || (ours !== undefined && id === ours);
			} catch {
				return false;
			}
		}

		/** After AniDB data changed for an anime without a Seanime AniDB ID, rebuild so the notice and IDs update. */
		async function refreshAnidb(mediaId: number, force = false, scope: Scope = "page") {
			const before = stableJson(anidbStore.get(mediaId) ?? null);
			await resolveAnidb(mediaId, force, scope);
			const after = anidbStore.get(mediaId);
			if (stableJson(after ?? null) !== before && after?.aid) scheduleRebuild(false, mediaId);
			// The badge and the Overrides button's ring count a missing AniDB ID
			if (currentMedia.get()?.id === mediaId) {
				updateBadge();
				tray.update();
			}
		}

		/**
		 * Fill the media override fields without saving: the TMDB ID typed in the field, else Animap's, else a TMDB
		 * title search (each candidate checked against the air dates), then the season and offset the dates line up with.
		 */
		async function autoFill(mediaId: number) {
			const refs = tmdb.overrides.media.fieldRefs;
			const { media, metadata } = await loadAnime(mediaId);

			// AniDB ID: only when Seanime has none for this anime and the field is empty
			const knownAnidb = metadata?.mappings?.anidbId;
			if (knownAnidb && !refs.anidbId.current.trim()) {
				// Already known (Seanime's own, or one the plugin verified): show it, with the plugin's offset if it's ours
				const ours = anidbStore.get(mediaId);
				refs.anidbId.setValue(`${knownAnidb}`);
				refs.anidbOffset.setValue(ours?.aid === knownAnidb && ours.offset ? `${ours.offset}` : "");
			} else if (!knownAnidb && !refs.anidbId.current.trim() && mediaId < 0x80000000) {
				const found = await findAnidb(mediaId, media, metadata);
				if (found.aid) {
					refs.anidbId.setValue(`${found.aid}`);
					refs.anidbOffset.setValue(found.offset ? `${found.offset}` : "");
					ctx.toast.info(`AniDB ${found.aid} from ${found.from}: ${found.reason}.`);
				} else log.step(`${mediaId}: Auto-fill found no verified AniDB ID: ${found.reason}`);
			}

			const typed = parseTmdbId(refs.tmdbId.current);
			const { found, firstValid } = await searchTmdb(mediaId, media, metadata, tmdbSession(), typed ? { ...typed, from: "the TMDB ID you entered" } : undefined);

			if (!found) {
				if (!firstValid) return ctx.toast.error(typed ? `TMDB has no ${typed.type ?? "show or movie"} with ID ${typed.id}.` : "Couldn't find this anime on TMDB. Enter the TMDB ID by hand.");
				refs.tmdbId.setValue(formatTmdbId(firstValid.id, firstValid.type));
				return ctx.toast.warning(`Filled the TMDB ID from ${firstValid.from}, but couldn't work out the season: ${firstValid.reason ?? "no match"}`);
			}

			const { id, from, mapping } = found;
			refs.tmdbId.setValue(formatTmdbId(id, mapping.tmdbType));
			if (mapping.tmdbType === "movie") {
				refs.tmdbSeason.setValue("");
				refs.tmdbOffset.setValue("");
				return ctx.toast.success(`Filled TMDB movie ${id} from ${from}. Review it and press Save.`);
			}

			const segments = mapping.segments ?? [];
			const first = segments[0] ?? (mapping.fallback ? { ...mapping.fallback, from: 1 } : undefined);
			if (!first) return ctx.toast.success(`Filled TMDB ID ${id} from ${from}. Review it and press Save.`);

			// The dates run across several seasons: fill a season list when reading them as one run gives the same match
			if (segments.length > 1) {
				const seasons = segments.map((x) => x.season).filter((x, i, all) => all.indexOf(x) === i);
				const session = tmdbSession();
				await session.prefetch(id, seasons);
				const run = await seasonRun(session, id, seasons);
				const start = run.findIndex((r) => r.season === first.season && r.episode === first.from + first.offset);
				const offset = start + 1 - first.from;
				const checked = Object.entries(mapping.map).filter(([k, t]) => /^\d+$/.test(k) && t.season !== undefined && seasons.indexOf(t.season) !== -1);
				const agree = checked.filter(([k, t]) => {
					const hit = run[Number(k) + offset - 1];
					return hit && hit.season === t.season && hit.episode === t.episode;
				}).length;
				if (start !== -1 && checked.length && agree / checked.length >= 0.9) {
					refs.tmdbSeason.setValue(formatSeasons(seasons));
					refs.tmdbOffset.setValue(offset ? `${offset}` : "");
					return ctx.toast.success(
						`Filled TMDB ${id} from ${from}: seasons ${formatSeasons(seasons)}${offset ? `, offset ${offset > 0 ? "+" : ""}${offset}` : ""}. Review it and press Save.`,
					);
				}
			}
			refs.tmdbSeason.setValue(`${first.season}`);
			refs.tmdbOffset.setValue(first.offset ? `${first.offset}` : "");
			ctx.toast.success(
				`Filled TMDB ${id} from ${from}: season ${first.season}${first.offset ? `, offset ${first.offset > 0 ? "+" : ""}${first.offset}` : ""}. Review it and press Save.`,
			);
			// The seasons didn't read as one run; say where the dates continue
			const next = segments[1];
			if (next) {
				ctx.toast.warning(
					`From episode ${next.from} on, the air dates continue in TMDB season ${next.season}. Try a season list like "${first.season}, ${next.season}", add episode overrides, or leave Season empty and let the automatic match handle it.`,
				);
			}
		}

		/**
		 * Find out once whether Seanime has metadata for this anime at all, when something depends on it: the TMDB
		 * fill-in, the AniDB lookup, or an AniDB ID override (which applies even with the lookup off).
		 */
		async function detectMissing(mediaId: number) {
			if (animap.get(mediaId) || mediaId >= 0x80000000) return;
			if (!isOn("tmdb-fill-missing") && !anidbLookup() && !tmdb.overrides.get(mediaId).anidbId) return;
			let missing = false;
			try {
				missing = !(await loadMetadata(mediaId));
			} catch {
				missing = true;
			}
			const count = missing ? await entryEpisodeCount(mediaId) : 0;
			animap.set(mediaId, { fallback: missing, episodeCount: count, checkedAt: Date.now(), ...(missing ? { since: Date.now() } : {}) });
			if (missing) log.info(`${mediaId}: Seanime has no metadata for this anime; the plugin supplies its episode list`);
			else log.step(`${mediaId}: Seanime has metadata for this anime`);
		}

		/**
		 * On demand: match or refresh an anime when Seanime loads it and its data has expired (nextCheckAt), instead
		 * of refreshing everything on a clock. Until the refresh lands, the previous stills are still shown. In the
		 * background only anime being watched are matched; the rest wait for their page.
		 */
		async function serve(mediaId: number, page = false) {
			if (!tmdb.API_KEY?.length) return;
			const now = Date.now();
			$store.set(`CEM_SERVED_${mediaId}`, now);
			// Seen, wherever it was loaded: keeps its stills from being forgotten (written at most daily)
			const seen = thumbnails.get(mediaId);
			if (seen && now - seen.lastSeenAt > DAY) thumbnails.set(mediaId, { ...seen, lastSeenAt: now });
			const scope: Scope | undefined = page ? "page" : backgroundScope(mediaId);
			if (!scope) return log.step(`${mediaId}: not on the watching list, matched when its page is opened`);
			log.step(`${mediaId}: checking (${scope === "page" ? "its page is open" : "watching list"})`);

			await detectMissing(mediaId);
			// No AniDB ID from Seanime: find a verified one (cached; at most one lookup per anime every 14 days)
			if (await needsAnidb(mediaId)) await refreshAnidb(mediaId, false, scope);
			if (!wantsMatch(mediaId)) return;
			const record = thumbnails.get(mediaId);
			if (record && now < (record.nextCheckAt ?? 0)) return log.step(`${mediaId}: fresh until ${new Date(record?.nextCheckAt ?? 0).toISOString()}`);
			log.step(`${mediaId}: ${record ? "expired, refreshing" : "not matched yet, matching"}`);
			log.time(`refresh ${mediaId}`);
			await refreshAnime(mediaId, false, false, scope);
			log.timeEnd(`refresh ${mediaId}`);
			// The match may have brought TMDB's air dates, which an AniDB lookup that found nothing hadn't had
			if (anidbStore.get(mediaId)?.status === "none" && (await needsAnidb(mediaId))) await refreshAnidb(mediaId, false, scope);
		}

		/**
		 * Make Seanime show changed data: clear its metadata cache once per batch (clearing it per anime made Seanime
		 * re-download Animap data for everything after every refresh), and refresh the views built from it. Upcoming
		 * Episodes is cached on the server until the AniList collection refreshes, so changed stills trigger that too
		 * (at most every 10 minutes).
		 */
		let rebuildPending = false;
		let rebuildStills = false;
		let rebuildUrgent = false;
		/** The anime whose changes the pending rebuild shows, so opening one of their pages makes it urgent. */
		let rebuildIds: number[] = [];
		let cancelRebuild: (() => void) | undefined;
		let lastCollectionRefresh = 0;
		let lastRebuild = 0;
		/**
		 * Background changes (anime matched while Seanime loads a page) are rebuilt at most every 20 seconds: each rebuild
		 * clears Seanime's whole metadata cache, and it then fetches every anime on screen from Animap again. The batches
		 * already gather a page load's anime, so this only spaces out loads that come in waves (e.g. at startup).
		 */
		const REBUILD_GAP = 20 * 1000;
		/**
		 * Whether the page the user is on shows a pending background change: the home page (Continue Watching and Upcoming
		 * Episodes: the anime being watched, and planned ones airing within a week), or the entry page of one of them.
		 * Elsewhere nothing shows episode data, so the change waits there: opening its page or the home page rebuilds.
		 */
		function rebuildShows() {
			if (currentPath === "/") {
				const ids = watchingIds();
				return ids === null || rebuildIds.some((id) => ids.indexOf(id) !== -1 || watching.upcoming.indexOf(id) !== -1);
			}
			const open = currentMedia.get()?.id;
			return open !== undefined && rebuildIds.indexOf(open) !== -1;
		}
		/**
		 * Rebuild soon. Straight away (after a second) for a change to the anime whose page is open, or with no mediaId
		 * (settings, the user's own actions), even while a batch runs; otherwise when the batch is done, at most every
		 * REBUILD_GAP, and only on a page that shows it (rebuildShows).
		 */
		function scheduleRebuild(stillsChanged: boolean, mediaId?: number) {
			rebuildPending = true;
			rebuildStills = rebuildStills || stillsChanged;
			if (mediaId !== undefined && rebuildIds.indexOf(mediaId) === -1) rebuildIds.push(mediaId);
			rebuildUrgent = rebuildUrgent || mediaId === undefined || mediaId === currentMedia.get()?.id;
			if (serving && !rebuildUrgent) return; // the batch rebuilds once when it's done
			armRebuild();
		}
		/** Not urgent and not on a page that shows the change: the rebuild waits (and says so) */
		function rebuildWaits() {
			if (rebuildUrgent || rebuildShows()) return false;
			log.step(`Rebuild for ${rebuildIds.join(", ")} waits for a page that shows them (home or their entry page)`);
			return true;
		}
		function armRebuild() {
			if (rebuildWaits()) return;
			cancelRebuild?.();
			const wait = rebuildUrgent ? 1000 : Math.max(1000, lastRebuild + REBUILD_GAP - Date.now());
			log.step(`Rebuild ${rebuildUrgent ? "now" : `in ${Math.round(wait / 1000)}s (at most every ${REBUILD_GAP / 1000}s)`} for ${rebuildIds.length ? rebuildIds.join(", ") : "all anime"}`);
			cancelRebuild = ctx.setTimeout(rebuild, wait);
		}
		function rebuild() {
			cancelRebuild?.();
			cancelRebuild = undefined;
			if (!rebuildPending) return;
			// Not while the overrides modal is open: the page doesn't change under it mid-edit. It runs when the modal closes.
			if (overridesOpen.get()) return log.step("Rebuild waits for the overrides modal to close");
			// A timer armed before a batch started: the batch re-arms it when it's done, so nothing is cleared mid-batch
			if (serving && !rebuildUrgent) return log.step("Rebuild waits for the running batch");
			// Left the page that showed it while the timer ran
			if (rebuildWaits()) return;
			rebuildPending = false;
			rebuildUrgent = false;
			rebuildIds = [];
			lastRebuild = Date.now();
			clearMetadataCache();
			ctx.anime.clearMissingEpisodesCache();
			const refreshCollection = rebuildStills && Date.now() - lastCollectionRefresh > 10 * 60 * 1000;
			rebuildStills = false;
			if (refreshCollection) {
				lastCollectionRefresh = Date.now();
				watching.at = 0; // the watching list may have changed with it
				try {
					$anilist.refreshAnimeCollection();
				} catch (e) {
					log.warn("Couldn't refresh the AniList collection, so Upcoming Episodes keeps its old stills (the plugin needs the anilist permission):", e);
				}
			}
			$app.invalidateClientQuery([
				"ANIME-ENTRIES-get-anime-entry",
				"ANIME-get-anime-episode-collection",
				"ANIME-COLLECTION-get-library-collection",
				"ANIME-ENTRIES-get-upcoming-episodes",
				"ANIME-ENTRIES-get-missing-episodes",
			]);
			log.mark("Rebuild");
			log.info(`Rebuilt Seanime's episode data${refreshCollection ? " and refreshed the AniList collection" : ""}`);
		}

		/**
		 * The anime Seanime loaded, in batches. Checked twice a second, but a batch starts only once nothing new was
		 * queued for 3 seconds (Seanime is done loading), or after 10 seconds of loading that keeps going. While Seanime
		 * starts up (the first 2 minutes) it loads the library, Continue Watching and more in waves: 6 and 20 seconds, so
		 * they make one batch and one rebuild rather than several. The open entry page doesn't wait for this: it's
		 * checked straight away.
		 */
		let serving = false;
		let batches = 0;
		/** Entry pages being checked: they go first. */
		let pageChecks = 0;
		const startedAt = Date.now();
		/** The queued anime (CEM_REQ_<id> keys the hook set), with when each was queued. */
		const requested = () => {
			const out: Record<number, number> = {};
			for (const [key, value] of Object.entries($store.getAll() ?? {})) {
				if (key.indexOf("CEM_REQ_") !== 0 || !(Number(value) > 0)) continue;
				const id = Number(key.slice(8));
				if (id > 0) out[id] = Number(value);
			}
			return out;
		};
		// The store is only scanned when the hook queued something since the last look
		let lastSeen = 0;
		let pending: Record<number, number> = {};
		let batchEnded = 0;
		ctx.setInterval(() => {
			if (serving) return;
			const last = Number($store.get("CEM_REQUESTED_LAST")) || 0;
			if (last > lastSeen) {
				lastSeen = last;
				pending = requested();
			}
			const queuedAt = Object.keys(pending).map((id) => pending[Number(id)]);
			if (!queuedAt.length) return;
			const now = Date.now();
			const starting = now - startedAt < 2 * 60 * 1000;
			const quiet = starting ? 6000 : 3000;
			const cap = starting ? 20000 : 10000;
			const settled = now - last >= quiet;
			// Anime queued while the last batch ran count from its end
			const waited = now - Math.max(Math.min(...queuedAt), batchEnded) >= cap;
			if (!settled && !waited) return;
			// Take what's queued now; anything the hook queues after this stays for the next batch
			const taken = requested();
			for (const id of Object.keys(taken)) $store.set(`CEM_REQ_${id}`, 0);
			pending = {};
			serving = true;
			const ids = Object.keys(taken)
				.map(Number)
				.sort((a, b) => taken[a] - taken[b]);
			const batch = ++batches;
			log.mark(`Batch ${batch}: ${ids.length} anime Seanime loaded${waited && !settled ? ` (still loading after ${cap / 1000}s)` : ""}`);
			log.inspect(`batch ${batch}`, ids);
			log.time(`batch ${batch}`);
			(async () => {
				for (const id of ids) {
					while (pageChecks > 0) await sleep(250);
					const before = thumbnails.get(id)?.refreshedAt;
					try {
						await serve(id);
					} catch (e) {
						log.error(`${id}: background check failed:`, e);
					}
					// Space out TMDB requests when a page loads many anime at once
					if (thumbnails.get(id)?.refreshedAt !== before) await sleep(250);
				}
			})()
				.catch(() => undefined)
				.then(() => {
					serving = false;
					batchEnded = Date.now();
					// Queued while it ran: look again
					lastSeen = 0;
					log.timeEnd(`batch ${batch}`);
					if (rebuildPending) armRebuild();
					tray.update();
				});
		}, 500);

		// Empty kept metadata copies once they're too old to use ($store has no delete), so a long session with a big
		// library doesn't hold one for every anime it ever loaded
		ctx.setInterval(() => {
			const now = Date.now();
			let emptied = 0;
			for (const [key, value] of Object.entries($store.getAll() ?? {})) {
				if (key.indexOf("CEM_META_") !== 0 || key === "CEM_META_CLEARED" || !value) continue;
				try {
					if (now - (JSON.parse(`${value}`) as { at: number }).at < HOUR) continue;
				} catch {}
				$store.set(key, "");
				emptied++;
			}
			if (emptied) log.debug(`Emptied ${emptied} kept metadata copies over an hour old`);
		}, 10 * 60 * 1000);

		// Forget anime not seen for 60 days, unless their custom metadata still needs the match
		ctx.setTimeout(() => {
			const now = Date.now();
			const forgotten: number[] = [];
			for (const [key, record] of Object.entries(thumbnails.all())) {
				if (hasCustom(Number(key)) || now - record.lastSeenAt <= 60 * DAY) continue;
				thumbnails.set(Number(key), null);
				forgotten.push(Number(key));
			}
			if (forgotten.length) log.info(`Forgot the TMDB matches of ${forgotten.length} anime not seen for 60 days`, forgotten);
		}, 5000);

		ctx.screen.onNavigate(async ({ pathname, searchParams }) => {
			currentPath = pathname;
			if (pathname !== "/entry" || !searchParams.id) {
				currentMedia.set(null);
				// Back home: background changes it shows are rebuilt (at most every REBUILD_GAP)
				if (pathname === "/" && rebuildPending && !serving) armRebuild();
				return updateBadge();
			}
			const mediaId = Number(searchParams.id);
			const entry = await ctx.anime.getAnimeEntry(mediaId);
			currentMedia.set({
				id: entry.mediaId,
				// No banner: the cover, as Seanime's own pages do
				banner: entry.media?.bannerImage || entry.media?.coverImage?.extraLarge || entry.media?.coverImage?.large || "",
				title: entry.media?.title?.userPreferred ?? "",
				type: entry.media?.format?.valueOf() === "MOVIE" ? "movie" : "tv",
			});
			// A change found in the background for this anime and still waiting for a rebuild shows now
			if (rebuildPending && rebuildIds.indexOf(mediaId) !== -1) {
				rebuildUrgent = true;
				armRebuild();
			}

			log.mark(`Page opened: ${entry.media?.title?.userPreferred ?? mediaId} (${mediaId})`);
			// The page may come from Seanime's cache without loading metadata, so check this anime here too, fully
			// A batch running meanwhile pauses between its anime until the page is done
			pageChecks++;
			serve(mediaId, true)
				.then(() => {
					// The page being viewed doesn't wait for a background batch or the rebuild gap
					if (rebuildPending && rebuildUrgent) rebuild();
					tray.update();
				})
				.catch((e) => log.error(`${mediaId}: checking the opened page failed:`, e))
				.then(() => pageChecks--);
			updateBadge();

			// Keep the generated episode list in step with newly aired episodes, straight away for the page being viewed
			if (!syncEpisodeCount(mediaId, entry.media)) return;
			clearMetadataCache();
			$app.invalidateClientQuery(ENTRY_QUERIES);
		});

		ctx.screen.loadCurrent();

		function isAnimeEpisode(ep: $app.Anime_Episode | $app.Onlinestream_Episode, type: string): ep is $app.Anime_Episode {
			return type !== "onlinestream";
		}

		function withBanner(banner: string, container: any[]) {
			const bannerDiv = tray.div([], {
				className: "absolute h-40 rounded-t-xl bg-center bg-cover pointer-events-none",
				style: {
					top: "-0.75rem",
					left: "-0.75rem",
					width: "calc(100% + 1.5rem)",
					backgroundImage: `url(${banner})`,
					maskImage: "linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, transparent 100%)",
				},
			});

			return tray.div([bannerDiv, tray.div(container, { style: { position: "relative", height: "100%" } })], {
				style: { position: "relative", height: "33.5rem" },
			});
		}

		/** An input with its label as a block on the left, all labels of a group as wide (labelWidth) so the inputs line up. */
		function styledInput(label: string, params: Parameters<NonNullable<$ui.Tray["input"]>>[1] & { placeholder?: string }, labelWidth = MODAL_LABEL_WIDTH) {
			return tray.flex(
				[
					tray.text(label, {
						className: "flex items-center whitespace-nowrap px-3 bg-gray-800 rounded-l-xl border text-sm",
						style: { opacity: params?.disabled ? "0.5" : "1", marginRight: "-1px", width: labelWidth, minWidth: labelWidth, flexShrink: "0" },
					}),
					tray.input({
						...params,
						style: {
							borderRadius: "0 0.75rem 0.75rem 0",
							background: "rgb(var(--color-gray-900))",
							...params?.style,
						},
					}),
				],
				{ gap: 0 },
			);
		}
	});

	$app.onAnimeMetadata((e) => {
		if (!e.animeMetadata) return e.next();
		const hookDebug = $shared.use<(line: string) => void>("hookDebug");
		const newEpisode = $shared.use<(key: string, airDate?: string, eid?: number, title?: string) => $app.Metadata_EpisodeMetadata>("newEpisode");
		if (!e.animeMetadata.episodes) e.animeMetadata.episodes = {};

		const record = $shared.use<CEM.ThumbnailStore>("thumbnails").get(e.mediaId);
		const matched = record?.status === "matched";
		// The episode list the plugin supplies (no Animap entry): nothing in it is Seanime's own but AniDB's air dates
		const supplied = !!$shared.use<CEM.AnimapStore>("animap").get(e.mediaId)?.fallback;
		const fillOn = $getUserPreference("tmdb-fill-missing") !== "false";
		const aired = $shared.use<Aired>("aired")(e.mediaId);
		const placeholder = (title?: string) => !title?.trim() || /^(episode|ep\.?)\s*\d+$|^第\s*\d+\s*話$/i.test(title.trim());
		const meta = e.animeMetadata;
		const episodes = meta.episodes as Record<string, $app.Metadata_EpisodeMetadata>; // set above
		// Episodes Seanime's own metadata has no overview, thumbnail, real title ("Episode 4") or length for (Animap often
		// has the length only as text, e.g. "8m", which Seanime doesn't read), before anything below changes them. Unaired
		// ones too: Animap may date an episode by its TV broadcast while it already streams. Seanime's own titles too, for
		// matching by title when the air dates don't line up.
		const gaps: Record<string, boolean> = {};
		const ownTitles: Record<string, string> = {};
		for (const [key, ep] of Object.entries(episodes)) {
			if (ep && (!(ep.overview || ep.summary) || !ep.image || placeholder(ep.title) || !ep.length)) gaps[key] = true;
			if (ep?.title && /^\d+$/.test(key) && !supplied) ownTitles[key] = ep.title;
		}
		/** Adds an aired episode Seanime's list doesn't have (yet). Which ones were added is kept for the UI context. */
		const added: string[] = [];
		const addEpisode = (key: string, airDate: string) => {
			episodes[key] = newEpisode(key, airDate);
			meta.episodeCount = Math.max(meta.episodeCount ?? 0, Number(key));
			added.push(key);
			return episodes[key]; // read back: Seanime's episode map stores a copy
		};

		// Seanime's metadata has no AniDB ID (e.g. Animap knows the anime but not its AniDB entry): add the user's or a
		// verified one, with episode IDs, adding aired episodes the metadata is missing. The no-metadata case gets this
		// in onAnimeMetadataRequested already.
		if (!e.animeMetadata.mappings) e.animeMetadata.mappings = {};
		const mappings = e.animeMetadata.mappings; // read back: assigned objects are stored as copies
		// Remember whether Seanime itself had an AniDB ID, so the UI context needn't load the metadata again to find out
		$store.set(`CEM_SEANIME_ANIDB_${e.mediaId}`, mappings.anidbId || 0);
		const { aid, anidb, own } = $shared.use<AnidbInUse>("anidbInUse")(e.mediaId);
		let injected = 0;
		if (!mappings.anidbId && e.mediaId < 0x80000000) {
			if (aid) {
				mappings.anidbId = injected = aid;
				for (const [n, eid] of Object.entries(own?.eids ?? {})) {
					const airDate = own?.airDates?.[n];
					const episode = episodes[n] ?? (aired(n, airDate) ? addEpisode(n, airDate ?? "") : undefined);
					if (episode && !episode.anidbEid) episode.anidbEid = episode.anidbId = eid;
				}
			}
		}

		// Fill-in: each field from the first source that has it. Seanime's own data always wins; then AniDB's air dates
		// (it dates episodes most reliably) but TMDB's titles, overviews and lengths (AniDB's titles are often only
		// "Volume 1"). Placeholder titles never count. AniDB's data only for the AniDB entry in use.
		const tmdbData = matched && fillOn ? record.episodes ?? {} : {};
		const anidbData = fillOn && anidb && anidb.status !== "none" && anidb.aid === mappings.anidbId ? anidb.episodes ?? {} : {};
		// Aired episodes TMDB has and Seanime's list doesn't (yet)
		for (const [key, data] of Object.entries(tmdbData)) {
			if (!episodes[key] && (data.aired || aired(key, data.airDate))) addEpisode(key, "");
		}
		// Titles and air dates taken from TMDB, with what was there before: they mustn't count as evidence for the TMDB
		// match they came from (a deleted override would otherwise match again by its own dates or titles)
		const tmdbFilled: Record<string, { title?: string; airDate?: string }> = {};
		let fills = 0;
		for (const [key, ep] of Object.entries(episodes)) {
			const t = tmdbData[key];
			const a = anidbData[key];
			if (!ep || !(t || a)) continue;
			const ownTitle = supplied || placeholder(ep.title) ? "" : ep.title;
			const title = ownTitle || (!placeholder(t?.title) ? t?.title : "") || (!placeholder(a?.title) ? a?.title : "");
			if (title && title !== ep.title) {
				if (title === t?.title) (tmdbFilled[key] ??= {}).title = ep.title ?? "";
				ep.title = title;
			}
			if (!ep.title) ep.title = `Episode ${key}`;
			const airDate = ep.airDate || a?.airDate || t?.airDate;
			if (airDate && airDate !== ep.airDate) {
				if (airDate === t?.airDate && airDate !== a?.airDate) (tmdbFilled[key] ??= {}).airDate = ep.airDate ?? "";
				ep.airDate = airDate;
			}
			const overview = ep.overview || ep.summary || t?.overview || a?.summary;
			if (overview && !(ep.overview || ep.summary)) ep.overview = ep.summary = overview;
			if (!ep.length) ep.length = t?.length || a?.length || 0;
			fills++;
		}

		// TMDB stills: they replace Animap's (TVDB) thumbnails with the setting on (and in the list the plugin supplies,
		// which has none), else only fill a missing one. Custom images below still win.
		let stills = 0;
		const replace = $getUserPreference("tmdb-thumbnails") === "true" || supplied;
		if (matched && (replace || fillOn)) {
			const tmdbImage = $shared.use<(path: string) => string>("tmdbImage");
			for (const [key, image] of Object.entries(record.images)) {
				const episodeMetadata = episodes[key];
				if (!episodeMetadata || (!replace && episodeMetadata.image)) continue;
				episodeMetadata.image = tmdbImage(image);
				episodeMetadata.hasImage = true;
				stills++;
			}
		}

		const entry = $shared.use<CEM.SharedDatabase>("database").get(e.mediaId);
		// Episodes only the custom metadata has aren't Seanime's either
		const customOnly: string[] = [];
		for (const [key, customMetadata] of Object.entries(entry.data)) {
			const episodeMetadata = e.animeMetadata.episodes[key];
			if (!episodeMetadata) customOnly.push(key);
			if (customMetadata.image?.length) customMetadata.hasImage = true;
			if (customMetadata.overview?.length) customMetadata.summary = customMetadata.overview;
			const merged = { ...episodeMetadata, ...customMetadata };
			// A blank custom image must not wipe the existing thumbnail
			if (!customMetadata.image?.length && episodeMetadata) {
				merged.image = episodeMetadata.image;
				merged.hasImage = episodeMetadata.hasImage;
			}
			e.animeMetadata.episodes[key] = merged;
		}
		// Kept apart from Seanime's own episodes: the UI context leaves these out of Seanime's (cached) metadata
		const notOwn = added.concat(customOnly);
		if (notOwn.length || $store.get(`CEM_ADDED_${e.mediaId}`)) $store.set(`CEM_ADDED_${e.mediaId}`, notOwn.length ? JSON.stringify(notOwn) : "");
		const filledKeys = Object.keys(tmdbFilled).length;
		if (filledKeys || $store.get(`CEM_TMDB_FILLED_${e.mediaId}`)) $store.set(`CEM_TMDB_FILLED_${e.mediaId}`, filledKeys ? JSON.stringify(tmdbFilled) : "");

		if ($debug.enabled && (stills || fills || injected || Object.keys(entry.data).length)) {
			hookDebug(`hook: ${e.mediaId}: ${stills} TMDB stills, ${fills ? `${fills} episodes filled in${added.length ? ` (${added.length} added)` : ""}, ` : ""}${Object.keys(entry.data).length} custom episodes${injected ? `, AniDB ${injected} added` : ""}`);
		}

		// What the UI context needs from this metadata (air dates, IDs), so its checks don't have to ask Seanime again:
		// with more than 100 anime loaded, Seanime's cache has often dropped it, and asking means another Animap fetch.
		// Without a TMDB key those checks don't run. Copies over an hour old are emptied by the UI context.
		if (!$getUserPreference("tmdb-api")) return e.next();
		const kept: Record<string, { airDate?: string; title?: string; gap?: boolean }> = {};
		for (const [key, ep] of Object.entries(episodes)) {
			if (notOwn.indexOf(key) !== -1) continue;
			const airDate = tmdbFilled[key]?.airDate ?? ep?.airDate;
			kept[key] = { ...(airDate ? { airDate } : {}), ...(ownTitles[key] ? { title: ownTitles[key] } : {}), ...(gaps[key] ? { gap: true } : {}) };
		}
		$store.set(
			`CEM_META_${e.mediaId}`,
			JSON.stringify({
				at: Date.now(),
				metadata: {
					episodes: kept,
					episodeCount: meta.episodeCount ?? 0,
					mappings: { themoviedbId: mappings.themoviedbId ?? "", anidbId: mappings.anidbId ?? 0 },
				},
			}),
		);
		e.next();
	});
}
