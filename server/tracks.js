import { unprocessable } from "./errors.js";

export const TRACKS = Object.freeze([
  { position: 1, slug: "01-feryad-akustik", title: "Feryad", variant: "Akustik" },
  { position: 2, slug: "02-ask-afeti-cihandir", title: "Aşk Afeti Cihandır", variant: null },
  { position: 3, slug: "03-kalir", title: "Kalır", variant: null },
  { position: 4, slug: "04-bir", title: "Bir", variant: null },
  { position: 5, slug: "05-yandi", title: "Yandı", variant: null },
  { position: 6, slug: "06-bana-sen-gereksin-sen", title: "Bana Sen Gereksin Sen", variant: null },
  { position: 7, slug: "07-ask-afeti-cihandir-classic", title: "Aşk Afeti Cihandır", variant: "Klasik" },
  { position: 8, slug: "08-kalir-akustik", title: "Kalır", variant: "Akustik" },
  { position: 9, slug: "09-yandi-akustik", title: "Yandı", variant: "Akustik" },
  { position: 10, slug: "10-bana-sen-gereksin-akustik", title: "Bana Sen Gereksin", variant: "Akustik" },
  { position: 11, slug: "11-feryad", title: "Feryad", variant: null },
  { position: 12, slug: "12-bir-gun", title: "Bir Gün", variant: null },
]);

const TRACK_SLUGS = new Set(TRACKS.map((track) => track.slug));
const TRACK_BY_SLUG = new Map(TRACKS.map((track) => [track.slug, track]));

export function validateTrackSlug(value, { optional = false } = {}) {
  if ((value === null || value === undefined || value === "") && optional) return null;
  if (typeof value !== "string" || !TRACK_SLUGS.has(value)) {
    throw unprocessable("Geçerli bir şarkı seçin.", "GECERSIZ_SARKI");
  }
  return value;
}

export function getTrackLabel(slug) {
  if (!slug) return null;
  const track = TRACK_BY_SLUG.get(slug);
  if (!track) return null;
  return track.variant ? `${track.title} · ${track.variant}` : track.title;
}
