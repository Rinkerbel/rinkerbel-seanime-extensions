/** Custom Lists' own types */
declare namespace CL {
	type MediaType = "ANIME" | "MANGA";

	/** Custom lists whose entries stay out of Seanime's status lists, per media type. Every other list is included. */
	type Excluded = Partial<Record<MediaType, string[]>>;

	/** Puts the entries of included custom lists that are missing from the status lists into their status's list */
	type AddHiddenEntries = (collection: any, source: any, excluded: string[], type: MediaType) => number;

	/** Runs AddHiddenEntries for one of the collection hooks, at most once per cached collection */
	type MergeCollection = (type: MediaType, raw: boolean, fresh: boolean, collection: any) => void;

	/**
	 * After one of Seanime's own saves: notes that its next fetch of each collection is its own reload, and sets the
	 * entry in the copy of the lists (what AniList now has, null when deleted, left out when the save kept them)
	 */
	type KeepLists = (mediaId: number | null, entry?: { lists: string[]; hidden: boolean } | null) => void;

	/** The note keepLists leaves in $store (`ownFetch`): when, and which collections ("ANIME:raw") have reloaded since */
	interface OwnFetch {
		at: number;
		seen: string[];
	}

	/** What the list section in Seanime's entry editor shows */
	interface CardState {
		/** loading: looking up the entry; ready: editable; missing: the entry wasn't found; error: AniList failed */
		status: "loading" | "ready" | "missing" | "error";
		message: string;
		/** Every custom list of the media's type, in AniList's order */
		lists: string[];
		/** The lists the entry is in */
		selected: string[];
		hidden: boolean;
	}

	/** The plugin's copy of a type's lists from AniList (`lists:<type>` in $store), kept until Seanime next fetches from AniList */
	interface Memberships {
		/** Every custom list name, in AniList's order */
		names: string[];
		/** Each entry in the user's list, by media ID: the lists it's in and whether it's hidden from status lists */
		entries: Record<number, { lists: string[]; hidden: boolean }>;
	}

	/** A custom lists change in the open editor, waiting in $store (`pending:<media id>`) for the editor's Save */
	interface Pending {
		lists: string[];
		hidden: boolean;
		/** Which opening of the editor made it, so closing that editor can drop it */
		opening: number;
	}

	/** The section's elements in the open editor */
	interface Section {
		root: $ui.DOMElement;
		/** The list box, and the checkbox of each list in it */
		box: $ui.DOMElement;
		listBoxes: $ui.DOMElement[];
		hideBox: $ui.DOMElement;
		/** What each checkbox shows, so only changes go through the DOM bridge */
		drawn: Record<string, string>;
	}

	/** The entry the editor is open for */
	interface CardMedia {
		id: number;
		type: MediaType;
	}

	/** A custom list in the tray */
	interface ListRow {
		name: string;
		count: number;
		included: boolean;
	}
}
