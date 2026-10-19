/// <reference path="../../typings/app.d.ts" />

declare namespace CEM {
	interface SharedDatabase {
		get: (mediaId: number) => CustomEpisodeEntry;
		save: (mediaId: number, data: CustomEpisodeMetadata) => void;
		delete: (mediaId: number, aniDBEpisode: string) => void;
	}

	/** A per-anime record store kept on disk, shared between the plugin's contexts (see keyedStore). */
	interface KeyedStore<T> {
		all: () => Record<number, T>;
		get: (mediaId: number) => T | undefined;
		set: (mediaId: number, value: T | null) => void;
	}
	type AnimapStore = KeyedStore<AnimapStatus>;
	type ThumbnailStore = KeyedStore<ThumbnailRecord>;
	type AnidbStore = KeyedStore<AnidbMatch>;

	type CustomEpisodeMetadata = Partial<
		Omit<$app.Metadata_EpisodeMetadata, "anidbId" | "tvdbId" | "episodeNumber" | "seasonNumber" | "absoluteEpisodeNumber" | "anidbEid">
	> &
		Pick<$app.Metadata_EpisodeMetadata, "episode">;

	interface CustomEpisodeEntry {
		mediaId: number;
		data: Record<string, CustomEpisodeMetadata>;
	}

	interface TMDBSearchResults {
		page: number;
		results: {
			adult: boolean;
			backdrop_path: string;
			genre_ids: number[];
			id: number;
			origin_country: string[];
			original_language: string;
			original_name: string;
			overview: string;
			popularity: number;
			poster_path: string;
			first_air_date: string;
			/** Movies' */
			title?: string;
			release_date?: string;
			/** Multi search only */
			media_type?: "tv" | "movie" | "person";
			softcore: boolean;
			name: string;
			vote_average: number;
			vote_count: number;
		}[];
		total_pages: number;
		total_results: number;
	}

	interface BaseMedia {
		adult: boolean;
		backdrop_path: string | null;
		genres: {
			id: number;
			name: string;
		}[];
		homepage: string;
		id: number;
		origin_country: string[];
		original_language: string;
		overview: string;
		popularity: number;
		poster_path: string | null;
		production_companies: {
			id: number;
			logo_path: string | null;
			name: string;
			origin_country: string;
		}[];
		production_countries: {
			iso_3166_1: string;
			name: string;
		}[];
		softcore: boolean;
		spoken_languages: {
			english_name: string;
			iso_639_1: string;
			name: string;
		}[];
		status: string;
		tagline: string;
		vote_average: number;
		vote_count: number;
	}

	interface TMDBTVShowDetails extends BaseMedia {
		created_by: any[];
		episode_run_time: number[];
		first_air_date: string;
		in_production: boolean;
		languages: string[];
		last_air_date: string;
		last_episode_to_air: {
			id: number;
			name: string;
			overview: string;
			vote_average: number;
			vote_count: number;
			air_date: string;
			episode_number: number;
			episode_type: string;
			production_code: string;
			runtime: number | null;
			season_number: number;
			show_id: number;
			still_path: string | null;
		};
		name: string;
		next_episode_to_air: {
			id: number;
			name: string;
			overview: string;
			vote_average: number;
			vote_count: number;
			air_date: string;
			episode_number: number;
			episode_type: string;
			production_code: string;
			runtime: number | null;
			season_number: number;
			show_id: number;
			still_path: string | null;
		};
		networks: {
			id: number;
			logo_path: string | null;
			name: string;
			origin_country: string;
		}[];
		number_of_episodes: number;
		number_of_seasons: number;
		original_name: string;
		seasons: {
			air_date: string;
			episode_count: number;
			id: number;
			name: string;
			overview: string;
			poster_path: string | null;
			season_number: number;
			vote_average: number;
		}[];
		type: string;
	}

