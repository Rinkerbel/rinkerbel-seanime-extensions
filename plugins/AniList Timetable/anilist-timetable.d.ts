/** AniList Timetable's own types, shared by the plugin and its webview */
declare namespace AT {
	/**
	 * A title's place in the user's AniList list, as the timetable filters it: its list status, or Unlisted for a
	 * title that isn't in the list (the global schedule's)
	 */
	type Mark = "completed" | "rewatching" | "watching" | "planning" | "paused" | "dropped" | "unlisted";

	type TitleLanguage = "romaji" | "english";

	/** What the user set in Settings, kept in $storage. The page filters every title by them. */
	interface Prefs {
		/** The marks whose titles show; Unlisted is the global schedule */
		marks: Mark[];
		/** AniList's formats shown (MediaFormat); a title with none always shows */
		formats: string[];
		/** The countries shown: JP, CN (China and Taiwan) and KR, AniList's countryOfOrigin; a title from elsewhere always shows */
		countries: string[];
		/** Adult titles hidden, shown, or only they */
		adult: "hide" | "show" | "only";
		/** null: the browser's clock */
		clock: "12" | "24" | null;
	}

	/** What the webview's browser says, for what's left to it */
	interface Browser {
		timeZone: string;
		hour12: boolean;
	}

	/** What the page sends when it starts */
	interface Ready extends Browser {
		/** The UTC offset of the browser's time zone, in minutes, for the dates the plugin writes */
		offset: number;
	}

	/** Seanime's own styles, read from its page for the webview: no colour or font of the plugin's own */
	interface Styles {
		/**
		 * Seanime's stylesheets. Its own are paths ("/static/css/index.css"), which the page resolves against the
		 * Seanime it's shown in (each client has its own address); others are absolute URLs.
		 */
		stylesheets: string[];
		/** The text of Seanime's <style> elements (custom CSS, a custom theme) */
		styles: string[];
		htmlClass: string;
		htmlStyle: string;
		/** Seanime's font-family */
		font: string;
	}

	/** A title, trimmed to what the timetable shows */
	interface Anime {
		/** AniList's ID */
		id: number;
		romaji: string;
		english: string | null;
		poster: string | null;
		/** Episode count, when known */
		episodes: number | null;
		/** AniList's MediaFormat (TV, TV_SHORT, MOVIE, ONA, ...) */
		format: string | null;
		/** What Seanime's Discover leaves out of its airing schedule: adult titles, titles not from Japan */
		adult: boolean;
		country: string | null;
	}

	/** An episode airing */
	interface Airing {
		/** Epoch milliseconds */
		time: number;
		episode: number;
		anime: Anime;
	}

	/** A UTC day of airings, as cached: the page sorts them into the days of its own time zone */
	interface Day {
		/** YYYY-MM-DD, UTC */
		date: string;
		airings: Airing[];
	}

	/** A cached day and when it was fetched */
	interface Cached<T> {
		at: number;
		data: T;
	}

	/** The cache in $storage: UTC days by date */
	interface Cache {
		version?: number;
		days: Record<string, Cached<Day>>;
	}

	/** An entry in the user's AniList list, as the page needs it */
	interface ListEntry {
		status: string;
		progress: number;
		/** The media's episode count, when AniList knows it */
		episodes: number | null;
	}

	/** What Seanime's modal shows */
	type View =
		/** The timetable's date picker on a phone, Seanime's modal: the day on screen, and the month shown (YYYY-MM) */
		| { kind: "date"; selected: string; month: string }
		/** Settings, as picked before Save */
		| { kind: "settings"; draft: Prefs };
}
