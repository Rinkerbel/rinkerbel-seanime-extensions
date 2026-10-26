/// <reference path="../../typings/core.d.ts" />

// nekoBT's own types. Seanime loads only provider.ts, and these are erased when it compiles it, so they only serve type-checking.

interface NekoBTGroup {
	id: string;
	display_name: string;
	name: string;
	uploading_group: boolean;
}

interface NekoBTTorrent {
	id: string;
	uploaded_at: number | string;
	title: string;
	infohash: string;
	magnet: string;
	media_id: string;
	media_episode_ids?: (string | number)[];
	filesize: number | string;
	seeders: number | string;
	leechers: number | string;
	completed: number | string;
	groups: NekoBTGroup[];
	batch: boolean;
	level?: number | null;
	// Nyaa torrent id when nekoBT imported this torrent from Nyaa, else null
	imported?: number | string | null;
	// Upload time on Nyaa (ms) for imported torrents
	nyaa_upload_time?: number | string | null;
	audio_lang?: string;
	sub_lang?: string;
	fsub_lang?: string;
}

interface NekoBTTorrentDetail {
	files?: { name: string }[];
	mediainfo?: string | null;
}

interface NekoBTSearchResponse {
	error: boolean;
	message?: string;
	data?: {
		results: NekoBTTorrent[];
		more?: boolean;
	};
}

interface NekoBTEpisode {
	id: number;
	season: number;
	episode: number;
}

interface NekoBTRelation {
	id: number;
	relation_type?: string; // SEQUEL, PREQUEL, SIDE_STORY, ...
}

interface NekoBTAnilistEntry {
	media?: { relations?: NekoBTRelation[] };
	season: number | null;
	src_start: number;
	src_end: number | null;
	dst_start: number;
	dst_end: number | null;
	ratio: number | null;
	anilist_id: number;
}

interface NekoBTAnilistInfo {
	entries?: NekoBTAnilistEntry[];
	relations?: NekoBTRelation[];
	primary?: { relations?: NekoBTRelation[] };
}

interface NekoBTMediaResponse {
	error: boolean;
	message?: string;
	data?: {
		episodes?: NekoBTEpisode[];
		anilist?: {
			entries?: NekoBTAnilistEntry[];
			relations?: NekoBTRelation[];
			primary?: { relations?: NekoBTRelation[] };
		};
	};
}

interface NekoBTResolveResponse {
	error: boolean;
	data?: {
		media_id: string;
		anilist_id: number | null;
	};
}

interface NekoBTMediaSearchResponse {
	error: boolean;
	// `anilist` is null when nekoBT has no AniList mapping for the series, else the same object as on /media/<id>
	data?: { results?: { id: string; similarity?: number; year?: number; anilist?: NekoBTAnilistInfo | null }[] };
}

interface NekoMediaInfo {
	// true when the AniList ID did not resolve and we found the parent series through title search + AniList relations.
	// Then `episodes` are the nekoBT episodes that no AniList entry is mapped to (usually specials) and nekoBT gives us
	// no reliable AniList episode numbers for them.
	fallback: boolean;
	mediaId: string;
	// Every mapping range of this AniList entry (long series span many seasons)
	entries: NekoBTAnilistEntry[];
	episodes: NekoBTEpisode[];
	// Ids of every episode of the nekoBT media (not just this entry), to notice a stale cache
	allEpisodeIds?: string[];
	// true when this came from $store instead of a fresh fetch
	fromCache?: boolean;
	// nekoBT has the series but no AniList mapping: search by the nekoBT media id instead of the AniList ID
	byMediaId?: boolean;
	// nekoBT episode id -> AniList episode number
	episodeNumberById: Map<string, number>;
}

// The parts of NekoMediaInfo that can be stored in $store (no Map)
interface CachedNekoMedia {
	fallback: boolean;
	mediaId: string;
	// Every mapping range of this AniList entry (long series span many seasons)
	entries: NekoBTAnilistEntry[];
	episodes: NekoBTEpisode[];
	allEpisodeIds?: string[];
	byMediaId?: boolean;
}

interface SeaDexTr {
	infoHash: string;
	isBest?: boolean;
	url?: string;
	groupedUrl?: string;
	releaseGroup?: string;
	dualAudio?: boolean;
	created?: string;
	files?: { length: number; name: string }[];
}

// A nekoBT torrent that was imported from Nyaa. Its swarm on Nyaa is usually bigger than on nekoBT's tracker.
interface ImportedTorrent {
	hash: string;
	nyaaId: string;
	title: string;
	group: string;
}

// Details scraped from a Nyaa page. Keyed by info hash, so they never go stale (only seeders drift).
interface NyaaDetails {
	name: string;
	// Nyaa upload time (ISO). Missing in entries cached by older versions.
	date?: string;
	seeders: number;
	leechers: number;
	downloads: number;
	formattedSize: string;
}

// Parsed search query (Nyaa syntax)
type QueryNode =
	| { kind: "term"; text: string; tokens: string[]; quoted: boolean }
	| { kind: "and"; items: QueryNode[] }
	| { kind: "or"; items: QueryNode[] }
	| { kind: "not"; item: QueryNode };

interface QueryToken {
	type: "word" | "phrase" | "(" | ")" | "|" | "-";
	value: string;
}

interface SeaDexRecordsResponse {
	items?: { expand?: { trs?: SeaDexTr[] } }[];
}
