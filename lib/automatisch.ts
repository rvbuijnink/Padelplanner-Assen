// Automatisch plannen, boeken, uitnodigen en afzeggen. Alles draait om het begin van de partij (T):
// - Elk uur van 08:00 tot en met 17:00 zoekt de site partijen vanaf 7 dagen vooruit tot zo ver als de clubs te boeken zijn: vier spelers die qua niveau,
//   speelduur en tijd passen, met een club die ze alle vier op "ja" hebben staan en waar live een baan vrij is.
//   Kiest de club: vrije baan, dan goedkoopste per persoon, dan de club waar het langst geleden een partij was.
// - Eerst boekt een bereidwillige speler (met 06-nummer) de baan. Boekt die niet binnen een paar uur, dan wijst
//   de site de volgende bereidwillige speler aan. Pas na het boeken gaan de uitnodigingen de deur uit.
// - Uitnodigingen: 12 uur reactietijd; tussen 22:00 en 08:00 loopt de klok niet en gaan er geen mails uit.
//   Wie niet reageert of afzegt, wordt vervangen door de volgende passende speler.
// - Afzeggen: tot 72 uur voor T zoekt de site automatisch een vervanger. Tussen 72 en 50 uur kiest de boeker
//   "We zoeken een vervanger" of "Partij annuleren"; spelers mogen zelf iemand voorstellen. Om 50 uur beslist de boeker:
//   annuleren of doorgaan met drie. Na 48 uur kan er niet meer gratis worden geannuleerd.
// - Zegt de boeker af, dan wijst de site een andere bevestigde speler aan die de baan moet overnemen.
// - 06-nummers komen nooit in een e-mail; ze staan alleen op de partijpagina (zie lib/telefoon.ts).
import { randomBytes } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { spelers, beschikbaarheid, partijen, partijDeelnemers } from "../db/schema.js";
import { verstuur, verstuurWachtrij, nlMinuten, STIL_VAN, STIL_TOT, type Mail } from "./mail.js";
import { idsMetTelefoon } from "./telefoon.js";
// @ts-ignore - gedeelde planner-logica (CommonJS), ook gebruikt in de browser
import Planner from "../src/planner.cjs";
// @ts-ignore - standaardgegevens van de clubs
import clubsJson from "../public/clubs.json";

const P: any = Planner;
export const MAX_SPELERS = 4;
const UUR = 3600000;
const DAG = 86400000;
// Hoeveel partijen er per run hooguit automatisch worden aangemaakt.
const MAX_NIEUW_PER_RUN = 4;
// Partijen worden minstens een week vooruit gepland, tot 31 dagen vooruit (de langste termijn van een club, Peakz;
// populaire avonden zijn snel vol). Clubs die een dag nog niet openzetten slaat de live controle vanzelf over.
export const MIN_DAGEN_VOORUIT = 7;
// Zoeken gebeurt in de runs van 08:00 tot en met 17:00 (Nederlandse tijd), zodat de boeker zijn 4 uur nog dezelfde dag heeft.
const ZOEK_VAN = 8;
const ZOEK_TOT = 17;
// Elke run controleert eerst de beste momenten en daarna een wisselend deel van de rest, zodat in de loop van de dag alle momenten aan bod komen.
const VASTE_CHECKS = 4;
const KANDIDATEN = 40;
// Reactietijd op een uitnodiging en boektijd voor de boeker, in uren waarin de klok loopt (08:00–22:00).
export const REACTIE_UREN = 12;
export const BOEK_UREN = 4;
// Grenzen rond het begin van de partij (in uren voor T).
export const AUTO_VERVANGER_UREN = 72;
export const BESLIS_UREN = 50;
export const GRATIS_ANNULEREN_UREN = 48;
const MAX_BAAN_CHECKS = 12;
const MAX_ZOEKTIJD = 18000;

const env = (k: string): string | undefined => (globalThis as any).Netlify?.env?.get(k) ?? process.env[k];
export const siteUrl = () => (env("URL") || "https://planpadel.netlify.app").replace(/\/+$/, "");
const partijUrl = (id: number) => `${siteUrl()}/?tab=planning&partij=${id}`;
const naarPartij = (id: number) => ({ label: "Naar de partijpagina", url: partijUrl(id) });

// ---- Datum en tijd (Nederlandse tijd) ----
const utc = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
export const nlVandaag = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
const plusDagen = (k: string, n: number) => new Date(utc(k) + n * DAG).toISOString().slice(0, 10);
const maandag = (k: string) => plusDagen(k, -((new Date(utc(k)).getUTCDay() + 6) % 7));
const naarMin = (t: string) => {
  const [u, m] = t.split(":").map(Number);
  return u * 60 + m;
};
const naarTijd = (m: number) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
// Tijdstip (ms) van een Nederlandse datum + tijd.
export function nlMoment(datum: string, tijd: string) {
  const alsUtc = utc(datum) + naarMin(tijd) * 60000;
  const s = new Date(alsUtc).toLocaleString("sv-SE", { timeZone: "Europe/Amsterdam" });
  const verschuiving = Date.parse(s.replace(" ", "T") + "Z") - alsUtc;
  return alsUtc - verschuiving;
}
const startVan = (p: { datum: string; tijd: string }) => nlMoment(p.datum, p.tijd);
export const gratisTot = (p: { datum: string; tijd: string }) => startVan(p) - GRATIS_ANNULEREN_UREN * UUR;
const urenTot = (p: { datum: string; tijd: string }) => (startVan(p) - Date.now()) / UUR;
const dagTekst = (datum: string) =>
  new Date(utc(datum)).toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
