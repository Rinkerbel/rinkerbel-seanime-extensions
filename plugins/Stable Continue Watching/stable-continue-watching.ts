/// <reference path="../../typings/plugin.d.ts" />
/// <reference path="../../typings/system.d.ts" />
/// <reference path="../../typings/app.d.ts" />
/// <reference path="../../typings/core.d.ts" />

/**
 * Keeps Continue Watching in the same order between refreshes.
 *
 * Seanime's page sorts Continue Watching with stable sorts (by "Episode N", then by the chosen sorting), so cards that
 * tie on both keep the order the server sent them in. That order isn't fixed: the server sorts the watching list by
 * progress with an unstable sort, and builds the streaming list (debrid, torrent and online streaming) in whichever
 * order each anime's metadata finishes loading. So with any sorting, tied cards (e.g. two anime on episode 5 that aired
 * the same day) can swap places every time the library is rebuilt.
 *
 * Sorting both lists by AniList ID before they reach the page makes ties come out the same every time. The chosen
 * sorting still decides everything else. Each list is given back as a new array: Seanime takes it as a copy.
 */
// @ts-ignore
function init(): void {
	// Anime with downloaded episodes
	$app.onAnimeLibraryCollection((e) => {
		const list = e.libraryCollection?.continueWatchingList;
		if (e.libraryCollection && list?.length) {
			e.libraryCollection.continueWatchingList = [...list].sort(
				(a, b) => (a.baseAnime?.id ?? 0) - (b.baseAnime?.id ?? 0),
			);
		}
		e.next();
	});

	// Anime watched by streaming, when the library includes them
	$app.onAnimeLibraryStreamCollection((e) => {
		const list = e.streamCollection?.continueWatchingList;
		if (e.streamCollection && list?.length) {
			e.streamCollection.continueWatchingList = [...list].sort(
				(a, b) => (a.baseAnime?.id ?? 0) - (b.baseAnime?.id ?? 0),
			);
		}
		e.next();
	});
}
