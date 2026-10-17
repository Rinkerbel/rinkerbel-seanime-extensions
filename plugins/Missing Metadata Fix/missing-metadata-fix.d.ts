/// <reference path="../../typings/app.d.ts" />

declare namespace CEM {
	interface SharedDatabase {
		records: () => Record<number, CustomEpisodeEntry>;
		get: (mediaId: number) => CustomEpisodeEntry;
		has: (mediaId: number) => boolean;
		save: (mediaId: number, data: CustomEpisodeMetadata) => CustomEpisodeEntry;
		delete: (mediaId: number, aniDBEpisode: string) => boolean;
	}

	type CustomEpisodeMetadata = Partial<
		Omit<$app.Metadata_EpisodeMetadata, "anidbId" | "tvdbId" | "episodeNumber" | "seasonNumber" | "absoluteEpisodeNumber" | "anidbEid">
	> &
		Pick<$app.Metadata_EpisodeMetadata, "episode">;

	interface CustomEpisodeEntry {
		mediaId: number;
		mediaTitle?: string;
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
		tmdbSeason?: number;
		/** Several TMDB seasons read as one run of episodes (tmdbSeason is the first). Offset counts across all of them. */
		tmdbSeasons?: number[];
		/** Added to the AniDB episode number to get the TMDB episode number (main episodes only). */
		tmdbOffset?: number;
		/** Real AniDB ID, for anime Seanime has no metadata for. */
		anidbId?: number;
		/** Added to this anime's episode number to get the AniDB main episode number (e.g. a second AniList part). */
		anidbOffset?: number;
		/** Skip this anime when automatically refreshing custom metadata from TMDB. */
		excludeAuto?: boolean;
		episodeOverrides: {
			aniDBEpisode?: string;
			tmdbId?: number;
			tmdbSeason?: number;
			tmdbEpisode?: number;
		}[];
	}

	interface V1Entry {
		mediaId: number;
		mediaTitle?: string;
		// can exist in local library and torrent streaming
		main: Partial<Record<number, V1CustomEpisodeMetadata>>;
		// can only exist in local library
		special: Partial<Record<number, V1CustomEpisodeMetadata>>;
		nc: Partial<Record<number, V1CustomEpisodeMetadata>>;
	}

	interface V1CustomEpisodeMetadata {
		// For tracking
		mediaId: number;
		type: $app.Anime_LocalFileType;
		episodeNumber: number;
		// For partial tracking
		aniDBEpisode?: string;
		// For display
		displayTitle?: string;
		episodeTitle?: string;
		length?: number;
		airDate?: $app.AL_FuzzyDateInput;
		overview?: string;
		image?: string;
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
		/** AniDB ID from ani.zip, 0 when it has none. */
		anidbId?: number;
	}

	interface AnimapStore {
		all: () => Record<number, AnimapStatus>;
		get: (mediaId: number) => AnimapStatus | undefined;
		set: (mediaId: number, status: AnimapStatus | null) => void;
	}

	/** Where an AniDB episode lives on TMDB. Movies have no season or episode. */
	interface TMDBTarget {
		tmdbId: number;
		season?: number;
		episode?: number;
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
		/** Refresh again sooner: the anime is airing, or a recent episode has no still yet. */
		active?: boolean;
		/** When the next refresh is due. Worked out from the airing schedule. */
		nextCheckAt?: number;
		/** Where the TMDB ID came from, for the status line. */
		idFrom?: string;
		/** Its own sources found nothing and related anime weren't checked in the background: matched on its page. */
		needsVisit?: boolean;
		/** TMDB episode metadata kept in the background for anime Seanime has no metadata for. */
		episodes?: Record<string, { title?: string; overview?: string; airDate?: string; length?: number }>;
		refreshedAt: number;
		lastSeenAt: number;
	}

	interface ThumbnailStore {
		all: () => Record<number, ThumbnailRecord>;
		get: (mediaId: number) => ThumbnailRecord | undefined;
		set: (mediaId: number, record: ThumbnailRecord | null) => void;
	}

	/** An AniDB anime's main episodes, from AniDB's HTTP API via proxy.ani.zip. */
	interface AnidbAnime {
		aid: number;
		/** Main episodes planned (AniDB's episodecount), 0 when unknown. */
		episodeCount: number;
		main: { n: number; eid: number; airDate?: string; length?: number }[];
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
		from?: string;
		reason?: string;
		/** "none" without checking related anime (background): looked up again on its page. */
		needsVisit?: boolean;
		checkedAt: number;
	}

	/** One step up an anime's parent/prequel chain, from AniList, cached for 30 days. */
	interface RelationStep {
		next: { id: number; title: string; relation: string } | null;
		at: number;
	}
}