export const momentTekst = (ms: number) =>
  new Date(ms).toLocaleString("nl-NL", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
const euro = (n: number) => "€ " + n.toFixed(2).replace(".", ",");

// Uiterste tijd: `uren` tellen alleen tussen 08:00 en 22:00 (de klok loopt 's nachts niet door).
// Nooit later dan 2 uur voor de partij.
export function deadline(vanaf: number, uren: number, partij?: { datum: string; tijd: string }) {
  let t = vanaf;
  let rest = uren * 60;
  for (let i = 0; i < 20 && rest > 0; i++) {
    const m = nlMinuten(t);
    if (m < STIL_TOT) { t += (STIL_TOT - m) * 60000; continue; }
    if (m >= STIL_VAN) { t += (1440 - m + STIL_TOT) * 60000; continue; }
    const stap = Math.min(rest, STIL_VAN - m);
    t += stap * 60000;
    rest -= stap;
  }
  t = Math.floor(t / 60000) * 60000;
  return partij ? Math.max(Math.min(t, startVan(partij) - 2 * UUR), vanaf + 30 * 60000) : t;
}
// Voor uitnodigingen van vóór de reactieklok: de oude regel (helft van de tijd tot de partij, 2 tot 12 uur).
export function reactieTotVan(r: { uitgenodigd: Date | string | null; reactieTot?: Date | string | null }, p: { datum: string; tijd: string }) {
  if (r.reactieTot) return new Date(r.reactieTot).getTime();
  const u = r.uitgenodigd ? new Date(r.uitgenodigd).getTime() : Date.now();
  return u + Math.min(12 * UUR, Math.max(2 * UUR, (startVan(p) - u) / 2));
}

// De maandagen van deze week en de weken waarin je al kunt reserveren (hooguit 6 weken vooruit).
export const komendeWeken = (vandaag: string) => Array.from({ length: 7 }, (_, i) => plusDagen(maandag(vandaag), 7 * i));

// ---- Gegevens laden ----
type Speler = typeof spelers.$inferSelect & { weken: Record<string, { tijdvakken: Record<string, string[]> }> };
type Deelnemer = typeof partijDeelnemers.$inferSelect;
type Partij = typeof partijen.$inferSelect & { rijen: Deelnemer[] };
type Context = { vandaag: string; spelers: Speler[]; partijen: Partij[]; clubs: any[]; metTelefoon: Set<number>; laatstePerClub: Record<string, string> };

// "gepland": gekozen voor een partij waarvan de baan nog geboekt wordt (nog niet uitgenodigd).
export const isActief = (d: { status: string }) => d.status === "gepland" || d.status === "uitgenodigd" || d.status === "bevestigd";
// De eerste vier actieve spelers (op volgorde van aanmelding) spelen; de rest is reserve.
export const spelendVan = (p: { rijen: Deelnemer[] }) => p.rijen.filter(isActief).sort((a, b) => new Date(a.aangemeld).getTime() - new Date(b.aangemeld).getTime());
const vierVan = (p: Partij) => spelendVan(p).slice(0, MAX_SPELERS);
const bevestigdVan = (p: Partij) => vierVan(p).filter((r) => r.status === "bevestigd");
const isCompleet = (p: Partij) => bevestigdVan(p).length === MAX_SPELERS;
// Opgelost: vier bevestigd, of de boeker besloot met drie door te gaan.
const isOpgelost = (p: Partij) => isCompleet(p) || (p.besluit === "drie" && bevestigdVan(p).length >= 3);

async function laad(): Promise<Context> {
  const vandaag = nlVandaag();
  const vanaf = plusDagen(vandaag, -14);
  const [sp, best, lijst, metTelefoon, laatst] = await Promise.all([
    db.select().from(spelers),
    db.select().from(beschikbaarheid).where(gte(beschikbaarheid.week, plusDagen(vandaag, -7))),
    db.select().from(partijen).where(gte(partijen.datum, vanaf)),
    idsMetTelefoon(),
    db.select({ clubId: partijen.clubId, datum: sql<string>`max(${partijen.datum})` }).from(partijen).where(eq(partijen.geannuleerd, false)).groupBy(partijen.clubId),
  ]);
  const ids = lijst.map((p) => p.id);
  const rijen = ids.length ? await db.select().from(partijDeelnemers).where(inArray(partijDeelnemers.partijId, ids)) : [];
  const laatstePerClub: Record<string, string> = {};
  for (const r of laatst) laatstePerClub[r.clubId] = String(r.datum).slice(0, 10);
  return {
    vandaag,
    spelers: sp.map((s) => {
      const weken: Speler["weken"] = {};
      for (const w of best) if (w.spelerId === s.id) weken[w.week] = { tijdvakken: w.tijdvakken };
      return { ...s, weken: P.vulStandaardweek(weken, s.standaardWeek, komendeWeken(vandaag)) };
    }),
    partijen: lijst.map((p) => ({ ...p, rijen: rijen.filter((r) => r.partijId === p.id) })),
    // Geen vaste prijzen of boekingstermijnen: vrije banen en prijzen komen live van de clubs.
    clubs: P.liveClubs((clubsJson as any).clubs),
    metTelefoon,
    laatstePerClub,
  };
}

// ---- Wie past bij een partij ----
function kanOp(s: Speler, datum: string, tijd: string, duur: number) {
  if (!s.duren.includes(String(duur))) return false;
  const tijden = P.tijdenVan(P.beschikbaarVan(s)[datum] || []);
  return P.vrijVanaf(tijden, naarMin(tijd)) >= duur;
}
const nivPast = (a: Speler, b: Speler) => P.wilMet(a.wensNiveaus, b.niveau) && P.wilMet(b.wensNiveaus, a.niveau);
const speeltAlOpDag = (ctx: Context, spelerId: number, datum: string, behalve?: number) =>
  ctx.partijen.some((q) => q.id !== behalve && !q.geannuleerd && q.datum === datum && q.rijen.some((r) => r.spelerId === spelerId && isActief(r)));
// Wie op een dag een uitnodiging afsloeg of liet verlopen, kan die dag kennelijk niet: niet opnieuw inplannen.
const nietOpDag = (r: { status: string }) => r.status === "afgezegd" || r.status === "verlopen";
const kanNietOpDag = (ctx: Context, spelerId: number, datum: string, behalve?: number) =>
  ctx.partijen.some((q) => q.id !== behalve && q.datum === datum && q.rijen.some((r) => r.spelerId === spelerId && nietOpDag(r)));
const teDichtBij = (ctx: Context, s: Speler, datum: string, behalve?: number) => {
  const rust = Math.max(0, Math.min(2, s.rustDagen ?? 0));
  if (!rust) return false;
  return ctx.partijen.some(
    (q) => q.id !== behalve && !q.geannuleerd && Math.abs(utc(q.datum) - utc(datum)) <= rust * DAG && q.rijen.some((r) => r.spelerId === s.id && isActief(r))
  );
};
function heeftRuimte(ctx: Context, s: Speler, datum: string, behalve?: number) {
  // "Wanneer het lukt": geen maximum per week; alleen eigen beschikbaarheid, rustdagen en één partij per dag tellen.
  if (s.frequentie === "wanneer-het-lukt") return true;
  const mijn = ctx.partijen.filter((p) => p.id !== behalve && !p.geannuleerd && p.rijen.some((r) => r.spelerId === s.id && isActief(r)));
  const week = maandag(datum);
  const dezeWeek = mijn.filter((p) => maandag(p.datum) === week).length;
  if (s.frequentie === "3x-per-week") return dezeWeek < 3;
  if (s.frequentie === "2x-per-week") return dezeWeek < 2;
  if (s.frequentie === "tweewekelijks") return mijn.filter((p) => Math.abs(utc(maandag(p.datum)) - utc(week)) <= 7 * DAG).length === 0;
  return dezeWeek === 0; // wekelijks
}
// Vervangers (en alle spelers) moeten de gekozen club op "ja" hebben staan.
const clubJa = (s: Speler, clubId: string, datum: string) => P.voorkeurVan(s, clubId, datum) !== "niet";

function pastBij(ctx: Context, s: Speler, p: { id?: number; datum: string; tijd: string; duur: number; clubId: string }, groep: Speler[], niv: (a: Speler, b: Speler) => boolean = nivPast) {
  if (!clubJa(s, p.clubId, p.datum)) return false;
  if (!kanOp(s, p.datum, p.tijd, p.duur)) return false;
  // Een gastspeler heeft geen speelsterkte: die telt niet mee bij het niveau van de groep.
  if (!groep.every((g) => g.gast || niv(s, g))) return false;
  if (!heeftRuimte(ctx, s, p.datum, p.id)) return false;
  if (speeltAlOpDag(ctx, s.id, p.datum, p.id)) return false;
  if (teDichtBij(ctx, s, p.datum, p.id)) return false;
  if (kanNietOpDag(ctx, s.id, p.datum, p.id)) return false;
  return true;
}
const aantalPartijen = (ctx: Context, s: Speler) =>
  ctx.partijen.filter((p) => p.datum >= ctx.vandaag && !p.geannuleerd && p.rijen.some((r) => r.spelerId === s.id && isActief(r))).length;
const keerGeboekt = (ctx: Context, s: Speler) => ctx.partijen.filter((q) => q.boekerId === s.id && q.geboekt).length;
// Wie kan boeken: bereid, met 06-nummer, en heeft het voor deze partij nog niet laten lopen.
const kanBoeken = (ctx: Context, s: Speler | undefined, p?: Partij): s is Speler =>
  !!s && s.boekBereid && ctx.metTelefoon.has(s.id) && !(p?.afgewezenBoekers ?? []).includes(s.id);

// ---- Agenda (.ics) ----
const icsTijd = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsTekst = (t: string) => t.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// Regels langer dan 75 tekens worden volgens de standaard gevouwen.
const vouw = (regel: string) => {
  const delen: string[] = [];
  let r = regel;
  while (r.length > 74) { delen.push(r.slice(0, 74)); r = " " + r.slice(74); }
  delen.push(r);
  return delen.join("\r\n");
};
function icsVan(ctx: Context, p: Partij) {
  const club = clubVan(ctx, p.clubId);
  const start = nlMoment(p.datum, p.tijd);
  const namen = spelendVan(p).slice(0, MAX_SPELERS).map((r) => spelerVan(ctx, r.spelerId)?.naam).filter(Boolean) as string[];
  const boeker = spelerVan(ctx, p.boekerId);
  const omschrijving =
    `Padel bij ${club.naam}, ${p.duur === 90 ? "1,5 uur" : "1 uur"}.\n` +
    (namen.length ? `Spelers: ${naamLijst(namen)}.\n` : "") +
    (boeker ? `${boeker.naam} boekt de baan.\n` : "") +
    `Bekijk de partij: ${siteUrl()}/?tab=planning`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Padelplanner Assen//NL",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:partij-${p.id}@padelplanner-assen`,
    `DTSTAMP:${icsTijd(Date.now())}`,
    `DTSTART:${icsTijd(start)}`,
    `DTEND:${icsTijd(start + p.duur * 60000)}`,
    `SUMMARY:${icsTekst(`Padel bij ${club.naam}`)}`,
    `LOCATION:${icsTekst(club.naam)}`,
    `DESCRIPTION:${icsTekst(omschrijving)}`,
    `URL:${siteUrl()}/?tab=planning`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Padel",
    "TRIGGER:-PT2H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].map(vouw).join("\r\n") + "\r\n";
}
const icsBijlage = (ctx: Context, p: Partij) => ({ naam: "padel.ics", inhoud: icsVan(ctx, p), type: "text/calendar; charset=utf-8; method=PUBLISH" });
const agendaLink = (p: Partij, spelerId: number) => {
  const t = p.rijen.find((r) => r.spelerId === spelerId)?.token;
  return t ? { label: "Zet in agenda", url: `${siteUrl()}/api/agenda?t=${t}` } : null;
};

// Agenda-afspraak voor een partij, alleen voor wie meespeelt (of de baan boekte).
export async function agendaVoor(partijId: number, spelerId: number) {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p) return null;
  const rij = p.rijen.find((r) => r.spelerId === spelerId);
  if (!(rij && isActief(rij)) && p.boekerId !== spelerId) return null;
  return icsVan(ctx, p);
}

// ---- E-mails ----
const clubVan = (ctx: Context, id: string) => ctx.clubs.find((c) => c.id === id) || { id, naam: id, boeken: siteUrl() };
const partijTekst = (ctx: Context, p: Partij | typeof partijen.$inferSelect) =>
  `${dagTekst(p.datum)} van ${p.tijd} tot ${naarTijd(naarMin(p.tijd) + p.duur)} bij ${clubVan(ctx, p.clubId).naam}`;
const naamLijst = (namen: string[]) => (namen.length > 1 ? namen.slice(0, -1).join(", ") + " en " + namen[namen.length - 1] : namen.join(""));
const spelerVan = (ctx: Context, id: number | null | undefined) => ctx.spelers.find((s) => s.id === id);
const kanMail = (s?: Speler): s is Speler => !!s && !!s.email && s.mailAan;
const antwoordLinks = (token: string) => [
  { label: "Ik doe mee", url: `${siteUrl()}/bevestig.html?t=${token}&a=ja` },
  { label: "Ik kan niet", url: `${siteUrl()}/bevestig.html?t=${token}&a=nee` },
];
// Deurcode (Valley Padel, Padel Rolde): een regel voor in de mail, of leeg als de club geen code gebruikt.
const deurcodeTekst = (ctx: Context, p: Partij) =>
  p.deurcode ? `Deurcode om de deur van de baan te openen: ${p.deurcode}\n`
    : clubVan(ctx, p.clubId).deurcode ? `De deurcode voor de baan volgt nog van ${spelerVan(ctx, p.boekerId)?.naam ?? "de boeker"}.\n` : "";
const namenVan = (ctx: Context, rijen: Deelnemer[]) => rijen.map((r) => spelerVan(ctx, r.spelerId)?.naam).filter(Boolean) as string[];

// Baanprijs: de live prijs die bij het plannen bij de club is gevonden.
function baanPrijs(_ctx: Context, p: Partij) {
  return p.baanPrijs ?? null;
}
export function bedragPP(ctx: Context, p: Partij, aantal = MAX_SPELERS) {
  const b = baanPrijs(ctx, p);
  return b == null ? null : b / aantal;
}
const bedragTekst = (ctx: Context, p: Partij, aantal = MAX_SPELERS) => {
  const b = bedragPP(ctx, p, aantal);
  return b == null ? "nog onbekend" : `${euro(b)} per persoon (baanprijs ${euro(baanPrijs(ctx, p)!)} gedeeld door ${aantal})`;
};
const geenNummer = "Je hebt nog geen 06-nummer ingevuld. Dat is nodig om een partij te bevestigen: vul het in bij Vaste instellingen.";

function boekerMail(ctx: Context, p: Partij, s: Speler): Mail | null {
  if (!kanMail(s)) return null;
  const club = clubVan(ctx, p.clubId);
  const anderen = namenVan(ctx, vierVan(p).filter((r) => r.spelerId !== s.id));
  return {
    aan: s.email!,
    naam: s.naam,
    onderwerp: `Boek jij de baan? Padel ${dagTekst(p.datum)} om ${p.tijd}`,
    tekst:
      `Hoi ${s.naam},\n\nEr is een partij voor je gevonden en jij bent gevraagd om de baan te boeken.\n\n` +
      `Wanneer: ${partijTekst(ctx, p)}\nMet: ${anderen.length ? naamLijst(anderen) : "nog onbekend"}\nBedrag: ${bedragTekst(ctx, p)}\n\n` +
      `${club.linkSoort === "racketiq" ? `De knop hieronder opent ${club.naam} met de datum, ${p.tijd} en de speelduur al ingevuld.` : club.linkSoort === "meetandplay" ? `De knop hieronder opent ${club.naam} op de juiste dag; kies daar ${p.tijd} en ${p.duur} minuten.` : `De knop hieronder opent de boekingspagina van ${club.naam}; kies daar ${dagTekst(p.datum)}, ${p.tijd} en ${p.duur} minuten.`}\n\n` +
      `Boek de baan vóór ${momentTekst(p.boekenTot ? new Date(p.boekenTot).getTime() : Date.now() + BOEK_UREN * UUR)}. ` +
      `Daarna maak je een Tikkie voor het bedrag per persoon en vul je de link in op de partijpagina, bij "Baan is geboekt". ` +
      `Pas dan krijgen de andere drie hun uitnodiging. Boek je niet op tijd, dan vragen we de volgende speler die wil boeken.\n\n` +
      `Gratis annuleren kan bij ${club.naam} tot 48 uur voor aanvang${club.annuleren ? ` (${club.annuleren})` : ""}.`,
    knoppen: [{ label: `Boek bij ${club.naam}`, url: P.boekLink(club, p.datum, p.tijd, p.duur) }, naarPartij(p.id)],
  };
}

