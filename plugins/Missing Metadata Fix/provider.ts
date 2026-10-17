/// <reference path="../../typings/plugin.d.ts" />
/// <reference path="../../typings/system.d.ts" />
/// <reference path="../../typings/app.d.ts" />
/// <reference path="../../typings/core.d.ts" />
/// <reference path="./missing-metadata-fix.d.ts" />
// Add delay between searches

// @ts-ignore
function init(): void {
	$shared.define("database", () => {
		const key = "CUSTOM_EPISODE_METADATA_STORAGE_V2";
		const records = () => ($storage.get(key) ?? {}) as Record<number, CEM.CustomEpisodeEntry>;
		const get = (mediaId: number) => records()[mediaId] ?? { mediaId, data: {} };
		const has = (mediaId: number) => mediaId in records();
		const set = (mediaId: number, data: CEM.CustomEpisodeEntry) => {
			const obj = records();
			obj[mediaId] = data;
			$storage.set(key, obj);
		};

		return {
			records,
			get,
			has,
			save: (mediaId: number, data: Partial<Omit<CEM.CustomEpisodeMetadata, "episode">> & Pick<CEM.CustomEpisodeMetadata, "episode">) => {
				const entry = get(mediaId);
				entry.data[data.episode] = data;
				set(mediaId, entry);
				return entry;
			},
			delete: (mediaId: number, episode: string) => {
				const entry = get(mediaId);
				delete entry.data[episode];
				set(mediaId, entry);
				return !(episode in entry.data);
			},
		};
	});

	// Whether Animap can serve an anime. Kept separate from the custom metadata so it survives deleting all of it.
	$shared.define("animap", () => {
		const key = "ANIMAP_STATUS_V1";
		const all = () => ($storage.get(key) ?? {}) as Record<number, CEM.AnimapStatus>;
		return {
			all,
			get: (mediaId: number) => all()[mediaId] as CEM.AnimapStatus | undefined,
			set: (mediaId: number, status: CEM.AnimapStatus | null) => {
				const obj = all();
				if (status) obj[mediaId] = status;
				else delete obj[mediaId];
				$storage.set(key, obj);
			},
		};
	});

	// TMDB image size from the settings. Stored stills are TMDB paths, so a new size applies straight away.
	$shared.define("tmdbImage", () => (path: string) => {
		if (/^https?:/.test(path)) return path; // stored before paths were
		const pref = $getUserPreference("image-size") ?? "w300";
		const size = pref === "max720" ? "w1280" : pref === "max1080" ? "w1920" : pref; // sizes from an earlier version
		return `https://image.tmdb.org/t/p/${size}${path}`;
	});

	// The AniDB ID (and episode IDs) used for anime Seanime has no metadata for
	$shared.define("anidb", () => {
		const key = "ANIDB_MATCHES_V1";
		const all = () => ($storage.get(key) ?? {}) as Record<number, CEM.AnidbMatch>;
		return {
			all,
			get: (mediaId: number) => all()[mediaId] as CEM.AnidbMatch | undefined,
			set: (mediaId: number, match: CEM.AnidbMatch | null) => {
				const obj = all();
				if (match) obj[mediaId] = match;
				else delete obj[mediaId];
				$storage.set(key, obj);
			},
		};
	});

	// How each anime maps onto TMDB and the stills found for it, kept on disk so restarts lose nothing
	$shared.define("thumbnails", () => {
		const key = "TMDB_THUMBNAILS_V1";
		const all = () => ($storage.get(key) ?? {}) as Record<number, CEM.ThumbnailRecord>;
		return {
			all,
			get: (mediaId: number) => all()[mediaId] as CEM.ThumbnailRecord | undefined,
			set: (mediaId: number, record: CEM.ThumbnailRecord | null) => {
				const obj = all();
				if (record) obj[mediaId] = record;
				else delete obj[mediaId];
				$storage.set(key, obj);
			},
		};
	});

	// When Animap has no entry (e.g. AniDB entries that are 18+), Seanime errors out before onAnimeMetadata fires and
	// custom metadata is never applied. For those anime, supply the episode list here instead so Animap is never called;
	// onAnimeMetadata still runs afterwards and merges the custom metadata and TMDB stills. Only anime with custom
	// metadata or matched TMDB stills are taken over, so everything else keeps going to Animap and picks up its entry
	// as soon as it exists.
	$app.onAnimeMetadataRequested((e) => {
		// Tell the UI context which anime Seanime is loading (entry page, Continue Watching, anywhere), so their TMDB
		// data is fetched or refreshed on demand. Seanime caches metadata for an hour, but only for 100 anime: a page
		// with more keeps evicting them, and the plugin's own checks then refetch them. So an anime checked in the last
		// 10 minutes isn't queued again (that would loop); the entry page still checks it on every visit.
		const served = Number($store.get(`CEM_SERVED_${e.mediaId}`)) || 0;
		const queued = `${$store.get("CEM_REQUESTED") ?? ""}`;
		if (Date.now() - served > 10 * 60 * 1000 && `,${queued},`.indexOf(`,${e.mediaId},`) === -1) {
			$store.set("CEM_REQUESTED", queued ? `${queued},${e.mediaId}` : `${e.mediaId}`);
			// When the queue started filling and when it last grew: the UI context waits for a page load to settle
			if (!queued) $store.set("CEM_REQUESTED_FIRST", Date.now());
			$store.set("CEM_REQUESTED_LAST", Date.now());
		} else if ($debug.enabled && Date.now() - served <= 10 * 60 * 1000) {
			$debug.debug(`hook: ${e.mediaId} not queued, checked ${Math.round((Date.now() - served) / 1000)}s ago`);
		}

		const status = $shared.use<CEM.AnimapStore>("animap").get(e.mediaId);
		if (!status?.fallback || !e.animeMetadata) return e.next();

		const custom = $shared.use<CEM.SharedDatabase>("database").get(e.mediaId).data;
		const thumbs = $shared.use<CEM.ThumbnailStore>("thumbnails").get(e.mediaId);
		const matched = thumbs?.status === "matched";
		const stills = matched && $getUserPreference("tmdb-thumbnails") === "true" ? Object.keys(thumbs.images) : [];
		const filled = matched && $getUserPreference("tmdb-fill-missing") === "true" ? Object.keys(thumbs.episodes ?? {}) : [];

		// A real AniDB ID clears Seanime's "metadata retrieval not available" notice and lets AnimeTosho search by AniDB
		// (anime and episode IDs). Only the user's override or a match whose air dates were checked against AniDB;
		// never a made-up or borrowed one, since torrent providers search by it.
		const overrides = ($storage.get("TMDB_OVERRIDES") ?? {}) as Record<number, CEM.TMDBOverrides>;
		const anidb = $shared.use<{ get: (id: number) => CEM.AnidbMatch | undefined }>("anidb").get(e.mediaId);
		const lookup = $getUserPreference("anidb-lookup") !== "false";
		const aid = overrides[e.mediaId]?.anidbId ?? (lookup && anidb?.status === "verified" ? anidb.aid : undefined);
		const eids = anidb?.aid === aid ? anidb?.eids ?? {} : {};

		if (!Object.keys(custom).length && !stills.length && !filled.length && !aid) return e.next();
		// Episodes written ahead of airing don't belong in the list yet
		const today = new Date().toISOString().slice(0, 10);
		const numbered = Object.keys(custom)
			.filter((k) => /^\d+$/.test(k) && !(custom[k].airDate && custom[k].airDate > today))
			.map(Number);
		const count = Math.max(status.episodeCount, ...numbered, 0);
		if (count < 1) return e.next();

		const episodes = e.animeMetadata.episodes ?? (e.animeMetadata.episodes = {});
		for (let n = 1; n <= count; n++) {
			const eid = eids[`${n}`] ?? 0;
			episodes[`${n}`] = {
				anidbId: eid, tvdbId: 0, title: `Episode ${n}`, image: "", airDate: "", length: 0, summary: "", overview: "",
				episodeNumber: n, episode: `${n}`, seasonNumber: 1, absoluteEpisodeNumber: n, anidbEid: eid, hasImage: false,
			};
		}
		e.animeMetadata.episodeCount = count;
		if ($debug.enabled) $debug.debug(`hook: ${e.mediaId} has no Animap entry; supplying ${count} episodes${aid ? `, AniDB ${aid}` : ""}`);
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
		const REPO_BRANCH = "master";
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
		const log = {
			mark: (...values: unknown[]) => $debug.mark(...values),
			step: (...values: unknown[]) => $debug.log(...values),
			debug: (...values: unknown[]) => $debug.debug(...values),
			inspect: (...values: unknown[]) => $debug.inspect(...values),
			time: (label: string) => $debug.time(label),
			timeEnd: (label: string) => $debug.timeEnd(label),
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
		 * ctx.anime.getAnimeMetadata when Seanime has no metadata.
		 */
		async function loadMetadata(mediaId: number): Promise<$app.Metadata_AnimeMetadata | undefined> {
			try {
				const kept = JSON.parse(`${$store.get(`CEM_META_${mediaId}`) ?? ""}`) as { at: number; metadata: $app.Metadata_AnimeMetadata };
				// Not older than an hour, and built since the plugin last cleared Seanime's cache (strictly after: one built
				// in the same millisecond as a clear may predate it)
				const cleared = Number($store.get("CEM_META_CLEARED")) || 0;
				if (Date.now() - kept.at < HOUR && kept.at > cleared) return kept.metadata;
			} catch {}
			log.debug(`${mediaId}: no usable kept metadata copy, asking Seanime`);
			return ctx.anime.getAnimeMetadata("anilist", mediaId);
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
			isFetching: ctx.state<boolean>(false),
			search: async (query: string, type: "tv" | "movie") =>
				tmdb.__fetch__<CEM.TMDBSearchResults>(`search/${type}?query=${encodeURIComponent(query)}&include_adult=true&language=en-US&page=1`),
			getDetails: <T extends "tv" | "movie">(tmdbId: number, type: T) =>
				tmdb.__fetch__<T extends "tv" ? CEM.TMDBTVShowDetails : CEM.TMDBMovieDetails>(`${type}/${tmdbId}`),
			getSeason: async (tmdbId: number, season: number) => tmdb.__fetch__<CEM.TMDBSeasonResults>(`tv/${tmdbId}/season/${season}`),
			/** Several seasons in one request: TMDB appends up to 20 "season/N" objects to the show details. */
			getSeasons: async (tmdbId: number, seasons: number[]) => {
				const result: Record<number, CEM.TMDBSeasonResults> = {};
				for (let i = 0; i < seasons.length; i += 20) {
					const chunk = seasons.slice(i, i + 20);
					const res = await tmdb.__fetch__<Record<string, unknown>>(`tv/${tmdbId}?append_to_response=${chunk.map((n) => `season/${n}`).join(",")}`);
					for (const n of chunk) {
						const season = res[`season/${n}`] as CEM.TMDBSeasonResults | undefined;
						if (season?.episodes) result[n] = season;
					}
				}
				return result;
			},
			__fetch__: async <T>(endpoint: string) => {
				const url = new URL(`${tmdb.baseUri}/${endpoint}`);
				url.searchParams.set("api_key", `${tmdb.API_KEY}`);
				url.searchParams.set("language", "en-US");

				// TMDB allows roughly 40 requests a second; on a 429 wait as asked and try again
				log.debug("TMDB request", endpoint);
				let res = await ctx.fetch(url.toString());
				for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
					const wait = Number(res.headers?.["Retry-After"] ?? res.headers?.["retry-after"]) || 2;
					log.warn(`TMDB rate limit hit, retrying in ${wait}s`);
					await new Promise<void>((resolve) => ctx.setTimeout(() => resolve(), wait * 1000));
					res = await ctx.fetch(url.toString());
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
			// isFetching=false could be lost and leave the spinner running. tray.update() always re-renders.
			setFetching: (value: boolean) => {
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
				has: (mediaId: number) => mediaId in tmdb.overrides.records(),
				hasEpisode: (mediaId: number, aniDBEpisode: string) => tmdb.overrides.get(mediaId).episodeOverrides.some((e) => e.aniDBEpisode === aniDBEpisode),
				remove: (mediaId: number) => {
					const records = tmdb.overrides.records();
					delete records[mediaId];
					$storage.set(tmdb.overrides.__id__, records);
				},
				removeEpisodeOverride: (mediaId: number, aniDBEpisode: string) => {
					const data = tmdb.overrides.get(mediaId);
					const filtered = data.episodeOverrides.filter((x) => x.aniDBEpisode !== aniDBEpisode);

					if (filtered.length === data.episodeOverrides.length) return false;
					tmdb.overrides.set(mediaId, { ...data, episodeOverrides: filtered }, true);
					return true;
				},
				removeMediaOverride: (mediaId: number) => {
					const data = tmdb.overrides.get(mediaId);
					delete data.tmdbId;
					delete data.tmdbSeason;
					delete data.tmdbSeasons;
					delete data.tmdbOffset;
					delete data.anidbId;
					delete data.anidbOffset;
					tmdb.overrides.set(mediaId, { ...data }, true);
					return !("tmdbId" in data) && !("tmdbSeason" in data) && !("tmdbOffset" in data);
				},
				// Where an episode points on TMDB: the episode override wins, then the media override (with its offset)
				resolve: (mediaId: number, aniDBEpisode: string) => {
					const media = tmdb.overrides.get(mediaId);
					const episode = media.episodeOverrides.find((e) => e.aniDBEpisode === aniDBEpisode) ?? {};
					const tmdbId = episode.tmdbId ?? media.tmdbId;
					const tmdbSeason = episode.tmdbSeason ?? media.tmdbSeason;
					let tmdbEpisode = episode.tmdbEpisode;
					if (tmdbEpisode === undefined) {
						const epstr = aniDBEpisode.match(/\d+/);
						// The offset only applies to main episodes ("12"), not specials ("S1")
						if (epstr) tmdbEpisode = parseInt(epstr[0], 10) + (/^\d+$/.test(aniDBEpisode) ? media.tmdbOffset ?? 0 : 0);
					}
					return { tmdbId, tmdbSeason, tmdbEpisode };
				},
				episode: {
					fieldRefs: {
						tmdbId: ctx.fieldRef<string>(""),
						tmdbSeason: ctx.fieldRef<string>(""),
						tmdbEpisode: ctx.fieldRef<string>(""),
					},
					fill: (data: CEM.TMDBOverrides["episodeOverrides"][number]) => {
						tmdb.overrides.episode.fieldRefs.tmdbId.setValue(data.tmdbId?.toString() ?? "");
						tmdb.overrides.episode.fieldRefs.tmdbSeason.setValue(data.tmdbSeason?.toString() ?? "");
						tmdb.overrides.episode.fieldRefs.tmdbEpisode.setValue(data.tmdbEpisode?.toString() ?? "");
					},
					resetFieldRefs: () => Object.values(tmdb.overrides.episode.fieldRefs).forEach((fr) => fr.setValue("")),
					save: (mediaId: number, aniDBEpisode: string) => {
						const update: CEM.TMDBOverrides["episodeOverrides"][number] = {};
						const tmdbId = tmdb.overrides.episode.fieldRefs.tmdbId.current;
						const tmdbSeason = tmdb.overrides.episode.fieldRefs.tmdbSeason.current;
						const tmdbEpisode = tmdb.overrides.episode.fieldRefs.tmdbEpisode.current;

						if (tmdbId.length && !isNaN(Number(tmdbId))) update.tmdbId = Number(tmdbId);
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
					excludeAuto: ctx.fieldRef<boolean>(false),
					fill: (data: Omit<CEM.TMDBOverrides, "mediaId" | "episodeOverrides">) => {
						tmdb.overrides.media.fieldRefs.tmdbId.setValue(data.tmdbId?.toString() ?? "");
						tmdb.overrides.media.fieldRefs.tmdbSeason.setValue(data.tmdbSeasons?.length ? formatSeasons(data.tmdbSeasons) : data.tmdbSeason?.toString() ?? "");
						tmdb.overrides.media.fieldRefs.tmdbOffset.setValue(data.tmdbOffset?.toString() ?? "");
						tmdb.overrides.media.fieldRefs.anidbId.setValue(data.anidbId?.toString() ?? "");
						tmdb.overrides.media.fieldRefs.anidbOffset.setValue(data.anidbOffset?.toString() ?? "");
					},
					resetFieldRefs: () => Object.values(tmdb.overrides.media.fieldRefs).forEach((fr) => fr.setValue("")),
					save: (mediaId: number) => {
						const update: Omit<CEM.TMDBOverrides, "mediaId" | "episodeOverrides"> = {};
						const tmdbId = tmdb.overrides.media.fieldRefs.tmdbId.current;
						const tmdbSeason = tmdb.overrides.media.fieldRefs.tmdbSeason.current;
						const tmdbOffset = tmdb.overrides.media.fieldRefs.tmdbOffset.current.trim();

						if (tmdbId.length && !isNaN(Number(tmdbId))) update.tmdbId = Number(tmdbId);
						if (tmdbSeason.trim().length) {
							const seasons = parseSeasons(tmdbSeason);
							if (!seasons) throw new Error(`TMDB Season "${tmdbSeason}" isn't a season or a list like "1-4" or "1, 2, 5".`);
							update.tmdbSeason = seasons[0];
							if (seasons.length > 1) update.tmdbSeasons = seasons;
						}
						if (tmdbOffset.length && Number.isInteger(Number(tmdbOffset)) && Number(tmdbOffset) !== 0) update.tmdbOffset = Number(tmdbOffset);
						const anidbId = Number(tmdb.overrides.media.fieldRefs.anidbId.current.trim());
						if (Number.isInteger(anidbId) && anidbId > 0) update.anidbId = anidbId;
						const anidbOffset = tmdb.overrides.media.fieldRefs.anidbOffset.current.trim();
						if (anidbOffset.length && Number.isInteger(Number(anidbOffset)) && Number(anidbOffset) !== 0) update.anidbOffset = Number(anidbOffset);

						// Overwrite so a cleared field actually removes the old value
						const { episodeOverrides, excludeAuto } = tmdb.overrides.get(mediaId);
						if (excludeAuto) update.excludeAuto = true;
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
					update.hasImage = true;
				}

				update.hasImage = !!update.image?.length;
				database.save(mediaId, update);
			},
		};

		/** TMDB overrides modal. Pass the episode being edited, or null from the episode list. */
		function overridesModal(currentMediaData: NonNullable<ReturnType<typeof currentMedia.get>>, episode: string | null) {
			return tray.modal({
				trigger: tray.button("Overrides", {
					intent: "white",
					// Match the neighbouring buttons: "md" in the editor, default size next to Delete All
					...(episode !== null ? { size: "md" as const } : {}),
					disabled: !$getUserPreference("tmdb-api")?.length || tmdb.isFetching.get(),
				}),
				title: "TMDB Overrides",
				description:
					"If the automatic fetching fails or uses the incorrect data, you can manually assign an override here. We will fetch the data based on the provided overrides.",
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
							...(episode !== null
								? [
									tray.tabsContent({
										value: "episode",
										className: "space-y-3 mt-2 p-3 border rounded-xl",
										items: [
											tray.text("This override takes precedence against media override and applies to the current episode only.", {
												className: "text-sm text-[--muted] break-normal text-pretty",
											}),
											styledInput("TMDB ID", {
												fieldRef: tmdb.overrides.episode.fieldRefs.tmdbId,
											}),
											styledInput("TMDB Season", {
												fieldRef: tmdb.overrides.episode.fieldRefs.tmdbSeason,
												disabled: currentMediaData.type === "movie",
											}),
											styledInput("TMDB Episode", {
												fieldRef: tmdb.overrides.episode.fieldRefs.tmdbEpisode,
												disabled: currentMediaData.type === "movie",
											}),
											tray.flex(
												[
													tray.button("Delete", {
														intent: "alert",
														size: "md",
														style: { display: tmdb.overrides.hasEpisode(currentMediaData.id, episode) ? "block" : "none" },
														onClick: ctx.eventHandler(`modal-del-${currentMediaData.id}-${episode}`, () => {
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
															tmdb.overrides.episode.save(currentMediaData.id, episode);
															rematch(currentMediaData.id);
															ctx.toast.success("Successfully saved this episode's overrides!");
															tray.update();
														}),
													}),
												],
												{ className: "justify-end" },
											),
										],
									}),
									]
								: []),
							tray.tabsContent({
								value: "media",
								className: "space-y-3 mt-2 p-3 border rounded-xl",
								items: [
									tray.text("This override will apply to all episodes of the current media except for episodes with existing overrides.", {
										className: "text-sm text-[--muted] break-normal text-pretty",
									}),
									tray.text(matchStatus(currentMediaData.id), { className: "text-sm break-normal text-pretty" }),
									styledInput("TMDB ID", {
										fieldRef: tmdb.overrides.media.fieldRefs.tmdbId,
									}),
									styledInput("TMDB Season", {
										fieldRef: tmdb.overrides.media.fieldRefs.tmdbSeason,
										disabled: currentMediaData.type === "movie",
									}),
									styledInput("TMDB Offset", {
										fieldRef: tmdb.overrides.media.fieldRefs.tmdbOffset,
										disabled: currentMediaData.type === "movie",
									}),
									// Real AniDB ID for anime Seanime has no metadata for: clears its "metadata retrieval not available" notice
									styledInput("AniDB ID", { fieldRef: tmdb.overrides.media.fieldRefs.anidbId }),
									styledInput("AniDB Offset", { fieldRef: tmdb.overrides.media.fieldRefs.anidbOffset }),
									tray.flex(
										[
											tray.tooltip(
												tray.button("Auto-fill", {
													intent: "white",
													size: "md",
													disabled: !tmdb.API_KEY?.length || tmdb.isFetching.get(),
													loading: tmdb.isFetching.get(),
													onClick: ctx.eventHandler(`modal-autofill-${currentMediaData.id}`, async () => {
														tmdb.setFetching(true);
														try {
															log.mark(`Auto-fill: ${currentMediaData.id}`);
															log.time(`autofill ${currentMediaData.id}`);
															await autoFill(currentMediaData.id);
															log.timeEnd(`autofill ${currentMediaData.id}`);
														} catch (e) {
															log.error(`${currentMediaData.id}: Auto-fill failed:`, e);
															ctx.toast.error((e as Error).message);
														} finally {
															tmdb.setFetching(false);
														}
													}),
												}),
												{ text: "Find the TMDB ID, season and offset from Animap or a TMDB search, checked against the air dates" },
											),
											tray.tooltip(
												tray.button("Refresh", {
													intent: "white",
													size: "md",
													disabled: !tmdb.API_KEY?.length || tmdb.isFetching.get(),
													loading: tmdb.isFetching.get(),
													onClick: ctx.eventHandler(`modal-refresh-${currentMediaData.id}`, async () => {
														tmdb.setFetching(true);
														try {
															const message = await refreshEntry(currentMediaData.id);
															ctx.toast.success(message);
														} catch (e) {
															ctx.toast.error((e as Error).message);
														} finally {
															tmdb.setFetching(false);
															tray.update();
														}
													}),
												}),
												{ text: "Match this anime again now (TMDB stills, AniDB ID, related anime), even if its data hasn't expired" },
											),
											tray.div([], { className: "flex-1" }),
											tray.button("Delete", {
												intent: "alert",
												size: "md",
												style: {
													display:
														tmdb.overrides.get(currentMediaData.id)?.tmdbId ||
														tmdb.overrides.get(currentMediaData.id)?.tmdbSeason ||
														tmdb.overrides.get(currentMediaData.id)?.tmdbOffset ||
														tmdb.overrides.get(currentMediaData.id)?.anidbId ||
														tmdb.overrides.get(currentMediaData.id)?.anidbOffset
															? "block"
															: "none",
												},
												onClick: ctx.eventHandler(`modal-del-${currentMediaData.id}`, () => {
													log.mark(`Media override deleted: ${currentMediaData.id}`);
													const isDeleted = tmdb.overrides.removeMediaOverride(currentMediaData.id);
													rematch(currentMediaData.id);
													if (anidbStore.get(currentMediaData.id)?.status === "override") {
														void refreshAnidb(currentMediaData.id, true)
															.then(() => scheduleRebuild(false))
															.catch((e) => log.error(`${currentMediaData.id}: AniDB lookup after deleting the override failed:`, e));
													}
													tmdb.overrides.media.resetFieldRefs();
													if (isDeleted) {
														ctx.toast.success("Successfully removed this media's overrides!");
													} else {
														ctx.toast.error("Unable to delete this media override!");
													}
													tray.update();
												}),
											}),
											tray.button("Save", {
												intent: "primary",
												size: "md",
												onClick: ctx.eventHandler(`modal-save-${currentMediaData.id}`, () => {
													log.mark(`Media override saved: ${currentMediaData.id}`);
													try {
														tmdb.overrides.media.save(currentMediaData.id);
													} catch (e) {
														return ctx.toast.error((e as Error).message);
													}
													rematch(currentMediaData.id);
													if (tmdb.overrides.get(currentMediaData.id).anidbId || anidbStore.get(currentMediaData.id)) {
														void detectMissing(currentMediaData.id)
															.then(() => refreshAnidb(currentMediaData.id, true))
															.then(() => scheduleRebuild(false))
															.catch((e) => log.error(`${currentMediaData.id}: AniDB lookup after saving the override failed:`, e));
													}
													clearMetadataCache();
													$app.invalidateClientQuery(["ANIME-ENTRIES-get-anime-entry", "ANIME-get-anime-episode-collection"]);
													ctx.toast.success("Successfully saved this media's overrides!");
													tray.update();
												}),
											}),
										],
										{ className: "justify-end" },
									),
								],
							}),
							tray.tabsContent({
								value: "bulk-update",
								className: "space-y-3 mt-2 p-3 border rounded-xl",
								items: [
									tray.text(
										"Bulk updates all episode metadata from TMDB using the TMDB ID, TMDB Season and TMDB Offset saved in the media override. Episodes with their own override use that instead. With the automatic refresh on, the plugin keeps it up to date afterwards.",
										{ className: "text-sm text-[--muted] text-pretty break-normal text-justify" },
									),
									tray.text(" Note that this may override previously saved custom metadata for this media.", {
										className: "text-sm text-orange-400 bg-orange-800 border border-orange-500 rounded-xl p-2 bg-opacity-50",
									}),
									tray.button("Bulk Update", {
										size: "md",
										intent: "success-subtle",
										className: "w-full",
										disabled: !tmdb.API_KEY?.length || tmdb.isFetching.get(),
										loading: tmdb.isFetching.get(),
										onClick: ctx.eventHandler(`bulk-update-${currentMediaData.id}`, async () => {
											// Bulk Update is manual: it only runs from a saved media override, never from Animap's ID
											const override = tmdb.overrides.get(currentMediaData.id);
											if (!override.tmdbId) return ctx.toast.error("No TMDB ID override saved. Save one in the Media tab first (Auto-fill can find it).");
											if (currentMediaData.type !== "movie" && typeof override.tmdbSeason !== "number")
												return ctx.toast.error("No TMDB Season override saved. Save one in the Media tab first (Auto-fill can find it).");

											tmdb.setFetching(true);
											let result: RefreshResult;
											try {
												log.mark(`Bulk Update: ${currentMediaData.id}`);
												log.time(`bulk ${currentMediaData.id}`);
												result = await refreshAnime(currentMediaData.id, true, true);
												log.timeEnd(`bulk ${currentMediaData.id}`);
											} catch (error) {
												log.error(`${currentMediaData.id}: Bulk Update failed:`, error);
												return ctx.toast.error((error as Error).message);
											} finally {
												tmdb.setFetching(false);
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
										}),
									}),
									tray.switch("Exclude from automatic metadata refresh", {
										fieldRef: tmdb.overrides.media.excludeAuto,
										onChange: ctx.eventHandler(`exclude-auto-${currentMediaData.id}`, ({ value }: { value: boolean }) => {
											const data = tmdb.overrides.get(currentMediaData.id);
											if (value) data.excludeAuto = true;
											else delete data.excludeAuto;
											tmdb.overrides.set(currentMediaData.id, data, true);
											updateBadge();
										}),
									}),
								],
							}),
						],
					}),
				],
				footer: [
					tray.text("TMDB ID can be found on the tmdb link of the series in the format of: https://www.themoviedb.org/tv/{tmdbId}", {
						className: "break-normal text-[--muted] text-xs",
					}),
				],
				onOpenChange: ctx.eventHandler(`modal-open-${currentMediaData.id}-${episode}`, ({ open }) => {
					tmdb.overrides.episode.resetFieldRefs();
					if (!open) return;
					// Load what's saved, so the fields are right however the modal was opened
					const saved = tmdb.overrides.get(currentMediaData.id);
					tmdb.overrides.media.fill(saved);
					tmdb.overrides.media.excludeAuto.setValue(!!saved.excludeAuto);
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
								tray.text("Custom Episode Metadata", { className: "text-lg font-bold" }),
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
												tray.stack([
													styledInput("Episode Title", {
														fieldRef: fieldRefs.data.title,
														disabled: tmdb.isFetching.get(),
													}),
												]),
												tray.stack([
													styledInput("Duration (minutes)", {
														fieldRef: fieldRefs.data.length,
														disabled: tmdb.isFetching.get(),
													}),
												]),
												tray.stack([
													styledInput("Airdate (yyyy-mm-dd)", {
														fieldRef: fieldRefs.data.airDate,
														disabled: tmdb.isFetching.get(),
													}),
												]),
												tray.stack([
													styledInput("Overview", {
														fieldRef: fieldRefs.data.overview,
														textarea: true,
														style: { resize: "none" },
														disabled: tmdb.isFetching.get(),
													}),
												]),
												tray.stack([
													styledInput("Image URL", {
														fieldRef: fieldRefs.data.image,
														disabled: tmdb.isFetching.get(),
													}),
												]),
											],
											{ className: "flex-1" },
										),
										tray.flex([
											tray.tooltip(
												tray.button("Fetch from TMDB", {
													intent: "white",
													size: "md",
													disabled: !$getUserPreference("tmdb-api")?.length,
													loading: tmdb.isFetching.get(),
													onClick: ctx.eventHandler(`tmdb-fetch-${currentMediaData.id}`, async () => {
														tmdb.setFetching(true);
														try {
															let { tmdbId, tmdbSeason, tmdbEpisode } = await resolveEpisode(currentMediaData.id, currentEpisodeData.episode);

															if (!tmdbId) {
																const search = await tmdb.search(currentMediaData.title, currentMediaData.type);
																if (!search.results.length) throw new Error(`Automatic fetch did not find any metadata. Fill up the overrides and try again.`);
																tmdbId = search.results[0].id;
															}

															if (typeof tmdbSeason !== "number") {
																const details = await tmdb.getDetails(tmdbId, currentMediaData.type);
																if (currentMediaData.type === "movie") {
																	const movie = details as CEM.TMDBMovieDetails;

																	if (movie.title) fieldRefs.data.title.setValue(movie.title);
																	if (movie.runtime) fieldRefs.data.length.setValue(movie.runtime.toString());
																	if (movie.release_date) fieldRefs.data.airDate.setValue(movie.release_date);
																	if (movie.overview) fieldRefs.data.overview.setValue(movie.overview);
																	if (movie.backdrop_path) fieldRefs.data.image.setValue(tmdbImage(movie.backdrop_path));

																	return;
																} else {
																	tmdbSeason = (details as CEM.TMDBTVShowDetails).seasons[0]?.season_number ?? 1;
																}
															}

															if (tmdbEpisode === undefined)
																throw new Error(`Automatic fetch was unable to retrieve the episode number [8001]. Fill up the override and try again.`);

															const season = await tmdb.getSeason(tmdbId, tmdbSeason);
															const episode = season.episodes.find((c) => c.episode_number == tmdbEpisode);

															if (!episode) throw new Error(`Automatic fetch was unable to retrieve the episode number [8002]. Fill up the override and try again.`);

															if (episode.name) fieldRefs.data.title.setValue(episode.name);
															if (episode.runtime) fieldRefs.data.length.setValue(episode.runtime.toString());
															if (episode.air_date) fieldRefs.data.airDate.setValue(episode.air_date);
															if (episode.overview) fieldRefs.data.overview.setValue(episode.overview);
															if (episode.still_path) fieldRefs.data.image.setValue(tmdbImage(episode.still_path));
														} catch (e) {
															log.debug(`${currentMediaData.id}: episode fetch from TMDB failed:`, e);
															ctx.toast.error((e as Error).message);
														} finally {
															tmdb.setFetching(false);
														}
													}),
												}),
												{ text: "TMDB API Key is required for this action." },
											),
											overridesModal(currentMediaData, currentEpisodeData.episode),
											tray.div([], { className: "flex-1" }),
											tray.button("Delete", {
												intent: "alert",
												size: "md",
												disabled: !(Object.values(currentEpisodeData).length - 1),
												onClick: ctx.eventHandler(`del-${currentMediaData.id}`, async () => {
													database.delete(currentMediaData.id, currentEpisodeData.episode);
													await checkAnimap(currentMediaData.id);
													ctx.setTimeout(() => {
														$app.invalidateClientQuery(["ANIME-ENTRIES-get-anime-entry", "ANIME-get-anime-episode-collection"]);
														ctx.toast.success("Successfully removed episode metadata!");
														tray.close();
													}, 500);
												}),
											}),
											tray.button("Save", {
												intent: "primary",
												size: "md",
												onClick: ctx.eventHandler(`save-${currentMediaData.id}`, async () => {
													try {
														fieldRefs.save(currentMediaData.id, currentEpisodeData.episode);
														await checkAnimap(currentMediaData.id);
														ctx.setTimeout(() => {
															$app.invalidateClientQuery(["ANIME-ENTRIES-get-anime-entry", "ANIME-get-anime-episode-collection"]);
															ctx.toast.success("Successfully saved episode metadata!");
															tray.close();
														}, 500);
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
														overridesModal(currentMediaData, null),
														tray.modal({
															trigger: tray.button("Delete All", { intent: "alert", disabled: !customEps.length }),
															title: "Delete all custom metadata?",
															description: `Are you sure you want to delete all custom metadata for ${currentMediaData.title}?`,
															footer: [
																tray.button("Delete", {
																	className: "w-full",
																	intent: "alert",
																	size: "md",
																	onClick: ctx.eventHandler(`cem-del-${currentMediaData.id}`, async () => {
																		Object.values(database.get(currentMediaData.id).data).forEach((cem) => database.delete(currentMediaData.id, cem.episode));
																		await checkAnimap(currentMediaData.id);
																		ctx.setTimeout(() => {
																			ctx.toast.success(`Removed all custom metadata for ${currentMediaData.title}!`);
																			$app.invalidateClientQuery(["ANIME-ENTRIES-get-anime-entry", "ANIME-get-anime-episode-collection"]);
																			tray.close();
																		}, 500);
																	}),
																}),
															],
														}),
													],
													{ className: "items-center" },
												),
												tray.text(matchStatus(currentMediaData.id), {
													className: "text-sm text-orange-400 bg-orange-800 border border-orange-500 rounded-xl p-2 bg-opacity-50 break-normal",
													style: {
														display: thumbnails.get(currentMediaData.id)?.status === "failed" && !thumbnails.get(currentMediaData.id)?.needsVisit && wantsMatch(currentMediaData.id) ? "block" : "none",
													},
												}),
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
																				await checkAnimap(currentMediaData.id);
																				ctx.setTimeout(() => {
																					ctx.toast.success(`Removed custom metadata for episode "${cem.episode}"!`);
																					$app.invalidateClientQuery(["ANIME-ENTRIES-get-anime-entry", "ANIME-get-anime-episode-collection"]);
																					tray.close();
																				}, 500);
																			}),
																		}),
																	],
																	{ className: "justify-center items-center" },
																),
															),
													],
													{ className: "space-y-2" },
												),
												tray.text(`There are no custom episode metadata for this entry.`, {
													className: "font-semibold text-[--muted] text-center",
													style: { display: customEps.length ? "none" : "block" },
												}),
											],
											{ className: "space-y-2 p-2 border rounded-xl bg-gray-800 overflow-scroll", style: { height: "24rem" } },
										),
									]),
						],
						{ className: "p-2 space-y-2 h-full" },
					),
				]);
			}
		});

		tray.onClose(() => currEditedEp.set(null));

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
				const mediaOverride = tmdb.overrides.get(episode.baseAnime.id);
				const episodeOverride = mediaOverride.episodeOverrides.find((e) => e.aniDBEpisode == aniDBEpisode);
				currEditedEp.set(customEpisodeMetadata);

				if (mediaOverride) tmdb.overrides.media.fill(mediaOverride);
				if (episodeOverride) tmdb.overrides.episode.fill(episodeOverride);
				ctx.setTimeout(() => tray.open(), 500);
			});
		});

		ctx.effect(() => {
			const currEditedEpData = currEditedEp.get();
			!currEditedEpData ? fieldRefs.reset() : fieldRefs.fill(currEditedEpData);
		}, [currEditedEp]);

		// Episodes Seanime shows: aired episodes for airing shows, the total otherwise.
		function episodeCount(media: $app.AL_BaseAnime | undefined) {
			if (media?.nextAiringEpisode?.episode) return Math.max(0, media.nextAiringEpisode.episode - 1);
			return media?.episodes ?? 0;
		}

		/** Keep a generated episode list (Animap has no entry) in step with newly aired episodes. True when it changed. */
		function syncEpisodeCount(mediaId: number, media: $app.AL_BaseAnime | undefined) {
			const status = animap.get(mediaId);
			const count = episodeCount(media);
			if (!media || !status?.fallback || status.episodeCount === count) return false;
			log.step(`${mediaId}: generated episode list ${status.episodeCount} -> ${count} episodes`);
			animap.set(mediaId, { ...status, fallback: true, episodeCount: count });
			return true;
		}

		// Runs when custom metadata is saved or deleted by hand, and weekly for an anime Animap had no entry for. Asks
		// Seanime for the metadata with our fallback switched off, so any Animap remap (e.g. Custom Anime Metadata's
		// AniDB/AniList ID) is honoured, and remembers whether the hook needs to supply the episode list.
		async function checkAnimap(mediaId: number) {
			const previous = animap.get(mediaId);
			const anidbId = previous?.anidbId; // ani.zip's answer doesn't change with the re-check
			// When Animap was first found to have no entry; a re-check that finds the same keeps it
			const since = previous?.fallback ? previous.since ?? Date.now() : Date.now();
			animap.set(mediaId, null);
			clearMetadataCache();
			if (mediaId >= 0x80000000) return; // custom sources provide their own metadata

			let fallback = false;
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

			let count = 0;
			try {
				count = episodeCount((await ctx.anime.getAnimeEntry(mediaId)).media);
			} catch {}
			animap.set(mediaId, { fallback: true, episodeCount: count, checkedAt: Date.now(), since, ...(anidbId !== undefined ? { anidbId } : {}) });
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

		type Mapping = Omit<CEM.ThumbnailRecord, "mediaId" | "images" | "active" | "refreshedAt" | "lastSeenAt"> & {
			movie?: CEM.TMDBMovieDetails;
			/** Air-date match only: the (season, offset) runs, in AniDB episode order. */
			segments?: { season: number; offset: number; from: number }[];
			/** Failed for want of a TMDB ID, so a title search may help. */
			noId?: boolean;
		};
		type RefreshResult = { record?: CEM.ThumbnailRecord; saved: number; missing: string[] };
		type TMDBEpisode = CEM.TMDBSeasonResults["episodes"][number];

		const isOn = (name: "tmdb-thumbnails" | "tmdb-auto-refresh" | "tmdb-fill-missing") => $getUserPreference(name) === "true";
		/** On unless switched off (also when the setting doesn't exist yet). */
		const anidbLookup = () => $getUserPreference("anidb-lookup") !== "false";
		const hasCustom = (mediaId: number) => Object.keys(database.get(mediaId).data).length > 0;
		/** Whether the automatic refresh writes TMDB data into this anime's custom metadata (all of it, unless excluded). */
		const autoWrites = (mediaId: number) => isOn("tmdb-auto-refresh") && hasCustom(mediaId) && !tmdb.overrides.get(mediaId).excludeAuto;
		/** Seanime has no metadata for this anime and TMDB should fill it in. */
		const fillsMissing = (mediaId: number) => isOn("tmdb-fill-missing") && !!animap.get(mediaId)?.fallback;
		/** Whether this anime needs a TMDB match at all. */
		const wantsMatch = (mediaId: number) => isOn("tmdb-thumbnails") || autoWrites(mediaId) || fillsMissing(mediaId);

		/**
		 * How much work an anime gets: "page" when its entry page is open or the user acts on it (everything, at once),
		 * "background" for anime being watched (everything, AniList relation lookups spaced out), "own" for the rest
		 * under "Everything" (its own IDs and a title search, no relation lookups), or nothing at all.
		 */
		type Scope = "page" | "background" | "own";
		let watching: { ids: number[] | null; at: number } = { ids: null, at: 0 };
		/**
		 * The anime on the user's list as Watching or Rewatching: the ones Continue Watching shows. Read from Seanime's
		 * cached list (AniList, or the local list when not logged in) at most every 5 minutes. null: no list loaded.
		 */
		function watchingIds(): number[] | null {
			const now = Date.now();
			if (now - watching.at < 5 * 60 * 1000) return watching.ids;
			let ids: number[] | null = null;
			try {
				const lists = $anilist.getAnimeCollection(false)?.MediaListCollection?.lists;
				if (lists) {
					ids = [];
					for (const list of lists)
						for (const entry of list?.entries ?? []) {
							const status = `${entry?.status ?? ""}`;
							const id = entry?.media?.id;
							if (id && (status === "CURRENT" || status === "REPEATING") && ids.indexOf(id) === -1) ids.push(id);
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
			watching = { ids, at: ids === null ? now - 5 * 60 * 1000 + 30 * 1000 : now };
			return ids;
		}
		/** The background scope of an anime Seanime loaded, or undefined when it's left for its entry page. */
		function backgroundScope(mediaId: number): Scope | undefined {
			const ids = watchingIds();
			// No list (not loaded yet): as before this setting existed
			if (ids === null || ids.indexOf(mediaId) !== -1) return "background";
			return $getUserPreference("background-matching") === "all" ? "own" : undefined;
		}
		const tmdbImage = $shared.use<(path: string) => string>("tmdbImage");
		// Clear the width cache an earlier version kept
		if ($storage.get("TMDB_IMAGE_WIDTHS_V1") !== undefined) $storage.remove("TMDB_IMAGE_WIDTHS_V1");
		/**
		 * Seanime keeps the metadata it built in memory for up to an hour, with the stills, fill-in data and AniDB IDs
		 * baked in, so switching a setting showed nothing until a restart. Changing a setting reloads the plugin: when a
		 * setting that changes what the hooks add differs from the last applied one, have Seanime rebuild its metadata
		 * once. The plugin's own TMDB and AniDB data on disk is kept, so nothing is fetched from TMDB again.
		 */
		const displaySettings = JSON.stringify({
			size: stillImageSize ?? "w300",
			thumbnails: $getUserPreference("tmdb-thumbnails") === "true",
			fill: $getUserPreference("tmdb-fill-missing") === "true",
			anidb: $getUserPreference("anidb-lookup") !== "false",
		});
		const appliedSettings = $storage.get<string>("CEM_APPLIED_SETTINGS");
		if (appliedSettings !== displaySettings) {
			$storage.set("CEM_APPLIED_SETTINGS", displaySettings);
			// The first run after an update only knew the image size; don't rebuild for that alone
			const firstRun = appliedSettings === undefined;
			if ($storage.get("TMDB_IMAGE_SIZE_APPLIED") !== undefined) $storage.remove("TMDB_IMAGE_SIZE_APPLIED");
			if (!firstRun) {
				// After the plugin finished loading (the rebuild helper and the web page's queries are ready)
				ctx.setTimeout(() => {
					log.mark("Settings changed");
					log.info(`Settings changed, rebuilding Seanime's episode data (${displaySettings})`);
					scheduleRebuild(true);
				}, 1000);
			}
		}
		log.step(`Settings: ${displaySettings}, background matching: ${$getUserPreference("background-matching") ?? "watching"}`);
		if (!tmdb.API_KEY?.length && (isOn("tmdb-thumbnails") || isOn("tmdb-fill-missing") || isOn("tmdb-auto-refresh") || anidbLookup()))
			log.warn("No TMDB API key is set: TMDB stills, fill-in, the automatic refresh and the AniDB lookup stay off until one is entered in the plugin settings");
		const sleep = (ms: number) => new Promise<void>((resolve) => ctx.setTimeout(() => resolve(), ms));
		/** "YYYY-MM-DD" as a day number, so dates compare without timezone trouble. */
		const toDay = (date: string | undefined) => {
			const m = (date ?? "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
			return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : NaN;
		};

		function isDue(record: CEM.ThumbnailRecord | undefined, now: number) {
			if (!record) return true;
			if (record.nextCheckAt) return now >= record.nextCheckAt;
			const age = now - record.refreshedAt;
			if (record.status === "failed") return age >= DAY;
			return age >= (record.active ? 3 * HOUR : 7 * DAY);
		}

		/** TMDB requests for one refresh. Seasons are fetched once each. */
		function tmdbSession() {
			const seasons: Record<string, Promise<CEM.TMDBSeasonResults>> = {};
			const season = (tmdbId: number, n: number) => {
				const key = `${tmdbId}:${n}`;
				if (!seasons[key]) seasons[key] = tmdb.getSeason(tmdbId, n);
				return seasons[key];
			};
			/** Fetch the seasons not cached yet in one batched request. Any the batch misses fall back to season(). */
			const prefetch = async (tmdbId: number, ns: number[]) => {
				const wanted = ns.filter((n, i) => ns.indexOf(n) === i && !seasons[`${tmdbId}:${n}`]);
				if (wanted.length < 2) return;
				try {
					const found = await tmdb.getSeasons(tmdbId, wanted);
					for (const n of wanted) if (found[n]) seasons[`${tmdbId}:${n}`] = Promise.resolve(found[n]);
				} catch {
					// season() fetches them one at a time instead
				}
			};
			const episode = async (target: CEM.TMDBTarget): Promise<TMDBEpisode | undefined> => {
				if (target.season === undefined || target.episode === undefined) return undefined;
				try {
					return (await season(target.tmdbId, target.season)).episodes.find((e) => e.episode_number === target.episode);
				} catch {
					return undefined;
				}
			};
			return { season, prefetch, episode };
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

		/** Where one episode points on TMDB, including season lists (which need the seasons' episode counts). */
		async function resolveEpisode(mediaId: number, key: string) {
			const target = tmdb.overrides.resolve(mediaId, key);
			const media = tmdb.overrides.get(mediaId);
			const own = media.episodeOverrides.find((e) => e.aniDBEpisode === key);
			if (!media.tmdbSeasons || media.tmdbSeasons.length < 2 || typeof own?.tmdbSeason === "number" || !target.tmdbId || target.tmdbEpisode === undefined) return target;
			const session = tmdbSession();
			await session.prefetch(target.tmdbId, media.tmdbSeasons);
			const hit = (await seasonRun(session, target.tmdbId, media.tmdbSeasons))[target.tmdbEpisode - 1];
			return { tmdbId: target.tmdbId, tmdbSeason: hit?.season, tmdbEpisode: hit?.episode };
		}

		/** Work out where every episode of an anime lives on TMDB. Throws on request errors. */
		async function buildMapping(
			mediaId: number,
			media: $app.AL_BaseAnime | undefined,
			metadata: $app.Metadata_AnimeMetadata | undefined,
			session: ReturnType<typeof tmdbSession>,
			override: CEM.TMDBOverrides,
		): Promise<Mapping> {
			const fail = (reason: string): Mapping => ({ status: "failed", reason, map: {} });
			const episodes = metadata?.episodes ?? {};
			const mainKeys = Object.keys(episodes).filter((k) => /^\d+$/.test(k));
			const highest = Math.max(0, ...mainKeys.map(Number));
			/**
			 * The last AniDB episode to take from a TMDB season, including ones that haven't aired yet. Past it the TMDB
			 * season belongs to another AniList entry (e.g. the next cour). AniList's episode total decides when it's
			 * known; otherwise the first episode TMDB marks as a (mid-)season finale, else everything TMDB lists.
			 */
			const limitFor = (seasonEpisodes: TMDBEpisode[], offset: number) => {
				if (media?.episodes) return Math.max(highest, media.episodes);
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
				const order: ("tv" | "movie")[] = media?.format?.valueOf() === "MOVIE" ? ["movie", "tv"] : ["tv", "movie"];
				let error: unknown;
				for (const type of order) {
					try {
						details = await tmdb.getDetails(tmdbId, type);
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
				return { status: "matched", source: override.tmdbId ? "override" : "auto", tmdbType, tmdbId, map: { "1": { tmdbId } }, movie: details as CEM.TMDBMovieDetails };
			}

			const map: Record<string, CEM.TMDBTarget> = {};

			// The media override decides everything, with the episode overrides on top. Several seasons are read as one run
			// of episodes: the offset counts across all of them and season 2 picks up where season 1 ends.
			if (typeof override.tmdbSeason === "number") {
				const offset = override.tmdbOffset ?? 0;
				const seasons = override.tmdbSeasons?.length ? override.tmdbSeasons : [override.tmdbSeason];
				const multi = seasons.length > 1;
				await session.prefetch(tmdbId, [
					...seasons,
					...override.episodeOverrides.filter((o) => (o.tmdbId ?? tmdbId) === tmdbId && typeof o.tmdbSeason === "number").map((o) => o.tmdbSeason as number),
				]);
				const run = await seasonRun(session, tmdbId, seasons);
				// Position in the run: the TMDB episode number for one season, the running count for several
				const numbered = run.map((r, i) => ({ ...r.ep, episode_number: multi ? i + 1 : r.episode }));
				const limit = limitFor(numbered, offset);
				const keys = mainKeys.slice();
				for (const ep of numbered) {
					const n = ep.episode_number - offset;
					if (n >= 1 && n <= limit) keys.push(`${n}`);
				}
				for (const ep of override.episodeOverrides) if (ep.aniDBEpisode) keys.push(ep.aniDBEpisode);

				for (const key of keys) {
					const o = override.episodeOverrides.find((e) => e.aniDBEpisode === key) ?? {};
					const id: number = o.tmdbId ?? tmdbId;
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
				return { status: "matched", source: "override", tmdbType, tmdbId, map, fallback: { season: seasons[0], offset, ...(multi ? { seasons } : {}) } };
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

			const first = Math.min(...dated.map((d) => d.day));
			const last = Math.max(...dated.map((d) => d.day));
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
			for (const n of wanted) {
				for (const ep of (await session.season(tmdbId, n)).episodes) {
					const day = toDay(ep.air_date);
					if (!isNaN(day)) candidates.push({ season: n, episode: ep.episode_number, day });
				}
			}

			// Every dated episode votes for the (season, offset) pairs that line its date up with a TMDB episode.
			// Take the strongest pair, then repeat for what's left, so an entry spanning two TMDB seasons still maps.
			let remaining = dated;
			const segments: { season: number; offset: number; from: number }[] = [];
			const minVotes = dated.length === 1 ? 1 : 2;
			while (remaining.length) {
				const score: Record<string, number> = {};
				const votes: Record<string, number> = {};
				const voted: Record<number, Record<string, boolean>> = {};
				for (const d of remaining) {
					const best: Record<string, number> = {};
					for (const c of candidates) {
						const diff = Math.abs(c.day - d.day);
						if (diff > 1) continue;
						const key = `${c.season}:${c.episode - d.n}`;
						best[key] = Math.max(best[key] ?? 0, diff === 0 ? 2 : 1);
					}
					voted[d.n] = {};
					for (const key of Object.keys(best)) {
						score[key] = (score[key] ?? 0) + best[key];
						votes[key] = (votes[key] ?? 0) + 1;
						voted[d.n][key] = true;
					}
				}
				// Highest score; on a tie prefer a regular season over specials, then the smaller offset
				const ranked = Object.keys(score).sort((a, b) => {
					const [sa, oa] = a.split(":").map(Number);
					const [sb, ob] = b.split(":").map(Number);
					return score[b] - score[a] || (sa === 0 ? 1 : 0) - (sb === 0 ? 1 : 0) || Math.abs(oa) - Math.abs(ob) || sa - sb;
				});
				const pick = ranked[0];
				if (!pick || votes[pick] < minVotes) break;

				const [season, offset] = pick.split(":").map(Number);
				const taken = remaining.filter((d) => voted[d.n][pick]);
				for (const d of taken) map[`${d.n}`] = { tmdbId, season, episode: d.n + offset };
				segments.push({ season, offset, from: Math.min(...taken.map((d) => d.n)) });
				remaining = remaining.filter((d) => !voted[d.n][pick]);
			}

			const matched = dated.length - remaining.length;
			if (!segments.length || matched * 2 < dated.length) {
				return { ...fail(`Only ${matched} of ${dated.length} episodes matched TMDB ${tmdbId} by air date. Set the TMDB Season and Offset in Overrides.`), tmdbId };
			}

			// Undated, unaired or unmatched episodes follow the segment they sit in
			segments.sort((a, b) => a.from - b.from);
			const segmentFor = (n: number) => segments.filter((s) => s.from <= n).pop() ?? segments[0];
			for (const key of mainKeys) {
				if (map[key]) continue;
				const s = segmentFor(Number(key));
				if (Number(key) + s.offset >= 1) map[key] = { tmdbId, season: s.season, episode: Number(key) + s.offset };
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

			// Episode overrides always win
			for (const o of override.episodeOverrides) {
				if (!o.aniDBEpisode) continue;
				const base = map[o.aniDBEpisode];
				const number = o.aniDBEpisode.match(/\d+/);
				const season = o.tmdbSeason ?? base?.season;
				const episode = o.tmdbEpisode ?? base?.episode ?? (number ? parseInt(number[0], 10) : undefined);
				if (season !== undefined && episode !== undefined) map[o.aniDBEpisode] = { tmdbId: o.tmdbId ?? tmdbId, season, episode };
			}

			return { status: "matched", source: "auto", tmdbType, tmdbId, map, fallback: { season: fallback.season, offset: fallback.offset }, segments };
		}

		const inFlight: Record<number, { job: Promise<RefreshResult>; scope: Scope }> = {};

		/**
		 * Rematch one anime, store its stills and, when asked, write the TMDB data into its custom metadata
		 * (what Bulk Update does). A forced call waits for a refresh already running instead of reusing it. The scope
		 * says whether related anime may be looked up (see Scope); the user's own actions use "page". A running refresh
		 * that couldn't look them up ("own") doesn't answer a call that may: if it ends up needing them, it runs again.
		 */
		async function refreshAnime(mediaId: number, writeMetadata: boolean, force = false, scope: Scope = "page"): Promise<RefreshResult> {
			const running = inFlight[mediaId];
			if (running) {
				const narrower = running.scope === "own" && scope !== "own";
				if (!force && !narrower) {
					log.step(`${mediaId}: joining the refresh already running`);
					return running.job;
				}
				const done = await running.job.catch(() => undefined);
				if (!force && done && !done.record?.needsVisit) return done;
				log.step(`${mediaId}: refreshing again after the running refresh (${force ? "forced" : "related anime needed"})`);
			}
			const job = doRefresh(mediaId, writeMetadata, force, scope);
			inFlight[mediaId] = { job, scope };
			try {
				return await job;
			} finally {
				if (inFlight[mediaId]?.job === job) delete inFlight[mediaId];
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
			let needsVisit = false;
			try {
				mapping = await buildMapping(mediaId, media, metadata, session, override);
				mapping.idFrom = override.tmdbId ? "your override" : "Animap";
				// No ID from the override or Animap: search TMDB by title, each hit checked against the air dates. Only
				// air dates from Animap make that check strong, so anime without them need the fill-in setting.
				const dated = Object.keys(metadata?.episodes ?? {}).some((k) => !!metadata?.episodes?.[k]?.airDate);
				if (mapping.status === "failed" && !override.tmdbId) {
					const custom = mediaId >= 0x80000000; // custom sources have no mappings, the title is all there is
					const { found, firstValid, skippedRelations } = await searchTmdb(
						mediaId, media, metadata, session, undefined, dated || custom || fillsMissing(mediaId), mapping.tmdbId ? [mapping.tmdbId] : [], scope,
					);
					if (found) {
						const again = await buildMapping(mediaId, media, metadata, session, { ...override, tmdbId: found.id });
						mapping = { ...(again.status === "matched" ? again : found.mapping), source: "auto", idFrom: found.from };
					} else if (mapping.noId && firstValid) {
						// Say what was found and why it didn't fit, not just that Animap had nothing
						mapping = { ...mapping, reason: `TMDB ${firstValid.id} (from ${firstValid.from}) didn't line up: ${firstValid.reason ?? "no match"}` };
					}
					// Its related anime weren't checked (not on the watching list): that waits for its page, not a warning
					if (!found && skippedRelations) {
						needsVisit = true;
						mapping = { ...mapping, reason: "Its own IDs and a title search found nothing; its related anime are checked when you open its page." };
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
			if (mapping.movie) {
				if (mapping.movie.backdrop_path?.length) images["1"] = mapping.movie.backdrop_path;
			} else {
				for (const [key, target] of Object.entries(mapping.map)) {
					const episode = await session.episode(target);
					if (!episode) continue;
					found[key] = episode;
					if (episode.still_path?.length) images[key] = episode.still_path;
				}
			}

			// Seanime has no metadata for this anime: keep TMDB's episode data in the background to fill it in
			let episodes: CEM.ThumbnailRecord["episodes"];
			if (fillsMissing(mediaId) && mapping.status === "matched") {
				episodes = {};
				const movie = mapping.movie;
				if (movie) {
					episodes["1"] = { title: movie.title, overview: movie.overview, airDate: movie.release_date, length: movie.runtime ?? undefined };
				} else {
					for (const [key, ep] of Object.entries(found)) {
						episodes[key] = { title: ep.name, overview: ep.overview, airDate: ep.air_date, length: ep.runtime ?? undefined };
					}
				}
			}

			// Next refresh: a few hours after the next episode airs (when TMDB has usually listed it), daily while a
			// recent episode still has no still, weekly otherwise
			const today = Math.floor(now / DAY);
			const recentWithoutStill = Object.entries(metadata?.episodes ?? {}).some(([key, ep]) => {
				const day = toDay(ep.airDate);
				return /^\d+$/.test(key) && !isNaN(day) && day <= today && today - day <= 30 && !images[key];
			});
			let nextCheckAt = now + (mapping.status === "failed" ? DAY : 7 * DAY);
			const airingAt = media?.nextAiringEpisode?.airingAt;
			if (airingAt) nextCheckAt = Math.min(nextCheckAt, Math.max(now + HOUR, airingAt * 1000 + 6 * HOUR));
			else if (media?.nextAiringEpisode) nextCheckAt = Math.min(nextCheckAt, now + DAY);
			if (recentWithoutStill) nextCheckAt = Math.min(nextCheckAt, now + DAY);

			const { movie, segments, noId, ...stored } = mapping;
			const record: CEM.ThumbnailRecord = {
				mediaId,
				...stored,
				images,
				...(episodes ? { episodes } : {}),
				active: !!media?.nextAiringEpisode || recentWithoutStill,
				...(needsVisit ? { needsVisit } : {}),
				nextCheckAt,
				refreshedAt: now,
				lastSeenAt: old?.lastSeenAt ?? now,
			};
			thumbnails.set(mediaId, record);
			result.record = record;

			if (writeMetadata && record.status === "matched") {
				if (movie) {
					const update: CEM.CustomEpisodeMetadata = { episode: "1" };
					if (movie.title?.length) update.title = movie.title;
					if (typeof movie.runtime === "number") update.length = movie.runtime;
					if (movie.release_date?.length) update.airDate = movie.release_date;
					if (movie.overview?.length) update.overview = movie.overview;
					if (images["1"]) update.image = tmdbImage(images["1"]);
					database.save(mediaId, update);
					result.saved++;
				} else {
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
			}

			const shown = (r: CEM.ThumbnailRecord | undefined) => (r?.status === "matched" ? stableJson([r.images, r.episodes ?? {}]) : "");
			const imagesChanged = (isOn("tmdb-thumbnails") || fillsMissing(mediaId)) && (flagged || shown(old) !== shown(record));
			// Whether Seanime has metadata for it doesn't change with what was written. Not known yet: the metadata loaded
			// above already answers it (without a status the hook didn't supply it), so there's no need to clear Seanime's
			// cache and ask Animap again. Custom sources provide their own metadata and get no status.
			if (result.saved && metadata && !animap.get(mediaId) && mediaId < 0x80000000) animap.set(mediaId, { fallback: false, episodeCount: 0, checkedAt: now });
			if (result.saved || imagesChanged) scheduleRebuild(imagesChanged, mediaId);

			const name = media?.title?.userPreferred ?? `${mediaId}`;
			if (record.needsVisit) log.step(`${name} (${mediaId}): not matched yet: ${record.reason}`);
			else if (record.status === "failed") {
				if (old?.status !== "failed" || old.reason !== record.reason) log.warn(`${name} (${mediaId}): match failed: ${record.reason}`);
				else log.step(`${name} (${mediaId}): still failing: ${record.reason}`);
			} else {
				const where = record.tmdbType === "movie" ? "movie" : `S${record.fallback?.season ?? "?"}${record.fallback?.offset ? ` offset ${record.fallback.offset}` : ""}`;
				const line = `${name} (${mediaId}): TMDB ${record.tmdbId} ${where}, ID from ${record.idFrom ?? "?"}, ${Object.keys(images).length} stills${result.saved ? `, ${result.saved} episodes written` : ""}`;
				if (imagesChanged || result.saved || old?.tmdbId !== record.tmdbId) log.info(line);
				else log.step(`${line} (unchanged)`);
			}
			const why = mapping.status === "failed" ? "failed, daily" : airingAt ? "6 hours after the next episode airs" : media?.nextAiringEpisode ? "airing, daily" : recentWithoutStill ? "a recent episode has no still yet, daily" : "finished, weekly";
			log.step(`${name} (${mediaId}): next refresh ${new Date(record.nextCheckAt ?? 0).toISOString()} (${why})`);
			if ($debug.enabled) {
				const { episodes: _filled, ...shown } = record;
				log.inspect(`${mediaId}: stored TMDB record`, shown);
			}

			updateBadge();
			return result;
		}

		/** Warning badge on the tray while the anime being viewed couldn't be matched. */
		function updateBadge() {
			const media = currentMedia.get();
			const record = media ? thumbnails.get(media.id) : undefined;
			// "Needs a page visit" isn't a failure: opening the page resolves it
			const failed = !!media && record?.status === "failed" && !record.needsVisit && wantsMatch(media.id);
			tray.updateBadge({ number: failed ? 1 : 0, intent: "warning" });
		}

		/** One line describing how the anime is matched on TMDB. */
		function matchStatus(mediaId: number) {
			const record = thumbnails.get(mediaId);
			if (!record) return wantsMatch(mediaId) ? "TMDB match: not matched yet." : "TMDB match: thumbnails and automatic refresh are off.";
			if (record.needsVisit) return "TMDB match: not found from its own IDs yet; checking its related anime now that its page is open.";
			if (record.status === "failed") return `TMDB match failed: ${record.reason ?? "unknown error"}`;
			const via = record.source === "override" ? "from the overrides" : `by air date, ID from ${record.idFrom ?? "Animap"}`;
			if (record.tmdbType === "movie") return `TMDB match: movie ${record.tmdbId}, ${via}.`;
			const offset = record.fallback?.offset ?? 0;
			const seasonText = record.fallback?.seasons ? `seasons ${formatSeasons(record.fallback.seasons)}` : `season ${record.fallback?.season}`;
			const where = record.fallback ? `, ${seasonText}${offset ? `, offset ${offset > 0 ? "+" : ""}${offset}` : ""}` : "";
			return `TMDB match: show ${record.tmdbId}${where}, ${via}. ${Object.keys(record.images).length} stills.`;
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
			const result = await refreshAnime(mediaId, autoWrites(mediaId), true);
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
			refreshAnime(mediaId, autoWrites(mediaId), true)
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

		/** The relation steps on disk, read once (only this context uses them) and written through. */
		let relationCache: Record<number, CEM.RelationStep> | undefined;
		const relationSteps = () => (relationCache = relationCache ?? $storage.get<Record<number, CEM.RelationStep>>(RELATIONS_KEY) ?? {});
		/**
		 * One step up from an anime: its parent, else its prequel. Cached on disk for 30 days, so sequels sharing a
		 * prequel and repeat visits don't ask AniList again. $anilist.getAnimeDetails blocks this whole context until
		 * AniList answers, so in the background the calls are spaced out. undefined: AniList couldn't be asked.
		 */
		/** Whether AniList is already known (cached) to list no parent or prequel: a page visit couldn't find more. */
		const knownWithoutRelations = (mediaId: number) => {
			const hit = relationSteps()[mediaId];
			return !!hit && hit.next === null && Date.now() - hit.at < 30 * DAY;
		};
		async function relationStep(mediaId: number, scope: Scope): Promise<CEM.RelationStep["next"] | undefined> {
			const hit = relationSteps()[mediaId];
			if (hit && Date.now() - hit.at < 30 * DAY) {
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
				? { id: edge.node.id, title: edge.node.title?.userPreferred ?? `${edge.node.id}`, relation: edge.relationType!.valueOf().toLowerCase() }
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
		async function relatedAnime(mediaId: number, scope: Scope): Promise<{ id: number; title: string; relation: string }[]> {
			if (mediaId >= 0x80000000) return [];
			const out: { id: number; title: string; relation: string }[] = [];
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
			const ids: { id: number; from: string }[] = [];
			const add = (id: number | undefined, from: string) => {
				if (id && !ids.some((x) => x.id === id)) ids.push({ id, from });
			};
			if (metadata === undefined && mediaId < 0x80000000) {
				try {
					metadata = await loadMetadata(mediaId);
				} catch {}
			}
			add(Number((metadata?.mappings?.themoviedbId ?? "").replace(/\D/g, "")) || undefined, "Animap");
			if (mediaId < 0x80000000) {
				add((await anizip(mediaId)).tmdbId, "ani.zip");
				if (!ids.length) add((await animeapi(mediaId)).tmdbId, "AnimeAPI");
			}
			return ids;
		}

		/**
		 * Find the anime on TMDB: the given ID only; else Animap's, ani.zip's or AnimeAPI's; else its parent's or a
		 * prequel's; else a TMDB title search. A candidate counts only
		 * when its air dates line up (see buildMapping), so a wrong first search result is skipped.
		 */
		/** Whether TMDB has any still (or a movie backdrop) for a mapping's episodes. Seasons are already cached. */
		async function hasStills(mapping: Awaited<ReturnType<typeof buildMapping>>, session: ReturnType<typeof tmdbSession>) {
			if (mapping.movie) return !!mapping.movie.backdrop_path?.length;
			for (const target of Object.values(mapping.map)) if ((await session.episode(target))?.still_path?.length) return true;
			return false;
		}

		async function searchTmdb(
			mediaId: number,
			media: $app.AL_BaseAnime | undefined,
			metadata: $app.Metadata_AnimeMetadata | undefined,
			session: ReturnType<typeof tmdbSession>,
			only?: { id: number; from: string },
			titleSearch = true,
			skip: number[] = [],
			scope: Scope = "page",
		): Promise<{ found?: { id: number; from: string; mapping: Mapping }; firstValid?: { id: number; from: string; reason?: string }; skippedRelations?: boolean }> {
			const tried: number[] = [];
			let firstValid: { id: number; from: string; reason?: string } | undefined;
			const attempt = async (id: number, from: string) => {
				if (tried.indexOf(id) !== -1) return undefined;
				tried.push(id);
				try {
					const mapping = await buildMapping(mediaId, media, metadata, session, { mediaId, tmdbId: id, episodeOverrides: [] });
					log.debug(`${mediaId}: TMDB ${id} from ${from}: ${mapping.status}${mapping.reason ? ` (${mapping.reason})` : ""}`);
					if (!firstValid) firstValid = { id, from, reason: mapping.reason };
					return mapping.status === "matched" ? { id, from, mapping } : undefined;
				} catch {
					return undefined; // not a TMDB entry of either type
				}
			};

			if (only) return { found: await attempt(only.id, only.from), firstValid };
			for (const id of skip) tried.push(id);

			// This anime's own mappings, then its parent's and prequels' (checked against this anime's air dates)
			let found: Awaited<ReturnType<typeof attempt>>;
			for (const candidate of await knownIds(mediaId, metadata)) {
				found = await attempt(candidate.id, candidate.from);
				if (found) return { found, firstValid };
			}
			// Related anime need AniList (one blocking request per uncached step): not for anime outside the watching
			// list in the background, which are checked when their page is opened instead
			const related = scope === "own" ? [] : await relatedAnime(mediaId, scope);
			if (scope === "own") log.step(`${mediaId}: related anime not checked in the background (not on the watching list)`);
			for (const r of related) {
				// The TMDB ID the user or the plugin already settled on for the related anime (e.g. found by a title
				// search), then the ID databases' entries for it
				const own = thumbnails.get(r.id);
				const settled = [
					{ id: tmdb.overrides.get(r.id).tmdbId, from: "its override" },
					{ id: own?.status === "matched" ? own.tmdbId : undefined, from: "its TMDB match" },
				].filter((c): c is { id: number; from: string } => !!c.id);
				for (const candidate of settled.concat(await knownIds(r.id))) {
					found = await attempt(candidate.id, `${r.relation} "${r.title}" (${candidate.from})`);
					if (found) return { found, firstValid };
				}
			}
			if (!titleSearch) return { found, firstValid };
			const type = media?.format?.valueOf() === "MOVIE" ? "movie" : "tv";
			// This anime's titles, then the related anime's: sequels and OVAs are often episodes of the first entry's show
			const titles: { title: string; from: string }[] = [];
			for (const t of [media?.title?.english, media?.title?.romaji, media?.title?.userPreferred]) if (t) titles.push({ title: t, from: `a TMDB search for "${t}"` });
			for (const r of related) titles.push({ title: r.title, from: `a TMDB search for ${r.relation} "${r.title}"` });
			const searched: string[] = [];
			for (const { title, from } of titles) {
				if (found) break;
				if (searched.indexOf(title) !== -1) continue;
				searched.push(title);
				let results: CEM.TMDBSearchResults["results"] = [];
				try {
					results = (await tmdb.search(title, type)).results;
				} catch {}
				// TMDB often has duplicate entries. Of the top 3 that match, take one with stills, and of those the oldest
				// entry: TMDB IDs are assigned in order (its API doesn't say when an entry was created), so try the lowest
				// ID first and stop at the first match with stills.
				let bare: Awaited<ReturnType<typeof attempt>>;
				for (const result of results.slice(0, 3).sort((a, b) => a.id - b.id)) {
					const hit = await attempt(result.id, from);
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
			return { found, firstValid, skippedRelations: !found && scope === "own" && mediaId < 0x80000000 && !knownWithoutRelations(mediaId) };
		}

		// ---------------------------------------------------------------------------------------------------------
		// AniDB IDs for anime Seanime has no metadata for (mostly 18+ entries Animap doesn't know). Without one, Seanime
		// shows "Episode metadata retrieval not available" and AnimeTosho can't search by AniDB. A found ID is only used
		// when this anime's own main episodes line up by air date with that AniDB entry's main episodes; never an ID
		// borrowed from a parent or prequel.
		// ---------------------------------------------------------------------------------------------------------

		const RELATIONS_KEY = "ANILIST_RELATIONS_V1";
		const anidbStore = $shared.use<{ all: () => Record<number, CEM.AnidbMatch>; get: (id: number) => CEM.AnidbMatch | undefined; set: (id: number, m: CEM.AnidbMatch | null) => void }>("anidb");
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
				const episodeRe = /<episode\s+id="(\d+)"[^>]*>([\s\S]*?)<\/episode>/g;
				let m: RegExpExecArray | null;
				while ((m = episodeRe.exec(xml))) {
					const epno = m[2].match(/<epno\s+type="(\d+)">\s*([^<]*?)\s*<\/epno>/);
					if (!epno || epno[1] !== "1" || !/^\d+$/.test(epno[2])) continue; // type 1: main episodes
					const airDate = (m[2].match(/<airdate>([^<]+)<\/airdate>/) ?? [])[1];
					const length = Number((m[2].match(/<length>(\d+)<\/length>/) ?? [])[1]) || 0;
					main.push({ n: Number(epno[2]), eid: Number(m[1]), ...(airDate ? { airDate } : {}), ...(length ? { length } : {}) });
				}
				main.sort((a, b) => a.n - b.n);
				anime = { aid, episodeCount: Number((xml.match(/<episodecount>(\d+)<\/episodecount>/) ?? [])[1] ?? 0), main };
			} else if (!/not found/i.test(xml)) {
				log.warn(`AniDB ${aid}: unexpected answer from proxy.ani.zip`, xml.slice(0, 200));
				return undefined; // an error like a ban or maintenance: don't remember it
			}
			log.debug(`AniDB ${aid}: ${anime ? `${anime.main.length} main episodes` : "not found"}`);
			cache[aid] = { at: Date.now(), ...(anime ? { anime } : {}) };
			$storage.set(ANIDB_EPISODES_KEY, cache);
			return anime ?? null;
		}

		/** Air dates known for this anime's episodes: Seanime's metadata, TMDB fill-in data, custom metadata, AniList. */
		function airDatePoints(mediaId: number, media: $app.AL_BaseAnime | undefined, metadata?: $app.Metadata_AnimeMetadata) {
			const points: Record<number, number> = {};
			const add = (n: number, day: number) => {
				if (n >= 1 && !isNaN(day) && points[n] === undefined) points[n] = day;
			};
			for (const [k, d] of Object.entries(metadata?.episodes ?? {})) if (/^\d+$/.test(k)) add(Number(k), toDay(d.airDate));
			for (const [k, d] of Object.entries(thumbnails.get(mediaId)?.episodes ?? {})) if (/^\d+$/.test(k)) add(Number(k), toDay(d.airDate));
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
					if (Math.abs(toDay(e.airDate) - p.day) > 1) continue;
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
			if (agree < Math.max(1, Math.ceil(points.length * 0.8))) return fail(`only ${agree} of ${points.length} air dates line up with AniDB ${anime.aid}`);
			const total = Math.max(anime.episodeCount, anime.main[anime.main.length - 1].n);
			if (episodes && total < offset + episodes) return fail(`AniDB ${anime.aid} has ${total} main episodes, this anime needs ${offset + episodes}`);
			// Same kind of episode: a short (3 min) never matches a full episode (24 min) that aired the same day
			const lengths = anime.main.filter((e) => e.length && e.n - offset >= 1 && (!episodes || e.n - offset <= episodes)).map((e) => e.length as number).sort((a, b) => a - b);
			const typical = lengths[Math.floor(lengths.length / 2)];
			if (duration && typical && (typical > duration * 2 || typical < duration / 2))
				return fail(`AniDB ${anime.aid}'s episodes run ${typical} min, this anime's ${duration} min`);
			return { ok: true, offset, reason: `${agree} of ${points.length} air dates line up${offset ? ` at offset +${offset}` : ""}` };
		}

		/** This anime's episode number -> AniDB episode ID. */
		const episodeIds = (anime: CEM.AnidbAnime, offset: number) => {
			const eids: Record<string, number> = {};
			for (const e of anime.main) if (e.n - offset >= 1) eids[`${e.n - offset}`] = e.eid;
			return eids;
		};
		const episodeDates = (anime: CEM.AnidbAnime, offset: number) => {
			const dates: Record<string, string> = {};
			for (const e of anime.main) if (e.n - offset >= 1 && e.airDate) dates[`${e.n - offset}`] = e.airDate;
			return dates;
		};

		/**
		 * Try this anime's own AniDB IDs (ani.zip, AnimeAPI, animap.id), then its parent's and prequels' (Animap, ani.zip,
		 * animap.id): a split AniList season is often one AniDB entry, found only through its first part. Every candidate
		 * must verify against this anime's own air dates and episode length; the first that does wins.
		 */
		async function findAnidb(mediaId: number, media: $app.AL_BaseAnime | undefined, metadata?: $app.Metadata_AnimeMetadata, scope: Scope = "page") {
			const points = airDatePoints(mediaId, media, metadata);
			log.debug(`${mediaId}: AniDB lookup with ${points.length} known air date(s)`);
			log.inspect(`${mediaId}: air dates checked against AniDB`, points);
			const reasons: string[] = [];
			let transient = false;
			const sources: [string, () => Promise<number | undefined>][] = [
				["ani.zip", async () => (await anizip(mediaId)).anidbId],
				["AnimeAPI", async () => (await animeapi(mediaId)).anidbId],
				["animap.id", () => animapIdAnidb(mediaId)],
			];
			// Parent and prequels last, looked up only if this anime's own IDs gave nothing usable
			const own = sources.length;
			const addRelated = async () => {
				for (const related of await relatedAnime(mediaId, scope)) {
					const label = `${related.relation} "${related.title}"`;
					sources.push(
						[`${label} (Animap)`, async () => {
							try {
								return (await loadMetadata(related.id))?.mappings?.anidbId || undefined;
							} catch {
								return undefined;
							}
						}],
						[`${label} (ani.zip)`, async () => (await anizip(related.id)).anidbId],
						[`${label} (animap.id)`, () => animapIdAnidb(related.id)],
					);
				}
			};
			const tried: number[] = [];
			for (let i = 0; ; i++) {
				// Only once this anime's own IDs gave nothing usable, and not in the background for anime off the watching list
				if (i === own && scope !== "own") await addRelated();
				if (i >= sources.length) break;
				const [from, get] = sources[i];
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
				const check = verifyAnidb(points, anime, media?.episodes, media?.duration);
				log.debug(`${mediaId}: AniDB ${aid} from ${from}: ${check.ok ? "verified" : "rejected"}, ${check.reason}`);
				if (check.ok) return { aid, offset: check.offset, eids: episodeIds(anime, check.offset), airDates: episodeDates(anime, check.offset), from, reason: check.reason };
				reasons.push(`AniDB ${aid} (${from}): ${check.reason}`);
			}
			return {
				reason: reasons.length ? reasons.join("; ") : `no AniDB ID from ani.zip, AnimeAPI, animap.id${scope === "own" ? "" : " or related anime"}`,
				transient,
				skippedRelations: scope === "own" && !knownWithoutRelations(mediaId),
			};
		}

		/**
		 * The AniDB ID (and episode IDs) to use for an anime Seanime has no metadata for. The user's override is used as
		 * given; otherwise a verified match, remembered for good (episode IDs refreshed every 14 days), or "none",
		 * remembered for 14 days.
		 */
		/** Writes per anime, so a lookup can tell another one (page vs background) stored a result while it ran. */
		const anidbWrites: Record<number, number> = {};
		const saveAnidb = (mediaId: number, match: CEM.AnidbMatch | null) => {
			anidbWrites[mediaId] = (anidbWrites[mediaId] ?? 0) + 1;
			anidbStore.set(mediaId, match);
		};
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
				const match: CEM.AnidbMatch = {
					mediaId, status: "override", aid: override.anidbId, offset,
					eids: anime ? episodeIds(anime, offset) : {}, airDates: anime ? episodeDates(anime, offset) : {}, from: "your override", checkedAt: now,
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
				if (fresh(existing)) return existing;
				// The ID stays; only the episode IDs are refreshed (new episodes of an airing anime)
				const anime = await anidbAnime(existing.aid!, true);
				const match = { ...existing, ...(anime ? { eids: episodeIds(anime, existing.offset ?? 0), airDates: episodeDates(anime, existing.offset ?? 0) } : {}), checkedAt: now };
				saveAnidb(mediaId, match);
				return match;
			}
			// A "none" found without checking related anime is looked up again once they may be checked
			if (existing?.status === "none" && !force && fresh(existing) && !(existing.needsVisit && scope !== "own")) return existing;

			const version = anidbWrites[mediaId] ?? 0;
			log.time(`anidb ${mediaId}`);
			let media: $app.AL_BaseAnime | undefined;
			try {
				media = (await ctx.anime.getAnimeEntry(mediaId)).media;
			} catch {}
			const found = await findAnidb(mediaId, media, undefined, scope);
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
				const match: CEM.AnidbMatch = { mediaId, status: "verified", aid: found.aid, offset: found.offset, eids: found.eids, airDates: found.airDates, from: found.from, reason: found.reason, checkedAt: now };
				saveAnidb(mediaId, match);
				log.info(`${name} (${mediaId}): AniDB ${found.aid} from ${found.from} verified (${found.reason}), ${Object.keys(found.eids).length} episode IDs`);
				log.inspect(`${mediaId}: AniDB match`, match);
				return match;
			}
			log.step(`${name} (${mediaId}): no verified AniDB ID: ${found.reason}`);
			// A request that failed is retried next time; a real "no" is remembered for 14 days (and no ID is stored)
			if (!found.transient)
				saveAnidb(mediaId, { mediaId, status: "none", reason: found.reason, checkedAt: now, ...(found.skippedRelations ? { needsVisit: true } : {}) });
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
		}

		/**
		 * Fill the media override fields without saving: the TMDB ID typed in the field, else Animap's, else a TMDB
		 * title search (each candidate checked against the air dates), then the season and offset the dates line up with.
		 */
		async function autoFill(mediaId: number) {
			const refs = tmdb.overrides.media.fieldRefs;
			let media: $app.AL_BaseAnime | undefined;
			let metadata: $app.Metadata_AnimeMetadata | undefined;
			try {
				media = (await ctx.anime.getAnimeEntry(mediaId)).media;
			} catch {}
			try {
				metadata = await loadMetadata(mediaId);
			} catch {}

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

			const typed = Number(refs.tmdbId.current.trim()) || undefined;
			const { found, firstValid } = await searchTmdb(mediaId, media, metadata, tmdbSession(), typed ? { id: typed, from: "the TMDB ID you entered" } : undefined);

			if (!found) {
				if (!firstValid) return ctx.toast.error(typed ? `TMDB has no show or movie with ID ${typed}.` : "Couldn't find this anime on TMDB. Enter the TMDB ID by hand.");
				refs.tmdbId.setValue(`${firstValid.id}`);
				return ctx.toast.warning(`Filled the TMDB ID from ${firstValid.from}, but couldn't work out the season: ${firstValid.reason ?? "no match"}`);
			}

			const { id, from, mapping } = found;
			refs.tmdbId.setValue(`${id}`);
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
			let count = 0;
			if (missing) {
				try {
					count = episodeCount((await ctx.anime.getAnimeEntry(mediaId)).media);
				} catch {}
			}
			animap.set(mediaId, { fallback: missing, episodeCount: count, checkedAt: Date.now(), ...(missing ? { since: Date.now() } : {}) });
			if (missing) log.info(`${mediaId}: Seanime has no metadata for this anime; the plugin supplies its episode list`);
			else log.step(`${mediaId}: Seanime has metadata for this anime`);
		}

		/**
		 * On demand: match or refresh an anime when Seanime loads it and its data has expired (nextCheckAt), instead
		 * of refreshing everything on a clock. Until the refresh lands, the previous stills are still shown. In the
		 * background only anime being watched are matched (unless "Everything" is chosen); the rest wait for their page.
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
			log.step(`${mediaId}: checking (${scope === "page" ? "its page is open" : scope === "background" ? "watching list" : "\"Everything\", own IDs only"})`);

			await detectMissing(mediaId);
			// No AniDB ID from Seanime: find a verified one (cached; at most one lookup per anime every 14 days)
			if (await needsAnidb(mediaId)) await refreshAnidb(mediaId, false, scope);
			if (!wantsMatch(mediaId)) return;
			const record = thumbnails.get(mediaId);
			// Left for its page earlier; now its related anime may be checked
			const revisit = !!record?.needsVisit && scope !== "own";
			if (!isDue(record, now) && !revisit) return log.step(`${mediaId}: fresh until ${new Date(record?.nextCheckAt ?? 0).toISOString()}`);
			if (record?.needsVisit && scope === "own") return log.step(`${mediaId}: waits for its page to check related anime`);
			log.step(`${mediaId}: ${record ? (revisit ? "checking related anime" : "expired, refreshing") : "not matched yet, matching"}`);
			log.time(`refresh ${mediaId}`);
			await refreshAnime(mediaId, autoWrites(mediaId), false, scope);
			log.timeEnd(`refresh ${mediaId}`);
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
		/** Background changes (anime matched while Seanime loads a page) are rebuilt at most once a minute. */
		const REBUILD_GAP = 60 * 1000;
		/**
		 * Rebuild soon. Straight away (after a second) for a change to the anime whose page is open, or with no mediaId
		 * (settings, the user's own actions), even while a batch runs; otherwise when the batch is done and at most once
		 * a minute, since each rebuild clears Seanime's whole metadata cache and makes it fetch every anime on screen
		 * from Animap again.
		 */
		function scheduleRebuild(stillsChanged: boolean, mediaId?: number) {
			rebuildPending = true;
			rebuildStills = rebuildStills || stillsChanged;
			if (mediaId !== undefined && rebuildIds.indexOf(mediaId) === -1) rebuildIds.push(mediaId);
			rebuildUrgent = rebuildUrgent || mediaId === undefined || mediaId === currentMedia.get()?.id;
			if (serving && !rebuildUrgent) return; // the batch rebuilds once when it's done
			armRebuild();
		}
		function armRebuild() {
			cancelRebuild?.();
			const wait = rebuildUrgent ? 1000 : Math.max(1000, lastRebuild + REBUILD_GAP - Date.now());
			log.step(`Rebuild ${rebuildUrgent ? "now" : `in ${Math.round(wait / 1000)}s (at most once a minute)`} for ${rebuildIds.length ? rebuildIds.join(", ") : "all anime"}`);
			cancelRebuild = ctx.setTimeout(rebuild, wait);
		}
		function rebuild() {
			cancelRebuild?.();
			cancelRebuild = undefined;
			if (!rebuildPending) return;
			// A timer armed before a batch started: the batch re-arms it when it's done, so nothing is cleared mid-batch
			if (serving && !rebuildUrgent) return log.step("Rebuild waits for the running batch");
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
		 * queued for a second (Seanime is done loading the page), or after 4 seconds of a page that keeps loading.
		 */
		let serving = false;
		let batches = 0;
		ctx.setInterval(() => {
			const queued = `${$store.get("CEM_REQUESTED") ?? ""}`;
			if (serving || !queued) return;
			const now = Date.now();
			const settled = now - (Number($store.get("CEM_REQUESTED_LAST")) || 0) >= 1000;
			const waited = now - (Number($store.get("CEM_REQUESTED_FIRST")) || 0) >= 4000;
			if (!settled && !waited) return;
			// Take what was read; anything the hook queued in between stays for the next batch
			const taken = queued.split(",");
			const left = `${$store.get("CEM_REQUESTED") ?? ""}`.split(",").filter((id) => id && taken.indexOf(id) === -1);
			$store.set("CEM_REQUESTED", left.join(","));
			if (left.length) $store.set("CEM_REQUESTED_FIRST", now);
			serving = true;
			const ids = queued.split(",").map(Number).filter((id, i, all) => id > 0 && all.indexOf(id) === i);
			const batch = ++batches;
			log.mark(`Batch ${batch}: ${ids.length} anime Seanime loaded${waited && !settled ? " (page still loading after 4s)" : ""}`);
			log.inspect(`batch ${batch}`, ids);
			log.time(`batch ${batch}`);
			(async () => {
				for (const id of ids) {
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
			if (pathname !== "/entry" || !searchParams.id) {
				currentMedia.set(null);
				return updateBadge();
			}
			const mediaId = Number(searchParams.id);
			const entry = await ctx.anime.getAnimeEntry(mediaId);
			currentMedia.set({
				id: entry.mediaId,
				banner: entry.media?.bannerImage ?? "",
				title: entry.media?.title?.userPreferred ?? "",
				type: entry.media?.format?.valueOf() === "MOVIE" ? "movie" : "tv",
			});
			// A change found in the background for this anime and still waiting for the once-a-minute rebuild shows now
			if (rebuildPending && rebuildIds.indexOf(mediaId) !== -1) {
				rebuildUrgent = true;
				armRebuild();
			}

			log.mark(`Page opened: ${entry.media?.title?.userPreferred ?? mediaId} (${mediaId})`);
			// The page may come from Seanime's cache without loading metadata, so check this anime here too, fully
			serve(mediaId, true)
				.then(() => {
					// The page being viewed doesn't wait for a background batch or the once-a-minute limit
					if (rebuildPending && rebuildUrgent) rebuild();
					tray.update();
				})
				.catch((e) => log.error(`${mediaId}: checking the opened page failed:`, e));
			updateBadge();

			// Keep the generated episode list in step with newly aired episodes, straight away for the page being viewed
			if (!syncEpisodeCount(mediaId, entry.media)) return;
			clearMetadataCache();
			$app.invalidateClientQuery(["ANIME-ENTRIES-get-anime-entry", "ANIME-get-anime-episode-collection"]);
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

		function styledInput(label: string, params: Parameters<NonNullable<$ui.Tray["input"]>>[1]) {
			return tray.flex(
				[
					tray.text(label, {
						className: "flex items-center w-fit whitespace-nowrap px-3 bg-gray-800 rounded-l-xl border text-sm",
						style: { opacity: params?.disabled ? "0.5" : "1", marginRight: "-1px" },
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
		if (!e.animeMetadata.episodes) e.animeMetadata.episodes = {};

		const record = $shared.use<CEM.ThumbnailStore>("thumbnails").get(e.mediaId);
		// Anime Seanime has no metadata for: TMDB's episode data, kept in the background, fills the generated list
		const fill =
			record?.status === "matched" &&
			!!record.episodes &&
			$getUserPreference("tmdb-fill-missing") === "true" &&
			!!$shared.use<CEM.AnimapStore>("animap").get(e.mediaId)?.fallback;
		if (fill) {
			for (const [key, data] of Object.entries(record.episodes ?? {})) {
				const episodeMetadata = e.animeMetadata.episodes[key];
				if (!episodeMetadata) continue;
				if (data.title) episodeMetadata.title = data.title;
				if (data.overview) episodeMetadata.overview = episodeMetadata.summary = data.overview;
				if (data.airDate) episodeMetadata.airDate = data.airDate;
				if (data.length) episodeMetadata.length = data.length;
			}
		}

		// Seanime's metadata has no AniDB ID (e.g. Animap knows the anime but not its AniDB entry): add the user's or a
		// verified one, with episode IDs, adding aired episodes the metadata is missing. The no-metadata case gets this
		// in onAnimeMetadataRequested already.
		const mappings = e.animeMetadata.mappings ?? (e.animeMetadata.mappings = {});
		// Remember whether Seanime itself had an AniDB ID, so the UI context needn't load the metadata again to find out
		$store.set(`CEM_SEANIME_ANIDB_${e.mediaId}`, mappings.anidbId || 0);
		let injected = 0;
		if (!mappings.anidbId && e.mediaId < 0x80000000) {
			const overrides = ($storage.get("TMDB_OVERRIDES") ?? {}) as Record<number, CEM.TMDBOverrides>;
			const anidb = $shared.use<{ get: (id: number) => CEM.AnidbMatch | undefined }>("anidb").get(e.mediaId);
			const aid = overrides[e.mediaId]?.anidbId ?? ($getUserPreference("anidb-lookup") !== "false" && anidb?.status === "verified" ? anidb.aid : undefined);
			if (aid) {
				mappings.anidbId = aid;
				injected = aid;
				const today = new Date().toISOString().slice(0, 10);
				for (const [n, eid] of Object.entries(anidb?.aid === aid ? anidb.eids ?? {} : {})) {
					let episode = e.animeMetadata.episodes[n];
					if (!episode) {
						const airDate = anidb?.airDates?.[n];
						if (!airDate || airDate > today) continue;
						const num = Number(n);
						episode = e.animeMetadata.episodes[n] = {
							anidbId: 0, tvdbId: 0, title: `Episode ${n}`, image: "", airDate, length: 0, summary: "", overview: "",
							episodeNumber: num, episode: n, seasonNumber: 1, absoluteEpisodeNumber: num, anidbEid: 0, hasImage: false,
						};
						e.animeMetadata.episodeCount = Math.max(e.animeMetadata.episodeCount ?? 0, num);
					}
					if (!episode.anidbEid) episode.anidbEid = episode.anidbId = eid;
				}
			}
		}

		// TMDB stills replace Animap's (TVDB) thumbnails. Custom images below still win.
		let stills = 0;
		if ($getUserPreference("tmdb-thumbnails") === "true" || fill) {
			if (record?.status === "matched") {
				const tmdbImage = $shared.use<(path: string) => string>("tmdbImage");
				for (const [key, image] of Object.entries(record.images)) {
					const episodeMetadata = e.animeMetadata.episodes[key];
					if (!episodeMetadata) continue;
					episodeMetadata.image = tmdbImage(image);
					episodeMetadata.hasImage = true;
					stills++;
				}
			}
		}

		const entry = $shared.use<CEM.SharedDatabase>("database").get(e.mediaId);
		for (const [key, customMetadata] of Object.entries(entry.data)) {
			const episodeMetadata = e.animeMetadata.episodes[key];
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

		if ($debug.enabled && (stills || fill || injected || Object.keys(entry.data).length))
			$debug.debug(
				`hook: ${e.mediaId}: ${stills} TMDB stills, ${fill ? `${Object.keys(record?.episodes ?? {}).length} fill-in episodes, ` : ""}${Object.keys(entry.data).length} custom episodes${injected ? `, AniDB ${injected} added` : ""}`,
			);

		// What the UI context needs from this metadata (air dates, IDs), so its checks don't have to ask Seanime again:
		// with more than 100 anime loaded, Seanime's cache has often dropped it, and asking means another Animap fetch.
		// Without a TMDB key those checks don't run. Copies over an hour old are emptied by the UI context.
		if (!$getUserPreference("tmdb-api")) return e.next();
		const episodes: Record<string, { airDate?: string }> = {};
		for (const [key, ep] of Object.entries(e.animeMetadata.episodes)) episodes[key] = ep?.airDate ? { airDate: ep.airDate } : {};
		$store.set(
			`CEM_META_${e.mediaId}`,
			JSON.stringify({
				at: Date.now(),
				metadata: {
					episodes,
					episodeCount: e.animeMetadata.episodeCount ?? 0,
					mappings: { themoviedbId: mappings.themoviedbId ?? "", anidbId: mappings.anidbId ?? 0 },
				},
			}),
		);
		e.next();
	});
}
