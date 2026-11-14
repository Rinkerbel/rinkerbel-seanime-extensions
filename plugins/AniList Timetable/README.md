# AniList Timetable

A Seanime plugin that puts AniList's airing schedule on Seanime's Schedule page, in place of its calendar: a week
of episodes as a timetable, with your AniList list.

## Installation

In Seanime, open the extensions page, choose to add an extension, and paste this manifest URL:

```txt
https://raw.githubusercontent.com/rinkerbel/rinkerbel-seanime-extensions/main/plugins/AniList%20Timetable/anilist-timetable.json
```

## What it does

- **A week at a glance.** Each day is a column, with every episode at its time in your browser's time zone and a
  countdown to the next ones. A narrow window shows fewer days.
- **Move through the days.** The arrows move a day or a week, Today comes back to today, and the dates open a
  calendar to jump to any day.
- **Your list on it.** Each title on your list shows its status.
- **Other plugins' times.** When another plugin changes the times on Seanime's schedule (one using LiveChart's
  times, say), your list's episodes show at those times.
- **One click for an episode watched.** For titles you're watching or rewatching, an aired episode has a check that
  sets your progress to it.
- **Straight to the title.** Click a title, its poster or its status to open its page in Seanime.
- **Settings.** The button by the heading:
  - **Your list:** which list statuses show. By default your list without dropped titles, as Seanime's own Schedule
    page shows it.
  - **Global schedule:** turn on **Not on your list** for everything else airing.
  - **Formats** (TV, TV Short, Movie, ...) and **Countries** (Japan, China with Taiwan, South Korea), for every
    title, on your list or not.
  - **Adult titles:** hide them (at first), show them, or show only them.
  - **Clock:** 12-hour or 24-hour. Your browser's at first.

The missing and upcoming episodes on the Schedule page stay where they were, above and below the timetable.

## Requests

The schedule comes from AniList's public API, all of it: about one request for a week of days, each day kept for an
hour (and across restarts). The settings only choose what's shown, so changing them sends nothing. Moving through
days you've already seen costs nothing, and quick clicks through the weeks ask only for the week you stop on.
