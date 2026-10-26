/// <reference path="../../typings/plugin.d.ts" />
/// <reference path="../../typings/system.d.ts" />
/// <reference path="../../typings/app.d.ts" />
/// <reference path="../../typings/core.d.ts" />
/// <reference path="./custom-lists.d.ts" />

/**
 * Custom Lists. Contents, in file order:
 *
 * init()
 *   SHARED STORES    $shared modules: putting hidden entries back into the status lists, once per collection
 *   HOOKS            the eight collection hooks (anime and manga, fresh and cached, with and without custom lists)
 *   UI CONTEXT       $ui.register, one runtime:
 *     1. Setup                    logging, the included lists setting
 *     2. AniList                  queries and mutations
 *     3. Seanime's collection     counts, finding an entry by title, refreshing Seanime
 *     4. Entry editor             the custom lists section in Seanime's list editor
 *     5. Tray                     creating, renaming and deleting lists, and which ones show in status lists
 *     6. Startup
 */
// @ts-ignore
function init(): void {
	// ====================================================================================================================
	// SHARED STORES: $shared modules, evaluated in every runtime that uses them
	// ====================================================================================================================

	/**
	 * AniList leaves entries that are "hidden from status lists" out of every status list, and Seanime drops custom
	 * lists from the collection it works with, so Seanime never sees those entries: no progress, no "in your list".
	 * This adds each one to the status list of its own status. It changes the collection in place and skips entries
	 * already there, so running it twice adds nothing.
	 */
	$shared.define("addHiddenEntries", () => {
		const fn: CL.AddHiddenEntries = (collection, source, excluded, type) => {
			const lists = collection?.MediaListCollection?.lists;
			const sourceLists = source?.MediaListCollection?.lists;
			if (!lists || !sourceLists) return 0;

			// Seanime's optional fields (name, status, isCustomList) reach JavaScript as objects wrapping the value:
			// isCustomList is truthy even when false, and === never matches. String() gives the value.
			const text = (v: unknown) => (v == null ? "" : String(v));
			// Seanime tells custom lists by their missing status
			const isCustom = (list: any) => text(list.isCustomList) === "true" || !text(list.status);

			// The status lists, and every entry already in one. Seanime's collections are Go slices: plain index loops
			// work on them where for...of and array methods may not.
			const present: Record<number, boolean> = {};
			const byStatus: Record<string, any> = {};
			for (let i = 0; i < lists.length; i++) {
				const list = lists[i];
				if (!list || isCustom(list)) continue;
				byStatus[text(list.status)] = list;
				const entries = list.entries || [];
				for (let j = 0; j < entries.length; j++) {
					const id = entries[j]?.media?.id;
					if (id) present[id] = true;
				}
			}

			const missing: Record<string, any[]> = {};
			let added = 0;
			for (let i = 0; i < sourceLists.length; i++) {
				const list = sourceLists[i];
				if (!list || !isCustom(list) || excluded.indexOf(text(list.name)) >= 0) continue;
				const entries = list.entries || [];
				for (let j = 0; j < entries.length; j++) {
					const entry = entries[j];
					const id = entry?.media?.id;
					const status = text(entry?.status);
					if (!id || !status || present[id]) continue;
					present[id] = true;
					(missing[status] = missing[status] || []).push(entry);
					added++;
				}
			}
			if (!added) return 0;

			const names: Record<string, string> = {
				CURRENT: type === "ANIME" ? "Watching" : "Reading",
				PLANNING: "Planning",
				COMPLETED: "Completed",
				DROPPED: "Dropped",
				PAUSED: "Paused",
				REPEATING: type === "ANIME" ? "Rewatching" : "Rereading",
			};
			const newLists: any[] = [];
			for (const status of Object.keys(missing)) {
				const list = byStatus[status];
				if (!list) {
					newLists.push({
						name: names[status] || status,
						status,
						isCustomList: false,
						entries: missing[status],
					});
					continue;
				}
				// A new slice assigned whole: the raw and plain collections share their status lists
				const entries: any[] = [];
				const old = list.entries || [];
				for (let j = 0; j < old.length; j++) entries.push(old[j]);
				list.entries = entries.concat(missing[status]);
			}
			if (newLists.length) {
				const all: any[] = [];
				for (let i = 0; i < lists.length; i++) all.push(lists[i]);
				collection.MediaListCollection.lists = all.concat(newLists);
			}
			return added;
		};
		return fn;
	});

	/**
	 * Seanime caches the collection after the fresh hook ran, and the cached hooks get that same object, so the
	 * entries added stay. A cached collection is checked once ($store marks it done); a fresh fetch marks both
	 * collections to be checked again, since Seanime refreshes the raw one and the plain one together.
	 */
	$shared.define("mergeCollection", () => {
		const fn: CL.MergeCollection = (type, raw, fresh, collection) => {
			const key = `merged:${type}:${raw ? "raw" : "plain"}`;
			if (fresh) $store.set(`merged:${type}:${raw ? "plain" : "raw"}`, false);
			else if ($store.get(key) === true) return;
			$store.set(key, true);
			try {
				const excluded = ($storage.get<CL.Excluded>("excluded") ?? {})[type] ?? [];
				// The plain collection has no custom lists: they come from the raw one
				const source = raw
					? collection
					: type === "ANIME"
						? $anilist.getRawAnimeCollection(false)
						: $anilist.getRawMangaCollection(false);
				const add = $shared.use<CL.AddHiddenEntries>("addHiddenEntries");
				const added = add(collection, source, excluded, type);
				if (added)
					console.log(
						`[Custom Lists] Added ${added} hidden ${type.toLowerCase()} entries to the status lists`,
					);
			} catch (err) {
				console.error(
					`[Custom Lists] Could not add hidden entries: ${err instanceof Error ? err.message : err}`,
				);
			}
		};
		return fn;
	});

	// ====================================================================================================================
	// HOOKS: each one is compiled from its own source, so all it uses is $shared
	// ====================================================================================================================
	// A throw would fail Seanime's request, so mergeCollection catches everything.

	$app.onGetAnimeCollection((e) => {
		$shared.use<CL.MergeCollection>("mergeCollection")("ANIME", false, true, e.animeCollection);
		e.next();
	});
	$app.onGetCachedAnimeCollection((e) => {
		$shared.use<CL.MergeCollection>("mergeCollection")("ANIME", false, false, e.animeCollection);
		e.next();
	});
	$app.onGetRawAnimeCollection((e) => {
		$shared.use<CL.MergeCollection>("mergeCollection")("ANIME", true, true, e.animeCollection);
		e.next();
	});
	$app.onGetCachedRawAnimeCollection((e) => {
		$shared.use<CL.MergeCollection>("mergeCollection")("ANIME", true, false, e.animeCollection);
		e.next();
	});
	$app.onGetMangaCollection((e) => {
		$shared.use<CL.MergeCollection>("mergeCollection")("MANGA", false, true, e.mangaCollection);
		e.next();
	});
	$app.onGetCachedMangaCollection((e) => {
		$shared.use<CL.MergeCollection>("mergeCollection")("MANGA", false, false, e.mangaCollection);
		e.next();
	});
	$app.onGetRawMangaCollection((e) => {
		$shared.use<CL.MergeCollection>("mergeCollection")("MANGA", true, true, e.mangaCollection);
		e.next();
	});
	$app.onGetCachedRawMangaCollection((e) => {
		$shared.use<CL.MergeCollection>("mergeCollection")("MANGA", true, false, e.mangaCollection);
		e.next();
	});

	// ====================================================================================================================
	// UI CONTEXT
	// ====================================================================================================================
	$ui.register((ctx) => {
		// ----------------------------------------------------------------------------------------------------------------
		// 1. Setup
		// ----------------------------------------------------------------------------------------------------------------
		const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
		const log = (message: string) => console.log(`[Custom Lists] ${message}`);
		const logError = (message: string, err: unknown) =>
			console.error(`[Custom Lists] ${message}: ${errorText(err)}`);
		const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
		/** A field of Seanime's collection: optional ones are objects wrapping the value (see addHiddenEntries) */
		const text = (v: unknown) => (v == null ? "" : String(v));

		/** Whether a list's entries show in Seanime's status lists. Lists are included unless turned off. */
		const isIncluded = (type: CL.MediaType, name: string) =>
			(($storage.get<CL.Excluded>("excluded") ?? {})[type] ?? []).indexOf(name) < 0;
		function setIncluded(type: CL.MediaType, name: string, included: boolean) {
			const excluded = $storage.get<CL.Excluded>("excluded") ?? {};
			const names = (excluded[type] ?? []).filter((n) => n !== name);
			if (!included) names.push(name);
			excluded[type] = names;
			$storage.set("excluded", excluded);
		}

		// ----------------------------------------------------------------------------------------------------------------
		// 2. AniList
		// ----------------------------------------------------------------------------------------------------------------
		// Seanime's own collection query doesn't ask for custom list memberships or the hidden flag, so those come
		// straight from AniList. $anilist.customQuery is synchronous: it holds up the plugin's UI until AniList answers.

		function anilist<T = any>(query: string, variables: Record<string, unknown>): T {
			const token = $database.anilist.getToken();
			if (!token) throw new Error("Log in to AniList first");
			return $anilist.customQuery<T>({ query, variables }, token);
		}

		const LIST_OPTIONS = `mediaListOptions { animeList { customLists } mangaList { customLists } }`;
		const listNamesIn = (data: any, type: CL.MediaType): string[] =>
			(type === "ANIME" ? data?.Viewer?.mediaListOptions?.animeList : data?.Viewer?.mediaListOptions?.mangaList)
				?.customLists ?? [];
		/** customLists(asArray: true) gives every list with whether the entry is in it */
		const enabledLists = (value: any): string[] =>
			Array.isArray(value) ? value.filter((l) => l?.enabled).map((l) => String(l.name)) : [];

		function fetchListNames(type: CL.MediaType): string[] {
			return listNamesIn(anilist(`query { Viewer { ${LIST_OPTIONS} } }`, {}), type);
		}

		/** The entry's lists and hidden flag, with every list name of its type. exists is false when it isn't on the list. */
		function fetchEntry(media: CL.CardMedia) {
			const query = `query ($mediaId: Int, $userName: String) {
				Viewer { ${LIST_OPTIONS} }
				MediaList(mediaId: $mediaId, userName: $userName) { customLists(asArray: true) hiddenFromStatusLists }
			}`;
			try {
				const data = anilist(query, { mediaId: media.id, userName: $database.anilist.getUsername() });
				return {
					exists: true,
					lists: listNamesIn(data, media.type),
					selected: enabledLists(data?.MediaList?.customLists),
					hidden: !!data?.MediaList?.hiddenFromStatusLists,
				};
			} catch (err) {
				// AniList answers a media that isn't on the list with "Not Found."
				if (/not found/i.test(errorText(err))) return { exists: false, lists: [], selected: [], hidden: false };
				throw err;
			}
		}

		function saveEntry(mediaId: number, lists: string[], hidden: boolean) {
			anilist(
				`mutation ($mediaId: Int, $lists: [String], $hidden: Boolean) {
					SaveMediaListEntry(mediaId: $mediaId, customLists: $lists, hiddenFromStatusLists: $hidden) { id }
				}`,
				{ mediaId, lists, hidden },
			);
		}

		function saveListNames(type: CL.MediaType, names: string[]) {
			const option = type === "ANIME" ? "animeListOptions" : "mangaListOptions";
			anilist(`mutation ($lists: [String]) { UpdateUser(${option}: { customLists: $lists }) { id } }`, {
				lists: names,
			});
		}

		function deleteList(type: CL.MediaType, name: string) {
			anilist(
				`mutation ($name: String, $type: MediaType) { DeleteCustomList(customList: $name, type: $type) { deleted } }`,
				{
					name,
					type,
				},
			);
		}

		/** Each entry in the list, with all the lists it's in */
		function fetchMembers(type: CL.MediaType, name: string) {
			const data = anilist(
				`query ($userName: String, $type: MediaType) {
					MediaListCollection(userName: $userName, type: $type) {
						lists { name isCustomList entries { mediaId customLists(asArray: true) } }
					}
				}`,
				{ userName: $database.anilist.getUsername(), type },
			);
			const group = (data?.MediaListCollection?.lists ?? []).find((l: any) => l?.isCustomList && l.name === name);
			return ((group?.entries ?? []) as any[]).map((e) => ({
				mediaId: Number(e.mediaId),
				lists: enabledLists(e.customLists),
			}));
		}

		/**
		 * AniList has no rename: a list renamed in UpdateUser loses its entries. So the new list is added, the entries are
		 * moved to it, and the old one is deleted.
		 */
		function renameList(type: CL.MediaType, oldName: string, newName: string) {
			const names = fetchListNames(type);
			if (names.indexOf(oldName) < 0) throw new Error(`"${oldName}" no longer exists`);
			if (names.some((n) => n !== oldName && sameName(n, newName)))
				throw new Error(`"${newName}" already exists`);
			saveListNames(type, names.concat([newName]));
			const members = fetchMembers(type, oldName);
			// A few entries per request keeps each one small
			for (let i = 0; i < members.length; i += 20) {
				const batch = members.slice(i, i + 20);
				const definitions: string[] = [];
				const fields: string[] = [];
				const variables: Record<string, unknown> = {};
				batch.forEach((member, j) => {
					definitions.push(`$m${j}: Int, $l${j}: [String]`);
					fields.push(`e${j}: SaveMediaListEntry(mediaId: $m${j}, customLists: $l${j}) { id }`);
					variables[`m${j}`] = member.mediaId;
					variables[`l${j}`] = member.lists.map((n) => (n === oldName ? newName : n));
				});
				anilist(`mutation (${definitions.join(", ")}) { ${fields.join(" ")} }`, variables);
			}
			deleteList(type, oldName);
			saveListNames(
				type,
				names.map((n) => (n === oldName ? newName : n)),
			);
			if (!isIncluded(type, oldName)) {
				setIncluded(type, oldName, true);
				setIncluded(type, newName, false);
			}
		}

		// ----------------------------------------------------------------------------------------------------------------
		// 3. Seanime's collection
		// ----------------------------------------------------------------------------------------------------------------
		const rawCollection = (type: CL.MediaType): any =>
			type === "ANIME" ? $anilist.getRawAnimeCollection(false) : $anilist.getRawMangaCollection(false);

		/** How many entries each custom list has, from Seanime's cached collection */
		function listCounts(type: CL.MediaType): Record<string, number> {
			const counts: Record<string, number> = {};
			const lists = rawCollection(type)?.MediaListCollection?.lists ?? [];
			for (let i = 0; i < lists.length; i++) {
				const list = lists[i];
				const custom = list && (text(list.isCustomList) === "true" || !text(list.status));
				if (custom && text(list.name)) counts[text(list.name)] = list.entries?.length ?? 0;
			}
			return counts;
		}

		/** The IDs of the entries in Seanime's collection with this title (the editor shows the user's preferred title) */
		function findByTitle(type: CL.MediaType, title: string): number[] {
			const ids: number[] = [];
			const lists = rawCollection(type)?.MediaListCollection?.lists ?? [];
			for (let i = 0; i < lists.length; i++) {
				const entries = lists[i]?.entries ?? [];
				for (let j = 0; j < entries.length; j++) {
					const media = entries[j]?.media;
					if (media?.id && text(media.title?.userPreferred).trim() === title && ids.indexOf(media.id) < 0)
						ids.push(media.id);
				}
			}
			return ids;
		}

		/** Has the open pages reload the collection, as Seanime does after its own edits */
		function reloadPages(type: CL.MediaType) {
			if (type === "ANIME") {
				$app.invalidateClientQuery([
					"ANIME-ENTRIES-get-anime-entry",
					"ANIME-COLLECTION-get-library-collection",
					"ANILIST-get-anime-collection",
					"ANILIST-get-raw-anime-collection",
					"ANILIST-get-raw-anime-collection-tags",
				]);
			} else {
				$app.invalidateClientQuery([
					"MANGA-get-manga-entry",
					"MANGA-get-anilist-manga-collection",
					"MANGA-get-raw-anilist-manga-collection",
					"MANGA-get-raw-anilist-manga-collection-tags",
					"MANGA-get-manga-collection",
				]);
			}
		}

		/**
		 * Fetches the collection from AniList again so the hooks rebuild it, then reloads the pages. Needed when AniList
		 * changed, and to take entries out of the status lists: nothing removes an entry the hooks added.
		 */
		function refreshSeanime(type: CL.MediaType) {
			try {
				if (type === "ANIME") $anilist.refreshAnimeCollection();
				else $anilist.refreshMangaCollection();
				reloadPages(type);
			} catch (err) {
				logError("Could not refresh Seanime's collection", err);
			}
		}

		/** Adds hidden entries to Seanime's cached collections now, with no request to AniList (a list turned on) */
		function addHiddenNow(type: CL.MediaType) {
			try {
				const add = $shared.use<CL.AddHiddenEntries>("addHiddenEntries");
				const excluded = ($storage.get<CL.Excluded>("excluded") ?? {})[type] ?? [];
				const raw = rawCollection(type);
				const plain =
					type === "ANIME" ? $anilist.getAnimeCollection(false) : $anilist.getMangaCollection(false);
				const added = add(plain, raw, excluded, type) + add(raw, raw, excluded, type);
				if (added) reloadPages(type);
			} catch (err) {
				logError("Could not add hidden entries", err);
			}
		}

		// ----------------------------------------------------------------------------------------------------------------
		// 4. Entry editor
		// ----------------------------------------------------------------------------------------------------------------
		// The section is built in Seanime's own page with the DOM API and Seanime's own classes (its Checkbox, field label
		// and input box), so the user's theme, the app's font and its scrollbar apply as they do to the editor's other
		// fields. A webview is a sandboxed iframe that gets none of them, and Seanime refuses it the font file.
		// The webview slot under the editor's form is still used, with no content, for its mount and unmount events:
		// they say when an editor opens and closes. Seanime doesn't say which media it's for, so that's read from the
		// editor: its title, and whether it says "rewatches" or "rereads".

		const FORM = "[data-anilist-media-entry-modal-form]";
		const editorSlot = ctx.newWebview({ slot: "after-media-entry-form", hidden: true });
		const cardState = ctx.state<CL.CardState>({
			status: "loading",
			message: "",
			lists: [],
			selected: [],
			hidden: false,
			save: "",
		});
		let cardMedia: CL.CardMedia | null = null;
		/** What AniList has for the open entry, to tell whether Save has anything to send */
		let saved: { selected: string[]; hidden: boolean } | null = null;
		/** The section's elements in the open editor, and what stops listening to them */
		let section: CL.Section | null = null;
		let stopListening: (() => void)[] = [];
		const sameLists = (a: string[], b: string[]) => a.length === b.length && a.every((n) => b.indexOf(n) >= 0);
		let page = { pathname: "", searchParams: {} as Record<string, string> };
		/** Counts the editor openings, so a slow lookup for one that has closed is dropped */
		let opening = 0;

		const setCard = (patch: Partial<CL.CardState>) => {
			cardState.set({ ...cardState.get(), ...patch });
			drawCard();
		};

		async function readEditor(): Promise<{ title: string; type: CL.MediaType | null }> {
			// The editor is a modal on media cards and small screens, and a popover on the entry page
			const titleEl =
				(await ctx.dom.queryOne(`[role="dialog"]:has(${FORM}) .UI-Modal__title`)) ??
				(await ctx.dom.queryOne(`.UI-Popover__root:has(${FORM}) > p`));
			const title = titleEl ? (await titleEl.getText()).trim() : "";
			// The repeat field's label; unreleased media have none
			const text = (await (await ctx.dom.queryOne(FORM))?.getText()) ?? "";
			const type = /rereads/i.test(text) ? "MANGA" : /rewatches/i.test(text) ? "ANIME" : null;
			return { title, type };
		}

		/** The media the editor is open for */
		async function findCardMedia(): Promise<CL.CardMedia | null> {
			const { title, type } = await readEditor();
			const pageType: CL.MediaType | null =
				page.pathname === "/entry" ? "ANIME" : page.pathname === "/manga/entry" ? "MANGA" : null;
			const pageId = pageType ? parseInt(page.searchParams.id ?? "", 10) : NaN;
			if (!title) return pageType && pageId ? { id: pageId, type: pageType } : null;

			const matches: CL.CardMedia[] = [];
			for (const t of (type ? [type] : ["ANIME", "MANGA"]) as CL.MediaType[]) {
				for (const id of findByTitle(t, title)) matches.push({ id, type: t });
			}
			// The entry page's own media first: titles can repeat (an anime and its manga)
			const onPage = matches.find((m) => m.id === pageId && m.type === pageType);
			if (onPage) return onPage;
			if (matches.length > 1) log(`"${title}" matches ${matches.length} entries; using the first`);
			return matches[0] ?? null;
		}

		// Seanime's Checkbox (components/ui/checkbox), class for class, so it looks and behaves like the app's own:
		// gray-700 until checked, then the brand colour with Seanime's check icon
		const CHECKBOX_ROOT = [
			"UI-Checkbox__root",
			"appearance-none peer block relative overflow-hidden transition h-5 w-5 shrink-0 text-white rounded-[--radius-md] ring-offset-1 border ring-offset-[--background]",
			"border-gray-300 dark:border-gray-700",
			"outline-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40 disabled:cursor-not-allowed data-[disabled=true]:opacity-50",
			"data-[state=unchecked]:bg-white dark:data-[state=unchecked]:bg-gray-700",
			"data-[state=unchecked]:hover:bg-gray-100 dark:data-[state=unchecked]:hover:bg-gray-600",
			"data-[state=checked]:bg-brand dark:data-[state=checked]:bg-brand data-[state=checked]:border-brand",
		].join(" ");
		const CHECK_ICON =
			'<span data-state="checked" class="UI-Checkbox__indicator flex h-full w-full items-center justify-center relative">' +
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" stroke="currentColor" fill="currentColor" class="UI-Checkbox__checkIcon absolute h-4 w-4">' +
			'<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>' +
			"</svg></span>";
		const escapeHtml = (s: string) =>
			s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
		/** One checkbox row; the row is what's clicked, so its label toggles it too */
		const checkboxRow = (attr: string, label: string, className: string) =>
			`<div ${attr} class="UI-Checkbox__container inline-flex gap-2 items-center cursor-pointer select-none ${className}">` +
			`<button type="button" role="checkbox" aria-checked="false" data-state="unchecked" class="${CHECKBOX_ROOT}"></button>` +
			`<label class="UI-Checkbox_label font-normal cursor-pointer min-w-0 break-words">${escapeHtml(label)}</label></div>`;

		/** Ticks or unticks one of the section's checkboxes, as Radix does Seanime's */
		function setCheckbox(box: $ui.DOMElement, checked: boolean, disabled = false) {
			box.setAttribute("data-state", checked ? "checked" : "unchecked");
			box.setAttribute("aria-checked", String(checked));
			box.setInnerHTML(checked ? CHECK_ICON : "");
			if (disabled) {
				box.setAttribute("disabled", "");
				box.setAttribute("data-disabled", "true");
			} else {
				box.removeAttribute("disabled");
				box.removeAttribute("data-disabled");
			}
		}

		/** Adds the section to the open editor, above its Save row, with nothing in its list yet */
		async function mountSection(form: $ui.DOMElement): Promise<CL.Section> {
			const root = await ctx.dom.createElement("div");
			root.setAttribute("data-custom-lists-section", "");
			// w-0 min-w-full: no width of its own, the form's width. On the entry page the editor is a popover that
			// takes its content's natural width, so long list names arriving would otherwise widen it.
			root.setAttribute("class", "UI-BasicField__field relative w-0 min-w-full space-y-1");
			root.setInnerHTML(
				'<div class="flex items-center justify-between gap-2">' +
					'<label class="UI-BasicField__fieldLabel text-sm w-fit font-semibold self-start">Custom lists</label>' +
					'<span data-cl-note class="UI-BasicField__fieldHelpText text-[0.83rem] text-[--muted] break-words"></span>' +
					"</div>" +
					// Seanime's input box. A fixed height: the lists scroll inside it instead of the editor growing
					'<div data-cl-box class="UI-Input__root block w-full h-40 overflow-y-auto px-3 py-1 rounded-xl bg-gray-950 border border-[--border] shadow-sm"></div>' +
					checkboxRow("data-cl-hidden", "Hide from status lists", "pt-1"),
			);
			// The form's rows sit in a stack; the Save row is the one with the submit button
			const saveRow = await form.queryOne(`.space-y-3 > div:has(button[type="submit"])`);
			if (saveRow) saveRow.before(root);
			else form.append(root);
			const [note, box, hide] = await Promise.all([
				root.queryOne("[data-cl-note]"),
				root.queryOne("[data-cl-box]"),
				root.queryOne("[data-cl-hidden]"),
			]);
			const hideBox = await hide!.queryOne("button");
			stopListening.push(hide!.addEventListener("click", () => toggleHidden()));
			return { root, note: note!, box: box!, hideBox: hideBox!, listBoxes: [], drawn: {} };
		}

		/** Fills the list box: the lists, or a message. Rows are only rebuilt here, so ticking keeps the scroll position. */
		async function fillLists() {
			const s = section;
			if (!s) return;
			const { status, message, lists } = cardState.get();
			s.listBoxes = [];
			s.drawn = {};
			if (status !== "ready" || !lists.length) {
				const text =
					status === "loading"
						? "Loading..."
						: status === "ready"
							? "No custom lists yet. Create one in the Custom Lists tray."
							: message;
				s.box.setInnerHTML(
					`<div class="h-full flex items-center justify-center text-center text-sm text-[--muted]">${escapeHtml(text)}</div>`,
				);
				drawCard();
				return;
			}
			s.box.setInnerHTML(
				lists.map((name, i) => checkboxRow(`data-cl-list="${i}"`, name, "w-full py-1.5")).join(""),
			);
			const rows = await s.box.query("[data-cl-list]");
			if (section !== s) return;
			for (const row of rows) {
				const i = parseInt(row.attributes["data-cl-list"] ?? "", 10);
				stopListening.push(row.addEventListener("click", () => toggleList(i)));
			}
			s.listBoxes = await Promise.all(rows.map((row) => row.queryOne("button") as Promise<$ui.DOMElement>));
			drawCard();
		}

		/** Shows the state on the section's checkboxes and note. Each goes through the DOM bridge, so only changes are sent. */
		function drawCard() {
			const s = section;
			if (!s) return;
			const { status, lists, selected, hidden, save } = cardState.get();
			const draw = (key: string, value: string, apply: () => void) => {
				if (s.drawn[key] === value) return;
				s.drawn[key] = value;
				apply();
			};
			const note = { "": "", unsaved: "Saves with Save", saving: "Saving...", saved: "Saved" }[save];
			draw("note", note, () => s.note.setText(note));
			s.listBoxes.forEach((box, i) => {
				const checked = selected.indexOf(lists[i]) >= 0;
				draw(`list${i}`, String(checked), () => setCheckbox(box, checked));
			});
			const off = status !== "ready" || !selected.length;
			const hiddenOn = hidden && !off;
			draw("hidden", `${hiddenOn} ${off}`, () => setCheckbox(s.hideBox, hiddenOn, off));
		}

		function change(selected: string[], hidden: boolean) {
			if (!cardMedia || !saved || cardState.get().status !== "ready") return;
			// An entry hidden from the status lists and in no custom list would be nowhere on AniList
			hidden = hidden && selected.length > 0;
			const unchanged = sameLists(selected, saved.selected) && hidden === saved.hidden;
			setCard({ selected, hidden, save: unchanged ? "" : "unsaved" });
		}
		function toggleList(i: number) {
			const { lists, selected, hidden } = cardState.get();
			const name = lists[i];
			if (name == null) return;
			const ticked = selected.indexOf(name) >= 0;
			// Kept in AniList's order
			change(
				lists.filter((n) => (n === name ? !ticked : selected.indexOf(n) >= 0)),
				hidden,
			);
		}
		function toggleHidden() {
			const { selected, hidden } = cardState.get();
			change(selected, !hidden);
		}

		async function openCard() {
			const run = ++opening;
			closeCard(false);
			cardState.set({ status: "loading", message: "", lists: [], selected: [], hidden: false, save: "" });
			try {
				const form = await ctx.dom.queryOne(FORM);
				if (run !== opening || !form) return;
				const mounted = await mountSection(form);
				if (run !== opening) return;
				section = mounted;
				await fillLists();
				// The form's submit event: Seanime's Save button, or Enter in one of its fields
				stopListening.push(
					form.addEventListener("submit", () => {
						try {
							saveCard();
						} catch (err) {
							logError("Could not save the entry's lists", err);
						}
					}),
				);

				const media = await findCardMedia();
				if (run !== opening) return;
				if (!media) {
					setCard({ status: "missing", message: "Couldn't tell which entry this is." });
					await fillLists();
					return;
				}
				const entry = fetchEntry(media);
				if (run !== opening) return;
				if (!entry.exists) {
					setCard({ status: "missing", message: "Save the entry first." });
					await fillLists();
					return;
				}
				cardMedia = media;
				saved = { selected: entry.selected, hidden: entry.hidden };
				setCard({ status: "ready", lists: entry.lists, selected: entry.selected, hidden: entry.hidden });
				await fillLists();
			} catch (err) {
				logError("Could not load the entry's lists", err);
				if (run === opening) {
					setCard({ status: "error", message: errorText(err) });
					await fillLists();
				}
			}
		}

		/** Saves with the editor's own Save button, in one request, like the editor's other fields */
		function saveCard() {
			if (!cardMedia || !saved) return;
			const { selected, hidden } = cardState.get();
			if (sameLists(selected, saved.selected) && hidden === saved.hidden) return;
			const media = cardMedia;
			setCard({ save: "saving" });
			try {
				saveEntry(media.id, selected, hidden);
				saved = { selected, hidden };
				setCard({ save: "saved" });
				log(`Saved ${media.type.toLowerCase()} ${media.id}: ${selected.length} lists, hidden: ${hidden}`);
			} catch (err) {
				logError("Could not save the entry's lists", err);
				setCard({ save: "unsaved" });
				ctx.toast.error(`Custom lists not saved: ${errorText(err)}`);
				return;
			}
			// Seanime refreshes its collection after its own save too, but that can run before this one lands
			refreshSeanime(media.type);
		}

		/**
		 * Closing the editor without Save drops the changes, as for its other fields. Seanime removes the section with
		 * the editor; `remove` takes it out when a new editor opens over an old one.
		 */
		function closeCard(closed = true) {
			if (closed) opening++;
			cardMedia = null;
			saved = null;
			stopListening.forEach((stop) => stop());
			stopListening = [];
			if (!closed) section?.root.remove();
			section = null;
		}

		editorSlot.onMount(() => {
			openCard();
		});
		editorSlot.onUnmount(() => closeCard());

		// ----------------------------------------------------------------------------------------------------------------
		// 5. Tray
		// ----------------------------------------------------------------------------------------------------------------
		const tray = ctx.newTray({
			iconUrl:
				"https://raw.githubusercontent.com/rinkerbel/rinkerbel-seanime-extensions/main/plugins/Custom%20Lists/icon.png",
			withContent: true,
			width: "28rem",
		});
		const trayType = ctx.state<CL.MediaType>("ANIME");
		const rows = ctx.state<CL.ListRow[]>([]);
		const trayStatus = ctx.state<{ loading: boolean; busy: boolean; error: string }>({
			loading: false,
			busy: false,
			error: "",
		});
		/** The open rename or delete dialog */
		const dialog = ctx.state<{ kind: "" | "rename" | "delete"; name: string }>({ kind: "", name: "" });
		const newName = ctx.fieldRef<string>("");
		const renameTo = ctx.fieldRef<string>("");
		let cancelRefresh: (() => void) | null = null;

		function loadRows() {
			const type = trayType.get();
			trayStatus.set({ ...trayStatus.get(), loading: true, error: "" });
			try {
				const counts = listCounts(type);
				rows.set(
					fetchListNames(type).map((name) => ({
						name,
						count: counts[name] ?? 0,
						included: isIncluded(type, name),
					})),
				);
				trayStatus.set({ ...trayStatus.get(), loading: false });
			} catch (err) {
				logError("Could not load the lists", err);
				trayStatus.set({ ...trayStatus.get(), loading: false, error: errorText(err) });
			}
			tray.update();
		}

		/**
		 * Runs an AniList change with the tray showing it's busy. The AniList calls block the UI context, so the work
		 * waits a moment for the tray to render first.
		 */
		function runChange(description: string, work: () => string | void) {
			if (trayStatus.get().busy) return;
			trayStatus.set({ ...trayStatus.get(), busy: true });
			tray.update();
			ctx.setTimeout(() => {
				const type = trayType.get();
				try {
					const done = work();
					refreshSeanime(type);
					if (done) ctx.toast.success(done);
				} catch (err) {
					logError(`Could not ${description}`, err);
					ctx.toast.error(`Could not ${description}: ${errorText(err)}`);
				}
				trayStatus.set({ ...trayStatus.get(), busy: false });
				dialog.set({ kind: "", name: "" });
				loadRows();
			}, 50);
		}

		function createList() {
			const name = (newName.current ?? "").trim();
			if (!name) return;
			const type = trayType.get();
			if (rows.get().some((r) => sameName(r.name, name))) {
				ctx.toast.warning(`"${name}" already exists`);
				return;
			}
			runChange("create the list", () => {
				saveListNames(type, fetchListNames(type).concat([name]));
				newName.setValue("");
				return `Created "${name}"`;
			});
		}

		const button = (label: string, key: string, onClick: () => void, props: Record<string, unknown> = {}) =>
			tray.button(label, {
				size: "sm",
				intent: "gray-subtle",
				disabled: trayStatus.get().busy,
				...props,
				onClick: ctx.eventHandler(key, onClick),
			});

		function renameDialog(row: CL.ListRow) {
			const open = dialog.get().kind === "rename" && dialog.get().name === row.name;
			return tray.modal({
				trigger: button("Rename", `rename-${row.name}`, () => {
					renameTo.setValue(row.name);
					dialog.set({ kind: "rename", name: row.name });
					tray.update();
				}),
				title: `Rename "${row.name}"`,
				open,
				onOpenChange: ctx.eventHandler(`rename-open-${row.name}`, ({ open }: { open: boolean }) => {
					if (!open) dialog.set({ kind: "", name: "" });
					tray.update();
				}),
				items: [
					tray.input({ fieldRef: renameTo, placeholder: "New name" }),
					tray.flex(
						[
							button(
								"Rename",
								`rename-confirm-${row.name}`,
								() => {
									const to = (renameTo.current ?? "").trim();
									if (!to || to === row.name) return;
									const type = trayType.get();
									runChange("rename the list", () => {
										renameList(type, row.name, to);
										return `Renamed "${row.name}" to "${to}"`;
									});
								},
								{ intent: "primary", loading: trayStatus.get().busy },
							),
						],
						{ className: "justify-end" },
					),
				],
			});
		}

		function deleteDialog(row: CL.ListRow) {
			const open = dialog.get().kind === "delete" && dialog.get().name === row.name;
			return tray.modal({
				trigger: button(
					"Delete",
					`delete-${row.name}`,
					() => {
						dialog.set({ kind: "delete", name: row.name });
						tray.update();
					},
					{ intent: "alert-subtle" },
				),
				title: `Delete "${row.name}"?`,
				description: "The entries stay in your AniList list. Only this custom list goes.",
				open,
				onOpenChange: ctx.eventHandler(`delete-open-${row.name}`, ({ open }: { open: boolean }) => {
					if (!open) dialog.set({ kind: "", name: "" });
					tray.update();
				}),
				items: [
					tray.flex(
						[
							button(
								"Delete",
								`delete-confirm-${row.name}`,
								() => {
									const type = trayType.get();
									runChange("delete the list", () => {
										deleteList(type, row.name);
										setIncluded(type, row.name, true);
										return `Deleted "${row.name}"`;
									});
								},
								{ intent: "alert", loading: trayStatus.get().busy },
							),
						],
						{ className: "justify-end" },
					),
				],
			});
		}

		function listRow(row: CL.ListRow) {
			const type = trayType.get();
			return tray.div(
				[
					tray.flex(
						[
							tray.stack(
								[
									tray.text(row.name, { className: "font-semibold break-all" }),
									tray.text(`${row.count} ${row.count === 1 ? "entry" : "entries"}`, {
										className: "text-xs text-[--muted]",
									}),
								],
								{ gap: 0, className: "flex-1 min-w-0" },
							),
							renameDialog(row),
							deleteDialog(row),
						],
						{ gap: 2, className: "items-center" },
					),
					tray.switch("Show in status lists", {
						value: row.included,
						size: "sm",
						disabled: trayStatus.get().busy,
						onChange: ctx.eventHandler(`include-${type}-${row.name}`, ({ value }: { value: boolean }) => {
							setIncluded(type, row.name, value);
							rows.set(rows.get().map((r) => (r.name === row.name ? { ...r, included: value } : r)));
							tray.update();
							// Turning a list on changes Seanime's cache in place, with no request. Turning one off needs the
							// collection fetched again (one request, shared by switches turned off in a row).
							if (value && !cancelRefresh) addHiddenNow(type);
							else {
								cancelRefresh?.();
								cancelRefresh = ctx.setTimeout(() => {
									cancelRefresh = null;
									refreshSeanime(type);
								}, 1500);
							}
						}),
					}),
				],
				{ className: "p-3 rounded-lg border border-[--border] flex flex-col gap-2" },
			);
		}

		tray.render(() => {
			const type = trayType.get();
			const status = trayStatus.get();
			const typeButton = (t: CL.MediaType, label: string) =>
				tray.button(label, {
					size: "sm",
					intent: t === type ? "primary" : "gray-subtle",
					disabled: status.busy,
					onClick: ctx.eventHandler(`type-${t}`, () => {
						if (t === trayType.get()) return;
						trayType.set(t);
						dialog.set({ kind: "", name: "" });
						loadRows();
					}),
				});

			const body = status.loading
				? tray.text("Loading...", { className: "text-[--muted]" })
				: status.error
					? tray.alert({ title: "Could not load the lists", description: status.error, intent: "alert" })
					: rows.get().length
						? tray.stack(rows.get().map(listRow), { gap: 2 })
						: tray.text("No custom lists yet.", { className: "text-[--muted]" });

			return tray.stack(
				[
					tray.flex(
						[
							tray.text("Custom Lists", { className: "font-semibold text-lg flex-1" }),
							typeButton("ANIME", "Anime"),
							typeButton("MANGA", "Manga"),
						],
						{ gap: 2, className: "items-center" },
					),
					tray.text(
						"Tick a title's lists in its list editor. Lists shown in status lists put their hidden entries back where Seanime can see them.",
						{
							className: "text-sm text-[--muted]",
						},
					),
					body,
					tray.flex(
						[
							tray.div([tray.input({ fieldRef: newName, placeholder: "New list" })], {
								className: "flex-1",
							}),
							button("Create", "create", createList, { intent: "primary", loading: status.busy }),
						],
						{ gap: 2, className: "items-center" },
					),
				],
				{ gap: 3 },
			);
		});

		tray.onOpen(() => {
			loadRows();
		});

		// ----------------------------------------------------------------------------------------------------------------
		// 6. Startup
		// ----------------------------------------------------------------------------------------------------------------
		ctx.screen.onNavigate((e) => {
			page = { pathname: e.pathname, searchParams: e.searchParams ?? {} };
		});
		ctx.screen.loadCurrent();
	});
}
