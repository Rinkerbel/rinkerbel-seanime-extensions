/// <reference path="../../typings/plugin.d.ts" />
/// <reference path="../../typings/system.d.ts" />
/// <reference path="../../typings/app.d.ts" />
/// <reference path="../../typings/core.d.ts" />
/// <reference path="./anilist-timetable.d.ts" />

/**
 * AniList Timetable. Contents, in file order:
 *
 * init()
 *   UI CONTEXT       $ui.register, one runtime:
 *     1. Setup              labels, Seanime's class strings, icons, the settings
 *     2. Cache              UTC days of airings in $storage, an hour each
 *     3. AniList schedule   the airing schedule's document, its requests, and what's kept of each answer
 *     4. Timetable          the days the page shows, put together from cached days
 *     5. AniList list       the user's list, their title language, the progress button's saves
 *     6. Seanime's page     its styles for the webview, the Schedule page laid out around the timetable
 *     7. Modal              Seanime's own modal: the date picker on a phone, the settings
 *     8. Webview            the Schedule page's webview, its messages
 *     9. Webview page       the HTML and its script (runs in the iframe, not in Seanime), then setContent
 */
// @ts-ignore
function init(): void {
	$ui.register((ctx) => {
		// ================================================================================================================
		// 1. Setup
		// ================================================================================================================

		const ANILIST_URL = "https://graphql.anilist.co";
		const HOUR = 60 * 60 * 1000;
		/** The marks: the list's statuses, in the settings' order, then the global schedule (titles not on the list) */
		const MARKS: AT.Mark[] = ["watching", "rewatching", "planning", "paused", "completed", "dropped", "unlisted"];
		/** Shown at first: the list's titles but dropped ones, as Seanime's Schedule page shows them, no global schedule */
		const DEFAULT_MARKS: AT.Mark[] = ["watching", "rewatching", "planning", "paused", "completed"];
		const MARK_LABELS: Record<AT.Mark, string> = {
			watching: "Watching",
			rewatching: "Rewatching",
			planning: "Planning",
			paused: "Paused",
			completed: "Completed",
			dropped: "Dropped",
			unlisted: "Not on your list",
		};
		/** AniList's formats, as Seanime names them, in its order, for the settings' format filter */
		const FORMATS: [string, string][] = [
			["TV", "TV"],
			["TV_SHORT", "TV Short"],
			["MOVIE", "Movie"],
			["SPECIAL", "Special"],
			["OVA", "OVA"],
			["ONA", "ONA"],
			["MUSIC", "Music"],
		];
		/**
		 * The settings' country filter: its key, its name, and the countries AniList's airing anime come from that it
		 * covers (AniList's countryOfOrigin). AniList keeps Taiwan apart; the owner asked for it under China. A title from
		 * anywhere else always passes. The page has the same codes (COUNTRY_OF).
		 */
		const COUNTRIES: [string, string, string[]][] = [
			["JP", "Japan", ["JP"]],
			["CN", "China", ["CN", "TW"]],
			["KR", "South Korea", ["KR"]],
		];
		/** The settings' adult titles: hidden, shown, or only they */
		const ADULT: [AT.Prefs["adult"], string][] = [
			["hide", "Hide"],
			["show", "Show"],
			["only", "Only"],
		];

		/**
		 * Seanime's own class strings, as its components render them (captured from Seanime's Button, IconButton and
		 * Skeleton components). Markup the plugin writes uses these, so it looks like Seanime's and follows the user's
		 * theme; every class is in Seanime's CSS build because its components use it. The webview gets the same object.
		 */
		const SEANIME = {
			buttonBase:
				"UI-Button_root whitespace-nowrap font-medium inline-flex items-center text-center justify-center focus-visible:outline-none focus-visible:ring-1 ring-offset-1 ring-offset-[--background] focus-visible:ring-white/40 disabled:opacity-50 disabled:pointer-events-none disabled:transform-none",
			buttonMotion:
				"transition-all duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] motion-safe:hover:scale-[1.01] motion-safe:active:scale-[0.98]",
			iconMotion:
				"transition-all duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] motion-safe:hover:scale-[1.04] motion-safe:active:scale-[0.96]",
			graySubtle:
				"rounded-lg text-[--gray] border bg-gray-100 border-transparent --border-gray-500/20 hover:bg-gray-200 active:bg-gray-300 dark:text-gray-100 dark:bg-opacity-10 dark:hover:bg-opacity-20",
			grayBasic:
				"text-[--gray] border border-transparent bg-transparent hover:bg-gray-100 active:bg-gray-200 dark:active:bg-opacity-20 dark:text-gray-200 dark:hover:bg-opacity-10 dark:active:text-gray-200",
			grayBasicRound:
				"rounded-full text-[--gray] border border-transparent bg-transparent hover:bg-gray-100 active:bg-gray-200 dark:active:bg-opacity-20 dark:text-gray-200 dark:hover:bg-opacity-10 dark:active:text-gray-200",
			sizeSm: "text-xs h-8 px-2.5",
			iconSizeMd: "UI-IconButton_root p-0 flex-none text-xl h-9 w-9",
			iconSizeXs: "UI-IconButton_root p-0 flex-none text-lg h-6 w-6",
			skeleton: "UI-Skeleton__root animate-pulse rounded-[--radius-md] bg-[--subtle] w-full h-12",
			card: "border border-[--border] rounded-xl bg-[--paper]",
		};
		const button = (variant: string, size = SEANIME.sizeSm) =>
			[SEANIME.buttonBase, variant, size, SEANIME.buttonMotion].join(" ");

		/** Lucide icons (Seanime's icon set), 24px grid, stroke 2. The webview gets them too. */
		const ICONS: Record<string, string> = {
			sliders:
				'<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
			left: '<path d="m15 18-6-6 6-6"/>',
			right: '<path d="m9 18 6-6-6-6"/>',
			leftLeft: '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
			rightRight: '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
			chevron: '<path d="m6 9 6 6 6-6"/>',
			check: '<path d="M20 6 9 17l-5-5"/>',
			checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
			globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
			eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
			rotate: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
			list: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
			pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
			drop: '<polyline points="10 15 15 20 20 15"/><path d="M4 4h7a4 4 0 0 1 4 4v12"/>',
			alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
		};
		/**
		 * Each list status's colour, as LiveChart Timetable has them, in Seanime's tones (its colour variables, which
		 * follow light and dark mode). Seanime has no brown: Dropped is its orange darkened.
		 */
		const MARK_COLOURS: Record<AT.Mark, string> = {
			completed: "var(--blue)",
			rewatching: "var(--teal)",
			watching: "var(--green)",
			planning: "var(--purple)",
			paused: "var(--orange)",
			dropped: "color-mix(in srgb, var(--orange) 62%, black)",
			unlisted: "var(--foreground)",
		};
		const MARK_CSS = MARKS.filter((m) => m !== "unlisted")
			.map((m) => `.at-mark-${m} { color: ${MARK_COLOURS[m]} !important; }`)
			.join("\n");
		/** The icon of each mark: on a title's list status, and in the settings (a title not on the list has none) */
		const MARK_ICONS: Record<AT.Mark, string> = {
			completed: "check",
			rewatching: "rotate",
			watching: "eye",
			planning: "list",
			paused: "pause",
			dropped: "drop",
			unlisted: "globe",
		};

		const log = (...args: any[]) => console.log("[anilist-timetable]", ...args);
		const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
		const sleep = (ms: number) => new Promise<void>((resolve) => ctx.setTimeout(() => resolve(), ms));

		// What $storage gives back can be Go slices rather than arrays: copy them with an index loop
		const toArray = <T>(v: any): T[] => {
			const out: T[] = [];
			for (let i = 0; i < (v?.length ?? 0); i++) out.push(v[i]);
			return out;
		};

		/** Saved settings, the default where nothing valid was saved, in the order they're shown */
		function readPrefs(saved: any): AT.Prefs {
			const s = saved || {};
			const pick = <T extends string>(all: T[], v: any, fallback: T[]) =>
				v == null ? fallback.slice() : all.filter((x) => toArray<string>(v).includes(x));
			const formats = FORMATS.map(([key]) => key);
			const countries = COUNTRIES.map(([key]) => key);
			return {
				marks: pick(MARKS, s.marks, DEFAULT_MARKS),
				formats: pick(formats, s.formats, formats),
				countries: pick(countries, s.countries, countries),
				// true and false were Show and Hide
				adult: s.adult === true ? "show" : ADULT.some(([key]) => key === s.adult) ? s.adult : "hide",
				clock: s.clock === "12" || s.clock === "24" ? s.clock : null,
			};
		}
		let prefs = readPrefs($storage.get("prefs"));
		/**
		 * The UTC offset of the first client's time zone, in minutes (goja has no Intl): what "today" is for keeping
		 * days, and for the phone's date picker. Kept, so it's right before a page has started after a restart.
		 */
		let utcOffset = Number($storage.get("offset")) || 0;
		/** Whether the first client's browser uses a 12-hour clock, which the settings start from */
		let browserHour12 = true;

		// ================================================================================================================
		// 2. Cache
		// ================================================================================================================

		// AniList's airing schedule is kept by UTC day: each client sorts the airings into the days of its own time zone,
		// so the cache depends on nothing the user picks, and the filters cost no request. A week on screen takes the
		// UTC days around it (the day before and after, for time zones either side of UTC). Days are one JSON string in
		// $storage (a string comes back as plain JavaScript). Seanime keeps a plugin's storage as one document and
		// rewrites it whole on every write, so it holds at most MAX_DAYS days, and a write waits a little so answers close
		// together make one.

		// Raised when what's kept of an answer changes, so a cache from an older version isn't read
		const CACHE_VERSION = 1;
		/** The most days $storage keeps; the 9 around today's week are kept whatever their number */
		const MAX_DAYS = 16;
		/** The most days kept in memory, ten weeks, so stepping back and forth over weeks seen costs nothing */
		const MAX_MEMORY_DAYS = 70;

		function readCache(): AT.Cache {
			try {
				const raw = $storage.get<string>("cache");
				const parsed = raw ? JSON.parse(raw) : null;
				if (parsed && parsed.version === CACHE_VERSION && parsed.days) return parsed;
			} catch (e) {
				log("cache unreadable, starting empty:", errorText(e));
			}
			return { days: {} };
		}

		const cache: AT.Cache = { ...readCache(), version: CACHE_VERSION };
		const isFresh = (c: AT.Cached<any> | undefined) => !!c && Date.now() - c.at < HOUR;
		/** Today where the first client is: its page says its UTC offset */
		const todayDate = () => new Date(Date.now() + utcOffset * 60000).toISOString().slice(0, 10);

		/** YYYY-MM-DD plus some days */
		function addDays(date: string, n: number): string {
			const [y, m, d] = date.split("-").map(Number);
			return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
		}
		/** `count` dates from `start` */
		const datesFrom = (start: string, count: number) => Array.from({ length: count }, (_, i) => addDays(start, i));
		/** The UTC days the page needs for `count` days from `start` in its time zone: the day before and after too */
		const utcDays = (start: string, count: number) => datesFrom(addDays(start, -1), count + 2);
		/** The UTC days around today's week, kept whatever else goes */
		const thisWeek = () => utcDays(todayDate(), 7);

		/**
		 * Drops the days before yesterday once they expire (later ones stay, so today's week shows at once, see
		 * loadWeek), then the oldest-fetched days past MAX_MEMORY_DAYS, but never today's week
		 */
		function pruneDays() {
			const week = thisWeek();
			for (const date of Object.keys(cache.days))
				if (date < week[0] && !isFresh(cache.days[date])) delete cache.days[date];
			let over = Object.keys(cache.days).length - MAX_MEMORY_DAYS;
			const oldestFirst = Object.keys(cache.days)
				.filter((date) => !week.includes(date))
				.sort((a, b) => cache.days[a].at - cache.days[b].at);
			for (const date of oldestFirst) {
				if (over-- <= 0) break;
				delete cache.days[date];
			}
		}

		let saving = false;
		/** Writes the days, about 2 s from now: what else comes in by then goes in the same write */
		function saveCache() {
			if (saving) return;
			saving = true;
			ctx.setTimeout(() => {
				saving = false;
				pruneDays();
				$storage.set("cache", JSON.stringify({ version: cache.version, days: storedDays() }));
			}, 2000);
		}

		/** The days $storage keeps: today's week, then the latest fetched, MAX_DAYS in all */
		function storedDays(): AT.Cache["days"] {
			const week = thisWeek();
			const dates = Object.keys(cache.days);
			const today = dates.filter((date) => week.includes(date));
			const latest = dates
				.filter((date) => !week.includes(date))
				.sort((a, b) => cache.days[b].at - cache.days[a].at);
			const out: AT.Cache["days"] = {};
			for (const date of today.concat(latest).slice(0, Math.max(MAX_DAYS, today.length)))
				out[date] = cache.days[date];
			return out;
		}

		// ================================================================================================================
		// 3. AniList schedule
		// ================================================================================================================

		// AniList's airing schedule for a span of time, the request Seanime's Discover page sends for its airing schedule
		// (Page.airingSchedules between two times), with only the fields the timetable shows. Seanime's own Schedule page
		// can't be used: it covers only the list (by season), and a plugin can't read its cache, only clear it. AniList
		// has 15 to 20 airings a day, so pages of 50 (its most), four to a request as aliases: a week and its edges in one
		// request, which AniList's rate limit (30 a minute while it's degraded) takes easily. No token: the schedule is
		// public, and the list comes from Seanime.

		const PER_PAGE = 50;
		const PAGES_PER_REQUEST = 4;
		/** At most this many requests for one span, in case AniList's hasNextPage never says no */
		const MAX_REQUESTS = 5;
		const AIRING_FIELDS = `airingAt
      episode
      media {
        id
        format
        episodes
        isAdult
        countryOfOrigin
        title {
          romaji
          english
        }
        coverImage {
          medium
        }
      }`;
		/** The pages from `first` on, as aliases p0, p1, ... */
		function scheduleQuery(first: number): string {
			const pages: string[] = [];
			for (let i = 0; i < PAGES_PER_REQUEST; i++)
				pages.push(`  p${i}: Page(page: ${first + i}, perPage: ${PER_PAGE}) {
    pageInfo {
      hasNextPage
    }
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      ${AIRING_FIELDS}
    }
  }`);
			return `query AiringSchedule($from: Int, $to: Int) {\n${pages.join("\n")}\n}`;
		}

		/**
		 * A request given up on after 12 s: Seanime's fetch ignores its timeout option and waits 35. It's raced
		 * against a timer, not aborted: Seanime's fetch reads an abort signal from its own goroutine, alongside
		 * whatever the plugin is running, which corrupted the runtime (LiveChart Timetable found this).
		 */
		function fetchFor(url: string, options: Record<string, any>): Promise<any> {
			return new Promise((resolve, reject) => {
				let settled = false;
				const timer = ctx.setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(new Error("timed out"));
				}, 12000);
				ctx.fetch(url, options).then(
					(res) => {
						if (settled) return;
						settled = true;
						timer();
						resolve(res);
					},
					(e) => {
						if (settled) return;
						settled = true;
						timer();
						reject(new Error(errorText(e)));
					},
				);
			});
		}

		/**
		 * One AniList request. A 429 waits out AniList's Retry-After (up to a minute) and a 5xx a moment, then it's
		 * tried again, twice at most; no answer at all is tried once more.
		 */
		async function anilist(query: string, variables: Record<string, any>): Promise<any> {
			const body = JSON.stringify({ query, variables });
			for (let attempt = 0; ; attempt++) {
				let res: any;
				try {
					res = await fetchFor(ANILIST_URL, {
						method: "POST",
						headers: { "Content-Type": "application/json", Accept: "application/json" },
						body,
					});
				} catch (e) {
					if (attempt === 0) {
						await sleep(1000);
						continue;
					}
					throw new Error(`AniList didn't answer (${errorText(e)}).`);
				}
				const json: { data?: any; errors?: { message?: string }[] } | null = res.json();
				if (attempt < 2 && (res.status === 429 || res.status >= 500 || !json)) {
					const after = Number(res.headers?.["Retry-After"] ?? res.headers?.["retry-after"]);
					log(`AniList answered ${res.status}, trying again`);
					await sleep(after > 0 ? Math.min(after, 60) * 1000 : 1500 * (attempt + 1));
					continue;
				}
				if (res.status === 429) throw new Error("AniList is limiting requests. Try again in a minute.");
				if (!json) throw new Error(`AniList sent an unexpected answer (HTTP ${res.status}).`);
				if (json.errors?.length && !json.data)
					throw new Error(json.errors[0].message || "AniList request failed.");
				if (!res.ok || !json.data) throw new Error(`AniList request failed (HTTP ${res.status}).`);
				return json.data;
			}
		}

		/** An airing, trimmed to what the page shows; null without a title */
		function trimAiring(s: any): AT.Airing | null {
			const m = s?.media;
			if (!m || !m.id || !s.airingAt) return null;
			return {
				time: Number(s.airingAt) * 1000,
				episode: Number(s.episode) || 0,
				anime: {
					id: Number(m.id),
					romaji: String(m.title?.romaji || m.title?.english || ""),
					english: m.title?.english ? String(m.title.english) : null,
					poster: m.coverImage?.medium ? String(m.coverImage.medium) : null,
					episodes: Number(m.episodes) || null,
					format: m.format ? String(m.format) : null,
					adult: !!m.isAdult,
					country: m.countryOfOrigin ? String(m.countryOfOrigin) : null,
				},
			};
		}

		// ================================================================================================================
		// 4. Timetable
		// ================================================================================================================

		/** A fetch already on its way, by its span: two quick clicks that need the same days share it */
		const inflight: Record<string, Promise<void>> = {};
		/** The days a fetch asks for: a week and its edges, so the next steps either way are cached */
		const FETCH_DAYS = 9;

		/** Fetches `count` UTC days from `from`, every page of them, and caches each day (an empty one too) */
		function fetchDays(from: string, count: number): Promise<void> {
			const key = `${from}|${count}`;
			if (!inflight[key]) {
				inflight[key] = (async () => {
					const start = Date.parse(from + "T00:00:00Z") / 1000;
					// airingAt_greater is exclusive, airingAt_lesser too
					const variables = { from: start - 1, to: start + count * 86400 };
					const airings: AT.Airing[] = [];
					for (let i = 0; i < MAX_REQUESTS; i++) {
						const data = await anilist(scheduleQuery(1 + i * PAGES_PER_REQUEST), variables);
						for (let p = 0; p < PAGES_PER_REQUEST; p++)
							for (const s of data?.[`p${p}`]?.airingSchedules || []) {
								const a = trimAiring(s);
								if (a) airings.push(a);
							}
						if (!data?.[`p${PAGES_PER_REQUEST - 1}`]?.pageInfo?.hasNextPage) break;
					}
					const at = Date.now();
					const byDay: Record<string, AT.Airing[]> = {};
					for (const date of datesFrom(from, count)) byDay[date] = [];
					for (const a of airings) {
						const date = new Date(a.time).toISOString().slice(0, 10);
						if (byDay[date]) byDay[date].push(a);
					}
					for (const date of Object.keys(byDay)) {
						byDay[date].sort((a, b) => a.time - b.time);
						cache.days[date] = { at, data: { date, airings: byDay[date] } };
					}
					saveCache();
				})().finally(() => {
					delete inflight[key];
				});
			}
			return inflight[key];
		}

		/** The latest week the page asked for (a number): an older one that hasn't started fetching is dropped */
		let latestWeek = 0;
		/** The fetch on its way: one at a time */
		let timetableBusy: Promise<void> | null = null;

		/**
		 * Sends the UTC days the page needs for `count` days from `start` in its time zone. Days already cached and
		 * fresh cost no request; otherwise FETCH_DAYS are fetched from the first missing one, which normally covers the
		 * rest (at most two fetches).
		 */
		async function loadWeek(start: string, count = 7, ticket = latestWeek) {
			const dates = utcDays(start, Math.max(1, Math.min(7, count)));
			const fresh = (d: string) => isFresh(cache.days[d]);
			const missing = () => dates.find((d) => !fresh(d));
			// The other days of a fetch go to the page with them, so stepping a day onto them shows them at once
			const fetched: string[] = [];
			const send = (error: string | null) =>
				webview.channel.send("week", {
					start,
					days: dates
						.concat(fetched.filter((d) => !dates.includes(d) && fresh(d)))
						.map((d) => cache.days[d]?.data ?? { date: d, airings: [] }),
					error,
				});
			// Today's week shows at once, however old, and is asked for again behind it (opening the page and Today are
			// instant): the page takes the new days in place
			const week = thisWeek();
			const behind = !!missing() && dates.every((d) => fresh(d) || (week.includes(d) && !!cache.days[d]));
			if (behind) send(null);
			// Moving forward, the days fetched start at the first missing one. Moving back (days missing before cached
			// ones), they end where the cached ones begin, so the next steps back are cached too.
			const from = () => {
				const firstFresh = dates.findIndex(fresh);
				return firstFresh > 0 ? addDays(dates[firstFresh - 1], 1 - FETCH_DAYS) : missing()!;
			};
			let error: string | null = null;
			try {
				for (let i = 0; i < 2 && missing(); i++) {
					// One fetch at a time, and only for the latest week asked for: quick clicks through the weeks cost
					// one fetch for the week they land on, not one each (and a 429)
					while (timetableBusy) await timetableBusy.catch(() => {});
					if (ticket !== latestWeek) return;
					if (!missing()) break;
					const first = from();
					const fetching = fetchDays(first, FETCH_DAYS);
					fetched.push(...datesFrom(first, FETCH_DAYS));
					timetableBusy = fetching;
					try {
						await fetching;
					} finally {
						if (timetableBusy === fetching) timetableBusy = null;
					}
				}
			} catch (e) {
				error = errorText(e);
				log("schedule failed:", error);
			}
			// Asked again behind days on screen, a failure leaves them be
			if (!(behind && error)) send(error);
		}

		// ================================================================================================================
		// 5. AniList list
		// ================================================================================================================

		// Seanime's collection fields that are Go pointers (status, progress, titles) reach JavaScript as objects
		// wrapping the value, so === and truthiness don't work on them: read them through String().
		const text = (v: unknown) => (v == null ? "" : String(v));
		const num = (v: unknown) => {
			if (v == null) return null;
			const n = Number(String(v));
			return isFinite(n) ? n : null;
		};

		let lists: Record<number, AT.ListEntry> = {};
		// The user's AniList title language, told from their collection: AniList's userPreferred title is the English
		// one or the romaji one. That costs no request.
		let inferredTitles: AT.TitleLanguage = "romaji";

		/** Reads the user's list from Seanime's cached collection (no request when it's cached, as it usually is) */
		function readCollection() {
			const next: Record<number, AT.ListEntry> = {};
			let english = 0;
			let romaji = 0;
			try {
				const listsIn = $anilist.getAnimeCollection(false)?.MediaListCollection?.lists;
				for (let i = 0; i < (listsIn?.length ?? 0); i++) {
					const entries = listsIn![i]?.entries;
					for (let j = 0; j < (entries?.length ?? 0); j++) {
						const entry = entries![j];
						const media = entry?.media;
						if (!media?.id) continue;
						next[media.id] = {
							status: text(entry.status),
							progress: num(entry.progress) ?? 0,
							episodes: num(media.episodes),
						};
						const t = media.title;
						const preferred = text(t?.userPreferred);
						if (t && text(t.english) && text(t.english) !== text(t.romaji)) {
							if (preferred === text(t.english)) english++;
							else if (preferred === text(t.romaji)) romaji++;
						}
					}
				}
				lists = next;
				inferredTitles = english > romaji ? "english" : "romaji";
			} catch (e) {
				log("collection unreadable:", errorText(e));
			}
		}

		/**
		 * Runs an AniList change (the progress button's), then has Seanime fetch the list again and the page show it. The
		 * $anilist calls are synchronous and hold up the plugin, so they run from a timer: the click that asked for them
		 * is answered first.
		 */
		function listChange(change: () => void, message: string): Promise<boolean> {
			return new Promise((resolve) => {
				ctx.setTimeout(() => {
					try {
						change();
					} catch (e) {
						log("AniList change failed:", errorText(e));
						ctx.toast.error(`AniList: ${errorText(e)}`);
						resolve(false);
						return;
					}
					try {
						$anilist.refreshAnimeCollection();
					} catch (e) {
						log("collection refresh failed:", errorText(e));
					}
					readCollection();
					webview.channel.send("lists", { lists, inferredTitles });
					ctx.toast.success(message);
					resolve(true);
				}, 0);
			});
		}

		// ================================================================================================================
		// 6. Seanime's page
		// ================================================================================================================

		// The webview is a sandboxed iframe with none of Seanime's styles. Instead of colours and fonts of its own, it
		// loads Seanime's: the stylesheets Seanime's page links (they load cross-origin as stylesheets do), the text of
		// its <style> elements (a custom theme, custom CSS), and the class and style of its <html>, where Seanime puts
		// the dark mode and the user's theme colours. The whole read is kept in the plugin's memory, so every page opened
		// while Seanime runs starts with it. Only the small parts go in $storage (the stylesheets, the <html> class and
		// style, the font: the theme), so after a restart the page starts in its colours and the <style> texts follow
		// with the next read. Those texts can be huge (a custom font embedded in custom CSS), and $storage is one
		// document Seanime rewrites whole on every write.

		/** What of Seanime's styles $storage keeps: all but the <style> texts */
		const smallStyles = (s: AT.Styles) => ({
			stylesheets: s.stylesheets,
			htmlClass: s.htmlClass,
			htmlStyle: s.htmlStyle,
			font: s.font,
		});
		let styles: AT.Styles | null = (() => {
			try {
				const raw = $storage.get<string>("styles");
				const saved = raw ? JSON.parse(raw) : null;
				return saved ? { ...smallStyles(saved), styles: [] } : null;
			} catch {
				return null;
			}
		})();

		async function readStyles(): Promise<AT.Styles | null> {
			const [root, body, links, tags] = await Promise.all([
				ctx.dom.queryOne("html"),
				ctx.dom.queryOne("body"),
				ctx.dom.query('link[rel="stylesheet"]'),
				ctx.dom.query("style", { withInnerHTML: true }),
			]);
			if (!root) return null;
			// The href property is the absolute URL: on Seanime's server in a browser, and on the desktop app's own
			// app:// scheme. Whichever client answers, Seanime's own stylesheets are kept as paths: each client has its
			// own address, and the page resolves a path against the Seanime it's shown in, since its frame takes the
			// address of the page around it.
			const [hrefs, base] = await Promise.all([
				Promise.all(links.map((l) => l.getProperty("href").catch(() => null))),
				root.getProperty("baseURI").catch(() => null),
			]);
			const origin = (/^[a-z]+:\/\/[^/]+/i.exec(String(base || "")) || [""])[0];
			const font = async (el: $ui.DOMElement | null) =>
				el ? String((await el.getComputedStyle("font-family").catch(() => "")) || "").trim() : "";
			const s: AT.Styles = {
				stylesheets: hrefs
					.filter((h): h is string => !!h && /^(https?|app):\/\//.test(h))
					.map((h) => (origin && h.startsWith(origin + "/") ? h.slice(origin.length) : h)),
				styles: tags
					.map((t) => t.innerHTML || "")
					// Not the toast and drawer libraries' styles (sonner, vaul): nothing in the page uses them
					.filter((s) => !!s.trim() && !/\[data-(sonner-toaster|vaul-drawer)/.test(s)),
				htmlClass: root.attributes?.class || "",
				htmlStyle: root.attributes?.style || "",
				font: (await font(body)) || (await font(root)),
			};
			return s;
		}

		function sendStyles() {
			readStyles()
				.then((next) => {
					if (!next) return;
					const small = JSON.stringify(smallStyles(next));
					if (!styles || small !== JSON.stringify(smallStyles(styles))) $storage.set("styles", small);
					styles = next;
					webview.channel.send("styles", next);
				})
				.catch((e) => log("styles unreadable:", errorText(e)));
		}

		const escapeAttribute = (s: string) =>
			String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

		/**
		 * onEachClient's marks: a name per call and per run of the plugin, so a mark left from an earlier run can't
		 * keep this one from an element
		 */
		const RUN = Date.now().toString(36);
		let eachClientCount = 0;

		/**
		 * Runs `fn` once for each element matching `selector` on any client's page, as each client that has one reports
		 * it. With several clients open (a browser, a phone, the desktop app), a DOM query is answered by the first
		 * client to answer, even with nothing; an observer hears only from clients that have a match. Each element is
		 * taken once, and marked: the observer reports changes to it too. Not by its ID alone: a client numbers
		 * elements from 0 again when its page reloads.
		 */
		function onEachClient(selector: string, fn: (el: $ui.DOMElement) => void): () => void {
			const mark = `data-at-${RUN}-${eachClientCount++}`;
			const taken: Record<string, number> = {};
			const [stop] = ctx.dom.observe(selector, (els) => {
				const now = Date.now();
				for (const el of els || []) {
					// Taken a moment ago: reported again before its mark got there
					if (el.attributes?.[mark] != null || now - (taken[el.id] || 0) < 3000) continue;
					taken[el.id] = now;
					el.setAttribute(mark, "");
					fn(el);
				}
			});
			return stop;
		}

		/**
		 * The timetable takes the place of Seanime's calendar on its Schedule page, between its carousels (missing
		 * episodes above, upcoming ones below). Seanime's slot for plugins is at the top of the page, so the page is laid
		 * out as a column with the timetable second (CSS order) and the calendar's box hidden. Elements aren't moved:
		 * React owns them, and a moved frame would load again. Seanime undoes styles a plugin set when it unloads, so the
		 * page is Seanime's again if the plugin stops.
		 */
		function placeOnSchedulePage() {
			// Each part found by a selector of its own: the page wrapper that holds the calendar, its box, its parts, and
			// the parts before it (the missing episodes; the timetable is first in the markup)
			const page = "[data-page-wrapper]:has(> * [data-schedule-calendar])";
			onEachClient(page, (el) => {
				el.setStyle("display", "flex");
				el.setStyle("flex-direction", "column");
				el.setStyle("row-gap", "2.5rem");
			});
			onEachClient(`${page} > :has([data-schedule-calendar])`, (el) => el.setStyle("display", "none"));
			// The page spaces its parts with margins by their place in the markup: a gap does it now. Parts show as their
			// data arrives (upcoming episodes load on their own), and the observers see them then.
			onEachClient(`${page} > *`, (el) => el.setStyle("margin-top", "0"));
			onEachClient(`${page} > :has(~ * [data-schedule-calendar]):not([data-webview-container])`, (el) =>
				el.setStyle("order", "-1"),
			);
		}

		// ================================================================================================================
		// 7. Modal
		// ================================================================================================================

		// The settings and the timetable's date picker on a phone open in Seanime's own modal (ctx.newModal), drawn with
		// Seanime's components. A plugin has one modal: each view replaces the last. Its builder functions are typed as
		// returning nothing, so they're used through `any`.
		let modal: any = ctx.newModal({ title: "Schedule" });
		let view: AT.View | null = null;

		// The modal's builders, through a wrapper that drops what Seanime can't take, since optional parts are written
		// as `cond ? x : null` and `style: undefined`:
		// - empty items: Seanime's renderer reads every item of an items array (component.key), so a null breaks it;
		// - props set to null or undefined: Seanime validates every prop it's given, and a nil one throws.
		const clean = (items: any[]) => items.filter((i) => i != null && i !== false);
		const tidy = (props: any) => {
			if (!props || typeof props !== "object" || Array.isArray(props) || props.type) return props;
			const out: any = {};
			for (const key of Object.keys(props)) {
				const value = props[key];
				if (value == null) continue;
				out[key] = key === "items" && Array.isArray(value) ? clean(value) : value;
			}
			return out;
		};
		const ui: any = {};
		for (const type of "div|button|select|css|span".split("|")) {
			ui[type] = (first: any, props?: any) =>
				props === undefined
					? modal[type](Array.isArray(first) ? clean(first) : tidy(first))
					: modal[type](Array.isArray(first) ? clean(first) : tidy(first), tidy(props));
		}

		function header(v: AT.View): { title: string; className: string } {
			switch (v.kind) {
				case "date":
					return { title: "Select a date", className: "max-w-md" };
				case "settings":
					return { title: "Settings", className: "max-w-lg" };
			}
		}

		function show(v: AT.View) {
			view = v;
			modal = ctx.newModal(header(v));
			modal.render(() => renderView());
			modal.open();
		}

		const redraw = () => {
			if (view) modal.update();
		};

		function renderView(): any {
			try {
				switch (view?.kind) {
					case "date":
						return renderDate(view);
					case "settings":
						return renderSettings(view);
				}
			} catch (e) {
				// An error thrown in a render counts toward the five that unload the plugin's UI
				log("modal render failed:", errorText(e));
				return modal.alert({ intent: "alert", description: errorText(e) });
			}
			return modal.div([]);
		}

		// Building blocks -------------------------------------------------------------------------------------------------

		/** An icon as a mask: it takes the colour of the text around it, as Seanime's icons do */
		const maskOf = (name: string) =>
			`url("data:image/svg+xml,${encodeURIComponent(
				`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`,
			)}")`;

		/**
		 * The modal's own classes, for what Seanime's CSS build has no class for. Seanime's css component scopes them to
		 * what follows it, so each view starts with it. Colours are Seanime's variables. No comments in it: Seanime's
		 * scoping reads everything before a brace as selectors.
		 */
		const MODAL_CSS = `
${MARK_CSS}
.at-toggle { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem; border-radius: 0.75rem; cursor: pointer; color: var(--muted); font-size: 0.875rem; min-width: 0; }
.at-toggle:hover { background: var(--subtle); }
.at-toggle.at-on { color: var(--foreground); background: var(--subtle); }
.at-dot { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 2rem; height: 2rem; border-radius: 9999px; font-size: 1.125rem; background: var(--subtle); color: var(--muted); }
.at-on .at-dot { background: currentColor; }
.at-on .at-dot .at-i { background-color: var(--background) !important; }
.at-chip-off { background: transparent !important; border-color: var(--border) !important; color: var(--muted) !important; }
`;
		const modalCss = () => ui.css(MODAL_CSS);

		/** The years Seanime's DatePicker offers: from a hundred years on back to 1800, the latest first */
		function yearOptions() {
			const thisYear = new Date(Date.now() + utcOffset * 60000).getUTCFullYear();
			const years: { value: string; label: string }[] = [];
			for (let y = thisYear + 100; y >= 1800; y--) years.push({ value: String(y), label: String(y) });
			return years;
		}

		const span = (t: string, className = "", style?: Record<string, string>) =>
			ui.span({ text: t, className, style });
		/** An icon in the colour of the text around it, as Seanime's are: a mask, which works wherever Seanime draws it */
		const icon = (name: string, className = "") =>
			ui.span({
				text: "",
				className: `at-i ${className}`,
				style: {
					display: "inline-block",
					flex: "none",
					width: "1em",
					height: "1em",
					backgroundColor: "currentColor",
					WebkitMask: `${maskOf(name)} center / contain no-repeat`,
					mask: `${maskOf(name)} center / contain no-repeat`,
				},
			});
		// Each key is registered once, its function swapped on every render: a fresh registration gives a new ID, which
		// changed the props of every clickable component on each redraw
		const handlerIds: Record<string, string> = {};
		const handlerFns: Record<string, (e: any) => void> = {};
		const handler = (key: string, fn: (e: any) => void): string => {
			handlerFns[key] = fn;
			return handlerIds[key] || (handlerIds[key] = ctx.eventHandler(key, (e: any) => handlerFns[key](e)));
		};

		// The timetable's date picker on a phone: Seanime's DatePicker, of plugin components, as it opens there (a
		// modal). Seanime's own can't be used: a plugin form's date field takes its value as a Date, which nothing a
		// plugin sends can be.
		const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
		const MONTH_NAMES = [
			"January",
			"February",
			"March",
			"April",
			"May",
			"June",
			"July",
			"August",
			"September",
			"October",
			"November",
			"December",
		];

		/**
		 * A month of Seanime's calendar (its classes): six weeks from the Monday on or before the 1st, as Seanime's,
		 * the arrows moving a month. `cell` draws a day (plainCell).
		 */
		function calendarMonth(o: {
			year: number;
			month: number;
			selected: string | null;
			key: string;
			onMonth: (year: number, month: number) => void;
			onDay: (date: string) => void;
			cell: (item: any, className: string, onClick: string) => any;
		}) {
			const { year, month, key } = o;
			const ymd = (d: Date) => d.toISOString().slice(0, 10);
			const today = ymd(new Date(Date.now() + utcOffset * 60000));
			const first = new Date(Date.UTC(year, month - 1, 1));
			const start = Date.UTC(year, month - 1, 1 - ((first.getUTCDay() + 6) % 7));
			const nav = (name: string, by: number, aria: string) =>
				ui.div([icon(name, "text-base")], {
					className: `${button(SEANIME.grayBasic, SEANIME.sizeSm)} rounded-lg relative z-10 cursor-pointer`,
					style: { width: "2rem", padding: "0" },
					onClick: handler(`${key}-${aria}`, () => o.onMonth(year, month + by)),
				});
			const weeks: any[] = [];
			for (let w = 0; w < 6; w++) {
				const days: any[] = [];
				for (let i = 0; i < 7; i++) {
					const d = new Date(start + (w * 7 + i) * 86400000);
					const date = ymd(d);
					const outside = d.getUTCMonth() !== month - 1;
					days.push(
						o.cell(
							span(String(d.getUTCDate())),
							[
								"UI-Calendar__dayButton h-9 w-9 p-0 font-normal justify-center rounded-[--radius]",
								date === o.selected
									? "bg-brand text-white font-semibold"
									: date === today
										? "bg-[--subtle] text-[--foreground]"
										: "",
								outside && date !== o.selected ? "!text-[--muted] opacity-20" : "",
							].join(" "),
							handler(`${key}-day-${w * 7 + i}`, () => o.onDay(date)),
						),
					);
				}
				weeks.push(ui.div(days, { className: "UI-Calendar__week flex w-full mt-2" }));
			}
			return ui.div(
				[
					ui.div(
						[
							nav("left", -1, "previous"),
							span(`${MONTH_NAMES[month - 1]} ${year}`, "UI-Calendar__captionLabel text-sm font-medium"),
							nav("right", 1, "next"),
						],
						{ className: "flex items-center justify-between" },
					),
					ui.div(
						WEEKDAYS.map((d) =>
							span(
								d,
								"UI-Calendar__weekday text-[--muted] rounded-[--radius] w-9 font-normal text-[0.8rem] text-center",
							),
						),
						{ className: "UI-Calendar__weekdays flex mt-4" },
					),
					...weeks,
				],
				{ className: "UI-Calendar__root p-3" },
			);
		}

		/** A day of the calendar (or its Clear) in a modal: a plain button, as Seanime's */
		const plainCell = (item: any, className: string, onClick: string) =>
			ui.div([item], {
				className: `${className} inline-flex items-center cursor-pointer hover:bg-[--subtle]`,
				onClick,
			});

		/**
		 * The timetable's date picker on a phone (below 640px; the page draws its own above that), as Seanime's
		 * DatePicker opens there: a modal, "Select a date", with Seanime's own Select for the year and Today where its
		 * Clear is. A day goes to the page (`go-to`).
		 */
		function renderDate(v: Extract<AT.View, { kind: "date" }>) {
			const [year, month] = v.month.split("-").map(Number);
			const setMonth = (y: number, m: number) => {
				v.month = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 7);
				redraw();
			};
			const go = (date: string) => {
				modal.close();
				webview.channel.send("go-to", { date });
			};
			return ui.div([
				ui.div(
					[
						ui.select("", {
							options: yearOptions(),
							value: String(year),
							size: "sm",
							onChange: handler("at-date-year", (e) => setMonth(Number(e.value) || year, month)),
						}),
					],
					{ className: "flex items-center justify-between p-1 sm:border-b" },
				),
				ui.div(
					[
						calendarMonth({
							year,
							month,
							selected: v.selected,
							key: "at-date",
							onMonth: setMonth,
							onDay: go,
							cell: plainCell,
						}),
					],
					{ className: "flex justify-center" },
				),
				ui.div(
					[
						plainCell(
							span("Today"),
							"px-4 py-2 text-sm text-[--muted] justify-center",
							handler("at-date-today", () => go(todayDate())),
						),
					],
					{ className: "flex justify-center p-1 border-t" },
				),
			]);
		}

		// Settings ------------------------------------------------------------------------------------------------------

		/**
		 * What shows and how: the list's statuses and the global schedule (titles not on the list), formats, countries
		 * and adult titles (hidden, shown, or only they), and the clock. Picked in Seanime's modal, kept by Save. The page filters every title by them,
		 * on the list or not: the schedule is fetched whole, so none of them costs a request.
		 */
		function renderSettings(v: Extract<AT.View, { kind: "settings" }>) {
			const d = v.draft;
			const change = (fn: () => void) => () => {
				fn();
				redraw();
			};
			const flip = (list: string[], x: string) =>
				list.includes(x) ? list.filter((y) => y !== x) : list.concat(x);
			const section = (title: string, items: any[]) =>
				ui.div([span(title, "text-sm font-semibold block"), ...items], { className: "space-y-2" });
			const toggle = (
				on: boolean,
				iconName: string,
				dotClass: string,
				text: string,
				key: string,
				fn: () => void,
			) =>
				ui.div(
					[
						ui.span({ text: "", className: `at-dot ${on ? dotClass : ""}`, items: [icon(iconName)] }),
						span(text, "truncate"),
					],
					{ className: `at-toggle ${on ? "at-on" : ""}`, onClick: handler(key, change(fn)) },
				);
			// Seanime's gray buttons, outlined when off. No tick on the ones picked: it widened them, moving the chips after
			// (the owner asked)
			const chip = (on: boolean, text: string, key: string, fn: () => void) =>
				ui.div([span(text)], {
					className: `${button(SEANIME.graySubtle, SEANIME.sizeSm)} cursor-pointer${on ? "" : " at-chip-off"}`,
					onClick: handler(key, change(fn)),
				});
			const chips = (items: any[]) => ui.div(items, { className: "flex flex-wrap gap-2" });
			const hour12 = d.clock ? d.clock === "12" : browserHour12;
			return ui.div(
				[
					modalCss(),
					section("Your list", [
						ui.div(
							MARKS.filter((m) => m !== "unlisted").map((m) =>
								toggle(
									d.marks.includes(m),
									MARK_ICONS[m],
									`at-mark-${m}`,
									MARK_LABELS[m],
									`at-set-mark-${m}`,
									() => {
										d.marks = flip(d.marks, m) as AT.Mark[];
									},
								),
							),
							{
								style: {
									display: "grid",
									gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
									gap: "0.375rem",
								},
							},
						),
					]),
					section("Global schedule", [
						toggle(
							d.marks.includes("unlisted"),
							MARK_ICONS.unlisted,
							"",
							MARK_LABELS.unlisted,
							"at-set-mark-unlisted",
							() => {
								d.marks = flip(d.marks, "unlisted") as AT.Mark[];
							},
						),
					]),
					section("Formats", [
						chips(
							FORMATS.map(([key, label]) =>
								chip(d.formats.includes(key), label, `at-set-format-${key}`, () => {
									d.formats = flip(d.formats, key);
								}),
							),
						),
					]),
					section("Countries", [
						chips(
							COUNTRIES.map(([key, label]) =>
								chip(d.countries.includes(key), label, `at-set-country-${key}`, () => {
									d.countries = flip(d.countries, key);
								}),
							),
						),
					]),
					section("Adult titles", [
						chips(
							ADULT.map(([key, label]) =>
								chip(d.adult === key, label, `at-set-adult-${key}`, () => (d.adult = key)),
							),
						),
					]),
					section("Clock", [
						chips([
							chip(hour12, "12-hour (1:30 PM)", "at-set-clock-12", () => (d.clock = "12")),
							chip(!hour12, "24-hour (13:30)", "at-set-clock-24", () => (d.clock = "24")),
						]),
					]),
					ui.div(
						[
							ui.button("Close", {
								intent: "gray-basic",
								onClick: handler("at-settings-close", () => modal.close()),
							}),
							ui.button("Save", {
								intent: "primary",
								onClick: handler("at-settings-save", () => {
									setPrefs(d);
									modal.close();
								}),
							}),
						],
						{ className: "flex justify-end gap-2" },
					),
				],
				{ className: "space-y-5" },
			);
		}

		function setPrefs(next: Partial<AT.Prefs>) {
			prefs = readPrefs({ ...prefs, ...next });
			$storage.set("prefs", prefs);
			webview.channel.send("prefs", { prefs });
		}

		// ================================================================================================================
		// 8. Webview
		// ================================================================================================================

		// On Seanime's Schedule page, in place of its calendar. At most most of the screen, so what's under it stays in
		// reach; it scrolls inside beyond that, its scroll bar in a gutter of its own (PAGE_CSS, .at-embedded). It starts
		// that tall (`height`: autoHeight alone starts a frame at an iframe's 150px), so it doesn't grow once its page has
		// loaded, moving what's under it; autoHeight then sets the page's own height. Fixed here: setOptions would
		// rebuild the frame.
		const webview = ctx.newWebview({
			fullWidth: true,
			style: "display: block",
			slot: "schedule-screen-top",
			autoHeight: true,
			height: "70vh",
			maxHeight: "70vh",
		});

		placeOnSchedulePage();

		webview.channel.on("ready", (r: AT.Ready) => {
			if (r && typeof r.hour12 === "boolean") browserHour12 = r.hour12;
			if (r && typeof r.offset === "number" && r.offset !== utcOffset) {
				utcOffset = r.offset;
				$storage.set("offset", utcOffset);
			}
			readCollection();
			// Every open page gets this (Seanime sends a webview's messages to all its clients); a page that has started
			// already (from what page() gave it, too) only takes the list from it
			webview.channel.send("init", initMessage());
			sendStyles();
		});

		/** The first day the page showed last */
		let lastStart: string | null = null;

		/** What the page starts from: the settings, the list and where it was */
		const initMessage = () => ({ prefs, inferredTitles, lists, lastStart });

		/**
		 * What page() starts the page with, so it draws the timetable at once, at its height, with no message to wait
		 * for: init, and the cached days it will show (where it was, else today). Seanime asks for the page's HTML each
		 * time its frame is put on a page, so these are always the latest. Stale days are drawn too: the page asks for
		 * its week as ever, and takes newer ones in place.
		 */
		function bootState() {
			const start = lastStart || todayDate();
			return {
				init: initMessage(),
				days: utcDays(start, 7)
					.map((d) => cache.days[d]?.data)
					.filter(Boolean),
			};
		}
		/** Without it the page starts as before, from ready: a failure here mustn't cost the page */
		function safeBootState() {
			try {
				return bootState();
			} catch (e) {
				log("page started without its days:", errorText(e));
				return null;
			}
		}

		webview.channel.on("week", (p: { start: string; count?: number }) => {
			if (!p || !/^\d{4}-\d\d-\d\d$/.test(p.start)) return;
			// The page opens on the days it showed last, kept in the plugin's memory: a sandboxed frame has nowhere to
			// keep something per browser, so it's the same for every client, until Seanime or the plugin restarts
			lastStart = p.start;
			loadWeek(p.start, Number(p.count) || 7, ++latestWeek);
		});

		// A title clicked (its poster, its name, its list status): its page in Seanime. Seanime's own preview modal
		// can't be opened by a plugin (it's state in Seanime's page, with no plugin event or URL for it), so there's no
		// lighter way. Seanime sends a plugin's navigation to every client's main tab (it can't tell them apart), and
		// the timetable's sandboxed frame can't navigate the page around it.
		webview.channel.on("open-entry", (p: { id: number }) => {
			const id = Number(p?.id);
			if (id > 0) ctx.screen.navigateTo("/entry", { id: String(id) });
		});
		webview.channel.on("open-settings", () =>
			show({
				kind: "settings",
				draft: {
					...prefs,
					marks: prefs.marks.slice(),
					formats: prefs.formats.slice(),
					countries: prefs.countries.slice(),
				},
			}),
		);
		// The timetable's dates clicked on a phone: Seanime's DatePicker opens a modal there
		webview.channel.on("open-date", (p: { start: string }) => {
			const start = /^\d{4}-\d\d-\d\d$/.test(String(p?.start)) ? p.start : todayDate();
			show({ kind: "date", selected: start, month: start.slice(0, 7) });
		});

		webview.channel.on("progress", (p: { anilistId: number; progress: number; total: number | null }) => {
			if (!p || !p.anilistId) return;
			listChange(
				() => $anilist.updateEntryProgress(p.anilistId, Math.round(p.progress), p.total || undefined),
				`Progress set to ${p.progress}`,
			).then((ok) => webview.channel.send("saved", { anilistId: p.anilistId, ok }));
		});

		// ================================================================================================================
		// 9. Webview page
		// ================================================================================================================

		const escapeStyle = (css: string) => css.replace(/<\/style/gi, "<\\/style");
		/** Seanime's font-family with Inter behind its first family, ahead of the generic fallbacks */
		const withInter = (font: string) => {
			const families = font.split(",");
			return [families[0], " Inter", ...families.slice(1)].join(",");
		};
		const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

		/**
		 * The page, with Seanime's styles from the last time they were read, so it starts styled. Without them (the
		 * first start) it stays hidden until the plugin sends them. Its <style> texts are put in once it has painted:
		 * written into the page, a custom font embedded in custom CSS held up its first paint (LiveChart Timetable's
		 * owner saw a black box). Inter's stylesheet doesn't hold it up either (media="print" until it has loaded).
		 */
		function page(): string {
			const s = styles;
			const fontStack = s && s.font ? withInter(s.font) : "";
			return `<!DOCTYPE html>
<html lang="en" class="${escapeAttribute(s ? s.htmlClass : "")}${s ? "" : " at-unstyled"}" style="${escapeAttribute(s ? s.htmlStyle : "")}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${(s ? s.stylesheets : []).map((href) => `<link rel="stylesheet" href="${escapeAttribute(href)}" data-at-seanime>`).join("\n")}
<style data-at-seanime></style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap" media="print" onload="this.media='all'">
<style>${PAGE_CSS}${fontStack ? `\n:root { --at-font: ${escapeStyle(fontStack)}; }` : ""}</style>
</head>
<body class="at-embedded">
<div id="app"></div>
<script>window.AT_SEANIME = ${json(SEANIME)};
window.AT_ICONS = ${json({ paths: ICONS, marks: MARK_ICONS, labels: MARK_LABELS })};
window.AT_BOOT = ${json(safeBootState())};
window.AT_STYLE_TEXTS = ${json(s ? s.styles : [])};</script>
<script>(${webviewApp.toString()})()</script>
</body>
</html>`;
		}

		// Layout only. Every colour, font and size of text is Seanime's: its variables and its classes, from its own
		// stylesheets. Seanime's font file is refused to the sandboxed iframe (its server's CORS turns away the iframe's
		// null origin), so Inter, the same typeface, comes from Google Fonts behind Seanime's font-family.
		const PAGE_CSS = `
html.at-unstyled body { visibility: hidden; }
html, body { margin: 0; }
/* The page scrolls: whatever overflow Seanime's <html> style (copied in) has, e.g. while one of its dialogs is open */
html { overflow: visible !important; }
body { overflow-y: auto; font-family: var(--at-font, inherit); }
/* Plain elements, as Seanime's CSS reset leaves them, in case its stylesheets don't load: no colour of their own */
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; text-align: inherit; }
h2, h3 { margin: 0; font-family: inherit; }
img { display: block; }
/* Inside the Schedule page's padding, as its calendar was. Its scroll bar (past 70vh) has a gutter of its own and room
   beside it, so it never sits over the cards (an overlay scroll bar takes no room of its own) */
body.at-embedded { scrollbar-gutter: stable; }
.at-page { padding: 0 0.75rem 0 0; }
.at-head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
.at-head h2 { margin: 0; }
.at-toolbar { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
.at-tt { display: grid; grid-template-columns: repeat(var(--at-columns, 7), minmax(0, 1fr)); gap: 1rem; }
.at-day { min-width: 0; }
.at-day-head { position: sticky; top: 0; z-index: 3; background: var(--background); display: flex; align-items: baseline; gap: 0.5rem; padding: 0.75rem 0; }
.at-day-head h3 { margin: 0; }
.at-day.at-today .at-day-head { color: var(--brand); }
.at-day.at-today .at-slots::before { background: rgb(var(--color-brand-500)); }
.at-slots { position: relative; padding-left: 1.125rem; }
.at-slots::before { content: ""; position: absolute; left: 0.3125rem; top: 0.375rem; bottom: 0; width: 2px; border-radius: 2px; background: var(--border); }
.at-slot { margin-bottom: 1.25rem; }
.at-slot-time { position: relative; display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.5rem; }
.at-slot-time::before { content: ""; position: absolute; left: -1.0625rem; top: 0.3125rem; width: 0.625rem; height: 0.625rem; border-radius: 9999px; background: rgb(var(--color-gray-600)); box-shadow: 0 0 0 2px var(--background); }
.at-slot.at-future .at-slot-time::before { background: rgb(var(--color-gray-400)); }
.at-now { position: relative; display: flex; align-items: center; justify-content: flex-end; margin: 0.25rem 0 1.25rem -1.125rem; }
.at-now::before { content: ""; position: absolute; left: 0; right: 0; height: 2px; background: rgb(var(--color-brand-500) / 0.6); }
.at-now span { position: relative; padding: 0.125rem 0.625rem; border-radius: 9999px; background: rgb(var(--color-brand-500)); }
.at-rel { display: grid; grid-template-columns: 3.5rem minmax(0, 1fr); column-gap: 0.625rem; margin-bottom: 1rem; }
.at-poster { position: relative; width: 3.5rem; height: 5rem; }
.at-poster-img { display: block; width: 100%; height: 100%; border-radius: var(--radius-md); overflow: hidden; background: var(--subtle); }
.at-poster-img img { display: block; width: 100%; height: 100%; object-fit: cover; }
.at-rel-body { min-width: 0; display: flex; flex-direction: column; height: 5rem; }
.at-rel-title { text-align: left; }
.at-rel-title:hover { text-decoration: underline; }
.at-rel-actions { display: flex; align-items: center; justify-content: space-between; margin-top: auto; margin-left: -0.25rem; }
/* Marks and the watched check colour Seanime's buttons, whose own dark:text class is more specific */
.at-progress.at-done { color: var(--green) !important; pointer-events: none; }
.at-muted { opacity: 0.4; }
.at-empty { display: flex; flex-direction: column; gap: 1.25rem; padding: 0.5rem 0 1.25rem; font-size: 1.125rem; }
.at-empty sup { font-size: 0.75em; }
${MARK_CSS}
.at-until { font-variant-numeric: tabular-nums; }
.at-range { background: none; border: 0; padding: 0; font-family: inherit; cursor: pointer; }
.at-range:hover, .at-range[aria-expanded=true] { color: var(--foreground); text-decoration: underline; }
/* The date picker: a menu under the dates, as Seanime's date fields open theirs */
.at-toolbar-box { position: relative; }
.at-datepop { position: absolute; z-index: 40; background: var(--paper); border: 1px solid var(--border); border-radius: 0.75rem; animation: at-pop 0.15s ease-out; transform-origin: top left; }
@keyframes at-pop { from { opacity: 0; transform: translateY(-0.5rem) scale(0.95); } }
.at-datepop[hidden] { display: none; }
/* Seanime's Select, small and filled (as its DatePicker's year), and its list over the picker */
.at-year-btn { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 2rem; padding: 0.25rem 0.5rem; border: 1px solid transparent; border-radius: var(--radius); font-size: 0.875rem; background: rgb(var(--color-gray-100)); }
.at-year-btn:hover { background: rgb(var(--color-gray-200)); }
.dark .at-year-btn { background: rgb(var(--color-gray-800)); }
.dark .at-year-btn:hover { background: rgb(var(--color-gray-700)); }
.at-year-btn svg.at-icon { width: 1rem; height: 1rem; margin-left: 0.5rem; opacity: 0.5; }
.at-year-list { position: fixed; z-index: 50; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: rgb(var(--color-gray-800)); box-shadow: 0 4px 6px -1px rgb(var(--color-gray-950) / 0.5); }
.at-year-items { flex: 1; overflow-y: auto; padding: 0.25rem; scrollbar-width: none; }
.at-year-items::-webkit-scrollbar { display: none; }
.at-year-scroll { display: flex; align-items: center; justify-content: center; height: 25px; flex: none; cursor: default; }
.at-year-scroll[hidden] { display: none; }
.at-year-scroll:first-child svg.at-icon { transform: rotate(180deg); }
.at-year-scroll svg.at-icon { width: 1rem; height: 1rem; opacity: 0.5; }
.at-year-item { position: relative; display: flex; align-items: center; width: 100%; height: 2rem; padding: 0 0.5rem 0 2rem; border-radius: var(--radius); font-size: 0.875rem; line-height: 1; }
.at-year-item:hover, .at-year-item.at-on { background: var(--subtle); }
.at-year-item svg.at-icon { position: absolute; left: 0.5rem; width: 1rem; height: 1rem; }
.at-today-link:hover { color: var(--foreground); }
.at-spinner { width: 1rem; height: 1rem; border: 2px solid var(--border); border-top-color: var(--brand); border-radius: 9999px; animation: at-spin 0.8s linear infinite; }
@keyframes at-spin { to { transform: rotate(360deg); } }
svg.at-icon { width: 1em; height: 1em; flex: none; }
`;

		/**
		 * The page's script. It runs in the webview's iframe, a browser, from its source text (page() puts
		 * webviewApp.toString() in a script tag), so it can use only browser globals and what it declares itself:
		 * nothing from the plugin around it.
		 */
		function webviewApp(): void {
			type Bridge = {
				send(event: string, payload?: any): void;
				on(event: string, cb: (value: any) => void): () => void;
			};
			const bridge = (window as any).webview as Bridge;
			/** Seanime's class strings, from the plugin (SEANIME there) */
			const C = (window as any).AT_SEANIME as Record<string, string>;
			const iconButton = (variant: string, size: string) => [C.buttonBase, variant, C.iconMotion, size].join(" ");
			const button = (variant: string, size: string) => [C.buttonBase, variant, size, C.buttonMotion].join(" ");

			const STATUS_MARKS: Record<string, AT.Mark> = {
				CURRENT: "watching",
				REPEATING: "rewatching",
				COMPLETED: "completed",
				PLANNING: "planning",
				PAUSED: "paused",
				DROPPED: "dropped",
			};
			/** AniList's formats as Seanime names them */
			const FORMAT_LABELS: Record<string, string> = {
				TV: "TV",
				TV_SHORT: "TV Short",
				MOVIE: "Movie",
				SPECIAL: "Special",
				OVA: "OVA",
				ONA: "ONA",
				MUSIC: "Music",
			};
			/** The settings' country filter for each country AniList's anime come from: Taiwan is under China (the plugin's COUNTRIES) */
			const COUNTRY_OF: Record<string, string> = { JP: "JP", CN: "CN", TW: "CN", KR: "KR" };
			/** The narrowest a day column gets before days are dropped */
			const COLUMN_WIDTH = 190;

			/** Lucide icons, and each mark's icon and name, from the plugin (ICONS, MARK_ICONS and MARK_LABELS there) */
			const ICON_PATHS = (window as any).AT_ICONS.paths as Record<string, string>;
			const MARK_ICONS = (window as any).AT_ICONS.marks as Record<AT.Mark, string>;
			const MARK_LABELS = (window as any).AT_ICONS.labels as Record<AT.Mark, string>;
			const icon = (name: string) =>
				`<svg class="at-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;

			// ------------------------------------------------------------------------------------------------------------
			// State
			// ------------------------------------------------------------------------------------------------------------

			/** The browser's own time zone and clock: each client shows the schedule in its own */
			const zone = (() => {
				try {
					return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
				} catch {
					return "UTC";
				}
			})();
			const browserHour12 = (() => {
				try {
					return !!new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12;
				} catch {
					return true;
				}
			})();

			let prefs: AT.Prefs | null = null;
			let inferredTitles: AT.TitleLanguage = "romaji";
			let lists: Record<string, AT.ListEntry> = {};
			/** The week the user asked for, and the first day of what's on screen (the last week loaded) */
			let viewStart: string | null = null;
			/** Titles kept on screen after their status changed to one the filters leave out, and the ones on screen */
			let kept: Record<string, boolean> = {};
			let shownIds: Record<string, boolean> = {};
			let shownStart: string | null = null;
			/** UTC days received, by date */
			const days: Record<string, AT.Day> = {};
			let loading = false;
			let error: string | null = null;
			let columns = 7;
			/** Titles seen, by AniList ID, for the buttons that name one */
			const animeById: Record<string, AT.Anime> = {};
			/** AniList IDs with a progress change on its way */
			const pending: Record<number, boolean> = {};

			const titleOf = (a: AT.Anime) => (inferredTitles === "english" && a.english ? a.english : a.romaji);
			/** The clock the settings picked, else the browser's */
			const hour12 = () => (prefs && prefs.clock ? prefs.clock === "12" : browserHour12);
			const listEntry = (a: AT.Anime) => lists[a.id] || null;
			const markOf = (a: AT.Anime): AT.Mark => {
				const entry = listEntry(a);
				return (entry && STATUS_MARKS[entry.status]) || "unlisted";
			};

			// ------------------------------------------------------------------------------------------------------------
			// Helpers
			// ------------------------------------------------------------------------------------------------------------

			const esc = (v: unknown) =>
				String(v ?? "")
					.replace(/&/g, "&amp;")
					.replace(/</g, "&lt;")
					.replace(/>/g, "&gt;")
					.replace(/"/g, "&quot;")
					.replace(/'/g, "&#39;");

			/** YYYY-MM-DD plus some days */
			function addDays(date: string, n: number): string {
				const [y, m, d] = date.split("-").map(Number);
				return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
			}
			const weekday = (date: string) => new Date(date + "T00:00:00Z").getUTCDay();

			// The day and clock of a moment in the browser's time zone, made once (they're asked for every airing)
			const dayFormat = (() => {
				try {
					return new Intl.DateTimeFormat("en-CA", {
						timeZone: zone,
						year: "numeric",
						month: "2-digit",
						day: "2-digit",
					});
				} catch {
					return null;
				}
			})();
			const clockFormat = (() => {
				try {
					return new Intl.DateTimeFormat("en-GB", {
						timeZone: zone,
						hour: "2-digit",
						minute: "2-digit",
						hourCycle: "h23",
					});
				} catch {
					return null;
				}
			})();
			const localDate = (ms: number) =>
				dayFormat ? dayFormat.format(new Date(ms)) : new Date(ms).toISOString().slice(0, 10);
			const localClock = (ms: number) =>
				clockFormat ? clockFormat.format(new Date(ms)) : new Date(ms).toISOString().slice(11, 16);
			const today = () => localDate(Date.now());

			/** The UTC offset of the browser's time zone, in minutes, which the plugin dates by */
			function utcOffset(): number {
				try {
					const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" } as any)
						.formatToParts(new Date())
						.find((p) => p.type === "timeZoneName");
					const m = /GMT([+-])(\d\d):(\d\d)/.exec(part ? part.value : "");
					return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
				} catch {
					return 0;
				}
			}

			const formatDate = (date: string, options: Intl.DateTimeFormatOptions) =>
				new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(date + "T00:00:00Z"));

			/** A clock reading ("HH:MM"), on the settings' clock */
			function formatClock(clock: string): string {
				const [h, m] = clock.split(":").map(Number);
				if (!hour12()) return clock;
				return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
			}

			/** The time left: "12h 45m 33s", "3d 13h 50m" */
			function until(ms: number): string {
				let s = Math.max(0, Math.floor((ms - Date.now()) / 1000));
				const d = Math.floor(s / 86400);
				s -= d * 86400;
				const h = Math.floor(s / 3600);
				s -= h * 3600;
				const m = Math.floor(s / 60);
				s -= m * 60;
				const pad = (n: number) => String(n).padStart(2, "0");
				if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
				if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
				return `${m}m ${pad(s)}s`;
			}

			const send = (event: string, payload?: any) => bridge.send(event, payload || {});

			/** As many days as fit side by side, at most a week: on a narrow screen days are dropped, not squeezed */
			function fitColumns(): number {
				const page = document.querySelector(".at-page");
				const width = page ? page.clientWidth - 32 : window.innerWidth;
				return Math.max(1, Math.min(7, Math.floor((width + 16) / (COLUMN_WIDTH + 16))));
			}

			const visibleDates = (start: string) => Array.from({ length: columns }, (_, i) => addDays(start, i));
			/** The UTC days the dates from `start` take: the day before and after too, for time zones off UTC */
			const neededDays = (start: string) => Array.from({ length: columns + 2 }, (_, i) => addDays(start, i - 1));

			/** A day in the browser's time zone: its airings, from the UTC days around it, by the minute they air */
			function slotsOf(date: string) {
				const slots: { time: number; clock: string; airings: AT.Airing[] }[] = [];
				for (const utc of [addDays(date, -1), date, addDays(date, 1)])
					for (const a of (days[utc] && days[utc].airings) || []) {
						if (localDate(a.time) !== date) continue;
						const last = slots[slots.length - 1];
						if (last && last.time === a.time) last.airings.push(a);
						else slots.push({ time: a.time, clock: localClock(a.time), airings: [a] });
					}
				return slots;
			}

			// ------------------------------------------------------------------------------------------------------------
			// Timetable
			// ------------------------------------------------------------------------------------------------------------

			/** A week asked for after the arrows' clicks stop (see requestWeek) */
			let weekTimer: ReturnType<typeof setTimeout> | null = null;

			/**
			 * Shows the days from `start` at once when they're in, and asks the plugin for them. After the arrows
			 * (`soon`), only once the clicks have stopped for 300 ms: each click moves the dates at once, but quick
			 * clicks through the weeks ask only for the one they land on. Otherwise what's on screen stays until the
			 * days arrive; a skeleton shows only if the first load is slow.
			 */
			function requestWeek(start: string, soon = false) {
				if (start !== shownStart) kept = {};
				viewStart = start;
				error = null;
				if (neededDays(start).every((d) => days[d])) {
					shownStart = start;
					loading = false;
					renderTimetable();
				} else {
					loading = true;
					if (!shownStart) {
						setTimeout(() => {
							if (loading && !shownStart) renderTimetable();
						}, 300);
					}
				}
				renderToolbar();
				if (weekTimer) clearTimeout(weekTimer);
				weekTimer = null;
				const ask = () => {
					weekTimer = null;
					send("week", { start, count: columns });
				};
				if (soon) weekTimer = setTimeout(ask, 300);
				else ask();
			}

			/** The date picker under the dates, open on a month (YYYY-MM), and its list of years; closed when null */
			let picker: { month: string; years?: boolean } | null = null;

			/**
			 * The date picker from 640px (below it, Seanime's modal: the plugin's), Seanime's DatePicker rebuilt: its
			 * year (its Select, small and filled, and the Select's list over the picker), a month of its calendar, and
			 * Today where its Clear is. The first day on screen is picked; a day clicked goes there.
			 */
			function renderPicker() {
				const el = document.getElementById("datepop");
				const range = document.querySelector<HTMLElement>("[data-act=date]");
				if (!el) return;
				if (range) range.setAttribute("aria-expanded", String(!!picker));
				if (!picker) {
					el.hidden = true;
					el.innerHTML = "";
					return;
				}
				const month = picker.month;
				const year = Number(month.slice(0, 4));
				const first = `${month}-01`;
				const start = addDays(first, -((weekday(first) + 6) % 7));
				const selected = shownStart || viewStart;
				const now = today();
				const cells = Array.from({ length: 42 }, (_, i) => {
					const date = addDays(start, i);
					const cls = [
						"UI-Calendar__dayButton h-9 w-9 p-0 font-normal justify-center rounded-[--radius] inline-flex items-center hover:bg-[--subtle]",
						date === selected
							? "bg-brand text-white font-semibold"
							: date === now
								? "bg-[--subtle] text-[--foreground]"
								: "",
						date.slice(0, 7) !== month && date !== selected ? "!text-[--muted] opacity-20" : "",
					].join(" ");
					return `<button class="${cls}" data-act="date-day" data-date="${date}">${Number(date.slice(8))}</button>`;
				});
				const weeks = Array.from(
					{ length: 6 },
					(_, w) =>
						`<div class="UI-Calendar__week flex w-full mt-2">${cells.slice(w * 7, w * 7 + 7).join("")}</div>`,
				).join("");
				// Seanime's years: from a hundred years on back to 1800
				const thisYear = Number(now.slice(0, 4));
				const years: number[] = [];
				for (let y = thisYear + 100; y >= 1800; y--) years.push(y);
				const nav = (by: number, name: string, title: string) =>
					`<button class="${button(C.grayBasic, C.sizeSm)} rounded-lg" style="width: 2rem; padding: 0" data-act="date-month" data-by="${by}" title="${title}">${icon(name)}</button>`;
				const yearList = picker.years
					? `<div class="at-year-list" role="listbox">
						<div class="at-year-scroll" data-scroll="-1">${icon("chevron")}</div>
						<div class="at-year-items">${years
							.map(
								(y) =>
									`<button class="at-year-item${y === year ? " at-on" : ""}" role="option" aria-selected="${y === year}" data-act="date-year" data-year="${y}">${y === year ? icon("check") : ""}${y}</button>`,
							)
							.join("")}</div>
						<div class="at-year-scroll" data-scroll="1">${icon("chevron")}</div>
					</div>`
					: "";
				el.innerHTML = `<div class="flex items-center justify-between p-1 border-b">
						<button class="at-year-btn" data-act="date-years" aria-label="Year" aria-expanded="${!!picker.years}">${year}${icon("chevron")}</button>
					</div>
					<div class="UI-Calendar__root p-3">
						<div class="flex items-center justify-between gap-2">
							${nav(-1, "left", "Previous month")}
							<span class="UI-Calendar__captionLabel text-sm font-medium">${formatDate(first, { month: "long", year: "numeric" })}</span>
							${nav(1, "right", "Next month")}
						</div>
						<div class="UI-Calendar__weekdays flex mt-4">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
							.map(
								(d) =>
									`<span class="UI-Calendar__weekday text-[--muted] rounded-[--radius] w-9 font-normal text-[0.8rem] text-center">${d}</span>`,
							)
							.join("")}</div>
						${weeks}
					</div>
					<div class="flex justify-center p-1 border-t">
						<button class="px-4 py-2 text-sm text-[--muted] at-today-link" data-act="date-today">Today</button>
					</div>${yearList}`;
				// Under the dates, kept inside the page's width
				const wasHidden = el.hidden;
				el.hidden = false;
				if (wasHidden && range) {
					const box = el.parentElement!;
					el.style.top = `${range.offsetTop + range.offsetHeight + 6}px`;
					el.style.left = `${Math.max(0, Math.min(range.offsetLeft, box.clientWidth - el.offsetWidth))}px`;
				}
				const list = el.querySelector<HTMLElement>(".at-year-items");
				if (!list) return;
				// Placed as Radix places Seanime's Select list ("item-aligned"): over the year field and as wide, from near
				// the top of the frame to near its bottom (Radix's 10px from each edge), scrolled so the year picked sits on
				// the field, under the pointer that opened it. It used to fill the date picker's box, the picked year near its
				// top, so the scroll-up arrow opened under the pointer and scrolled the list at once (the owner found it).
				const yearBox = el.querySelector<HTMLElement>(".at-year-list");
				const field = el.querySelector<HTMLElement>("[data-act=date-years]");
				const on = list.querySelector<HTMLElement>(".at-on");
				if (yearBox && field) {
					const f = field.getBoundingClientRect();
					yearBox.style.left = `${f.left}px`;
					yearBox.style.width = `${f.width}px`;
					yearBox.style.top = "10px";
					yearBox.style.bottom = "10px";
				}
				const align = () => {
					if (on && field)
						list.scrollTop += on.getBoundingClientRect().top - field.getBoundingClientRect().top;
				};
				// Its scroll arrows, shown while there's more that way, scroll while the pointer is on them
				const arrows = Array.from(el.querySelectorAll<HTMLElement>(".at-year-scroll"));
				const showArrows = () => {
					arrows[0].hidden = list.scrollTop <= 0;
					arrows[1].hidden = list.scrollTop >= list.scrollHeight - list.clientHeight - 1;
				};
				list.addEventListener("scroll", showArrows);
				// Aligned again once the arrows are shown or hidden: they move the list's items
				align();
				showArrows();
				align();
				for (const arrow of arrows) {
					let timer: ReturnType<typeof setInterval> | null = null;
					arrow.addEventListener("pointerenter", () => {
						timer = setInterval(() => (list.scrollTop += 8 * Number(arrow.dataset.scroll)), 16);
					});
					arrow.addEventListener("pointerleave", () => timer && clearInterval(timer));
				}
			}

			function pickerMonth(year: number, month: number) {
				const d = new Date(Date.UTC(year, month - 1, 1));
				picker = { month: d.toISOString().slice(0, 7) };
				renderPicker();
			}

			function renderToolbar() {
				const el = document.getElementById("toolbar");
				if (!el) return;
				const start = shownStart || viewStart;
				const range =
					start &&
					(columns === 1
						? formatDate(start, { weekday: "long", month: "short", day: "numeric", year: "numeric" })
						: `${formatDate(start, { month: "short", day: "numeric" })} – ${formatDate(
								addDays(start, columns - 1),
								{
									month: "short",
									day: "numeric",
									year: "numeric",
								},
							)}`);
				const step = columns;
				const nav = (days: number, name: string, title: string) =>
					`<button class="${iconButton("rounded-lg " + C.grayBasic, C.iconSizeMd)}" data-act="nav" data-days="${days}" title="${title}">${icon(name)}</button>`;
				el.innerHTML = `
					${nav(-step, "leftLeft", step === 7 ? "Previous week" : `Previous ${step} days`)}
					${nav(-1, "left", "Previous day")}
					<button class="${button(C.graySubtle, C.sizeSm)}" data-act="today">Today</button>
					${nav(1, "right", "Next day")}
					${nav(step, "rightRight", step === 7 ? "Next week" : `Next ${step} days`)}
					<button class="at-range text-sm text-[--muted]" data-act="date" title="Go to a date" aria-expanded="${!!picker}">${esc(range || "")}</button>
					${loading && shownStart ? `<span class="at-spinner" role="status" aria-label="Loading"></span>` : ""}`;
			}

			/**
			 * Whether a title shows: the settings let its list status (or the global schedule, off the list), its format,
			 * its country and whether it's adult through. A format or country the settings don't list always passes.
			 */
			const shows = (a: AT.Anime) => {
				if (!prefs || !prefs.marks.includes(markOf(a))) return false;
				if (a.format && FORMAT_LABELS[a.format] && !prefs.formats.includes(a.format)) return false;
				const country = a.country && COUNTRY_OF[a.country];
				if (country && !prefs.countries.includes(country)) return false;
				return prefs.adult === "only" ? a.adult : prefs.adult === "show" || !a.adult;
			};
			/**
			 * Whether a title is on the timetable: the filters let it through, or it was there when its status changed
			 * (it stays, muted, until the days change)
			 */
			const listed = (a: AT.Anime) => {
				const on = shows(a) || !!kept[a.id];
				if (on) shownIds[a.id] = true;
				return on;
			};
			/** The titles on screen now keep their place through a status change */
			const keepShown = () => Object.keys(shownIds).forEach((id) => (kept[id] = true));

			function airingHtml(r: AT.Airing, aired: boolean): string {
				const a = r.anime;
				animeById[a.id] = a;
				const mark = markOf(a);
				const entry = listEntry(a);
				const title = titleOf(a);
				const episodes = `EP${r.episode}${a.episodes ? `/${a.episodes}` : ""}`;
				const format = (a.format && FORMAT_LABELS[a.format]) || "";
				// The progress button: only for titles being watched (or rewatched), once the episode has aired
				let progress = "";
				if (entry && aired && r.episode && (entry.status === "CURRENT" || entry.status === "REPEATING")) {
					progress =
						entry.progress >= r.episode
							? `<span class="at-progress at-done ${iconButton(C.grayBasicRound, C.iconSizeXs)}" title="Watched">${icon("checkCircle")}</span>`
							: `<button class="at-progress ${iconButton(C.grayBasicRound, C.iconSizeXs)}" data-act="progress" data-anime="${a.id}" data-episode="${r.episode}" title="Progress to ${r.episode}"${
									pending[a.id] ? " disabled" : ""
								}>${icon("check")}</button>`;
				}
				return `<div class="at-rel${shows(a) ? "" : " at-muted"}">
					<div class="at-poster">
						<button class="at-poster-img" data-act="entry" data-anime="${a.id}" title="${esc(title)}">${
							a.poster ? `<img src="${esc(a.poster)}" alt="" loading="lazy">` : ""
						}</button>
					</div>
					<div class="at-rel-body">
						<button class="at-rel-title text-sm font-medium line-clamp-2" data-act="entry" data-anime="${a.id}" title="${esc(title)}">${esc(title)}</button>
						<div class="text-xs text-[--muted] truncate"><span class="font-semibold text-[--foreground]">${esc(episodes)}</span>${format ? ` · ${esc(format)}` : ""}</div>
						<div class="at-rel-actions">
							${
								entry
									? `<button class="${iconButton(C.grayBasicRound, C.iconSizeXs)} at-mark-${mark}" data-act="entry" data-anime="${a.id}" title="${esc(MARK_LABELS[mark])}">${icon(MARK_ICONS[mark])}</button>`
									: "<span></span>"
							}
							${progress}
						</div>
					</div>
				</div>`;
			}

			function renderTimetable() {
				const el = document.getElementById("timetable");
				if (!el) return;
				el.style.setProperty("--at-columns", String(columns));
				const start = shownStart;
				if (!start) {
					// Only while the first load is slow
					el.innerHTML = loading
						? `<div class="at-tt">${Array.from({ length: columns })
								.map(
									() =>
										`<div><div class="${C.skeleton}" style="height:2rem;width:60%;margin:0.75rem 0"></div>${Array.from(
											{ length: 4 },
										)
											.map(
												() =>
													`<div class="${C.skeleton}" style="height:5rem;margin-bottom:1rem"></div>`,
											)
											.join("")}</div>`,
								)
								.join("")}</div>`
						: "";
					return;
				}
				shownIds = {};
				const now = Date.now();
				const todayDate = today();
				const nowLabel = (() => {
					try {
						const time = new Intl.DateTimeFormat("en-US", {
							timeZone: zone,
							hour: "numeric",
							minute: "2-digit",
							hour12: hour12(),
						}).format(new Date(now));
						const offset = new Intl.DateTimeFormat("en-US", {
							timeZone: zone,
							timeZoneName: "shortOffset",
						} as any)
							.formatToParts(new Date(now))
							.find((p) => p.type === "timeZoneName");
						return `${time} ${offset ? offset.value : ""}`;
					} catch {
						return "";
					}
				})();
				const nowMarker = `<div class="at-now"><span class="text-xs font-semibold text-white">${esc(nowLabel)}</span></div>`;

				const alert = error
					? `<div class="${C.card} p-3 mb-4 flex items-center gap-3 text-sm text-[--red]">${icon("alert")}<div class="flex-1">Couldn't load the schedule from AniList. ${esc(
							error,
						)}</div><button class="${button(C.graySubtle, C.sizeSm)}" data-act="retry">Retry</button></div>`
					: "";

				const columnsHtml = visibleDates(start)
					.map((date) => {
						let nowPlaced = date !== todayDate;
						const parts: string[] = [];
						for (const slot of slotsOf(date)) {
							const airings = slot.airings.filter((a) => listed(a.anime));
							if (!airings.length) continue;
							const past = slot.time <= now;
							if (!nowPlaced && !past) {
								parts.push(nowMarker);
								nowPlaced = true;
							}
							parts.push(`<div class="at-slot ${past ? "at-past" : "at-future"}">
								<div class="at-slot-time">
									<span class="text-sm font-medium">${esc(formatClock(slot.clock))}</span>
									${past ? "" : `<span class="text-xs text-[--muted] at-until" data-until="${slot.time}">${esc(until(slot.time))}</span>`}
								</div>
								${airings.map((a) => airingHtml(a, past)).join("")}
							</div>`);
						}
						// Nothing (or nothing the filters let through): a sleepy face, the current time under it
						if (!parts.length)
							parts.push(
								`<div class="at-empty text-[--muted]"><p>Nothing scheduled</p><p>(－.－)<sup>z<sup>Z<sup>z</sup></sup></sup></p></div>`,
							);
						if (!nowPlaced) parts.push(nowMarker);
						return `<section class="at-day${date === todayDate ? " at-today" : ""}">
							<div class="at-day-head"><h3>${esc(formatDate(date, { weekday: "short" }))}</h3><span class="text-lg text-[--muted]">${esc(
								formatDate(date, { month: "short", day: "2-digit" }),
							)}</span></div>
							<div class="at-slots">${parts.join("")}</div>
						</section>`;
					})
					.join("");
				el.innerHTML = `${alert}<div class="at-tt">${columnsHtml}</div>`;
			}

			// ------------------------------------------------------------------------------------------------------------
			// Events
			// ------------------------------------------------------------------------------------------------------------

			document.addEventListener("click", (e) => {
				// A click anywhere else closes the date picker
				if (picker && !(e.target as Element).closest("#datepop, [data-act=date]")) {
					picker = null;
					renderPicker();
				}
				// And anywhere but the list of years, that list
				if (picker && picker.years && !(e.target as Element).closest(".at-year-list, [data-act=date-years]")) {
					picker.years = false;
					renderPicker();
				}
				const el = (e.target as Element).closest<HTMLElement>("[data-act]");
				if (!el) return;
				e.preventDefault();
				const anime = el.dataset.anime ? animeById[el.dataset.anime] : null;
				switch (el.dataset.act) {
					case "nav":
						if (viewStart) requestWeek(addDays(viewStart, Number(el.dataset.days)), true);
						break;
					case "today":
						requestWeek(today());
						break;
					case "date":
						// A phone gets Seanime's modal, as its DatePicker opens there (below 640px)
						if (!picker && window.innerWidth < 640) {
							send("open-date", { start: shownStart || viewStart || today() });
							break;
						}
						picker = picker ? null : { month: (shownStart || viewStart || today()).slice(0, 7) };
						renderPicker();
						break;
					case "date-today":
						picker = null;
						renderPicker();
						requestWeek(today());
						break;
					case "date-month":
						if (picker)
							pickerMonth(
								Number(picker.month.slice(0, 4)),
								Number(picker.month.slice(5)) + Number(el.dataset.by),
							);
						break;
					case "date-day":
						picker = null;
						renderPicker();
						requestWeek(el.dataset.date!);
						break;
					case "date-years":
						if (picker) {
							picker.years = !picker.years;
							renderPicker();
						}
						break;
					case "date-year":
						if (picker) pickerMonth(Number(el.dataset.year), Number(picker.month.slice(5)));
						break;
					case "retry":
						if (viewStart) requestWeek(viewStart);
						break;
					case "settings":
						send("open-settings");
						break;
					case "entry":
						if (anime) send("open-entry", { id: anime.id });
						break;
					case "progress": {
						const entry = anime && listEntry(anime);
						if (!anime || !entry) break;
						pending[anime.id] = true;
						renderTimetable();
						send("progress", {
							anilistId: anime.id,
							progress: Number(el.dataset.episode),
							total: entry.episodes || anime.episodes || null,
						});
						break;
					}
				}
			});

			// A mouse wheel's notch eases over a few frames instead of jumping, its step the browser's. The box scrolled
			// is the nearest one under the pointer that can scroll that way, or the page. Only a mouse wheel's notches
			// are eased (whole lines, or wheelDeltaY in 120s with a step of 50px or more): easing a touchpad's large
			// steps among its small ones fought its own scrolling, which bounced. Any other step, a touch or a press
			// stops the easing and leaves scrolling to the browser for a moment. Zooming keeps its own.
			const easing = new WeakMap<Element, { target: number; frame: number }>();
			const running = new Set<{ target: number; frame: number }>();
			let otherAt = 0;
			const stopEasing = (s: { target: number; frame: number }) => {
				if (s.frame) cancelAnimationFrame(s.frame);
				s.frame = 0;
				running.delete(s);
			};
			const stopAllEasing = () => running.forEach(stopEasing);
			const wheelNotch = (e: WheelEvent) => {
				const w = (e as any).wheelDeltaY;
				return e.deltaMode === 1 || (e.deltaMode === 0 && Math.abs(e.deltaY) >= 50 && w !== 0 && w % 120 === 0);
			};
			document.addEventListener(
				"touchstart",
				() => {
					otherAt = Date.now();
					stopAllEasing();
				},
				{ passive: true, capture: true },
			);
			document.addEventListener("pointerdown", stopAllEasing, { passive: true, capture: true });
			const scrollerOf = (from: Element | null, dy: number): Element | null => {
				for (
					let el = from;
					el && el !== document.body && el !== document.documentElement;
					el = el.parentElement
				) {
					const overflow = getComputedStyle(el).overflowY;
					if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight) {
						const room = dy > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop;
						if (room > 0 || easing.get(el)?.frame) return el;
					}
				}
				return document.scrollingElement;
			};
			const easeStep = (box: Element, s: { target: number; frame: number }) => {
				const d = s.target - box.scrollTop;
				if (Math.abs(d) < 1) {
					stopEasing(s);
					return;
				}
				box.scrollTop += Math.sign(d) * Math.max(1, Math.abs(d) * 0.2);
				s.frame = requestAnimationFrame(() => easeStep(box, s));
			};
			document.addEventListener(
				"wheel",
				(e) => {
					if (e.ctrlKey) return;
					if (!wheelNotch(e)) {
						otherAt = Date.now();
						stopAllEasing();
						return;
					}
					if (Date.now() - otherAt < 400) return;
					const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
					const box = scrollerOf(e.target instanceof Element ? e.target : null, dy);
					if (!box) return;
					const s = easing.get(box) || { target: 0, frame: 0 };
					easing.set(box, s);
					if (!s.frame) s.target = box.scrollTop;
					const next = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, s.target + dy));
					// At its end: the frame's parent page scrolls on, as it would
					if (next === s.target && !s.frame) return;
					s.target = next;
					e.preventDefault();
					if (!s.frame) {
						running.add(s);
						s.frame = requestAnimationFrame(() => easeStep(box, s));
					}
				},
				{ passive: false },
			);

			// Days drop or come back as the page narrows or widens, once the width has settled (150 ms): opening or
			// closing a modal on the Schedule page narrowed the frame for a moment, which dropped the page to one day
			// (LiveChart Timetable's owner found it). A frame with no width (hidden) isn't measured.
			let resizeTimer: ReturnType<typeof setTimeout> | null = null;
			window.addEventListener("resize", () => {
				if (resizeTimer) clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => {
					resizeTimer = null;
					const page = document.querySelector(".at-page");
					if (page && !page.clientWidth) return;
					const next = fitColumns();
					if (next === columns) return;
					columns = next;
					renderToolbar();
					if (viewStart && !neededDays(viewStart).every((d) => days[d])) requestWeek(viewStart);
					else renderTimetable();
				}, 150);
			});

			// Countdowns tick every second; the "now" line and past/future slots move with each minute
			let lastMinute = Math.floor(Date.now() / 60000);
			setInterval(() => {
				document.querySelectorAll<HTMLElement>("[data-until]").forEach((el) => {
					el.textContent = until(Number(el.dataset.until));
				});
				const minute = Math.floor(Date.now() / 60000);
				if (minute !== lastMinute) {
					lastMinute = minute;
					renderTimetable();
				}
			}, 1000);

			// ------------------------------------------------------------------------------------------------------------
			// Messages from the plugin
			// ------------------------------------------------------------------------------------------------------------

			/** Seanime's styles: its stylesheets, its <style> texts and its <html> class and style, as on its page */
			function applyStyles(s: AT.Styles) {
				const root = document.documentElement;
				const head = document.head;
				// Compared as written: Seanime's own are paths, which resolve against the Seanime the page is shown in
				const have = Array.from(head.querySelectorAll<HTMLLinkElement>("link[data-at-seanime]"));
				for (const link of have) if (!s.stylesheets.includes(link.getAttribute("href") || "")) link.remove();
				for (const href of s.stylesheets) {
					if (have.some((l) => l.getAttribute("href") === href)) continue;
					const link = document.createElement("link");
					link.rel = "stylesheet";
					link.href = href;
					link.setAttribute("data-at-seanime", "");
					head.insertBefore(link, head.firstChild);
				}
				const text = s.styles.join("\n");
				let tag = head.querySelector<HTMLStyleElement>("style[data-at-seanime]");
				if (!tag) {
					tag = document.createElement("style");
					tag.setAttribute("data-at-seanime", "");
					head.appendChild(tag);
				}
				if (tag.textContent !== text) tag.textContent = text;
				root.className = s.htmlClass;
				root.setAttribute("style", s.htmlStyle || "");
				if (s.font) {
					// Inter behind Seanime's first family, ahead of the generic fallbacks
					const families = s.font.split(",");
					root.style.setProperty("--at-font", [families[0], " Inter", ...families.slice(1)].join(","));
				}
			}

			interface Init {
				prefs: AT.Prefs;
				inferredTitles: AT.TitleLanguage;
				lists: any;
				lastStart: string | null;
			}
			function takeInit(msg: Init) {
				inferredTitles = msg.inferredTitles || "romaji";
				lists = msg.lists || {};
				// Every open page gets the init another one asked for: once started, a page keeps its days
				if (prefs) {
					renderTimetable();
					return;
				}
				prefs = msg.prefs;
				columns = fitColumns();
				// Where the user was last time, as the plugin remembers it
				requestWeek(msg.lastStart || today());
			}
			bridge.on("init", takeInit);

			// The settings: what's on screen is drawn again, no request
			bridge.on("prefs", (msg: { prefs: AT.Prefs }) => {
				prefs = msg.prefs;
				kept = {};
				renderTimetable();
			});

			// A day picked in Seanime's modal (a phone's date picker): the days from it
			bridge.on("go-to", (msg: { date: string }) => requestWeek(msg.date));

			// Escape closes the list of years, then the date picker
			document.addEventListener("keydown", (e) => {
				if (e.key !== "Escape" || !picker) return;
				if (picker.years) picker.years = false;
				else picker = null;
				renderPicker();
			});

			bridge.on("styles", (s: AT.Styles) => {
				applyStyles(s);
				document.documentElement.classList.remove("at-unstyled");
				const next = fitColumns();
				if (next !== columns) {
					columns = next;
					renderToolbar();
					renderTimetable();
				}
			});

			bridge.on("week", (msg: { start: string; days: AT.Day[]; error: string | null }) => {
				for (const day of msg.days || []) if (day.airings.length || !days[day.date]) days[day.date] = day;
				if (msg.start !== viewStart) return;
				loading = false;
				error = msg.error;
				shownStart = msg.start;
				renderToolbar();
				renderTimetable();
			});

			bridge.on("lists", (msg: { lists: any; inferredTitles?: AT.TitleLanguage }) => {
				keepShown();
				lists = msg.lists || {};
				if (msg.inferredTitles) inferredTitles = msg.inferredTitles;
				renderTimetable();
			});

			bridge.on("saved", (msg: { anilistId: number }) => {
				delete pending[msg.anilistId];
				renderTimetable();
			});

			// ------------------------------------------------------------------------------------------------------------
			// Start
			// ------------------------------------------------------------------------------------------------------------

			// Seanime's styles may never arrive (a first start with Seanime's page unreachable): show the page anyway
			setTimeout(() => document.documentElement.classList.remove("at-unstyled"), 2000);

			document.getElementById("app")!.innerHTML = `<div class="at-page">
				<div class="at-head"><h2>Anime Schedule</h2>
					<button class="${iconButton("rounded-lg " + C.grayBasic, C.iconSizeMd)}" data-act="settings" title="Settings">${icon("sliders")}</button></div>
				<div class="at-toolbar-box"><div class="at-toolbar" id="toolbar"></div><div class="at-datepop" id="datepop" hidden></div></div>
				<div id="timetable"></div>
			</div>`;
			columns = fitColumns();
			renderToolbar();
			// The plugin's latest init and the days it will show, in the page itself: drawn now, at their height, rather
			// than once the answer to ready comes (the frame grew then, moving Seanime's page under it). The days are
			// asked for as ever (requestWeek), and the init that comes back only refreshes the list.
			const boot = (window as any).AT_BOOT as { init: Init; days: AT.Day[] } | undefined;
			if (boot && boot.init && boot.init.prefs) {
				for (const day of boot.days || []) days[day.date] = day;
				takeInit(boot.init);
			}
			// Seanime's <style> texts (custom CSS, a custom theme) once the page has painted: written into the page, they
			// held up its first paint
			const styleTexts = ((window as any).AT_STYLE_TEXTS || []) as string[];
			if (styleTexts.length)
				requestAnimationFrame(() =>
					setTimeout(() => {
						const tag = document.head.querySelector<HTMLStyleElement>("style[data-at-seanime]");
						if (tag && !tag.textContent) tag.textContent = styleTexts.join("\n");
					}, 0),
				);
			const ready: AT.Ready = { timeZone: zone, hour12: browserHour12, offset: utcOffset() };
			send("ready", ready);
		}

		// Last: the page's styles above must exist before Seanime asks for its content
		webview.setContent(() => page());
	});
}