	interface TMDBMovieDetails extends BaseMedia {
		belongs_to_collection: {
			id: number;
			name: string;
			poster_path: string | null;
			backdrop_path: string | null;
		} | null;
		budget: number;
		imdb_id: string | null;
		original_title: string;
		release_date: string;
		revenue: number;
		runtime: number | null;
		title: string;
		video: boolean;
	}

	interface TMDBSeasonResults {
		_id: string;
		air_date: string;
		episodes: {
			air_date: string;
			episode_number: number;
			episode_type: string;
			id: number;
			name: string;
			overview: string;
			production_code: string;
			runtime: number;
			season_number: number;
			show_id: number;
			still_path: string;
			vote_average: number;
			vote_count: number;
			crew: {
				department: string;
				job: string;
				credit_id: string;
				adult: boolean;
				gender: number;
				id: number;
				known_for_department: string;
				name: string;
				original_name: string;
				popularity: number;
				profile_path: string;
			}[];
			guest_stars: {
				character: string;
				credit_id: string;
				order: number;
				adult: boolean;
				gender: number;
				id: number;
				known_for_department: string;
				name: string;
				original_name: string;
				popularity: number;
				profile_path: string;
			}[];
		}[];
		name: string;
		networks: {
			id: number;
			logo_path: string;
			name: string;
			origin_country: string;
		}[];
		overview: string;
		id: number;
		poster_path: string;
		season_number: number;
		vote_average: number;
	}

	interface TMDBOverrides {
		mediaId: number;
		tmdbId?: number;
		/** The TMDB ID's type, when it's known (entered as "movie/123", or found as one): TV and movie IDs overlap. */
		tmdbType?: "tv" | "movie";
		tmdbSeason?: number;
		/** Several TMDB seasons read as one run of episodes (tmdbSeason is the first). Offset counts across all of them. */
		tmdbSeasons?: number[];
		/**
		 * TMDB episode ranges read as one run, in TMDB's order ("S1E2-S1E4, S1E7"), then every later episode (tmdbSeason is
		 * the first range's). A range without an end episode runs to the end of its last season. Offset counts across it.
		 */
		tmdbRanges?: TMDBRange[];
		/** Added to the AniDB episode number to get the TMDB episode number (main episodes only). */
		tmdbOffset?: number;
		/** Real AniDB ID, for anime Seanime has no metadata for. */
		anidbId?: number;
		/** Added to this anime's episode number to get the AniDB main episode number (e.g. a second AniList part). */
		anidbOffset?: number;
		/** No tray badge or Overrides dot for this anime's missing TMDB match or AniDB ID. */
		ignoreWarnings?: boolean;
		episodeOverrides: {
			aniDBEpisode?: string;
			tmdbId?: number;
			/** "movie": the episode is a TMDB movie (entered as m123), e.g. an anime whose episodes are separate movies. */
			tmdbType?: "tv" | "movie";
			tmdbSeason?: number;
			tmdbEpisode?: number;
		}[];
	}

	/** Whether Animap can serve an anime, decided by the UI context and read by the metadata hooks. */
	interface AnimapStatus {
		/** Animap returned an error, so the plugin supplies the episode list itself. */
		fallback: boolean;
		/** Number of episodes to generate when acting as the fallback. */
		episodeCount: number;
		/** When Animap was last asked. An anime it had no entry for is asked again daily for a week, then weekly. */
		checkedAt?: number;
		/** When Animap was first found to have no entry for this anime. */
		since?: number;
	}

	/** One range of the Season field ("S1E2-S1E4"), in TMDB's order. */
	interface TMDBRange {
		season: number;
		episode: number;
		toSeason: number;
		/** Missing: to the end of toSeason */
		toEpisode?: number;
	}

	/** Where an AniDB episode lives on TMDB. Movies have no season or episode. */
	interface TMDBTarget {
		tmdbId: number;
		season?: number;
		episode?: number;
		/** A TMDB movie as one episode (an episode override of m123) */
		movie?: boolean;
	}