function uitnodiging(ctx: Context, p: Partij, s: Speler, rij: Deelnemer, voorgesteldDoor?: Speler): Mail | null {
  if (!kanMail(s) || !rij.token) return null;
  const anderen = namenVan(ctx, vierVan(p).filter((r) => r.spelerId !== s.id));
  const boeker = spelerVan(ctx, p.boekerId);
  const tot = momentTekst(reactieTotVan(rij, p));
  return {
    aan: s.email!,
    naam: s.naam,
    onderwerp: `Padel ${dagTekst(p.datum)} om ${p.tijd}: doe je mee?`,
    tekst:
      `Hoi ${s.naam},\n\n` +
      (voorgesteldDoor ? `${voorgesteldDoor.naam} stelt je voor als vervanger voor een partij.\n\n` : "Volgens je beschikbaarheid kun je op dit moment, dus er is een partij voor je gevonden.\n\n") +
      `Wanneer: ${partijTekst(ctx, p)}\nMet: ${anderen.length ? naamLijst(anderen) : "nog onbekend"}\nBedrag: ${bedragTekst(ctx, p)}\n` +
      (p.geboekt ? `De baan is geboekt${boeker ? ` door ${boeker.naam}` : ""}.\n` + deurcodeTekst(ctx, p) +
        (p.betaallink ? `Doe je mee? Betaal dan je deel via de Tikkie: ${p.betaallink}\n` : "") : "") +
      `\nReageer vóór ${tot}. Reageer je niet op tijd, dan vragen we iemand anders.` +
      (ctx.metTelefoon.has(s.id) ? "" : `\n\n${geenNummer}`),
    knoppen: [...antwoordLinks(rij.token), ...(p.geboekt && p.betaallink ? [{ label: "Betaal je deel (Tikkie)", url: p.betaallink }] : [])],
  };
}

function gaatDoor(ctx: Context, p: Partij, vier: Speler[], boeker?: Speler): Mail[] {
  return vier.filter(kanMail).map((s) => {
    const rij = p.rijen.find((r) => r.spelerId === s.id);
    const ikBoek = s.id === boeker?.id;
    const tikkie = !ikBoek && !!p.betaallink && !rij?.betaald;
    return {
      aan: s.email!,
      naam: s.naam,
      onderwerp: `De partij van ${dagTekst(p.datum)} om ${p.tijd} gaat door`,
      bijlagen: [icsBijlage(ctx, p)],
      tekst:
        `Hoi ${s.naam},\n\nAlle vier spelers hebben bevestigd. De partij gaat door!\n\n` +
        `Wanneer: ${partijTekst(ctx, p)}\nSpelers: ${naamLijst(vier.map((x) => x.naam))}\n` +
        `Boeker: ${boeker ? (ikBoek ? "jij" : boeker.naam) : "nog onbekend"}\nBedrag: ${bedragTekst(ctx, p)}\n` + deurcodeTekst(ctx, p) + "\n" +
        (ikBoek ? (p.betaallink ? "Je Tikkie staat bij de partij." : "Zet nog een Tikkie bij de partij, dan kunnen de anderen betalen.")
          : tikkie ? `Betaal je deel via de Tikkie: ${p.betaallink}` : p.betaallink ? "Je hebt je deel al betaald." : `Er staat nog geen Tikkie bij de partij; die komt van ${boeker?.naam ?? "de boeker"}.`) +
        "\n\nDe 06-nummers van je medespelers staan op de partijpagina (niet in deze mail). Kun je toch niet? Klik daar op \"Ik kan niet meer\".",
      knoppen: [...(tikkie ? [{ label: "Betaal je deel (Tikkie)", url: p.betaallink! }] : []), ...(agendaLink(p, s.id) ? [agendaLink(p, s.id)!] : []), naarPartij(p.id)],
    };
  });
}

// Eenvoudige mail aan een lijst spelers.
function bericht(ctx: Context, p: Partij, ids: number[], onderwerp: string, tekst: (s: Speler) => string, knoppen?: { label: string; url: string }[]): Mail[] {
  return [...new Set(ids)].map((id) => spelerVan(ctx, id)).filter(kanMail).map((s) => ({
    aan: s.email!, naam: s.naam, onderwerp, tekst: `Hoi ${s.naam},\n\n` + tekst(s), knoppen: knoppen ?? [naarPartij(p.id)],
  }));
}

// ---- Bouwstenen ----
async function zetRij(p: Partij, spelerId: number, status: "gepland" | "uitgenodigd") {
  const token = randomBytes(18).toString("base64url");
  const nu = new Date();
  const reactieTot = status === "uitgenodigd" ? new Date(deadline(nu.getTime(), REACTIE_UREN, p)) : null;
  const waarden = { status, token, uitgenodigd: status === "uitgenodigd" ? nu : null, reactieTot, herinnerd: false, aangemeld: nu, betaald: false };
  await db
    .insert(partijDeelnemers)
    .values({ partijId: p.id, spelerId, ...waarden })
    .onConflictDoUpdate({ target: [partijDeelnemers.partijId, partijDeelnemers.spelerId], set: waarden });
  const rij = { partijId: p.id, spelerId, ...waarden } as Deelnemer;
  p.rijen = [...p.rijen.filter((r) => r.spelerId !== spelerId), rij];
  return rij;
}
async function zetStatus(p: Partij, spelerId: number, status: string) {
  await db.update(partijDeelnemers).set({ status }).where(and(eq(partijDeelnemers.partijId, p.id), eq(partijDeelnemers.spelerId, spelerId)));
  const r = p.rijen.find((x) => x.spelerId === spelerId);
  if (r) r.status = status;
}
async function zetPartij(p: Partij, set: Partial<typeof partijen.$inferInsert>) {
  await db.update(partijen).set(set).where(eq(partijen.id, p.id));
  Object.assign(p, set);
}

// Wijs (opnieuw) een boeker aan zolang de baan nog niet geboekt is. Geen bereidwillige speler meer: false.
async function wijsBoekerAan(ctx: Context, p: Partij, mails: Mail[]) {
  const kandidaten = vierVan(p).map((r) => spelerVan(ctx, r.spelerId)).filter((s) => kanBoeken(ctx, s, p) && s!.id !== p.boekerId) as Speler[];
  const boeker = kandidaten.sort((a, b) => keerGeboekt(ctx, a) - keerGeboekt(ctx, b) || a.id - b.id)[0];
  if (!boeker) return false;
  await zetPartij(p, { boekerId: boeker.id, boekenTot: new Date(deadline(Date.now(), BOEK_UREN, p)) });
  const m = boekerMail(ctx, p, boeker);
  if (m) mails.push(m);
  return true;
}

// De partij gaat niet door. Wie nog meedeed krijgt een mail (wie nog niet was uitgenodigd niet) en kan die dag opnieuw worden ingepland.
async function annuleer(ctx: Context, p: Partij, mails: Mail[], reden: string, iedereen = false) {
  const gelukt = await db.update(partijen).set({ geannuleerd: true, compleetGemeld: false })
    .where(and(eq(partijen.id, p.id), eq(partijen.geannuleerd, false))).returning({ id: partijen.id });
  p.geannuleerd = true;
  if (!gelukt.length) return;
  const actief = spelendVan(p);
  const gemaild = actief.filter((r) => iedereen || r.status !== "gepland" || r.spelerId === p.boekerId).map((r) => r.spelerId);
  if (actief.length) {
    await db.update(partijDeelnemers).set({ status: "geannuleerd" })
      .where(and(eq(partijDeelnemers.partijId, p.id), inArray(partijDeelnemers.status, ["gepland", "uitgenodigd", "bevestigd"])));
  }
  for (const r of actief) r.status = "geannuleerd";
  const boekers = [p.boekerId, p.vorigeBoekerId].filter((x): x is number => !!x);
  const gratis = Date.now() < gratisTot(p);
  mails.push(...bericht(ctx, p, [...gemaild, ...(p.geboekt ? boekers : [])], `Geannuleerd: padel ${dagTekst(p.datum)} om ${p.tijd}`, (s) =>
    `De partij van ${partijTekst(ctx, p)} gaat niet door. ${reden}\n\n` +
    (p.geboekt && boekers.includes(s.id)
      ? `Jij hebt de baan op je naam staan: annuleer hem zelf bij ${clubVan(ctx, p.clubId).naam}. ` +
        (gratis ? `Gratis annuleren kan tot ${momentTekst(gratisTot(p))}.` : "Gratis annuleren kan niet meer (minder dan 48 uur voor aanvang).") + "\n\n"
      : "") +
      "Je beschikbaarheid blijft staan: kunnen er op een ander moment vier spelers, dan plannen we automatisch een nieuwe partij.",
    [{ label: "Naar de Padelplanner", url: `${siteUrl()}/?tab=planning` }]));
}

// Na het boeken: de andere spelers uitnodigen.
async function stuurUitnodigingen(ctx: Context, p: Partij, mails: Mail[]) {
  for (const r of spelendVan(p)) {
    if (r.status !== "gepland" || r.spelerId === p.boekerId) continue;
    const rij = await zetRij(p, r.spelerId, "uitgenodigd");
    const m = uitnodiging(ctx, p, spelerVan(ctx, r.spelerId)!, rij);
    if (m) mails.push(m);
  }
}

