# nekoBT for Seanime

A torrent provider for [Seanime](https://seanime.app) that searches [nekoBT](https://nekobt.to), with configurable filters and [SeaDex](https://releases.moe) best-release tagging.

## Features

- Searches nekoBT by AniList ID. Episodes and seasons are matched through nekoBT's own mappings, so no external mapping file is needed.
- Supports Seanime's smart search: episode number, batches, resolution and title refinement.
- Fully configurable filters: video codec, video type, audio and subtitle languages, subtitle levels, OTL, MTL and hardsubs.
- Pulls best releases from Seadex and marks them in Seanime.
- Optionally adds SeaDex releases that nekoBT doesn't have.
- Optionally shows only the highest fansub level available.
- Optionally appends subtitle languages to torrent names.
- Optionally adds your private tracker key to magnet links.

## Installation

In Seanime, open the extensions page, choose to add an extension, and paste this manifest URL:

```txt
https://raw.githubusercontent.com/Rinkerbel/rinkerbel-seanime-extensions/refs/heads/main/anime-torrent-providers/nekobt-rinkerbel/nekobt-rinkerbel.json
```

After installing, open the extension's settings to configure it. Saving the settings once after an update clears any "user config is incompatible" warning.

## Settings

Every filter is optional. Leave a field empty to disable it. Lists are comma separated, and values are not case sensitive.

### General

| Setting | Default | Description |
| --- | --- | --- |
| Torrent Key | empty | Your nekoBT private tracker key. You can paste just the key or the full announce URL. |
| Adds your private Torrent key to downloads | off | Adds the key to nekoBT magnet links. **Turn this off when using debrid**, private torrents are meant to only be used by you and not by your debrid. This is a bannable offense[^1] [^2] |
| Add Seadex torrents to results | on | Adds SeaDex releases that nekoBT doesn't have. See [SeaDex](#seadex). |
| Only show the highest sub level available | off | Shows only the highest fansub level present: level 3, else level 2, else level 1, else everything. SeaDex releases are never hidden. |
| Append subtitle languages to torrent names | off | Adds the full language names to the end of the name, for example `(English, Spanish, French)`. Official and fansub languages are combined, `enm` counts as English, and regional variants such as `pt-br` and `pt-pt` are merged. This might be helpful when configuring Seanime auto select. |

[^1]: [See rule 14 of nekoBT](https://wiki.nekobt.to/rules/)
[^2]: [Public and private download links? What does that mean?](https://wiki.nekobt.to/faq/#public-and-private-download-links-what-does-that-mean)

### Filters

| Setting | Matching | Accepted values |
| --- | --- | --- |
| [Video codecs](https://wiki.nekobt.to/info/metadata/#video-codec) | Keeps only the listed codecs | `other`, `h264` (`avc`, `x264`), `hevc` (`h265`, `x265`), `av1`, `vp9`, `mpeg2`, `xvid` (`divx`), `wmv`, `vc1`. Numeric nekoBT ids also work. |
| [Video types (include)](https://wiki.nekobt.to/info/metadata/#video-type) | Keeps only the listed types | `other`, `vhs`, `ld`, `tv-encode`, `tv-raw`, `dvd-remux`, `dvd-encode`, `dvd-disc`, `web-mini`, `web-encode`, `web-dl`, `bd-disc`, `bd-mini`, `bd-encode`, `bd-remux`, `hybrid`. Numeric nekoBT ids also work. |
| [Video types (exclude)](https://wiki.nekobt.to/info/metadata/#video-type) | Removes the listed types | Same values as above. Applied to the include list, or to all types if the include list is empty. For example `web-mini,bd-mini` removes mini encodes. |
| Audio languages | Torrent must contain **all** listed languages | ISO 639 codes such as `ja` or `ja,en` |
| [Subtitle levels](https://wiki.nekobt.to/info/sub-levels/) | Torrent may match **any** listed level | `-1` none, `0` official, `1` slight modifications, `2` small-scale fansub, `3` full-scale fansub |
| Fansub languages | Torrent may match **any** listed language | ISO 639 codes such as `en,enm`. `enm` is the English track with honorifics. |
| Official subtitle languages | Torrent may match **any** listed language | ISO 639 codes such as `en` |
| [Hardsubs](https://wiki.nekobt.to/info/metadata/#hardsubs) | All / Only / Exclude | Subtitles that are burned into the video. |
| [OTL (Original Translation)](https://wiki.nekobt.to/info/metadata/#otl-original-translation) | All / Only / Exclude | Fansub groups that translated everything themselves instead of editing an existing script |
| [MTL (Machine Translation)](https://wiki.nekobt.to/info/metadata/#mtl-machine-translation) | All / Only / Exclude | Includes fully machine translated and edited machine translations |

Unknown values in a list are ignored.  
Click the filter settings to be send to relevant nekoBT docs for further learning.

## How it works

- The AniList ID is resolved to a nekoBT media entry, and only the episodes belonging to that AniList entry are searched. This keeps multi-season series from mixing seasons together.
- Superseded torrents (replaced by a fix or repack) are always excluded, and results follow nekoBT's best-first ordering.
- Searching for a specific episode returns single-episode torrents. If there are none, batches are included as well.
- Anime that nekoBT hasn't mapped (for example mini anime or specials without their own AniList ID) are looked up by title. A candidate is only accepted if its AniList relations list the anime you searched for. Results come from nekoBT's unmapped episodes, and episode numbers are read from the torrent names, so these results are marked as unconfirmed.
- nekoBT has no resolution filter. The extension detects the resolution from the torrent name and, if that isn't possible, from the torrent's file names or media info, and then hides torrents with a different resolution. Torrents whose resolution can't be determined are kept.
- If nekoBT rate limits a request, the extension waits for the time the server asks for (up to 15 seconds) and retries once.

## SeaDex

[SeaDex](https://releases.moe) curates the best releases for each anime and also lists alternative releases.

- **Tagging:** any nekoBT torrent that matches a SeaDex release (best or alternative) is marked as a best release in Seanime.
- **Pulling:** with *Add Seadex torrents to results* on, SeaDex releases that nekoBT doesn't have are added to the results. These come from Nyaa. SeaDex releases on other trackers, or with hidden info hashes, can't be added.
- Pulled and tagged releases start with `[BEST]` or `[ALT]` so you can tell them apart, because Seanime has no way to show the difference itself.
- Every SeaDex release links to its [releases.moe](https://releases.moe) page.
- Pulled releases are not affected by your filters, because SeaDex has no codec, language or subtitle data for them. Batch and episode filtering and the resolution filter still apply.

## Known limitations

- Seanime appears to treat best releases as batches. Single-episode alternative releases may show up as "Season" entries instead of an episode.
- Seanime sorts by seeders unless sorting is changed, so an extension can't force nekoBT's best-first order. The fansub option narrows the list but doesn't reorder it.
- Anime missing from nekoBT's database can't be found, apart from the title-based lookup described above.

## Credits

- Original extension by [bruuhim](https://github.com/bruuhim/bruuhim-seanime-extensions).
- [nekoBT](https://nekobt.to) for the torrent index and API.
- [SeaDex](https://releases.moe) for best release curation.
