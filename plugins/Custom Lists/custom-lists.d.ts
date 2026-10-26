/** Custom Lists' own types */
declare namespace CL {
	type MediaType = "ANIME" | "MANGA";

	/** Custom lists whose entries stay out of Seanime's status lists, per media type. Every other list is included. */
	type Excluded = Partial<Record<MediaType, string[]>>;

	/** Puts the entries of included custom lists that are missing from the status lists into their status's list */
	type AddHiddenEntries = (collection: any, source: any, excluded: string[], type: MediaType) => number;

	/** Runs AddHiddenEntries for one of the collection hooks, at most once per cached collection */
	type MergeCollection = (type: MediaType, raw: boolean, fresh: boolean, collection: any) => void;

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
		/** "": nothing to save; unsaved: changed, waiting for the editor's Save; saving; saved */
		save: "" | "unsaved" | "saving" | "saved";
	}

	/** The section's elements in the open editor */
	interface Section {
		root: $ui.DOMElement;
		note: $ui.DOMElement;
		/** The list box, and the checkbox of each list in it */
		box: $ui.DOMElement;
		listBoxes: $ui.DOMElement[];
		hideBox: $ui.DOMElement;
		/** What each checkbox and the note show, so only changes go through the DOM bridge */
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
