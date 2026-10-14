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
    // Nyaa torrent id when nekoBT imported this torrent from Nyaa, else null
    imported?: number | string | null
    // Upload time on Nyaa (ms) for imported torrents
    nyaa_upload_time?: number | string | null
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
    relation_type?: string // SEQUEL, PREQUEL, SIDE_STORY, ...
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

interface NekoBTAnilistInfo {
    entries?: NekoBTAnilistEntry[]
    relations?: NekoBTRelation[]
    primary?: { relations?: NekoBTRelation[] }
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

interface NekoBTMediaSearchResponse {
    error: boolean
    // `anilist` is null when nekoBT has no AniList mapping for the series, else the same object as on /media/<id>
    data?: { results?: { id: string, similarity?: number, year?: number, anilist?: NekoBTAnilistInfo | null }[] }
}

interface NekoMediaInfo {
    // true when the AniList ID did not resolve and we found the parent series through title search + AniList relations.
    // Then `episodes` are the nekoBT episodes that no AniList entry is mapped to (usually specials) and nekoBT gives us
    // no reliable AniList episode numbers for them.
    fallback: boolean
    mediaId: string
    // Every mapping range of this AniList entry (long series span many seasons)
    entries: NekoBTAnilistEntry[]
    episodes: NekoBTEpisode[]
    // Ids of every episode of the nekoBT media (not just this entry), to notice a stale cache
    allEpisodeIds?: string[]
    // true when this came from $store instead of a fresh fetch
    fromCache?: boolean
    // nekoBT has the series but no AniList mapping: search by the nekoBT media id instead of the AniList ID
    byMediaId?: boolean
    // nekoBT episode id -> AniList episode number
    episodeNumberById: Map<string, number>
}

// The parts of NekoMediaInfo that can be stored in $store (no Map)
interface CachedNekoMedia {
    fallback: boolean
    mediaId: string
    // Every mapping range of this AniList entry (long series span many seasons)
    entries: NekoBTAnilistEntry[]
    episodes: NekoBTEpisode[]
    allEpisodeIds?: string[]
    byMediaId?: boolean
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

// A nekoBT torrent that was imported from Nyaa. Its swarm on Nyaa is usually bigger than on nekoBT's tracker.
interface ImportedTorrent {
    hash: string
    nyaaId: string
    title: string
    group: string
}

// Details scraped from a Nyaa page. Keyed by info hash, so they never go stale (only seeders drift).
interface NyaaDetails {
    name: string
    // Nyaa upload time (ISO). Missing in entries cached by older versions.
    date?: string
    seeders: number
    leechers: number
    downloads: number
    formattedSize: string
}

// Parsed search query (Nyaa syntax)
type QueryNode =
    | { kind: "term", text: string, tokens: string[], quoted: boolean }
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

// How long SeaDex lists are reused (only if Seanime gives extensions a store, see cacheGet)
const CACHE_TTL_MS = 60 * 60 * 1000
// How long nekoBT media info is reused. nekoBT adds a season's episode ids all at once (padded to 12 when the
// count is unknown), and a stale cache is also noticed and refreshed, see searchMedia and collect.
const MEDIA_TTL_MS = 24 * 60 * 60 * 1000
// How long "this anime is not on nekoBT" is remembered
const MISSING_TTL_MS = 30 * 60 * 1000
// How long nekoBT torrent search results are reused. Seanime keeps its own search results for 30 minutes
// (its GcTime), so this costs no extra freshness: it only saves the request when a Seanime option that
// doesn't change our request changes, like the resolution dropdown.
const SEARCH_TTL_MS = 30 * 60 * 1000
// Sub level used for torrents nekoBT has no level for (lower than -1 = "no subs")
const UNKNOWN_LEVEL = -2
// nekoBT media search similarity (0-1) needed to accept a series nekoBT hasn't mapped to AniList
const UNMAPPED_MIN_SIMILARITY = 0.9
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

const NYAA_TRACKERS = [
    "http://nyaa.tracker.wf:7777/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.opentrackr.org:1337/announce",
]

// Nyaa pages scraped per search (the rest of the SeaDex releases are built from SeaDex's own data)
const MAX_SEADEX_SCRAPES = 12
// Nyaa pages scraped at the same time (Nyaa rate limits bursts)
const NYAA_CONCURRENCY = 3
// Nyaa pages read per search for imported nekoBT torrents the feed didn't contain
const MAX_IMPORTED_SCRAPES = 8
// Most distinct titles and group names put into the Nyaa feed query for imported torrents
const MAX_IMPORTED_TITLES = 6
const MAX_IMPORTED_GROUPS = 8
// Feed searches per lookup: each further round only asks for what the previous ones didn't return
const MAX_FEED_ROUNDS = 3
// More distinct episodes than this and the episode filter is left out of the feed query
const MAX_FEED_EPISODES = 20
// Nyaa RSS searches (SeaDex "grouped" search links) per search
const MAX_NYAA_RSS = 5
// How long a Nyaa feed counts as "already read" (releases found in it are kept until Seanime restarts)
const NYAA_FEED_TTL_MS = 24 * 60 * 60 * 1000

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

        // Seanime doesn't tell providers whether the magnet is for debrid or torrent streaming, so this is a manual switch
        const useUserkey = this.getPref("useUserkey").toLowerCase() === "true"
        const userkey = this.getPref("userkey")
        if (!useUserkey || !userkey) return magnet

        let cleanUserkey = userkey
        if (cleanUserkey.includes("/tracker/")) {
            const parts = cleanUserkey.split("/tracker/")
            if (parts.length > 1) cleanUserkey = parts[1].split("/")[0]
        }

        // A SeaDex release built from Nyaa data: if nekoBT has the same torrent, use nekoBT's magnet so the key can be added
        const nekoTracker = /tracker(\.|%2E)nekobt(\.|%2E)to/i
        if (!nekoTracker.test(magnet) && torrent.infoHash) {
            const nekoMagnet = await this.findNekoMagnet(torrent.infoHash)
            if (nekoMagnet) magnet = nekoMagnet
        }

