/// <reference path="./anime-torrent-provider.d.ts" />
/// <reference path="./core.d.ts" />


//+ --------------------------------------------------------------------------------------------------
// Types
//+ --------------------------------------------------------------------------------------------------

interface NekoBTGroup {
    id: string
    display_name: string
    name: string
    uploading_group: boolean
}

interface NekoBTTorrent {
    id: string
    uploaded_at: number | string
    title: string
    infohash: string
    magnet: string
    media_id: string
    media_episode_ids?: (string | number)[]
    filesize: number | string
    seeders: number | string
    leechers: number | string
    completed: number | string
    groups: NekoBTGroup[]
    batch: boolean
    level?: number | null
    audio_lang?: string
    sub_lang?: string
    fsub_lang?: string
}

interface NekoBTTorrentDetail {
    files?: { name: string }[]
    mediainfo?: string | null
}

interface NekoBTSearchResponse {
    error: boolean
    message?: string
    data?: {
        results: NekoBTTorrent[]
        more?: boolean
    }
}

interface NekoBTEpisode {
    id: number
    season: number
    episode: number
}

interface NekoBTRelation {
    id: number
}

interface NekoBTAnilistEntry {
    media?: { relations?: NekoBTRelation[] }
    season: number | null
    src_start: number
    src_end: number | null
    dst_start: number
    dst_end: number | null
    ratio: number | null
    anilist_id: number
}

interface NekoBTMediaResponse {
    error: boolean
    message?: string
    data?: {
        episodes?: NekoBTEpisode[]
        anilist?: {
            entries?: NekoBTAnilistEntry[]
            relations?: NekoBTRelation[]
            primary?: { relations?: NekoBTRelation[] }
        }
    }
}

interface NekoBTResolveResponse {
    error: boolean
    data?: {
        media_id: string
        anilist_id: number | null
    }
}

// What we keep per AniList entry: the nekoBT media id plus the episodes that belong to this specific entry.
interface NekoBTMediaSearchResponse {
    error: boolean
    data?: { results?: { id: string }[] }
}

interface NekoMediaInfo {
    // true when the AniList ID did not resolve and we found the parent series through title search + AniList relations.
    // Then `episodes` are the nekoBT episodes that no AniList entry is mapped to (usually specials) and nekoBT gives us
    // no reliable AniList episode numbers for them.
    fallback: boolean
    mediaId: string
    // true when we could not map this AniList entry to specific nekoBT episodes (movies, unmapped entries).
    // In that case the search uses media_id=anilist-<id> and lets nekoBT narrow to the entry's episodes.
    useExternalId: boolean
    // Every mapping range of this AniList entry (long series span many seasons)
    entries: NekoBTAnilistEntry[]
    episodes: NekoBTEpisode[]
    // nekoBT episode id -> AniList episode number
    episodeNumberById: Map<string, number>
}

// The parts of NekoMediaInfo that can be stored in $store (no Map)
interface CachedNekoMedia {
    fallback: boolean
    mediaId: string
    useExternalId: boolean
    // Every mapping range of this AniList entry (long series span many seasons)
    entries: NekoBTAnilistEntry[]
    episodes: NekoBTEpisode[]
}

interface SeaDexTr {
    infoHash: string
    isBest?: boolean
    url?: string
    groupedUrl?: string
    releaseGroup?: string
    dualAudio?: boolean
    created?: string
    files?: { length: number, name: string }[]
}

// Details scraped from a Nyaa page. Keyed by info hash, so they never go stale (only seeders drift).
interface NyaaDetails {
    name: string
    seeders: number
    leechers: number
    downloads: number
    formattedSize: string
}

// Parsed search query (Nyaa syntax)
type QueryNode =
    | { kind: "term", tokens: string[] }
    | { kind: "and", items: QueryNode[] }
    | { kind: "or", items: QueryNode[] }
    | { kind: "not", item: QueryNode }

interface QueryToken {
    type: "word" | "phrase" | "(" | ")" | "|" | "-"
    value: string
}

interface SeaDexRecordsResponse {
    items?: { expand?: { trs?: SeaDexTr[] } }[]
}

//+ --------------------------------------------------------------------------------------------------
// Constants
//+ --------------------------------------------------------------------------------------------------

const API_URL = "https://nekobt.to/api/v1"
const SEADEX_URL = "https://releases.moe/api/collections/entries/records"
const PAGE_LIMIT = 100
const MAX_PAGES = 5

// How long nekoBT media info and SeaDex lists are reused (only if Seanime gives extensions a store, see cacheGet)
const CACHE_TTL_MS = 60 * 60 * 1000
// How long "this anime is not on nekoBT" is remembered
const MISSING_TTL_MS = 30 * 60 * 1000
// Finished/cancelled anime don't get new episodes, so their nekoBT media info is reused longer
const FINISHED_TTL_MS = 24 * 60 * 60 * 1000
// Above this many episode ids the URL gets huge, so nekoBT is asked to narrow by AniList ID instead
const MAX_EPISODE_IDS = 150
// Sub level used for torrents nekoBT has no level for (lower than -1 = "no subs")
const UNKNOWN_LEVEL = -2
const VIDEO_FILE = /\.(mkv|mp4|avi|m2ts|ts|webm|mov|wmv|flv|ogm)$/i

// Rate limits: retry once if the server asks us to wait no longer than this
const MAX_RATE_LIMIT_RETRIES = 1
const MAX_RATE_LIMIT_WAIT_MS = 15000

// Shorthands users can type in the manifest config -> nekoBT ids
const VIDEO_CODECS: Record<string, number> = {
    "other": 0,
    "h264": 1, "avc": 1, "x264": 1,
    "h265": 2, "hevc": 2, "x265": 2,
    "av1": 3,
    "vp9": 4,
    "mpeg2": 5, "mpeg-2": 5,
    "xvid": 6, "divx": 6,
    "wmv": 7,
    "vc1": 8, "vc-1": 8,
}

const VIDEO_TYPES: Record<string, number> = {
    "other": 0,
    "vhs": 1,
    "ld": 2, "laserdisc": 2,
    "tv-encode": 3,
    "tv-raw": 4,
    "dvd-remux": 5,
    "dvd-encode": 6,
    "web-mini": 7,
    "web-encode": 8,
    "web-dl": 9, "webdl": 9,
    "bd-disc": 11,
    "bd-mini": 12,
    "bd-encode": 13,
    "bd-remux": 14,
    "hybrid": 15,
    "dvd-disc": 16,
}

