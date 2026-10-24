/// <reference path="../../typings/plugin.d.ts" />
/// <reference path="../../typings/system.d.ts" />
/// <reference path="../../typings/app.d.ts" />
/// <reference path="../../typings/core.d.ts" />
/// <reference path="./missing-metadata-fix.d.ts" />

/**
 * Missing Metadata Fix. Contents, in file order:
 *
 * init()
 *   SHARED STORES    $shared modules: the stores on disk, the settings checks and the AniDB ID in use, for every runtime
 *   HOOKS            onAnimeMetadataRequested (the episode list for anime Animap has no entry for) and onAnimeMetadata
 *                    (TMDB stills, fill-in, AniDB IDs and the custom metadata, applied as Seanime builds its episodes)
 *   UI CONTEXT       $ui.register, one runtime:
 *     1. Setup                    the tray, logging, how long things are kept, small helpers
 *     2. Stores and settings      the stores, the settings and TMDB token, the tray's state, TMDB's API and the override
 *                                 store (tmdb)
 *     3. Seanime's metadata       reading it, Animap, the episode list for anime it has no entry for
 *     4. Tray                     the custom episode list, the episode editor, shared widgets
 *     5. Overrides                the fields and their syntax, the overrides modal, Auto-fill, Bulk Update, status lines
 *     6. TMDB matching            the refresh, building the match, where the TMDB ID comes from
 *     7. AniDB                    entries, checking a candidate, the lookup and the match in use
 *     8. Scheduling and rebuilds  what's matched when, Seanime's rebuilds
 *     9. Startup                  registers the tray and episode menu, checks the settings, starts the timers and page
 *                                 watching (above it, only values and stores are set up)
 */
