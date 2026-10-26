# Custom Lists

A Seanime plugin for your AniList custom lists, for anime and manga:

- **In the list editor:** the card that opens from a title's edit button gets a **Custom lists** section, as on
  AniList: a checkbox for each of your custom lists, and **Hide from status lists**.
- **In the tray:** create, rename and delete custom lists.
- **Hidden entries show up in Seanime:** Seanime only sees entries that are in a status list (Watching, Planning…),
  so a title you hid from the status lists on AniList had no progress tracking and showed as not in your list. The
  plugin puts each one in the status list of its own status, inside Seanime only. AniList keeps it hidden.

## Using it

### A title's lists

Open the list editor for a title in your list (the edit button on its card or on its page). Tick the custom lists it
belongs in, then press the editor's **Save**: the lists save with the rest of the entry, in one request. Closing the
editor without saving drops the changes, as for its other fields.

**Hide from status lists** needs at least one custom list ticked, since a title hidden everywhere else would be in
no list at all.

The section only shows for titles already in your list. Add the title first, then open its editor.

### Managing lists

Open the **Custom Lists** tray and pick **Anime** or **Manga**.

- **Create:** type a name under the lists and press **Create**.
- **Rename:** AniList has no renaming, so the plugin makes the new list, moves every title across and deletes the
  old one. Big lists take a few seconds.
- **Delete:** removes the list. The titles stay in your AniList list.
- **Show in status lists:** on by default. Turn it off for a list whose hidden titles you'd rather Seanime didn't
  show in your status lists. The switch never changes anything on AniList. Turning it on shows the titles at once;
  turning it off makes Seanime reload your list from AniList once, a moment after your last switch.

## Permissions

| Scope | Why |
|---|---|
| `anilist`, `anilist-token` | Reads your custom lists from AniList and saves changes to them |
| `database` | Reads your AniList username and login |
| `storage` | Remembers which lists are left out of the status lists |

## Credits

Inspired by two earlier plugins: [AniList Custom Lists](https://github.com/faddix/anilist-custom-lists) by Faddix and
[Custom Lists to Status](https://github.com/AlwaysBorderRadius/custom-lists-to-status) by AlwaysBorderRadius.
