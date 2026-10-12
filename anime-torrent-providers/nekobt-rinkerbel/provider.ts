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
    level?: number
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

interface MediaContext {
    // true when the AniList ID did not resolve and we found the parent series through title search + AniList relations.
    // Then `episodes` are the nekoBT episodes that no AniList entry is mapped to (usually specials) and nekoBT gives us
    // no reliable AniList episode numbers for them.
    fallback: boolean
    mediaId: string
    // true when we could not map this AniList entry to specific nekoBT episodes (movies, unmapped entries).
    // In that case the search uses media_id=anilist-<id> and lets nekoBT narrow to the entry's episodes.
    useExternalId: boolean
    entry: NekoBTAnilistEntry | null
    episodes: NekoBTEpisode[]
    // nekoBT episode id -> AniList episode number
    episodeNumberById: Map<string, number>
}

interface SeaDexTr {
    infoHash: string
    isBest?: boolean
    url?: string
    releaseGroup?: string
    dualAudio?: boolean
    created?: string
    files?: { length: number, name: string }[]
}

interface SeaDexRecordsResponse {
    items?: { expand?: { trs?: SeaDexTr[] } }[]
}

//+ --------------------------------------------------------------------------------------------------
// Constants
//+ --------------------------------------------------------------------------------------------------

const API_URL = "https://nekobt.to/api/v1"
const SEADEX_URL = "https://releases.moe/api/collections/entries/records"
const PAGE_LIMIT = 50
const MAX_PAGES = 5

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

const ALL_VIDEO_TYPE_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16]

//+ --------------------------------------------------------------------------------------------------
// Provider
//+ --------------------------------------------------------------------------------------------------