        const trUrl = `https://tracker.nekobt.to/api/tracker/${cleanUserkey}/announce`
        const encodedTr = encodeURIComponent(trUrl)

        // Replace nekoBT's tracker URL (encoded or not) with the private one
        const regexEncoded = /tr=https%3A%2F%2Ftracker\.nekobt\.to%2Fapi%2Ftracker%2F[a-zA-Z0-9_-]+%2Fannounce/i
        const regexUnencoded = /tr=https:\/\/tracker\.nekobt\.to\/api\/tracker\/[a-zA-Z0-9_-]+\/announce/i

        // Only nekoBT magnets carry the nekoBT tracker. SeaDex releases from Nyaa don't, and never get the key.
        if (regexEncoded.test(magnet)) return magnet.replace(regexEncoded, `tr=${encodedTr}`)
        if (regexUnencoded.test(magnet)) return magnet.replace(regexUnencoded, `tr=${trUrl}`)
        return magnet
    }

    // nekoBT's magnet for an info hash, or "" when nekoBT doesn't have the torrent.
    // Searching a 40 character info hash makes nekoBT look up that torrent directly.
    private async findNekoMagnet(infoHash: string): Promise<string> {
        const hash = infoHash.toLowerCase()
        const res = await this.fetchJson<{ data?: { results?: NekoBTTorrent[], infohash_match?: string | null } }>(
            `${API_URL}/torrents/search?query=${hash}&limit=5`,
        )
        const hit = (res?.data?.results ?? []).find(t => (t.infohash || "").toLowerCase() === hash)
        if (hit?.magnet) return hit.magnet
        const id = res?.data?.infohash_match
        if (!id) return ""
        const detail = await this.fetchJson<{ data?: { magnet?: string, infohash?: string } }>(`${API_URL}/torrents/${id}`)
        return (detail?.data?.infohash || "").toLowerCase() === hash ? detail?.data?.magnet || "" : ""
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
        // Simple search is a plain text search (like Nyaa): no nekoBT media lookup, Seanime parses episode numbers itself
        const freeText = !!opts.freeText && (opts.query || "").trim().length > 0
        let [nekoMedia, seaDex] = await Promise.all([
            freeText ? Promise.resolve(null) : this.getNekoMedia(media),
            this.getSeaDexBest(media.id),
        ])
        if (!nekoMedia && !freeText) console.warn(`nekoBT: No nekoBT media found for AniList ID ${media.id}`)
        const wantedEp = opts.episodeNumber && opts.episodeNumber > 0 ? opts.episodeNumber : undefined

        // Cached media info that doesn't know the requested episode (an airing show got new episode ids): refetch once.
        // Not for episodes beyond a known episode count, those simply don't exist.
        const withinCount = !media.episodeCount || media.episodeCount <= 0 || (wantedEp ?? 0) <= media.episodeCount
        if (nekoMedia && nekoMedia.fromCache && !nekoMedia.fallback && nekoMedia.episodes.length > 0
            && wantedEp !== undefined && !opts.batch && withinCount && !this.findEpisode(nekoMedia, wantedEp)) {
            console.log(`nekoBT: Episode ${wantedEp} not in cached media info for AniList ${media.id}, refreshing`)
            this.forgetNekoMedia(media.id)
            nekoMedia = await this.getNekoMedia(media)
        }

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
                if (nekoMedia.fallback) {
                    // Specials without their own AniList mapping: the parent series' unmapped episodes
                    params.push(`media_id=${nekoMedia.mediaId}`)
                    const ids = nekoMedia.episodes.map(e => String(e.id))
                    if (ids.length > 0) {
                        params.push(`episode_ids=${ids.join(",")}`)
                        params.push("episode_match_any=true")
                    }
                } else {
                    // nekoBT narrows the AniList ID to this entry's episodes itself, also across several seasons
                    // or several nekoBT media. A single episode still needs its nekoBT episode id.
                    params.push(`media_id=${nekoMedia.byMediaId ? nekoMedia.mediaId : `anilist-${media.id}`}`)
                    const single = wantedEp !== undefined && !opts.batch ? this.findEpisode(nekoMedia, wantedEp) : null
                    if (single) {
                        params.push(`episode_ids=${single.id}`)
                        params.push("episode_match_any=true")
                    }
                }

                if (opts.batch === true) params.push("batch=true")
                else if (wantedEp !== undefined && !includeBatches) params.push("batch=false")
            }

            if (query) params.push(`query=${encodeURIComponent(query)}`)
            params.push(...this.buildUserFilters())

            const fetched = await this.fetchAllPages(params)

            // A torrent of this nekoBT media with an episode id the cached media info doesn't know: forget the cache
            if (nekoMedia && !nekoMedia.fallback && nekoMedia.fromCache && nekoMedia.allEpisodeIds) {
                const known = new Set(nekoMedia.allEpisodeIds)
                const stale = fetched.some(t => t.media_id === nekoMedia.mediaId
                    && (t.media_episode_ids || []).some(id => !known.has(String(id))))
                if (stale) {
                    console.log(`nekoBT: Cached media info for AniList ${media.id} is out of date, it will be refreshed`)
                    this.forgetNekoMedia(media.id)
                }
            }

            const imported: ImportedTorrent[] = []
            for (const t of fetched) {
                if (!t.infohash) continue
                const hash = t.infohash.toLowerCase()
                if (seen.has(hash)) continue
                seen.add(hash)
                if (t.id) this.nekoIdByHash.set(hash, t.id)
                // A missing sub level (null) ranks below every real level for "prefer fansubs"
                this.levelByHash.set(hash, typeof t.level === "number" ? t.level : UNKNOWN_LEVEL)
                episodesByHash.set(hash, (t.media_episode_ids || []).map(String))
                results.push(this.toAnimeTorrent(t, nekoMedia, !freeText))
                if (t.imported) {
                    const primary = (t.groups || []).find(g => g.uploading_group)
                    imported.push({ hash, nyaaId: String(t.imported), title: t.title || "", group: primary?.display_name || "" })
                }
            }