// @ts-ignore
function init(): void {
	// ====================================================================================================================
	// SHARED STORES: $shared modules, evaluated in every runtime that uses them
	// ====================================================================================================================
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

	/**
	 * Whether to build and write debug lines: a development install (its debug panel), or Developer mode in the settings
	 * (every line to seanime.log, for anyone reporting a problem)
	 */
	$shared.define("debugging", () => () => $debug.enabled || $getUserPreference("debug-to-log") === "true");
	/** A debug line from the metadata hooks: the plugin's debug panel, and seanime.log in Developer mode */
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
		// An automatic match only while its lookup is on (it stays stored for when it's back on)
		if (overrides[mediaId]?.anidbNone) return { anidb };
		const lookedUp = $getUserPreference("anidb-lookup") !== "false" && anidb?.status === "verified" ? anidb.aid : undefined;
		const aid = overrides[mediaId]?.anidbId ?? lookedUp;
		let own = aid && anidb?.aid === aid ? anidb : undefined;
		// Episodes whose override says "none" get none of it
		const none = (overrides[mediaId]?.episodeOverrides ?? []).filter((o) => o.anidbNone).map((o) => o.aniDBEpisode);
		if (own && none.length) {
			const omit = <T>(r?: Record<string, T>) => r && Object.fromEntries(Object.entries(r).filter(([k]) => none.indexOf(k) === -1));
			own = { ...own, eids: omit(own.eids), airDates: omit(own.airDates), episodes: omit(own.episodes) };
		}
		return { aid, anidb, own };
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

	// Whether the TMDB setting holds an API Read Access Token: without one nothing from TMDB is applied, stored data included
	// TMDB's verdict on a token is kept by this fingerprint of it, never the token itself
	$shared.define("tokenPrint", () => (token: string) => {
		let h = 5381;
		for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) | 0;
		return (h >>> 0).toString(36);
	});
	$shared.define("tmdbUsable", () => () => {
		const token = `${$getUserPreference("tmdb-api") ?? ""}`.trim();
		const verdict = $storage.get<{ print: string; ok: boolean }>("CEM_TMDB_TOKEN_CHECK");
		const rejected = verdict && !verdict.ok && verdict.print === $shared.use<(token: string) => string>("tokenPrint")(token);
		return /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(token) && !rejected;
	});

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
		// A failed match only holds the episodes their overrides point at
		const matched = !!thumbs && $shared.use<() => boolean>("tmdbUsable")();
		const stills = matched && $getUserPreference("tmdb-thumbnails") === "true" ? Object.keys(thumbs.images) : [];
		const filled = matched && $getUserPreference("tmdb-fill-missing") === "true" ? Object.keys(thumbs.episodes ?? {}) : [];

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

	// ====================================================================================================================
	// HOOKS: what Seanime's episode metadata gets (each hook runs in its own runtime)
	// ====================================================================================================================
	// When Animap has no entry (e.g. AniDB entries that are 18+), Seanime errors out before onAnimeMetadata fires and
	// custom metadata is never applied. For those anime, supply the episode list here instead so Animap is never called;
	// onAnimeMetadata still runs afterwards and merges the custom metadata and TMDB stills. Only anime with custom
	// metadata or TMDB stills (a match's, or episode overrides') are taken over, so everything else keeps going to Animap
	// and picks up its entry as soon as it exists.
	$app.onAnimeMetadataRequested((e) => {
		const hookDebug = $shared.use<(line: string) => void>("hookDebug");
		const newEpisode = $shared.use<(key: string, airDate?: string, eid?: number, title?: string) => $app.Metadata_EpisodeMetadata>("newEpisode");
		const debugging = $shared.use<() => boolean>("debugging")();
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
		} else if (debugging && recent) hookDebug(`hook: ${e.mediaId} not queued, checked ${Math.round((Date.now() - served) / 1000)}s ago`);

		// Only for an anime Animap has no entry for (fallbackSupply checks)
		const supply = e.animeMetadata ? $shared.use<(mediaId: number) => CEM.FallbackSupply | null>("fallbackSupply")(e.mediaId) : null;
		if (!supply || !e.animeMetadata) return e.next();
		const { count, aid, eids, airDates } = supply;

		// Assigned objects are stored as copies, so work on what's read back
		if (!e.animeMetadata.episodes) e.animeMetadata.episodes = {};
		const episodes = e.animeMetadata.episodes;
		for (let n = 1; n <= count; n++) episodes[`${n}`] = newEpisode(`${n}`, airDates?.[`${n}`] ?? "", eids[`${n}`] ?? 0, `Episode ${n}`);
		e.animeMetadata.episodeCount = count;
		if (debugging) hookDebug(`hook: ${e.mediaId} has no Animap entry; supplying ${count} episodes${aid ? `, AniDB ${aid}` : ""}`);
		if (aid) {
			if (!e.animeMetadata.mappings) e.animeMetadata.mappings = {};
			e.animeMetadata.mappings.anidbId = aid;
		}
		e.preventDefault();
		e.next();
	});

	/**
	 * Every time Seanime builds an anime's metadata: add the AniDB ID in use, fill in what Seanime lacks from TMDB and
	 * AniDB, put TMDB's stills in, and merge the custom metadata over all of it, in that order. It runs in its own runtime
	 * and can't fetch: it only applies what the UI context stored.
	 */
	$app.onAnimeMetadata((e) => {
		if (!e.animeMetadata) return e.next();
		const hookDebug = $shared.use<(line: string) => void>("hookDebug");
		const newEpisode = $shared.use<(key: string, airDate?: string, eid?: number, title?: string) => $app.Metadata_EpisodeMetadata>("newEpisode");
		const debugging = $shared.use<() => boolean>("debugging")();
		if (!e.animeMetadata.episodes) e.animeMetadata.episodes = {};

		const record = $shared.use<CEM.ThumbnailStore>("thumbnails").get(e.mediaId);
		// A failed match only holds the episodes their overrides point at
		const matched = !!record && $shared.use<() => boolean>("tmdbUsable")();
		// The episode list the plugin supplies (no Animap entry): nothing in it is Seanime's own but AniDB's air dates
		const supplied = !!$shared.use<CEM.AnimapStore>("animap").get(e.mediaId)?.fallback;
		const fillOn = $getUserPreference("tmdb-fill-missing") === "true";
		const aired = $shared.use<Aired>("aired")(e.mediaId);
		// A title AniDB or Animap gives an episode it has no title for (as plainTitle in the UI context)
		const generic = /^(episode|ep\.?|movie|special|ova|ona|oad|part)\s*[a-z]?\d+(\s*of\s*\d+)?$|^complete movie$|^第\s*\d+\s*話$/i;
		const placeholder = (title?: string) => !title?.trim() || generic.test(title.trim());
		const meta = e.animeMetadata;
		const episodes = meta.episodes as Record<string, $app.Metadata_EpisodeMetadata>; // set above
		const { gaps, ownTitles } = seanimeGaps();
		/** Adds an aired episode Seanime's list doesn't have (yet). Which ones were added is kept for the UI context. */
		const added: string[] = [];
		const addEpisode = (key: string, airDate: string) => {
			episodes[key] = newEpisode(key, airDate);
			meta.episodeCount = Math.max(meta.episodeCount ?? 0, Number(key));
			added.push(key);
			return episodes[key]; // read back: Seanime's episode map stores a copy
		};

		if (!e.animeMetadata.mappings) e.animeMetadata.mappings = {};
		const mappings = e.animeMetadata.mappings; // read back: assigned objects are stored as copies
		// Remember whether Seanime itself had an AniDB ID, so the UI context needn't load the metadata again to find out.
		// In the list the plugin supplies, an ID is the plugin's own (the override or a lookup's), never Seanime's.
		$store.set(`CEM_SEANIME_ANIDB_${e.mediaId}`, supplied ? 0 : mappings.anidbId || 0);
		const { aid, own } = $shared.use<AnidbInUse>("anidbInUse")(e.mediaId);
		dropAnidb();
		const injected = injectAnidb();
		const overridden = anidbEpisodeOverrides();
		// An episode with custom metadata is the user's: its empty fields keep Seanime's own data, no fill-in or still
		const entry = $shared.use<CEM.SharedDatabase>("database").get(e.mediaId);
		const { fills, tmdbFilled } = fillIn();
		const stills = applyStills();
		const customOnly = mergeCustom();

		// Kept apart from Seanime's own episodes: the UI context leaves these out of Seanime's (cached) metadata
		const notOwn = added.concat(customOnly);
		if (notOwn.length || $store.get(`CEM_ADDED_${e.mediaId}`)) $store.set(`CEM_ADDED_${e.mediaId}`, notOwn.length ? JSON.stringify(notOwn) : "");
		const filledKeys = Object.keys(tmdbFilled).length;
		if (filledKeys || $store.get(`CEM_TMDB_FILLED_${e.mediaId}`)) {
			$store.set(`CEM_TMDB_FILLED_${e.mediaId}`, filledKeys ? JSON.stringify(tmdbFilled) : "");
		}

		if (debugging && (stills || fills || injected || Object.keys(entry.data).length)) {
			const filled = fills ? `${fills} episodes filled in${added.length ? ` (${added.length} added)` : ""}, ` : "";
			const anidbAdded = injected ? `, AniDB ${injected} added` : "";
			hookDebug(`hook: ${e.mediaId}: ${stills} TMDB stills, ${filled}${Object.keys(entry.data).length} custom episodes${anidbAdded}`);
		}
		keepForUi();
		e.next();

		/**
		 * Episodes Seanime's own metadata has no overview, thumbnail, real title ("Episode 4") or length for (Animap often
		 * has the length only as text, e.g. "8m", which Seanime doesn't read), before anything below changes them. Unaired
		 * ones too: Animap may date an episode by its TV broadcast while it already streams. Seanime's own titles too, for
		 * matching by title when the air dates don't line up.
		 */
		function seanimeGaps() {
			const gaps: Record<string, boolean> = {};
			const ownTitles: Record<string, string> = {};
			for (const [key, ep] of Object.entries(episodes)) {
				if (ep && (!(ep.overview || ep.summary) || !ep.image || placeholder(ep.title) || !ep.length)) gaps[key] = true;
				if (ep?.title && /^\d+$/.test(key) && !supplied) ownTitles[key] = ep.title;
			}
			return { gaps, ownTitles };
		}

		/**
		 * Seanime's metadata has no AniDB ID (e.g. Animap knows the anime but not its AniDB entry): add the user's or a
		 * verified one, with episode IDs, adding aired episodes the metadata is missing. The no-metadata case gets this in
		 * onAnimeMetadataRequested already. Your override replaces an ID Seanime has itself, with its episode IDs (e.g. a TV
		 * series AniDB lists as its other episodes, O1 onwards, while Animap has its movies). Returns the ID added, or 0.
		 */
		function injectAnidb() {
			const yours = own?.status === "override";
			if (!aid || (mappings.anidbId && !yours)) return 0;
			if (yours && mappings.anidbId) {
				// Seanime's episode IDs follow its own mapping: the main episodes take yours (or none), the rest stay only
				// with the same AniDB entry
				const same = mappings.anidbId === aid;
				for (const key of Object.keys(episodes)) {
					const episode = episodes[key]; // read back: Seanime's episode map stores a copy
					if (!episode || (same && !/^\d+$/.test(key))) continue;
					episode.anidbEid = episode.anidbId = 0;
				}
			}
			mappings.anidbId = aid;
			for (const [n, eid] of Object.entries(own?.eids ?? {})) {
				const airDate = own?.airDates?.[n];
				const episode = episodes[n] ?? (aired(n, airDate) ? addEpisode(n, airDate ?? "") : undefined);
				if (episode && !episode.anidbEid) episode.anidbEid = episode.anidbId = eid;
			}
			return aid;
		}

		/**
		 * "none" for AniDB: no AniDB ID at all, Seanime's own included, for the anime or the episodes that say so. Wrong
		 * episode IDs (e.g. AniDB counting a TV series as its four movies) would point torrent searches by AniDB at the
		 * wrong episodes, and AniDB's episode links at the wrong pages.
		 */
		function dropAnidb() {
			const override = (($storage.get("TMDB_OVERRIDES") ?? {}) as Record<number, CEM.TMDBOverrides>)[e.mediaId];
			if (override?.anidbNone) mappings.anidbId = 0;
			const none = (override?.episodeOverrides ?? []).filter((o) => o.anidbNone).map((o) => o.aniDBEpisode);
			for (const key of override?.anidbNone ? Object.keys(episodes) : none) {
				const episode = key ? episodes[key] : undefined;
				if (episode && (episode.anidbEid || episode.anidbId)) episode.anidbEid = episode.anidbId = 0;
			}
		}

		/** Episode overrides naming their AniDB episode: its ID over any other, and its data for the fill-in */
		function anidbEpisodeOverrides() {
			const overridden: Record<string, { title?: string; airDate?: string; length?: number; summary?: string }> = {};
			for (const o of (($storage.get("TMDB_OVERRIDES") ?? {}) as Record<number, CEM.TMDBOverrides>)[e.mediaId]?.episodeOverrides ?? []) {
				if (!o.aniDBEpisode || !o.anidbEid) continue;
				const episode = episodes[o.aniDBEpisode];
				if (episode) episode.anidbEid = episode.anidbId = o.anidbEid;
				if (o.anidb) overridden[o.aniDBEpisode] = o.anidb;
			}
			return overridden;
		}

		/**
		 * Fill-in: each field from the first source that has it. Seanime's own data always wins; then AniDB's air dates (it
		 * dates episodes most reliably) but TMDB's titles, overviews and lengths (AniDB's titles are often only "Volume 1").
		 * Placeholder titles never count. AniDB's data only for the AniDB entry in use. tmdbFilled: the titles and air dates
		 * taken from TMDB, with what was there before: they mustn't count as evidence for the TMDB match they came from (a
		 * deleted override would otherwise match again by its own dates or titles).
		 */
		function fillIn() {
			const tmdbData = matched && fillOn ? record.episodes ?? {} : {};
			// AniDB's data comes with its ID in use (the override, or a lookup's while that's on), fill-in switched on or not
			const anidbData = { ...(own && own.status !== "none" && own.aid === mappings.anidbId ? own.episodes : {}), ...overridden };
			// Aired episodes TMDB has and Seanime's list doesn't (yet)
			for (const [key, data] of Object.entries(tmdbData)) {
				if (!episodes[key] && (data.aired || aired(key, data.airDate))) addEpisode(key, "");
			}
			const tmdbFilled: Record<string, { title?: string; airDate?: string }> = {};
			let fills = 0;
			for (const [key, ep] of Object.entries(episodes)) {
				const t = tmdbData[key];
				const a = anidbData[key];
				if (!ep || !(t || a) || entry.data[key]) continue;
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
			return { fills, tmdbFilled };
		}

		/**
		 * TMDB stills: they replace Animap's (TVDB) thumbnails with the setting on (and in the list the plugin supplies,
		 * which has none), else only fill a missing one. Custom images (mergeCustom) still win. Returns how many.
		 */
		function applyStills() {
			let stills = 0;
			const stillsOn = $getUserPreference("tmdb-thumbnails") === "true";
			const replace = stillsOn || supplied;
			if (!matched || !(stillsOn || fillOn)) return 0;
			const tmdbImage = $shared.use<(path: string) => string>("tmdbImage");
			for (const [key, image] of Object.entries(record.images)) {
				const episodeMetadata = episodes[key];
				if (!episodeMetadata || entry.data[key] || (!replace && episodeMetadata.image)) continue;
				episodeMetadata.image = tmdbImage(image);
				episodeMetadata.hasImage = true;
				stills++;
			}
			return stills;
		}

		/** The custom metadata over everything else; returns the episodes only it has (they aren't Seanime's either) */
		function mergeCustom() {
			const customOnly: string[] = [];
			for (const [key, customMetadata] of Object.entries(entry.data)) {
				const episodeMetadata = meta.episodes![key];
				if (!episodeMetadata) customOnly.push(key);
				if (customMetadata.image?.length) customMetadata.hasImage = true;
				if (customMetadata.overview?.length) customMetadata.summary = customMetadata.overview;
				const merged = { ...episodeMetadata, ...customMetadata };
				// A blank custom image must not wipe the existing thumbnail
				if (!customMetadata.image?.length && episodeMetadata) {
					merged.image = episodeMetadata.image;
					merged.hasImage = episodeMetadata.hasImage;
				}
				meta.episodes![key] = merged;
			}
			return customOnly;
		}

		/**
		 * What the UI context needs from this metadata (air dates, IDs), so its checks don't have to ask Seanime again: with
		 * more than 100 anime loaded, Seanime's cache has often dropped it, and asking means another Animap fetch. Without a
		 * TMDB key and the AniDB lookup those checks don't run. Copies over an hour old are emptied by the UI context.
		 */
		function keepForUi() {
			if (!$getUserPreference("tmdb-api") && $getUserPreference("anidb-lookup") === "false") return;
			const kept: Record<string, { airDate?: string; title?: string; gap?: boolean }> = {};
			for (const [key, ep] of Object.entries(episodes)) {
				if (notOwn.indexOf(key) !== -1) continue;
				const airDate = tmdbFilled[key]?.airDate ?? ep?.airDate;
				kept[key] = {
					...(airDate ? { airDate } : {}),
					...(ownTitles[key] ? { title: ownTitles[key] } : {}),
					...(gaps[key] ? { gap: true } : {}),
				};
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
		}
	});

	// ====================================================================================================================
	// UI CONTEXT: the tray, overrides, matching and scheduling (one runtime, sections 1-9 below)
	// ====================================================================================================================
	$ui.register((ctx) => {

		// ----------------------------------------------------------------------------------------------------------------
		// 1. Setup: the tray, logging, how long things are kept, small helpers
		// ----------------------------------------------------------------------------------------------------------------
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
		 * Building costly arguments is guarded by debugging, so normal installs don't pay for it.
		 */
		const text = (values: unknown[]) =>
			values.map((v) => (typeof v === "string" ? v : v instanceof Error ? v.message : JSON.stringify(v))).join(" ");
		/**
		 * Developer mode in the settings: every level also goes to seanime.log, so a whole session can be read back (the
		 * debug panel keeps only the last 500 lines, and only development installs have one) and sent with a bug report
		 */
		const toFile = $getUserPreference("debug-to-log") === "true";
		/** Debug lines are wanted somewhere: the debug panel or seanime.log */
		const debugging = $debug.enabled || toFile;
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
		/** A JSON value the metadata hooks left in $store; empty when there's none (or it doesn't parse). */
		function storeJson<T>(key: string, empty: T): T {
			try {
				return (JSON.parse(`${$store.get(key) ?? ""}`) as T) ?? empty;
			} catch {
				return empty;
			}
		}
		const MINUTE = 60 * 1000;
		const HOUR = 60 * MINUTE;
		const DAY = 24 * HOUR;
		/** Custom sources' anime (IDs from 2^31 up) provide their own metadata: no Animap, AniList relations or ID lookups */
		const isCustomSource = (mediaId: number) => mediaId >= 0x80000000;
		// How long answers are kept and how far apart requests go (the README's "Requests and caches")
		/** Animap's answer to whether it has an anime */
		const ANIMAP_PROBE_KEEP = HOUR;
		/** AnimeAPI's answers; its public instance allows about 30 requests per 10 minutes */
		const ANIMEAPI_KEEP = 14 * DAY;
		const ANIMEAPI_SPACING = 20 * 1000;
		/** AniList's parent/prequel steps; in the background, AniList's blocking calls are spaced */
		const RELATIONS_KEEP = 30 * DAY;
		const RELATIONS_SPACING = 3000;
		/** AniDB entries (episodes, air dates), fetched through proxy.ani.zip */
		const ANIDB_ENTRY_KEEP = 14 * DAY;
		const ANIDB_SPACING = 1500;
		/** How long an AniDB match stands before it's checked again: a verified one's episode IDs refreshed, a "none" looked up again */
		const ANIDB_MATCH_KEEP = 14 * DAY;
		/** The plugin's own choice: animap.id sets no usage limit */
		const ANIMAP_ID_SPACING = 1500;
		/** Your anime list, read from Seanime's cache */
		const WATCHING_LIST_KEEP = 5 * MINUTE;
		/** Refreshing the AniList collection (for Upcoming Episodes' stills) at most this often */
		const COLLECTION_REFRESH_GAP = 10 * MINUTE;
		/** TMDB matches of anime not seen for this long are forgotten (unless they have custom metadata) */
		const FORGET_AFTER = 60 * DAY;
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
		const sleep = (ms: number) => new Promise<void>((resolve) => ctx.setTimeout(() => resolve(), ms));
		/** "YYYY-MM-DD" as a day number, so dates compare without timezone trouble. */
		const toDay = (date: string | undefined) => {
			const m = (date ?? "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
			return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : NaN;
		};
		/**
		 * AniDB often dates the first episodes by early screenings or streams (a premiere event, or a batch put online weeks
		 * before the broadcast): those dates say nothing against a match. How many episodes, from episode 1 on without a
		 * gap, are dated 2 to 90 days before the broadcast; none unless an episode after them lines up (within a day),
		 * else the dates simply differ. dates(n): [the early side's day, the broadcast's day] for episode n, if both known.
		 */
		const earlyScreenings = (dates: (n: number) => [number, number] | undefined, last: number) => {
			let early = 0;
			for (let d = dates(1); d && d[0] < d[1] - 1 && d[1] - d[0] <= 90; d = dates(early + 1)) early++;
			for (let n = early + 1; n <= last; n++) {
				const d = dates(n);
				if (d && Math.abs(d[0] - d[1]) <= 1) return early;
			}
			return 0;
		};
		/**
		 * An episode title reduced for comparing ("" for a placeholder like "Episode 4", "Episode O1", "Movie 2", "Part 1
		 * of 2" or "Complete Movie", as AniDB and Animap name episodes they have no title for), so punctuation and case
		 * don't matter.
		 */
		const plainTitle = (title?: string) => {
			const plain = (title ?? "").toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\u3040-\u30ff\u4e00-\u9fff]+/g, "");
			const generic = /^(episode|ep|movie|special|ova|ona|oad|part)[a-z]?\d+(of\d+)?$|^completemovie$|^第\d+話$/;
			return plain.length < 4 || generic.test(plain) ? "" : plain;
		};
		const lastCalls: Record<string, number> = {};
		/** Keep calls to one service at least `ms` apart. Waits instead of skipping: this runs in the background. */
		async function spaced(service: string, ms: number) {
			const wait = (lastCalls[service] ?? 0) + ms - Date.now();
			if (wait > 0) await sleep(wait);
			lastCalls[service] = Date.now();
		}

		// ----------------------------------------------------------------------------------------------------------------
		// 2. Stores and settings: the stores on disk, the settings and TMDB token, the tray's state, TMDB's API and the override store (tmdb)
		// ----------------------------------------------------------------------------------------------------------------
		const database = $shared.use<CEM.SharedDatabase>("database");
		const animap = $shared.use<CEM.AnimapStore>("animap");
		const thumbnails = $shared.use<CEM.ThumbnailStore>("thumbnails");

		const stillImageSize = $getUserPreference("image-size");

		/**
		 * The TMDB API Read Access Token (a JWT, "eyJ..."), or "": only the token is taken. It goes in the Authorization
		 * header, so it never shows up in a URL or the logs, where an API key would.
		 */
		const tmdbSetting = `${$getUserPreference("tmdb-api") ?? ""}`.trim();
		const tokenPrint = $shared.use<(token: string) => string>("tokenPrint")(tmdbSetting);
		/** TMDB's answer to the token (see checkToken), kept by its fingerprint */
		const tokenVerdict = $storage.get<{ print: string; ok: boolean }>("CEM_TMDB_TOKEN_CHECK");
		const TOKEN_REJECTED = "TMDB rejected the API Read Access Token in the plugin settings";
		/** Why TMDB can't be used, or "" */
		function tokenProblem() {
			if (!tmdbSetting) return "no TMDB API Read Access Token in the plugin settings";
			if (!/^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(tmdbSetting)) {
				if (/^[0-9a-f]{32}$/i.test(tmdbSetting)) return "the TMDB setting holds an API key, not the API Read Access Token (eyJ…)";
				return "the TMDB setting isn't an API Read Access Token (eyJ…)";
			}
			if (tokenVerdict?.print === tokenPrint && !tokenVerdict.ok) return TOKEN_REJECTED;
			return "";
		}
		let tmdbMissing = tokenProblem();
		const tmdbToken = tmdbMissing ? "" : tmdbSetting;

		/**
		 * The automatic matches, TMDB's (a token, and the stills or the fill-in on) and AniDB's (its lookup on), are made and
		 * used only while their switch is on; switched off they stay stored, unused. By hand, AniDB can always be filled in
		 * (Auto-fill) and overridden, TMDB whenever there's a token.
		 */
		const tmdbOn = () => !!tmdb.API_KEY && (isOn("tmdb-thumbnails") || isOn("tmdb-fill-missing"));

		// The stills and the fill-in are off unless switched on
		const isOn = (name: "tmdb-thumbnails" | "tmdb-fill-missing") => $getUserPreference(name) === "true";
		/** On unless switched off (also when the setting doesn't exist yet). */
		const anidbLookup = () => $getUserPreference("anidb-lookup") !== "false";
		const hasCustom = (mediaId: number) => Object.keys(database.get(mediaId).data).length > 0;
		/** Seanime has no metadata for this anime and TMDB should fill it in. */
		const fillsMissing = (mediaId: number) => isOn("tmdb-fill-missing") && !!animap.get(mediaId)?.fallback;
		/** Episodes whose overview or thumbnail Seanime's own metadata lacks, as the metadata hook last saw them. */
		const gapKeys = (mediaId: number) => {
			type Kept = { metadata?: { episodes?: Record<string, { gap?: boolean }> } };
			const episodes = storeJson<Kept>(`CEM_META_${mediaId}`, {}).metadata?.episodes ?? {};
			return Object.keys(episodes).filter((k) => episodes[k]?.gap);
		};
		/**
		 * Whether this anime needs a TMDB match at all. Fill-in matches every anime, like the stills: whether an episode
		 * lacks anything (an overview, a thumbnail, the whole episode) only shows once TMDB's episodes are known.
		 */
		const wantsMatch = (_mediaId: number) => tmdbOn();
		const currentMedia = ctx.state<{ id: number; banner: string; title: string; type: "tv" | "movie" } | null>(null);
		const currEditedEp = ctx.state<CEM.CustomEpisodeMetadata | null>(null);

		const tmdb = {
			API_KEY: tmdbToken,
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
				url.searchParams.set("language", "en-US");
				const get = () => ctx.fetch(url.toString(), { headers: { Authorization: `Bearer ${tmdb.API_KEY}`, Accept: "application/json" } });

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
					const both = [...oldData.episodeOverrides, ...(override.episodeOverrides ?? [])];
					const episodeOverridesMap = new Map(both.map((o) => [o.aniDBEpisode, o]));

					records[mediaId] = overwrite
						? { mediaId, episodeOverrides: [], ...override }
						: { ...oldData, ...override, episodeOverrides: Array.from(episodeOverridesMap.values()) };

					$storage.set(tmdb.overrides.__id__, records);
				},
				hasEpisode: (mediaId: number, aniDBEpisode: string) =>
					tmdb.overrides.get(mediaId).episodeOverrides.some((e) => e.aniDBEpisode === aniDBEpisode),
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
						anidbId: ctx.fieldRef<string>(""),
						anidbEpisode: ctx.fieldRef<string>(""),
					},
					/** The fields' text for a saved episode override */
					values: (data: CEM.TMDBOverrides["episodeOverrides"][number]): Record<string, string> => ({
						tmdbId: data.tmdbNone ? "none" : formatTmdbId(data.tmdbId, data.tmdbType),
						tmdbSeason: data.tmdbSeason?.toString() ?? "",
						tmdbEpisode: data.tmdbEpisode?.toString() ?? "",
						anidbId: data.anidbNone ? "none" : data.anidbId?.toString() ?? "",
						anidbEpisode: data.anidbEpisode ?? "",
					}),
					fill: (data: CEM.TMDBOverrides["episodeOverrides"][number]) => {
						const refs: Record<string, $ui.FieldRef<string>> = tmdb.overrides.episode.fieldRefs;
						for (const [k, v] of Object.entries(tmdb.overrides.episode.values(data))) refs[k].setValue(v);
					},
					resetFieldRefs: () => Object.values(tmdb.overrides.episode.fieldRefs).forEach((fr) => fr.setValue("")),
					/** placeholderAid: the anime's AniDB ID in use, for an AniDB Episode entered without an AniDB ID */
					save: async (mediaId: number, aniDBEpisode: string, placeholderAid: string) => {
						const refs = tmdb.overrides.episode.fieldRefs;
						const update: CEM.TMDBOverrides["episodeOverrides"][number] = {};
						const tmdbSeason = refs.tmdbSeason.current;
						const tmdbEpisode = refs.tmdbEpisode.current;

						if (noneIn(refs, NONE_FIELDS.episode.tmdb)) update.tmdbNone = true;
						else {
							readTmdbIdField(refs.tmdbId.current, update);
							if (update.tmdbType === "movie" && (tmdbSeason.trim() || tmdbEpisode.trim()))
								throw new Error("A TMDB movie is one episode: clear the TMDB Season and Episode, or enter a show's ID (s<id>).");
							if (tmdbSeason.length && !isNaN(Number(tmdbSeason))) update.tmdbSeason = Number(tmdbSeason);
							if (tmdbEpisode.length && !isNaN(Number(tmdbEpisode))) update.tmdbEpisode = Number(tmdbEpisode);
						}

						// AniDB: both fields or neither (the ID defaults to the anime's), checked against AniDB's episode list
						const aidText = refs.anidbId.current.trim();
						const epText = refs.anidbEpisode.current.trim().toUpperCase();
						if (noneIn(refs, NONE_FIELDS.episode.anidb)) update.anidbNone = true;
						else if (aidText || epText) {
							const aid = Number(aidText || placeholderAid);
							if (!Number.isInteger(aid) || aid < 1)
								throw new Error(
									aidText ? `AniDB ID "${aidText}" isn't a number.` : "Enter the AniDB ID too: this anime has none yet.",
								);
							if (!new RegExp(`^[${ANIDB_LETTERS}]?\\d+$`).test(epText))
								throw new Error(`AniDB Episode "${epText}" isn't an episode like "12", or a lettered one (${ANIDB_LETTER_LIST}).`);
							const letter = /^\d/.test(epText) ? "" : epText[0];
							let anime = await anidbAnime(aid);
							// An entry cached before every lettered type was kept: fetched again for them
							if (letter && letter !== "S" && anime && !anime.lettered) anime = await anidbAnime(aid, true);
							if (anime === undefined) throw new Error("Couldn't reach AniDB right now: try saving again in a minute.");
							if (anime === null) throw new Error(`AniDB has no anime ${aid}.`);
							const list = !letter ? anime.main : letter === "S" ? anime.specials ?? [] : anime.lettered?.[letter] ?? [];
							const ep = list.find((x) => x.n === Number(epText.replace(/^[A-Z]/, "")));
							if (!ep) throw new Error(`AniDB ${aid} has no episode ${epText}.`);
							const { eid, n: _n, ...data } = ep;
							Object.assign(update, { anidbId: aid, anidbEpisode: epText, anidbEid: eid });
							if (Object.keys(data).length) update.anidb = data;
						}

						tmdb.overrides.set(mediaId, { episodeOverrides: [{ aniDBEpisode, ...update }] });
					},
				},
				media: {
					fieldRefs: {
						tmdbId: ctx.fieldRef<string>(""),
						tmdbEpisodes: ctx.fieldRef<string>(""),
						anidbId: ctx.fieldRef<string>(""),
						anidbEpisodes: ctx.fieldRef<string>(""),
					},
					ignoreWarnings: ctx.fieldRef<boolean>(false),
					/** The fields' text for a saved media override */
					values: (data: Omit<CEM.TMDBOverrides, "mediaId" | "episodeOverrides">): Record<string, string> => ({
						tmdbId: data.tmdbNone ? "none" : formatTmdbId(data.tmdbId, data.tmdbType),
						tmdbEpisodes: formatTmdbEpisodes(data),
						anidbId: data.anidbNone ? "none" : data.anidbId?.toString() ?? "",
						anidbEpisodes: formatAnidbEpisodes({ offset: data.anidbOffset, specials: data.anidbSpecials, letter: data.anidbLetter }),
					}),
					fill: (data: Omit<CEM.TMDBOverrides, "mediaId" | "episodeOverrides">) => {
						const refs: Record<string, $ui.FieldRef<string>> = tmdb.overrides.media.fieldRefs;
						for (const [k, v] of Object.entries(tmdb.overrides.media.values(data))) refs[k].setValue(v);
					},
					resetFieldRefs: () => Object.values(tmdb.overrides.media.fieldRefs).forEach((fr) => fr.setValue("")),
					save: (mediaId: number) => {
						const update: Omit<CEM.TMDBOverrides, "mediaId" | "episodeOverrides"> = {};
						const refs = tmdb.overrides.media.fieldRefs;
						// An ID field left empty shows the ID in use (greyed out): episodes entered without an ID are that one's
						const shown = autoPlaceholders(mediaId, null);
						const tmdbEpisodes = refs.tmdbEpisodes.current.trim();
						if (noneIn(refs, NONE_FIELDS.media.tmdb)) update.tmdbNone = true;
						else {
							readTmdbIdField(refs.tmdbId.current, update);
							if (tmdbEpisodes) {
								if (update.tmdbType === "movie")
									throw new Error("A TMDB movie has no seasons: clear the TMDB Episodes, or enter a show's ID (s<id>).");
								const episodes = parseTmdbEpisodes(tmdbEpisodes);
								if (typeof episodes === "string") throw new Error(`TMDB Episodes: ${episodes}`);
								Object.assign(update, episodes);
								if (update.tmdbId === undefined && shown.tmdbId) readTmdbIdField(shown.tmdbId, update);
							}
						}
						if (noneIn(refs, NONE_FIELDS.media.anidb)) update.anidbNone = true;
						else {
							const anidbId = Number(refs.anidbId.current.trim());
							if (Number.isInteger(anidbId) && anidbId > 0) update.anidbId = anidbId;
							const anidbEpisodes = refs.anidbEpisodes.current.trim();
							if (anidbEpisodes) {
								const episodes = parseAnidbEpisodes(anidbEpisodes);
								if (typeof episodes === "string") throw new Error(`AniDB Episodes: ${episodes}`);
								if (episodes.offset) update.anidbOffset = episodes.offset;
								if (episodes.specials) update.anidbSpecials = true;
								if (episodes.letter) update.anidbLetter = episodes.letter;
								if (!update.anidbId) {
									if (!Number(shown.anidbId)) throw new Error("Enter the AniDB ID too: this anime has none yet.");
									update.anidbId = Number(shown.anidbId);
								}
							}
						}

						// Overwrite so a cleared field actually removes the old value
						const { episodeOverrides, ignoreWarnings } = tmdb.overrides.get(mediaId);
						if (ignoreWarnings) update.ignoreWarnings = true;
						tmdb.overrides.set(mediaId, { ...update, episodeOverrides }, true);
					},
				},
			},
		};

		// ----------------------------------------------------------------------------------------------------------------
		// 3. Seanime's metadata: reading it (or the copy the hooks keep), Animap, and the episode list for anime it has no entry for
		// ----------------------------------------------------------------------------------------------------------------
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
			if (!isCustomSource(mediaId)) {
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
			if (known && !fresh && Date.now() - known.at < ANIMAP_PROBE_KEEP) return known.has;
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
					log.warn(
						"The plugin can't ask Animap directly (anime.clap.ing isn't in the manifest's allowed domains); " +
							"update the plugin's manifest. Until then a failed metadata request can crash Seanime:",
						e,
					);
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
		const tmdbImage = $shared.use<(path: string) => string>("tmdbImage");
		const fallbackSupply = $shared.use<(mediaId: number) => CEM.FallbackSupply | null>("fallbackSupply");

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
			if (isCustomSource(mediaId)) return; // custom sources provide their own metadata

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

		/**
		 * Find out once whether Seanime has metadata for this anime at all, when something depends on it: the TMDB
		 * fill-in, the AniDB lookup, or an AniDB ID override (which applies even with the lookup off).
		 */
		async function detectMissing(mediaId: number) {
			if (animap.get(mediaId) || isCustomSource(mediaId)) return;
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

		// ----------------------------------------------------------------------------------------------------------------
		// 4. Tray: the custom episode list, the episode editor, and the widgets the overrides modal shares
		// ----------------------------------------------------------------------------------------------------------------
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
				Object.entries(fieldRefs.data).forEach(([k, fieldRef]) => {
					fieldRef.setValue((data[k as keyof typeof fieldRefs.data] ?? "").toString());
				}),
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
					if (!/^https?:\/\/\S+$/i.test(image)) throw new Error(`Field image is invalid. Please enter an http(s) URL without spaces.`);
					update.image = image;
				}

				// hasImage only with an image: without one, Seanime's own thumbnail (and its flag) stays
				if (update.image) update.hasImage = true;
				database.save(mediaId, update);
			},
		};

		/**
		 * A delete waiting to be confirmed ("episode": the editor's, "all": Delete All), drawn over the whole tray rather
		 * than as a modal. Answered, it stays in place, invisible and click-through, until the editor or the tray opens
		 * again: the button just pressed vanishing would drop focus and close the tray on a phone (see actionButton).
		 */
		const confirming = ctx.state<{ which: "episode" | "all"; done: boolean } | null>(null);

		/** The tray away from an anime's page */
		function trayIntro() {
			return tray.flex(
				[
					tray.div([], {
						className: "w-10 h-10 bg-center bg-contain bg-no-repeat",
						style: { backgroundImage: `url(${iconUrl})` },
					}),
					tray.stack(
						[
							tray.text("Missing Metadata Fix", { className: "text-lg font-bold" }),
							tray.text("Navigate to an anime page to edit their episode metadata.", {
								className: "text-sm text-[--muted] break-normal",
							}),
						],
						{ gap: 0 },
					),
				],
				{ className: "p-2" },
			);
		}

		/** The episode editor: the custom metadata fields, then Auto-fill, Overrides, Delete and Save */
		function episodeEditor(media: ShownMedia, episode: CEM.CustomEpisodeMetadata) {
			const fields = [
				["Episode Title", "title"],
				["Duration (minutes)", "length"],
				["Airdate (yyyy-mm-dd)", "airDate"],
				["Overview", "overview"],
				["Image URL", "image"],
			] as const;
			const input = (label: string, field: (typeof fields)[number][1]) =>
				styledInput(
					label,
					{
						fieldRef: fieldRefs.data[field],
						disabled: !!tmdb.isFetching.get(),
						...(field === "overview" ? { textarea: true, style: { resize: "none" } } : {}),
					},
					EDITOR_LABEL_WIDTH,
				);
			return [
				tray.stack(
					fields.map(([label, field]) => tray.stack([input(label, field)])),
					{ className: "flex-1" },
				),
				tray.flex([
					tray.tooltip(
						actionButton(`episode-autofill-${media.id}`, "Auto-fill", {}, () => runEpisodeAutoFill(media.id, episode.episode)),
						{ text: tmdbOn() ? "Autofill from AniDB and TMDB" : "Autofill from AniDB" },
					),
					overridesModal(media, episode.episode),
					tray.div([], { className: "flex-1" }),
					tray.button("Delete", {
						intent: "alert",
						size: "md",
						// Only with something saved to delete; it sits next to Save, so it asks first (see confirmCover)
						style: { display: database.get(media.id).data[episode.episode] ? "block" : "none" },
						onClick: ctx.eventHandler(`del-${media.id}`, () => confirming.set({ which: "episode", done: false })),
					}),
					withDot(
						tray.button("Save", {
							intent: "primary",
							size: "md",
							onClick: ctx.eventHandler(`save-${media.id}`, () => saveCustomEpisode(media.id, episode.episode)),
						}),
						unsaved.get().editor,
						"bg-blue-500",
					),
				]),
				progressLine("episode-autofill-"),
			];
		}

		/** The episode editor's Auto-fill: fills the fields (see episodeAutoFill) without saving */
		async function runEpisodeAutoFill(mediaId: number, key: string) {
			try {
				log.mark(`Episode Auto-fill: ${mediaId} episode ${key}`);
				const { data, from } = await episodeAutoFill(mediaId, key);
				for (const [k, v] of Object.entries(data)) {
					if (v !== undefined && v !== "") fieldRefs.data[k as keyof typeof data].setValue(`${v}`);
				}
				checkUnsaved();
				const names: Record<string, string> = {
					title: "title", length: "duration", airDate: "air date", overview: "overview", image: "image",
				};
				const filled = Object.keys(data).map((k) => names[k]).join(", ");
				ctx.toast.success(`Filled the ${filled} from ${from.join(" and ")}. Review and press Save.`);
			} catch (e) {
				log.step(`${mediaId}: episode Auto-fill found nothing: ${(e as Error).message}`);
				ctx.toast.error((e as Error).message);
			}
		}

		/**
		 * The episode editor's Auto-fill: this episode's data from the anime's TMDB match and AniDB match, found the same
		 * way as everywhere else (a refresh when they're out of date), or its own override's show or movie. TMDB first,
		 * AniDB's English title, air date and length where TMDB has none. Throws when neither has anything.
		 */
		async function episodeAutoFill(mediaId: number, key: string) {
			const data: { title?: string; length?: string; airDate?: string; overview?: string; image?: string } = {};
			const from: string[] = [];
			let why = "";
			// An episode pointing at its own show or movie needs no match for the anime, nor the switches (by hand)
			const override = tmdb.overrides.get(mediaId);
			const ownOverride = override.episodeOverrides.filter((o) => o.aniDBEpisode === key && o.tmdbId);
			const own = tmdb.API_KEY ? overrideEpisodes({ ...override, episodeOverrides: ownOverride }, {}, undefined)[key] : undefined;
			const noneHere = override.episodeOverrides.some((o) => o.aniDBEpisode === key && o.tmdbNone);
			if (noneHere || (override.tmdbNone && !own)) why = "TMDB is set to none in your overrides";
			else if (own || tmdbOn()) {
				let record: CEM.ThumbnailRecord | undefined;
				if (!own) {
					try {
						await refreshAnime(mediaId, false);
					} catch (e) {
						why = (e as Error).message;
					}
					record = thumbnails.get(mediaId);
				}
				// A failed match still has the episodes their overrides point at
				const target = own ?? record?.map[key];
				if (record?.status === "failed" && !target) why = record.reason ?? "no TMDB match";
				const ep = target ? await tmdbSession().episode(target) : undefined;
				if (ep) {
					if (plainTitle(ep.name)) data.title = ep.name;
					if (ep.runtime) data.length = `${ep.runtime}`;
					if (ep.air_date) data.airDate = ep.air_date;
					if (ep.overview) data.overview = ep.overview;
					if (ep.still_path) data.image = tmdbImage(ep.still_path);
					from.push(target?.movie ? `TMDB movie ${target.tmdbId}` : `TMDB S${target?.season}E${target?.episode}`);
				} else if (target) {
					const where = target.movie ? `movie ${target.tmdbId}` : `S${target.season}E${target.episode} on ${target.tmdbId}`;
					why = `TMDB has no ${where}`;
				} else if (record?.status === "matched") why = `TMDB's match has no episode ${key}`;
			} else why = tmdbMissing || "TMDB stills and fill-in are off";
			if (await needsAnidb(mediaId)) await refreshAnidb(mediaId).catch((e) => log.debug(`${mediaId}: AniDB lookup for Auto-fill failed:`, e));
			const ep = anidbEpisodes(mediaId)[key];
			const before = Object.keys(data).length;
			if (ep?.title && !data.title && plainTitle(ep.title)) data.title = ep.title;
			if (ep?.length && !data.length) data.length = `${ep.length}`;
			if (ep?.summary && !data.overview) data.overview = ep.summary;
			// AniDB's air dates come first, as everywhere else
			if (ep?.airDate && ep.airDate !== data.airDate) data.airDate = ep.airDate;
			if (Object.keys(data).length > before)
				from.push(`AniDB ${override.episodeOverrides.find((o) => o.aniDBEpisode === key)?.anidbId ?? anidbStore.get(mediaId)?.aid}`);
			if (!from.length) throw new Error(`Nothing to fill for episode ${key}${why ? `: ${why}` : ""}.`);
			return { data, from };
		}

		/** The episode editor's Save */
		async function saveCustomEpisode(mediaId: number, key: string) {
			try {
				fieldRefs.save(mediaId, key);
				// The editor stays open with what was saved (Delete shows for it)
				currEditedEp.set(database.get(mediaId).data[key] ?? { episode: key });
				checkUnsaved();
				await customChanged(mediaId, "Successfully saved episode metadata!");
			} catch (err) {
				ctx.toast.error((err as Error).message);
			}
		}

		/** Seanime's queries for the open entry page, refreshed after the custom metadata changes */
		const ENTRY_QUERIES = ["ANIME-ENTRIES-get-anime-entry", "ANIME-get-anime-episode-collection"];
		/**
		 * After the custom metadata changed: re-check Animap (an anime may no longer need the plugin's episode list), then
		 * refresh the page under the tray
		 */
		async function customChanged(mediaId: number, message: string) {
			tray.update();
			await checkAnimap(mediaId);
			ctx.setTimeout(() => {
				$app.invalidateClientQuery(ENTRY_QUERIES);
				ctx.toast.success(message);
			}, 500);
		}

		/** The anime's episodes with custom metadata, each with the fields saved and a Delete; Overrides and Delete All above */
		function customEpisodeList(media: ShownMedia) {
			const customEps = Object.values(database.get(media.id)?.data ?? {});
			const row = (cem: CEM.CustomEpisodeMetadata) =>
				tray.flex(
					[
						tray.text(`E${cem.episode}`, { className: "w-16 text-center font-semibold" }),
						// The fields saved (hasImage is bookkeeping); none: Seanime's own data, nothing filled in
						tray.text(
							Object.keys(cem)
								.filter((x) => x !== "episode" && x !== "hasImage")
								.sort()
								.join(", ") || "none (Seanime's own data)",
							{ className: "flex-1 text-sm text-[--muted]" },
						),
						tray.button("Delete", {
							intent: "alert",
							onClick: ctx.eventHandler(`cem-${media.id}-${cem.episode}`, async () => {
								database.delete(media.id, cem.episode);
								await customChanged(media.id, `Removed custom metadata for episode "${cem.episode}"!`);
							}),
						}),
					],
					{ className: "justify-center items-center" },
				);
			const deleteAll = () =>
				tray.button("Delete All", {
					intent: "alert",
					onClick: ctx.eventHandler(`cem-del-all-${media.id}`, () => confirming.set({ which: "all", done: false })),
				});
			return tray.div(
				[
					tray.flex(
						[
							tray.text("Episode", { className: "text-sm font-bold w-16" }),
							tray.text("Custom Fields", { className: "text-sm font-bold flex-1" }),
							overridesModal(media, null, problemText(problems(media.id))),
							...(customEps.length ? [deleteAll()] : []),
						],
						{ className: "items-center" },
					),
					tray.div(customEps.sort((a, b) => Number(a.episode) - Number(b.episode)).map(row), { className: "space-y-2" }),
					// Nothing listed: the note in the middle of the box
					...(customEps.length
						? []
						: [
								tray.div(
									[
										tray.text("No custom episode metadata for this anime.", {
											className: "font-semibold text-[--muted] text-center",
										}),
									],
									{ className: "flex flex-1 items-center justify-center" },
								),
							]),
				],
				{ className: "flex flex-col gap-2 p-2 border rounded-xl bg-gray-800 overflow-scroll", style: { height: "24rem" } },
			);
		}
		function confirmCover(media: NonNullable<ReturnType<typeof currentMedia.get>>, episode: CEM.CustomEpisodeMetadata | null) {
			const c = confirming.get();
			if (!c) return tray.div([], { style: { display: "none" } });
			const all = c.which === "all";
			const answer = (run?: () => Promise<void>) => async () => {
				confirming.set({ ...c, done: true });
				await run?.();
			};
			const remove = answer(async () => {
				if (all) {
					Object.values(database.get(media.id).data).forEach((cem) => database.delete(media.id, cem.episode));
					return customChanged(media.id, `Removed all custom metadata for ${media.title}!`);
				}
				if (!episode) return;
				database.delete(media.id, episode.episode);
				// The editor stays open, its fields emptied
				currEditedEp.set({ episode: episode.episode });
				await customChanged(media.id, "Successfully removed episode metadata!");
			});
			return tray.div(
				[
					tray.div(
						[
							tray.text(all ? "Delete all custom metadata?" : `Delete episode ${episode?.episode}'s custom metadata?`, {
								className: "font-semibold",
							}),
							tray.text(
								all
									? `Everything you saved for ${media.title}'s episodes is removed.`
									: "Everything you saved for this episode is removed.",
								{ className: "text-sm text-[--muted] break-normal text-pretty" },
							),
							tray.flex(
								[
									tray.button("Cancel", {
										intent: "gray-subtle",
										size: "md",
										onClick: ctx.eventHandler("confirm-cancel", answer()),
									}),
									tray.button("Delete", {
										intent: "alert",
										size: "md",
										onClick: ctx.eventHandler(`confirm-delete-${media.id}`, remove),
									}),
								],
								{ className: "justify-end" },
							),
						],
						{ className: "flex flex-col gap-3 p-4 border rounded-xl bg-[--paper] w-full", style: { maxWidth: "22rem" } },
					),
				],
				{
					className: "absolute flex items-center justify-center rounded-xl p-4",
					// Over the tray's padding too, like the banner
					style: {
						top: "-0.75rem",
						left: "-0.75rem",
						width: "calc(100% + 1.5rem)",
						height: "calc(100% + 1.5rem)",
						zIndex: "10",
						background: "rgb(0 0 0 / 0.7)",
						backdropFilter: "blur(2px)",
						...(c.done ? { opacity: "0", pointerEvents: "none" } : {}),
					},
				},
			);
		}

		function isAnimeEpisode(ep: $app.Anime_Episode | $app.Onlinestream_Episode, type: string): ep is $app.Anime_Episode {
			return type !== "onlinestream";
		}

		function withBanner(banner: string, cover: any, container: any[]) {
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

			return tray.div([bannerDiv, tray.div(container, { style: { position: "relative", height: "100%" } }), cover], {
				style: { position: "relative", height: "33.5rem" },
			});
		}

		/** Label widths: the overrides modal's fields, the episode editor's */
		const MODAL_LABEL_WIDTH = "8rem";
		const EDITOR_LABEL_WIDTH = "11.5rem";

		/** An input with its label as a block on the left, all labels of a group as wide (labelWidth) so the inputs line up. */
		function styledInput(
			label: string,
			params: Parameters<NonNullable<$ui.Tray["input"]>>[1] & { placeholder?: string },
			labelWidth = MODAL_LABEL_WIDTH,
		) {
			return tray.flex(
				[
					tray.text(label, {
						className: "flex items-center whitespace-nowrap px-3 bg-gray-800 rounded-l-xl border text-sm",
						style: {
							opacity: params?.disabled ? "0.5" : "1",
							marginRight: "-1px", width: labelWidth, minWidth: labelWidth, flexShrink: "0",
						},
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

		/**
		 * A button running a TMDB/AniDB action. While one runs the others are disabled, but never the one clicked: on a
		 * phone Seanime's trays sit in a focus-trapping popover, and a focused button turning disabled drops focus to the
		 * page; the popover's trap then takes focus back on its next re-render (every debug line of a development plugin,
		 * a badge change), and the tray, losing focus, closes with the overrides modal in it. Seanime's loading state
		 * disables the button too, so actionCss draws its spinner and disabled look instead.
		 */
		function actionButton(
			id: string,
			label: string,
			props: { intent?: $ui.Intent; className?: string; disabled?: boolean },
			run: () => Promise<unknown>,
		) {
			const running = tmdb.isFetching.get();
			const intent = props.intent ?? "white";
			return tray.button(label, {
				size: "md",
				...props,
				intent,
				className: [props.className, "cem-action", `cem-${intent}`, running === id ? "cem-busy" : ""].filter(Boolean).join(" "),
				disabled: !!props.disabled || (!!running && running !== id),
				onClick: ctx.eventHandler(id, async () => {
					if (tmdb.isFetching.get()) return;
					tmdb.setFetching(id);
					progress.set({ mediaId: Number(id.split("-").pop()), step: 0, text: "", shown: false });
					const stop = ctx.setTimeout(() => {
						const now = progress.get();
						if (now) progress.set({ ...now, shown: true });
					}, 1000);
					try {
						await run();
					} finally {
						stop();
						progress.set(null);
						tmdb.setFetching("");
					}
				}),
			});
		}

		/**
		 * Styles for actionButton, ahead of what holds the buttons (tray.css only reaches the components after it). Each
		 * browser applies them for itself, so a phone and a desktop showing the same tray each get theirs:
		 * - the running button looks like Seanime's loading one (spinner, disabled look) without being disabled
		 * - on a touchscreen (no hover) a tapped button keeps its hover colour until something else is tapped: there the
		 *   hover colour is the button's own
		 * - a status line's blip and lead that open its steps (see statusLine): inline although Seanime wraps a modal's
		 *   trigger in a div; the blip's halo still under reduced motion
		 */
		const SPINNER = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1792"><path d="M526 1394q0 53-37.5 90.5t-90.5 37.5q-52 0-90-38t-38-90q0-53 37.5-90.5t90.5-37.5 90.5 37.5 37.5 90.5zm498 206q0 53-37.5 90.5t-90.5 37.5-90.5-37.5-37.5-90.5 37.5-90.5 90.5-37.5 90.5 37.5 37.5 90.5zm-704-704q0 53-37.5 90.5t-90.5 37.5-90.5-37.5-37.5-90.5 37.5-90.5 90.5-37.5 90.5 37.5 37.5 90.5zm1202 498q0 52-38 90t-90 38q-53 0-90.5-37.5t-37.5-90.5 37.5-90.5 90.5-37.5 90.5 37.5 37.5 90.5zm-964-996q0 66-47 113t-113 47-113-47-47-113 47-113 113-47 113 47 47 113zm1170 498q0 53-37.5 90.5t-90.5 37.5-90.5-37.5-37.5-90.5 37.5-90.5 90.5-37.5 90.5 37.5 37.5 90.5zm-640-704q0 80-56 136t-136 56-136-56-56-136 56-136 136-56 136 56 56 136zm530 206q0 93-66 158.5t-158 65.5q-93 0-158.5-65.5t-65.5-158.5q0-92 65.5-158t158.5-66q92 0 158 66t66 158z"/></svg>')}")`;
		const actionCss = () =>
			tray.css(
				".cem-busy { opacity: .5 !important; pointer-events: none !important; }" +
					// Seanime's loading spinner (its Button's), in the text colour
					`.cem-busy::before { content: ""; width: 15px; height: 15px; margin-inline-end: .5rem; flex-shrink: 0; ` +
					`background-color: currentColor; -webkit-mask: ${SPINNER} center / contain no-repeat; ` +
					`mask: ${SPINNER} center / contain no-repeat; animation: spin 1s linear infinite; }` +
					".cem-line > div, .cem-trigger { display: inline; }" +
					"@media (prefers-reduced-motion: reduce) { .cem-line .animate-ping { animation: none; opacity: 0 !important; } }" +
					"@media (hover: none) { .cem-white:hover { background-color: #fff !important; } " +
					".cem-success-subtle:hover { --tw-bg-opacity: .1 !important; } }",
			);

		/**
		 * A notification dot on a button's corner, its halo pinging (still under reduced motion). The same components either
		 * way, the dot only hidden: a changed trigger would remount a modal, closing it (after a refresh, say). With room,
		 * the button moves left while the dot shows, by as far as the halo reaches past it: by the tray's edge each ping
		 * widened the tray, flashing a scrollbar.
		 */
		function withDot(button: any, show: boolean, color: string, room = false) {
			const dot = {
				position: "absolute", top: "-0.25rem", right: "-0.25rem", width: "0.625rem", height: "0.625rem",
				display: show ? "block" : "none",
			};
			return tray.div(
				[
					tray.css("@media (prefers-reduced-motion: reduce) { .animate-ping { animation: none; opacity: 0; } }"),
					button,
					tray.div([], { className: `rounded-full ${color} animate-ping pointer-events-none`, style: { ...dot, opacity: "0.75" } }),
					tray.div([], { className: `rounded-full ${color} pointer-events-none`, style: dot }),
				],
				{ className: "relative w-fit", style: show && room ? { marginRight: "0.5625rem" } : {} },
			);
		}

		/**
		 * What a running action (Refresh, Auto-fill, Bulk Update) is looking at, numbered, for the line under it. Shown once
		 * the action has run a second, so a quick one doesn't flash it. Only its own anime's steps count: background
		 * refreshes of other anime run alongside.
		 */
		const progress = ctx.state<{ mediaId: number; step: number; text: string; shown: boolean } | null>(null);
		function report(mediaId: number, text: string) {
			const now = progress.get();
			if (now?.mediaId === mediaId) progress.set({ ...now, step: now.step + 1, text });
		}
		/**
		 * The progress line for the actions whose IDs start with one of these. Always there and one line high, cut short
		 * with an ellipsis, so the modal neither remounts nor changes height when it shows or its text grows.
		 */
		function progressLine(...prefixes: string[]) {
			const now = progress.get();
			const running = tmdb.isFetching.get();
			const visible = !!now?.shown && now.step > 0 && prefixes.some((p) => running.startsWith(p));
			// width 0 and min-width 100%: it fills the row without its unwrapped text widening the modal (which squeezed
			// the text around it into wrapping)
			return tray.text(visible ? `Step ${now!.step}: ${now!.text}` : "\u00a0", {
				className: "text-xs text-[--muted]",
				style: {
					visibility: visible ? "visible" : "hidden",
					whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", width: "0", minWidth: "100%",
				},
			});
		}

		// ----------------------------------------------------------------------------------------------------------------
		// 5. Overrides: the fields and their syntax, the overrides modal and its tabs, Auto-fill, Bulk Update, the status lines and badge
		// ----------------------------------------------------------------------------------------------------------------
		/**
		 * A TMDB ID as entered, Shoko's way: "s1429" a show, "m371371" a movie; also a TMDB page link or a plain number. TV
		 * and movie IDs overlap (s1429 is Attack on Titan, m1429 25th Hour), so a plain number is tried as the type the
		 * anime's format suggests first.
		 */
		function parseTmdbId(value: string): { id: number; type?: "tv" | "movie" } | undefined {
			const v = value.trim();
			const prefixed = v.match(/^([sm])\s*(\d+)$/i);
			if (prefixed) {
				if (!Number(prefixed[2])) return undefined;
				return { id: Number(prefixed[2]), type: prefixed[1].toLowerCase() === "m" ? "movie" : "tv" };
			}
			const m = v.match(/^(?:.*?\b(tv|movie)\/)?(\d+)(?:\D.*)?$/i);
			if (!m || !Number(m[2])) return undefined;
			return { id: Number(m[2]), ...(m[1] ? { type: m[1].toLowerCase() as "tv" | "movie" } : {}) };
		}
		const formatTmdbId = (id: number | undefined, type?: "tv" | "movie") => {
			if (!id) return "";
			return `${type === "movie" ? "m" : type === "tv" ? "s" : ""}${id}`;
		};
		/**
		 * Each tab's override fields by source: "none" in any of them leaves that source out for the anime (or episode),
		 * saved as the ID field's "none", the others empty and off
		 */
		const NONE_FIELDS = {
			media: { tmdb: ["tmdbId", "tmdbEpisodes"], anidb: ["anidbId", "anidbEpisodes"] },
			episode: { tmdb: ["tmdbId", "tmdbSeason", "tmdbEpisode"], anidb: ["anidbId", "anidbEpisode"] },
		};
		const isNone = (value: string) => value.trim().toLowerCase() === "none";
		/** The letters AniDB numbers its episode types with: specials, credits (openings, endings), trailers, parodies, other */
		const ANIDB_LETTERS = "SCTPO";
		const ANIDB_LETTER_LIST = "S1 specials, C1 credits, T1 trailers, P1 parodies, O1 other";
		const noneIn = (refs: Record<string, $ui.FieldRef<string>>, keys: string[]) => keys.some((k) => isNone(refs[k].current));
		/** The TMDB ID field of an override into the override; throws on one that isn't an ID */
		function readTmdbIdField(value: string, update: { tmdbId?: number; tmdbType?: "tv" | "movie" }) {
			if (!value.trim().length) return;
			const parsed = parseTmdbId(value);
			if (!parsed) throw new Error(`TMDB ID "${value}" isn't an ID like s1429 (a show), m371371 (a movie) or a TMDB link.`);
			update.tmdbId = parsed.id;
			if (parsed.type) update.tmdbType = parsed.type;
		}
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
		/**
		 * Episode ranges as entered in the Season field: "S1E2-S1E4", "S1E7", "S1E6-S2" (to the end of season 2), "S3" (all
		 * of season 3), "S1E1-5", "S0E66-S0E68" (specials: TMDB's season 0 comes first). They must follow TMDB's order
		 * without overlapping.
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
				let toEpisode: number | undefined;
				if (dash) toEpisode = m[4] !== undefined ? Number(m[4]) : undefined;
				else if (m[2] !== undefined) toEpisode = episode;
				if (episode < 1 || (toEpisode !== undefined && toEpisode < 1)) return `"${part}": episodes start at 1.`;
				const backwards = toSeason < season || (toSeason === season && toEpisode !== undefined && toEpisode < episode);
				if (backwards) return `"${part}" ends before it starts.`;
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
		/** [1, 2, 3, 4, 6] -> "1-4, 6", or with a prefix ("S") before each number "S1-S4, S6" */
		function formatSeasons(seasons: number[], prefix = "") {
			const parts: string[] = [];
			const n = (i: number) => `${prefix}${seasons[i]}`;
			for (let i = 0; i < seasons.length; i++) {
				let j = i;
				while (j + 1 < seasons.length && seasons[j + 1] === seasons[j] + 1) j++;
				parts.push(j > i + 1 ? `${n(i)}-${n(j)}` : j === i + 1 ? `${n(i)}, ${n(j)}` : n(i));
				i = j;
			}
			return parts.join(", ");
		}
		/**
		 * The Media tab's TMDB Episodes field: a season ("S2"), seasons read as one run ("S1-S4, S6"), where episode 1 lands
		 * ("S6E2": the old season and offset) or ranges ("S1E2-S1E4, S1E7"). Seasons are taken without their S too ("2",
		 * "1-4, 6"); a list with an episode in it ("S1-S4, S6E3") is ranges. "1778=S27E1" says which episode lands there
		 * instead of episode 1, for an offset below zero (episode 1778 is S27E1: offset -1777); it works before a season
		 * list or ranges too. Returns the override's fields, or an error message.
		 */
		type TmdbEpisodes = Pick<CEM.TMDBOverrides, "tmdbSeason" | "tmdbSeasons" | "tmdbRanges" | "tmdbOffset">;
		function parseTmdbEpisodes(value: string): TmdbEpisodes | string {
			const prefixed = value.trim().match(/^(-?\d+)\s*=\s*(.*)$/);
			const start = prefixed ? Number(prefixed[1]) : 1;
			const text = prefixed ? prefixed[2].trim() : value.trim();
			const withOffset = (fields: TmdbEpisodes, offset: number) => (offset ? { ...fields, tmdbOffset: offset } : fields);
			// One start ("S6E2", "S6"): a season and offset, as before ranges, so the episodes still stop at AniList's total
			const single = text.match(/^S(\d+)(?:E(\d+))?$/i);
			if (single) return withOffset({ tmdbSeason: Number(single[1]) }, Number(single[2] ?? 1) - start);
			// Whole seasons only ("S1-S4, S6"): a season list, which stops at its last season (ranges take every later one)
			const items = text.split(",").map((p) => p.trim());
			const plain = items.every((p) => /^S\d+(\s*-\s*S\d+)?$/i.test(p)) ? text.replace(/S/gi, "") : text;
			if (/^S/i.test(plain)) {
				const ranges = parseRanges(text);
				if (typeof ranges === "string") return ranges;
				return withOffset({ tmdbSeason: ranges[0].season, tmdbRanges: ranges }, 1 - start);
			}
			const seasons = parseSeasons(plain);
			if (!seasons) return `"${value.trim()}" isn't a season (S2), seasons (S1-S4, S6), a start (S6E2) or ranges (S1E2-S1E4, S1E7).`;
			return withOffset({ tmdbSeason: seasons[0], ...(seasons.length > 1 ? { tmdbSeasons: seasons } : {}) }, 1 - start);
		}
		/** The TMDB Episodes field's text for a season, seasons or ranges and an offset (see parseTmdbEpisodes) */
		function formatTmdbEpisodes(o: TmdbEpisodes) {
			if (typeof o.tmdbSeason !== "number") return "";
			const offset = o.tmdbOffset ?? 0;
			const list = o.tmdbRanges?.length ? formatRanges(o.tmdbRanges) : o.tmdbSeasons?.length ? formatSeasons(o.tmdbSeasons, "S") : undefined;
			// Several seasons or ranges count the offset along the run: the episode that lands on its first episode
			if (list) return offset ? `${1 - offset}=${list}` : list;
			if (offset < 0) return `${1 - offset}=S${o.tmdbSeason}E1`;
			return offset ? `S${o.tmdbSeason}E${offset + 1}` : `S${o.tmdbSeason}`;
		}
		/**
		 * The Media tab's AniDB Episodes field: where episode 1 lands on AniDB, a main episode ("13"), a special ("S1") or
		 * another lettered type ("O1", "C1", ...); "5=1" says which episode lands there instead (episode 5 is AniDB's 1:
		 * offset -4).
		 */
		type AnidbEpisodes = { offset?: number; specials?: boolean; letter?: string };
		function parseAnidbEpisodes(value: string): AnidbEpisodes | string {
			const m = value.trim().match(/^(?:(-?\d+)\s*=\s*)?([A-Z]?)\s*(\d*)$/i);
			const kind = m?.[2].toUpperCase() ?? "";
			if (!m || (!m[2] && !m[3]) || m[3] === "0" || (kind && ANIDB_LETTERS.indexOf(kind) === -1))
				return `"${value.trim()}" isn't an AniDB episode like 13, or a lettered one (${ANIDB_LETTER_LIST}).`;
			const offset = Number(m[3] || 1) - (m[1] ? Number(m[1]) : 1);
			return { ...(offset ? { offset } : {}), ...(kind === "S" ? { specials: true } : {}), ...(kind && kind !== "S" ? { letter: kind } : {}) };
		}
		/** The AniDB Episodes field's text (see parseAnidbEpisodes): empty for main episodes from 1 */
		function formatAnidbEpisodes({ offset = 0, specials, letter }: AnidbEpisodes) {
			const kind = letter ?? (specials ? "S" : "");
			if (offset < 0) return `${1 - offset}=${kind}1`;
			return offset || kind ? `${kind}${offset + 1}` : "";
		}
		/** Whether an episode override sets anything on TMDB (it can set only its AniDB episode) */
		const tmdbFields = (o: CEM.TMDBOverrides["episodeOverrides"][number]) =>
			o.tmdbId !== undefined || o.tmdbSeason !== undefined || o.tmdbEpisode !== undefined;
		/** Whether a media override sets anything, "none" included (an override can be left with only episode overrides) */
		const hasMediaOverride = (o: CEM.TMDBOverrides) =>
			!!(o.tmdbId || o.tmdbSeason || o.tmdbOffset || o.tmdbNone) ||
			!!(o.anidbId || o.anidbOffset || o.anidbSpecials || o.anidbLetter || o.anidbNone);

		/**
		 * Override fields changed since they were saved (Auto-fill fills them without saving): a blue dot on that tab's Save.
		 * Checked when a field changes, and after anything that fills or saves them; so are the fields that are off.
		 */
		const unsaved = ctx.state<{ media: boolean; episode: boolean; editor: boolean }>({ media: false, episode: false, editor: false });
		function checkUnsaved() {
			const media = currentMedia.get();
			if (!media) return;
			const saved = tmdb.overrides.get(media.id);
			const episode = currEditedEp.get()?.episode;
			const differs = (refs: Record<string, $ui.FieldRef<string>>, values: Record<string, string>) =>
				Object.keys(values).some((k) => refs[k].current.trim() !== values[k]);
			// The episode editor's fields against the custom metadata saved for the episode
			const custom: Record<string, unknown> = (episode !== undefined && database.get(media.id).data[episode]) || {};
			const customValues = Object.fromEntries(Object.keys(fieldRefs.data).map((k) => [k, `${custom[k] ?? ""}`]));
			const episodeSaved = saved.episodeOverrides.find((e) => e.aniDBEpisode === episode) ?? {};
			const next = {
				editor: episode !== undefined && differs(fieldRefs.data, customValues),
				media: differs(tmdb.overrides.media.fieldRefs, tmdb.overrides.media.values(saved)),
				episode: episode !== undefined && differs(tmdb.overrides.episode.fieldRefs, tmdb.overrides.episode.values(episodeSaved)),
			};
			const now = unsaved.get();
			if (next.media !== now.media || next.episode !== now.episode || next.editor !== now.editor) unsaved.set(next);

			// Fields that are off ("media.tmdbEpisodes"), and cleared as they turn off: a source's other fields once one of them
			// says "none"; a movie's Episodes (an episode's Season and Episode), as it has no seasons, while the TMDB
			// ID field, or the match shown in it when it's empty, is a movie
			const auto = autoPlaceholders(media.id, episode ?? null);
			const off: Record<string, boolean> = {};
			for (const tab of ["media", "episode"] as const) {
				const refs: Record<string, $ui.FieldRef<string>> = tmdb.overrides[tab].fieldRefs;
				const shownId = refs.tmdbId.current.trim() || (tab === "media" ? auto.tmdbId : auto.epTmdbId);
				for (const [source, keys] of Object.entries(NONE_FIELDS[tab])) {
					const none = keys.find((k) => isNone(refs[k].current));
					if (none) keys.forEach((k) => k !== none && (off[`${tab}.${k}`] = true));
					else if (source === "tmdb" && parseTmdbId(shownId)?.type === "movie")
						keys.slice(1).forEach((k) => (off[`${tab}.${k}`] = true));
				}
			}
			const was = offFields.get();
			if (stableJson(off) === stableJson(was)) return;
			offFields.set(off);
			for (const key of Object.keys(off)) {
				if (was[key]) continue;
				const [tab, field] = key.split(".") as ["media" | "episode", string];
				(tmdb.overrides[tab].fieldRefs as Record<string, $ui.FieldRef<string>>)[field].setValue("");
			}
		}
		const offFields = ctx.state<Record<string, boolean>>({});
		const isOff = (field: string) => !!offFields.get()[field];

		/** Whether the overrides modal is open */
		const overridesOpen = ctx.state<boolean>(false);
		/**
		 * Delete buttons pressed since the modal opened ("media", "episode"). Once there's nothing left to delete the pressed
		 * one shrinks to nothing, invisible, instead of going: a removed (or hidden) button drops focus the way a disabled one
		 * does (see actionButton) and closes the tray on a phone. It's gone when the modal opens again.
		 */
		const deletePressed = ctx.state<Record<string, boolean>>({});
		const deleteStyle = (has: boolean, which: string): Record<string, string> => {
			if (has) return { display: "block" };
			if (deletePressed.get()[which]) {
				return { opacity: "0", pointerEvents: "none", width: "0", minWidth: "0", padding: "0", border: "0", overflow: "hidden" };
			}
			return { display: "none" };
		};
		/** The anime whose page is open, as the tray shows it */
		type ShownMedia = NonNullable<ReturnType<typeof currentMedia.get>>;
		/** A tab of the overrides modal, as tall as the tallest */
		type Pane = (value: string, items: any[]) => any;
		/** Text of the Media tab's description and status lines: how many lines it wraps to, roughly, at the modal's width */
		const MEDIA_TAB_TEXT =
			"Applies to every episode of this anime, except episodes with their own override. " +
			'Empty fields keep what the plugin found (shown greyed out). Enter "none" to leave TMDB or AniDB out.';
		const FIELD_HELP_LINK = "What the fields take";
		/** The Media tab's fields and what each takes, rows of an example and what it means */
		const FIELD_HELP: [string, [string, string][]][] = [
			["TMDB ID", [["s1429", "a show; m371371 a movie, or a TMDB link"]]],
			[
				"TMDB Episodes",
				[
					["S2", "season 2"],
					["S1-S4, S6", "seasons 1 to 4 and 6, read as one run"],
					["S6E2", "episode 1 is S6E2, the next ones follow"],
					["S1E2-S1E4, S1E7", "these TMDB episodes in order, then every later one (S1E6-S2 to the end of season 2, S3 all of it)"],
					["S0E66-S0E68", "specials work the same"],
				],
			],
			[
				"AniDB Episodes",
				[
					["13", "episode 1 is AniDB's episode 13 (empty: AniDB's episode 1)"],
					["S1", "AniDB's specials, from S1"],
					["O1", "AniDB's other episodes, from O1; C1 credits, T1 trailers and P1 parodies the same way"],
				],
			],
			[
				"Starting with a later episode",
				[
					["1778=S27E1", "episode 1778 is S27E1; the ones before it get nothing from TMDB"],
					["5=1", "the same for AniDB. Without a number and =, it's episode 1: S6E2 is 1=S6E2"],
				],
			],
			["Leaving a source out", [["none", "in any of TMDB's or AniDB's fields: nothing from it for this anime"]]],
		];
		/** The Media tab's description, with a link that opens what the fields take (a small modal, like the status lines') */
		function mediaTabIntro() {
			const code = (text: string) => tray.span(text, { className: "font-mono text-[--foreground] whitespace-nowrap" });
			const rows = FIELD_HELP.map(([title, examples]) =>
				tray.div(
					[
						tray.text(title, { className: "font-semibold" }),
						...examples.map(([example, meaning]) =>
							tray.flex([tray.div([code(example)], { className: "shrink-0 w-36" }), tray.span(meaning)], { gap: 2 }),
						),
					],
					{ className: "space-y-1" },
				),
			);
			const help = tray.modal({
				trigger: tray.span(FIELD_HELP_LINK, { className: "cem-trigger cursor-pointer underline text-[--foreground]" }),
				title: "The Media tab's fields",
				open: stepsOpen.get() === "help",
				onOpenChange: ctx.eventHandler("steps-help", ({ open }: { open: boolean }) => stepsOpen.set(open ? "help" : "")),
				className: "max-w-xl",
				items: [tray.div(rows, { className: "space-y-3 text-sm text-[--muted] break-normal" })],
			});
			return tray.div([tray.span(`${MEDIA_TAB_TEXT} `), help], { className: "cem-line text-sm text-[--muted] break-normal text-pretty" });
		}
		const textLines = (text: string) => Math.max(1, Math.ceil(text.length / 95));
		/** TMDB overrides modal. Pass the episode being edited, or null from the episode list. */
		function overridesModal(currentMediaData: ShownMedia, episode: string | null, attention = "") {
			const auto = autoPlaceholders(currentMediaData.id, episode);
			// Every tab at least as tall as the Media tab, the tallest (its status lines can wrap to several lines each), so
			// the modal keeps its size when switching: Seanime only renders the active tab, so it can't be measured
			const tmdbLine = tmdbStatus(currentMediaData.id);
			const anidbLine = anidbStatus(currentMediaData.id);
			// 1.75rem of it the progress line above the buttons
			const intro = textLines(`${MEDIA_TAB_TEXT} ${FIELD_HELP_LINK}`);
			const mediaHeight = 22.75 + 1.25 * (intro + textLines(tmdbLine.text) + textLines(anidbLine.text));
			const pane: Pane = (value, items) =>
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
			// Something to fix (no TMDB match, no AniDB ID): the orange dot, the reason as the tooltip
			const trigger = tray.tooltip(withDot(button, !!attention, "bg-orange-500", true), {
				text: attention || (tmdb.API_KEY ? "Override AniDB and TMDB matches" : "Override AniDB matches"),
			});
			return tray.modal({
				trigger,
				// Kept in the plugin: Seanime's modal only reads it when mounted, so one remounted opens again instead of closing
				open: overridesOpen.get(),
				title: "TMDB & AniDB Overrides",
				// Wider than Seanime's default (max-w-lg) for the status lines; on a phone it's the full width, scrolling when tall
				className: "max-w-3xl max-h-[90vh] overflow-y-auto",
				description:
					"Correct what the plugin matched for this anime on TMDB and AniDB. Saved overrides are used instead of the automatic match.",
				items: [
					actionCss(),
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
								...(episode !== null ? [episodePane(pane, currentMediaData, episode, auto)] : []),
								mediaPane(pane, currentMediaData, auto, tmdbLine, anidbLine),
								bulkPane(pane, currentMediaData),
							]),
						],
					}),
				],
				footer: [
					tray.div(
						[
							tray.text("TMDB ID can be found on the TMDB link of the series in the format of: /tv/{tmdbId} or /movie/{tmdbId}.", {
							className: "break-normal",
						}),
							tray.text("Prefix the ID with s or m to set its type.", { className: "break-normal" }),
						],
						{ className: "w-full text-left text-[--muted] text-xs" },
					),
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
					checkUnsaved();
				}),
			});
		}

		/**
		 * What the plugin matched by itself, as the override fields' placeholders: the media's TMDB ID and episodes (a
		 * season and start, or ranges when the match spans several parts), its AniDB ID and episodes; an episode's TMDB
		 * target.
		 */
		function autoPlaceholders(mediaId: number, episode: string | null) {
			const record = thumbnails.get(mediaId);
			// Only matches in use: an automatic one switched off stays stored but isn't shown
			const auto = tmdbOn() && record?.status === "matched" && record.source !== "override" ? record : undefined;
			const out: Record<
				"tmdbId" | "tmdbEpisodes" | "anidbId" | "anidbEpisodes" | "epTmdbId" | "epSeason" | "epEpisode" | "epAnidbEpisode",
				string
			> = {
				tmdbId: "", tmdbEpisodes: "", anidbId: "", anidbEpisodes: "",
				epTmdbId: "", epSeason: "", epEpisode: "", epAnidbEpisode: "",
			};
			if (auto?.tmdbId) {
				out.tmdbId = formatTmdbId(auto.tmdbId, auto.tmdbType ?? "tv");
				const runs = episodeRuns(auto);
				// Several parts in TMDB's order, from episode 1, without gaps in this anime's numbers: as ranges
				const follows = (r: (typeof runs)[number], before: (typeof runs)[number]) => {
					const later = r.season > before.season || (r.season === before.season && r.first > before.last);
					return r.from === before.to + 1 && r.tmdbId === auto.tmdbId && later;
				};
				const ordered = runs.length > 1 && runs[0].from === 1 && runs.every((r, i) => i === 0 || follows(r, runs[i - 1]));
				if (ordered) {
					out.tmdbEpisodes = formatRanges(runs.map((r) => ({ season: r.season, episode: r.first, toSeason: r.season, toEpisode: r.last })));
				}
				// Parts with gaps or out of order: no Episodes value says that, only the automatic match keeps them
				else if (runs.length > 1) out.tmdbEpisodes = `${runs.length} parts, kept while this is empty`;
				else if (auto.fallback && auto.tmdbType !== "movie") {
					out.tmdbEpisodes = formatTmdbEpisodes({ tmdbSeason: auto.fallback.season, tmdbOffset: auto.fallback.offset });
				}
			}
			const match = anidbStore.get(mediaId);
			const seanime = Number($store.get(`CEM_SEANIME_ANIDB_${mediaId}`)) || 0;
			if (anidbLookup() && match?.status === "verified" && match.aid) {
				out.anidbId = `${match.aid}`;
				out.anidbEpisodes = formatAnidbEpisodes(match);
				// The episode's own on AniDB: its number plus the offset, among the specials when the match is to them
				if (episode !== null && /^\d+$/.test(episode)) {
					out.epAnidbEpisode = `${match.specials ? "S" : ""}${Number(episode) + (match.offset ?? 0)}`;
				}
			} else if (seanime) out.anidbId = `${seanime}`;
			const target = episode !== null && tmdbOn() ? record?.map[episode] : undefined;
			if (target) {
				out.epTmdbId = formatTmdbId(target.tmdbId, target.movie ? "movie" : "tv");
				if (target.season !== undefined) out.epSeason = `${target.season}`;
				if (target.episode !== undefined) out.epEpisode = `${target.episode}`;
			}
			return out;
		}

		/** The Episode tab: this episode's own TMDB and AniDB episode */
		function episodePane(pane: Pane, media: ShownMedia, episode: string, auto: ReturnType<typeof autoPlaceholders>) {
			const refs = tmdb.overrides.episode.fieldRefs;
			return pane("episode", [
				tray.text(
					"Applies to this episode only, over the media override and any range. Enter m<id> to make it a TMDB movie. " +
						"AniDB Episode takes a number or a lettered one (S3, C1, O5). Enter \"none\" to leave TMDB or AniDB out.",
					{ className: "text-sm text-[--muted] break-normal text-pretty" },
				),
				styledInput("TMDB ID", { fieldRef: refs.tmdbId, disabled: !tmdb.API_KEY || isOff("episode.tmdbId"), placeholder: auto.epTmdbId }),
				styledInput("TMDB Season", {
					fieldRef: refs.tmdbSeason,
					disabled: !tmdb.API_KEY || isOff("episode.tmdbSeason"),
					placeholder: auto.epSeason,
				}),
				styledInput("TMDB Episode", {
					fieldRef: refs.tmdbEpisode,
					disabled: !tmdb.API_KEY || isOff("episode.tmdbEpisode"),
					placeholder: auto.epEpisode,
				}),
				styledInput("AniDB ID", { fieldRef: refs.anidbId, disabled: isOff("episode.anidbId"), placeholder: auto.anidbId }),
				styledInput("AniDB Episode", {
					fieldRef: refs.anidbEpisode,
					disabled: isOff("episode.anidbEpisode"),
					placeholder: auto.epAnidbEpisode,
				}),
				tray.div([], { className: "flex-1" }),
				tray.flex(
					[
						tray.button("Delete", {
							intent: "alert",
							size: "md",
							style: deleteStyle(tmdb.overrides.hasEpisode(media.id, episode), "episode"),
							onClick: ctx.eventHandler(`modal-del-${media.id}-${episode}`, () => deleteEpisodeOverride(media.id, episode)),
						}),
						withDot(
							tray.button("Save", {
								intent: "primary",
								size: "md",
								onClick: ctx.eventHandler(`modal-save-${media.id}-${episode}`, () =>
									saveEpisodeOverride(media.id, episode, auto.anidbId),
								),
							}),
							unsaved.get().episode,
							"bg-blue-500",
						),
					],
					{ className: "justify-end flex-wrap" },
				),
			]);
		}

		function deleteEpisodeOverride(mediaId: number, episode: string) {
			deletePressed.set({ ...deletePressed.get(), episode: true });
			if (!tmdb.overrides.hasEpisode(mediaId, episode)) return ctx.toast.info("This episode has no overrides to delete.");
			const isDeleted = tmdb.overrides.removeEpisodeOverride(mediaId, episode);
			rematch(mediaId);
			scheduleRebuild(false);
			tmdb.overrides.episode.resetFieldRefs();
			checkUnsaved();
			if (isDeleted) ctx.toast.success("Successfully removed this episode's overrides!");
			else ctx.toast.error("Unable to delete this episode override!");
			tray.update();
		}

		/** placeholderAid: the anime's AniDB ID in use, for an AniDB Episode entered without an AniDB ID */
		async function saveEpisodeOverride(mediaId: number, episode: string, placeholderAid: string) {
			try {
				await tmdb.overrides.episode.save(mediaId, episode, placeholderAid);
			} catch (e) {
				return ctx.toast.error((e as Error).message);
			}
			// As saved: a "none" typed in any of a source's fields shows in its ID field
			tmdb.overrides.episode.fill(tmdb.overrides.get(mediaId).episodeOverrides.find((o) => o.aniDBEpisode === episode) ?? {});
			rematch(mediaId);
			// Its AniDB episode shows once the modal closes (see rebuild)
			scheduleRebuild(false);
			checkUnsaved();
			ctx.toast.success("Successfully saved this episode's overrides!");
			tray.update();
		}

		/** The Media tab: the anime's TMDB match and AniDB ID, how each was found, and the buttons that redo them */
		function mediaPane(pane: Pane, media: ShownMedia, auto: ReturnType<typeof autoPlaceholders>, tmdbLine: Status, anidbLine: Status) {
			const refs = tmdb.overrides.media.fieldRefs;
			let refreshTip = "Look up the AniDB ID again";
			if (tmdbOn()) refreshTip = anidbLookup() ? "Match TMDB and AniDB again" : "Match TMDB again";
			return pane("media", [
				mediaTabIntro(),
				statusLine("tmdb", tmdbLine),
				styledInput("TMDB ID", { fieldRef: refs.tmdbId, disabled: !tmdb.API_KEY || isOff("media.tmdbId"), placeholder: auto.tmdbId }),
				styledInput("TMDB Episodes", {
					fieldRef: refs.tmdbEpisodes,
					disabled: !tmdb.API_KEY || isOff("media.tmdbEpisodes"),
					placeholder: auto.tmdbEpisodes,
				}),
				statusLine("anidb", anidbLine),
				// Real AniDB ID for anime Seanime has no metadata for: clears its "metadata retrieval not available" notice
				styledInput("AniDB ID", { fieldRef: refs.anidbId, disabled: isOff("media.anidbId"), placeholder: auto.anidbId }),
				styledInput("AniDB Episodes", {
					fieldRef: refs.anidbEpisodes,
					disabled: isOff("media.anidbEpisodes"),
					placeholder: auto.anidbEpisodes,
				}),
				tray.switch("Ignore warnings for this anime", {
					fieldRef: tmdb.overrides.media.ignoreWarnings,
					onChange: ctx.eventHandler(`ignore-warnings-${media.id}`, ({ value }: { value: boolean }) => {
						const data = tmdb.overrides.get(media.id);
						if (value) data.ignoreWarnings = true;
						else delete data.ignoreWarnings;
						tmdb.overrides.set(media.id, data, true);
						updateBadge();
						tray.update();
					}),
				}),
				tray.div([], { className: "flex-1" }),
				progressLine("modal-"),
				tray.flex(
					[
						actionButton(`modal-autofill-${media.id}`, "Auto-fill", {}, async () => {
							try {
								log.mark(`Auto-fill: ${media.id}`);
								log.time(`autofill ${media.id}`);
								await autoFill(media.id);
								log.timeEnd(`autofill ${media.id}`);
							} catch (e) {
								log.error(`${media.id}: Auto-fill failed:`, e);
								ctx.toast.error((e as Error).message);
							}
							checkUnsaved();
						}),
						// Refresh redoes the automatic matches: none switched on, nothing to redo
						...(tmdbOn() || anidbLookup()
							? [
									tray.tooltip(
										actionButton(`modal-refresh-${media.id}`, "Refresh", {}, async () => {
											try {
												ctx.toast.success(await refreshEntry(media.id));
											} catch (e) {
												ctx.toast.error((e as Error).message);
											}
										}),
										{ text: refreshTip },
									),
								]
							: []),
						// Development installs and Developer mode: everything stored for this anime, in the debug panel or seanime.log
						...(debugging
							? [
									tray.tooltip(
										tray.button("Debug", {
											intent: "gray-subtle",
											size: "md",
											onClick: ctx.eventHandler(`debug-dump-${media.id}`, () => {
												debugDump(media.id);
												const where = $debug.enabled ? "the debug panel" : "seanime.log";
												ctx.toast.info(`Everything stored for this anime is in ${where}`);
											}),
										}),
										{ text: "Log everything stored for this anime" },
									),
								]
							: []),
						tray.div([], { className: "flex-1" }),
						tray.button("Delete", {
							intent: "alert",
							size: "md",
							style: deleteStyle(hasMediaOverride(tmdb.overrides.get(media.id)), "media"),
							onClick: ctx.eventHandler(`modal-del-${media.id}`, () => deleteMediaOverride(media.id)),
						}),
						withDot(
							tray.button("Save", {
								intent: "primary",
								size: "md",
								onClick: ctx.eventHandler(`modal-save-${media.id}`, () => saveMediaOverride(media.id)),
							}),
							unsaved.get().media,
							"bg-blue-500",
						),
					],
					{ className: "justify-end flex-wrap" },
				),
			]);
		}

		/**
		 * After the media override is saved or deleted: the AniDB ID again, as Refresh does it (your override's, a lookup
		 * when Seanime has none, or forgetting one). A "none" just removed has left nothing stored to redo.
		 */
		function anidbAfterOverride(mediaId: number, after: "saving" | "deleting") {
			void detectMissing(mediaId)
				.then(() => needsAnidb(mediaId))
				.then((needed) => (needed ? refreshAnidb(mediaId, true) : undefined))
				.then(() => scheduleRebuild(false))
				.catch((e) => log.error(`${mediaId}: AniDB lookup after ${after} the override failed:`, e));
		}

		function deleteMediaOverride(mediaId: number) {
			deletePressed.set({ ...deletePressed.get(), media: true });
			if (!hasMediaOverride(tmdb.overrides.get(mediaId))) return ctx.toast.info("This media has no overrides to delete.");
			log.mark(`Media override deleted: ${mediaId}`);
			tmdb.overrides.removeMediaOverride(mediaId);
			rematch(mediaId);
			anidbAfterOverride(mediaId, "deleting");
			tmdb.overrides.media.resetFieldRefs();
			checkUnsaved();
			ctx.toast.success("Successfully removed this media's overrides!");
			tray.update();
		}

		function saveMediaOverride(mediaId: number) {
			log.mark(`Media override saved: ${mediaId}`);
			// The media fields as stored, to tell whether saving changed anything
			const mediaFields = () => {
				const o = tmdb.overrides.get(mediaId);
				const tmdbPart = [o.tmdbId, o.tmdbType, o.tmdbSeason, o.tmdbSeasons, o.tmdbRanges, o.tmdbOffset];
				return stableJson([...tmdbPart, o.anidbId, o.anidbOffset, o.anidbSpecials, o.anidbLetter, o.tmdbNone, o.anidbNone]);
			};
			const before = mediaFields();
			try {
				tmdb.overrides.media.save(mediaId);
			} catch (e) {
				return ctx.toast.error((e as Error).message);
			}
			// As saved: a "none" typed in any of a source's fields shows in its ID field
			tmdb.overrides.media.fill(tmdb.overrides.get(mediaId));
			// Saved as it was: no new match, lookup or rebuild (a long show takes a while to match)
			const record = thumbnails.get(mediaId);
			const saved = tmdb.overrides.get(mediaId);
			const tmdbApplied = !!saved.tmdbId === (record?.source === "override");
			const applied = tmdbApplied && !!saved.anidbId === (anidbStore.get(mediaId)?.status === "override");
			if (mediaFields() === before && record && applied) {
				log.step(`${mediaId}: override saved unchanged`);
				ctx.toast.info("Nothing changed in this media's overrides.");
				checkUnsaved();
				return tray.update();
			}
			rematch(mediaId);
			anidbAfterOverride(mediaId, "saving");
			// Shown once the modal closes (see rebuild)
			scheduleRebuild(false);
			checkUnsaved();
			ctx.toast.success("Successfully saved this media's overrides!");
			tray.update();
		}

		/**
		 * Everything stored for an anime as one object in the debug panel (and seanime.log in Developer mode), instead of
		 * reading each store by hand: the override, both matches, Animap's status, the custom metadata,
		 * what the metadata hooks left for the UI context, and the cached lookups
		 */
		function debugDump(mediaId: number) {
			log.mark(`Debug dump: ${mediaId}`);
			log.inspect(`${mediaId}: everything stored`, {
				settings: JSON.parse(displaySettings),
				override: tmdb.overrides.records()[mediaId] ?? null,
				tmdbMatch: thumbnails.get(mediaId) ?? null,
				refreshRunning: !!inFlight[mediaId],
				anidbMatch: anidbStore.get(mediaId) ?? null,
				animapStatus: animap.get(mediaId) ?? null,
				customMetadata: database.get(mediaId).data,
				// What the metadata hooks last saw and added (see onAnimeMetadata)
				seanimeAnidbId: $store.get(`CEM_SEANIME_ANIDB_${mediaId}`) ?? null,
				keptMetadata: storeJson(`CEM_META_${mediaId}`, null),
				addedEpisodes: storeJson(`CEM_ADDED_${mediaId}`, []),
				tmdbFilled: storeJson(`CEM_TMDB_FILLED_${mediaId}`, {}),
				airedCount: $store.get(`CEM_AIRED_${mediaId}`) ?? null,
				lastServed: Number($store.get(`CEM_SERVED_${mediaId}`)) || null,
				// Cached lookups
				relationStep: relationSteps()[mediaId] ?? null,
				animeApi: ($storage.get<Record<number, unknown>>(ANIMEAPI_KEY) ?? {})[mediaId] ?? null,
				animapProbe: animapProbes[mediaId] ?? null,
			});
		}

		/**
		 * Fill the media override fields without saving: the TMDB ID typed in the field, else Animap's, else a TMDB
		 * title search (each candidate checked against the air dates), then the season and offset the dates line up with.
		 */
		async function autoFill(mediaId: number) {
			const refs = tmdb.overrides.media.fieldRefs;
			const { media, metadata } = await loadAnime(mediaId);

			// A source set to "none" is left as it is
			const none = { tmdb: noneIn(refs, NONE_FIELDS.media.tmdb), anidb: noneIn(refs, NONE_FIELDS.media.anidb) };
			// AniDB ID: only when Seanime has none for this anime and the field is empty
			const knownAnidb = none.anidb ? undefined : metadata?.mappings?.anidbId;
			let anidbFound = "";
			if (knownAnidb && !refs.anidbId.current.trim()) {
				// Already known (Seanime's own, or one the plugin verified): show it, with the plugin's episodes if it's ours
				const ours = anidbStore.get(mediaId);
				refs.anidbId.setValue(`${knownAnidb}`);
				refs.anidbEpisodes.setValue(ours?.aid === knownAnidb ? formatAnidbEpisodes(ours) : "");
				anidbFound = `AniDB ${knownAnidb} from ${ours?.aid === knownAnidb ? `${ours.from ?? "the plugin's lookup"}` : "Seanime's metadata"}.`;
			} else if (!none.anidb && !knownAnidb && !refs.anidbId.current.trim() && !isCustomSource(mediaId)) {
				const found = await findAnidb(mediaId, media, metadata);
				if (found.aid) {
					refs.anidbId.setValue(`${found.aid}`);
					refs.anidbEpisodes.setValue(formatAnidbEpisodes(found));
					anidbFound = `AniDB ${found.aid} from ${found.from}: ${found.reason}.`;
					if (tmdb.API_KEY) ctx.toast.info(anidbFound);
				} else {
					log.step(`${mediaId}: Auto-fill found no verified AniDB ID: ${found.reason}`);
					if (!tmdb.API_KEY) return ctx.toast.error(`No verified AniDB ID found: ${found.reason}. Enter it by hand.`);
				}
			}
			// Without a TMDB token only the AniDB ID is filled
			if (!tmdb.API_KEY || none.tmdb) {
				if (anidbFound) return ctx.toast.success(`Filled ${anidbFound} Review it and press Save.`);
				if (none.tmdb) return ctx.toast.info("TMDB is set to none and the AniDB ID field is filled in: nothing to look up.");
				return ctx.toast.info("The AniDB ID field is already filled in: nothing to look up.");
			}

			const typed = parseTmdbId(refs.tmdbId.current);
			const only = typed ? { ...typed, from: "the TMDB ID you entered" } : undefined;
			const { found, firstValid } = await searchTmdb(mediaId, media, metadata, tmdbSession(), only);

			if (!found) {
				if (!firstValid) {
					if (typed) return ctx.toast.error(`TMDB has no ${typed.type ?? "show or movie"} with ID ${typed.id}.`);
					return ctx.toast.error("Couldn't find this anime on TMDB. Enter the TMDB ID by hand.");
				}
				refs.tmdbId.setValue(formatTmdbId(firstValid.id, firstValid.type));
				return ctx.toast.warning(
					`Filled the TMDB ID from ${firstValid.from}, but couldn't work out the season: ${firstValid.reason ?? "no match"}`,
				);
			}

			const { id, from, mapping } = found;
			refs.tmdbId.setValue(formatTmdbId(id, mapping.tmdbType));
			if (mapping.tmdbType === "movie") {
				refs.tmdbEpisodes.setValue("");
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
				const checked = Object.entries(mapping.map).filter(
					([k, t]) => /^\d+$/.test(k) && t.season !== undefined && seasons.indexOf(t.season) !== -1,
				);
				const agree = checked.filter(([k, t]) => {
					const hit = run[Number(k) + offset - 1];
					return hit && hit.season === t.season && hit.episode === t.episode;
				}).length;
				if (start !== -1 && checked.length && agree / checked.length >= 0.9) {
					const text = seasonListText(seasons, offset, run);
					refs.tmdbEpisodes.setValue(text);
					const what = /E\d/.test(text) ? `episodes ${text}` : `seasons ${text}`;
					return ctx.toast.success(`Filled TMDB ${id} from ${from}: ${what}. Review it and press Save.`);
				}
			}
			// The parts don't read as one run of seasons: an Episodes value would lose them (Doraemon: episodes TMDB splits
			// or skips). Only the ID is filled; with Episodes empty the automatic match keeps every part.
			if (segments.length > 1) {
				refs.tmdbEpisodes.setValue("");
				const parts = episodeRuns(mapping).length;
				return ctx.toast.success(
					`Filled TMDB ${id} from ${from}. Its episodes match in ${parts} parts no Episodes value can describe: ` +
						"leave TMDB Episodes empty so the automatic match keeps them. Review it and press Save.",
				);
			}
			refs.tmdbEpisodes.setValue(formatTmdbEpisodes({ tmdbSeason: first.season, tmdbOffset: first.offset }));
			ctx.toast.success(`Filled TMDB ${id} from ${from}: ${landsOn(first.season, first.offset)}. Review it and press Save.`);
		}

		/**
		 * The TMDB Episodes text for seasons read as one run (in that order) with an offset along it. A season list only
		 * starts at its first season's first episode: with episode 1 further along it, ranges from where it lands.
		 */
		function seasonListText(seasons: number[], offset: number, run: { season: number; episode: number }[]) {
			const at = run[offset];
			if (offset <= 0 || !at) return formatTmdbEpisodes({ tmdbSeason: seasons[0], tmdbSeasons: seasons, tmdbOffset: offset });
			// Runs of consecutive seasons from the one episode 1 lands in: "S1E4-S4", then "S6" or "S8-S9"
			const groups: number[][] = [];
			for (const season of seasons.slice(seasons.indexOf(at.season))) {
				const group = groups[groups.length - 1];
				if (group && season === group[group.length - 1] + 1) group.push(season);
				else groups.push([season]);
			}
			return groups
				.map((g, i) => {
					const from = i ? `S${g[0]}` : `S${at.season}E${at.episode}`;
					return g.length > 1 || (i === 0 && at.episode > 1) ? `${from}-S${g[g.length - 1]}` : from;
				})
				.join(", ");
		}

		/** The Bulk Update tab */
		function bulkPane(pane: Pane, media: ShownMedia) {
			const fromBoth =
				"Writes TMDB's data for every episode into your custom metadata, from the TMDB ID and Episodes saved in the " +
				"Media tab (episodes with their own override use that), and AniDB's from the AniDB ID: its air dates, and its " +
				"titles, lengths and summaries where TMDB has none. Only for editing episodes by hand: the stills and fill-in work " +
				"without it.";
			const fromAnidb =
				"Writes AniDB's data for every episode into your custom metadata, from the AniDB ID: titles, lengths, summaries and " +
				"air dates. Only for editing episodes by hand.";
			return pane("bulk-update", [
				tray.text(tmdb.API_KEY ? fromBoth : fromAnidb, { className: "text-sm text-[--muted] text-pretty break-normal" }),
				tray.alert({ intent: "warning", description: "This replaces the custom metadata you saved for this anime's episodes." }),
				actionButton(`bulk-update-${media.id}`, "Bulk Update", { intent: "success-subtle", className: "w-full" }, () => bulkUpdate(media)),
				progressLine("bulk-update-"),
			]);
		}

		/** Bulk Update: TMDB's data (from a saved media override only) and then AniDB's, written into the custom metadata */
		async function bulkUpdate(media: ShownMedia) {
			// TMDB's data only from a saved media override: Bulk Update is manual, never from Animap's ID
			const override = tmdb.overrides.get(media.id);
			const movie = override.tmdbType === "movie" || (media.type === "movie" && override.tmdbType !== "tv");
			const fromTmdb = !!tmdb.API_KEY && !!override.tmdbId && (movie || typeof override.tmdbSeason === "number");
			let result: RefreshResult | undefined;
			log.mark(`Bulk Update: ${media.id}`);
			log.time(`bulk ${media.id}`);
			if (fromTmdb) {
				try {
					result = await refreshAnime(media.id, true, true);
				} catch (error) {
					log.error(`${media.id}: Bulk Update failed:`, error);
					return ctx.toast.error((error as Error).message);
				}
				if (result.record?.status === "failed") return ctx.toast.error(result.record.reason ?? "Unable to match this anime on TMDB.");
				if (result.missing.length) ctx.toast.warning(`No TMDB episode found for episode(s) ${result.missing.join(", ")}`);
			}
			const fromAnidb = await bulkFromAnidb(media.id, result?.written ?? []);
			log.timeEnd(`bulk ${media.id}`);
			const saved = (result?.saved ?? 0) + fromAnidb.added;
			if (!saved) {
				const tmdbHint = tmdb.API_KEY ? "a TMDB ID and Episodes or " : "";
				if (fromTmdb) return ctx.toast.error("Neither TMDB nor AniDB has episodes for this anime yet.");
				return ctx.toast.error(`Nothing to write: save ${tmdbHint}an AniDB ID in the Media tab first (Auto-fill can find them).`);
			}
			const sources = [result?.saved ? "TMDB" : "", fromAnidb.used ? "AniDB" : ""].filter(Boolean).join(" and ");

			// Bulk update is the one action that closes the tray, so the episode list refreshes
			ctx.setTimeout(() => {
				ctx.toast.success(`Saved ${sources}'s metadata for ${saved} episode(s)!`);
				tray.close();
			}, 500);
		}

		/**
		 * Bulk Update's AniDB part, after TMDB's (written: the episodes it wrote): AniDB's air dates over TMDB's, its English
		 * titles, lengths and summaries where TMDB has none. The episodes TMDB didn't write get AniDB's alone. Returns how
		 * many episodes TMDB hadn't written (added), and how many AniDB wrote anything in (used).
		 */
		async function bulkFromAnidb(mediaId: number, written: string[]) {
			if (await needsAnidb(mediaId)) await refreshAnidb(mediaId).catch((e) => log.debug(`${mediaId}: AniDB lookup for Bulk Update failed:`, e));
			let added = 0;
			let used = 0;
			for (const [key, ep] of Object.entries(anidbEpisodes(mediaId))) {
				const tmdbs = written.indexOf(key) !== -1;
				const update: CEM.CustomEpisodeMetadata = tmdbs ? { ...database.get(mediaId).data[key] } : { episode: key };
				if (ep.title && !update.title && plainTitle(ep.title)) update.title = ep.title;
				if (ep.length && update.length === undefined) update.length = ep.length;
				if (ep.summary && !update.overview) update.overview = ep.summary;
				if (ep.airDate) update.airDate = ep.airDate;
				if (stableJson(update) === stableJson(tmdbs ? database.get(mediaId).data[key] : { episode: key })) continue;
				database.save(mediaId, update);
				used++;
				if (!tmdbs) added++;
			}
			if (used) scheduleRebuild(false, mediaId);
			return { added, used };
		}

		/** AniDB's data for each episode: the AniDB match's (when in use), and the episodes whose override names their AniDB episode */
		function anidbEpisodes(mediaId: number) {
			const match = anidbStore.get(mediaId);
			const override = tmdb.overrides.get(mediaId);
			const wanted = override.anidbId ? match?.aid === override.anidbId : anidbLookup();
			const inUse = match && match.status !== "none" && !override.anidbNone && wanted;
			const out: Record<string, { title?: string; airDate?: string; length?: number; summary?: string }> = { ...(inUse ? match.episodes : {}) };
			for (const o of override.episodeOverrides) {
				if (o.aniDBEpisode && o.anidb) out[o.aniDBEpisode] = o.anidb;
				if (o.aniDBEpisode && o.anidbNone) delete out[o.aniDBEpisode];
			}
			return out;
		}

		/** Which status line's steps are open ("tmdb", "anidb"), kept in the plugin like overridesOpen: a remounted modal reads it */
		const stepsOpen = ctx.state("");
		/** A status line's state, by its blip's colour (the design system's signals): found, failed, off (can't be looked up), pending */
		type LineState = "found" | "failed" | "off" | "pending";
		type Status = { text: string; state: LineState; title: string; steps: string[] };
		const BLIP: Record<LineState, string> = { found: "bg-green-500", failed: "bg-orange-500", off: "bg-red-500", pending: "bg-blue-500" };
		/**
		 * A status line of the Media tab, its lead ("TMDB ID", "AniDB ID") in bold. A pinging status blip like the Overrides
		 * button's dot comes first, coloured by its state (the text says the same), and clicking it or the lead opens the
		 * steps numbered in a small modal over the Overrides one (Seanime's tooltip takes plain text only, and its popover
		 * can't be opened from a plugin's trigger). Only that modal closes on a click outside it.
		 */
		function statusLine(which: string, status: Status) {
			// A line reads like a label: no full stop at its end
			const text = status.text.replace(/\.$/, "");
			const cut = text.indexOf(":");
			const lineClass = "cem-line text-sm text-[--muted] break-normal text-pretty";
			const lead = tray.span(text.slice(0, cut + 1), { className: "font-semibold text-[--foreground]" });
			// The blip first, in the text's flow (its halo pinging around it), then the lead
			const color = BLIP[status.state];
			const blip = tray.div(
				[
					tray.div([], {
						className: `rounded-full ${color} animate-ping pointer-events-none`,
						style: { position: "absolute", inset: "0", opacity: "0.75" },
					}),
				],
				{
					className: `rounded-full ${color}`,
					style: {
						display: "inline-block", position: "relative", width: "0.5rem", height: "0.5rem",
						marginRight: "0.375rem", verticalAlign: "0.0625rem",
					},
				},
			);
			const trigger = tray.div([blip, lead], { className: "cem-trigger cursor-pointer" });
			const head = tray.modal({
				trigger,
				title: status.title,
				open: stepsOpen.get() === which,
				onOpenChange: ctx.eventHandler(`steps-${which}`, ({ open }: { open: boolean }) => stepsOpen.set(open ? which : "")),
				className: "max-w-xl",
				items: [
					tray.div(
						status.steps.map((step, i) =>
							tray.flex([tray.span(`${i + 1}.`, { className: "shrink-0 w-6 text-right text-[--muted]" }), tray.span(step)], { gap: 2 }),
						),
						// Its own scroll, the space for the scrollbar kept: a long list neither grows the modal past the screen
						// nor rewraps when the scrollbar appears
						{ className: "space-y-1.5 text-sm break-normal", style: { maxHeight: "60vh", overflowY: "auto", scrollbarGutter: "stable" } },
					),
				],
			});
			return tray.div([head, tray.span(text.slice(cut + 1))], { className: lineClass });
		}

		/** The last step of a match stored before the steps were kept */
		const OLDER_MATCH = "Looked up before the plugin kept every step: press Refresh to see them all";
		/** How the anime is matched on TMDB, for the Media tab, with the match's steps */
		function tmdbStatus(mediaId: number): Status {
			const record = thumbnails.get(mediaId);
			const off = (text: string, steps: string[]): Status => ({
				text: `TMDB ID: ${text}.`,
				state: "off",
				title: "Why nothing is looked up on TMDB",
				steps,
			});
			if (tmdbMissing) {
				let fix = "Enter TMDB's API Read Access Token in the plugin settings";
				if (tmdbMissing === TOKEN_REJECTED) fix = "TMDB answered that the token isn't valid";
				else if (tmdbSetting)
					fix =
						"The plugin only takes TMDB's API Read Access Token (eyJ…), found in TMDB's API settings: " +
						"it stays out of URLs and the logs";
				return off(tmdbMissing, [fix, "Until then nothing is looked up on TMDB"]);
			}
			if (tmdb.overrides.get(mediaId).tmdbNone)
				return off("none, your override", [
					"Your override in this tab sets none: nothing is looked up on TMDB for this anime",
					"Episodes with their own TMDB ID still use it",
				]);
			const overridden = tmdbOverridden(mediaId);
			if (!wantsMatch(mediaId))
				return off(overridden ? "your override, used once stills or fill-in are on" : "stills and fill-in are off", [
					"TMDB stills and fill-in are both off in the plugin settings: nothing is matched, and a match from before isn't used",
					"Auto-fill still finds the TMDB ID, season and offset to save here; Bulk Update writes TMDB's data from them",
				]);
			if (!record)
				return {
					text: "TMDB ID: not matched yet.",
					state: "pending",
					title: "When the TMDB match is made",
					steps: ["Matched when Seanime loads this anime (its page, or the watching list)", "Press Refresh to match it now"],
				};
			// A match stored before steps were kept: its outcome, until a refresh records the rest
			const fromId = `TMDB${record.tmdbId ? ` ${record.tmdbId}` : ""} from ${record.idFrom ?? "Animap"}`;
			const steps = record.steps ?? [`${fromId}: ${outcome(record as Mapping)}`, OLDER_MATCH];
			if (record.status === "failed") {
				return { text: `TMDB ID: no match: ${record.reason ?? "unknown error"}`, state: "failed", title: "Why the TMDB match failed", steps };
			}
			// Parts the status line leaves out: all of them, as the last step
			const runs = episodeRuns(record);
			const parts = runs.length > 3 ? [`Its ${runs.length} parts: ${runs.map(runText).join("; ")}`] : [];
			return { text: matchText(record), state: "found", title: "How the TMDB match was found", steps: steps.concat(parts) };
		}
		/** One part of a match: this anime's episodes and the TMDB episodes they're on, "25-48 S2E1-24" */
		function runText(r: ReturnType<typeof episodeRuns>[number]) {
			const span = (from: number, to: number) => (from === to ? `${from}` : `${from}-${to}`);
			return `${span(r.from, r.to)} S${r.season}E${span(r.first, r.last)}`;
		}
		/** One line describing a TMDB match */
		function matchText(record: CEM.ThumbnailRecord) {
			const via = record.source === "override" ? "from the overrides" : `${matchedBy(record)}, ID from ${record.idFrom ?? "Animap"}`;
			if (record.tmdbType === "movie") return `TMDB ID: movie ${record.tmdbId}, ${via}.`;
			const fallback = record.fallback;
			const seasons = fallback?.seasons;
			// As the TMDB Episodes field says it: "season 2", "from S2E13", "seasons S1-S4"
			const seasonText = !fallback
				? ""
				: seasons
					? `seasons ${formatTmdbEpisodes({ tmdbSeason: fallback.season, tmdbSeasons: seasons, tmdbOffset: fallback.offset })}`
					: landsOn(fallback.season, fallback.offset);
			// Episodes spread over several TMDB seasons (or offsets): each run, e.g. "1-24 S1E1-24; 25-48 S2E1-24"
			const runs = episodeRuns(record);
			let where = "";
			if (runs.length > 1) {
				// Long shows (Doraemon's 31 parts): the first two and the last, every part in the steps (see runsText)
				const shown = runs.length > 3 ? [...runs.slice(0, 2).map(runText), "…", runText(runs[runs.length - 1])] : runs.map(runText);
				where = `, ${runs.length} parts: ${shown.join("; ")}`;
			} else if (fallback) where = `, ${seasonText}`;
			// Stills of main episodes and of specials (S1, S2: Animap's specials, OVAs and the like)
			const keys = Object.keys(record.images);
			const main = keys.filter((k) => /^\d+$/.test(k)).length;
			const stills = keys.length === main ? `${main} stills` : `${keys.length} stills (${main} episodes, ${keys.length - main} specials)`;
			return `TMDB ID: show ${record.tmdbId}${where}, ${via}. ${stills}.`;
		}
		/** What a TMDB match lined up by */
		function matchedBy(r: { byTitle?: boolean; byName?: boolean; byCount?: boolean; byAnidb?: boolean }) {
			if (r.byTitle) return "by episode title (the air dates didn't line up)";
			if (r.byName) return "by its exact title and episode count (TMDB's dates are a few days off)";
			if (r.byCount) return "by episode count (the air dates didn't line up)";
			return `by air date${r.byAnidb ? " (AniDB's)" : ""}`;
		}
		/** The main episodes' TMDB targets as runs: consecutive episodes on the same TMDB season, one after the other. */
		function episodeRuns(record: { map: Record<string, CEM.TMDBTarget> }) {
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
		/** Where the AniDB ID Seanime uses for this anime comes from, for the Media tab, with the lookup's steps when it's one's result. */
		function anidbStatus(mediaId: number): Status {
			const found = (text: string, steps: string[]): Status => ({ text, state: "found", title: "How the AniDB ID was found", steps });
			const override = tmdb.overrides.get(mediaId).anidbId;
			if (override) {
				const { anidbOffset: offset, anidbSpecials: specials, anidbLetter: letter } = tmdb.overrides.get(mediaId);
				const where = formatAnidbEpisodes({ offset, specials, letter });
				const from = where ? `, episodes ${where}` : "";
				return found(`AniDB ID: ${override}, your override.`, [
					`Your override in this tab sets AniDB ${override}${from}`,
					"Used as given: nothing is looked up",
				]);
			}
			if (tmdb.overrides.get(mediaId).anidbNone)
				return {
					text: "AniDB ID: none, your override",
					state: "off",
					title: "Why no AniDB ID has been looked up",
					steps: [
						"Your override in this tab sets none: nothing is looked up on AniDB or added to Seanime's metadata",
						"Seanime's own AniDB IDs (the anime's and its episodes') are left out too",
					],
				};
			const match = anidbStore.get(mediaId);
			const seanime = Number($store.get(`CEM_SEANIME_ANIDB_${mediaId}`)) || 0;
			// Seanime's own: the AniDB ID in its Animap data (unless it's the one the plugin added)
			if (seanime && !(match?.aid === seanime && match.status === "verified"))
				return found(`AniDB ID: ${seanime}, from Seanime's metadata (Animap).`, [
					`Seanime's metadata from Animap has AniDB ${seanime} for this anime`,
					"Nothing to look up: the plugin only looks for an AniDB ID when Seanime's metadata has none",
				]);
			if (isCustomSource(mediaId))
				return {
					text: "AniDB ID: not looked up for custom entries",
					state: "off",
					title: "Why no AniDB ID has been looked up",
					steps: ["Custom sources provide their own metadata: nothing is looked up, only an AniDB ID entered here is used"],
				};
			if (!anidbLookup())
				return {
					text: "AniDB ID: automatic lookup has been disabled",
					state: "off",
					title: "Why no AniDB ID has been looked up",
					steps: [
						"The automatic lookup has been disabled in the plugin settings",
						"Auto-fill will still attempt to find one to save here, or enter it yourself",
					],
				};
			if (match?.status === "verified") {
				let at = match.specials ? ", its specials" : "";
				if (match.offset) at = `, from its episode ${match.offset + 1}${match.specials ? " of the specials" : ""}`;
				return found(
					`AniDB ID: ${match.aid}${at}, found through ${match.from ?? "a lookup"} ` +
						`and checked against AniDB: ${match.reason ?? "air dates line up"}.`,
					match.steps ?? [`${match.from ?? "A lookup"}: AniDB ${match.aid} fits: ${match.reason ?? "air dates line up"}`, OLDER_MATCH],
				);
			}
			if (match?.status === "none")
				return {
					text: `AniDB ID: none found${match.reason ? `: ${match.reason}` : ""}.`,
					state: "failed",
					title: "Why no AniDB ID was found",
					steps: match.steps ?? [match.reason ?? "Nothing usable found", OLDER_MATCH],
				};
			return {
				text: "AniDB ID: not looked up yet.",
				state: "pending",
				title: "When the AniDB ID is looked up",
				steps: [
					"Looked up when Seanime loads this anime (its page, or the watching list) and its metadata has no AniDB ID",
					"Press Refresh to look it up now",
				],
			};
		}

		/**
		 * What's missing for the anime being viewed: a TMDB match (when one is wanted), an AniDB ID (when Seanime has none
		 * and the lookup found none). "Needs a page visit" isn't missing: opening the page resolves it.
		 */
		function problems(mediaId: number) {
			const out: ("TMDB" | "AniDB")[] = [];
			if (tmdb.overrides.get(mediaId).ignoreWarnings) return out;
			const record = thumbnails.get(mediaId);
			if (record?.status === "failed" && wantsMatch(mediaId) && !tmdb.overrides.get(mediaId).tmdbNone) out.push("TMDB");
			const seanime = $store.get(`CEM_SEANIME_ANIDB_${mediaId}`);
			const match = anidbStore.get(mediaId);
			// The lookup only runs for anime Seanime has no AniDB ID for; one Seanime has since got isn't missing
			const settled = tmdb.overrides.get(mediaId).anidbId || tmdb.overrides.get(mediaId).anidbNone;
			if (anidbLookup() && !Number(seanime) && match?.status === "none" && !settled) out.push("AniDB");
			return out;
		}
		const problemText = (missing: ("TMDB" | "AniDB")[]) => {
			if (missing.length === 2) return "No TMDB match and no AniDB ID: open Overrides";
			if (missing[0] === "TMDB") return "No TMDB match: open Overrides";
			return missing.length ? "No AniDB ID: open Overrides" : "";
		};

		/** Warning badge on the tray: how many of the TMDB match and the AniDB ID the anime being viewed is missing. */
		function updateBadge() {
			const media = currentMedia.get();
			tray.updateBadge({ number: media ? problems(media.id).length : 0, intent: "warning" });
		}

		// ----------------------------------------------------------------------------------------------------------------
		// 6. TMDB matching: the refresh, building the match (override, air dates, titles), where the TMDB ID comes from
		// ----------------------------------------------------------------------------------------------------------------
		// Seanime takes episode thumbnails from Animap (TVDB) and keeps them in a 1 hour in-memory cache. The matcher
		// below maps every anime onto TMDB and stores the result on disk; onAnimeMetadata swaps the stills in whenever
		// Seanime rebuilds its cache. Nothing is kept in timers: whether an anime is due is worked out from the stored
		// timestamps, and an anime is refreshed when Seanime next loads it after its data has expired.

		type Mapping = Omit<CEM.ThumbnailRecord, "mediaId" | "images" | "refreshedAt" | "lastSeenAt"> & {
			movie?: CEM.TMDBMovieDetails;
			/** Air-date match only: the (season, offset) runs, in AniDB episode order. */
			segments?: { season: number; offset: number; from: number }[];
			/** Air-date match only: episodes placed by their own date, apart from their segment */
			singles?: { n: number; season: number; episode: number }[];
			/** Failed for want of a TMDB ID, so a title search may help. */
			noId?: boolean;
		};
		type RefreshResult = { record?: CEM.ThumbnailRecord; saved: number; written: string[]; missing: string[] };
		type TMDBEpisode = CEM.TMDBSeasonResults["episodes"][number];

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
						return {
							episode_number: 1, name: m.title, overview: m.overview,
							air_date: m.release_date, runtime: m.runtime, still_path: m.backdrop_path,
						} as TMDBEpisode;
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
				const sorted = episodes.slice().sort((a, b) => a.episode_number - b.episode_number);
				for (const ep of sorted) run.push({ season, episode: ep.episode_number, ep });
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
				if (end === -1) {
					if (r.toEpisode !== undefined) return `TMDB ${tmdbId} has no S${r.toSeason}E${r.toEpisode}`;
					return `TMDB ${tmdbId} has no season ${r.toSeason}`;
				}
				picked.push(...run.slice(start, end + 1));
			}
			return picked.concat(run.slice(end + 1));
		}

		/** Episode overrides always win, over any match: their own show or movie, else the anime's (id) */
		function overrideEpisodes(override: CEM.TMDBOverrides, into: Record<string, CEM.TMDBTarget>, id: number | undefined) {
			for (const o of override.episodeOverrides) {
				if (!o.aniDBEpisode || !tmdbFields(o)) continue;
				if (o.tmdbType === "movie" && o.tmdbId) {
					into[o.aniDBEpisode] = { tmdbId: o.tmdbId, movie: true };
					continue;
				}
				const base = into[o.aniDBEpisode];
				const number = o.aniDBEpisode.match(/\d+/);
				const season = o.tmdbSeason ?? base?.season;
				const episode = o.tmdbEpisode ?? base?.episode ?? (number ? parseInt(number[0], 10) : undefined);
				const target = o.tmdbId ?? id;
				if (target && season !== undefined && episode !== undefined) into[o.aniDBEpisode] = { tmdbId: target, season, episode };
			}
			return into;
		}

		/** What every step of a TMDB match works from (see buildMapping) */
		type MatchInput = {
			mediaId: number;
			media: $app.AL_BaseAnime | undefined;
			session: ReturnType<typeof tmdbSession>;
			override: CEM.TMDBOverrides;
			tmdbId: number;
			episodes: Record<string, $app.Metadata_EpisodeMetadata>;
			/** This anime's own main episodes ("12"), and the highest of them */
			mainKeys: string[];
			highest: number;
			/** AniList's total, 0 when unknown */
			total: number;
			/** The AniDB match stored, and the same while it's in use (see buildMapping) */
			storedAnidb: CEM.AnidbMatch | undefined;
			anidbMatch: CEM.AnidbMatch | undefined;
			/** The ID is a related anime's or a title search's, not this anime's own (see buildMapping) */
			borrowed: boolean;
			fail: (reason: string) => Mapping;
		};
		/** Dated episodes: this anime's episode number and its air day */
		type Dated = { n: number; day: number }[];

		/** Work out where every episode of an anime lives on TMDB. Throws on request errors. */
		async function buildMapping(
			mediaId: number,
			media: $app.AL_BaseAnime | undefined,
			metadata: $app.Metadata_AnimeMetadata | undefined,
			session: ReturnType<typeof tmdbSession>,
			override: CEM.TMDBOverrides,
			/** For a borrowed ID: the TMDB episodes ("season:episode") other anime have as their own. undefined: its own ID. */
			claimed?: Record<string, boolean>,
			/** A title search hit whose name is exactly one of this anime's titles: its dates may be a few days off */
			nameMatch = false,
		): Promise<Mapping> {
			// "none": no match for the anime, only the episodes pointed at their own show or movie
			if (override.tmdbNone) return { status: "failed", reason: "your override sets none", map: overrideEpisodes(override, {}, undefined) };
			const tmdbId = override.tmdbId ?? (Number((metadata?.mappings?.themoviedbId ?? "").replace(/\D/g, "")) || undefined);
			// A failed match still takes the episodes their overrides point at (their own show or movie, else this one's ID)
			const fail = (reason: string): Mapping => ({ status: "failed", reason, map: overrideEpisodes(override, {}, tmdbId) });
			// The AniDB match only while in use (its dates and episodes help the match); the stored one tells whether the list
			// the plugin supplies was dated by AniDB
			const storedAnidb = anidbStore.get(mediaId);
			const anidbInUse = storedAnidb?.status === "override" || (storedAnidb?.status === "verified" && anidbLookup());
			const anidbMatch = !override.anidbNone && anidbInUse ? storedAnidb : undefined;
			const episodes = metadata?.episodes ?? {};
			// AniList's total. Seanime hands optional numbers over as wrapped Go pointers, which === never equals.
			const total = Number(media?.episodes) || 0;
			// A finished anime's total is final: episodes Animap lists past it (an AniDB entry spanning several AniList
			// ones, e.g. Steel Ball Run's 1st STAGE) are the next entry's, which Seanime doesn't show here and which
			// mustn't be claimed from it
			const own = total && String(media?.status) === "FINISHED" ? total : Infinity;
			const mainKeys = Object.keys(episodes).filter((k) => /^\d+$/.test(k) && Number(k) <= own);
			const highest = Math.max(0, ...mainKeys.map(Number));

			if (!tmdbId) {
				let where: string;
				if (!metadata) where = "Seanime returned no Animap data for this anime";
				else if (animap.get(mediaId)?.fallback) where = "Animap has no entry for this anime";
				else {
					const seen = `${Object.keys(episodes).length} episodes, AniDB ${metadata.mappings?.anidbId ?? "none"}`;
					where = `Seanime's Animap data for this anime has no TMDB ID (${seen})`;
				}
				const fix = "Use Auto-fill in the Media tab of Overrides, or enter the TMDB ID there.";
				return { ...fail(`No TMDB ID: there's no TMDB ID override and ${where}. ${fix}`), noId: true };
			}

			// A season override can only mean a TV show. Otherwise try the type the AniList format suggests first.
			let tmdbType: "tv" | "movie" = "tv";
			let details: CEM.TMDBTVShowDetails | CEM.TMDBMovieDetails | undefined;
			if (typeof override.tmdbSeason !== "number") {
				const byFormat: ("tv" | "movie")[] = media?.format?.valueOf() === "MOVIE" ? ["movie", "tv"] : ["tv", "movie"];
				const order = override.tmdbType ? [override.tmdbType] : byFormat;
				let error: unknown;
				/** The movie with this ID came out at another time: with the type unknown, the show with it is tried */
				let otherMovie: string | undefined;
				for (const type of order) {
					try {
						const loaded = await session.details(tmdbId, type);
						// TMDB counts show and movie IDs apart: this anime's own ID without its type (ani.zip, Animap) may name an
						// unrelated movie (e.g. a 1979 film for a 2025 anthology's show), or a movie cut of a TV series AniList
						// lists episode by episode. Only years apart: TMDB often dates a movie by its premiere, weeks or months
						// before. A borrowed one is checked closer (see searchTmdb).
						const unsure = type === "movie" && !override.tmdbType && !claimed;
						const series = total > 1 && /^TV/.test(String(media?.format ?? "")) ? `this anime is a TV series of ${total} episodes` : "";
						const problem = unsure && (series || otherYear(media, metadata, loaded as CEM.TMDBMovieDetails));
						if (problem) {
							otherMovie = `TMDB movie ${tmdbId} doesn't fit: ${problem}`;
							continue;
						}
						details = loaded;
						tmdbType = type;
						break;
					} catch (e) {
						error = e;
					}
				}
				if (!details && otherMovie) return { ...fail(`${otherMovie}, and TMDB has no show with that ID`), tmdbId };
				if (!details) {
					const from = override.tmdbId ? "your override" : "Animap";
					throw new Error(`TMDB ID ${tmdbId} (from ${from}) didn't load: ${(error as Error)?.message ?? "unknown error"}`);
				}
			}

			if (tmdbType === "movie") {
				// One episode, the movie: read like any other episode (see tmdbSession's episode)
				const map: Record<string, CEM.TMDBTarget> = { "1": { tmdbId, movie: true } };
				overrideEpisodes(override, map, tmdbId);
				const source = override.tmdbId ? "override" : "auto";
				return { status: "matched", source, tmdbType, tmdbId, map, movie: details as CEM.TMDBMovieDetails };
			}

			const input: MatchInput = {
				mediaId, media, session, override, tmdbId, episodes, mainKeys, highest, total, storedAnidb, anidbMatch,
				borrowed: !!claimed, fail,
			};
			if (typeof override.tmdbSeason === "number") return overrideMapping(input, override.tmdbSeason);
			return airDateMapping(input, details as CEM.TMDBTVShowDetails, claimed ?? {}, nameMatch);
		}

		/**
		 * The last AniDB episode to take from a TMDB season, including ones that haven't aired yet. Past it the TMDB
		 * season belongs to another AniList entry (e.g. the next cour). AniList's episode total decides when it's
		 * known; otherwise the first episode TMDB marks as a (mid-)season finale, else everything TMDB lists.
		 */
		function seasonLimit(m: MatchInput, seasonEpisodes: TMDBEpisode[], offset: number) {
			if (m.total) return Math.max(m.highest, m.total);
			const finale = seasonEpisodes
				.filter((e) => {
					const finale = e.episode_type === "finale" || e.episode_type === "mid_season";
					return e.episode_number - offset >= Math.max(1, m.highest) && finale;
				})
				.sort((a, b) => a.episode_number - b.episode_number)[0];
			return finale ? Math.max(m.highest, finale.episode_number - offset) : Infinity;
		}

		/**
		 * The media override's season decides everything, with the episode overrides on top. Several seasons are read as
		 * one run of episodes: the offset counts across all of them and season 2 picks up where season 1 ends.
		 */
		async function overrideMapping(m: MatchInput, tmdbSeason: number): Promise<Mapping> {
			const { session, override, tmdbId, mainKeys, total } = m;
			const offset = override.tmdbOffset ?? 0;
			const ranges = override.tmdbRanges?.length ? override.tmdbRanges : undefined;
			const seasons = ranges ? [tmdbSeason] : override.tmdbSeasons?.length ? override.tmdbSeasons : [tmdbSeason];
			const multi = !!ranges || seasons.length > 1;
			await session.prefetch(tmdbId, [
				...seasons,
				...override.episodeOverrides
					.filter((o) => (o.tmdbId ?? tmdbId) === tmdbId && typeof o.tmdbSeason === "number")
					.map((o) => o.tmdbSeason as number),
			]);
			const ranged = ranges ? await rangeRun(session, tmdbId, ranges) : undefined;
			if (typeof ranged === "string") return { ...m.fail(`Your TMDB Episodes ranges don't fit: ${ranged}.`), tmdbId };
			const run = ranged ?? (await seasonRun(session, tmdbId, seasons));
			// Position in the run: the TMDB episode number for one season, the running count for several
			const numbered = run.map((r, i) => ({ ...r.ep, episode_number: multi ? i + 1 : r.episode }));
			// Ranges take every later episode on purpose (sequels to come): no stop at a season finale
			const limit = ranges && !total ? Infinity : seasonLimit(m, numbered, offset);
			const keys = mainKeys.slice();
			for (const ep of numbered) {
				const n = ep.episode_number - offset;
				if (n >= 1 && n <= limit) keys.push(`${n}`);
			}
			for (const ep of override.episodeOverrides) if (ep.aniDBEpisode && tmdbFields(ep)) keys.push(ep.aniDBEpisode);

			const map: Record<string, CEM.TMDBTarget> = {};
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
					// An offset below zero puts the first episodes before the season (Doraemon's 1778=S27E1: episodes
					// 1-1777): nothing there, unless TMDB numbers an episode 0
					if (n < 1 && id === tmdbId && !run.some((r) => r.episode === n)) continue;
					map[key] = { tmdbId: id, season: seasons[0], episode: n };
					continue;
				}
				const hit = run[n - 1];
				if (hit) map[key] = { tmdbId: id, season: hit.season, episode: hit.episode };
			}
			const fallback = { season: seasons[0], offset, ...(multi && !ranges ? { seasons } : {}) };
			return { status: "matched", source: "override", tmdbType: "tv", tmdbId, map, fallback };
		}

		/**
		 * Without a season override: where the air dates line up, else the episode titles, the show's exact name or the
		 * episode count. The steps below, in this order.
		 */
		async function airDateMapping(
			m: MatchInput,
			show: CEM.TMDBTVShowDetails,
			claimed: Record<string, boolean>,
			nameMatch: boolean,
		): Promise<Mapping> {
			const { mediaId, override, tmdbId, anidbMatch, fail } = m;
			const dates = datedEpisodes(m);
			if (!dates) {
				return { ...fail("There are no air dates to match against yet. Set the TMDB Episodes in the Media tab of Overrides."), tmdbId };
			}
			const { anidbDated, listFromAnidb, anidbOk } = dates;
			let dated = dates.dated;
			const first = Math.min(...dated.concat(anidbDated ?? []).map((d) => d.day));
			const last = Math.max(...dated.concat(anidbDated ?? []).map((d) => d.day));
			const near = await tmdbEpisodesNear(m, show, first, last, claimed);

			let best = voteByAirDate(m, near, dated);
			/** Matched with AniDB's air dates (see anidbEvidence) */
			let byAnidb = listFromAnidb && anidbOk;
			const lines = (b: typeof best, set: Dated) => b.segments.length && b.matched * 2 >= set.length;
			// Also when AniDB dates more episodes and puts one of them elsewhere: one date (AniList's start date) lines up
			// with any special of that day, whatever the next ones say
			const place = (b: typeof best, n: number) => {
				const s = b.segments.filter((x) => x.from <= n).pop() ?? b.segments[0];
				const t = b.map[`${n}`];
				return t ? `${t.season}:${t.episode}` : s ? `${s.season}:${n + s.offset}` : "";
			};
			if (anidbDated && (!lines(best, dated) || anidbDated.length > dated.length)) {
				const withAnidb = voteByAirDate(m, near, anidbDated);
				const moves = !lines(best, dated) || anidbDated.some((d) => place(withAnidb, d.n) !== place(best, d.n));
				if (lines(withAnidb, anidbDated) && moves) {
					log.step(
						`${mediaId}: ${best.matched} of ${dated.length} air dates matched TMDB ${tmdbId}; ` +
							`with AniDB ${anidbMatch?.aid}'s dates ${withAnidb.matched} of ${anidbDated.length} do: matched with those`,
					);
					best = withAnidb;
					dated = anidbDated;
					byAnidb = true;
				}
			}
			if (best.shift) {
				const way = best.shift > 0 ? "later" : "earlier";
				log.step(
					`${mediaId}: TMDB ${tmdbId} dates these episodes ${Math.abs(best.shift)} days ${way} ` +
						"(e.g. the TV broadcast instead of the streaming release); matched with that shift",
				);
			}
			const map: Record<string, CEM.TMDBTarget> = {};
			Object.assign(map, best.map);
			const segments = best.segments;

			const other = await matchByTitleOrCount(m, near, { dated, first, map, segments: segments.length, matched: best.matched, nameMatch });
			if ("failed" in other) return { ...fail(other.failed), tmdbId };
			if (other.pick) {
				byAnidb = listFromAnidb && anidbOk;
				for (const key of Object.keys(map)) delete map[key];
				segments.length = 0;
				segments.push({ ...other.pick, from: 1 });
			}
			const singles = other.pick ? [] : best.singles;
			for (const x of singles) {
				log.step(`${mediaId}: episode ${x.n} is TMDB S${x.season}E${x.episode} by its own air date, apart from the others`);
			}

			const fallback = await fillRemaining(m, map, segments, show, near.candidates);
			overrideEpisodes(override, map, tmdbId);
			return {
				status: "matched",
				source: "auto",
				tmdbType: "tv",
				tmdbId,
				map,
				fallback: { season: fallback.season, offset: fallback.offset },
				segments,
				...(singles.length ? { singles } : {}),
				...other.flags,
				...(byAnidb ? { byAnidb } : {}),
			};
		}

		/**
		 * The air dates a match lines up: Seanime's for this anime's main episodes, those aired by tomorrow (Japan is ahead
		 * of the TMDB listing's timezone), else AniList's start date for episode 1; and AniDB's, where they say something
		 * else (anidbDated). undefined: no dates at all.
		 */
		function datedEpisodes(m: MatchInput) {
			const { mediaId, media, episodes, mainKeys, storedAnidb, anidbMatch } = m;
			const today = Math.floor(Date.now() / DAY);
			const anidbOk = anidbEvidence(anidbMatch);
			// The list the plugin supplies (no Animap entry) is dated from AniDB: its dates are AniDB's evidence
			const listFromAnidb = !!animap.get(mediaId)?.fallback && Object.keys(storedAnidb?.airDates ?? {}).length > 0;
			const ownDated = mainKeys.map((k) => ({ n: Number(k), day: toDay(episodes[k].airDate) })).filter((d) => !isNaN(d.day));
			const allDated: Dated = listFromAnidb && !anidbOk ? [] : ownDated;
			let dated = allDated.filter((d) => d.day <= today + 1);
			// Nothing aired yet: TMDB usually lists upcoming episodes with their dates too
			if (!dated.length) dated = allDated;
			// Without Animap dates, AniList's start date still pins down episode 1
			const start = media?.startDate;
			if (!dated.length && start?.year && start.month && start.day) {
				dated = [{ n: 1, day: Math.round(Date.UTC(start.year, start.month - 1, start.day) / DAY) }];
			}
			if (!dated.length) return undefined;
			// AniDB's air dates (the AniDB entry found or set for this anime), where they say something else: when the
			// anime's own don't line up, the match is tried with AniDB's instead
			let anidbDated: Dated | undefined;
			if (anidbOk && anidbMatch?.airDates) {
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
			return { dated, anidbDated, listFromAnidb, anidbOk };
		}

		/**
		 * The TMDB episodes a match can land on: those of the regular seasons that overlap the anime's air dates (first to
		 * last), plus specials (ONAs and OVAs often live there), but not ones other anime have as their own (claimed).
		 */
		async function tmdbEpisodesNear(m: MatchInput, show: CEM.TMDBTVShowDetails, first: number, last: number, claimed: Record<string, boolean>) {
			const regular = (show.seasons ?? []).filter((s) => s.season_number > 0).sort((a, b) => a.season_number - b.season_number);
			const wanted = regular
				.filter((s, i) => {
					const start = toDay(s.air_date);
					const next = toDay(regular[i + 1]?.air_date);
					return (isNaN(start) || start <= last + 1) && (isNaN(next) || next >= first - 1);
				})
				.map((s) => s.season_number);
			if ((show.seasons ?? []).some((s) => s.season_number === 0)) wanted.push(0);

			await m.session.prefetch(m.tmdbId, wanted);
			const candidates: { season: number; episode: number; day: number }[] = [];
			/** "season:episode" -> TMDB's air day, and which episodes TMDB marks as a season's finale */
			const tmdbDays: Record<string, number> = {};
			const finales: Record<string, boolean> = {};
			for (const n of wanted) {
				for (const ep of (await m.session.season(m.tmdbId, n)).episodes) {
					const day = toDay(ep.air_date);
					if (ep.episode_type === "finale") finales[`${n}:${ep.episode_number}`] = true;
					if (isNaN(day) || claimed[`${n}:${ep.episode_number}`]) continue;
					candidates.push({ season: n, episode: ep.episode_number, day });
					tmdbDays[`${n}:${ep.episode_number}`] = day;
				}
			}
			// TMDB's episodes by air day: each dated episode only looks at the days around its own (long shows like
			// Doraemon have ~1800 episodes on each side, too many to compare all with all)
			const byDay: Record<number, typeof candidates> = {};
			for (const c of candidates) (byDay[c.day] ??= []).push(c);
			return { regular, wanted, candidates, tmdbDays, finales, byDay };
		}
		type TmdbNear = Awaited<ReturnType<typeof tmdbEpisodesNear>>;

		/**
		 * Every dated episode votes for the (season, offset) pairs that line its date up with a TMDB episode. Take the
		 * strongest pair, then repeat for what's left, so an entry spanning two TMDB seasons still maps. A week's shift
		 * (TMDB often lists the TV broadcast, a week after the streaming release) only when it explains the dates better,
		 * with nothing at all against it.
		 */
		function voteByAirDate(m: MatchInput, near: TmdbNear, set: Dated) {
			const { tmdbId, mainKeys, episodes, anidbMatch, media, borrowed } = m;
			const { byDay, tmdbDays, finales } = near;
			// On a tie, TMDB's specials season when its AniDB episodes are a related anime's specials, or when it's an OVA,
			// ONA, special or movie with a borrowed ID: the show's main episodes belong to the anime that has it as its own
			// (TMDB sometimes lists an OVA twice, e.g. Pico: My Little Summer Story as S0E1 and S1E3 of Boku no Pico)
			const format = String(media?.format ?? "");
			const extra = borrowed && !!format && format !== "TV" && format !== "TV_SHORT";
			const preferSpecials = (anidbMatch?.status === "verified" && !!anidbMatch.specials) || extra;
			const RUN_GAP = 4;
			/** shift: how many days later TMDB dates the episodes */
			const vote = (shift: number) => {
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
					// Highest score; on a tie prefer a regular season over specials (the other way round with preferSpecials),
					// then the smaller offset
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
				// An episode left on its own (too few for a part) that its part would put on a TMDB episode dated more than a
				// week away, but whose own day has exactly one free episode of that season: placed there by itself. Specials
				// rarely run in order (Attack on Titan's OVAs are TMDB's S0E7, 13 and 14, Chibi Theater shorts in between),
				// and a stray a day or two off (a donghua) is never more than a week away.
				const singles: { n: number; season: number; episode: number }[] = [];
				for (const d of set) {
					const s = segments.filter((x) => x.from <= d.n).pop() ?? segments[0];
					if (!s || map[`${d.n}`] || Math.abs((tmdbDays[`${s.season}:${d.n + s.offset}`] ?? Infinity) - shift - d.day) <= 7) continue;
					const hits = (byDay[d.day + shift] ?? []).filter((c) => c.season === s.season && !claimedHere[`${c.season}:${c.episode}`]);
					if (hits.length !== 1) continue;
					map[`${d.n}`] = { tmdbId, season: s.season, episode: hits[0].episode };
					claimedHere[`${s.season}:${hits[0].episode}`] = true;
					singles.push({ n: d.n, season: s.season, episode: hits[0].episode });
					mapped++;
				}
				// What speaks against it: a dated episode its segment puts on a TMDB episode dated elsewhere (e.g. episode 1 of
				// a second cour on the first cour's last episode, months earlier), or an episode on a TMDB finale with the
				// next episode right after it in the same season
				segments.sort((a, b) => a.from - b.from);
				const at = (n: number) => {
					if (map[`${n}`]) return `${map[`${n}`].season}:${map[`${n}`].episode}`;
					const s = segments.filter((x) => x.from <= n).pop() ?? segments[0];
					return s ? `${s.season}:${n + s.offset}` : "";
				};
				let against = 0;
				// The list the plugin supplies is dated from AniDB: early-screened first episodes would push the match a
				// week's shift and an episode off
				const byN: Record<number, number> = {};
				for (const d of set) byN[d.n] = d.day;
				const early = earlyScreenings((n) => {
					const day = tmdbDays[at(n)];
					return byN[n] !== undefined && day !== undefined ? [byN[n], day - shift] : undefined;
				}, Math.max(0, ...set.map((d) => d.n)));
				for (const d of set) {
					const day = tmdbDays[at(d.n)];
					if (day !== undefined && Math.abs(day - shift - d.day) > 1 && d.n > early) against++;
				}
				for (const key of mainKeys) {
					const here = at(Number(key));
					const [season, episode] = here.split(":").map(Number);
					if (finales[here] && episodes[`${Number(key) + 1}`] && at(Number(key) + 1) === `${season}:${episode + 1}`) against++;
				}
				return { map, segments, singles, matched: mapped, against, shift };
			};
			let best = vote(0);
			if (!best.segments.length || best.matched < set.length || best.against) {
				for (const shift of [7, -7]) {
					const other = vote(shift);
					const beat = best.segments.length ? best.matched - best.against : 0;
					if (other.segments.length && !other.against && other.matched > beat) best = other;
				}
			}
			return best;
		}

		/**
		 * Episode titles: each titled episode votes for the (season, offset) pairs that put it on a TMDB episode of the same
		 * title. top: the strongest, when at least half the titled episodes agree on it and nothing ties.
		 */
		async function voteByTitle(m: MatchInput, numbers: number[], titled: { n: number; title: string }[]) {
			const votes: Record<string, number> = {};
			const titles: Record<string, string> = {};
			for (const n of numbers) {
				for (const ep of (await m.session.season(m.tmdbId, n)).episodes) titles[`${n}:${ep.episode_number}`] = plainTitle(ep.name);
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
			const ranked = Object.keys(votes).sort((a, b) => votes[b] - votes[a]);
			const tied = !!ranked[1] && votes[ranked[1]] === votes[ranked[0]];
			const top = ranked[0] && votes[ranked[0]] * 2 >= titled.length && !tied ? ranked[0] : undefined;
			return { votes, titles, top, best: ranked[0] as string | undefined };
		}

		/**
		 * What replaces the air dates' match (pick), when something else decides: episode titles outrank dates that matched;
		 * dates that don't line up fall back to the titles, the show's exact name, then the episode count, else the match
		 * fails. No pick: the air dates' match stands.
		 */
		async function matchByTitleOrCount(
			m: MatchInput,
			near: TmdbNear,
			found: { dated: Dated; first: number; map: Record<string, CEM.TMDBTarget>; segments: number; matched: number; nameMatch: boolean },
			): Promise<
				{ pick?: { season: number; offset: number }; flags: { byTitle?: boolean; byName?: boolean; byCount?: boolean } } | { failed: string }
			> {
			const { mediaId, session, tmdbId, episodes, mainKeys, highest, total } = m;
			const { regular, wanted, tmdbDays } = near;
			const { dated, first, map, segments, matched, nameMatch } = found;
			// Animap's episode titles are often TMDB's word for word (placeholders like "Episode 4" don't count)
			const titled = mainKeys.map((k) => ({ n: Number(k), title: plainTitle(episodes[k].title) })).filter((t) => t.title);
			if (segments && matched * 2 >= dated.length) {
				if (titled.length < 2) return { flags: {} };
				// The dates matched, but titles outrank them: when TMDB's dates run a week off, the dates can point one
				// episode too early with most of them still lining up
				const { votes, titles, top } = await voteByTitle(m, wanted.filter((n) => n > 0), titled);
				const hits = titled.filter((t) => map[`${t.n}`] && titles[`${map[`${t.n}`].season}:${map[`${t.n}`].episode}`] === t.title).length;
				if (!top || votes[top] < 2 || votes[top] <= hits) return { flags: {} };
				const [season, offset] = top.split(":").map(Number);
				log.step(
					`${mediaId}: the air dates put ${hits} of ${titled.length} episode titles on TMDB ${tmdbId}'s; ` +
						`matched by title instead (${votes[top]} titles, ${landsOn(season, offset)})`,
				);
				return { pick: { season, offset }, flags: { byTitle: true } };
			}

			// The air dates don't line up: TMDB lists a streaming release (every episode on one day) instead of the
			// Japanese broadcast, or simply wrong dates. Episode titles come next.
			const numbers = regular.map((s) => s.season_number);
			if (titled.length) await session.prefetch(tmdbId, numbers.filter((n) => wanted.indexOf(n) === -1));
			const noTitles = { votes: {} as Record<string, number>, top: undefined, best: undefined };
			const { votes, top, best } = titled.length ? await voteByTitle(m, numbers, titled) : noTitles;
			if (top) {
				const [season, offset] = top.split(":").map(Number);
				log.step(
					`${mediaId}: ${matched} of ${dated.length} air dates matched TMDB ${tmdbId}; matched by episode title instead ` +
						`(${votes[top]} of ${titled.length} titles, ${landsOn(season, offset)})`,
				);
				return { pick: { season, offset }, flags: { byTitle: true } };
			}
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
			const named = nameMatch ? nearSeason() : undefined;
			if (named !== undefined) {
				log.step(
					`${mediaId}: ${matched} of ${dated.length} air dates matched TMDB ${tmdbId}; its title is this anime's and its season ` +
						`${named} has as many episodes, all dated within a week: matched by that`,
				);
				return { pick: { season: named, offset: 0 }, flags: { byName: true } };
			}
			// Otherwise one regular season with exactly as many episodes as the anime, starting no earlier: episodes
			// then match by number
			const same = regular.filter((s) => s.episode_count === highest && !(toDay(s.air_date) < first - 1));
			if (highest >= 2 && mainKeys.length === highest && same.length === 1) {
				log.step(
					`${mediaId}: ${matched} of ${dated.length} air dates matched TMDB ${tmdbId}; matched by episode count instead ` +
						`(season ${same[0].season_number}, ${highest} episodes)`,
				);
				return { pick: { season: same[0].season_number, offset: 0 }, flags: { byCount: true } };
			}
			const titles = titled.length ? `, ${best ? votes[best] : 0} of ${titled.length} by title` : "";
			const failed = `Only ${matched} of ${dated.length} episodes matched TMDB ${tmdbId} by air date${titles}.`;
			return { failed: `${failed} Set the TMDB Episodes in Overrides.` };
		}

		/**
		 * The episodes the match hasn't placed: undated, unaired or unmatched ones follow the part they sit in; episodes
		 * TMDB lists that Seanime doesn't have yet; specials and episode 0. Returns the last part, the one later episodes
		 * follow.
		 */
		async function fillRemaining(
			m: MatchInput,
			map: Record<string, CEM.TMDBTarget>,
			segments: { season: number; offset: number; from: number }[],
			show: CEM.TMDBTVShowDetails,
			candidates: TmdbNear["candidates"],
		) {
			const { mediaId, session, tmdbId, episodes, mainKeys, highest, total } = m;
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
			const limit = seasonLimit(m, seasonEpisodes, fallback.offset);
			for (const ep of seasonEpisodes) {
				const n = ep.episode_number - fallback.offset;
				if (n > highest && n <= limit && !map[`${n}`]) map[`${n}`] = { tmdbId, season: fallback.season, episode: ep.episode_number };
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
			return fallback;
		}

		const inFlight: Record<number, Promise<RefreshResult>> = {};

		/**
		 * The steps a TMDB refresh or an AniDB lookup went through, for the hover panels on the Media tab's status lines:
		 * begun when one starts, added to as it goes and stored with its result. A lookup not begun (Auto-fill's) adds none.
		 */
		const traces: Record<string, string[]> = {};
		const trace = {
			begin: (kind: "tmdb" | "anidb", mediaId: number) => void (traces[`${kind}${mediaId}`] = []),
			add: (kind: "tmdb" | "anidb", mediaId: number, step: string) => void traces[`${kind}${mediaId}`]?.push(step),
			end: (kind: "tmdb" | "anidb", mediaId: number) => {
				const steps = traces[`${kind}${mediaId}`];
				delete traces[`${kind}${mediaId}`];
				return steps?.length ? { steps: steps.slice(0, 40) } : {};
			},
		};
		/** Where episode 1 lands, as the TMDB Episodes field says it: "season 2", "from S2E13", "episode 1778 on S27E1" */
		function landsOn(season: number, offset = 0) {
			if (offset > 0) return `from S${season}E${offset + 1}`;
			return offset < 0 ? `episode ${1 - offset} on S${season}E1` : `season ${season}`;
		}
		/** Where a show's match puts the episodes: where episode 1 lands, or how many parts it's in, as the status line counts them */
		function matchWhere(m: { map: Record<string, CEM.TMDBTarget>; fallback?: { season: number; offset: number } }) {
			const parts = episodeRuns(m).length;
			if (parts > 1) return `in ${parts} parts`;
			return m.fallback ? landsOn(m.fallback.season, m.fallback.offset) : "";
		}
		/** A TMDB candidate's verdict, for the steps */
		function outcome(m: Mapping) {
			if (m.status !== "matched") {
				return `didn't fit: ${(m.reason ?? "no match").replace(/\s*Set the TMDB (Season and Offset|Episodes) in Overrides\.$/, "")}`;
			}
			const apart = (m.singles ?? []).map((x) => `, episode ${x.n} on S${x.season}E${x.episode} by its own air date`).join("");
			const where = m.tmdbType === "movie" ? " (a movie)" : m.fallback ? `, ${matchWhere(m)}${apart}` : "";
			return `matched${where}, ${m.source === "override" ? "as your override sets it" : matchedBy(m)}`;
		}

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
			const result: RefreshResult = { saved: 0, written: [], missing: [] };
			if (!tmdb.API_KEY) return result;
			report(mediaId, "Loading the episode list");

			const old = thumbnails.get(mediaId);
			const now = Date.now();
			const { media, metadata, flagged } = await loadForRefresh(mediaId, force, now);
			trace.begin("tmdb", mediaId);
			trace.add("tmdb", mediaId, episodeListStep(mediaId, media, metadata));

			const session = tmdbSession();
			const override = tmdb.overrides.get(mediaId);
			let mapping: Mapping;
			try {
				mapping = await matchOnTmdb(mediaId, media, metadata, session, override, scope);
			} catch (e) {
				// A request error (offline, TMDB down) keeps a good match; the next refresh tries again
				if (old?.status === "matched") {
					log.warn(`${mediaId}: TMDB request failed, keeping the previous match:`, e);
					return { ...result, record: old };
				}
				// Episodes pointed at their own show or movie don't need the anime's (e.g. its ID no longer loads)
				mapping = { status: "failed", reason: (e as Error).message, map: overrideEpisodes(override, {}, undefined) };
			}
			// Episodes whose override says "none": no still or fill-in, whatever the match
			for (const o of override.episodeOverrides) if (o.tmdbNone && o.aniDBEpisode) delete mapping.map[o.aniDBEpisode];

			if (mapping.status === "matched") report(mediaId, `Fetching TMDB ${mapping.tmdbId}'s episodes and stills`);
			const { images, found } = await fetchEpisodes(mediaId, mapping, media, metadata, session, now);
			const gapList = isOn("tmdb-fill-missing") ? gapKeys(mediaId) : [];
			// A failed match's episodes are only the ones their overrides point at
			const episodes = isOn("tmdb-fill-missing") ? fillInData(mediaId, found, images, gapList, media, metadata, now) : undefined;
			const next = nextCheck(mapping, old, media, metadata, images, found, gapList, now);

			const { movie: _movie, segments, singles, noId, ...stored } = mapping;
			const record: CEM.ThumbnailRecord = {
				mediaId,
				...stored,
				images,
				...(episodes ? { episodes } : {}),
				nextCheckAt: next.at,
				...(next.failedSince !== undefined ? { failedSince: next.failedSince } : {}),
				...trace.end("tmdb", mediaId),
				refreshedAt: now,
				lastSeenAt: old?.lastSeenAt ?? now,
			};
			thumbnails.set(mediaId, record);
			result.record = record;
			rematchBorrowers(record);
			if (writeMetadata && record.status === "matched") writeToCustom(mediaId, mapping, found, images, metadata, now, result);

			// No record shows as much as one without stills or fill-in: a first match with nothing to show rebuilds nothing
			const shown = (r: CEM.ThumbnailRecord | undefined) => stableJson([r?.images ?? {}, r?.episodes ?? {}]);
			const showsAnything = isOn("tmdb-thumbnails") || fillsMissing(mediaId) || !!record.episodes || !!old?.episodes;
			const imagesChanged = showsAnything && (flagged || shown(old) !== shown(record));
			// Whether Seanime has metadata for it doesn't change with what was written. Not known yet: the metadata loaded
			// above already answers it (without a status the hook didn't supply it), so there's no need to clear Seanime's
			// cache and ask Animap again. Custom sources provide their own metadata and get no status.
			if (result.saved && metadata && !animap.get(mediaId) && !isCustomSource(mediaId)) {
				animap.set(mediaId, { fallback: false, episodeCount: 0, checkedAt: now });
			}
			if (result.saved || imagesChanged) scheduleRebuild(imagesChanged, mediaId);

			const name = media?.title?.userPreferred ?? `${mediaId}`;
			if (record.status === "failed") {
				if (old?.status !== "failed" || old.reason !== record.reason) log.warn(`${name} (${mediaId}): match failed: ${record.reason}`);
				else log.step(`${name} (${mediaId}): still failing: ${record.reason}`);
			} else {
				const where = record.tmdbType === "movie" ? "movie" : matchWhere(record) || "?";
				const written = result.saved ? `, ${result.saved} episodes written` : "";
				const stills = `${Object.keys(images).length} stills${written}`;
				const line = `${name} (${mediaId}): TMDB ${record.tmdbId} ${where}, ID from ${record.idFrom ?? "?"}, ${stills}`;
				if (imagesChanged || result.saved || old?.tmdbId !== record.tmdbId) log.info(line);
				else log.step(`${line} (unchanged)`);
			}
			log.step(`${name} (${mediaId}): next refresh ${new Date(record.nextCheckAt ?? 0).toISOString()} (${next.why})`);
			if (debugging) {
				const { episodes: _filled, ...shown } = record;
				log.inspect(`${mediaId}: stored TMDB record`, shown);
			}

			updateBadge();
			return result;
		}

		/**
		 * The anime's AniList entry and Seanime's metadata for a refresh. flagged: found just now to have no Animap data.
		 * Animap may have added an anime it had no entry for; while the flag is set the metadata carries no TMDB ID or air
		 * dates. Asking clears Seanime's whole metadata cache, so it's re-checked daily for the first week (the first "no
		 * entry" may have been Animap or the network failing), weekly after that, and whenever the user saves overrides or
		 * runs Bulk Update.
		 */
		async function loadForRefresh(mediaId: number, force: boolean, now: number) {
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
			const flagged = !metadata && !animap.get(mediaId) && !isCustomSource(mediaId);
			if (flagged) animap.set(mediaId, { fallback: true, episodeCount: episodeCount(media), checkedAt: now, since: now });
			return { media, metadata, flagged };
		}

		/** The refresh's first step: which episode list the match works from */
		function episodeListStep(mediaId: number, media: $app.AL_BaseAnime | undefined, metadata: $app.Metadata_AnimeMetadata | undefined) {
			const listed = Object.keys(metadata?.episodes ?? {}).filter((k) => /^\d+$/.test(k));
			const dated = listed.filter((k) => !!metadata?.episodes?.[k]?.airDate).length;
			const total = Number(media?.episodes) || 0;
			// See buildMapping: a finished anime's episodes past its AniList total aren't its own
			const ownOnly = total === 1 ? "episode 1 is" : `episodes 1-${total} are`;
			const own = String(media?.status) === "FINISHED" && total && listed.length > total ? `; only ${ownOnly} its own, by AniList's total` : "";
			const count = `${listed.length} episode${listed.length === 1 ? "" : "s"}, ${dated === listed.length ? "all" : dated} dated${own}`;
			const byAnidb = anidbEvidence(anidbStore.get(mediaId)) && Object.keys(anidbStore.get(mediaId)?.airDates ?? {}).length ? " by AniDB" : "";
			if (animap.get(mediaId)?.fallback)
				return metadata
					? `Episode list: the plugin's own, Animap has no entry for this anime (${count}${byAnidb})`
					: "Episode list: none yet, Animap has no entry for this anime (the plugin supplies one)";
			if (!metadata) return "Episode list: none, Seanime has no metadata for this anime";
			return `Episode list: Seanime's metadata from Animap (${count})`;
		}

		/**
		 * The TMDB match: from the override's ID or Animap's, else (no ID override) another ID searched for (see
		 * searchTmdb). Throws on request errors.
		 */
		async function matchOnTmdb(
			mediaId: number,
			media: $app.AL_BaseAnime | undefined,
			metadata: $app.Metadata_AnimeMetadata | undefined,
			session: ReturnType<typeof tmdbSession>,
			override: CEM.TMDBOverrides,
			scope: Scope,
		): Promise<Mapping> {
			let mapping = await buildMapping(mediaId, media, metadata, session, override);
			mapping.idFrom = override.tmdbId ? "your override" : "Animap";
			let step = `TMDB ${mapping.tmdbId ?? override.tmdbId} from ${mapping.idFrom}: ${outcome(mapping)}`;
			if (override.tmdbNone) step = "Your override sets none: nothing is looked up on TMDB";
			else if (mapping.noId) step = "No TMDB ID in your overrides or Seanime's metadata";
			trace.add("tmdb", mediaId, step);
			if (mapping.status !== "failed" || override.tmdbId || override.tmdbNone) return mapping;

			// No ID from the override or Animap: search TMDB by title, each hit checked against the air dates. Air dates
			// from Animap make that check strong, or AniList's full start date for an anime that hasn't aired yet (TMDB
			// has to date its first episode that day), or for a one-episode anime its start year (a movie found has to
			// have come out that year; a show can't line up without dates); anime without any need the fill-in setting.
			const start = media?.startDate;
			const unaired = !!(start?.year && start.month && start.day) && !Object.keys(metadata?.episodes ?? {}).some((k) => /^\d+$/.test(k));
			const single = !!start?.year && (Number(media?.episodes) || 0) <= 1;
			const dated = unaired || single || Object.keys(metadata?.episodes ?? {}).some((k) => !!metadata?.episodes?.[k]?.airDate);
			const custom = isCustomSource(mediaId); // custom sources have no mappings, the title is all there is
			const { found, firstValid } = await searchTmdb(
				mediaId, media, metadata, session, undefined, dated || custom || fillsMissing(mediaId), mapping.tmdbId ? [mapping.tmdbId] : [], scope,
			);
			if (found) {
				const foundOverride = { ...override, tmdbId: found.id, tmdbType: found.mapping.tmdbType };
				const claimed = found.borrowed ? claimedEpisodes(mediaId, found.id) : undefined;
				const again = await buildMapping(mediaId, media, metadata, session, foundOverride, claimed);
				const base = again.status === "matched" ? again : found.mapping;
				mapping = { ...base, source: "auto", idFrom: found.from, ...(found.borrowed ? { borrowed: true } : {}) };
			} else if (mapping.noId && firstValid) {
				// Say what was found and why it didn't fit, not just that Animap had nothing
				const why = `TMDB ${firstValid.id} (from ${firstValid.from}) didn't line up: ${firstValid.reason ?? "no match"}`;
				mapping = { ...mapping, reason: why };
			}
			return mapping;
		}

		/**
		 * TMDB's episode for every episode the match maps, and the stills among them. A just-aired episode without a still or
		 * overview: TMDB's API may serve a cached copy of its season that lags hours behind, so the season is fetched again
		 * past it (episodes from the last 14 days only).
		 */
		async function fetchEpisodes(
			mediaId: number,
			mapping: Mapping,
			media: $app.AL_BaseAnime | undefined,
			metadata: $app.Metadata_AnimeMetadata | undefined,
			session: ReturnType<typeof tmdbSession>,
			now: number,
		) {
			const images: Record<string, string> = {};
			const found: Record<string, TMDBEpisode> = {};
			const today = Math.floor(now / DAY);
			const nextEpisode = Number(media?.nextAiringEpisode?.episode) || 0;
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
				const name = plainTitle(e.name) ? e.name : more.name || e.name;
				return { ...e, still_path: e.still_path || more.still_path, overview: e.overview || more.overview, name };
			};
			const fresh: Record<string, Promise<CEM.TMDBSeasonResults | undefined>> = {};
			const freshSeason = (tmdbId: number, season: number) =>
				(fresh[`${tmdbId}:${season}`] ??= tmdb.getSeasons(tmdbId, [season], now).then((r) => r[season], () => undefined));
			for (const [key, target] of Object.entries(mapping.map)) {
				let episode = await session.episode(target);
				if (episode && lacks(episode) && freshlyAired(key) && target.season !== undefined && target.episode !== undefined) {
					const tmdbId = target.tmdbId, season = target.season, number = target.episode;
					const current = (await freshSeason(tmdbId, season))?.episodes?.find((e) => e.episode_number === number);
					episode = merge(episode, current, "current season list", key);
				}
				if (!episode) continue;
				found[key] = episode;
				if (episode.still_path?.length) images[key] = episode.still_path;
			}
			return { images, found };
		}

		/**
		 * TMDB's episode data kept in the background to fill in what Seanime lacks: every episode's when Seanime has no
		 * metadata for this anime; otherwise only for episodes it has no overview, thumbnail, title or length for (gapList)
		 * and aired ones Animap doesn't list yet. undefined: nothing to keep.
		 */
		function fillInData(
			mediaId: number,
			found: Record<string, TMDBEpisode>,
			images: Record<string, string>,
			gapList: string[],
			media: $app.AL_BaseAnime | undefined,
			metadata: $app.Metadata_AnimeMetadata | undefined,
			now: number,
		) {
			let episodes: CEM.ThumbnailRecord["episodes"];
			const nextEpisode = Number(media?.nextAiringEpisode?.episode) || 0;
			const all = fillsMissing(mediaId);
			const gaps = all ? [] : gapList;
			// Aired main episodes Animap doesn't list yet count as gaps too. Aired by TMDB's date, or by AniList's next
			// episode when TMDB dates them later (the TV broadcast, a week after streaming)
			const aired = new Date(now).toISOString().slice(0, 10);
			const airedByDate = (key: string) => !!found[key].air_date && found[key].air_date <= aired;
			const airedEarly = (key: string) => /^\d+$/.test(key) && Number(key) < nextEpisode && !airedByDate(key);
			const absent = (key: string) => /^\d+$/.test(key) && !metadata?.episodes?.[key] && (airedByDate(key) || airedEarly(key));
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
			return episodes;
		}

		/**
		 * When the match is refreshed next (at), and why. An hour after the next episode airs (TMDB usually has it by then);
		 * while a recent episode still has no still (or, with fill-in, nothing to fill in its missing overview) every 2 hours
		 * for its first 2 days, then daily; weekly otherwise. Aired: by Animap's date, a day ahead since it's Japan's (an
		 * episode at 00:30 there is the day before in UTC), or by AniList's next episode (Animap may date the TV broadcast a
		 * week after the stream). A failed match: daily for its first week of failing (TMDB may add the anime, or a related
		 * one gets matched), weekly after that (e.g. an anime TMDB doesn't list at all); a refresh by hand doesn't restart
		 * the week (failedSince).
		 */
		function nextCheck(
			mapping: Mapping,
			old: CEM.ThumbnailRecord | undefined,
			media: $app.AL_BaseAnime | undefined,
			metadata: $app.Metadata_AnimeMetadata | undefined,
			images: Record<string, string>,
			found: Record<string, TMDBEpisode>,
			gapList: string[],
			now: number,
		) {
			const today = Math.floor(now / DAY);
			const nextEpisode = Number(media?.nextAiringEpisode?.episode) || 0;
			const lacking = Object.entries(metadata?.episodes ?? {})
				.filter(([key]) => /^\d+$/.test(key))
				.map(([key, ep]) => {
					const day = toDay(ep.airDate);
					const aired = (!isNaN(day) && day <= today + 1) || Number(key) < nextEpisode;
					const recent = isNaN(day) || today - day <= 30;
					const gap = gapList.indexOf(key) !== -1;
					const missing = !images[key] ? isOn("tmdb-thumbnails") || !isOn("tmdb-fill-missing") || gap : gap && !found[key]?.overview;
					return aired && recent && missing ? (isNaN(day) ? today : Math.min(day, today)) : NaN;
				})
				.filter((day) => !isNaN(day));
			const recentWithoutStill = lacking.length > 0;
			const justAired = lacking.some((day) => today - day <= 2);
			const failedSince = mapping.status === "failed" ? (old?.status === "failed" ? old.failedSince ?? old.refreshedAt : now) : undefined;
			const failedEvery = failedSince !== undefined && now - failedSince >= 7 * DAY ? 7 * DAY : DAY;
			let at = now + (mapping.status === "failed" ? failedEvery : 7 * DAY);
			const airingAt = media?.nextAiringEpisode?.airingAt;
			if (airingAt) at = Math.min(at, Math.max(now + HOUR, airingAt * 1000 + HOUR));
			else if (media?.nextAiringEpisode) at = Math.min(at, now + DAY);
			if (recentWithoutStill) at = Math.min(at, now + (justAired ? 2 * HOUR : DAY));

			let why = "finished, weekly";
			if (mapping.status === "failed") why = `failed${failedEvery > DAY ? " for over a week, weekly" : ", daily"}`;
			else if (recentWithoutStill && at === now + (justAired ? 2 * HOUR : DAY))
				why = `a recent episode has no still or overview yet, ${justAired ? "every 2 hours" : "daily"}`;
			else if (airingAt) why = "an hour after the next episode airs";
			else if (media?.nextAiringEpisode) why = "airing, daily";
			return { at, failedSince, why };
		}

		/**
		 * A movie, or a show's main episodes, belong to one anime: one that borrowed them from a related anime or a search
		 * gets matched again once the anime they're the own match of is matched
		 */
		function rematchBorrowers(record: CEM.ThumbnailRecord) {
			if (record.status !== "matched" || record.borrowed) return;
			const mine = (r: CEM.ThumbnailRecord) =>
				Object.keys(r.map)
					.filter((k) => /^\d+$/.test(k) && r.map[k].tmdbId === record.tmdbId)
					.map((k) => `${r.map[k].season}:${r.map[k].episode}`);
			const own = mine(record);
			for (const other of Object.values(thumbnails.all())) {
				const sameMatch = other.tmdbId === record.tmdbId && other.tmdbType === record.tmdbType;
				if (other.mediaId === record.mediaId || !sameMatch || !other.borrowed || other.nextCheckAt === 1) continue;
				if (record.tmdbType === "tv" && !mine(other).some((t) => own.indexOf(t) !== -1)) continue;
				const what = record.tmdbType === "tv" ? "'s episodes are" : " is";
				log.step(`${other.mediaId}: TMDB ${record.tmdbId}${what} ${record.mediaId}'s own match; matching ${other.mediaId} again`);
				thumbnails.set(other.mediaId, { ...other, nextCheckAt: 1 }); // due now
			}
		}

		/** Bulk Update's TMDB part: each matched episode's TMDB data into the custom metadata, counted in result */
		function writeToCustom(
			mediaId: number,
			mapping: Mapping,
			found: Record<string, TMDBEpisode>,
			images: Record<string, string>,
			metadata: $app.Metadata_AnimeMetadata | undefined,
			now: number,
			result: RefreshResult,
		) {
			const today = Math.floor(now / DAY);
			const explicit = tmdb.overrides.get(mediaId).episodeOverrides.filter(tmdbFields).map((o) => o.aniDBEpisode);
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
				result.written.push(key);
			}
		}

		/**
		 * The Refresh button: this anime only, everything at once, even when nothing has expired. Re-checks Animap, the
		 * AniDB ID and the TMDB match (related anime included), then rebuilds Seanime's data for the open page.
		 */
		async function refreshEntry(mediaId: number) {
			log.mark(`Refresh button: ${mediaId}`);
			log.info(`${mediaId}: refreshing by hand (Refresh button)`);
			report(mediaId, "Checking for missing episodes");
			await detectMissing(mediaId);
			if (await needsAnidb(mediaId)) await refreshAnidb(mediaId, true);
			// TMDB with its switches on, or from a TMDB override (by hand, with a token)
			const byTmdb = tmdbOn() || (!!tmdb.API_KEY && tmdbOverridden(mediaId));
			const result: RefreshResult = byTmdb ? await refreshAnime(mediaId, false, true) : { saved: 0, written: [], missing: [] };
			// TMDB's dates may let AniDB's ID be checked better (only redone when there are more of them)
			if (byTmdb && (await needsAnidb(mediaId))) await refreshAnidb(mediaId);
			scheduleRebuild(true);
			const record = result.record;
			if (!record) return `Refreshed. ${anidbStatus(mediaId).text}`;
			if (record.status === "failed") {
				const none = tmdb.overrides.get(mediaId).tmdbNone;
				const overridden = Object.keys(record.map).length;
				if (!overridden && !none) throw new Error(record.reason ?? "Couldn't match this anime on TMDB.");
				const episodes = overridden ? `, ${overridden} episode${overridden === 1 ? "" : "s"} from their own override` : "";
				return `Refreshed: ${none ? "TMDB set to none by your override" : "no TMDB match for the anime"}${episodes}.`;
			}
			const written = result.saved ? `, ${result.saved} episodes written` : "";
			return `Refreshed: TMDB ${record.tmdbId}, ${Object.keys(record.images).length} stills${written}.`;
		}

		/** A TMDB ID (or "none") in the anime's overrides, its own or an episode's: matched by hand, whatever the switches say */
		const tmdbOverridden = (mediaId: number) => {
			const override = tmdb.overrides.get(mediaId);
			return !!override.tmdbId || !!override.tmdbNone || override.episodeOverrides.some((o) => !!o.tmdbId);
		};

		/** After overrides change: rematch straight away, writing metadata only if the automatic refresh would. */
		function rematch(mediaId: number) {
			if (!wantsMatch(mediaId) && !(tmdb.API_KEY && tmdbOverridden(mediaId))) return;
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
				const result = {
					tmdbId: Number(`${mappings.themoviedb_id ?? ""}`.replace(/\D/g, "")) || undefined,
					anidbId: mappings.anidb_id || undefined,
				};
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
			type Cached = { tmdbId?: number; tmdbType?: "tv" | "movie"; anidbId?: number; at: number };
			const cache = $storage.get<Record<number, Cached>>(ANIMEAPI_KEY) ?? {};
			const hit = cache[mediaId];
			if (hit && Date.now() - hit.at < ANIMEAPI_KEEP) return hit;
			if (Date.now() - animeapiLastCall < ANIMEAPI_SPACING) {
				log.debug(`${mediaId}: AnimeAPI skipped (rate limit)`);
				return {};
			}
			animeapiLastCall = Date.now();
			try {
				const res = await ctx.fetch(`https://animeapi.my.id/anilist/${mediaId}`, { timeout: 10 });
				if (!res.ok && res.status !== 404) return {};
				type Answer = { themoviedb?: number | null; themoviedb_type?: "tv" | "movie" | null; anidb?: number | null };
				const data = (res.ok ? res.json() : {}) as Answer;
				const result = {
					tmdbId: data.themoviedb || undefined,
					tmdbType: data.themoviedb_type || undefined,
					anidbId: data.anidb || undefined,
				};
				log.debug(`${mediaId}: AnimeAPI`, result);
				cache[mediaId] = { ...result, at: Date.now() };
				$storage.set(ANIMEAPI_KEY, cache);
				return result;
			} catch (e) {
				log.debug(`${mediaId}: AnimeAPI failed`, e);
				return {};
			}
		}

		// V2: steps also take an alternative version (V1 cached "none" for those for 30 days)
		const RELATIONS_KEY = "ANILIST_RELATIONS_V2";
		if ($storage.get("ANILIST_RELATIONS_V1") !== undefined) $storage.remove("ANILIST_RELATIONS_V1");
		/** The relation steps on disk, read once (only this context uses them) and written through. */
		let relationCache: Record<number, CEM.RelationStep> | undefined;
		const relationSteps = () => (relationCache = relationCache ?? $storage.get<Record<number, CEM.RelationStep>>(RELATIONS_KEY) ?? {});
		/**
		 * One step up from an anime: its parent, else its prequel, else an alternative version (e.g. an edited cut of an
		 * OVA, which TMDB keeps among that OVA's specials). Cached on disk for 30 days, so sequels sharing a
		 * prequel and repeat visits don't ask AniList again. $anilist.getAnimeDetails blocks this whole context until
		 * AniList answers, so in the background the calls are spaced out. undefined: AniList couldn't be asked.
		 */
		async function relationStep(mediaId: number, scope: Scope): Promise<CEM.RelationStep["next"] | undefined> {
			const hit = relationSteps()[mediaId];
			// Steps cached before the episode count was kept are asked again
			if (hit && Date.now() - hit.at < RELATIONS_KEEP && !(hit.next && hit.next.episodes === undefined)) {
				log.debug(`${mediaId}: related step (cached): ${hit.next ? `${hit.next.relation} ${hit.next.id}` : "none"}`);
				return hit.next;
			}
			if (scope !== "page") await spaced("anilist-relations", RELATIONS_SPACING);
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
			const anime = (relation: string) => edges.find((e) => e.relationType?.valueOf() === relation && e.node?.type?.valueOf() !== "MANGA");
			const edge = anime("PARENT") ?? anime("PREQUEL") ?? anime("ALTERNATIVE");
			const next = edge?.node?.id
				? {
						id: edge.node.id,
						title: edge.node.title?.userPreferred ?? `${edge.node.id}`,
						relation: edge.relationType!.valueOf().toLowerCase(),
						episodes: Number(edge.node.episodes) || 0,
					}
				: null;
			log.debug(`${mediaId}: related step (asked AniList): ${next ? `${next.relation} ${next.id}` : "none"}`);
			const steps = relationSteps();
			const now = Date.now();
			steps[mediaId] = { next, at: now };
			// Drop expired steps while writing
			for (const key of Object.keys(steps)) if (now - steps[Number(key)].at >= RELATIONS_KEEP) delete steps[Number(key)];
			$storage.set(RELATIONS_KEY, steps);
			return next;
		}

		/**
		 * The anime's parent and prequels on AniList (specials and later seasons often share their TMDB entry): up to five
		 * steps up (a fifth season's only link may be the first), the parent first, then the prequel chain. An alternative
		 * version only as the first step: further up, it's another anime's (a first season's remake isn't its sequel's).
		 */
		async function relatedAnime(mediaId: number, scope: Scope): Promise<NonNullable<CEM.RelationStep["next"]>[]> {
			if (isCustomSource(mediaId)) return [];
			const out: NonNullable<CEM.RelationStep["next"]>[] = [];
			let current = mediaId;
			log.time(`relations ${mediaId}`);
			for (let step = 0; step < 5; step++) {
				report(mediaId, step ? `Following the related anime on AniList (${step + 1})` : "Looking up related anime on AniList");
				const next = await relationStep(current, scope);
				if (!next || next.id === mediaId || out.some((r) => r.id === next.id) || (step && next.relation === "alternative")) break;
				out.push(next);
				current = next.id;
			}
			log.timeEnd(`relations ${mediaId}`);
			log.step(`${mediaId}: related anime: ${out.length ? out.map((r) => `${r.relation} ${r.id}`).join(" -> ") : "none"}`);
			return out;
		}

		/** TMDB IDs known for an AniList anime, most trusted first: Animap, ani.zip (AnimeAPI's comes apart, see animeapiIds). */
		async function knownIds(mediaId: number, metadata?: $app.Metadata_AnimeMetadata) {
			const ids: { id: number; from: string; type?: "tv" | "movie" }[] = [];
			const add = (id: number | undefined, from: string, type?: "tv" | "movie") => {
				if (id && !ids.some((x) => x.id === id)) ids.push({ id, from, ...(type ? { type } : {}) });
			};
			if (metadata === undefined && !isCustomSource(mediaId)) {
				try {
					metadata = await loadMetadata(mediaId);
				} catch {}
			}
			add(Number((metadata?.mappings?.themoviedbId ?? "").replace(/\D/g, "")) || undefined, "Animap");
			if (!isCustomSource(mediaId)) add((await anizip(mediaId)).tmdbId, "ani.zip");
			return ids;
		}
		/**
		 * AnimeAPI's TMDB ID for an AniList anime. Its public instance allows few requests, so it's asked only once every ID
		 * found before it has been tried without a match (a wrong Animap ID mustn't keep it from being asked).
		 */
		async function animeapiIds(mediaId: number): Promise<{ id: number; from: string; type?: "tv" | "movie" }[]> {
			if (isCustomSource(mediaId)) return [];
			const api = await animeapi(mediaId);
			if (!api.tmdbId) return [];
			const type = api.tmdbType === "tv" || api.tmdbType === "movie" ? api.tmdbType : undefined;
			return [{ id: api.tmdbId, from: "AnimeAPI", ...(type ? { type } : {}) }];
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
				for (const [key, t] of Object.entries(r.map)) {
					if (/^\d+$/.test(key) && t.tmdbId === tmdbId && t.season !== undefined) claimed[`${t.season}:${t.episode}`] = true;
				}
			}
			return claimed;
		}

		/**
		 * A title without the kind of release at the end ("... OVA", "...してOVA": TMDB keeps those as specials of the
		 * show's entry) or a season number ("Edgerunners 2", "エッジランナーズ2", "Season 3", "第2期"), then without its
		 * subtitle ("Dacryon - Luna: ...", "ダクリュオン・ルナ ~堕聖母誕生~"), when that leaves something to search for.
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
			const bare = unnumbered(title.replace(/(^|[^a-z])[\s(（\-:：]*(?:OVA|ONA|OAD|(?:the\s+)?movie|specials?|劇場版)[\s)）]*$/i, "$1"));
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
		): Promise<{
			found?: { id: number; from: string; mapping: Mapping; borrowed?: boolean };
			firstValid?: { id: number; from: string; reason?: string; type?: "tv" | "movie" };
		}> {
			/** "123" (either type), "tv123", "movie123" */
			const tried: string[] = [];
			let firstValid: { id: number; from: string; reason?: string; type?: "tv" | "movie" } | undefined;
			const { startDay } = startOf(media, metadata);
			/** One candidate checked against this anime's air dates: its match when it lines up */
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
				// Without its type an ID is tried as both; with one, it's the same entry the ID names without it (a related
				// anime's match, then its Animap ID: the same show)
				const seen = type ? tried.indexOf(`${id}`) !== -1 : tried.indexOf(`tv${id}`) !== -1 || tried.indexOf(`movie${id}`) !== -1;
				if (tried.indexOf(key) !== -1 || seen) return undefined;
				tried.push(key);
				report(mediaId, `Checking TMDB ${id} from ${from}`);
				let mapping: Mapping;
				try {
					const candidate = { mediaId, tmdbId: id, ...(type ? { tmdbType: type } : {}), episodeOverrides: [] };
					const claimed = borrowed ? claimedEpisodes(mediaId, id) : undefined;
					mapping = await buildMapping(mediaId, media, metadata, session, candidate, claimed, nameMatch);
					// A candidate is passed as an override, but it isn't the user's
					if (mapping.source === "override") mapping = { ...mapping, source: "auto" };
				} catch {
					return undefined; // not a TMDB entry of either type
				}
				const movie = borrowed && mapping.status === "matched" ? mapping.movie : undefined;
				const problem = movie ? await borrowedMovieProblem(mediaId, media, metadata, id, movie) : undefined;
				if (problem) mapping = { status: "failed", reason: `TMDB movie ${id} doesn't fit: ${problem}`, tmdbType: "movie", map: {} };
				log.debug(`${mediaId}: TMDB ${id} from ${from}: ${mapping.status}${mapping.reason ? ` (${mapping.reason})` : ""}`);
				trace.add("tmdb", mediaId, `TMDB ${id} from ${from}: ${outcome(mapping)}`);
				const foundType = mapping.tmdbType ?? type;
				if (!firstValid) firstValid = { id, from, reason: mapping.reason, ...(foundType ? { type: foundType } : {}) };
				if (mapping.status === "matched") return { id, from, mapping, ...(borrowed ? { borrowed } : {}) };
				if (!problem || isNaN(startDay)) return undefined;
				const other = await collectionMovie(mediaId, session, id, startDay);
				return other ? attempt(other.id, `${from}, its TMDB collection "${other.collection}"`, true, "movie") : undefined;
			};

			if (only) return { found: await attempt(only.id, only.from, false, only.type), firstValid };
			for (const id of skip) tried.push(`${id}`);

			// This anime's own mappings, then its parent's and prequels' (checked against this anime's air dates). An ID
			// already tried (skip) isn't tried again.
			let found: Awaited<ReturnType<typeof attempt>>;
			for (const list of [() => knownIds(mediaId, metadata), () => animeapiIds(mediaId)]) {
				for (const candidate of await list()) {
					found = await attempt(candidate.id, candidate.from, false, candidate.type);
					if (found) return { found, firstValid };
				}
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
				const theirIds = async () => (settled as { id: number; from: string; type?: "tv" | "movie" }[]).concat(await knownIds(r.id));
				for (const list of [theirIds, () => animeapiIds(r.id)]) {
					for (const candidate of await list()) {
						found = await attempt(candidate.id, `${r.relation} "${r.title}" (${candidate.from})`, true, candidate.type);
						if (found) return { found, firstValid };
					}
				}
			}
			if (!titleSearch) return { found, firstValid };

			// One episode (a movie, or a special TMDB may keep as a movie): search shows and movies at once. Otherwise only
			// shows, a movie being one episode.
			const preferred = media?.format?.valueOf() === "MOVIE" ? "movie" : "tv";
			const searchType = preferred === "movie" || (Number(media?.episodes) || 0) <= 1 ? "multi" : "tv";
			const { own, titles } = searchTitles(media, related);
			// Enough for any anime TMDB has; one it doesn't have costs no more each time it's retried. Known up front, so the
			// progress line can count them.
			const SEARCHES = 10;
			const planned = Math.min(SEARCHES, titles.map((t) => t.title).filter((t, i, all) => all.indexOf(t) === i).length);
			const searched: string[] = [];
			for (const { title, from } of titles) {
				if (found) break;
				if (searched.indexOf(title) !== -1) continue;
				if (searched.length >= SEARCHES) break;
				searched.push(title);
				report(mediaId, `Searching TMDB for "${title}" (title ${searched.length} of ${planned})`);
				let results: CEM.TMDBSearchResults["results"] = [];
				try {
					const all = (await tmdb.search(title, searchType)).results;
					results = all.filter((r) => searchType !== "multi" || r.media_type === "tv" || r.media_type === "movie");
				} catch {}
				if (!results.length) trace.add("tmdb", mediaId, `A TMDB search for "${title}" found nothing`);
				const typeOf = (r: (typeof results)[number]): "tv" | "movie" => (searchType === "multi" ? (r.media_type as "tv" | "movie") : "tv");
				// TMDB often has duplicate entries. Of the top 3 that match, take one with stills, and of those the oldest
				// entry: TMDB IDs are assigned in order (its API doesn't say when an entry was created), so try the lowest
				// ID first and stop at the first match with stills. The type the format suggests first: the two types'
				// IDs are counted apart.
				let bare: Awaited<ReturnType<typeof attempt>>;
				const top = results.slice(0, 3).sort((a, b) => Number(typeOf(b) === preferred) - Number(typeOf(a) === preferred) || a.id - b.id);
				for (const result of top) {
					// Named exactly as one of this anime's own titles (TMDB's English or original name)
					const isOwn = (n?: string) => !!plainTitle(n) && own.some((t) => plainTitle(t) === plainTitle(n));
					const named = [result.name, result.original_name, result.title].some(isOwn);
					const hit = await attempt(result.id, from, true, typeOf(result), named);
					if (!hit) continue;
					if (await hasStills(hit.mapping, session)) {
						found = hit;
						break;
					}
					log.debug(`${mediaId}: TMDB ${result.id} matches but has no stills; trying the other results`);
					trace.add("tmdb", mediaId, `TMDB ${result.id} has no stills; trying the search's other results`);
					bare = bare ?? hit;
				}
				found = found ?? bare;
			}
			return { found, firstValid };
		}

		/** This anime's start day (AniList's full start date, else episode 1's air date) and year, for checking a movie */
		function startOf(media: $app.AL_BaseAnime | undefined, metadata: $app.Metadata_AnimeMetadata | undefined) {
			const start = media?.startDate;
			const startDay =
				start?.year && start.month && start.day
					? Math.round(Date.UTC(Number(start.year), Number(start.month) - 1, Number(start.day)) / DAY)
					: toDay(metadata?.episodes?.["1"]?.airDate);
			const startYear = Number(start?.year) || (isNaN(startDay) ? 0 : new Date(startDay * DAY).getUTCFullYear());
			return { startDay, startYear };
		}

		/**
		 * Why a movie ID borrowed from a related anime or a title search doesn't fit: another anime has it as its own ID (a
		 * movie is one AniList entry), or it came out on another date than this anime. undefined: it fits.
		 */
		async function borrowedMovieProblem(
			mediaId: number,
			media: $app.AL_BaseAnime | undefined,
			metadata: $app.Metadata_AnimeMetadata | undefined,
			id: number,
			movie: CEM.TMDBMovieDetails,
		) {
			const { startDay, startYear } = startOf(media, metadata);
			const episodeTotal = Number(media?.episodes) || 0;
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
			const yearOf = (day: number) => new Date(day * DAY).getUTCFullYear();
			const fits = (day: number) => (yearOnly ? !startYear || yearOf(day) === startYear : Math.abs(day - startDay) <= 7);
			if (fits(released)) return undefined;
			// TMDB's release date is the first anywhere, often a festival premiere weeks before the anime came out: its
			// Japanese releases count instead, else (none listed) any country's
			const releases = await movieReleases(id);
			const where = releases.jp.length ? "in Japan" : "anywhere";
			const counted = releases.jp.length ? releases.jp : releases.all;
			const hit = counted.find((date) => fits(toDay(date)));
			if (hit) {
				log.step(`${mediaId}: TMDB movie ${id} came out ${movie.release_date}, ${where} also ${hit}: that fits`);
				return undefined;
			}
			const also = counted.length ? ` (${where}: ${counted.slice(0, 3).join(", ")})` : "";
			if (yearOnly) return `it came out in ${yearOf(released)}${also}, this anime in ${startYear}`;
			return `it came out ${movie.release_date}${also}, this anime ${new Date(startDay * DAY).toISOString().slice(0, 10)}`;
		}

		/**
		 * A movie's release dates on TMDB ("yyyy-mm-dd", in order): Japan's, and every country's. Premieres, cinemas,
		 * streaming and TV; not disc releases, months later. Empty when TMDB couldn't be asked.
		 */
		async function movieReleases(id: number) {
			type Answer = { results?: { iso_3166_1: string; release_dates?: { release_date?: string; type?: number }[] }[] };
			let results: NonNullable<Answer["results"]> = [];
			try {
				results = (await tmdb.__fetch__<Answer>(`movie/${id}/release_dates`)).results ?? [];
			} catch (e) {
				log.debug(`TMDB movie ${id}: release dates unavailable`, e);
			}
			const dates = (country?: string) => {
				const out: string[] = [];
				for (const r of results) {
					if (country && r.iso_3166_1 !== country) continue;
					for (const d of r.release_dates ?? []) {
						const date = (d.release_date ?? "").slice(0, 10);
						if (d.type !== 5 && !isNaN(toDay(date)) && out.indexOf(date) === -1) out.push(date);
					}
				}
				return out.sort();
			};
			return { jp: dates("JP"), all: dates() };
		}

		/** A movie that came out more than a year away from this anime: another title. undefined: it may be this one. */
		function otherYear(media: $app.AL_BaseAnime | undefined, metadata: $app.Metadata_AnimeMetadata | undefined, movie: CEM.TMDBMovieDetails) {
			const { startYear } = startOf(media, metadata);
			const released = toDay(movie.release_date);
			if (!startYear || isNaN(released)) return undefined;
			const year = new Date(released * DAY).getUTCFullYear();
			return Math.abs(year - startYear) > 1 ? `it came out in ${year}, this anime in ${startYear}` : undefined;
		}

		/**
		 * A related anime's movie that isn't this one: TMDB has no relations for movies, but its collection (e.g. "Part 1"
		 * and "Part 2") may hold the one released when this anime was (within a week of startDay). Only when exactly one did.
		 */
		async function collectionMovie(mediaId: number, session: ReturnType<typeof tmdbSession>, id: number, startDay: number) {
			const collection = (await session.details(id, "movie").catch(() => undefined))?.belongs_to_collection;
			if (!collection) return undefined;
			let parts: { id: number; release_date?: string }[] = [];
			try {
				parts = (await tmdb.__fetch__<{ parts?: { id: number; release_date?: string }[] }>(`collection/${collection.id}`)).parts ?? [];
			} catch {}
			const near = parts.filter((p) => p.id !== id && Math.abs(toDay(p.release_date) - startDay) <= 7);
			const ids = near.map((p) => p.id).join(", ");
			const then = near.length ? `TMDB ${ids} came out then` : "nothing came out then";
			log.debug(`${mediaId}: TMDB collection ${collection.id} "${collection.name}": ${then}`);
			const verdict = near.length ? `TMDB ${ids} came out when this anime did` : "nothing in it came out when this anime did";
			trace.add("tmdb", mediaId, `Its TMDB collection "${collection.name}": ${verdict}`);
			return near.length === 1 ? { id: near[0].id, collection: collection.name } : undefined;
		}

		/**
		 * The titles a TMDB search tries, in order: every title of this anime (English and romaji differ between sites; the
		 * native one is the most consistent), then each without its subtitle ("Dacryon - Luna: ...", "ダクリュオン・ルナ
		 * ~堕聖母誕生~") or season number, which TMDB often leaves out or keeps as a season of the first entry's show, then
		 * the related anime's (sequels and OVAs are often episodes of the first entry's show). own: this anime's titles.
		 */
		function searchTitles(media: $app.AL_BaseAnime | undefined, related: NonNullable<CEM.RelationStep["next"]>[]) {
			const titles: { title: string; from: string }[] = [];
			const title = media?.title;
			const own = [title?.english, title?.romaji, title?.native, title?.userPreferred, ...((media?.synonyms ?? []) as string[])]
				.map((t) => `${t ?? ""}`.trim())
				.filter((t) => t.length > 1);
			for (const t of own) titles.push({ title: t, from: `a TMDB search for "${t}"` });
			for (const t of own) {
				for (const short of shortTitles(t)) titles.push({ title: short, from: `a TMDB search for "${short}" (from "${t}")` });
			}
			for (const r of related) titles.push({ title: r.title, from: `a TMDB search for ${r.relation} "${r.title}"` });
			return { own, titles };
		}

		// ----------------------------------------------------------------------------------------------------------------
		// 7. AniDB: entries through proxy.ani.zip, checking a candidate, the lookup and the match in use
		// ----------------------------------------------------------------------------------------------------------------
		// AniDB IDs for anime Seanime has none for: no metadata at all (mostly 18+ entries Animap doesn't know), or Animap
		// data without an AniDB ID. Without one, Seanime shows "Episode metadata retrieval not available" and AnimeTosho
		// can't search by AniDB. A found ID is only used when this anime's own air dates (or episode titles) line up with
		// that AniDB entry. A related anime's entry counts only past that anime's own main episodes, else by its specials.
		// Your override is used as given and replaces an ID Seanime has itself; "none" leaves Seanime's own out too. The
		// entry in use also fills in episode titles, air dates and summaries.

		const anidbStore = $shared.use<CEM.AnidbStore>("anidb");
		const ANIDB_EPISODES_KEY = "ANIDB_EPISODES_V1";
		/**
		 * The TMDB and AniDB matches check each other, but never in a circle: a match that only lined up with the other
		 * source's air dates (or titles) can't then vouch for that source. Otherwise two wrong IDs could keep each other
		 * up long after the anime's own dates stopped agreeing with either.
		 */
		function anidbEvidence(match: CEM.AnidbMatch | undefined) {
			return !!match && (match.status === "override" || (match.status === "verified" && !match.byTmdb && anidbLookup()));
		}
		/**
		 * The TMDB match, when it may count as evidence for the AniDB one (see anidbEvidence), and only while it's in use:
		 * an automatic one with the stills or fill-in on, one from an override while that's still saved
		 */
		function tmdbEvidence(mediaId: number) {
			const record = thumbnails.get(mediaId);
			if (record?.status !== "matched" || !tmdb.API_KEY) return undefined;
			const inUse = record.source === "override" ? !!tmdb.overrides.get(mediaId).tmdbId : tmdbOn() && !record.byAnidb;
			return inUse ? record : undefined;
		}

		/**
		 * animap.id's AniDB ID for an AniList anime: it maps AniList IDs to other sites, and the AniDB ID is read from the
		 * anidb.net/anime/<id> URL in its "sources".
		 */
		async function animapIdAnidb(mediaId: number): Promise<number | undefined> {
			await spaced("animap.id", ANIMAP_ID_SPACING);
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
			if (hit && !force && Date.now() - hit.at < ANIDB_ENTRY_KEEP) return hit.anime ?? null;
			await spaced("proxy.ani.zip", ANIDB_SPACING);
			let xml = "";
			try {
				const url = `https://proxy.ani.zip/httpapi?client=animeplugin&clientver=1&protover=1&request=anime&aid=${aid}`;
				const res = await ctx.fetch(url, { timeout: 10 });
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
				const lettered: NonNullable<CEM.AnidbAnime["lettered"]> = {};
				const episodeRe = /<episode\s+id="(\d+)"[^>]*>([\s\S]*?)<\/episode>/g;
				let m: RegExpExecArray | null;
				while ((m = episodeRe.exec(xml))) {
					const epno = m[2].match(/<epno\s+type="(\d+)">\s*([^<]*?)\s*<\/epno>/);
					// Type 1: main episodes ("12"); the others by their letter: specials ("S1"), credits ("C1"), trailers
					// ("T1"), parodies ("P1") and other episodes ("O1")
					if (!epno) continue;
					const isMain = epno[1] === "1" && /^\d+$/.test(epno[2]);
					const letter = (epno[2].match(/^([A-Z])\d+$/) ?? [])[1];
					if (!isMain && !letter) continue;
					const airDate = (m[2].match(/<airdate>([^<]+)<\/airdate>/) ?? [])[1];
					const length = Number((m[2].match(/<length>(\d+)<\/length>/) ?? [])[1]) || 0;
					const title = anidbTitle(m[2]);
					const summary = anidbSummary(m[2]);
					(isMain ? main : letter === "S" ? specials : (lettered[letter!] ??= [])).push({
						n: Number(epno[2].replace(/^[A-Z]/, "")),
						eid: Number(m[1]),
						...(airDate ? { airDate } : {}),
						...(length ? { length } : {}),
						...(title ? { title } : {}),
						...(summary ? { summary } : {}),
					});
				}
				main.sort((a, b) => a.n - b.n);
				specials.sort((a, b) => a.n - b.n);
				for (const list of Object.values(lettered)) list.sort((a, b) => a.n - b.n);
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
				anime = { aid, episodeCount, main, specials, lettered, malIds };
			} else if (!/not found/i.test(xml)) {
				log.warn(`AniDB ${aid}: unexpected answer from proxy.ani.zip`, xml.slice(0, 200));
				return undefined; // an error like a ban or maintenance: don't remember it
			}
			log.debug(`AniDB ${aid}: ${anime ? `${anime.main.length} main episodes, ${anime.specials?.length ?? 0} specials` : "not found"}`);
			cache[aid] = { at: Date.now(), ...(anime ? { anime } : {}) };
			$storage.set(ANIDB_EPISODES_KEY, cache);
			return anime ?? null;
		}

		/**
		 * Air dates known for this anime's episodes: Seanime's metadata, TMDB's, custom metadata, AniList. TMDB's ("fill":
		 * where the others have none, "first": ahead of them, "none": not at all) only when its match may count as evidence.
		 */
		function airDatePoints(
			mediaId: number,
			media: $app.AL_BaseAnime | undefined,
			metadata?: $app.Metadata_AnimeMetadata,
			withTmdb: "none" | "fill" | "first" = "fill",
		) {
			const points: Record<number, number> = {};
			const from: Record<number, string> = {};
			const add = (n: number, day: number, source: string) => {
				if (n < 1 || isNaN(day) || points[n] !== undefined) return;
				points[n] = day;
				from[n] = source;
			};
			// The first date for an episode counts: TMDB's ahead of the others when asked (the check with them applied)
			const record = withTmdb === "none" ? undefined : tmdbEvidence(mediaId);
			const tmdb = () => {
				for (const [k, d] of Object.entries(record?.episodes ?? {})) if (/^\d+$/.test(k)) add(Number(k), toDay(d.airDate), "TMDB's");
			};
			if (withTmdb === "first") tmdb();
			// Not the episode list the plugin supplies (no Animap entry): its dates are AniDB's own, no evidence for AniDB
			if (!animap.get(mediaId)?.fallback)
				for (const [k, d] of Object.entries(metadata?.episodes ?? {})) {
					if (/^\d+$/.test(k)) add(Number(k), toDay(d.airDate), "Seanime's metadata");
				}
			tmdb();
			for (const [k, d] of Object.entries(database.get(mediaId).data)) {
				if (/^\d+$/.test(k)) add(Number(k), toDay(d.airDate), "your custom metadata");
			}
			const next = media?.nextAiringEpisode;
			if (next?.episode && next.airingAt) add(next.episode, Math.floor((next.airingAt * 1000) / DAY), "AniList's next episode");
			const start = media?.startDate;
			if (start?.year && start.month && start.day) {
				add(1, Math.round(Date.UTC(start.year, start.month - 1, start.day) / DAY), "AniList's start date");
			}
			return Object.keys(points).map((n) => ({ n: Number(n), day: points[Number(n)], from: from[Number(n)] }));
		}

		/** Air dates for a step: each source with its episodes, e.g. "episodes 1-11 (TMDB's); episode 1 on 2026-09-25 (AniList's start date)" */
		function describePoints(points: { n: number; day: number; from?: string }[]) {
			const bySource: Record<string, number[]> = {};
			for (const p of points.slice().sort((a, b) => a.n - b.n)) (bySource[p.from ?? "unknown"] ??= []).push(p.n);
			const date = (n: number) => new Date((points.find((p) => p.n === n)?.day ?? 0) * DAY).toISOString().slice(0, 10);
			const episodes = (ns: number[]) => (ns.length === 1 ? `episode ${ns[0]} on ${date(ns[0])}` : `episodes ${formatSeasons(ns)}`);
			return Object.keys(bySource)
				.map((from) => `${episodes(bySource[from])} (${from})`)
				.join("; ");
		}

		/**
		 * Whether an AniDB entry's main episodes are this anime's by episode title: each titled episode votes for the
		 * offset that puts it on the AniDB episode with its title (AniDB's English one). At least two, and at least half
		 * of the titled episodes, must agree on one offset with nothing tied.
		 */
		function verifyAnidbTitles(titles: { n: number; title: string }[], anime: CEM.AnidbAnime) {
			const fail = (reason: string) => ({ ok: false, offset: 0, reason });
			const byTitle: Record<string, number[]> = {};
			for (const e of anime.main) if (plainTitle(e.title)) (byTitle[plainTitle(e.title)] ??= []).push(e.n);
			const votes: Record<number, number> = {};
			for (const t of titles) {
				const seen: Record<number, boolean> = {};
				for (const n of byTitle[t.title] ?? []) seen[n - t.n] = true;
				for (const offset of Object.keys(seen)) votes[Number(offset)] = (votes[Number(offset)] ?? 0) + 1;
			}
			const ranked = Object.keys(votes).map(Number).sort((a, b) => votes[b] - votes[a]);
			const top = ranked[0];
			if (top === undefined || votes[top] < 2 || votes[top] * 2 < titles.length || votes[ranked[1]] === votes[top] || top < 0)
				return fail(`${top === undefined ? 0 : votes[top]} of ${titles.length} episode titles match AniDB ${anime.aid}'s`);
			const reason = `${votes[top]} of ${titles.length} episode titles match AniDB ${anime.aid}'s${top ? ` at offset +${top}` : ""}`;
			return { ok: true, offset: top, reason };
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
			if (!ranked.length) {
				const which = points.length === 1 ? "the one air date doesn't" : `none of ${points.length} air dates`;
				return fail(`${which} line up with AniDB ${anime.aid}'s main episodes`);
			}
			const offset = ranked[0];
			const agree = votes[offset];
			if (offset < 0) return fail(`AniDB ${anime.aid}'s episodes start after this anime's (offset ${offset})`);
			const early =
				offset === 0
					? earlyScreenings((n) => {
							const anidb = toDay(anime.main.find((e) => e.n === n)?.airDate);
							const own = points.find((p) => p.n === n)?.day;
							return !isNaN(anidb) && own !== undefined ? [anidb, own] : undefined;
						}, Math.max(0, ...points.map((p) => p.n)))
					: 0;
			// AniDB lists a new season a few episodes ahead and adds the rest as they near: an upcoming episode it has no
			// date for yet can't disagree. Aired ones it lacks still count against it.
			const today = Math.floor(Date.now() / DAY);
			const unlisted = points.filter((p) => p.day > today && isNaN(toDay(anime.main.find((e) => e.n === p.n + offset)?.airDate))).length;
			const compared = points.length - unlisted;
			const counted = compared - points.filter((p) => p.n <= early).length;
			const linedUp = `${agree} of ${compared} air date${compared === 1 ? "" : "s"} line${agree === 1 ? "s" : ""} up`;
			// Several early episodes leave fewer to go by: two at least must line up
			if (agree < Math.max(early > 1 ? 2 : 1, Math.ceil(counted * 0.8))) return fail(`only ${linedUp} with AniDB ${anime.aid}`);
			const total = Math.max(anime.episodeCount, anime.main[anime.main.length - 1].n);
			if (episodes && total < offset + episodes) {
				return fail(`AniDB ${anime.aid} has ${total} main episodes, this anime needs ${offset + episodes}`);
			}
			// Same kind of episode: a short (3 min) never matches a full episode (24 min) that aired the same day
			const lengths = anime.main
				.filter((e) => e.length && e.n - offset >= 1 && (!episodes || e.n - offset <= episodes))
				.map((e) => e.length as number)
				.sort((a, b) => a - b);
			const typical = lengths[Math.floor(lengths.length / 2)];
			if (duration && typical && (typical > duration * 2 || typical < duration / 2))
				return fail(`AniDB ${anime.aid}'s episodes run ${typical} min, this anime's ${duration} min`);
			const at = offset ? ` at offset +${offset}` : "";
			const upcoming = unlisted ? ` (${unlisted} upcoming episode${unlisted === 1 ? "" : "s"} AniDB doesn't list yet)` : "";
			let screened = "";
			if (early === 1) screened = " (AniDB dates episode 1 by an early screening)";
			else if (early) screened = ` (AniDB dates episodes 1-${early} by early screenings)`;
			return { ok: true, offset, reason: `${linedUp}${at}${upcoming}${screened}` };
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
			const reason = `it links this anime's MyAnimeList entry ${mal}, and only its ${which} aired in ${period}, when this anime did`;
			return { ok: true, offset, reason };
		}

		/** An AniDB entry's specials (S1 as 1), or another lettered type (O1 as 1), in place of its main episodes, for the checks below. */
		const asMain = (anime: CEM.AnidbAnime, episodes: CEM.AnidbEpisode[]): CEM.AnidbAnime => ({
			aid: anime.aid, episodeCount: episodes.length, main: episodes, specials: [], malIds: [],
		});
		const asSpecials = (anime: CEM.AnidbAnime) => asMain(anime, anime.specials);
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
					/** Only lined up with the TMDB match's dates or titles (see anidbEvidence) */
					byTmdb?: boolean;
					/** Found through a related anime, with this many main episodes of its own */
					related?: number;
					transient?: undefined;
			  }
			| { aid?: undefined; reason: string; transient: boolean };
		async function findAnidb(
			mediaId: number,
			media: $app.AL_BaseAnime | undefined,
			metadata?: $app.Metadata_AnimeMetadata,
			scope: Scope = "page",
			/** Check only this candidate (a stored match again, with the dates known now) */
			only?: { aid: number; from: string; related?: number },
		): Promise<AnidbFound> {
			const { points, verify } = anidbVerifier(mediaId, media, metadata);
			const reasons: string[] = [];
			let transient = false;
			const sources: AnidbSource[] = only ? [[only.from, async () => only.aid, only.related]] : ownAnidbSources(mediaId);
			// Parent and prequels last, looked up only if this anime's own IDs gave nothing usable
			const own = only ? Infinity : sources.length;
			const tried: number[] = [];
			for (let i = 0; ; i++) {
				if (i === own) {
					sources.push(...(await relatedAnidbSources(mediaId, scope)));
					const next = sources.length > own ? "; trying its related anime" : ", and it has no related anime";
					trace.add("anidb", mediaId, `Nothing usable from this anime's own IDs${next}`);
				}
				if (i >= sources.length) break;
				const [from, get, relatedEpisodes] = sources[i];
				report(mediaId, `Asking ${from} for an AniDB ID`);
				const aid = await get();
				if (!aid) trace.add("anidb", mediaId, `${from}: no AniDB ID`);
				if (!aid || tried.indexOf(aid) !== -1) continue;
				tried.push(aid);
				report(mediaId, `Checking AniDB ${aid} from ${from}`);
				const anime = await anidbAnime(aid);
				if (anime === undefined) {
					transient = true;
					reasons.push(`AniDB ${aid} (${from}) couldn't be fetched`);
					trace.add("anidb", mediaId, `${from}: AniDB ${aid} couldn't be fetched`);
					continue;
				}
				if (anime === null) {
					reasons.push(`AniDB ${aid} (${from}) doesn't exist`);
					trace.add("anidb", mediaId, `${from}: AniDB ${aid} doesn't exist`);
					continue;
				}
				const verdict = judgeAnidb(mediaId, media, points, verify, anime, from, relatedEpisodes);
				if ("aid" in verdict) return verdict;
				reasons.push(`AniDB ${aid} (${from}): ${verdict.reason}`);
			}
			return {
				reason: reasons.length ? reasons.join("; ") : "no AniDB ID from ani.zip, AnimeAPI, animap.id or related anime",
				transient,
			};
		}

		/** A source of an AniDB ID: its name, how it's asked, and for a related anime how many episodes that anime has itself */
		type AnidbSource = [string, () => Promise<number | undefined>, number?];
		/** This anime's own AniDB IDs, in the order they're asked */
		const ownAnidbSources = (mediaId: number): AnidbSource[] => [
			["ani.zip", async () => (await anizip(mediaId)).anidbId],
			["AnimeAPI", async () => (await animeapi(mediaId)).anidbId],
			// animap.id is its own site (AniList -> AniDB links), not the Animap behind Seanime's metadata
			["animap.id", () => animapIdAnidb(mediaId)],
		];
		/** The parent's and prequels' AniDB IDs, each with how many episodes that anime has itself (AniList's count, 0 when unknown) */
		async function relatedAnidbSources(mediaId: number, scope: Scope) {
			const sources: AnidbSource[] = [];
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
					[`${label} (animap.id)`, () => animapIdAnidb(related.id), ownMain],
				);
			}
			return sources;
		}

		type AnidbVerify = (anime: CEM.AnidbAnime) => ReturnType<typeof verifyAnidb> & { byTmdb?: boolean };
		/**
		 * What an AniDB entry is checked against: this anime's air dates (points; adds them to the lookup's steps) and
		 * episode titles. verify: an entry (or its specials) checked against the anime's own air dates, else with TMDB's
		 * ahead of them, else by episode title; byTmdb when it only lined up with TMDB's help.
		 */
		function anidbVerifier(mediaId: number, media: $app.AL_BaseAnime | undefined, metadata: $app.Metadata_AnimeMetadata | undefined) {
			const points = airDatePoints(mediaId, media, metadata);
			// The same with TMDB's dates (the anime's TMDB match) ahead of the anime's own, where they differ: tried too
			const withTmdb = airDatePoints(mediaId, media, metadata, "first");
			const ownPoints = airDatePoints(mediaId, media, metadata, "none");
			const days = (p: typeof points) => stableJson(p.map((d) => [d.n, d.day]));
			const tmdbDiffers = days(withTmdb) !== days(points);
			log.debug(`${mediaId}: AniDB lookup with ${points.length} known air date(s)`);
			log.inspect(`${mediaId}: air dates checked against AniDB`, points);
			trace.add("anidb", mediaId, points.length ? `Air dates to compare: ${describePoints(points)}` : "No air dates to compare");
			// Dates that can't count: AniDB's own, and TMDB's when its match only lined up with them (see anidbEvidence)
			if (animap.get(mediaId)?.fallback && Object.values(metadata?.episodes ?? {}).some((e) => !!e?.airDate))
				trace.add("anidb", mediaId, "Not compared: the episode list's dates, which are AniDB's (the plugin supplies the list)");
			const unused = thumbnails.get(mediaId);
			if (unused?.status === "matched" && !tmdbEvidence(mediaId)) {
				const why = unused.byAnidb && tmdbOn() ? "its match only lined up with AniDB's" : "its match isn't in use";
				trace.add("anidb", mediaId, `Not compared: TMDB's dates, ${why}`);
			}
			const episodes = Number(media?.episodes) || undefined;
			const duration = Number(media?.duration) || undefined;
			// Episode titles: Seanime's own (not the list the plugin supplies), and the TMDB match's where those have none
			const titlesFrom = (withTmdb: boolean) => {
				const out: Record<number, string> = {};
				if (!animap.get(mediaId)?.fallback)
					for (const [k, ep] of Object.entries(metadata?.episodes ?? {})) {
						if (/^\d+$/.test(k) && plainTitle(ep.title)) out[Number(k)] = plainTitle(ep.title);
					}
				if (withTmdb)
					for (const [k, ep] of Object.entries(tmdbEvidence(mediaId)?.episodes ?? {})) {
						if (/^\d+$/.test(k) && !out[Number(k)] && plainTitle(ep.title)) out[Number(k)] = plainTitle(ep.title);
					}
				return Object.keys(out).map((n) => ({ n: Number(n), title: out[Number(n)] }));
			};
			const ownTitles = titlesFrom(false);
			const allTitles = titlesFrom(true);
			const verify: AnidbVerify = (anime) => {
				const check = verifyAnidb(points, anime, episodes, duration);
				if (check.ok) {
					// Only with TMDB's dates among them: it can't vouch for that match in turn
					const own = points.length === ownPoints.length || verifyAnidb(ownPoints, anime, episodes, duration).ok;
					return own ? check : { ...check, byTmdb: true };
				}
				if (tmdbDiffers) {
					const other = verifyAnidb(withTmdb, anime, episodes, duration);
					if (other.ok) {
						return { ...other, reason: `${other.reason} with TMDB's air dates (the anime's own: ${check.reason})`, byTmdb: true };
					}
				}
				const byTitle = verifyAnidbTitles(ownTitles, anime);
				if (byTitle.ok) return { ...byTitle, reason: `${byTitle.reason} (air dates: ${check.reason})` };
				const withTmdbTitles = allTitles.length > ownTitles.length ? verifyAnidbTitles(allTitles, anime) : byTitle;
				if (withTmdbTitles.ok) {
					return { ...withTmdbTitles, reason: `${withTmdbTitles.reason}, with TMDB's (air dates: ${check.reason})`, byTmdb: true };
				}
				return check;
			};
			return { points, verify };
		}

		/**
		 * One AniDB candidate's verdict: its match when it's this anime (see verify), also when it links this anime's
		 * MyAnimeList entry or, for an anime dated by year only, by that year; a related anime's entry only past that
		 * anime's own main episodes, else by its specials. Otherwise why not (reason).
		 */
		function judgeAnidb(
			mediaId: number,
			media: $app.AL_BaseAnime | undefined,
			points: { n: number; day: number }[],
			verify: AnidbVerify,
			anime: CEM.AnidbAnime,
			from: string,
			/** Set for a related anime's ID: how many main episodes that anime has itself */
			relatedEpisodes: number | undefined,
		): Extract<AnidbFound, { aid: number }> | { reason: string } {
			const aid = anime.aid;
			const related = relatedEpisodes !== undefined;
			const episodes = Number(media?.episodes) || undefined;
			const mal = Number(media?.idMal) || 0;
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
			trace.add("anidb", mediaId, `${from}: AniDB ${aid} ${check.ok ? "fits" : "doesn't fit"}: ${check.reason}`);
			// AniList's count only: one taken from the air dates would cut off an airing anime's later episodes
			const extra = { ...(check.byTmdb ? { byTmdb: true } : {}), ...(related ? { related: relatedEpisodes } : {}) };
			if (check.ok) {
				return { aid, offset: check.offset, ...matchEpisodes(anime, check.offset, false, episodes), from, reason: check.reason, ...extra };
			}
			// A related anime's AniDB entry whose main episodes aren't this anime's: its specials may be (a mini anime,
			// shorts released between the episodes)
			if (related && anime.specials?.length) {
				const count = episodes ?? Math.max(1, ...points.map((p) => p.n));
				const sp = verify(asSpecials(anime));
				log.debug(`${mediaId}: AniDB ${aid}'s specials: ${sp.ok ? "verified" : "rejected"}, ${sp.reason}`);
				trace.add("anidb", mediaId, `Its specials instead: ${sp.ok ? "they fit" : "they don't fit"}: ${sp.reason}`);
				if (sp.ok && sp.offset + count <= anime.specials[anime.specials.length - 1].n) {
					const withSpecials = sp.reason.replace(/ lines? up/, (up) => `${up} with its special${count === 1 ? "" : "s"}`);
					const which = sp.offset ? "" : count === 1 ? " (S1)" : ` (S1-S${count})`;
					return {
						aid,
						offset: sp.offset,
						...matchEpisodes(anime, sp.offset, true, count),
						from,
						reason: `${withSpecials}${which}`,
						specials: true,
						...(sp.byTmdb ? { byTmdb: true } : {}),
						related: relatedEpisodes,
					};
				}
			}
			return { reason: check.reason };
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
			const override = tmdb.overrides.get(mediaId);
			const existing = anidbStore.get(mediaId);
			const now = Date.now();
			const fresh = (m?: CEM.AnidbMatch) => !!m && now - m.checkedAt < ANIDB_MATCH_KEEP;

			// "none": nothing looked up, and what was found before is forgotten
			if (override.anidbNone) {
				if (existing) saveAnidb(mediaId, null);
				return undefined;
			}
			if (override.anidbId) {
				const offset = override.anidbOffset ?? 0;
				const letter = override.anidbLetter;
				const same = existing?.status === "override" && existing.aid === override.anidbId && existing.offset === offset;
				const sameKind = existing?.letter === letter && (!override.anidbSpecials || !!existing?.specials);
				if (!force && same && sameKind && fresh(existing)) return existing;
				const noEpisodes = { eids: {}, airDates: {} };
				let anime = await anidbAnime(override.anidbId, force);
				// An entry cached before every lettered type was kept: fetched again for them
				if (letter && anime && !anime.lettered) anime = await anidbAnime(override.anidbId, true);
				// The entry's specials when you say so ("S1") or this anime's air dates fit them and not its main episodes (e.g.
				// a mini anime listed as the parent's specials); its other lettered types only when you say so ("O1")
				let specials = !!override.anidbSpecials && !letter;
				let count: number | undefined;
				if (letter || specials) {
					try {
						count = Number((await ctx.anime.getAnimeEntry(mediaId)).media?.episodes) || undefined;
					} catch {}
				} else if (anime?.specials?.length) {
					const { media, metadata } = await loadAnime(mediaId);
					count = Number(media?.episodes) || undefined;
					const points = airDatePoints(mediaId, media, metadata);
					const duration = Number(media?.duration) || undefined;
					specials = !verifyAnidb(points, anime, count, duration).ok && verifyAnidb(points, asSpecials(anime), count, duration).ok;
					if (specials) log.step(`${mediaId}: your AniDB ${override.anidbId}: the air dates fit its specials, not its main episodes`);
				}
				const match: CEM.AnidbMatch = {
					mediaId, status: "override", aid: override.anidbId, offset,
					...(anime ? matchEpisodes(letter ? asMain(anime, anime.lettered?.[letter] ?? []) : anime, offset, specials, count) : noEpisodes),
					from: "your override", checkedAt: now, ...(specials ? { specials } : {}), ...(letter ? { letter } : {}),
				};
				saveAnidb(mediaId, match);
				return match;
			}
			// The override was removed: forget what it set, then look up as if it never existed
			if (existing?.status === "override") {
				saveAnidb(mediaId, null);
				return anidbLookup() ? resolveAnidb(mediaId, force, scope) : undefined;
			}
			// Custom sources provide their own metadata: only your override, never a lookup
			if (!anidbLookup() || isCustomSource(mediaId)) return undefined;

			// TMDB's air dates that may count as evidence (see anidbEvidence): a match looked up with fewer is checked again
			// once there are more (a verified one kept from before this was counted: as with none)
			const tmdbDated = () => {
				const episodes = tmdbEvidence(mediaId)?.episodes ?? {};
				return Object.keys(episodes).filter((k) => /^\d+$/.test(k) && episodes[k]?.airDate).length;
			};
			const moreDates = () => tmdbDated() > (existing?.tmdbPoints ?? (existing?.status === "verified" ? 0 : Infinity));
			const verified = (found: Extract<AnidbFound, { aid: number }>): CEM.AnidbMatch => {
				// A failed TMDB match may line up with the new AniDB entry's dates: due now instead of at its weekly retry
				const record = thumbnails.get(mediaId);
				if (record?.status === "failed" && (record.nextCheckAt ?? 0) > now && existing?.aid !== found.aid) {
					thumbnails.set(mediaId, { ...record, nextCheckAt: now });
				}
				const match: CEM.AnidbMatch = {
					mediaId, status: "verified", ...found, ...trace.end("anidb", mediaId), checkedAt: now, tmdbPoints: tmdbDated(),
				};
				saveAnidb(mediaId, match);
				return match;
			};

			let recheck = "";
			if (existing?.status === "verified" && !force && moreDates()) {
				const { media, metadata } = await loadAnime(mediaId);
				trace.begin("anidb", mediaId);
				const counts = `TMDB now has ${tmdbDated()} air dates that can count, ${existing.tmdbPoints ?? 0} before`;
				trace.add("anidb", mediaId, `AniDB ${existing.aid} checked again: ${counts}`);
				const related = existing.related ?? (existing.specials ? 0 : undefined);
				const again = await findAnidb(mediaId, media, metadata, scope, { aid: existing.aid!, from: existing.from ?? "a lookup", related });
				if (again.aid) {
					log.step(`${mediaId}: AniDB ${again.aid} checked again with TMDB's air dates: ${again.reason}`);
					return verified(again);
				}
				if (again.transient) return existing;
				recheck = `AniDB ${existing.aid} no longer fits with TMDB's added dates (${again.reason}); looked up again`;
				log.warn(
					`${media?.title?.userPreferred ?? mediaId} (${mediaId}): AniDB ${existing.aid} no longer lines up now that TMDB has ` +
						`more air dates (${again.reason}); looking again`,
				);
			} else if (existing?.status === "verified" && !force) {
				if (fresh(existing)) return existing;
				// The ID stays; only the episode IDs are refreshed (new episodes of an airing anime)
				const anime = await anidbAnime(existing.aid!, true);
				let count: number | undefined;
				if (existing.specials) {
					try {
						count = Number((await ctx.anime.getAnimeEntry(mediaId)).media?.episodes) || undefined;
					} catch {}
				}
				const episodes = anime ? matchEpisodes(anime, existing.offset ?? 0, !!existing.specials, count) : {};
				const match = { ...existing, ...episodes, checkedAt: now };
				saveAnidb(mediaId, match);
				return match;
			}
			// A "none" found without checking related anime is looked up again once they may be checked, and one found with
			// fewer air dates than are known now (e.g. TMDB's, once it matched)
			if (existing?.status === "none" && !force && fresh(existing) && !moreDates()) return existing;

			const version = anidbWrites[mediaId] ?? 0;
			log.time(`anidb ${mediaId}`);
			// The anime's own air dates too (Animap's, when it has an entry but no AniDB ID)
			const { media, metadata } = await loadAnime(mediaId);
			trace.begin("anidb", mediaId);
			if (recheck) trace.add("anidb", mediaId, recheck);
			const found = await findAnidb(mediaId, media, metadata, scope);
			log.timeEnd(`anidb ${mediaId}`);
			const name = media?.title?.userPreferred ?? `${mediaId}`;
			// Another lookup for this anime (its page and the background) stored a result while this one ran. An ID it
			// found stays; this lookup's ID replaces only a "none"; a "none" from this one never replaces anything.
			if ((anidbWrites[mediaId] ?? 0) !== version) {
				const stored = anidbStore.get(mediaId);
				if (!found.aid || (stored && stored.status !== "none")) {
					trace.end("anidb", mediaId);
					log.step(`${name} (${mediaId}): another AniDB lookup finished first; keeping its result (${stored?.status ?? "nothing"})`);
					return stored?.status === "none" ? undefined : stored;
				}
			}
			if (found.aid) {
				const match = verified(found);
				const eids = Object.keys(found.eids).length;
				log.info(`${name} (${mediaId}): AniDB ${found.aid} from ${found.from} verified (${found.reason}), ${eids} episode IDs`);
				log.inspect(`${mediaId}: AniDB match`, match);
				return match;
			}
			log.step(`${name} (${mediaId}): no verified AniDB ID: ${found.reason}`);
			// A request that failed is retried next time; a real "no" is remembered for 14 days (and no ID is stored)
			if (!found.transient)
				saveAnidb(mediaId, {
					mediaId, status: "none", reason: found.reason, ...trace.end("anidb", mediaId), checkedAt: now, tmdbPoints: tmdbDated(),
				});
			return undefined;
		}

		/**
		 * Whether Seanime lacks an AniDB ID for this anime: no metadata at all, or metadata without one (Animap knows the
		 * anime but not its AniDB entry), or your override sets one. An ID the plugin added itself still counts as missing,
		 * so it stays maintained.
		 */
		async function needsAnidb(mediaId: number) {
			// "none": only to forget a match from before
			if (tmdb.overrides.get(mediaId).anidbNone) return !!anidbStore.get(mediaId);
			// Your override applies over an ID Seanime has too, and is forgotten once removed
			if (tmdb.overrides.get(mediaId).anidbId || anidbStore.get(mediaId)?.status === "override") return true;
			if (isCustomSource(mediaId)) return false;
			if (animap.get(mediaId)?.fallback) return true;
			if (!anidbLookup()) return false;
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

		// ----------------------------------------------------------------------------------------------------------------
		// 8. Scheduling and rebuilds: what's matched when (watching list, page, batches), Seanime's rebuilds
		// ----------------------------------------------------------------------------------------------------------------
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
			if (now - watching.at < WATCHING_LIST_KEEP) return watching.ids;
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
			watching = { ids, upcoming, at: ids === null ? now - WATCHING_LIST_KEEP + 30 * 1000 : now };
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

		/**
		 * On demand: match or refresh an anime when Seanime loads it and its data has expired (nextCheckAt), instead
		 * of refreshing everything on a clock. Until the refresh lands, the previous stills are still shown. In the
		 * background only anime being watched are matched; the rest wait for their page.
		 */
		async function serve(mediaId: number, page = false) {
			if (!tmdbOn() && !anidbLookup() && !tmdb.overrides.get(mediaId).anidbId) return;
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
			if (record && now < (record.nextCheckAt ?? 0)) {
				return log.step(`${mediaId}: fresh until ${new Date(record?.nextCheckAt ?? 0).toISOString()}`);
			}
			log.step(`${mediaId}: ${record ? "expired, refreshing" : "not matched yet, matching"}`);
			log.time(`refresh ${mediaId}`);
			await refreshAnime(mediaId, false, false, scope);
			log.timeEnd(`refresh ${mediaId}`);
			// The match may have brought TMDB's air dates, which the AniDB lookup hadn't had (checked again only then)
			if (await needsAnidb(mediaId)) await refreshAnidb(mediaId, false, scope);
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
			const when = rebuildUrgent ? "now" : `in ${Math.round(wait / 1000)}s (at most every ${REBUILD_GAP / 1000}s)`;
			log.step(`Rebuild ${when} for ${rebuildIds.length ? rebuildIds.join(", ") : "all anime"}`);
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
			const refreshCollection = rebuildStills && Date.now() - lastCollectionRefresh > COLLECTION_REFRESH_GAP;
			rebuildStills = false;
			if (refreshCollection) {
				lastCollectionRefresh = Date.now();
				watching.at = 0; // the watching list may have changed with it
				try {
					$anilist.refreshAnimeCollection();
				} catch (e) {
					log.warn(
						"Couldn't refresh the AniList collection, so Upcoming Episodes keeps its old stills " +
							"(the plugin needs the anilist permission):",
						e,
					);
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

		// ----------------------------------------------------------------------------------------------------------------
		// 9. Startup: registers the tray and episode menu, checks the settings, starts the timers and page watching
		// ----------------------------------------------------------------------------------------------------------------
		for (const refs of [tmdb.overrides.media.fieldRefs, tmdb.overrides.episode.fieldRefs, fieldRefs.data]) {
			for (const ref of Object.values(refs)) ref.onValueChange(() => checkUnsaved());
		}

		tray.render(function () {
			const media = currentMedia.get();
			const episode = currEditedEp.get();
			if (!media) return trayIntro();
			return withBanner(media.banner, confirmCover(media, episode), [
				tray.stack(
					[
						actionCss(),
						tray.div(
							[
								tray.text("Custom Episode Metadata for", { className: "text-sm" }),
								tray.text(`${media.title}`, { className: "font-bold text-xl line-clamp-2 break-normal text-pretty leading-tight" }),
								tray.text(`Episode ${episode?.episode}`, { className: `text-sm`, style: { display: episode ? "block" : "none" } }),
							],
							{ className: "space-y-1 font-semibold h-28" },
						),
						...(episode ? episodeEditor(media, episode) : [customEpisodeList(media)]),
					],
					{ className: "p-2 space-y-2 h-full" },
				),
			]);
		});

		tray.onOpen(() => {
			confirming.set(null);
			if (tmdbProblem()) ctx.toast.error(tmdbProblem());
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
				confirming.set(null);
				ctx.setTimeout(() => tray.open(), 500);
			});
		});

		ctx.effect(() => {
			const currEditedEpData = currEditedEp.get();
			!currEditedEpData ? fieldRefs.reset() : fieldRefs.fill(currEditedEpData);
			checkUnsaved();
		}, [currEditedEp]);
		/**
		 * Seanime keeps the metadata it built in memory for up to an hour, with the stills, fill-in data and AniDB IDs
		 * baked in, so switching a setting showed nothing until a restart. Changing a setting reloads the plugin: when a
		 * setting that changes what the hooks add differs from the last applied one, have Seanime rebuild its metadata
		 * once. The plugin's own TMDB and AniDB data on disk is kept, so nothing is fetched from TMDB again.
		 */
		const displaySettings = JSON.stringify({
			size: stillImageSize ?? "w1280",
			thumbnails: $getUserPreference("tmdb-thumbnails") === "true",
			fill: $getUserPreference("tmdb-fill-missing") === "true",
			anidb: $getUserPreference("anidb-lookup") !== "false",
			// Taking the token away removes the stored TMDB data from what Seanime shows; a new one is checked (by its fingerprint)
			tmdb: !!tmdbToken,
			token: tokenPrint,
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
		/** Stills or fill-in switched on without a usable token: said in the log, and as an error each time the tray opens */
		const tmdbProblem = () => {
			const stills = isOn("tmdb-thumbnails");
			const fill = isOn("tmdb-fill-missing");
			if (!tmdbMissing || !(stills || fill)) return "";
			const what = stills && fill ? "stills and fill-in are" : stills ? "stills are" : "fill-in is";
			return `TMDB ${what} on, but ${tmdbMissing}`;
		};
		if (tmdbProblem()) log.warn(tmdbProblem());
		// Just saved (Seanime reloads the plugin with its settings): say what's wrong with them on the settings page itself
		const badToken = tmdbSetting && tmdbMissing && tmdbMissing !== TOKEN_REJECTED ? tmdbMissing : "";
		if (appliedSettings !== displaySettings && (tmdbProblem() || badToken)) {
			const message = tmdbProblem() || badToken;
			ctx.setTimeout(() => ctx.toast.error(message[0].toUpperCase() + message.slice(1)), 1000);
		}
		/**
		 * A token new to the plugin (just saved: Seanime reloads the plugin with its settings) is tried once against TMDB's
		 * authentication endpoint. Rejected, TMDB stays off until another one is saved; a failed request decides nothing.
		 */
		async function checkToken() {
			let status = 0;
			try {
				const headers = { Authorization: `Bearer ${tmdb.API_KEY}`, Accept: "application/json" };
				status = (await ctx.fetch(`${tmdb.baseUri}/authentication`, { headers })).status;
			} catch (e) {
				return log.debug("Couldn't reach TMDB to check the token:", e);
			}
			if (status !== 200 && status !== 401) return log.debug(`TMDB answered ${status} checking the token`);
			$storage.set("CEM_TMDB_TOKEN_CHECK", { print: tokenPrint, ok: status === 200 });
			if (status === 200) return ctx.toast.success("TMDB accepted the API Read Access Token");
			tmdb.API_KEY = "";
			tmdbMissing = TOKEN_REJECTED;
			log.warn(TOKEN_REJECTED);
			ctx.toast.error(`${TOKEN_REJECTED}: check it in TMDB's API settings`);
			// Seanime drops what the plugin added from TMDB
			scheduleRebuild(true);
			tray.update();
		}
		if (tmdb.API_KEY && tokenVerdict?.print !== tokenPrint) void checkToken();
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
				if (hasCustom(Number(key)) || now - record.lastSeenAt <= FORGET_AFTER) continue;
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
	});
}