// `laatste`: de speler die net bevestigde (bij oude partijen zonder boeker boekt die).
async function werkBij(ctx: Context, p: Partij, mails: Mail[], laatste?: number) {
  if (startVan(p) < Date.now() || p.geannuleerd) return;
  const uren = urenTot(p);

  // Aanvullen met de volgende passende speler: tot 72 uur voor aanvang, of tot 50 uur als de boeker "We zoeken een vervanger" koos.
  const magZoeken = p.automatisch && p.besluit !== "drie" && (uren > AUTO_VERVANGER_UREN || (p.besluit === "zoeken" && uren > BESLIS_UREN));
  if (magZoeken && spelendVan(p).length < MAX_SPELERS) {
    const groep = spelendVan(p).map((r) => spelerVan(ctx, r.spelerId)).filter(Boolean) as Speler[];
    const nieuw: Speler[] = [];
    const kandidaten = ctx.spelers
      .filter((s) => ctx.metTelefoon.has(s.id) && !p.rijen.some((r) => r.spelerId === s.id))
      .sort((a, b) => aantalPartijen(ctx, a) - aantalPartijen(ctx, b) || a.id - b.id);
    for (const s of kandidaten) {
      if (groep.length + nieuw.length >= MAX_SPELERS) break;
      if (pastBij(ctx, s, p, [...groep, ...nieuw])) nieuw.push(s);
    }
    for (const s of nieuw) {
      const rij = await zetRij(p, s.id, p.geboekt ? "uitgenodigd" : "gepland");
      if (p.geboekt) { const m = uitnodiging(ctx, p, s, rij); if (m) mails.push(m); }
    }
  }

  // Nog niet geboekt (nieuwe werkwijze): zonder vier spelers of zonder boeker gaat de partij niet door.
  if (!p.geboekt && p.boekenTot) {
    if (spelendVan(p).length < MAX_SPELERS) return annuleer(ctx, p, mails, "Er konden niet genoeg spelers op dat moment.");
    const boekerRij = vierVan(p).find((r) => r.spelerId === p.boekerId);
    if (!boekerRij && !(await wijsBoekerAan(ctx, p, mails))) return annuleer(ctx, p, mails, "Er was niemand die de baan kon boeken.");
    return;
  }
  // Oude partijen: nog niet geboekt en geen vervanger meer te vinden.
  if (!p.geboekt && !p.boekenTot && p.automatisch && spelendVan(p).length < MAX_SPELERS && p.rijen.some(nietOpDag) && !magZoeken) {
    return annuleer(ctx, p, mails, "Er is geen andere speler gevonden die op dat moment kan.");
  }

  const boeker = spelerVan(ctx, p.boekerId);
  if (!isOpgelost(p) && p.geboekt) {
    // 72 uur voor aanvang: de boeker kiest. Spelers mogen zelf iemand voorstellen.
    if (uren <= AUTO_VERVANGER_UREN && uren > BESLIS_UREN && !p.keuzeGemeld && !p.besluit) {
      await zetPartij(p, { keuzeGemeld: true });
      if (boeker) mails.push(...bericht(ctx, p, [boeker.id], `Kies: vervanger zoeken of annuleren (${dagTekst(p.datum)})`, () =>
        `Voor de partij van ${partijTekst(ctx, p)} zijn nog maar ${bevestigdVan(p).length} van de 4 spelers bevestigd, en de site zoekt niet meer automatisch.\n\n` +
        `Kies op de partijpagina: "We zoeken een vervanger" of "Partij annuleren". Om ${momentTekst(startVan(p) - BESLIS_UREN * UUR)} (50 uur voor aanvang) moet het beslist zijn, want gratis annuleren kan tot ${momentTekst(gratisTot(p))}.`));
      mails.push(...bericht(ctx, p, bevestigdVan(p).map((r) => r.spelerId).filter((id) => id !== boeker?.id), `Weet jij een vervanger? (${dagTekst(p.datum)})`, () =>
        `Voor de partij van ${partijTekst(ctx, p)} ontbreekt nog een speler. ${boeker?.naam ?? "De boeker"} kiest of we een vervanger zoeken of annuleren. Weet je iemand? Stel hem voor op de partijpagina.`));
    }
    // 50 uur voor aanvang: de boeker beslist: annuleren of doorgaan met drie.
    if (uren <= BESLIS_UREN && !p.beslisGemeld && p.besluit !== "drie") {
      await zetPartij(p, { beslisGemeld: true });
      if (boeker) mails.push(...bericht(ctx, p, [boeker.id], `Beslis nu: doorgaan of annuleren (${dagTekst(p.datum)})`, () =>
        `Er is nog geen oplossing voor de partij van ${partijTekst(ctx, p)}: ${bevestigdVan(p).length} van de 4 spelers zijn bevestigd.\n\n` +
        `Beslis op de partijpagina: "Partij annuleren" of "Doorgaan met drie" (dan delen jullie de baanprijs door drie: ${bedragTekst(ctx, p, 3)}).\n\n` +
        `Gratis annuleren kan tot ${momentTekst(gratisTot(p))}.`));
    }
  }

  // Compleet: vier spelers hebben bevestigd.
  if (!p.compleetGemeld && isCompleet(p)) {
    const vier = bevestigdVan(p).map((r) => spelerVan(ctx, r.spelerId)).filter(Boolean) as Speler[];
    let b = boeker;
    if (!b) {
      // Oude partijen: wie als laatste bevestigde boekt, anders wie het minst boekte.
      const kunnen = vier.filter((s) => !s.gast);
      b = kunnen.find((s) => s.id === laatste) ?? kunnen.slice().sort((x, y) => keerGeboekt(ctx, x) - keerGeboekt(ctx, y) || x.id - y.id)[0];
    }
    const gelukt = await db.update(partijen).set({ compleetGemeld: true, boekerId: b?.id ?? null })
      .where(and(eq(partijen.id, p.id), eq(partijen.compleetGemeld, false))).returning({ id: partijen.id });
    if (!gelukt.length) return;
    p.compleetGemeld = true;
    p.boekerId = b?.id ?? null;
    mails.push(...gaatDoor(ctx, p, vier, b));
  }
}

// Tekst over het gratis annuleren, voor op de site en in mails.
function gratisTekst(p: Partij) {
  const ms = gratisTot(p) - Date.now();
  if (ms <= 0) return "Gratis annuleren kan niet meer: de partij begint over minder dan 48 uur.";
  const u = Math.floor(ms / UUR);
  return `Nog ${u >= 48 ? Math.floor(u / 24) + " dagen en " + (u % 24) + " uur" : u + " uur"} om gratis te annuleren (tot ${momentTekst(gratisTot(p))}).`;
}

// ---- Baan geboekt / betaallink (Tikkie) ----
// Na "Baan is geboekt": de boeker staat op bevestigd en de andere spelers krijgen hun uitnodiging (met de Tikkie als die er is).
export async function markeerGeboekt(partijId: number) {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p) return;
  const mails: Mail[] = [];
  const boekerRij = p.rijen.find((r) => r.spelerId === p.boekerId);
  if (boekerRij && (boekerRij.status === "gepland" || boekerRij.status === "uitgenodigd")) await zetStatus(p, boekerRij.spelerId, "bevestigd");
  await zetPartij(p, { boekenTot: p.boekenTot ?? null });
  await stuurUitnodigingen(ctx, p, mails);
  // Wie al bevestigd had (oude partijen, of na een overname) hoort dat de baan geboekt is.
  const wie = spelerVan(ctx, p.boekerId)?.naam ?? "De boeker";
  for (const r of bevestigdVan(p)) {
    if (r.spelerId === p.boekerId) continue;
    const s = spelerVan(ctx, r.spelerId);
    if (!kanMail(s)) continue;
    const metLink = !!p.betaallink && !r.betaald;
    mails.push({
      aan: s.email!, naam: s.naam,
      onderwerp: `De baan is geboekt: padel op ${dagTekst(p.datum)}`,
      tekst: `Hoi ${s.naam},\n\n${wie} heeft de baan geboekt voor de partij van ${partijTekst(ctx, p)}.\nBedrag: ${bedragTekst(ctx, p)}\n` + deurcodeTekst(ctx, p) + "\n" +
        (metLink ? "Betaal je deel via de Tikkie hieronder." : `Er staat (nog) geen Tikkie bij de partij. Spreek met ${wie} af hoe je betaalt.`),
      knoppen: metLink ? [{ label: "Betaal je deel (Tikkie)", url: p.betaallink! }, naarPartij(p.id)] : [naarPartij(p.id)],
    });
  }
  await werkBij(ctx, p, mails);
  await verstuur(mails);
}

// Later (of een nieuwe) Tikkie: wie bevestigd heeft en nog niet betaalde krijgt hem per mail.
export async function meldBetaallink(partijId: number) {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || !p.betaallink) return;
  const mails: Mail[] = [];
  for (const r of bevestigdVan(p)) {
    if (r.spelerId === p.boekerId || r.betaald) continue;
    mails.push(...bericht(ctx, p, [r.spelerId], `Betaal je deel van de baan voor ${dagTekst(p.datum)}`, () =>
      `${spelerVan(ctx, p.boekerId)?.naam ?? "De boeker"} heeft een Tikkie bij de partij van ${partijTekst(ctx, p)} gezet.\nBedrag: ${bedragTekst(ctx, p, p.besluit === "drie" ? 3 : MAX_SPELERS)}`,
      [{ label: "Betaal je deel (Tikkie)", url: p.betaallink! }, naarPartij(p.id)]));
  }
  await verstuur(mails);
}

// Later (of een nieuwe) deurcode: wie bevestigd heeft of is uitgenodigd krijgt hem per mail.
export async function meldDeurcode(partijId: number) {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || !p.deurcode || !p.geboekt || p.geannuleerd) return;
  const ids = spelendVan(p).filter((r) => (r.status === "bevestigd" || r.status === "uitgenodigd") && r.spelerId !== p.boekerId).map((r) => r.spelerId);
  const mails = bericht(ctx, p, ids, `Deurcode voor de baan op ${dagTekst(p.datum)}`, () =>
    `${spelerVan(ctx, p.boekerId)?.naam ?? "De boeker"} heeft de deurcode bij de partij van ${partijTekst(ctx, p)} gezet.\n\n` + deurcodeTekst(ctx, p));
  await verstuur(mails);
}

// ---- Antwoorden op een uitnodiging en afzeggen ----
export type Antwoord = { ok: true; tekst: string; boeken?: { club: string; url: string }; betaallink?: string | null; bedrag?: number | null } | { ok: false; fout: string; status?: number };