            // Imported torrents: bring seeders, leechers and downloads up to what Nyaa's swarm has
            if (imported.length > 0) await this.applyNyaaStats(results, imported, freeText ? null : media)

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
            const hasBestBatch = seaDex.some(tr => onNyaa(tr) && tr.isBest !== false && this.isSeaDexBatch(tr))

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
                const isBatch = this.isSeaDexBatch(tr)
                if (normallyShown(tr, isBatch)) return true
                if (alwaysShownBest(tr, isBatch)) {
                    injected.add(tr.infoHash.toLowerCase())
                    return true
                }
                return false
            })
            // One Nyaa RSS request per SeaDex search link covers many releases; only what's left is scraped
            await this.prefetchNyaaDetails(wanted, seaDex)
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
        // The key is the whole request, so any change to the query or your filters is a different entry
        const cacheKey = `nekobt:search:${params.join("&")}`
        const stored = this.cacheGet<NekoBTTorrent[]>(cacheKey)
        if (stored) {
            console.log("nekoBT: Using cached nekoBT search results")
            return stored
        }

        const all: NekoBTTorrent[] = []
        let complete = false
        for (let page = 0; page < MAX_PAGES; page++) {
            const pageParams = page > 0 ? [...params, `offset=${page * PAGE_LIMIT}`] : params
            const res = await this.fetchSearch(pageParams)
            if (!res || !res.data || !Array.isArray(res.data.results)) break
            all.push(...res.data.results)
            if (!res.data.more || page === MAX_PAGES - 1) {
                complete = true
                break
            }
        }

        // Only complete result sets are kept (never after a failed request), and only the fields we use
        if (complete) this.cacheSet(cacheKey, all.map(t => this.slimTorrent(t)), SEARCH_TTL_MS)
        return all
    }

    // The fields of a search result that are used later; the rest (descriptions, uploader details...) is dropped
    private slimTorrent(t: NekoBTTorrent): NekoBTTorrent {
        return {
            id: t.id,
            uploaded_at: t.uploaded_at,
            title: t.title,
            infohash: t.infohash,
            magnet: t.magnet,
            media_id: t.media_id,
            media_episode_ids: t.media_episode_ids,
            filesize: t.filesize,
            seeders: t.seeders,
            leechers: t.leechers,
            completed: t.completed,
            groups: (t.groups || []).map(g => ({
                id: g.id,
                display_name: g.display_name,
                name: g.name,
                uploading_group: g.uploading_group,
            })),
            batch: t.batch,
            level: t.level,
            imported: t.imported,
            nyaa_upload_time: t.nyaa_upload_time,
            audio_lang: t.audio_lang,
            sub_lang: t.sub_lang,
            fsub_lang: t.fsub_lang,
        }
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
            const cached = { ...this.buildNekoMedia(stored), fromCache: true }
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
                this.persistNekoMedia(anilistId, fb)
            } else if (meta.status === 404) {
                // Only a real "not found" is remembered, never a network error or rate limit
                this.cacheSet(missingKey, true, MISSING_TTL_MS)
            }
            return fb
        }
        let mediaId = resolved.data.media_id

        const mediaMeta: { status?: number } = {}
        let mediaRes = await this.fetchJson<NekoBTMediaResponse>(`${API_URL}/media/${mediaId}?force=true`, 0, mediaMeta)
        if (!mediaRes && mediaMeta.status === 404) {
            // resolve can point at a media that doesn't exist (seen with an AniList entry spread over two nekoBT media)
            const found = await this.discoverNekoMedia(anilistId, mediaId)
            if (found) {
                console.log(`nekoBT: resolve gave ${mediaId} for AniList ${anilistId}, which doesn't exist; using ${found.id} found through its torrents`)
                mediaId = found.id
                mediaRes = found.res
            }
        } else if (!mediaRes) {
            // Network error, rate limit, ...: use the AniList ID for this search, but don't remember the empty result
            return this.buildNekoMedia({ fallback: false, mediaId, entries: [], episodes: [] })
        }
        const allEpisodes = mediaRes?.data?.episodes ?? []
        // An AniList entry can have several mapping ranges (One Piece spans 24 seasons plus specials).
        // Only keep the episodes inside those ranges. This includes season 0 when the entry maps to specials.
        const mapped = (mediaRes?.data?.anilist?.entries ?? [])
            .filter(e => e.anilist_id === anilistId && e.season !== null && e.season !== undefined)
            .map(e => ({ ...e, media: undefined })) // entry.media (titles, tags, ...) is large and not needed later
        const episodes = mapped.length > 0 ? allEpisodes.filter(e => mapped.some(en => this.inEntry(e, en))) : []

        const allEpisodeIds = allEpisodes.map(e => String(e.id))
        const nekoMedia = this.buildNekoMedia({ fallback: false, mediaId, entries: mapped, episodes, allEpisodeIds })
        this.mediaCache.set(anilistId, nekoMedia)
        this.persistNekoMedia(anilistId, nekoMedia)
        return nekoMedia
    }

    // Finds the nekoBT media that really holds this AniList entry: search torrents by AniList ID (nekoBT expands it
    // server-side), then check the media ids of the results for a mapping to this AniList entry.
    private async discoverNekoMedia(anilistId: number, skipId: string): Promise<{ id: string, res: NekoBTMediaResponse } | null> {
        const search = await this.fetchSearch(["sort_by=best", "category=0", "limit=25", `media_id=anilist-${anilistId}`])
        const ids: string[] = []
        for (const t of search?.data?.results ?? []) {
            if (t.media_id && t.media_id !== skipId && ids.indexOf(t.media_id) === -1) ids.push(t.media_id)
        }
        for (const id of ids.slice(0, 3)) {
            const res = await this.fetchJson<NekoBTMediaResponse>(`${API_URL}/media/${id}?force=true`)
            const entries = res?.data?.anilist?.entries ?? []
            if (entries.some(e => e.anilist_id === anilistId)) return { id, res: res! }
        }
        return null
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

    private persistNekoMedia(anilistId: number, nekoMedia: NekoMediaInfo) {
        const data: CachedNekoMedia = {
            fallback: nekoMedia.fallback,
            mediaId: nekoMedia.mediaId,
            entries: nekoMedia.entries,
            episodes: nekoMedia.episodes,
            allEpisodeIds: nekoMedia.allEpisodeIds,
            byMediaId: nekoMedia.byMediaId,
        }
        this.cacheSet(`nekobt:media:${anilistId}`, data, MEDIA_TTL_MS)
    }

    private forgetNekoMedia(anilistId: number) {
        this.mediaCache.delete(anilistId)
        this.cacheRemove(`nekobt:media:${anilistId}`)
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

    private cacheRemove(key: string) {
        try {
            const store = this.getStore()
            if (store && typeof store.remove === "function") store.remove(key)
        } catch (e) {
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
                checked.add(cand.id)
                if (fetches >= 8) return null // keep request count (rate limits) bounded

                // nekoBT has the series, but without any AniList mapping (so resolve can't find it):
                // accept a (near) exact title match from about the same year
                const year = media.startDate?.year
                const sameYear = !year || !cand.year || Math.abs(cand.year - year) <= 1
                if (!cand.anilist) {
                    if ((cand.similarity ?? 0) < UNMAPPED_MIN_SIMILARITY || !sameYear) continue
                    fetches++
                    const res = await this.fetchJson<NekoBTMediaResponse>(`${API_URL}/media/${cand.id}?force=true`)
                    const unmapped = res ? this.unmappedNekoMedia(cand.id, res, media) : null
                    if (unmapped) {
                        console.log(`nekoBT: AniList ${media.id} isn't mapped on nekoBT, using ${cand.id} (title match "${q}")`)
                        return unmapped
                    }
                    continue
                }

                // Mapped series: the search result already carries its AniList relations, so a series is
                // only fetched once it lists our AniList entry as related
                const anilist = cand.anilist
                const relations: NekoBTRelation[] = [
                    ...(anilist.relations ?? []),
                    ...(anilist.primary?.relations ?? []),
                    ...(anilist.entries ?? []).flatMap(e => e.media?.relations ?? []),
                ]
                if (!relations.some(r => r.id === media.id)) continue

                fetches++
                const res = await this.fetchJson<NekoBTMediaResponse>(`${API_URL}/media/${cand.id}?force=true`)
                if (!res) continue
                const entries = res.data?.anilist?.entries ?? anilist.entries ?? []
                const allEpisodes = res.data?.episodes ?? []

                // A sequel or prequel of a mapped entry inside the same nekoBT season (Steel Ball Run 2nd & 3rd
                // STAGE continues 1st STAGE's season): its episodes are the ones right after (or before) that entry
                const neighbour = this.neighbourEntry(media, entries, allEpisodes)
                if (neighbour) {
                    console.log(`nekoBT: AniList ${media.id} not mapped, using ${cand.id} season ${neighbour.entry.season} episodes ${neighbour.entry.src_start}-${neighbour.entry.src_end ?? "end"}`)
                    return {
                        ...this.buildNekoMedia({
                            fallback: false,
                            mediaId: cand.id,
                            entries: [neighbour.entry],
                            episodes: neighbour.episodes,
                            allEpisodeIds: allEpisodes.map(e => String(e.id)),
                        }),
                        byMediaId: true,
                    }
                }

                const orphans = allEpisodes.filter(e => !entries.some(en => this.inEntry(e, en)))
                if (orphans.length === 0) continue

                console.log(`nekoBT: AniList ${media.id} not mapped, using unmapped episodes of ${cand.id}`)
                return {
                    fallback: true,
                    mediaId: cand.id,
                    entries: [],
                    episodes: orphans,
                    episodeNumberById: new Map<string, number>(),
                }
            }
        }
        return null
    }

    //+ ----------------------------------------------------------------------------------------------
    // Search query matching for SeaDex releases, modelled on Nyaa's search (search.py + es_mapping.yml)
    //   foo bar      both words
    //   foo|bar      either word
    //   -foo         without the word (also -"foo bar" and -(foo|bar))
    //   "foo bar"    this exact text anywhere in the name, case-insensitive ("S01" also finds S01E01,
    //                but "blue box" doesn't find Blue.Box, just like on Nyaa)
    //   +foo, foo*   same as foo
    //   (foo bar)    grouping
    // Plain words match the start of a word in the name, the way Nyaa indexes names: split on spaces and punctuation,
    // and also into parts at case changes ("BluRay" -> blu, ray), "_" and "."; numbers also match without leading
    // zeros ("53" finds 0053); "1920x1080" also gives 1920 and 1080.
    // Words that belong to the anime's own titles always count as matched, because every SeaDex release
    // is for this anime even when it is named differently ("ao no hako" vs "Blue Box").
    //+ ----------------------------------------------------------------------------------------------

    // Nyaa's character filter: "-" and "!" become "_", "_" becomes a space (one pass)
    private nyaaCharFilter(s: string): string {
        return s.replace(/[-!_]/g, c => (c === "_" ? " " : "_"))
    }

    // Approximation of Elasticsearch's standard tokenizer: words of letters/digits, joined by "_", "." or "'"
    private nyaaStandardTokens(s: string): string[] {
        return s.split(/[^0-9A-Za-z\u00c0-\uffff_.']+/).map(t => t.replace(/^[_.']+|[_.']+$/g, "")).filter(Boolean)
    }

    // The tokens Nyaa indexes for a name (before its prefix n-grams)
    private nyaaIndexTokens(name: string): string[] {
        const out = new Set<string>()
        const add = (t: string) => {
            const l = t.toLowerCase()
            if (!l) return
            out.add(l)
            if (/^\d+$/.test(l)) out.add(l.replace(/^0+(?=\d)/, ""))
        }
        for (const tok of this.nyaaStandardTokens(this.nyaaCharFilter(name))) {
            add(tok)
            const res = tok.match(/(\d+)[xX](\d+)/)
            if (res) {
                add(res[1])
                add(res[2])
            }
            for (const part of tok.split(/[_.']+/)) {
                add(part)
                for (const sub of part.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ")) add(sub)
            }
        }
        return [...out]
    }

    private nyaaQueryTokens(word: string): string[] {
        return this.nyaaStandardTokens(this.nyaaCharFilter(word.replace(/\*+$/, ""))).map(t => t.toLowerCase())
    }

    // Nyaa indexes prefixes of up to 15 characters; longer words must match whole
    private nyaaWordMatches(q: string, indexTokens: string[]): boolean {
        return indexTokens.some(t => (q.length <= 15 ? t.indexOf(q) === 0 : t === q))
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
            } else if (c === "+") {
                // "+" is AND, which is already the default between terms
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
            const quoted = tk.type === "phrase"
            return { kind: "term", text: tk.value.toLowerCase(), tokens: quoted ? [] : this.nyaaQueryTokens(tk.value), quoted }
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
        const titleRaw = titles.map(t => t.toLowerCase())
        const titleTokens = this.nyaaIndexTokens(titles.join(" "))

        return (name: string) => {
            const raw = name.toLowerCase()
            const tokens = this.nyaaIndexTokens(name)
            const evalNode = (n: QueryNode, allowTitle: boolean): boolean => {
                switch (n.kind) {
                    case "term": {
                        if (n.quoted) {
                            if (!n.text) return true
                            if (raw.indexOf(n.text) !== -1) return true
                            return allowTitle && titleRaw.some(t => t.indexOf(n.text) !== -1)
                        }
                        if (n.tokens.length === 0) return true
                        // Every token of the word has to match, in the name or (not when negated) in the anime's titles
                        return n.tokens.every(q => this.nyaaWordMatches(q, tokens) || (allowTitle && this.nyaaWordMatches(q, titleTokens)))
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
            for (const n of this.fileEpisodes(f.name, nekoMedia, media)) out.add(n)
        }
        return out
    }

    // AniList episode numbers of one file (several for "0487+0490"), empty if unknown. Uses habari:
    // 1. Its alternate number: "S10E01 (0337)" -> 337, the absolute episode, if it fits the AniList entry
    // 2. Season + episode: "S01E04" converted through nekoBT's season mapping for this AniList entry
    // 3. The plain episode number: "Title - 0053" -> 53
    private fileEpisodes(name: string, nekoMedia: NekoMediaInfo | null, media: Media): number[] {
        let h: any = null
        try {
            h = $habari.parse(name)
        } catch (e) {
            return []
        }
        const nums = (v: unknown): number[] => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v])
            .map(x => parseInt(String(x), 10))
            .filter(n => !isNaN(n) && n > 0)
        const max = media.episodeCount && media.episodeCount > 0 ? media.episodeCount : Number.MAX_SAFE_INTEGER

        // habari's "Episode Alt". The docs don't name this field, so look for it rather than guess one spelling.
        const altKey = h ? Object.keys(h).find(k => /episode/i.test(k) && /alt/i.test(k)) : undefined
        const alt = nums(altKey ? h[altKey] : undefined)
        if (alt.length > 0 && alt.every(n => n <= max)) return alt

        const eps = nums(h?.episode_number)
        const seasons = nums(h?.season_number)
        if (eps.length > 0 && seasons.length === 1) {
            const season = seasons[0]
            if (nekoMedia && !nekoMedia.fallback) {
                const mapped = eps.map(ep => {
                    const entry = nekoMedia.entries.find(en => !en.ratio && this.inEntry({ id: 0, season, episode: ep }, en))
                    return entry ? entry.dst_start + (ep - entry.src_start) : -1
                })
                if (mapped.every(n => n > 0)) return mapped
            }
            // Without a mapping only season 1 numbers can be trusted as AniList numbers
            return season === 1 ? eps : []
        }
        return eps
    }

    // For an unmapped AniList entry that is the SEQUEL (or PREQUEL) of a mapped entry: the unmapped episodes
    // directly after (or before) that entry in the same nekoBT season, numbered from 1. Returns null when that
    // range is empty or overlaps another mapped entry, so the caller falls back to all unmapped episodes.
    private neighbourEntry(media: Media, entries: NekoBTAnilistEntry[], episodes: NekoBTEpisode[]): { entry: NekoBTAnilistEntry, episodes: NekoBTEpisode[] } | null {
        const count = media.episodeCount && media.episodeCount > 0 ? media.episodeCount : 0
        for (const en of entries) {
            if (en.season === null || en.season === undefined || en.ratio) continue
            const rel = (en.media?.relations ?? []).find(r => r.id === media.id)
            if (!rel) continue

            let start: number
            let end: number | null
            if (rel.relation_type === "SEQUEL" && en.src_end !== null && en.src_end !== undefined) {
                start = en.src_end + 1
                end = count ? start + count - 1 : null
            } else if (rel.relation_type === "PREQUEL" && count) {
                end = en.src_start - 1
                start = end - count + 1
                if (start < 1) continue
            } else {
                continue
            }

            const entry: NekoBTAnilistEntry = {
                season: en.season, src_start: start, src_end: end, dst_start: 1, dst_end: count || null, ratio: null, anilist_id: media.id,
            }
            const covered = episodes.filter(e => this.inEntry(e, entry))
            if (covered.length === 0) continue
            if (covered.some(e => entries.some(other => this.inEntry(e, other)))) continue
            return { entry, episodes: covered }
        }
        return null
    }

    // A nekoBT series without AniList mapping. With one regular season, its episodes map 1:1 to the AniList
    // entry, so single-episode searches still work. With several seasons we can't tell which one this AniList
    // entry is, so the whole series is searched and episode numbers come from the torrent names.
    private unmappedNekoMedia(mediaId: string, res: NekoBTMediaResponse, media: Media): NekoMediaInfo | null {
        const all = res.data?.episodes ?? []
        const seasons = [...new Set(all.filter(e => e.season > 0).map(e => e.season))]
        const allEpisodeIds = all.map(e => String(e.id))
        if (seasons.length === 1) {
            const entry: NekoBTAnilistEntry = {
                season: seasons[0], src_start: 1, src_end: null, dst_start: 1, dst_end: null, ratio: null, anilist_id: media.id,
            }
            const episodes = all.filter(e => this.inEntry(e, entry))
            return { ...this.buildNekoMedia({ fallback: false, mediaId, entries: [entry], episodes, allEpisodeIds }), byMediaId: true }
        }
        return { fallback: true, mediaId, entries: [], episodes: [], allEpisodeIds, episodeNumberById: new Map<string, number>() }
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

    // A release with one video file is a single episode, even if it also ships a cover image or subtitles
    private isSeaDexBatch(tr: SeaDexTr): boolean {
        const files = tr.files ?? []
        const videos = files.filter(f => VIDEO_FILE.test(f.name)).length
        return videos > 0 ? videos !== 1 : files.length !== 1
    }

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
    private async prefetchNyaaDetails(trs: SeaDexTr[], allReleases: SeaDexTr[]) {
        const groups = new Map<string, SeaDexTr[]>()
        for (const tr of trs) {
            const g = tr.groupedUrl || ""
            if (!/^https:\/\/nyaa\.si\//.test(g)) continue
            if (this.cacheGet<NyaaDetails>(`nekobt:nyaa:${tr.infoHash.toLowerCase()}`)) continue
            // This search was already read recently; releases missing from it are scraped from their own page instead
            if (this.cacheGet<boolean>(`nekobt:rss:${g}`)) continue
            const list = groups.get(g) ?? []
            list.push(tr)
            groups.set(g, list)
        }

        // Every release of this anime found in a feed is stored, not just the ones this search needs,
        // so a later search (other episode, simple search) doesn't read the same feed again
        const known = new Set(allReleases.map(tr => tr.infoHash.toLowerCase()))
        let queries = 0
        for (const url of groups.keys()) {
            if (queries++ >= MAX_NYAA_RSS) break
            const items = await this.fetchNyaaRss(this.toNyaaRssUrl(url))
            if (items.size === 0) continue // failed or empty: try again next time
            for (const [hash, d] of items) {
                if (known.has(hash)) this.cacheSet(`nekobt:nyaa:${hash}`, d, null)
            }
            this.cacheSet(`nekobt:rss:${url}`, true, NYAA_FEED_TTL_MS)
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

    // Reads seeders, leechers, downloads, size and upload time from a Nyaa torrent page
    private async scrapeNyaaPage(url: string): Promise<NyaaDetails | null> {
        if (!/^https:\/\/nyaa\.si\//.test(url)) return null
        try {
            const res = await fetch(url, { timeout: 5000 })
            if (!res.ok) return null
            const $ = LoadDoc(await res.text())
            const details: NyaaDetails = {
                name: $("h3.panel-title").first().text().trim(),
                seeders: -1,
                leechers: 0,
                downloads: 0,
                formattedSize: "",
            }
            $(".panel-body .row div.col-md-1").each((i: number, el: any) => {
                const label = el.text().trim()
                const valueEl = el.next()
                if (!valueEl) return
                const value = valueEl.text().trim()
                const n = parseInt(value, 10)
                if (label === "Seeders:") details.seeders = isNaN(n) ? -1 : n
                else if (label === "Leechers:") details.leechers = isNaN(n) ? 0 : n
                else if (label === "Downloads:") details.downloads = isNaN(n) ? 0 : n
                else if (label === "File size:") details.formattedSize = value
                else if (label === "Date:") {
                    const ts = parseInt(String(valueEl.attr("data-timestamp") || ""), 10)
                    if (!isNaN(ts) && ts > 0) details.date = new Date(ts * 1000).toISOString()
                }
            })
            return details
        } catch (e) {
            console.warn("nekoBT: Failed to read Nyaa page: " + (e as Error).message)
            return null
        }
    }

    // Seeders, leechers and downloads of torrents nekoBT imported from Nyaa, taken from Nyaa. nekoBT only counts peers
    // of its own tracker, and nekoBT's magnets list Nyaa's trackers too, so the larger number is used, not the sum.
    //  - one torrent to look up: its Nyaa page is read
    //  - several: ONE Nyaa feed search of the form ((title)|(title)) (Group|Group) returns most of them at once;
    //    what the feed didn't contain is read page by page, a few at a time
    private async applyNyaaStats(results: AnimeTorrent[], imported: ImportedTorrent[], media: Media | null) {
        const detailsOf = (hash: string) => this.cacheGet<NyaaDetails>(`nekobt:nyaa:${hash}`)
        const missing = imported.filter(i => !detailsOf(i.hash))

        if (missing.length === 1) {
            const d = await this.scrapeNyaaPage(`https://nyaa.si/view/${missing[0].nyaaId}`)
            if (d) this.cacheSet(`nekobt:nyaa:${missing[0].hash}`, d, null)
        } else if (missing.length > 1) {
            // Round 1 asks for everything. A feed holds only the latest ~75 matches, so when some torrents are
            // missing from it the query is repeated for just those: their groups, titles, episodes and resolutions,
            // without what is already cached. Further rounds only use titles read from the torrent names.
            let remaining = missing
            for (let round = 0; round < MAX_FEED_ROUNDS && remaining.length > 1; round++) {
                const url = this.buildImportedFeedUrl(remaining, round === 0 ? media : null)
                if (!url || this.cacheGet<boolean>(`nekobt:rss:${url}`)) break
                const items = await this.fetchNyaaRss(url)
                if (items.size === 0) break
                this.cacheSet(`nekobt:rss:${url}`, true, CACHE_TTL_MS)
                let found = 0
                for (const i of remaining) {
                    const d = items.get(i.hash)
                    if (d) {
                        this.cacheSet(`nekobt:nyaa:${i.hash}`, d, null)
                        found++
                    }
                }
                remaining = remaining.filter(i => !detailsOf(i.hash))
                if (found === 0) break
            }
            const left = missing.filter(i => !detailsOf(i.hash)).slice(0, MAX_IMPORTED_SCRAPES)
            await this.mapLimited(left, NYAA_CONCURRENCY, async i => {
                const d = await this.scrapeNyaaPage(`https://nyaa.si/view/${i.nyaaId}`)
                if (d) this.cacheSet(`nekobt:nyaa:${i.hash}`, d, null)
            })
        }

        const byHash = new Map<string, AnimeTorrent>()
        for (const r of results) if (r.infoHash) byHash.set(r.infoHash, r)
        for (const i of imported) {
            const d = detailsOf(i.hash)
            const r = byHash.get(i.hash)
            if (!d || !r) continue
            r.seeders = Math.max(r.seeders, d.seeders)
            r.leechers = Math.max(r.leechers, d.leechers)
            r.downloadCount = Math.max(r.downloadCount, d.downloads)
        }
    }

    // What a torrent name says, for the feed query. The title comes from habari, so it matches the name by construction.
    private parseImported(i: ImportedTorrent): { title: string, group: string, season: number, episode: number, resolution: string } {
        let h: any = null
        try {
            h = $habari.parse(i.title)
        } catch (e) {
        }
        const num = (v: unknown): number[] => (Array.isArray(v) ? v : []).map(x => parseInt(String(x), 10)).filter(n => !isNaN(n) && n >= 0)
        const eps = num(h?.episode_number)
        const seasons = num(h?.season_number)
        const res = this.detectResolution(i.title).replace(/\D/g, "")
        return {
            title: String(h?.title || ""),
            group: String(h?.release_group || ""),
            season: seasons.length === 1 ? seasons[0] : 1,
            episode: eps.length === 1 ? eps[0] : -1, // a batch (or no number at all) can't be narrowed by episode
            resolution: res,
        }
    }

    // Builds the Nyaa feed search for imported torrents:
    //   ((Title)|(Other Title)) ((Group)|(Group Two)) (01|E01|EP01|EP1|S01E01|...) (720|1080)
    // Blocks are joined by spaces, which is AND. Every title and group is wrapped in its own parentheses so names
    // with spaces stay together. Titles: the anime's (smart search only) plus the ones read from the torrent names.
    // The episode and resolution blocks are only added when EVERY torrent has one, otherwise they would hide it.
    private buildImportedFeedUrl(list: ImportedTorrent[], media: Media | null): string {
        // Characters with a meaning in Nyaa's search syntax would change the query. A hyphen inside a word
        // ("Erai-raws") stays, because Nyaa indexes it as part of the word.
        const clean = (s: string) => {
            const t = s.replace(/[+|"()*~!&:.,'\u2019\[\]{}_]/g, " ")
            let out = ""
            for (let k = 0; k < t.length; k++) {
                const c = t[k]
                const inWord = c === "-" && /[A-Za-z0-9]/.test(t[k - 1] || "") && /[A-Za-z0-9]/.test(t[k + 1] || "")
                out += c === "-" && !inWord ? " " : c
            }
            return out.replace(/\s+/g, " ").trim()
        }
        const titles: string[] = []
        const addTitle = (s?: string) => {
            const c = clean(s || "").split(" ").slice(0, 6).join(" ")
            // Titles in other scripts don't appear in torrent names
            if ((c.match(/[A-Za-z]/g) || []).length < 3) return
            if (titles.every(t => t.toLowerCase() !== c.toLowerCase())) titles.push(c)
        }
        const groups: string[] = []
        const addGroup = (s?: string) => {
            const c = clean(s || "")
            if (c.length >= 2 && groups.every(g => g.toLowerCase() !== c.toLowerCase())) groups.push(c)
        }

        if (media) {
            addTitle(media.romajiTitle)
            addTitle(media.englishTitle)
            for (const s of media.synonyms || []) addTitle(s)
        }
        const parsed = list.map(i => this.parseImported(i))
        parsed.forEach((pi, k) => {
            addTitle(pi.title)
            addGroup(pi.group)
            addGroup(list[k].group)
        })
        if (titles.length === 0) return ""

        const block = (items: string[]) => `(${items.map(x => `(${x})`).join("|")})`
        const parts: string[] = [block(titles.slice(0, MAX_IMPORTED_TITLES))]
        if (groups.length > 0) parts.push(block(groups.slice(0, MAX_IMPORTED_GROUPS)))

        // Episode numbers, in the spellings names use
        if (parsed.every(pi => pi.episode >= 0)) {
            const pairs = new Map<string, { season: number, episode: number }>()
            for (const pi of parsed) pairs.set(`${pi.season}x${pi.episode}`, { season: pi.season, episode: pi.episode })
            if (pairs.size <= MAX_FEED_EPISODES) {
                const variants: string[] = []
                const add = (v: string) => {
                    if (variants.indexOf(v) === -1) variants.push(v)
                }
                for (const { season, episode } of pairs.values()) {
                    const ee = episode < 10 ? `0${episode}` : String(episode)
                    const ss = season < 10 ? `0${season}` : String(season)
                    add(ee)
                    add(`E${ee}`)
                    add(`EP${ee}`)
                    add(`EP${episode}`)
                    add(`S${ss}E${ee}`)
                }
                parts.push(`(${variants.join("|")})`)
            }
        }

        // Resolutions
        if (parsed.every(pi => pi.resolution !== "")) {
            const resolutions: string[] = []
            for (const pi of parsed) if (resolutions.indexOf(pi.resolution) === -1) resolutions.push(pi.resolution)
            parts.push(`(${resolutions.join("|")})`)
        }

        return `https://nyaa.si/?page=rss&q=${encodeURIComponent(parts.join(" "))}&c=0_0&f=0`
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
                    date: this.parseRssDate(get("pubDate")),
                })
            }
        } catch (e) {
            console.warn("nekoBT: Nyaa RSS failed: " + (e as Error).message)
        }
        return items
    }

    // "Mon, 05 Oct 2026 15:40:52 -0000" -> ISO, or undefined. Parsed by hand, the engine's Date parsing of this format isn't guaranteed.
    private parseRssDate(s: string): string | undefined {
        const m = s.match(/(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2})(?: ([+-])(\d{2})(\d{2}))?/)
        if (!m) return undefined
        const month = "JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(m[2]) / 3
        let ms = Date.UTC(parseInt(m[3], 10), month, parseInt(m[1], 10), parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10))
        if (m[7]) ms -= (m[7] === "-" ? -1 : 1) * (parseInt(m[8], 10) * 60 + parseInt(m[9], 10)) * 60000
        return isNaN(ms) ? undefined : new Date(ms).toISOString()
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
        const single = !this.isSeaDexBatch(tr)
        const videos = files.filter(f => VIDEO_FILE.test(f.name))
        const mainFile = videos.length === 1 ? videos[0] : files[0]
        const size = files.reduce((sum, f) => sum + (f.length || 0), 0)
        const title = media.romajiTitle || media.englishTitle || "Unknown Title"
        let name = single
            ? mainFile.name.replace(/\.[a-z0-9]{2,4}$/i, "")
            : `[${tr.releaseGroup || "SeaDex"}] ${title}${tr.dualAudio ? " [Dual-Audio]" : ""}`
        let seeders = -1
        let leechers = 0
        let downloads = 0
        let formattedSize = ""
        let uploaded: string | undefined

        const detailsKey = `nekobt:nyaa:${hash}`
        const details = this.cacheGet<NyaaDetails>(detailsKey)
        if (details) {
            if (details.name) name = details.name
            seeders = details.seeders
            leechers = details.leechers
            downloads = details.downloads
            formattedSize = details.formattedSize
            uploaded = details.date
        } else if (scrape) {
            const scraped = await this.scrapeNyaaPage(tr.url as string)
            if (scraped) {
                this.cacheSet(detailsKey, scraped, null) // kept until Seanime restarts: the page belongs to an immutable info hash
                if (scraped.name) name = scraped.name
                seeders = scraped.seeders
                leechers = scraped.leechers
                downloads = scraped.downloads
                formattedSize = scraped.formattedSize
                uploaded = scraped.date
            }
        }

        let magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`
        name = `${tr.isBest !== false ? "[BEST]" : "[ALT]"} ${name}`
        for (const t of NYAA_TRACKERS) magnet += `&tr=${encodeURIComponent(t)}`

        // Nyaa's upload time. SeaDex's `created` is only when the release was added to SeaDex, the last resort.
        const created = new Date(uploaded || (tr.created ? tr.created.replace(" ", "T") : Date.now()))
        const torrent: AnimeTorrent = {
            name,
            date: isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
            size,
            formattedSize: formattedSize || this.formatBytes(size),
            seeders,
            leechers,
            downloadCount: downloads,
            link: tr.url as string, // the release's Nyaa page
            downloadUrl: "",
            magnetLink: magnet,
            infoHash: hash,
            resolution: this.detectResolution(name) || this.detectResolution(mainFile?.name || ""),
            isBatch: !single,
            episodeNumber: single && mainFile ? (this.fileEpisodes(mainFile.name, nekoMedia, media)[0] ?? -1) : -1,
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
            const r = String(habari?.video_resolution || "").toLowerCase()
            const again = r.match(/(\d{3,4})p/)
            if (again) return again[1] + "p"
            const wh2 = r.match(/(\d{3,4})\s*x\s*(\d{3,4})/)
            if (wh2) return this.bucketByWidth(parseInt(wh2[1], 10))
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
            const lookupable = !!r.infoHash && this.nekoIdByHash.has(r.infoHash)
            if (!res && lookupable && lookups < 15) {
                lookups++
                res = await this.lookupResolution(r)
                if (res) r.resolution = res
            }
            if (!res || res === target) kept.push(r)
        }
        return kept
    }

    // "Append subtitle languages": nekoBT's own codes for official and fansub subtitles, e.g. " (en, enm, es-419)"
    private formatSubtitleLangs(t: NekoBTTorrent): string {
        if (this.getPref("subtitleLangs").toLowerCase() !== "true") return ""
        const codes: string[] = []
        for (const code of [...this.splitList(t.sub_lang || ""), ...this.splitList(t.fsub_lang || "")]) {
            if (codes.indexOf(code) === -1) codes.push(code)
        }
        return codes.length > 0 ? ` (${codes.join(", ")})` : ""
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

    // `scoped`: the search was limited to this anime, so every result belongs to it
    private toAnimeTorrent(t: NekoBTTorrent, nekoMedia: NekoMediaInfo | null, scoped: boolean = false): AnimeTorrent {
        // Imported torrents keep their original Nyaa upload time, uploaded_at is when nekoBT imported them
        const nyaaTs = this.toNumber(t.nyaa_upload_time)
        const ts = nyaaTs > 0 ? nyaaTs : this.toNumber(t.uploaded_at)
        const date = ts > 0 ? new Date(ts).toISOString() : new Date().toISOString()

        const title = (t.title || "Unknown") + this.formatSubtitleLangs(t)
        const resolution = this.detectResolution(t.title || "")

        // Episode info comes straight from the API's episode ids rather than title guessing
        const ids = (t.media_episode_ids || []).map(String)
        const isBatch = !!t.batch || ids.length > 1
        let episodeNumber = -1
        if (nekoMedia && !isBatch && ids.length === 1) {
            const n = nekoMedia.episodeNumberById.get(ids[0])
            if (n !== undefined) episodeNumber = n
        }
        if (nekoMedia && nekoMedia.fallback && !isBatch) episodeNumber = this.parseEpisodeFromName(t.title || "")
        // No mapping (simple search, unmapped anime): parse the name like Seanime would. Seanime's torrent list keeps
        // a -1 as is instead of parsing it, so a single episode left at -1 would never get its episode thumbnail.
        if (episodeNumber === -1 && !isBatch) episodeNumber = this.parseEpisodeFromName(t.title || "")

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
            confirmed: !!nekoMedia && !nekoMedia.fallback
                && (scoped || ids.some(id => nekoMedia.episodeNumberById.has(id))),
        }
    }

    // Seanime shows no size when formattedSize is empty, so format it here, in the same units as Nyaa ("3.7 GiB")
    private formatBytes(bytes: number): string {
        if (!bytes || bytes <= 0) return ""
        const units = ["B", "KiB", "MiB", "GiB", "TiB"]
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
        const value = bytes / Math.pow(1024, i)
        return (i === 0 ? String(bytes) : value.toFixed(1)) + " " + units[i]
    }
}