// [ISO 639-1, ISO 639-2/T, English name]
const LANGUAGES: [string, string, string][] = [
    ["en", "eng", "English"], ["ja", "jpn", "Japanese"], ["es", "spa", "Spanish"], ["pt", "por", "Portuguese"],
    ["fr", "fra", "French"], ["de", "deu", "German"], ["it", "ita", "Italian"], ["ru", "rus", "Russian"],
    ["ar", "ara", "Arabic"], ["zh", "zho", "Chinese"], ["ko", "kor", "Korean"], ["id", "ind", "Indonesian"],
    ["ms", "msa", "Malay"], ["pl", "pol", "Polish"], ["th", "tha", "Thai"], ["tr", "tur", "Turkish"],
    ["vi", "vie", "Vietnamese"], ["ta", "tam", "Tamil"], ["te", "tel", "Telugu"], ["hi", "hin", "Hindi"],
    ["nl", "nld", "Dutch"], ["sv", "swe", "Swedish"], ["no", "nor", "Norwegian"], ["da", "dan", "Danish"],
    ["fi", "fin", "Finnish"], ["cs", "ces", "Czech"], ["hu", "hun", "Hungarian"], ["ro", "ron", "Romanian"],
    ["bg", "bul", "Bulgarian"], ["uk", "ukr", "Ukrainian"], ["el", "ell", "Greek"], ["he", "heb", "Hebrew"],
    ["fa", "fas", "Persian"], ["bn", "ben", "Bengali"], ["ur", "urd", "Urdu"], ["tl", "fil", "Filipino"],
    ["ca", "cat", "Catalan"], ["hr", "hrv", "Croatian"], ["sr", "srp", "Serbian"], ["sk", "slk", "Slovak"],
    ["sl", "slv", "Slovenian"], ["lt", "lit", "Lithuanian"], ["lv", "lav", "Latvian"], ["et", "est", "Estonian"],
    ["ml", "mal", "Malayalam"], ["mr", "mar", "Marathi"], ["kn", "kan", "Kannada"], ["my", "mya", "Burmese"],
    ["km", "khm", "Khmer"], ["la", "lat", "Latin"],
]

const NYAA_TRACKERS = [
    "http://nyaa.tracker.wf:7777/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.opentrackr.org:1337/announce",
]

// Nyaa pages scraped per search (the rest of the SeaDex releases are built from SeaDex's own data)
const MAX_SEADEX_SCRAPES = 12
// Nyaa pages scraped at the same time (Nyaa rate limits bursts)
const NYAA_CONCURRENCY = 3
// Nyaa RSS searches (SeaDex "grouped" search links) per search
const MAX_NYAA_RSS = 5

const ALL_VIDEO_TYPE_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16]

//+ --------------------------------------------------------------------------------------------------
// Provider
//+ --------------------------------------------------------------------------------------------------

class Provider {
    private mediaCache: Map<number, NekoMediaInfo | null> = new Map()
    private bestCache: Map<number, SeaDexTr[]> = new Map()
    private levelByHash: Map<string, number> = new Map()
    private nekoIdByHash: Map<string, string> = new Map()

    public getSettings(): AnimeProviderSettings {
        return {
            type: "main",
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query"],
            supportsAdult: false,
        }
    }

    public async getLatest(): Promise<AnimeTorrent[]> {
        try {
            const params = ["sort_by=rss", "category=0", `limit=${PAGE_LIMIT}`, "upgraded=false", ...this.buildUserFilters()]
            const res = await this.fetchSearch(params)
            if (!res || !res.data || !Array.isArray(res.data.results)) return []
            return res.data.results.map(t => this.toAnimeTorrent(t, null))
        } catch (error) {
            console.error("nekoBT: Error fetching latest: " + (error as Error).message)
            return []
        }
    }