	/** How an anime maps onto TMDB, and the stills found for it. Refreshed automatically, kept on disk. */
	interface ThumbnailRecord {
		mediaId: number;
		status: "matched" | "failed";
		reason?: string;
		/** "override": built from the media override; "auto": matched by air date. */
		source?: "override" | "auto";
		tmdbType?: "tv" | "movie";
		tmdbId?: number;
		map: Record<string, TMDBTarget>;
		/** Season and offset used for episodes that aren't dated yet. */
		fallback?: { season: number; offset: number; seasons?: number[] };
		images: Record<string, string>;
		/** When the next refresh is due. Worked out from the airing schedule. */
		nextCheckAt?: number;
		/** Matched by episode count: the air dates didn't line up (e.g. TMDB lists a streaming release). */
		byCount?: boolean;
		/** Matched by episode title: the air dates didn't line up (e.g. TMDB lists wrong dates). */
		byTitle?: boolean;
		/** Matched by the show's exact title and episode count, its dates within a week (TMDB a few days off). */
		byName?: boolean;
		/** The TMDB ID came from a related anime or a title search, not this anime's own IDs. */
		borrowed?: boolean;
		/** Where the TMDB ID came from, for the status line. */
		idFrom?: string;
		/** TMDB episode metadata kept in the background for anime Seanime has no metadata for. */
		/** aired: aired by AniList although TMDB dates it later. */
		episodes?: Record<string, { title?: string; overview?: string; airDate?: string; length?: number; aired?: boolean }>;
		/** Failed since then (kept while it keeps failing): retried daily for a week, weekly after. */
		failedSince?: number;
		refreshedAt: number;
		lastSeenAt: number;
	}

	/** The episode list supplied for an anime Animap has no entry for. */
	interface FallbackSupply {
		count: number;
		aid?: number;
		eids: Record<string, number>;
		/** AniDB's air dates for the supplied episodes */
		airDates?: Record<string, string>;
	}

	/** An AniDB episode: English title only, summary when AniDB has one. */
	interface AnidbEpisode { n: number; eid: number; airDate?: string; length?: number; title?: string; summary?: string }

	/** An AniDB anime's main episodes, from AniDB's HTTP API via proxy.ani.zip. */
	interface AnidbAnime {
		aid: number;
		/** Main episodes planned (AniDB's episodecount), 0 when unknown. */
		episodeCount: number;
		/** Undated first and last main episodes are dated by the entry's start and end dates. */
		main: AnidbEpisode[];
		/** Specials (S1 as n 1). */
		specials: AnidbEpisode[];
		/** The MyAnimeList entries AniDB links (several for an entry MAL splits into parts). */
		malIds: number[];
	}

	/** The AniDB ID used for an anime Seanime has no metadata for. */
	interface AnidbMatch {
		mediaId: number;
		/** verified: an automatic match whose air dates lined up; override: the user's ID; none: nothing usable. */
		status: "verified" | "override" | "none";
		aid?: number;
		offset?: number;
		/** This anime's episode number -> AniDB episode ID. */
		eids?: Record<string, number>;
		/** This anime's episode number -> AniDB air date, to add episodes Seanime's metadata is missing once aired. */
		airDates?: Record<string, string>;
		/** This anime's episode number -> AniDB's title, air date, length and summary (see the fill-in priorities). */
		episodes?: Record<string, { title?: string; airDate?: string; length?: number; summary?: string }>;
		/** The episodes are the AniDB entry's specials (a related anime has its main episodes), S1 onwards plus the offset. */
		specials?: boolean;
		from?: string;
		reason?: string;
		/** "none": how many of TMDB's air dates it had; looked up again once TMDB has more (they're tried on their own too). */
		tmdbPoints?: number;
		checkedAt: number;
	}

	/** One step up an anime's parent/prequel chain, from AniList, cached for 30 days. */
	interface RelationStep {
		/** episodes: AniList's episode count for it (0 when unknown; missing in steps cached before it was kept). */
		next: { id: number; title: string; relation: string; episodes?: number } | null;
		at: number;
	}
}