class Provider {
    private mediaCache: Map<number, MediaContext | null> = new Map()
    private bestCache: Map<number, SeaDexTr[]> = new Map()
    private seaDexTorrentCache: Map<string, { torrent: AnimeTorrent, scraped: boolean }> = new Map()
    private levelByHash: Map<string, number> = new Map()
    private resolutionCache: Map<string, string> = new Map()
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
            return await this.searchMedia(opts.media, { query: opts.query })
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
        const useUserkey = this.getPref("useUserkey").toLowerCase() !== "false"
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
            resolution?: string
        },
    ): Promise<AnimeTorrent[]> {
        const ctx = await this.getMediaContext(media)
        if (!ctx) console.warn(`nekoBT: No nekoBT media found for AniList ID ${media.id}`)

        const seaDex = await this.getSeaDexBest(media.id)
        const wantedEp = opts.episodeNumber && opts.episodeNumber > 0 ? opts.episodeNumber : undefined

        let results = await this.collect(media, ctx, seaDex, opts, wantedEp, false)

        // Nothing without batches (e.g. older seasons only released as batches): include batches anyway
        if (results.length === 0 && opts.batch !== true && wantedEp !== undefined) {
            results = await this.collect(media, ctx, seaDex, opts, wantedEp, true)
        }
        return results
    }

    private async collect(
        media: Media,
        ctx: MediaContext | null,
        seaDex: SeaDexTr[],
        opts: { query?: string, batch?: boolean, resolution?: string },
        wantedEp: number | undefined,
        includeBatches: boolean,
    ): Promise<AnimeTorrent[]> {
        const results: AnimeTorrent[] = []
        const seen = new Set<string>()

        // ---- nekoBT
        if (ctx) {
            const params: string[] = [
                "sort_by=best",
                "category=0",
                `limit=${PAGE_LIMIT}`,
                `media_id=${ctx.useExternalId ? `anilist-${media.id}` : ctx.mediaId}`,
                "upgraded=false",
            ]

            // Without episode_match_any the API only returns torrents containing ALL listed episodes,
            // so it is always enabled and `batch` decides between packs and single episodes.
            let episodeIds: string[] = ctx.episodes.map(e => String(e.id))
            if (wantedEp !== undefined && !opts.batch) {
                const single = this.findEpisode(ctx, wantedEp)
                if (single) episodeIds = [String(single.id)]
            }
            if (episodeIds.length > 0) {
                params.push(`episode_ids=${episodeIds.join(",")}`)
                params.push("episode_match_any=true")
            }

            if (opts.batch === true) params.push("batch=true")
            else if (wantedEp !== undefined && !includeBatches) params.push("batch=false")

            const query = (opts.query || "").trim()
            if (query) params.push(`query=${encodeURIComponent(query)}`)
            params.push(...this.buildUserFilters())

            for (const t of await this.fetchAllPages(params)) {
                if (!t.infohash) continue
                const hash = t.infohash.toLowerCase()
                if (seen.has(hash)) continue
                seen.add(hash)
                if (t.id) this.nekoIdByHash.set(hash, t.id)
                if (typeof t.level === "number") this.levelByHash.set(hash, t.level)
                results.push(this.toAnimeTorrent(t, ctx))
            }

            // Fallback mode has no episode mapping: select the episode from the torrent name instead
            if (ctx.fallback && wantedEp !== undefined && !opts.batch) {
                for (let i = results.length - 1; i >= 0; i--) {
                    const n = results[i].episodeNumber
                    if (n !== -1 && n !== wantedEp) results.splice(i, 1)
                }
            }
        }

        const pull = this.getPref("pullSeaDex").toLowerCase() !== "false"

        // ---- SeaDex releases nekoBT doesn't have (Nyaa only). Filtered by batch/episode BEFORE any Nyaa page is scraped.
        if (pull) {
            const wanted = seaDex.filter(tr => {
                if (!tr.url || !/^https:\/\/nyaa\.si\//.test(tr.url)) return false
                if (seen.has(tr.infoHash.toLowerCase())) return false
                const files = tr.files ?? []
                const isBatch = files.length !== 1
                if (opts.batch === true) return isBatch
                if (wantedEp !== undefined && !isBatch) {
                    const n = this.parseEpisodeFromName(files[0].name)
                    return n === -1 || n === wantedEp
                }
                return true
            })
            const built = await Promise.all(wanted.map((tr, i) => this.getSeaDexTorrent(tr, media, i < MAX_SEADEX_SCRAPES)))
            for (const t of built) {
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
        return this.applyFansubPreference(filtered)
    }

    // "Prefer fansubs": keep only the highest fansub level present (L3, else L2, else L1), else everything.
    // SeaDex-tagged releases are never removed. Levels are measured on the non-SeaDex results.
    private applyFansubPreference(results: AnimeTorrent[]): AnimeTorrent[] {
        if (this.getPref("preferFansubs").toLowerCase() !== "true") return results
        const levelOf = (r: AnimeTorrent) => (r.infoHash ? this.levelByHash.get(r.infoHash) : undefined)
        for (const tier of [3, 2, 1]) {
            if (results.some(r => !r.isBestRelease && levelOf(r) === tier)) {
                return results.filter(r => r.isBestRelease || levelOf(r) === tier)
            }
        }
        return results
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

    private async getMediaContext(media: Media): Promise<MediaContext | null> {
        const anilistId = media.id
        if (this.mediaCache.has(anilistId)) return this.mediaCache.get(anilistId)!

        const resolved = await this.fetchJson<NekoBTResolveResponse>(
            `${API_URL}/media/resolve?id=anilist-${anilistId}`,
        )
        if (!resolved || resolved.error || !resolved.data || !resolved.data.media_id) {
            // Not mapped on nekoBT (yet): try to find the parent series. Failures are not cached.
            const fb = await this.getFallbackContext(media)
            if (fb) this.mediaCache.set(anilistId, fb)
            return fb
        }
        const mediaId = resolved.data.media_id

        const mediaRes = await this.fetchJson<NekoBTMediaResponse>(`${API_URL}/media/${mediaId}`)
        const allEpisodes = mediaRes?.data?.episodes ?? []
        const entries = mediaRes?.data?.anilist?.entries ?? []
        const entry = entries.find(e => e.anilist_id === anilistId) ?? null

        // Only keep the episodes belonging to this AniList entry (a nekoBT media can span several seasons/entries).
        // This includes season 0 when the AniList entry itself is mapped to season 0 (specials, OVAs, mini anime).
        const mapped = !!entry && entry.season !== null && entry.season !== undefined
        let episodes: NekoBTEpisode[] = []
        if (mapped) {
            episodes = allEpisodes.filter(e => this.inEntry(e, entry!))
        }
        const useExternalId = !mapped || episodes.length === 0

        const episodeNumberById = new Map<string, number>()
        for (const e of episodes) {
            const num = entry && !entry.ratio ? entry.dst_start + (e.episode - entry.src_start) : e.episode
            episodeNumberById.set(String(e.id), num)
        }

        const ctx: MediaContext = { fallback: false, mediaId, useExternalId, entry, episodes, episodeNumberById }
        this.mediaCache.set(anilistId, ctx)
        return ctx
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
    private async getFallbackContext(media: Media): Promise<MediaContext | null> {
        const queries: string[] = []
        const add = (q?: string) => {
            const c = (q || "").trim()
            if (c.length >= 3 && queries.indexOf(c) === -1) queries.push(c)
        }
        add(media.romajiTitle)
        add(media.englishTitle)
        const words = (media.romajiTitle || "").split(/\s+/).filter(Boolean)
        for (let n = words.length - 1; n >= 1; n--) add(words.slice(0, n).join(" "))
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
                    entry: null,
                    episodes: orphans,
                    episodeNumberById: new Map<string, number>(),
                }
            }
        }
        return null
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
    private findEpisode(ctx: MediaContext, anilistEpisode: number): NekoBTEpisode | null {
        for (const e of ctx.episodes) {
            if (ctx.episodeNumberById.get(String(e.id)) === anilistEpisode) return e
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

        const releases: SeaDexTr[] = []
        try {
            const filter = encodeURIComponent(`alID=${anilistId}`)
            const url = `${SEADEX_URL}?page=1&perPage=1&filter=${filter}&skipTotal=1&expand=trs`
            const data = await this.fetchJson<SeaDexRecordsResponse>(url)
            for (const tr of data?.items?.[0]?.expand?.trs ?? []) {
                if (!tr.infoHash || tr.infoHash === "<redacted>") continue
                releases.push(tr)
            }
            this.bestCache.set(anilistId, releases)
        } catch (e) {
            console.warn("nekoBT: Could not fetch SeaDex releases: " + (e as Error).message)
        }
        return releases
    }

    // Builds an AnimeTorrent for a SeaDex release. Single-file releases use their file name; batches use the Nyaa page title.
    private async getSeaDexTorrent(tr: SeaDexTr, media: Media, scrape: boolean): Promise<AnimeTorrent> {
        const hash = tr.infoHash.toLowerCase()
        const cached = this.seaDexTorrentCache.get(hash)
        if (cached && (cached.scraped || !scrape)) return cached.torrent

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

        if (scrape) {
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
            episodeNumber: single ? this.parseEpisodeFromName(files[0].name) : -1,
            releaseGroup: tr.releaseGroup || "",
            isBestRelease: true,
            confirmed: true,
        }
        this.seaDexTorrentCache.set(hash, { torrent, scraped: scrape })
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
        const cached = this.resolutionCache.get(id)
        if (cached !== undefined) return cached

        let found = ""
        const res = await this.fetchJson<{ data?: NekoBTTorrentDetail }>(`${API_URL}/torrents/${id}`)
        const d = res?.data
        for (const f of d?.files ?? []) {
            found = this.detectResolution(f.name)
            if (found) break
        }
        if (!found && d?.mediainfo) {
            const w = d.mediainfo.match(/Width\s*:\s*([\d\s]+)\s*pixels/i)
            if (w) found = this.bucketByWidth(parseInt(w[1].replace(/\s/g, ""), 10))
        }
        this.resolutionCache.set(id, found)
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

    private async fetchJson<T>(url: string): Promise<T | null> {
        try {
            const res = await fetch(url)
            if (res.status === 429) {
                console.warn("nekoBT: Rate limit reached (HTTP 429)")
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

    private toNumber(v: unknown): number {
        if (typeof v === "number") return v
        const n = parseInt(String(v ?? "0"), 10)
        return isNaN(n) ? 0 : n
    }

    private toAnimeTorrent(t: NekoBTTorrent, ctx: MediaContext | null): AnimeTorrent {
        const ts = this.toNumber(t.uploaded_at)
        const date = ts > 0 ? new Date(ts).toISOString() : new Date().toISOString()

        const title = (t.title || "Unknown") + this.formatSubtitleLangs(t)
        const resolution = this.detectResolution(t.title || "")

        // Episode info comes straight from the API's episode ids rather than title guessing
        const ids = (t.media_episode_ids || []).map(String)
        let isBatch = !!t.batch || ids.length > 1
        let episodeNumber = -1
        if (ctx && !isBatch && ids.length === 1) {
            const n = ctx.episodeNumberById.get(ids[0])
            if (n !== undefined) episodeNumber = n
        }
        if (ctx && ctx.fallback && !isBatch) episodeNumber = this.parseEpisodeFromName(t.title || "")

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
            confirmed: ctx !== null && !ctx.fallback,
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