    public async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            return await this.searchMedia(opts.media, { query: opts.query, freeText: true })
        } catch (error) {
            console.error("nekoBT: Error in search: " + (error as Error).message)
            return []
        }
    }

    public async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        try {
            return await this.searchMedia(opts.media, {
                query: opts.query,
                batch: !!opts.batch,
                episodeNumber: opts.batch ? undefined : opts.episodeNumber,
                knownEpisode: opts.episodeNumber,
                resolution: opts.resolution,
            })
        } catch (error) {
            console.error("nekoBT: Error in smart search: " + (error as Error).message)
            return []
        }
    }

    public async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    public async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        let magnet = torrent.magnetLink || torrent.downloadUrl || ""
        if (!magnet) return ""

        // SeaDex releases come from Nyaa and never get the private nekoBT tracker
        if (NYAA_TRACKERS.some(t => magnet.indexOf(encodeURIComponent(t)) !== -1)) return magnet

        // Seanime doesn't tell providers whether the magnet is for debrid or torrent streaming, so this is a manual switch
        const useUserkey = this.getPref("useUserkey").toLowerCase() === "true"
        const userkey = this.getPref("userkey")
        if (!useUserkey || !userkey) return magnet

        let cleanUserkey = userkey
        if (cleanUserkey.includes("/tracker/")) {
            const parts = cleanUserkey.split("/tracker/")
            if (parts.length > 1) cleanUserkey = parts[1].split("/")[0]
        }

        const trUrl = `https://tracker.nekobt.to/api/tracker/${cleanUserkey}/announce`
        const encodedTr = encodeURIComponent(trUrl)

        // Replace an existing nekoBT tracker URL (encoded or not), otherwise append ours
        const regexEncoded = /tr=https%3A%2F%2Ftracker\.nekobt\.to%2Fapi%2Ftracker%2F[a-zA-Z0-9_-]+%2Fannounce/i
        const regexUnencoded = /tr=https:\/\/tracker\.nekobt\.to\/api\/tracker\/[a-zA-Z0-9_-]+\/announce/i

        if (regexEncoded.test(magnet)) {
            magnet = magnet.replace(regexEncoded, `tr=${encodedTr}`)
        } else if (regexUnencoded.test(magnet)) {
            magnet = magnet.replace(regexUnencoded, `tr=${trUrl}`)
        } else {
            magnet += `&tr=${encodedTr}`
        }
        return magnet
    }

    //+ ----------------------------------------------------------------------------------------------
    // Search
    //+ ----------------------------------------------------------------------------------------------

    private async searchMedia(
        media: Media,
        opts: {
            query?: string
            batch?: boolean
            episodeNumber?: number
            // The episode Seanime has selected, also in batch mode (used to always show SeaDex best releases)
            knownEpisode?: number
            resolution?: string
            // Simple search: search nekoBT by the query alone, like Nyaa, without restricting to this anime's episodes
            freeText?: boolean
        },
    ): Promise<AnimeTorrent[]> {
        const [nekoMedia, seaDex] = await Promise.all([this.getNekoMedia(media), this.getSeaDexBest(media.id)])
        if (!nekoMedia) console.warn(`nekoBT: No nekoBT media found for AniList ID ${media.id}`)
        const wantedEp = opts.episodeNumber && opts.episodeNumber > 0 ? opts.episodeNumber : undefined

        const first = await this.collect(media, nekoMedia, seaDex, opts, wantedEp, false)

        // Batches off and no single-episode release anywhere (nekoBT or SeaDex): include batches from both.
        // SeaDex best releases added regardless of the toggle don't count, so they never block this.
        if (first.regularCount === 0 && opts.batch !== true && wantedEp !== undefined) {
            return (await this.collect(media, nekoMedia, seaDex, opts, wantedEp, true)).torrents
        }
        return first.torrents
    }

    private async collect(
        media: Media,
        nekoMedia: NekoMediaInfo | null,
        seaDex: SeaDexTr[],
        opts: { query?: string, batch?: boolean, resolution?: string, knownEpisode?: number, freeText?: boolean },
        wantedEp: number | undefined,
        includeBatches: boolean,
    ): Promise<{ torrents: AnimeTorrent[], regularCount: number }> {
        const results: AnimeTorrent[] = []
        // SeaDex best releases shown even though they don't match the Batches toggle
        const injected = new Set<string>()
        const seen = new Set<string>()
        // nekoBT episode ids per info hash, for the per-episode fansub preference
        const episodesByHash = new Map<string, string[]>()

        // ---- nekoBT
        const query = (opts.query || "").trim()
        const freeText = !!opts.freeText && query.length > 0
        if (nekoMedia || freeText) {
            const params: string[] = [
                "sort_by=best",
                "category=0",
                `limit=${PAGE_LIMIT}`,
                "upgraded=false",
            ]

            if (nekoMedia && !freeText) {
                // Without episode_match_any the API only returns torrents containing ALL listed episodes,
                // so it is always enabled and `batch` decides between packs and single episodes.
                let episodeIds: string[] = nekoMedia.episodes.map(e => String(e.id))
                if (wantedEp !== undefined && !opts.batch) {
                    const single = this.findEpisode(nekoMedia, wantedEp)
                    if (single) episodeIds = [String(single.id)]
                }
                const byAnilistId = nekoMedia.useExternalId || (!nekoMedia.fallback && episodeIds.length > MAX_EPISODE_IDS)
                params.push(`media_id=${byAnilistId ? `anilist-${media.id}` : nekoMedia.mediaId}`)
                if (!byAnilistId && episodeIds.length > 0) {
                    params.push(`episode_ids=${episodeIds.join(",")}`)
                    params.push("episode_match_any=true")
                }

                if (opts.batch === true) params.push("batch=true")
                else if (wantedEp !== undefined && !includeBatches) params.push("batch=false")
            }

            if (query) params.push(`query=${encodeURIComponent(query)}`)
            params.push(...this.buildUserFilters())

            for (const t of await this.fetchAllPages(params)) {
                if (!t.infohash) continue
                const hash = t.infohash.toLowerCase()
                if (seen.has(hash)) continue
                seen.add(hash)
                if (t.id) this.nekoIdByHash.set(hash, t.id)
                // A missing sub level (null) ranks below every real level for "prefer fansubs"
                this.levelByHash.set(hash, typeof t.level === "number" ? t.level : UNKNOWN_LEVEL)
                episodesByHash.set(hash, (t.media_episode_ids || []).map(String))
                results.push(this.toAnimeTorrent(t, nekoMedia))
            }

            // Fallback mode has no episode mapping: select the episode from the torrent name instead
            if (nekoMedia && nekoMedia.fallback && wantedEp !== undefined && !opts.batch) {
                for (let i = results.length - 1; i >= 0; i--) {
                    const n = results[i].episodeNumber
                    if (n !== -1 && n !== wantedEp) results.splice(i, 1)
                }
            }
        }

        const pull = this.getPref("pullSeaDex").toLowerCase() !== "false"

        // ---- SeaDex releases nekoBT doesn't have (Nyaa only). Filtered by batch/episode BEFORE any Nyaa page is scraped.
        if (pull) {
            const onNyaa = (tr: SeaDexTr) => !!tr.url && /^https:\/\/nyaa\.si\//.test(tr.url)
            const knownEp = opts.knownEpisode && opts.knownEpisode > 0 ? opts.knownEpisode : undefined
            // Batch mode without an episode number: best singles are only added when SeaDex has no best batch
            const hasBestBatch = seaDex.some(tr => onNyaa(tr) && tr.isBest !== false && (tr.files ?? []).length !== 1)

            const normallyShown = (tr: SeaDexTr, isBatch: boolean): boolean => {
                if (opts.batch === true) return isBatch
                if (wantedEp !== undefined) {
                    // Batches off: SeaDex batches only appear in the batch fallback, like nekoBT batches
                    if (isBatch && !includeBatches) return false
                    // The release must contain the episode. Releases whose files carry no recognisable
                    // episode numbers are kept.
                    const eps = this.releaseEpisodes(tr.files ?? [], nekoMedia, media)
                    return eps.size === 0 || eps.has(wantedEp)
                }
                return true
            }

            // A SeaDex best release that contains the selected episode is always shown, whatever the Batches toggle says
            const alwaysShownBest = (tr: SeaDexTr, isBatch: boolean): boolean => {
                if (tr.isBest === false) return false
                if (knownEp !== undefined) return this.releaseEpisodes(tr.files ?? [], nekoMedia, media).has(knownEp)
                return opts.batch === true && !isBatch && !hasBestBatch
            }

            const wanted = seaDex.filter(tr => {
                if (!onNyaa(tr)) return false
                if (seen.has(tr.infoHash.toLowerCase())) return false
                const isBatch = (tr.files ?? []).length !== 1
                if (normallyShown(tr, isBatch)) return true
                if (alwaysShownBest(tr, isBatch)) {
                    injected.add(tr.infoHash.toLowerCase())
                    return true
                }
                return false
            })
            // One Nyaa RSS request per SeaDex search link covers many releases; only what's left is scraped
            await this.prefetchNyaaDetails(wanted)
            const built = await this.mapLimited(wanted, NYAA_CONCURRENCY, (tr, i) => this.getSeaDexTorrent(tr, media, nekoMedia, i < MAX_SEADEX_SCRAPES))
            // A typed query applies to SeaDex releases too (nekoBT applies it to its own results)
            const matchesQuery = this.buildQueryMatcher(query, media)
            for (const t of built) {
                if (matchesQuery && !matchesQuery(t.name.replace(/^\[(BEST|ALT)\] /, ""))) continue
                if (t.infoHash) seen.add(t.infoHash)
                results.push(t)
            }
        }

        // ---- Every SeaDex release (best or alt) is a best release for Seanime
        const isBestByHash = new Map<string, boolean>()
        for (const tr of seaDex) isBestByHash.set(tr.infoHash.toLowerCase(), tr.isBest !== false)
        for (const r of results) {
            if (!r.infoHash || !isBestByHash.has(r.infoHash)) continue
            r.isBestRelease = true
            r.link = `https://releases.moe/${media.id}/`
            if (pull && r.name.indexOf("[BEST] ") !== 0 && r.name.indexOf("[ALT] ") !== 0) {
                r.name = `${isBestByHash.get(r.infoHash) ? "[BEST]" : "[ALT]"} ${r.name}`
            }
        }

        const filtered = await this.filterByResolution(results, opts.resolution)
        const torrents = this.applyFansubPreference(filtered, episodesByHash)
        const regularCount = torrents.filter(t => !t.infoHash || !injected.has(t.infoHash)).length
        return { torrents, regularCount }
    }

    // "Prefer fansubs", decided per episode: for every episode, only torrents with the highest sub level available
    // for that episode are kept (L3, else L2, else L1; if the best is L0 or no subs, everything for that episode stays).
    // Torrents without a sub level count as the lowest level, so they're only kept when nothing better exists.
    // A torrent stays if it is the best option for at least one episode it contains, so a lower-level batch that
    // covers episodes nobody else has is kept. SeaDex releases are never removed and don't take part.
    private applyFansubPreference(results: AnimeTorrent[], episodesByHash: Map<string, string[]>): AnimeTorrent[] {
        if (this.getPref("preferFansubs").toLowerCase() !== "true") return results
        const levelOf = (r: AnimeTorrent) => (r.infoHash ? this.levelByHash.get(r.infoHash) : undefined)
        const episodesOf = (r: AnimeTorrent) => {
            const eps = r.infoHash ? episodesByHash.get(r.infoHash) : undefined
            return eps && eps.length > 0 ? eps : ["?"]
        }

        const best = new Map<string, number>()
        for (const r of results) {
            if (r.isBestRelease) continue
            const level = levelOf(r)
            if (level === undefined) continue
            for (const ep of episodesOf(r)) {
                const cur = best.get(ep)
                if (cur === undefined || level > cur) best.set(ep, level)
            }
        }

        return results.filter(r => {
            if (r.isBestRelease) return true
            const level = levelOf(r)
            if (level === undefined) return true
            return episodesOf(r).some(ep => {
                const top = best.get(ep)
                return top === undefined || top < 1 || level === top
            })
        })
    }

    private async fetchAllPages(params: string[]): Promise<NekoBTTorrent[]> {
        const all: NekoBTTorrent[] = []
        for (let page = 0; page < MAX_PAGES; page++) {
            const pageParams = page > 0 ? [...params, `offset=${page * PAGE_LIMIT}`] : params
            const res = await this.fetchSearch(pageParams)
            if (!res || !res.data || !Array.isArray(res.data.results)) break
            all.push(...res.data.results)
            if (!res.data.more) break
        }
        return all
    }

    private async fetchSearch(params: string[]): Promise<NekoBTSearchResponse | null> {
        return this.fetchJson<NekoBTSearchResponse>(`${API_URL}/torrents/search?${params.join("&")}`)
    }

    //+ ----------------------------------------------------------------------------------------------
    // nekoBT media resolution (AniList ID -> nekoBT media id + this entry's episode ids)
    //+ ----------------------------------------------------------------------------------------------

    private async getNekoMedia(media: Media): Promise<NekoMediaInfo | null> {
        const anilistId = media.id
        if (this.mediaCache.has(anilistId)) return this.mediaCache.get(anilistId)!

        const stored = this.cacheGet<CachedNekoMedia>(`nekobt:media:${anilistId}`)
        if (stored) {
            console.log(`nekoBT: Using cached media info for AniList ${anilistId}`)
            const cached = this.buildNekoMedia(stored)
            this.mediaCache.set(anilistId, cached)
            return cached
        }

        const missingKey = `nekobt:missing:${anilistId}`
        if (this.cacheGet<boolean>(missingKey)) {
            console.log(`nekoBT: AniList ${anilistId} is not on nekoBT (cached)`)
            return null
        }

        const meta: { status?: number } = {}
        const resolved = await this.fetchJson<NekoBTResolveResponse>(
            `${API_URL}/media/resolve?id=anilist-${anilistId}`,
            0,
            meta,
        )
        if (!resolved || resolved.error || !resolved.data || !resolved.data.media_id) {
            // Not mapped on nekoBT (yet): try to find the parent series (specials, mini anime).
            // Adult entries skip this, they are not side stories of a mapped series.
            let fb: NekoMediaInfo | null = null
            if (media.isAdult) {
                console.log(`nekoBT: AniList ${anilistId} is marked adult on AniList, skipping the title-based lookup`)
            } else {
                fb = await this.getFallbackNekoMedia(media)
            }
            if (fb) {
                this.mediaCache.set(anilistId, fb)
                this.persistNekoMedia(anilistId, fb, media)
            } else if (meta.status === 404) {
                // Only a real "not found" is remembered, never a network error or rate limit
                this.cacheSet(missingKey, true, MISSING_TTL_MS)
            }
            return fb
        }
        const mediaId = resolved.data.media_id

        const mediaRes = await this.fetchJson<NekoBTMediaResponse>(`${API_URL}/media/${mediaId}`)
        const allEpisodes = mediaRes?.data?.episodes ?? []
        // An AniList entry can have several mapping ranges (One Piece spans 24 seasons plus specials).
        // Only keep the episodes inside those ranges. This includes season 0 when the entry maps to specials.
        const mapped = (mediaRes?.data?.anilist?.entries ?? [])
            .filter(e => e.anilist_id === anilistId && e.season !== null && e.season !== undefined)
            .map(e => ({ ...e, media: undefined })) // entry.media (titles, tags, ...) is large and not needed later
        const episodes = mapped.length > 0 ? allEpisodes.filter(e => mapped.some(en => this.inEntry(e, en))) : []
        const useExternalId = mapped.length === 0 || episodes.length === 0

        const nekoMedia = this.buildNekoMedia({ fallback: false, mediaId, useExternalId, entries: mapped, episodes })
        this.mediaCache.set(anilistId, nekoMedia)
        this.persistNekoMedia(anilistId, nekoMedia, media)
        return nekoMedia
    }

    // nekoBT episode id -> AniList episode number is derived from the entry mapping
    private buildNekoMedia(d: CachedNekoMedia): NekoMediaInfo {
        const episodeNumberById = new Map<string, number>()
        if (!d.fallback) {
            for (const e of d.episodes) {
                const entry = d.entries.find(en => this.inEntry(e, en))
                const num = entry && !entry.ratio ? entry.dst_start + (e.episode - entry.src_start) : e.episode
                episodeNumberById.set(String(e.id), num)
            }
        }
        return { ...d, episodeNumberById }
    }

    private persistNekoMedia(anilistId: number, nekoMedia: NekoMediaInfo, media: Media) {
        const data: CachedNekoMedia = {
            fallback: nekoMedia.fallback,
            mediaId: nekoMedia.mediaId,
            useExternalId: nekoMedia.useExternalId,
            entries: nekoMedia.entries,
            episodes: nekoMedia.episodes,
        }
        const done = media.status === "FINISHED" || media.status === "CANCELLED"
        this.cacheSet(`nekobt:media:${anilistId}`, data, done ? FINISHED_TTL_MS : CACHE_TTL_MS)
    }

    //+ ----------------------------------------------------------------------------------------------
    // Cache. Seanime appears to create a fresh provider for every search, so plain class fields don't survive.
    // This uses Seanime's $store if the extension runtime provides one, and silently does nothing otherwise.
    //+ ----------------------------------------------------------------------------------------------

    private getStore(): any {
        try {
            const s = (globalThis as any).$store
            return s && typeof s.get === "function" && typeof s.set === "function" ? s : null
        } catch (e) {
            return null
        }
    }

    // Returns null when missing or expired. Expired entries are removed.
    private cacheGet<T>(key: string): T | null {
        try {
            const store = this.getStore()
            if (!store) return null
            const raw = store.get(key)
            if (!raw || typeof raw !== "string") return null
            const entry = JSON.parse(raw) as { exp: number, v: T }
            if (!entry) return null
            if (entry.exp && entry.exp < Date.now()) {
                if (typeof store.remove === "function") store.remove(key)
                return null
            }
            return entry.v
        } catch (e) {
            return null
        }
    }

    // ttlMs = null keeps the value until Seanime restarts or reloads the extension
    private cacheSet(key: string, value: unknown, ttlMs: number | null = CACHE_TTL_MS) {
        try {
            const store = this.getStore()
            if (!store) return
            store.set(key, JSON.stringify({ exp: ttlMs === null ? 0 : Date.now() + ttlMs, v: value }))
        } catch (e) {
        }
    }

    private inEntry(e: NekoBTEpisode, entry: NekoBTAnilistEntry): boolean {
        if (entry.season === null || entry.season === undefined) return false
        return e.season === entry.season &&
            e.episode >= entry.src_start &&
            (entry.src_end === null || entry.src_end === undefined || e.episode <= entry.src_end)
    }

    // Fallback for AniList entries nekoBT has no mapping for (e.g. a mini anime that only exists as an AniList side story).
    // 1. Search nekoBT media by the entry's titles (and progressively shortened romaji title).
    // 2. Accept a candidate only if its AniList relations list our AniList ID, which proves it is the parent series.
    // 3. Use every nekoBT episode that no AniList entry is mapped to (typically the season 0 specials).
    private async getFallbackNekoMedia(media: Media): Promise<NekoMediaInfo | null> {
        const queries: string[] = []
        const add = (q?: string) => {
            const c = (q || "").trim()
            if (c.length >= 3 && queries.indexOf(c) === -1) queries.push(c)
        }
        add(media.romajiTitle)
        add(media.englishTitle)
        const words = (media.romajiTitle || "").split(/\s+/).filter(Boolean)
        for (let n = words.length - 1; n >= Math.max(1, words.length - 2); n--) add(words.slice(0, n).join(" "))
        for (const s of media.synonyms || []) add(s)

        const checked = new Set<string>()
        let fetches = 0
        for (const q of queries.slice(0, 6)) {
            const search = await this.fetchJson<NekoBTMediaSearchResponse>(
                `${API_URL}/media/search?query=${encodeURIComponent(q)}&limit=5`,
            )
            for (const cand of (search?.data?.results ?? []).slice(0, 3)) {
                if (checked.has(cand.id)) continue
                if (fetches >= 8) return null // keep request count (rate limits) bounded
                checked.add(cand.id)
                fetches++

                const res = await this.fetchJson<NekoBTMediaResponse>(`${API_URL}/media/${cand.id}`)
                const anilist = res?.data?.anilist
                if (!anilist) continue

                const relations: NekoBTRelation[] = [
                    ...(anilist.relations ?? []),
                    ...(anilist.primary?.relations ?? []),
                    ...(anilist.entries ?? []).flatMap(e => e.media?.relations ?? []),
                ]
                if (!relations.some(r => r.id === media.id)) continue

                const entries = anilist.entries ?? []
                const orphans = (res?.data?.episodes ?? []).filter(e => !entries.some(en => this.inEntry(e, en)))
                if (orphans.length === 0) continue

                console.log(`nekoBT: AniList ${media.id} not mapped, using unmapped episodes of ${cand.id}`)
                return {
                    fallback: true,
                    mediaId: cand.id,
                    useExternalId: false,
                    entries: [],
                    episodes: orphans,
                    episodeNumberById: new Map<string, number>(),
                }
            }
        }
        return null
    }

    //+ ----------------------------------------------------------------------------------------------
    // Search query matching (Nyaa syntax), used for SeaDex releases
    //   foo bar      both words
    //   foo|bar      either word
    //   -foo         without the word (also -"foo bar" and -(foo|bar))
    //   "foo bar"    the exact phrase
    //   (foo bar)    grouping
    // Words that belong to the anime's own titles always count as matched, because every SeaDex release
    // is for this anime even when it is named differently ("ao no hako" vs "Blue Box").
    //+ ----------------------------------------------------------------------------------------------

    private queryTokens(s: string): string[] {
        return s.toLowerCase().replace(/['’`]/g, "").split(/[^0-9a-z\u00c0-\uffff]+/).filter(Boolean)
    }

    private tokenizeQuery(q: string): QueryToken[] {
        const out: QueryToken[] = []
        let i = 0
        while (i < q.length) {
            const c = q[i]
            if (/\s/.test(c)) {
                i++
            } else if (c === "\"") {
                const end = q.indexOf("\"", i + 1)
                out.push({ type: "phrase", value: end === -1 ? q.slice(i + 1) : q.slice(i + 1, end) })
                i = end === -1 ? q.length : end + 1
            } else if (c === "(" || c === ")" || c === "|") {
                out.push({ type: c, value: c })
                i++
            } else if (c === "-" && i + 1 < q.length && !/\s/.test(q[i + 1])) {
                out.push({ type: "-", value: c })
                i++
            } else {
                let j = i
                while (j < q.length && !/[\s"()|]/.test(q[j])) j++
                out.push({ type: "word", value: q.slice(i, j) })
                i = j
            }
        }
        return out
    }

    private parseQuery(q: string): QueryNode | null {
        const toks = this.tokenizeQuery(q)
        let pos = 0
        const parseUnary = (): QueryNode | null => {
            if (pos >= toks.length) return null
            const tk = toks[pos++]
            if (tk.type === "-") {
                const n = parseUnary()
                return n ? { kind: "not", item: n } : null
            }
            if (tk.type === "(") {
                const n = parseAnd()
                if (pos < toks.length && toks[pos].type === ")") pos++
                return n
            }
            if (tk.type === ")" || tk.type === "|") return null
            return { kind: "term", tokens: this.queryTokens(tk.value) }
        }
        const parseOr = (): QueryNode | null => {
            const items: QueryNode[] = []
            const first = parseUnary()
            if (first) items.push(first)
            while (pos < toks.length && toks[pos].type === "|") {
                pos++
                const n = parseUnary()
                if (n) items.push(n)
            }
            if (items.length === 0) return null
            return items.length === 1 ? items[0] : { kind: "or", items }
        }
        const parseAnd = (): QueryNode => {
            const items: QueryNode[] = []
            while (pos < toks.length && toks[pos].type !== ")") {
                const n = parseOr()
                if (n) items.push(n)
            }
            return { kind: "and", items }
        }

        const items: QueryNode[] = []
        while (pos < toks.length) {
            if (toks[pos].type === ")") {
                pos++
                continue
            }
            const n = parseOr()
            if (n) items.push(n)
        }
        return items.length > 0 ? { kind: "and", items } : null
    }

    // Returns null when there is no query (everything matches)
    private buildQueryMatcher(query: string | undefined, media: Media): ((name: string) => boolean) | null {
        const q = (query || "").trim()
        if (!q) return null
        const root = this.parseQuery(q)
        if (!root) return null

        const titles = [media.romajiTitle, media.englishTitle, ...(media.synonyms || [])]
            .filter((t): t is string => !!t)
            .map(t => this.queryTokens(t).join(" "))
        const titleWords = new Set(titles.join(" ").split(" ").filter(Boolean))

        return (name: string) => {
            const hay = " " + this.queryTokens(name).join(" ") + " "
            const evalNode = (n: QueryNode, allowTitle: boolean): boolean => {
                switch (n.kind) {
                    case "term": {
                        if (n.tokens.length === 0) return true
                        const phrase = n.tokens.join(" ")
                        if (hay.indexOf(" " + phrase + " ") !== -1) return true
                        if (!allowTitle) return false
                        return n.tokens.length === 1
                            ? titleWords.has(phrase)
                            : titles.some(t => (" " + t + " ").indexOf(" " + phrase + " ") !== -1)
                    }
                    case "and":
                        return n.items.every(i => evalNode(i, allowTitle))
                    case "or":
                        return n.items.some(i => evalNode(i, allowTitle))
                    case "not":
                        // A negated title word must really be absent from the name
                        return !evalNode(n.item, false)
                }
            }
            return evalNode(root, true)
        }
    }

    // AniList episode numbers contained in a release, from its video file names
    private releaseEpisodes(files: { name: string }[], nekoMedia: NekoMediaInfo | null, media: Media): Set<number> {
        const out = new Set<number>()
        for (const f of files) {
            if (!VIDEO_FILE.test(f.name)) continue
            const n = this.fileEpisode(f.name, nekoMedia, media)
            if (n > 0) out.add(n)
        }
        return out
    }

    // AniList episode number of one file, or -1 if unknown.
    // 1. "S10E01 (0337)": the bracketed number is the absolute episode, if it fits the AniList entry
    // 2. "S01E04": converted through nekoBT's season mapping for this AniList entry
    // 3. anything else ("Title - 0053"): parsed by habari
    private fileEpisode(name: string, nekoMedia: NekoMediaInfo | null, media: Media): number {
        const max = media.episodeCount && media.episodeCount > 0 ? media.episodeCount : Number.MAX_SAFE_INTEGER
        const abs = name.match(/S\d{1,2}E\d{1,4}\s*[(\[](\d{1,4})[)\]]/i)
        if (abs) {
            const n = parseInt(abs[1], 10)
            if (n >= 1 && n <= max) return n
        }
        const se = name.match(/S(\d{1,2})E(\d{1,4})/i)
        if (se) {
            const season = parseInt(se[1], 10)
            const ep = parseInt(se[2], 10)
            if (nekoMedia && !nekoMedia.fallback) {
                const probe: NekoBTEpisode = { id: 0, season, episode: ep }
                const entry = nekoMedia.entries.find(en => !en.ratio && this.inEntry(probe, en))
                if (entry) return entry.dst_start + (ep - entry.src_start)
            }
            return season === 1 ? ep : -1
        }
        return this.parseEpisodeFromName(name)
    }

    private parseEpisodeFromName(title: string): number {
        try {
            const data = $habari.parse(title) as any
            const raw = data?.episode_number
            const first = Array.isArray(raw) ? raw[0] : raw
            const n = parseInt(String(first ?? ""), 10)
            return isNaN(n) ? -1 : n
        } catch (e) {
            return -1
        }
    }

    // AniList episode number -> nekoBT episode
    private findEpisode(nekoMedia: NekoMediaInfo, anilistEpisode: number): NekoBTEpisode | null {
        for (const e of nekoMedia.episodes) {
            if (nekoMedia.episodeNumberById.get(String(e.id)) === anilistEpisode) return e
        }
        return null
    }

    //+ ----------------------------------------------------------------------------------------------
    // SeaDex (releases.moe) best releases
    //+ ----------------------------------------------------------------------------------------------

    // Every SeaDex release (best and alternative) with a usable info hash
    private async getSeaDexBest(anilistId: number): Promise<SeaDexTr[]> {
        const cached = this.bestCache.get(anilistId)
        if (cached) return cached
        const stored = this.cacheGet<SeaDexTr[]>(`nekobt:seadex2:${anilistId}`)
        if (stored) {
            console.log(`nekoBT: Using cached SeaDex releases for AniList ${anilistId}`)
            this.bestCache.set(anilistId, stored)
            return stored
        }

        const releases: SeaDexTr[] = []
        try {
            const filter = encodeURIComponent(`alID=${anilistId}`)
            const url = `${SEADEX_URL}?page=1&perPage=1&filter=${filter}&skipTotal=1&expand=trs`
            const data = await this.fetchJson<SeaDexRecordsResponse>(url)
            for (const tr of data?.items?.[0]?.expand?.trs ?? []) {
                if (!tr.infoHash || tr.infoHash === "<redacted>") continue
                releases.push({
                    infoHash: tr.infoHash,
                    isBest: tr.isBest,
                    url: tr.url,
                    groupedUrl: tr.groupedUrl,
                    releaseGroup: tr.releaseGroup,
                    dualAudio: tr.dualAudio,
                    created: tr.created,
                    files: (tr.files ?? []).map(f => ({ length: f.length, name: f.name })),
                })
            }
            if (data) {
                // A failed request (null) is not cached, an entry-less anime (empty list) is
                this.bestCache.set(anilistId, releases)
                this.cacheSet(`nekobt:seadex2:${anilistId}`, releases)
            }
        } catch (e) {
            console.warn("nekoBT: Could not fetch SeaDex releases: " + (e as Error).message)
        }
        return releases
    }

    // SeaDex links most releases to a Nyaa search ("groupedUrl"). The same search as RSS returns title, seeders,
    // leechers, downloads, size and info hash for every match, so one request replaces many page scrapes.
    // Releases not found this way fall back to scraping their own page.
    private async prefetchNyaaDetails(trs: SeaDexTr[]) {
        const groups = new Map<string, SeaDexTr[]>()
        for (const tr of trs) {
            const g = tr.groupedUrl || ""
            if (!/^https:\/\/nyaa\.si\//.test(g)) continue
            if (this.cacheGet<NyaaDetails>(`nekobt:nyaa:${tr.infoHash.toLowerCase()}`)) continue
            const list = groups.get(g) ?? []
            list.push(tr)
            groups.set(g, list)
        }

        let queries = 0
        for (const [url, list] of groups) {
            if (queries++ >= MAX_NYAA_RSS) break
            const rssUrl = this.toNyaaRssUrl(url)
            const items = await this.fetchNyaaRss(rssUrl)
            for (const tr of list) {
                const hash = tr.infoHash.toLowerCase()
                const d = items.get(hash)
                if (d) this.cacheSet(`nekobt:nyaa:${hash}`, d, null)
            }
        }
    }

    // "https://nyaa.si/?q=..." -> "https://nyaa.si/?page=rss&q=..."
    // "https://nyaa.si/user/NAME?q=..." -> "https://nyaa.si/?page=rss&q=...&u=NAME"
    private toNyaaRssUrl(url: string): string {
        const m = url.match(/^https:\/\/nyaa\.si\/(?:user\/([^/?#]+)\/?)?\??([^#]*)/)
        if (!m) return url
        const user = m[1]
        const query = (m[2] || "").split("&").filter(kv => kv && kv.indexOf("page=") !== 0).join("&")
        let out = "https://nyaa.si/?page=rss"
        if (query) out += "&" + query
        if (user) out += "&u=" + user
        return out
    }

    private async fetchNyaaRss(url: string): Promise<Map<string, NyaaDetails>> {
        const items = new Map<string, NyaaDetails>()
        try {
            const res = await fetch(url, { timeout: 8000 })
            if (!res.ok) {
                console.warn(`nekoBT: Nyaa RSS returned HTTP ${res.status}`)
                return items
            }
            const xml = await res.text()
            if (xml.indexOf("<rss") === -1) return items
            const itemRe = /<item>([\s\S]*?)<\/item>/g
            let m: RegExpExecArray | null
            while ((m = itemRe.exec(xml)) !== null) {
                const block = m[1]
                const get = (tag: string) => {
                    const r = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">"))
                    return r ? this.decodeXml(r[1].trim()) : ""
                }
                const hash = get("nyaa:infoHash").toLowerCase()
                if (!hash) continue
                const num = (s: string) => {
                    const n = parseInt(s, 10)
                    return isNaN(n) ? -1 : n
                }
                items.set(hash, {
                    name: get("title"),
                    seeders: num(get("nyaa:seeders")),
                    leechers: Math.max(0, num(get("nyaa:leechers"))),
                    downloads: Math.max(0, num(get("nyaa:downloads"))),
                    formattedSize: get("nyaa:size"),
                })
            }
        } catch (e) {
            console.warn("nekoBT: Nyaa RSS failed: " + (e as Error).message)
        }
        return items
    }

    private decodeXml(s: string): string {
        return s
            .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, "\"")
            .replace(/&#39;|&apos;/g, "'")
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
            .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/&amp;/g, "&")
    }

    // Runs fn over items, at most `limit` at a time
    private async mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
        const out: R[] = []
        for (let i = 0; i < items.length; i += limit) {
            const chunk = items.slice(i, i + limit)
            const res = await Promise.all(chunk.map((item, j) => fn(item, i + j)))
            for (const r of res) out.push(r)
        }
        return out
    }

    // Builds an AnimeTorrent for a SeaDex release. Single-file releases use their file name; batches use the Nyaa page title.
    private async getSeaDexTorrent(tr: SeaDexTr, media: Media, nekoMedia: NekoMediaInfo | null, scrape: boolean): Promise<AnimeTorrent> {
        const hash = tr.infoHash.toLowerCase()
        const files = tr.files ?? []
        const single = files.length === 1
        const size = files.reduce((sum, f) => sum + (f.length || 0), 0)
        const title = media.romajiTitle || media.englishTitle || "Unknown Title"
        let name = single
            ? files[0].name.replace(/\.[a-z0-9]{2,4}$/i, "")
            : `[${tr.releaseGroup || "SeaDex"}] ${title}${tr.dualAudio ? " [Dual-Audio]" : ""}`
        let seeders = -1
        let leechers = 0
        let downloads = 0
        let formattedSize = ""

        const detailsKey = `nekobt:nyaa:${hash}`
        const details = this.cacheGet<NyaaDetails>(detailsKey)
        if (details) {
            if (details.name) name = details.name
            seeders = details.seeders
            leechers = details.leechers
            downloads = details.downloads
            formattedSize = details.formattedSize
        } else if (scrape) {
            try {
                const res = await fetch(tr.url as string, { timeout: 5000 })
                if (res.ok) {
                    const $ = LoadDoc(await res.text())
                    const pageTitle = $("h3.panel-title").first().text().trim()
                    if (pageTitle) name = pageTitle
                    $(".panel-body .row div.col-md-1").each((i: number, el: any) => {
                        const label = el.text().trim()
                        const valueEl = el.next()
                        if (!valueEl) return
                        const value = valueEl.text().trim()
                        if (label === "Seeders:") seeders = parseInt(value) || -1
                        else if (label === "Leechers:") leechers = parseInt(value) || 0
                        else if (label === "Downloads:") downloads = parseInt(value) || 0
                        else if (label === "File size:") formattedSize = value
                    })
                    // Kept until Seanime restarts: the page belongs to an immutable info hash
                    this.cacheSet(detailsKey, { name: pageTitle || "", seeders, leechers, downloads, formattedSize }, null)
                }
            } catch (e) {
                console.warn("nekoBT: Failed to scrape Nyaa page for SeaDex release: " + (e as Error).message)
            }
        }

        name = `${tr.isBest !== false ? "[BEST]" : "[ALT]"} ${name}`
        let magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`
        for (const t of NYAA_TRACKERS) magnet += `&tr=${encodeURIComponent(t)}`

        const created = tr.created ? new Date(tr.created.replace(" ", "T")) : new Date()
        const torrent: AnimeTorrent = {
            name,
            date: isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
            size,
            formattedSize: formattedSize || this.formatBytes(size),
            seeders,
            leechers,
            downloadCount: downloads,
            link: `https://releases.moe/${media.id}/`,
            downloadUrl: "",
            magnetLink: magnet,
            infoHash: hash,
            resolution: this.detectResolution(name) || this.detectResolution(files[0]?.name || ""),
            isBatch: !single,
            episodeNumber: single ? this.fileEpisode(files[0].name, nekoMedia, media) : -1,
            releaseGroup: tr.releaseGroup || "",
            isBestRelease: true,
            confirmed: true,
        }
        return torrent
    }

    //+ ----------------------------------------------------------------------------------------------
    // Resolution filtering
    //+ ----------------------------------------------------------------------------------------------

    private bucketByWidth(width: number): string {
        if (width >= 3000) return "2160p"
        if (width >= 1800) return "1080p"
        if (width >= 1200) return "720p"
        if (width > 0) return "480p"
        return ""
    }

    // Returns e.g. "1080p" or "" when unknown
    private detectResolution(text: string): string {
        const l = (text || "").toLowerCase()
        const p = l.match(/(?:^|[^\d])(2160|1440|1080|720|576|480|360)p/)
        if (p) return p[1] + "p"
        if (/\b(4k|uhd)\b/.test(l)) return "2160p"
        const wh = l.match(/(\d{3,4})\s*x\s*(\d{3,4})/)
        if (wh) return this.bucketByWidth(parseInt(wh[1], 10))
        try {
            const habari = $habari.parse(text) as any
            if (habari && habari.video_resolution) {
                const r = String(habari.video_resolution)
                if (r !== text) {
                    const again = r.toLowerCase().match(/(\d{3,4})p/)
                    if (again) return again[1] + "p"
                    const wh2 = r.toLowerCase().match(/(\d{3,4})\s*x\s*(\d{3,4})/)
                    if (wh2) return this.bucketByWidth(parseInt(wh2[1], 10))
                }
            }
        } catch (e) {
        }
        return ""
    }

    // nekoBT's torrent info endpoint lists file names and (sometimes) a mediainfo report
    private async lookupResolution(t: AnimeTorrent): Promise<string> {
        const id = t.infoHash ? this.nekoIdByHash.get(t.infoHash) : undefined
        if (!id) return ""
        const key = `nekobt:res:${id}`
        const cached = this.cacheGet<string>(key)
        if (cached !== null) return cached

        let found = ""
        const res = await this.fetchJson<{ data?: NekoBTTorrentDetail }>(`${API_URL}/torrents/${id}`)
        if (!res) return ""
        const d = res?.data
        for (const f of d?.files ?? []) {
            found = this.detectResolution(f.name)
            if (found) break
        }
        if (!found && d?.mediainfo) {
            const w = d.mediainfo.match(/Width\s*:\s*([\d\s]+)\s*pixels/i)
            if (w) found = this.bucketByWidth(parseInt(w[1].replace(/\s/g, ""), 10))
        }
        this.cacheSet(key, found, null)
        return found
    }

    // Drops torrents whose resolution is known and different. Unknown ones are looked up on nekoBT (bounded), and kept if still unknown.
    private async filterByResolution(results: AnimeTorrent[], wanted?: string): Promise<AnimeTorrent[]> {
        if (!wanted) return results
        const w = wanted.toLowerCase()
        const digits = w.replace(/\D/g, "")
        const target = /4k|uhd/.test(w) ? "2160p" : digits ? digits + "p" : ""
        if (!target) return results

        let lookups = 0
        const kept: AnimeTorrent[] = []
        for (const r of results) {
            let res = r.resolution || ""
            if (!res && lookups < 15) {
                lookups++
                res = await this.lookupResolution(r)
                if (res) r.resolution = res
            }
            if (!res || res === target) kept.push(r)
        }
        return kept
    }

    //+ ----------------------------------------------------------------------------------------------
    // Subtitle languages in the torrent name
    //+ ----------------------------------------------------------------------------------------------

    private formatSubtitleLangs(t: NekoBTTorrent): string {
        if (this.getPref("subtitleLangs").toLowerCase() !== "true") return ""

        const codes = [...this.splitList(t.sub_lang || ""), ...this.splitList(t.fsub_lang || "")]
        const out: string[] = []
        for (const code of codes) {
            const base = code === "enm" ? "en" : code.split("-")[0]
            const lang = LANGUAGES.find(l => l[0] === base || l[1] === base)
            const label = lang ? lang[2] : base
            if (out.indexOf(label) === -1) out.push(label)
        }
        return out.length > 0 ? ` (${out.join(", ")})` : ""
    }

    //+ ----------------------------------------------------------------------------------------------
    // User config -> API filters
    //+ ----------------------------------------------------------------------------------------------

    private getPref(name: string): string {
        try {
            const v = $getUserPreference(name)
            return typeof v === "string" ? v.trim() : ""
        } catch (e) {
            return ""
        }
    }

    private splitList(value: string): string[] {
        return value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
    }

    // Accepts shorthand names or raw ids
    private mapIds(value: string, table: Record<string, number>): number[] {
        const ids: number[] = []
        for (const token of this.splitList(value)) {
            const key = token.replace(/[\s_]+/g, "-")
            let id: number | undefined = table[key]
            if (id === undefined && /^\d+$/.test(key)) id = parseInt(key, 10)
            if (id === undefined) {
                console.warn(`nekoBT: Unknown value in config: "${token}"`)
                continue
            }
            if (ids.indexOf(id) === -1) ids.push(id)
        }
        return ids
    }

    private triState(name: string, param: string, out: string[]) {
        const v = this.getPref(name).toLowerCase()
        if (v === "true" || v === "only") out.push(`${param}=true`)
        else if (v === "false" || v === "exclude") out.push(`${param}=false`)
    }

    private cleanLangList(value: string): string {
        return this.splitList(value).map(encodeURIComponent).join(",")
    }

    private buildUserFilters(): string[] {
        const out: string[] = []

        const codecs = this.mapIds(this.getPref("videoCodecs"), VIDEO_CODECS)
        if (codecs.length > 0) out.push(`video_codec=${codecs.join(",")}`)

        // Include list wins; otherwise exclusions are turned into an include list of everything else
        let types = this.mapIds(this.getPref("videoTypes"), VIDEO_TYPES)
        const excluded = this.mapIds(this.getPref("excludeVideoTypes"), VIDEO_TYPES)
        if (types.length > 0) {
            types = types.filter(t => excluded.indexOf(t) === -1)
        } else if (excluded.length > 0) {
            types = ALL_VIDEO_TYPE_IDS.filter(t => excluded.indexOf(t) === -1)
        }
        if (types.length > 0) out.push(`video_type=${types.join(",")}`)

        const audio = this.cleanLangList(this.getPref("audioLang"))
        if (audio) out.push(`audio_lang=${audio}`)

        const levels = this.splitList(this.getPref("levels")).filter(l => /^-?\d$/.test(l))
        if (levels.length > 0) out.push(`levels=${levels.join(",")}`)

        const fansub = this.cleanLangList(this.getPref("fansubLang"))
        if (fansub) out.push(`fansub_lang=${fansub}`)

        const sub = this.cleanLangList(this.getPref("subLang"))
        if (sub) out.push(`sub_lang=${sub}`)

        this.triState("otl", "otl", out)
        this.triState("mtl", "mtl", out)
        this.triState("hardsub", "hardsub", out)

        return out
    }

    //+ ----------------------------------------------------------------------------------------------
    // Helpers
    //+ ----------------------------------------------------------------------------------------------

    // Fetches JSON. On HTTP 429 it waits as long as the server asks (JSON `retry_after` in seconds, or the Cloudflare
    // `Retry-After` header) and retries, as long as the wait is reasonable. $sleep blocks, so the wait is capped.
    private async fetchJson<T>(url: string, attempt: number = 0, meta?: { status?: number }): Promise<T | null> {
        try {
            const res = await fetch(url)
            if (meta) meta.status = res.status
            if (res.status === 429) {
                const waitMs = await this.getRetryDelayMs(res)
                if (attempt < MAX_RATE_LIMIT_RETRIES && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
                    console.warn(`nekoBT: Rate limited, retrying in ${Math.round(waitMs / 1000)}s`)
                    $sleep(waitMs)
                    return await this.fetchJson<T>(url, attempt + 1, meta)
                }
                console.warn(`nekoBT: Rate limited (HTTP 429), not retrying (wait ${Math.round(waitMs / 1000)}s)`)
                return null
            }
            if (res.status === 404) {
                console.log(`nekoBT: Not found: ${url}`)
                return null
            }
            if (!res.ok) {
                console.error(`nekoBT: HTTP ${res.status} for ${url}`)
                return null
            }
            const json = await res.json() as any
            if (json && json.error === true) {
                console.error(`nekoBT: API error: ${json.message}`)
                return null
            }
            return json as T
        } catch (e) {
            console.error(`nekoBT: Fetch error: ${(e as Error).message}`)
            return null
        }
    }

    // nekoBT API limits answer with JSON { retry_after: seconds }, Cloudflare limits with a Retry-After header (seconds)
    private async getRetryDelayMs(res: any): Promise<number> {
        try {
            const body = JSON.parse(await res.text())
            const seconds = Number(body?.retry_after)
            if (!isNaN(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 250
        } catch (e) {
        }
        try {
            const h = res.headers
            const raw = h && typeof h.get === "function" ? h.get("retry-after") : h ? (h["retry-after"] ?? h["Retry-After"]) : undefined
            const seconds = Number(Array.isArray(raw) ? raw[0] : raw)
            if (!isNaN(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 250
        } catch (e) {
        }
        return 2000
    }

    private toNumber(v: unknown): number {
        if (typeof v === "number") return v
        const n = parseInt(String(v ?? "0"), 10)
        return isNaN(n) ? 0 : n
    }

    private toAnimeTorrent(t: NekoBTTorrent, nekoMedia: NekoMediaInfo | null): AnimeTorrent {
        const ts = this.toNumber(t.uploaded_at)
        const date = ts > 0 ? new Date(ts).toISOString() : new Date().toISOString()

        const title = (t.title || "Unknown") + this.formatSubtitleLangs(t)
        const resolution = this.detectResolution(t.title || "")

        // Episode info comes straight from the API's episode ids rather than title guessing
        const ids = (t.media_episode_ids || []).map(String)
        let isBatch = !!t.batch || ids.length > 1
        let episodeNumber = -1
        if (nekoMedia && !isBatch && ids.length === 1) {
            const n = nekoMedia.episodeNumberById.get(ids[0])
            if (n !== undefined) episodeNumber = n
        }
        if (nekoMedia && nekoMedia.fallback && !isBatch) episodeNumber = this.parseEpisodeFromName(t.title || "")

        const size = this.toNumber(t.filesize)

        return {
            name: title,
            date,
            size,
            formattedSize: this.formatBytes(size),
            seeders: this.toNumber(t.seeders),
            leechers: this.toNumber(t.leechers),
            downloadCount: this.toNumber(t.completed),
            link: t.id ? `https://nekobt.to/torrents/${t.id}` : "",
            magnetLink: t.magnet || undefined,
            downloadUrl: "",
            infoHash: t.infohash ? t.infohash.toLowerCase() : undefined,
            resolution,
            isBatch,
            episodeNumber,
            // Only the primary (uploading) group counts; secondary contributors must not be shown as the release group
            releaseGroup: (Array.isArray(t.groups) ? t.groups.find(g => g.uploading_group) : undefined)?.display_name ?? "",
            isBestRelease: false, // set from SeaDex only
            confirmed: nekoMedia !== null && !nekoMedia.fallback,
        }
    }

    private formatBytes(bytes: number, decimals: number = 2): string {
        if (!bytes || bytes <= 0) return "0 Bytes"
        const k = 1024
        const sizes = ["Bytes", "KB", "MB", "GB", "TB"]
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
        return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i]
    }
}