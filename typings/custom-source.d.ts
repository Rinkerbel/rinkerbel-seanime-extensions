/// <reference path="./app.d.ts" />

declare type Settings = {
    supportsAnime: boolean
    supportsManga: boolean
}

declare type ListResponse<T extends $app.AL_BaseAnime | $app.AL_BaseManga> = {
    media: T[]
    page: number
    totalPages: number
    total: number
}

declare abstract class CustomSource {
    getSettings(): Settings

    getAnime(ids: number[]): Promise<$app.AL_BaseAnime[]>

    getAnimeMetadata(id: number): Promise<$app.Metadata_AnimeMetadata | null>

    getAnimeWithRelations(id: number): Promise<$app.AL_CompleteAnime>

    getAnimeDetails(id: number): Promise<$app.AL_AnimeDetailsById_Media | null>

    getManga(ids: number[]): Promise<$app.AL_BaseManga[]>

    listAnime(search: string, page: number, perPage: number): Promise<ListResponse<$app.AL_BaseAnime>>

    getMangaDetails(id: number): Promise<$app.AL_MangaDetailsById_Media | null>

    listManga(search: string, page: number, perPage: number): Promise<ListResponse<$app.AL_BaseManga>>
}
