# nekoBT for Seanime

A torrent provider for [Seanime](https://seanime.app) that searches [nekoBT](https://nekobt.to), with configurable filters and [SeaDex](https://releases.moe) best-release support.

## Features

- Searches nekoBT by AniList ID. Episodes and seasons are matched through nekoBT's own mappings, so no external mapping file is needed.
- Finds anime that nekoBT has not mapped to AniList (mini anime, specials, series without an AniList ID) by title.
- Supports Seanime's smart search (episode number, batches, resolution and title refinement) and simple search with Nyaa-style queries.
- Fully configurable filters: video codec, video type, audio and subtitle languages, subtitle levels, OTL, MTL and hardsubs.
- Marks SeaDex best and alternative releases as best releases in Seanime.
- Optionally adds SeaDex releases that nekoBT doesn't have.
- Optionally shows only the highest fansub level available, per episode.
- Optionally appends subtitle language codes to torrent names.
- Optionally adds your private tracker key to magnet links.

## Installation

In Seanime, open the extensions page, choose to add an extension, and paste this manifest URL:

```txt
https://raw.githubusercontent.com/Rinkerbel/rinkerbel-seanime-extensions/refs/heads/main/anime-torrent-providers/nekoBT%20by%20rinker/nekobt-rinkerbel.json
```

After installing, open the extension's settings to configure it. Saving the settings once after an update clears any "user config is incompatible" warning.

## Settings

Every filter is optional. Leave a field empty to disable it. Lists are comma separated, and values are not case sensitive.

### General

| Setting | Default | Description |
| --- | --- | --- |
| Torrent Key | empty | Your nekoBT private tracker key. You can paste just the key or the full announce URL. |
| Adds your private Torrent key to downloads | off | Adds the key to nekoBT magnet links. **Turn this off when using debrid**, private torrents are meant to only be used by you and not by your debrid. This is a bannable offense[^1] [^2] |
| Add Seadex torrents to results | on | Adds SeaDex releases that nekoBT doesn't have, and labels SeaDex releases with `[BEST]` or `[ALT]`. See [SeaDex](#seadex). |
| Only show the highest sub level available | off | For each episode, shows only the torrents with the highest sub level available for it: level 3, else level 2, else level 1. Lower-level torrents that cover episodes nothing better covers are kept, and torrents without a sub level count as the lowest level. SeaDex releases are never hidden. |
| Append subtitle languages to torrent names | off | Adds nekoBT's language codes for official and fansub subtitles to the end of the name, for example `(en, enm, es-419)`. Codes are written exactly as nekoBT uses them. This might be helpful when configuring Seanime auto select. |

[^1]: [See rule 14 of nekoBT](https://wiki.nekobt.to/rules/)
[^2]: [Public and private download links? What does that mean?](https://wiki.nekobt.to/faq/#public-and-private-download-links-what-does-that-mean)

### Filters

| Setting | Matching | Accepted values |
| --- | --- | --- |
| [Video codecs](https://wiki.nekobt.to/info/metadata/#video-codec) | Keeps only the listed codecs | `other`, `h264` (`avc`, `x264`), `hevc` (`h265`, `x265`), `av1`, `vp9`, `mpeg2`, `xvid` (`divx`), `wmv`, `vc1`. Numeric nekoBT ids also work. |
| [Video types (include)](https://wiki.nekobt.to/info/metadata/#video-type) | Keeps only the listed types | `other`, `vhs`, `ld`, `tv-encode`, `tv-raw`, `dvd-remux`, `dvd-encode`, `dvd-disc`, `web-mini`, `web-encode`, `web-dl`, `bd-disc`, `bd-mini`, `bd-encode`, `bd-remux`, `hybrid`. Numeric nekoBT ids also work. |
| [Video types (exclude)](https://wiki.nekobt.to/info/metadata/#video-type) | Removes the listed types | Same values as above. Applied to the include list, or to all types if the include list is empty. For example `web-mini,bd-mini` removes mini encodes. |
| Audio languages | Torrent must contain **all** listed languages | nekoBT language codes such as `ja` or `ja,en`. The full list is in nekoBT's [language list](https://nekobt.to/api/v1/langs). |
| [Subtitle levels](https://wiki.nekobt.to/info/sub-levels/) | Torrent may match **any** listed level | `-1` none, `0` official, `1` slight modifications, `2` small-scale fansub, `3` full-scale fansub |
| Fansub languages | Torrent may match **any** listed language | nekoBT language codes such as `en,enm`. `enm` is the English track with honorifics. |
| Official subtitle languages | Torrent may match **any** listed language | nekoBT language codes such as `en` |
| [Hardsubs](https://wiki.nekobt.to/info/metadata/#hardsubs) | All / Only / Exclude | Subtitles that are burned into the video. |
| [OTL (Original Translation)](https://wiki.nekobt.to/info/metadata/#otl-original-translation) | All / Only / Exclude | Fansub groups that translated everything themselves instead of editing an existing script |
| [MTL (Machine Translation)](https://wiki.nekobt.to/info/metadata/#mtl-machine-translation) | All / Only / Exclude | Includes fully machine translated and edited machine translations |

Unknown values in a list are ignored.  
Click a setting name to open the relevant nekoBT docs.

## How it works

### Searching

- The AniList ID is resolved to a nekoBT media entry. Searches then use the AniList ID, so nekoBT narrows them to that entry's episodes itself, also when the entry spans several seasons. A single-episode search additionally sends that episode's nekoBT episode id.
- Superseded torrents (replaced by a fix or repack) are always excluded, and results follow nekoBT's best-first ordering.
- With batches off, searching for a specific episode returns single-episode torrents. If there are none, from nekoBT or SeaDex, batches are included as well. Batch searches return batches.
- Simple search is a plain text search, like Nyaa: it sends your query and your filters to nekoBT without limiting the results to the anime, and adds the SeaDex releases of the anime that match your query. Queries support [the same filters as nyaa](https://nyaa.si/help#using-search).
- nekoBT has no resolution filter. The extension detects the resolution from the torrent name and, if that isn't possible, from the torrent's file names or media info, and then hides torrents with a different resolution. Torrents whose resolution can't be determined are kept.
- If nekoBT rate limits a request, the extension waits for the time the server asks for (up to 15 seconds) and retries once.

### Anime that nekoBT doesn't map to AniList

- **Series without an AniList mapping.** If resolving the AniList ID fails, nekoBT is searched by title. A series with no AniList mapping is accepted when its title is a near-exact match (similarity of at least 90%) and its year is within a year of the anime's. With one regular season, its episodes are matched 1:1. With several seasons the whole series is searched and episode numbers come from the torrent names.
- **Specials and mini anime.** If the anime has no mapping but the series it belongs to does, the parent is accepted only if its AniList relations list the anime you searched for. The results come from the parent's unmapped episodes, and episode numbers are read from the torrent names.
- **Wrong media ids.** If nekoBT resolves an AniList ID to a media that doesn't exist, the correct media is found through the torrents nekoBT returns for that AniList ID.
- Anime that AniList marks as adult skip the title-based lookup.

### Caching

If your Seanime version lets extensions use its store, lookups are cached in memory to save requests: nekoBT media info for 24 hours, SeaDex releases for 1 hour, and Nyaa details and resolution lookups until Seanime restarts. "Not on nekoBT" is remembered for 30 minutes. Reloading the extension or restarting Seanime clears everything. Without the store, nothing is cached and everything still works.

## SeaDex

[SeaDex](https://releases.moe) curates the best releases for each anime and also lists alternative releases.

- **Tagging:** any nekoBT torrent that matches a SeaDex release (best or alternative) is marked as a best release in Seanime. Its link stays nekoBT's torrent page.
- **Pulling:** with *Add Seadex torrents to results* on, SeaDex releases that nekoBT doesn't have are added to the results. These come from Nyaa and link to their Nyaa page. Their names, seeders, sizes and upload dates are read from Nyaa, through its RSS feed where possible. SeaDex releases on other trackers, or with hidden info hashes, can't be added.
- **Labels:** with the setting on, SeaDex releases start with `[BEST]` or `[ALT]`, because Seanime has no way to show the difference itself.
- **Which releases are shown:** a SeaDex best release that contains the selected episode is always shown, whatever the batches toggle says. Other SeaDex releases follow the toggle, like nekoBT's. Episodes are read from the release's file names.
- **Filters:** pulled releases are not affected by your filters.
- **Torrent key:** pulled releases never get your key. If you download one while the key setting is on, the extension checks whether nekoBT has the same torrent and, if it does, uses nekoBT's magnet with your key.
- To browse every SeaDex release, including all single episodes, use simple search or the dedicated SeaDex extension.

## Known limitations

- Seanime treats best releases as batches. SeaDex releases, including single-episode ones, show as "Season".
- Seanime sorts by seeders unless sorting is changed, so an extension can't force nekoBT's best-first order. The fansub option narrows the list but doesn't reorder it.
- Anime missing from nekoBT's database can't be found, apart from the title-based lookups described above.

## Credits

- Original extension by [bruuhim](https://github.com/bruuhim/bruuhim-seanime-extensions).
- [nekoBT](https://nekobt.to) for the torrent index and API.
- [SeaDex](https://releases.moe) for best release curation.