export async function beantwoord(partijId: number, spelerId: number, ja: boolean): Promise<Antwoord> {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || startVan(p) < Date.now()) return { ok: false, fout: "Deze partij bestaat niet meer of is al voorbij.", status: 404 };
  if (p.geannuleerd) return ja ? { ok: false, fout: "Deze partij is geannuleerd.", status: 409 } : { ok: true, tekst: "Deze partij was al geannuleerd." };
  const s = spelerVan(ctx, spelerId);
  if (!s) return { ok: false, fout: "Onbekende speler.", status: 404 };
  const rij = p.rijen.find((r) => r.spelerId === spelerId);
  const mails: Mail[] = [];
  let tekst: string;

  if (ja) {
    if (!ctx.metTelefoon.has(s.id)) return { ok: false, fout: "Vul eerst je 06-nummer in bij Vaste instellingen. Dat is nodig om een partij te bevestigen; alleen je bevestigde medespelers zien het.", status: 409 };
    if (rij?.status === "gepland") return { ok: true, tekst: p.boekerId === s.id ? "Jij boekt de baan. Geboekt? Druk op de partijpagina op \"Baan is geboekt\"." : "De baan wordt eerst geboekt. Daarna krijg je een uitnodiging." };
    if (rij?.status === "bevestigd") return { ok: true, tekst: "Je had al bevestigd. Tot dan!", betaallink: p.betaallink, bedrag: bedragPP(ctx, p) };
    if (rij?.status === "verwijderd") return { ok: false, fout: "De beheerder heeft je uit deze partij gehaald.", status: 409 };
    if (rij?.status === "uitgenodigd") {
      await zetStatus(p, s.id, "bevestigd");
      tekst = "Top, je doet mee!";
    } else {
      if (!clubJa(s, p.clubId, p.datum)) return { ok: false, fout: `Je hebt ${clubVan(ctx, p.clubId).naam} op "nee" staan.`, status: 409 };
      if (speeltAlOpDag(ctx, s.id, p.datum, p.id)) return { ok: false, fout: "Je staat die dag al bij een andere partij.", status: 409 };
      const nu = new Date();
      const waarden = { status: "bevestigd", aangemeld: nu, token: rij?.token ?? randomBytes(18).toString("base64url") };
      await db.insert(partijDeelnemers).values({ partijId: p.id, spelerId: s.id, ...waarden })
        .onConflictDoUpdate({ target: [partijDeelnemers.partijId, partijDeelnemers.spelerId], set: waarden });
      p.rijen = [...p.rijen.filter((r) => r.spelerId !== s.id), { ...(rij ?? { partijId: p.id, spelerId: s.id, uitgenodigd: null, reactieTot: null, herinnerd: false, betaald: false }), ...waarden } as Deelnemer];
      tekst = vierVan(p).some((r) => r.spelerId === s.id) ? "Je doet mee!" : "De partij is al vol. Je staat op de reservelijst.";
    }
    if (p.betaallink && s.id !== p.boekerId) tekst += " Betaal je deel meteen via de Tikkie.";
  } else {
    if (!rij || !isActief(rij)) return { ok: true, tekst: "Je stond al niet (meer) bij deze partij." };
    const wasBevestigd = rij.status === "bevestigd";
    const speeldeMee = vierVan(p).some((r) => r.spelerId === s.id);
    const wasBoeker = p.boekerId === s.id;
    await zetStatus(p, s.id, "afgezegd");
    const uren = urenTot(p);
    tekst = "Je bent afgemeld. " + gratisTekst(p);
    if (wasBevestigd && uren <= GRATIS_ANNULEREN_UREN) tekst += " Regel zelf een vervanger (stel hem voor op de partijpagina) of betaal je deel.";

    if (wasBoeker && !p.geboekt) {
      // Nog niet geboekt: de volgende bereidwillige speler boekt.
      await zetPartij(p, { afgewezenBoekers: [...(p.afgewezenBoekers ?? []), s.id], boekerId: null });
    } else if (wasBoeker && p.geboekt) {
      // De boeker zegt af: een andere bevestigde speler neemt de baan over.
      const nieuw = (bevestigdVan(p).map((r) => spelerVan(ctx, r.spelerId)).filter(Boolean) as Speler[])
        .sort((a, b) => Number(b.boekBereid) - Number(a.boekBereid) || keerGeboekt(ctx, a) - keerGeboekt(ctx, b))[0];
      if (nieuw) {
        await zetPartij(p, { boekerId: nieuw.id, vorigeBoekerId: s.id, overnameNodig: true });
        mails.push(...bericht(ctx, p, [nieuw.id], `Neem jij de baan over? (${dagTekst(p.datum)})`, () =>
          `${s.naam} kan niet meer meedoen aan de partij van ${partijTekst(ctx, p)} en had de baan geboekt. Jij bent aangewezen als nieuwe boeker.\n\n` +
          `Spreek met ${s.naam} af hoe de boeking bij ${clubVan(ctx, p.clubId).naam} op jouw naam komt (annuleren gebeurt bij de club zelf; zonder overname blijft de baan op naam van ${s.naam} staan). ` +
          `Druk daarna op de partijpagina op "Ik neem de baan over" en zet er eventueel een nieuwe Tikkie bij. Het nummer van ${s.naam} vind je niet meer op de site; vraag het je medespelers als je het niet hebt.`));
        tekst += ` ${nieuw.naam} is gevraagd de baan over te nemen. Tot dat gebeurt, blijft de baan op jouw naam staan.`;
      } else tekst += " Er is geen andere bevestigde speler om de baan over te nemen; de baan blijft op jouw naam staan.";
    }
    if (speeldeMee && wasBevestigd) {
      if (p.compleetGemeld) await zetPartij(p, { compleetGemeld: false });
      const fase = uren > AUTO_VERVANGER_UREN ? "We zoeken automatisch een vervanger. Je krijgt een mail zodra de partij weer compleet is."
        : uren > BESLIS_UREN ? `${spelerVan(ctx, p.boekerId)?.naam ?? "De boeker"} kiest op de partijpagina: "We zoeken een vervanger" of "Partij annuleren". Weet je iemand? Stel hem daar voor.`
        : uren > GRATIS_ANNULEREN_UREN ? `${spelerVan(ctx, p.boekerId)?.naam ?? "De boeker"} beslist nu: annuleren of doorgaan met drie.`
        : `Gratis annuleren kan niet meer. ${s.naam} regelt zelf een vervanger of betaalt zijn deel.`;
      const ids = [...spelendVan(p).filter((r) => r.status !== "gepland").map((r) => r.spelerId), ...(p.boekerId ? [p.boekerId] : []), ...(p.vorigeBoekerId && p.vorigeBoekerId !== s.id ? [p.vorigeBoekerId] : [])];
      mails.push(...bericht(ctx, p, ids.filter((id) => id !== s.id), `${s.naam} kan niet meer op ${dagTekst(p.datum)}`, () =>
        `${s.naam} heeft zich afgemeld voor de partij van ${partijTekst(ctx, p)}.\n\n${fase}\n\n${gratisTekst(p)}`));
    }
  }
  // Opnieuw ophalen: bevestigde een andere speler net tegelijk, dan telt die ook mee.
  const [vers] = await db.select().from(partijen).where(eq(partijen.id, p.id));
  if (vers) Object.assign(p, vers);
  p.rijen = await db.select().from(partijDeelnemers).where(eq(partijDeelnemers.partijId, p.id));
  await werkBij(ctx, p, mails, ja ? s.id : undefined);
  await verstuur(mails);
  if (!ja && p.geannuleerd) tekst = "Je bent afgemeld. Daardoor gaat de partij niet door; de anderen krijgen een mail.";
  if (ja && p.compleetGemeld && vierVan(p).some((r) => r.spelerId === s.id)) tekst += " De partij is compleet en gaat door!";
  return { ok: true, tekst, betaallink: ja && s.id !== p.boekerId ? p.betaallink : null, bedrag: bedragPP(ctx, p) };
}

// ---- Keuzes van de boeker ----
export type Keuze = "nietboeken" | "bezet" | "zoeken" | "annuleren" | "drie" | "overnemen";
export async function boekerKeuze(partijId: number, spelerId: number, keuze: Keuze, beheer = false): Promise<Antwoord> {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || p.geannuleerd || startVan(p) < Date.now()) return { ok: false, fout: "Deze partij bestaat niet (meer).", status: 404 };
  if (p.boekerId !== spelerId && !beheer) return { ok: false, fout: "Alleen de boeker kan dit kiezen.", status: 403 };
  const mails: Mail[] = [];
  const boeker = spelerVan(ctx, p.boekerId);
  let tekst = "";
  if (keuze === "nietboeken") {
    if (p.geboekt) return { ok: false, fout: "De baan staat al op geboekt.", status: 409 };
    await zetPartij(p, { afgewezenBoekers: [...(p.afgewezenBoekers ?? []), spelerId] });
    if (!(await wijsBoekerAan(ctx, p, mails))) await annuleer(ctx, p, mails, "Er was niemand die de baan kon boeken.");
    tekst = p.geannuleerd ? "Er is niemand anders die wil boeken, dus de partij gaat niet door." : `${spelerVan(ctx, p.boekerId)?.naam} is gevraagd de baan te boeken. Jij speelt gewoon mee.`;
  } else if (keuze === "bezet") {
    // De baan bleek bij de club al bezet: boeken lukt niet, dus de partij gaat niet door. Alle spelers krijgen een mail.
    if (p.geboekt) return { ok: false, fout: "De baan staat al op geboekt. Kies dan \"Partij annuleren\".", status: 409 };
    const club = clubVan(ctx, p.clubId);
    await zetPartij(p, { besluit: "bezet" });
    await annuleer(ctx, p, mails, `${beheer && p.boekerId !== spelerId ? "De beheerder meldt" : `${boeker?.naam ?? "De boeker"} meldt`} dat de baan bij ${club.naam} al bezet was, dus boeken lukte niet.`, true);
    tekst = "De partij is geannuleerd. De andere spelers krijgen een mail dat de baan al bezet was.";
  } else if (keuze === "zoeken") {
    await zetPartij(p, { besluit: "zoeken" });
    mails.push(...bericht(ctx, p, bevestigdVan(p).map((r) => r.spelerId).filter((id) => id !== p.boekerId), `We zoeken een vervanger (${dagTekst(p.datum)})`, () =>
      `${boeker?.naam ?? "De boeker"} heeft gekozen: we zoeken een vervanger voor de partij van ${partijTekst(ctx, p)}. De site nodigt passende spelers uit tot 50 uur voor aanvang. Weet je zelf iemand? Stel hem voor op de partijpagina.`));
    await werkBij(ctx, p, mails);
    tekst = "We zoeken een vervanger. De site nodigt passende spelers uit tot 50 uur voor aanvang; de anderen kunnen ook iemand voorstellen.";
  } else if (keuze === "annuleren") {
    await annuleer(ctx, p, mails, `${boeker?.naam ?? "De boeker"} heeft de partij geannuleerd.`);
    tekst = `De partij is geannuleerd en iedereen krijgt een mail. Annuleer de baan zelf bij ${clubVan(ctx, p.clubId).naam}. ${gratisTekst(p)}`;
  } else if (keuze === "drie") {
    await zetPartij(p, { besluit: "drie" });
    mails.push(...bericht(ctx, p, bevestigdVan(p).map((r) => r.spelerId).filter((id) => id !== p.boekerId), `De partij gaat door met drie (${dagTekst(p.datum)})`, () =>
      `${boeker?.naam ?? "De boeker"} heeft besloten: de partij van ${partijTekst(ctx, p)} gaat door met drie spelers. Jullie delen de baanprijs: ${bedragTekst(ctx, p, 3)}.`));
    tekst = `De partij gaat door met drie. Het bedrag per persoon is nu ${bedragTekst(ctx, p, 3)}; pas je Tikkie zo nodig aan.`;
  } else if (keuze === "overnemen") {
    if (!p.overnameNodig) return { ok: true, tekst: "Er hoeft niets overgenomen te worden." };
    await zetPartij(p, { overnameNodig: false });
    if (p.vorigeBoekerId) mails.push(...bericht(ctx, p, [p.vorigeBoekerId], `${boeker?.naam} heeft de baan overgenomen`, () =>
      `${boeker?.naam} heeft de baan voor de partij van ${partijTekst(ctx, p)} overgenomen. Je hoeft er niets meer mee.`));
    tekst = "Je hebt de baan overgenomen. Zet er eventueel een nieuwe Tikkie bij.";
  }
  await verstuur(mails);
  return { ok: true, tekst };
}

// ---- Zelf een vervanger voorstellen ----
// Wie kan worden voorgesteld: heeft de club op "ja", staat niet al bij de partij en speelt die dag nog niet.
export async function kandidatenVoor(partijId: number) {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p) return [];
  return ctx.spelers
    .filter((s) => ctx.metTelefoon.has(s.id) && clubJa(s, p.clubId, p.datum) && !p.rijen.some((r) => r.spelerId === s.id && (isActief(r) || nietOpDag(r))) && !speeltAlOpDag(ctx, s.id, p.datum, p.id))
    .map((s) => ({ id: s.id, naam: s.naam }))
    .sort((a, b) => a.naam.localeCompare(b.naam));
}
export async function stelVoor(partijId: number, doorId: number, kandidaatId: number, beheer = false): Promise<Antwoord> {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || p.geannuleerd || startVan(p) < Date.now()) return { ok: false, fout: "Deze partij bestaat niet (meer).", status: 404 };
  const door = spelerVan(ctx, doorId);
  if (!beheer && !bevestigdVan(p).some((r) => r.spelerId === doorId) && p.boekerId !== doorId) return { ok: false, fout: "Alleen bevestigde spelers kunnen een vervanger voorstellen.", status: 403 };
  if (!p.geboekt) return { ok: false, fout: "De baan is nog niet geboekt.", status: 409 };
  if (spelendVan(p).length >= MAX_SPELERS) return { ok: false, fout: "De partij is al vol (of er staat al iemand uitgenodigd).", status: 409 };
  const k = spelerVan(ctx, kandidaatId);
  if (!k || !(await kandidatenVoor(partijId)).some((x) => x.id === kandidaatId)) return { ok: false, fout: "Deze speler kan niet worden voorgesteld (club op nee, al ingepland die dag, of al afgemeld).", status: 409 };
  const rij = await zetRij(p, k.id, "uitgenodigd");
  const mails: Mail[] = [];
  const m = uitnodiging(ctx, p, k, rij, door);
  if (m) mails.push(m);
  await verstuur(mails);
  return { ok: true, tekst: `${k.naam} is uitgenodigd${kanMail(k) ? " per e-mail" : " (en ziet het op de site)"}.` };
}

