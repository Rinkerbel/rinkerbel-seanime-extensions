# Stable Continue Watching

A [Seanime](https://seanime.app) plugin that stops Continue Watching cards from swapping places when they tie in the
sorting you chose.

## The problem

Seanime sorts Continue Watching on the page by episode number and then by the sorting you chose. Cards that tie on
both keep the order the server sent them in, and that order changes every time Seanime rebuilds your library. With the
default sorting (air date, newest first), two anime on the same episode that aired the same day can swap places after
you watch something, refresh, or a plugin updates your list. Other sortings tie the same way, e.g. two anime on the
same episode with the same score.

## What it does

Before Continue Watching reaches the page, the plugin sorts it by AniList ID. Your chosen sorting
still decides the order; cards that tie in it now always come out in the same order.

It covers both Continue Watching lists: anime with downloaded episodes, and anime you stream (torrent, debrid or
online streaming, when the library includes them).

## Installation

In Seanime, open the extensions page, choose to add an extension, and paste this manifest URL:

```txt
https://raw.githubusercontent.com/rinkerbel/rinkerbel-seanime-extensions/main/plugins/Stable%20Continue%20Watching/stable-continue-watching.json
```

It has no settings and needs no permissions.