// ---- Beheerder: spelers handmatig aan een partij toevoegen of eruit halen (zonder e-mail) ----
export async function beheerKandidaten(partijId: number) {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p) return [];
  return ctx.spelers
    .filter((s) => !p.rijen.some((r) => r.spelerId === s.id && isActief(r)))
    .map((s) => ({ id: s.id, naam: s.naam, gast: s.gast, afgezegd: p.rijen.some((r) => r.spelerId === s.id && r.status === "afgezegd"), alOpDag: speeltAlOpDag(ctx, s.id, p.datum, p.id) }))
    .sort((a, b) => a.naam.localeCompare(b.naam));
}
export async function beheerToevoegen(partijId: number, spelerId: number): Promise<Antwoord> {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || p.geannuleerd || startVan(p) < Date.now()) return { ok: false, fout: "Deze partij bestaat niet (meer).", status: 404 };
  const s = spelerVan(ctx, spelerId);
  if (!s) return { ok: false, fout: "Onbekende speler.", status: 404 };
  const rij = p.rijen.find((r) => r.spelerId === s.id);
  // Stond de speler al bevestigd (bijvoorbeeld op de reservelijst), dan alleen de volgorde en de stand bijwerken.
  const alBevestigd = rij?.status === "bevestigd";
  if (!alBevestigd) {
    // Een bestaande rij houdt zijn oorspronkelijke aanmeldmoment, zodat de speler zijn plek in de volgorde terugkrijgt.
    const waarden = { status: "bevestigd", aangemeld: rij?.aangemeld ? new Date(rij.aangemeld) : new Date(), token: rij?.token ?? randomBytes(18).toString("base64url"), reactieTot: null };
    await db.insert(partijDeelnemers).values({ partijId: p.id, spelerId: s.id, ...waarden })
      .onConflictDoUpdate({ target: [partijDeelnemers.partijId, partijDeelnemers.spelerId], set: waarden });
    p.rijen = await db.select().from(partijDeelnemers).where(eq(partijDeelnemers.partijId, p.id));
  }
  // Een door de beheerder toegevoegde (bevestigde) speler gaat vóór spelers die nog niet bevestigd hebben:
  // hij neemt de plek in van de laatste onbevestigde speler bij de vier; die schuift door naar de reservelijst.
  let verschoven: Speler | undefined;
  if (!vierVan(p).some((r) => r.spelerId === s.id)) {
    const plek = vierVan(p).filter((r) => r.status !== "bevestigd").pop();
    if (plek) {
      await db.update(partijDeelnemers).set({ aangemeld: new Date(plek.aangemeld) })
        .where(and(eq(partijDeelnemers.partijId, p.id), eq(partijDeelnemers.spelerId, s.id)));
      await db.update(partijDeelnemers).set({ aangemeld: new Date() })
        .where(and(eq(partijDeelnemers.partijId, p.id), eq(partijDeelnemers.spelerId, plek.spelerId)));
      verschoven = spelerVan(ctx, plek.spelerId);
      p.rijen = await db.select().from(partijDeelnemers).where(eq(partijDeelnemers.partijId, p.id));
    }
  }
  const reserve = !vierVan(p).some((r) => r.spelerId === s.id);
  // Meteen bijwerken: is de partij nu compleet, dan wordt dat vastgelegd en krijgen de spelers de "gaat door"-mail.
  const mails: Mail[] = [];
  await werkBij(ctx, p, mails);
  await verstuur(mails);
  return { ok: true, tekst: (alBevestigd ? `${s.naam} stond al bevestigd bij deze partij.` : `${s.naam} is als bevestigd aan de partij toegevoegd (zonder e-mail).`) +
    (reserve ? " De partij was al vol, dus deze speler staat op de reservelijst." : "") +
    (verschoven ? ` ${verschoven.naam} had nog niet bevestigd en staat nu op de reservelijst.` : "") +
    (!reserve && isCompleet(p) ? " De partij is nu compleet." : "") +
    (speeltAlOpDag(ctx, s.id, p.datum, p.id) ? ` Let op: ${s.naam} staat die dag ook bij een andere partij.` : "") };
}
// Gastspeler: alleen een naam. Bestaat er al een gast met die naam, dan wordt die opnieuw gebruikt.
export async function beheerGastToevoegen(partijId: number, naam: string): Promise<Antwoord> {
  const schoon = naam.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!schoon) return { ok: false, fout: "Vul de naam van de gastspeler in.", status: 400 };
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || p.geannuleerd || startVan(p) < Date.now()) return { ok: false, fout: "Deze partij bestaat niet (meer).", status: 404 };
  let gast = ctx.spelers.find((s) => s.gast && s.naam.toLowerCase() === schoon.toLowerCase());
  if (!gast) {
    const [nieuw] = await db
      .insert(spelers)
      .values({ slug: "gast-" + randomBytes(9).toString("base64url"), gast: true, naam: schoon, niveau: "", wensNiveaus: [], duren: [], frequentie: "", mailAan: false, herinneringAan: false, boekBereid: false })
      .returning({ id: spelers.id });
    gast = { id: nieuw.id, naam: schoon } as Speler;
  }
  const r = await beheerToevoegen(p.id, gast.id);
  return r.ok ? { ...r, tekst: "Gastspeler " + r.tekst } : r;
}
export async function beheerVerwijderen(partijId: number, spelerId: number): Promise<Antwoord> {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || p.geannuleerd || startVan(p) < Date.now()) return { ok: false, fout: "Deze partij bestaat niet (meer).", status: 404 };
  const s = spelerVan(ctx, spelerId);
  const rij = p.rijen.find((r) => r.spelerId === spelerId);
  if (!s || !rij || !isActief(rij)) return { ok: true, tekst: "Deze speler stond al niet (meer) bij deze partij." };
  const speeldeMee = vierVan(p).some((r) => r.spelerId === spelerId) && rij.status === "bevestigd";
  // "verwijderd": niet opnieuw voor deze partij uitgenodigd, maar die dag wel gewoon in te plannen bij een andere partij.
  await zetStatus(p, spelerId, "verwijderd");
  if (speeldeMee && p.compleetGemeld) await zetPartij(p, { compleetGemeld: false });
  if (p.boekerId === spelerId && !p.geboekt) await zetPartij(p, { boekerId: null, afgewezenBoekers: [...(p.afgewezenBoekers ?? []), spelerId] });
  return { ok: true, tekst: `${s.naam} is uit de partij gehaald (zonder e-mail).` + (p.boekerId === spelerId ? ` ${s.naam} blijft als boeker staan; de baan staat op die naam.` : "") };
}

// ---- Nieuwe partijen zoeken ----
// Per club de goedkoopste vrije baan; daarna de goedkoopste club (laatste-keusclubs zoals Rolde achteraan), bij gelijke prijs de club waar het langst geleden een partij was.
// Een baan die de boeker bij de club al bezet vond (keuze "bezet") wordt niet opnieuw voorgesteld, ook al toont de koppeling hem als vrij.
const alsBezetGemeld = (ctx: Context, datum: string, clubId: string, tijd: string, duur: number) =>
  ctx.partijen.some((q) => q.besluit === "bezet" && q.datum === datum && q.clubId === clubId &&
    naarMin(q.tijd) < naarMin(tijd) + duur && naarMin(tijd) < naarMin(q.tijd) + q.duur);
async function liveKeuze(ctx: Context, datum: string, slot: any, duur: number, opties: any[]) {
  try {
    const r = await fetch(`${siteUrl()}/api/banen?datum=${datum}&slot=${slot.id}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const live = await r.json();
    const eind = naarMin(slot.tot);
    const perClub: { clubId: string; tijd: string; prijs: number }[] = [];
    for (const o of opties) {
      const c = live?.clubs?.[o.club.id];
      if (!c?.live || !c.boekbaar) continue;
      for (const st of c.starts ?? []) {
        if (naarMin(st.tijd) + duur > eind) continue;
        if (alsBezetGemeld(ctx, datum, o.club.id, st.tijd, duur)) continue;
        const prijzen = (st.banen ?? []).map((b: any) => b.prijzen?.[String(duur)]).filter((x: any) => x != null);
        if (!prijzen.length) continue;
        perClub.push({ clubId: o.club.id, tijd: st.tijd, prijs: Math.min(...prijzen) });
        break;
      }
    }
    // Clubs die als laatste keus zijn aangewezen (Padel Rolde) alleen als er nergens anders een baan vrij is, ook als ze goedkoper zijn.
    const laatst = (id: string) => (clubVan(ctx, id).laatsteKeus ? 1 : 0);
    perClub.sort((a, b) => laatst(a.clubId) - laatst(b.clubId) || a.prijs - b.prijs || (ctx.laatstePerClub[a.clubId] ?? "").localeCompare(ctx.laatstePerClub[b.clubId] ?? ""));
    return perClub[0] ?? null;
  } catch {
    return null;
  }
}

function zonderAfgezegdeDagen(ctx: Context, s: Speler, dagen: string[]): Speler {
  // Ook dagen waarop iemand al speelt (of te kort na/voor een partij zit) eruit: nooit twee keer op een dag.
  const weg = dagen.filter((d) => kanNietOpDag(ctx, s.id, d) || speeltAlOpDag(ctx, s.id, d) || teDichtBij(ctx, s, d));
  if (!weg.length) return s;
  const weken: Speler["weken"] = {};
  for (const [w, v] of Object.entries(s.weken)) {
    const tijdvakken = { ...v.tijdvakken };
    for (const d of weg) delete tijdvakken[d];
    weken[w] = { ...v, tijdvakken };
  }
  return { ...s, weken };
}

// De beste momenten eerst, daarna de rest vanaf een punt dat elk uur opschuift.
function volgorde<T>(lijst: T[], ronde: number): T[] {
  const vast = lijst.slice(0, VASTE_CHECKS);
  const rest = lijst.slice(VASTE_CHECKS);
  if (!rest.length) return vast;
  const begin = (ronde * (MAX_BAAN_CHECKS - VASTE_CHECKS)) % rest.length;
  return [...vast, ...rest.slice(begin), ...rest.slice(0, begin)];
}

async function zoekNieuwePartijen(ctx: Context, mails: Mail[]) {
  const dagen: string[] = [];
  const max = P.boekingsHorizon(ctx.clubs);
  const ronde = Math.floor(Date.now() / UUR);
  for (let i = MIN_DAGEN_VOORUIT; i <= max; i++) dagen.push(plusDagen(ctx.vandaag, i));
  const vandaagDatum = P.parseKey(ctx.vandaag);
  const begin = Date.now();
  let gemaakt = 0;
  let checks = 0;
  const geprobeerd = new Set<string>();
  const genoegGezocht = () => checks >= MAX_BAAN_CHECKS || Date.now() - begin > MAX_ZOEKTIJD;
  while (gemaakt < MAX_NIEUW_PER_RUN && !genoegGezocht()) {
    // Alleen spelers met een 06-nummer (anders kunnen ze niet bevestigen en loopt de partij vast).
    const pool = ctx.spelers.filter((s) => ctx.metTelefoon.has(s.id) && dagen.some((d) => heeftRuimte(ctx, s, d)))
      .map((s) => ({ ...zonderAfgezegdeDagen(ctx, s, dagen), kanBoeken: kanBoeken(ctx, s) }));
    if (pool.length < MAX_SPELERS) break;
    const kandidaten = volgorde(P.plan(pool, ctx.clubs, vandaagDatum, KANDIDATEN, dagen), ronde);
    let gekozen: { k: any; groep: Speler[]; duur: number; clubId: string; tijd: string; prijs: number } | null = null;
    for (const k of kandidaten) {
      if (genoegGezocht()) break;
      const sleutel = k.datum + k.slot.id + k.voorbeeldGroep.join("|");
      if (geprobeerd.has(sleutel)) continue;
      geprobeerd.add(sleutel);
      const groep = k.voorbeeldGroep.map((n: string) => pool.find((s) => s.naam === n)).filter(Boolean) as Speler[];
      const opties = k.opties.filter((o: any) => o.status.soort === "boekbaar");
      if (groep.length !== MAX_SPELERS || !opties.length) continue;
      // Er moet iemand in het groepje zijn die de baan wil en kan boeken.
      if (!groep.some((s) => kanBoeken(ctx, s))) continue;
      const duur = Math.max(...k.duren.map(Number));
      const voorlopig = { datum: k.datum, tijd: k.slot.van, duur, clubId: opties[0].club.id };
      if (!groep.every((s, i) => pastBij(ctx, s, voorlopig, groep.filter((_, j) => j !== i)))) continue;
      checks++;
      const live = await liveKeuze(ctx, k.datum, k.slot, duur, opties);
      if (!live) continue; // geen vrije baan (of de club was niet bereikbaar): niemand uitnodigen
      const voorstel = { datum: k.datum, tijd: live.tijd, duur, clubId: live.clubId };
      if (groep.every((s, i) => pastBij(ctx, s, voorstel, groep.filter((_, j) => j !== i)))) {
        gekozen = { k, groep, duur, clubId: live.clubId, tijd: live.tijd, prijs: live.prijs };
        break;
      }
    }
    if (!gekozen) break;
    const { k, groep, duur, clubId, tijd, prijs } = gekozen;
    const [nieuw] = await db.insert(partijen)
      .values({ datum: k.datum, tijd, duur, clubId, automatisch: true, opmerking: "Automatisch gepland", baanPrijs: prijs, boekenTot: new Date(deadline(Date.now(), BOEK_UREN)) })
      .returning();
    const p: Partij = { ...nieuw, rijen: [] };
    ctx.partijen.push(p);
    ctx.laatstePerClub[clubId] = k.datum;
    for (const s of groep) await zetRij(p, s.id, "gepland");
    if (!(await wijsBoekerAan(ctx, p, mails))) await annuleer(ctx, p, mails, "Er was niemand die de baan kon boeken.");
    gemaakt++;
  }
  return gemaakt;
}

// ---- Partijen met een vrije baan waar nog één speler ontbreekt ----
// Live berekend zodra een speler de site opent (niet pas bij de volgende ronde van het automatisch plannen):
// drie passende spelers kunnen op hetzelfde moment en er is live een baan vrij bij een club die alle vier op "ja" hebben.
// De vierde speler (wie kijkt) kan meedoen en boekt dan zelf de baan. Zijn eigen beschikbaarheid is niet nodig: hij kiest zelf.
const MAX_DRIETAL_CHECKS = 10;
const MAX_DRIETALLEN = 6;
export type OpenPartij = { datum: string; tijd: string; duur: number; clubId: string; club: string; prijs: number; perPersoon: number; spelers: { id: number; naam: string; niveau: string; pastPrecies: boolean }[] };

function magOpDag(ctx: Context, s: Speler, datum: string) {
  return !speeltAlOpDag(ctx, s.id, datum) && !teDichtBij(ctx, s, datum) && !kanNietOpDag(ctx, s.id, datum);
}

// Bij "speel mee" mag de speelsterkte iets afwijken van wat iemand heeft ingesteld: wie kijkt ziet zelf wie er
// meedoen (met hun speelsterkte) en kiest of hij aansluit. De gewone automatische planning blijft strikt.
const NIVEAU_MARGE = 0.5;
function wilOngeveer(wens: string[], niveau: string) {
  const b = P.wensBereik(wens);
  const g = P.niveauGetal(niveau);
  if (!b || !Number.isFinite(g)) return P.wilMet(wens, niveau);
  return g >= b[0] - NIVEAU_MARGE - 1e-9 && g <= b[1] + NIVEAU_MARGE + 1e-9;
}
const nivBijna = (a: Speler, b: Speler) => wilOngeveer(a.wensNiveaus, b.niveau) && wilOngeveer(b.wensNiveaus, a.niveau);
const voornaam = (naam: string) => naam.trim().split(/\s+/)[0] || naam;

function drietallenVoor(ctx: Context, ik: Speler) {
  const max = P.boekingsHorizon(ctx.clubs);
  const uit: { datum: string; van: number; tot: number; duren: string[]; groep: Speler[]; clubs: any[] }[] = [];
  const anderen = ctx.spelers.filter((s) => s.id !== ik.id && ctx.metTelefoon.has(s.id) && nivBijna(ik, s) && s.duren.some((x) => ik.duren.includes(x)));
  for (let i = MIN_DAGEN_VOORUIT; i <= max; i++) {
    const d = plusDagen(ctx.vandaag, i);
    if (!magOpDag(ctx, ik, d)) continue;
    const clubsDag = ctx.clubs.filter((c) => clubJa(ik, c.id, d));
    if (!clubsDag.length) continue;
    const kunnen = anderen
      .filter((s) => heeftRuimte(ctx, s, d) && magOpDag(ctx, s, d))
      .map((s) => ({ s, tijden: P.tijdenVan(P.beschikbaarVan(s)[d] || []) }))
      .filter((x) => x.tijden.length);
    if (kunnen.length < 3) continue;
    const gezien = new Map<string, number>();
    for (let t = P.DAG_VAN; t + 60 <= 1440; t += P.STAP) {
      const nu = kunnen
        .map((x) => { const rest = P.vrijVanaf(x.tijden, t); return { ...x, rest, duren: x.s.duren.filter((du) => ik.duren.includes(du) && Number(du) <= rest) }; })
        .filter((x) => x.duren.length);
      for (let a = 0; a < nu.length; a++)
        for (let b = a + 1; b < nu.length; b++) {
          if (!nivBijna(nu[a].s, nu[b].s)) continue;
          for (let c = b + 1; c < nu.length; c++) {
            const g = [nu[a], nu[b], nu[c]];
            if (!nivBijna(g[0].s, g[2].s) || !nivBijna(g[1].s, g[2].s)) continue;
            const duren = ik.duren.filter((du) => g.every((x) => x.duren.includes(du)));
            if (!duren.length) continue;
            const clubs = clubsDag.filter((cl) => g.every((x) => clubJa(x.s, cl.id, d)));
            if (!clubs.length) continue;
            const sleutel = g.map((x) => x.s.id).sort((p, q) => p - q).join("|");
            const tot = t + Math.min(...g.map((x) => x.rest));
            // Zelfde drietal een half uur later binnen hetzelfde tijdvak: al gevonden.
            if ((gezien.get(sleutel) ?? -1) >= tot) continue;
            gezien.set(sleutel, tot);
            uit.push({ datum: d, van: t, tot, duren, groep: g.map((x) => x.s), clubs });
          }
        }
    }
  }
  uit.sort((a, b) => a.datum.localeCompare(b.datum) || a.van - b.van);
  // Overlappende momenten op dezelfde dag maar één keer tonen.
  const gekozen: typeof uit = [];
  for (const k of uit) {
    if (gekozen.some((g) => g.datum === k.datum && k.van < g.tot && g.van < k.tot)) continue;
    gekozen.push(k);
  }
  return gekozen;
}

export async function openPartijenVoor(spelerId: number): Promise<{ partijen: OpenPartij[]; reden?: string }> {
  const ctx = await laad();
  const ik = spelerVan(ctx, spelerId);
  if (!ik) return { partijen: [] };
  if (!ctx.metTelefoon.has(ik.id)) return { partijen: [], reden: "Vul eerst je 06-nummer in bij Vaste instellingen; dat is nodig om mee te spelen en de baan te boeken." };
  const kandidaten = drietallenVoor(ctx, ik).slice(0, MAX_DRIETAL_CHECKS);
  const gevonden = await Promise.all(kandidaten.map(async (k) => {
    const slot = { id: P.tijdId(k.van, k.tot), tot: naarTijd(k.tot) };
    const opties = k.clubs.map((club) => ({ club }));
    // Eerst de langste gezamenlijke speelduur, anders de kortere.
    for (const duur of k.duren.map(Number).sort((a, b) => b - a)) {
      const live = await liveKeuze(ctx, k.datum, slot, duur, opties);
      if (live) return { k, duur, live };
    }
    return null;
  }));
  const partijen: OpenPartij[] = [];
  for (const g of gevonden) {
    if (!g || partijen.length >= MAX_DRIETALLEN) continue;
    partijen.push({
      datum: g.k.datum, tijd: g.live.tijd, duur: g.duur, clubId: g.live.clubId, club: clubVan(ctx, g.live.clubId).naam,
      prijs: g.live.prijs, perPersoon: g.live.prijs / MAX_SPELERS,
      // Alleen voornaam en speelsterkte; pastPrecies = valt binnen ieders ingestelde niveau-range (zonder marge).
      spelers: g.k.groep.map((s) => ({ id: s.id, naam: voornaam(s.naam), niveau: s.niveau, pastPrecies: nivPast(ik, s) && g.k.groep.every((x) => x.id === s.id || nivPast(x, s)) })),
    });
  }
  return { partijen };
}

// ---- Bestaande partijen waar nog één speler ontbreekt ----
// Geboekt, niet geannuleerd, nog niet begonnen, drie bevestigd en niet "doorgaan met drie".
// De beheerder ziet ze allemaal; een speler alleen die waar een plek vrij is en waar hij zelf bij past.
export type GatPartij = { id: number; datum: string; tijd: string; duur: number; clubId: string; club: string; perPersoon: number | null; urenTot: number;
  spelers: { naam: string; niveau: string | null; gast: boolean; status: string }[]; boeker: string | null; plekVrij: boolean; besluit: string | null };
export async function partijenMetGat(spelerId: number | null, beheer: boolean): Promise<GatPartij[]> {
  const ctx = await laad();
  const ik = spelerVan(ctx, spelerId);
  const uit: GatPartij[] = [];
  for (const p of ctx.partijen) {
    if (p.geannuleerd || !p.geboekt || startVan(p) < Date.now() || p.besluit === "drie") continue;
    if (bevestigdVan(p).length !== MAX_SPELERS - 1) continue;
    const plekVrij = spelendVan(p).length < MAX_SPELERS;
    if (!beheer) {
      if (!ik || ik.gast || !plekVrij || !ctx.metTelefoon.has(ik.id)) continue;
      if (p.rijen.some((r) => r.spelerId === ik.id && (isActief(r) || nietOpDag(r) || r.status === "verwijderd"))) continue;
      const groep = spelendVan(p).map((r) => spelerVan(ctx, r.spelerId)).filter(Boolean) as Speler[];
      // Zelf aansluiten is vrijwillig (zoals bij "speel mee"): club op ja, beschikbaar, speelsterkte met kleine marge,
      // nog geen partij die dag en rustdagen; het maximum aantal partijen per week telt hier niet.
      if (!clubJa(ik, p.clubId, p.datum) || !kanOp(ik, p.datum, p.tijd, p.duur) || !groep.every((g) => g.gast || nivBijna(ik, g)) || !magOpDag(ctx, ik, p.datum)) continue;
    }
    uit.push({
      id: p.id, datum: p.datum, tijd: p.tijd, duur: p.duur, clubId: p.clubId, club: clubVan(ctx, p.clubId).naam,
      perPersoon: bedragPP(ctx, p), urenTot: Math.round(urenTot(p)),
      spelers: vierVan(p).map((r) => {
        const s = spelerVan(ctx, r.spelerId);
        const naam = s?.naam ?? "?";
        return { naam: beheer ? naam : voornaam(naam), niveau: s && !s.gast ? s.niveau : null, gast: !!s?.gast, status: r.status };
      }),
      boeker: beheer ? spelerVan(ctx, p.boekerId)?.naam ?? null : null,
      plekVrij, besluit: beheer ? p.besluit : null,
    });
  }
  return uit.sort((a, b) => a.datum.localeCompare(b.datum) || a.tijd.localeCompare(b.tijd));
}

// "Ik speel mee en boek de baan": de partij wordt meteen aangemaakt met deze speler als boeker.
// Na "Baan is geboekt" krijgen de andere drie hun uitnodiging (zoals bij elke automatische partij).
export async function speelMeeEnBoek(spelerId: number, b: any): Promise<Antwoord & { id?: number }> {
  const ctx = await laad();
  const ik = spelerVan(ctx, spelerId);
  if (!ik) return { ok: false, fout: "Sla eerst je vaste instellingen op.", status: 404 };
  if (!ctx.metTelefoon.has(ik.id)) return { ok: false, fout: "Vul eerst je 06-nummer in bij Vaste instellingen.", status: 409 };
  const datum = typeof b?.datum === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.datum) ? b.datum : null;
  const tijd = typeof b?.tijd === "string" && /^([01]\d|2[0-3]):(00|30)$/.test(b.tijd) ? b.tijd : null;
  const duur = Number(b?.duur);
  const clubId = typeof b?.clubId === "string" ? b.clubId : "";
  const ids = Array.isArray(b?.spelers) ? [...new Set(b.spelers.map(Number))] as number[] : [];
  if (!datum || !tijd || ![60, 90].includes(duur) || !ctx.clubs.some((c) => c.id === clubId) || ids.length !== 3 || ids.includes(ik.id))
    return { ok: false, fout: "Onbekende partij." };
  const dagen = (utc(datum) - utc(ctx.vandaag)) / DAG;
  if (dagen < MIN_DAGEN_VOORUIT || dagen > P.boekingsHorizon(ctx.clubs)) return { ok: false, fout: "Dit moment valt buiten de periode waarin de site plant.", status: 409 };
  const groep = ids.map((id) => spelerVan(ctx, id));
  if (groep.some((s) => !s || !ctx.metTelefoon.has(s.id))) return { ok: false, fout: "Een van de spelers doet niet meer mee.", status: 409 };
  const drie = groep as Speler[];
  if (!clubJa(ik, clubId, datum)) return { ok: false, fout: `Je hebt ${clubVan(ctx, clubId).naam} op "nee" staan.`, status: 409 };
  if (!ik.duren.includes(String(duur))) return { ok: false, fout: "Deze speelduur staat niet bij je vaste instellingen.", status: 409 };
  if (!magOpDag(ctx, ik, datum)) return { ok: false, fout: "Je staat die dag (of te kort ervoor of erna) al bij een andere partij.", status: 409 };
  const voorstel = { datum, tijd, duur, clubId };
  if (!drie.every((s) => nivBijna(ik, s) && pastBij(ctx, s, voorstel, [ik, ...drie.filter((x) => x.id !== s.id)], nivBijna)))
    return { ok: false, fout: "Deze partij is er niet meer: een van de spelers kan inmiddels niet meer. Vernieuw de pagina.", status: 409 };
  // Nog eens live controleren of de baan echt vrij is (en tegen welke prijs).
  const live = await liveKeuze(ctx, datum, { id: P.tijdId(naarMin(tijd), naarMin(tijd) + duur), tot: naarTijd(naarMin(tijd) + duur) }, duur, [{ club: clubVan(ctx, clubId) }]);
  if (!live || live.tijd !== tijd) return { ok: false, fout: "Deze baan is net niet meer vrij. Vernieuw de pagina voor andere momenten.", status: 409 };
  const [nieuw] = await db.insert(partijen)
    .values({ datum, tijd, duur, clubId, automatisch: true, opmerking: `${ik.naam} speelt mee en boekt de baan`, baanPrijs: live.prijs, boekerId: ik.id, boekenTot: new Date(deadline(Date.now(), BOEK_UREN, { datum, tijd })) })
    .returning();
  const p: Partij = { ...nieuw, rijen: [] };
  ctx.partijen.push(p);
  for (const s of [ik, ...drie]) await zetRij(p, s.id, "gepland");
  const club = clubVan(ctx, clubId);
  return {
    ok: true, id: p.id,
    tekst: `Top, je speelt mee! Boek de baan bij ${club.naam} vóór ${momentTekst(new Date(p.boekenTot!).getTime())} en druk daarna op "Baan is geboekt". ` +
      `Dan krijgen ${naamLijst(drie.map((s) => s.naam))} hun uitnodiging.`,
    boeken: { club: club.naam, url: P.boekLink(club, datum, tijd, duur) },
  };
}

// ---- Elk uur ----
export async function automatischPlannen(metZoeken?: boolean) {
  const wachtrij = await verstuurWachtrij();
  const ctx = await laad();
  const mails: Mail[] = [];
  const nu = Date.now();
  let verlopen = 0;
  for (const p of ctx.partijen) {
    if (startVan(p) < nu || p.geannuleerd) continue;
    for (const r of p.rijen) {
      if (r.status !== "uitgenodigd" || reactieTotVan(r, p) > nu) continue;
      await zetStatus(p, r.spelerId, "verlopen");
      verlopen++;
    }
    // De boeker boekte niet op tijd: de volgende bereidwillige speler.
    if (!p.geboekt && p.boekenTot && new Date(p.boekenTot).getTime() <= nu && p.boekerId) {
      await zetPartij(p, { afgewezenBoekers: [...(p.afgewezenBoekers ?? []), p.boekerId], boekerId: null });
    }
  }
  for (const p of ctx.partijen) await werkBij(ctx, p, mails);
  await dagHerinneringen(ctx, mails);
  const uur = Math.floor(nlMinuten() / 60);
  const zoeken = metZoeken ?? (uur >= ZOEK_VAN && uur <= ZOEK_TOT);
  const nieuw = zoeken ? await zoekNieuwePartijen(ctx, mails) : 0;
  await verstuur(mails);
  console.log(`Automatisch plannen: ${wachtrij} uit de wachtrij, ${nieuw} nieuwe partij(en), ${verlopen} verlopen uitnodiging(en), ${mails.length} e-mail(s).`);
}

// Gegevens van een uitnodiging opzoeken via de sleutel uit de e-mail.
export async function zoekUitnodiging(token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const [r] = await db.select().from(partijDeelnemers).where(eq(partijDeelnemers.token, token));
  return r ?? null;
}

// Extra gegevens voor de partijpagina.
export async function partijInfo(ids: number[]) {
  const ctx = await laad();
  const out = new Map<number, { bedrag: number | null; bedragDrie: number | null; gratisTot: number; boekenTot: number | null; vorigeBoeker: string | null }>();
  for (const p of ctx.partijen) {
    if (!ids.includes(p.id)) continue;
    out.set(p.id, { bedrag: bedragPP(ctx, p), bedragDrie: bedragPP(ctx, p, 3), gratisTot: gratisTot(p), boekenTot: p.boekenTot ? new Date(p.boekenTot).getTime() : null, vorigeBoeker: spelerVan(ctx, p.vorigeBoekerId)?.naam ?? null });
  }
  return out;
}

// ---- Herinnering op de dag zelf ----
// Een paar uur voor de partij (maar niet vóór 08:00): tijd, club, medespelers en de Tikkie als die nog openstaat.
async function dagHerinneringen(ctx: Context, mails: Mail[]) {
  const nu = Date.now();
  for (const p of ctx.partijen) {
    if (p.dagHerinnerd || p.geannuleerd || !isOpgelost(p)) continue;
    const start = startVan(p);
    const vanaf = Math.max(start - 4 * UUR, nlMoment(p.datum, "08:00"));
    if (start <= nu || nu < vanaf) continue;
    await zetPartij(p, { dagHerinnerd: true });
    const club = clubVan(ctx, p.clubId);
    const boeker = spelerVan(ctx, p.boekerId);
    const rijen = bevestigdVan(p);
    const namen = namenVan(ctx, rijen);
    for (const r of rijen) {
      const s = spelerVan(ctx, r.spelerId);
      if (!kanMail(s)) continue;
      const ikBoek = s.id === p.boekerId;
      const tikkie = !ikBoek && !!p.betaallink && !r.betaald;
      mails.push({
        aan: s.email!, naam: s.naam,
        onderwerp: `Vandaag padel om ${p.tijd} bij ${club.naam}`,
        tekst:
          `Hoi ${s.naam},\n\nVandaag is het zover!\n\nWanneer: ${partijTekst(ctx, p)}\nSpelers: ${naamLijst(namen)}\n` +
          (boeker ? `Baan geboekt door: ${ikBoek ? "jou" : boeker.naam}\n` : "") + deurcodeTekst(ctx, p) +
          (tikkie ? `\nJe deel staat nog open (${bedragTekst(ctx, p, p.besluit === "drie" ? 3 : MAX_SPELERS)}). Betaal via de Tikkie hieronder.\n` : "") +
          "\nDe 06-nummers van je medespelers staan op de partijpagina. Veel plezier!",
        knoppen: [...(tikkie ? [{ label: "Betaal je deel (Tikkie)", url: p.betaallink! }] : []), naarPartij(p.id)],
      });
    }
  }
}

// ---- Wekelijkse herinnering: beschikbaarheid invullen ----
// Op zondagavond: wie nog weken open heeft staan (binnen de periode waarin je al kunt reserveren) krijgt een mail.
// Niet voor spelers met een standaardweek: hun weken zijn automatisch ingevuld.
export async function herinnerBeschikbaarheid() {
  const ctx = await laad();
  const horizon = P.boekingsHorizon(ctx.clubs);
  const laatsteWeek = maandag(plusDagen(ctx.vandaag, horizon));
  const weken: string[] = [];
  for (let w = plusDagen(maandag(ctx.vandaag), 7); w <= laatsteWeek; w = plusDagen(w, 7)) weken.push(w);
  const mails: Mail[] = [];
  for (const s of ctx.spelers) {
    if (!kanMail(s) || !s.herinneringAan) continue;
    if (s.standaardWeek && Object.keys(s.standaardWeek).length) continue;
    const open = weken.filter((w) => !s.weken[w]);
    if (!open.length) continue;
    const wekenTekst = naamLijst(open.map((w) => `de week van ${new Date(utc(w)).toLocaleDateString("nl-NL", { day: "numeric", month: "long", timeZone: "UTC" })}`));
    mails.push({
      aan: s.email!,
      naam: s.naam,
      onderwerp: open.length === 1 ? "Vul je beschikbaarheid in voor padel" : `Nog ${open.length} weken padel-beschikbaarheid in te vullen`,
      tekst:
        `Hoi ${s.naam},\n\nJe hebt nog niet ingevuld wanneer je kunt in ${wekenTekst}. ` +
        "De planner kan je alleen inplannen als je beschikbaarheid bekend is. Kun je een week niet? Klik dan op \"Ik kan deze week niet\", dan krijg je er geen herinnering meer over.\n\n" +
        "Tip: kun je meestal op dezelfde momenten? Stel dan een standaardweek in. Die geldt voor elke week die je niet zelf aanpast, en dan krijg je deze mail niet meer.\n\n" +
        "Geen herinneringen meer? Zet ze uit bij Vaste instellingen.",
      knoppen: [{ label: "Beschikbaarheid invullen", url: `${siteUrl()}/?tab=beschikbaarheid&week=${open[0]}` }],
    });
  }
  await verstuur(mails);
  console.log(`Herinnering beschikbaarheid: ${mails.length} e-mail(s).`);
}
