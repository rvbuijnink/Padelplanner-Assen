// Automatisch plannen met e-mail.
// - De site zoekt zelf momenten waarop vier passende spelers kunnen én er live een baan vrij is, en maakt daar een partij van.
// - Die spelers krijgen een uitnodiging per e-mail met "Ik doe mee" / "Kan toch niet".
// - Wie afzegt of niet op tijd reageert, wordt vervangen door de volgende speler die ook kan.
// - Is er geen vervanger (en is de baan nog niet geboekt), dan wordt de partij geannuleerd en krijgen de anderen een mail.
//   Wie afzegde of niet reageerde, wordt die dag niet meer ingepland; de anderen wel.
// - Wie als vierde bevestigt, boekt meteen de baan (krijgt direct de boekknop); iedereen krijgt een mail dat de partij doorgaat.
// Gebruikt door de geplande functie (elk uur) en door de API (direct na een antwoord).
import { randomBytes } from "node:crypto";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { spelers, beschikbaarheid, clubGegevens, partijen, partijDeelnemers } from "../db/schema.js";
import { verstuur, type Mail } from "./mail.js";
// @ts-ignore - gedeelde planner-logica (CommonJS), ook gebruikt in de browser
import Planner from "../src/planner.cjs";
// @ts-ignore - standaardgegevens van de clubs
import clubsJson from "../public/clubs.json";

const P: any = Planner;
export const MAX_SPELERS = 4;
const UUR = 3600000;
// Hoeveel partijen er per run hooguit automatisch worden aangemaakt (voorkomt een stortvloed aan mails).
const MAX_NIEUW_PER_RUN = 4;
// Partijen worden minstens zoveel dagen vooruit gepland, zodat er tijd is om te bevestigen en te boeken.
// Hoe ver vooruit: zo ver als er bij minstens één club gereserveerd kan worden (per club wordt daarna nog gekeken of die dag al boekbaar is).
const MIN_DAGEN_VOORUIT = 2;
// Hoe vaak per run hooguit bij de clubs wordt nagevraagd of er een baan vrij is, en hoe lang er hooguit wordt gezocht.
const MAX_BAAN_CHECKS = 12;
const MAX_ZOEKTIJD = 18000;

const env = (k: string): string | undefined => (globalThis as any).Netlify?.env?.get(k) ?? process.env[k];
export const siteUrl = () => (env("URL") || "https://planpadel.netlify.app").replace(/\/+$/, "");

// ---- Datum en tijd (Nederlandse tijd) ----
const utc = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
export const nlVandaag = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
const plusDagen = (k: string, n: number) => new Date(utc(k) + n * 86400000).toISOString().slice(0, 10);
const maandag = (k: string) => plusDagen(k, -((new Date(utc(k)).getUTCDay() + 6) % 7));
const naarMin = (t: string) => {
  const [u, m] = t.split(":").map(Number);
  return u * 60 + m;
};
const naarTijd = (m: number) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
// Tijdstip (ms) van een Nederlandse datum + tijd.
function nlMoment(datum: string, tijd: string) {
  const alsUtc = utc(datum) + naarMin(tijd) * 60000;
  const s = new Date(alsUtc).toLocaleString("sv-SE", { timeZone: "Europe/Amsterdam" });
  const verschuiving = Date.parse(s.replace(" ", "T") + "Z") - alsUtc;
  return alsUtc - verschuiving;
}
const dagTekst = (datum: string) =>
  new Date(utc(datum)).toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const momentTekst = (ms: number) =>
  new Date(ms).toLocaleString("nl-NL", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });

// Uiterste moment om te reageren: de helft van de tijd tot de partij, minstens 2 en hooguit 12 uur.
export function verlooptOp(uitgenodigd: Date, partij: { datum: string; tijd: string }) {
  const start = nlMoment(partij.datum, partij.tijd);
  const marge = Math.min(12 * UUR, Math.max(2 * UUR, (start - uitgenodigd.getTime()) / 2));
  return uitgenodigd.getTime() + marge;
}

// De maandagen van deze week en de weken waarin je al kunt reserveren (hooguit 6 weken vooruit).
export const komendeWeken = (vandaag: string) => Array.from({ length: 7 }, (_, i) => plusDagen(maandag(vandaag), 7 * i));

// ---- Gegevens laden ----
type Speler = typeof spelers.$inferSelect & { weken: Record<string, { tijdvakken: Record<string, string[]> }> };
type Deelnemer = typeof partijDeelnemers.$inferSelect;
type Partij = typeof partijen.$inferSelect & { rijen: Deelnemer[] };
type Context = { vandaag: string; spelers: Speler[]; partijen: Partij[]; clubs: any[] };

export const isActief = (d: { status: string }) => d.status === "uitgenodigd" || d.status === "bevestigd";
// De eerste vier actieve spelers (op volgorde van aanmelding) spelen; de rest is reserve.
export const spelendVan = (p: Partij) => p.rijen.filter(isActief).sort((a, b) => a.aangemeld.getTime() - b.aangemeld.getTime());

async function laad(): Promise<Context> {
  const vandaag = nlVandaag();
  const vanaf = plusDagen(vandaag, -14);
  const [sp, best, gegevens, lijst] = await Promise.all([
    db.select().from(spelers),
    db.select().from(beschikbaarheid).where(gte(beschikbaarheid.week, plusDagen(vandaag, -7))),
    db.select().from(clubGegevens),
    db.select().from(partijen).where(gte(partijen.datum, vanaf)),
  ]);
  const ids = lijst.map((p) => p.id);
  const rijen = ids.length ? await db.select().from(partijDeelnemers).where(inArray(partijDeelnemers.partijId, ids)) : [];
  const g: Record<string, unknown> = {};
  for (const r of gegevens) g[r.clubId] = r;
  return {
    vandaag,
    spelers: sp.map((s) => {
      const weken: Speler["weken"] = {};
      for (const w of best) if (w.spelerId === s.id) weken[w.week] = { tijdvakken: w.tijdvakken };
      // Weken die de speler niet zelf heeft ingevuld: de standaardweek (als die er is).
      return { ...s, weken: P.vulStandaardweek(weken, s.standaardWeek, komendeWeken(vandaag)) };
    }),
    partijen: lijst.map((p) => ({ ...p, rijen: rijen.filter((r) => r.partijId === p.id) })),
    clubs: P.voegClubsSamen((clubsJson as any).clubs, g),
  };
}

// ---- Wie past bij een partij ----
function kanOp(s: Speler, datum: string, tijd: string, duur: number) {
  if (!s.duren.includes(String(duur))) return false;
  const tijden = P.tijdenVan(P.beschikbaarVan(s)[datum] || []);
  return P.vrijVanaf(tijden, naarMin(tijd)) >= duur;
}
const nivPast = (a: Speler, b: Speler) => P.wilMet(a.wensNiveaus, b.niveau) && P.wilMet(b.wensNiveaus, a.niveau);
// Staat iemand op deze dag al bij een andere partij (uitgenodigd, speler of reserve)?
const speeltAlOpDag = (ctx: Context, spelerId: number, datum: string, behalve?: number) =>
  ctx.partijen.some((q) => q.id !== behalve && q.datum === datum && q.rijen.some((r) => r.spelerId === spelerId && isActief(r)));
// Heeft iemand op deze dag een uitnodiging afgeslagen of laten verlopen? Dan kan die die dag niet: niet opnieuw inplannen.
const nietOpDag = (r: { status: string }) => r.status === "afgezegd" || r.status === "verlopen";
const kanNietOpDag = (ctx: Context, spelerId: number, datum: string, behalve?: number) =>
  ctx.partijen.some((q) => q.id !== behalve && q.datum === datum && q.rijen.some((r) => r.spelerId === spelerId && nietOpDag(r)));
// Wil iemand rustdagen tussen partijen? Dan niet inplannen als er binnen dat aantal dagen al een partij is.
const DAG = 86400000;
const teDichtBij = (ctx: Context, s: Speler, datum: string, behalve?: number) => {
  const rust = Math.max(0, Math.min(2, s.rustDagen ?? 0));
  if (!rust) return false;
  return ctx.partijen.some(
    (q) => q.id !== behalve && Math.abs(utc(q.datum) - utc(datum)) <= rust * DAG && q.rijen.some((r) => r.spelerId === s.id && isActief(r))
  );
};

// Hoe vaak iemand per week wil spelen. "Om de week": niet als er de week ervoor of erna al een partij is.
function heeftRuimte(ctx: Context, s: Speler, datum: string, behalve?: number) {
  const mijn = ctx.partijen.filter((p) => p.id !== behalve && p.rijen.some((r) => r.spelerId === s.id && isActief(r)));
  const week = maandag(datum);
  const dezeWeek = mijn.filter((p) => maandag(p.datum) === week).length;
  if (s.frequentie === "3x-per-week") return dezeWeek < 3;
  if (s.frequentie === "2x-per-week") return dezeWeek < 2;
  if (s.frequentie === "tweewekelijks") {
    const rond = mijn.filter((p) => Math.abs(utc(maandag(p.datum)) - utc(week)) <= 7 * 86400000).length;
    return rond === 0;
  }
  return dezeWeek === 0;
}

function pastBij(ctx: Context, s: Speler, p: { id?: number; datum: string; tijd: string; duur: number; clubId: string }, groep: Speler[]) {
  if (P.voorkeurVan(s, p.clubId, p.datum) === "niet") return false;
  if (!kanOp(s, p.datum, p.tijd, p.duur)) return false;
  if (!groep.every((g) => nivPast(s, g))) return false;
  if (!heeftRuimte(ctx, s, p.datum, p.id)) return false;
  // Nooit twee partijen op dezelfde dag, en niet opnieuw vragen op een dag waarop iemand al heeft afgezegd.
  if (speeltAlOpDag(ctx, s.id, p.datum, p.id)) return false;
  // Minimaal aantal vrije dagen tussen twee partijen, zoals de speler heeft aangegeven.
  if (teDichtBij(ctx, s, p.datum, p.id)) return false;
  // Wie die dag al een partij afzegde of niet op tijd reageerde, kan die dag kennelijk niet (ook niet een half uur later).
  if (kanNietOpDag(ctx, s.id, p.datum, p.id)) return false;
  return true;
}

// Voorrang voor wie de komende tijd het minst speelt.
const aantalPartijen = (ctx: Context, s: Speler) =>
  ctx.partijen.filter((p) => p.datum >= ctx.vandaag && p.rijen.some((r) => r.spelerId === s.id && isActief(r))).length;

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
const spelerVan = (ctx: Context, id: number | null) => ctx.spelers.find((s) => s.id === id);
const kanMail = (s?: Speler): s is Speler => !!s && !!s.email && s.mailAan;
const antwoordLinks = (token: string) => [
  { label: "Ik doe mee", url: `${siteUrl()}/bevestig.html?t=${token}&a=ja` },
  { label: "Kan toch niet", url: `${siteUrl()}/bevestig.html?t=${token}&a=nee` },
];

function uitnodiging(ctx: Context, p: Partij, s: Speler, token: string): Mail | null {
  if (!kanMail(s)) return null;
  const anderen = spelendVan(p).filter((r) => r.spelerId !== s.id).map((r) => spelerVan(ctx, r.spelerId)?.naam).filter(Boolean) as string[];
  const rij = p.rijen.find((r) => r.spelerId === s.id)!;
  const tot = momentTekst(verlooptOp(rij.uitgenodigd ?? new Date(), p));
  return {
    aan: s.email!,
    naam: s.naam,
    onderwerp: `Padel ${dagTekst(p.datum)} om ${p.tijd}: doe je mee?`,
    tekst:
      `Hoi ${s.naam},\n\n` +
      "Volgens je beschikbaarheid kun je op dit moment, dus er is een partij voor je gepland.\n\n" +
      (p.geboekt
        ? `Iemand kan toch niet, dus je kunt invallen. De baan is al geboekt${spelerVan(ctx, p.boekerId) ? ` door ${spelerVan(ctx, p.boekerId)!.naam}` : ""}; je betaalt alleen je deel.\n\n`
        : p.automatisch ? `Bij het plannen was er bij ${clubVan(ctx, p.clubId).naam} nog een baan vrij. Wie als laatste van de vier bevestigt, boekt meteen de baan.\n\n` : "") +
      `Wanneer: ${partijTekst(ctx, p)}\n` +
      `Met: ${anderen.length ? naamLijst(anderen) : "nog onbekend"}\n\n` +
      `Laat het weten vóór ${tot}. Reageer je niet op tijd, dan vragen we iemand anders.`,
    knoppen: antwoordLinks(token),
  };
}

function gaatDoor(ctx: Context, p: Partij, vier: Speler[], boeker: Speler, laatste?: number): Mail[] {
  const club = clubVan(ctx, p.clubId);
  const pr = P.prijs(club, p.duur, p.datum, P.tijdId(naarMin(p.tijd), naarMin(p.tijd) + p.duur));
  const kosten = pr ? ` De baan kost ongeveer € ${pr.perBaan.toFixed(2).replace(".", ",")}, dat is € ${pr.perPersoon.toFixed(2).replace(".", ",")} per persoon.` : "";
  const planner = { label: "Naar de Padelplanner", url: `${siteUrl()}/?tab=planning` };
  const agenda = (s: Speler) => agendaLink(p, s.id);
  const bijlagen = [icsBijlage(ctx, p)];
  // De baan was al geboekt (er is een vervanger gevonden): niet opnieuw boeken, alleen je deel betalen.
  if (p.geboekt) {
    const bedrag = pr ? ` Je deel is ongeveer € ${pr.perPersoon.toFixed(2).replace(".", ",")}.` : "";
    const mails: Mail[] = vier.filter(kanMail).map((s) => {
      const rij = p.rijen.find((r) => r.spelerId === s.id);
      const tikkie = s.id !== boeker.id && !!p.betaallink && !rij?.betaald;
      return {
        aan: s.email!,
        naam: s.naam,
        onderwerp: `De partij van ${dagTekst(p.datum)} om ${p.tijd} is weer compleet`,
        tekst:
          `Hoi ${s.naam},\n\nDe partij is weer compleet en gaat door!\n\n` +
          `Wanneer: ${partijTekst(ctx, p)}\nSpelers: ${naamLijst(vier.map((x) => x.naam))}\n\n` +
          (s.id === boeker.id ? "Jij hebt de baan al geboekt, die hoeft niet opnieuw." : `De baan is al geboekt door ${boeker.naam}.${bedrag}`) +
          (tikkie ? " Betaal je deel via de Tikkie hieronder." : "") +
          `\n\nKun je toch niet? Meld je dan af op de site, dan zoeken we een vervanger.`,
        knoppen: [...(tikkie ? [{ label: "Betaal je deel (Tikkie)", url: p.betaallink! }] : []), ...([agenda(s)].filter(Boolean) as { label: string; url: string }[]), planner],
        bijlagen,
      };
    });
    // Speelt wie boekte zelf niet meer mee? Dan krijgt die bericht wie er invalt.
    if (!vier.some((s) => s.id === boeker.id) && kanMail(boeker)) {
      mails.push({
        aan: boeker.email!,
        naam: boeker.naam,
        onderwerp: `Er is een vervanger voor de partij van ${dagTekst(p.datum)}`,
        tekst: `Hoi ${boeker.naam},\n\nDe partij van ${partijTekst(ctx, p)} is weer compleet met ${naamLijst(vier.map((x) => x.naam))}. De baan die jij hebt geboekt wordt dus gebruikt. Spreek met de spelers af hoe zij jou betalen.`,
        knoppen: [planner],
      });
    }
    return mails;
  }
  return vier.filter(kanMail).map((s) => ({
    aan: s.email!,
    naam: s.naam,
    onderwerp: `De partij van ${dagTekst(p.datum)} om ${p.tijd} gaat door`,
    bijlagen,
    tekst:
      `Hoi ${s.naam},\n\nAlle vier spelers hebben bevestigd. De partij gaat door!\n\n` +
      `Wanneer: ${partijTekst(ctx, p)}\nSpelers: ${naamLijst(vier.map((x) => x.naam))}\n\n` +
      (s.id === boeker.id
        ? `${laatste === s.id ? "Jij bevestigde als laatste, dus jij boekt de baan." : "Jij boekt de baan."} Doe dat zo snel mogelijk via de knop hieronder.${kosten} Is er geen baan meer vrij? Laat het de anderen weten.\n\nGeboekt? Druk bij de partij op de site op "Baan is geboekt" en plak daar eventueel je Tikkie (of andere betaallink). De anderen krijgen dan een mail dat de baan geboekt is, met de Tikkie erin; je hebt hun nummers niet nodig. Ook zonder Tikkie krijgen ze die mail.`
        : `${boeker.naam} boekt de baan.${kosten}`) +
      `\n\nKun je toch niet? Meld je dan af op de site, dan zoeken we een vervanger.`,
    knoppen: [...(s.id === boeker.id ? [{ label: `Boek bij ${club.naam}`, url: club.boeken }] : []), ...([agenda(s)].filter(Boolean) as { label: string; url: string }[]), planner],
  }));
}

// ---- Een partij bijwerken: aanvullen met uitnodigingen en melden als het compleet is ----
async function nodigUit(ctx: Context, p: Partij, s: Speler, mails: Mail[]) {
  const token = randomBytes(18).toString("base64url");
  const nu = new Date();
  const waarden = { status: "uitgenodigd", token, uitgenodigd: nu, herinnerd: false, aangemeld: nu };
  await db
    .insert(partijDeelnemers)
    .values({ partijId: p.id, spelerId: s.id, ...waarden })
    .onConflictDoUpdate({ target: [partijDeelnemers.partijId, partijDeelnemers.spelerId], set: waarden });
  const rij = { partijId: p.id, spelerId: s.id, ...waarden } as Deelnemer;
  p.rijen = [...p.rijen.filter((r) => r.spelerId !== s.id), rij];
}

// De partij gaat niet door. Wie nog meedeed (of reserve/uitgenodigd was) krijgt een mail en kan die dag opnieuw worden ingepland.
// Wie afzegde of niet reageerde, blijft als "afgezegd"/"verlopen" bewaard en wordt die dag dus niet meer ingepland.
async function annuleer(ctx: Context, p: Partij, mails: Mail[]) {
  const gelukt = await db
    .update(partijen)
    .set({ geannuleerd: true, compleetGemeld: false })
    .where(and(eq(partijen.id, p.id), eq(partijen.geannuleerd, false)))
    .returning({ id: partijen.id });
  p.geannuleerd = true;
  if (!gelukt.length) return; // al geannuleerd (bijv. tegelijk door een ander verzoek)
  const actief = spelendVan(p);
  if (actief.length) {
    await db
      .update(partijDeelnemers)
      .set({ status: "geannuleerd" })
      .where(and(eq(partijDeelnemers.partijId, p.id), inArray(partijDeelnemers.status, ["uitgenodigd", "bevestigd"])));
  }
  for (const r of actief) r.status = "geannuleerd";
  const weg = p.rijen.filter(nietOpDag).map((r) => spelerVan(ctx, r.spelerId)?.naam).filter(Boolean) as string[];
  const boeker = spelerVan(ctx, p.boekerId);
  for (const r of actief) {
    const s = spelerVan(ctx, r.spelerId);
    if (!kanMail(s)) continue;
    mails.push({
      aan: s.email!,
      naam: s.naam,
      onderwerp: `Geannuleerd: padel ${dagTekst(p.datum)} om ${p.tijd}`,
      tekst:
        `Hoi ${s.naam},\n\nDe partij van ${partijTekst(ctx, p)} gaat helaas niet door. ` +
        (weg.length ? `${naamLijst(weg)} kon${weg.length > 1 ? "den" : ""} niet (of reageerde niet op tijd) en ` : "Er konden niet genoeg spelers en ") +
        "er is geen andere speler gevonden die op dat moment kan.\n\n" +
        (boeker && boeker.id === s.id ? "Had je de baan toch al geboekt? Annuleer hem dan bij de club.\n\n" : "") +
        "Je beschikbaarheid blijft staan: kunnen er op een ander moment vier spelers, dan plannen we automatisch een nieuwe partij. " +
        `Wie bij deze partij afzegde of niet reageerde, plannen we op ${dagTekst(p.datum)} niet meer in.`,
      knoppen: [{ label: "Naar de Padelplanner", url: `${siteUrl()}/?tab=planning` }],
    });
  }
}

// `laatste`: de speler die net bevestigde. Maakt die de partij compleet, dan boekt die meteen de baan.
// Geeft true terug als `laatste` daardoor de boeker is geworden.
async function werkBij(ctx: Context, p: Partij, mails: Mail[], laatste?: number): Promise<boolean> {
  const start = nlMoment(p.datum, p.tijd);
  if (start < Date.now() || p.geannuleerd) return false;
  const spelend = spelendVan(p);

  // Aanvullen tot vier (niet meer in de laatste 3 uur voor de partij).
  if (p.automatisch && spelend.length < MAX_SPELERS && start - Date.now() > 3 * UUR) {
    const groep = spelend.map((r) => spelerVan(ctx, r.spelerId)).filter(Boolean) as Speler[];
    const nieuw: Speler[] = [];
    const kandidaten = ctx.spelers
      .filter((s) => !p.rijen.some((r) => r.spelerId === s.id))
      .sort((a, b) => aantalPartijen(ctx, a) - aantalPartijen(ctx, b) || a.id - b.id);
    for (const s of kandidaten) {
      if (groep.length + nieuw.length >= MAX_SPELERS) break;
      if (pastBij(ctx, s, p, [...groep, ...nieuw])) nieuw.push(s);
    }
    for (const s of nieuw) await nodigUit(ctx, p, s, mails);
    for (const s of nieuw) {
      const rij = p.rijen.find((r) => r.spelerId === s.id)!;
      const m = uitnodiging(ctx, p, s, rij.token!);
      if (m) mails.push(m);
    }
  }

  // Geen vervanger te vinden (of te laat om nog te zoeken) en de baan is nog niet geboekt: de partij gaat niet door.
  // Een geboekte baan wordt niet automatisch geannuleerd; dan zoeken de spelers zelf iemand.
  if (p.automatisch && !p.geboekt && spelendVan(p).length < MAX_SPELERS && p.rijen.some(nietOpDag)) {
    await annuleer(ctx, p, mails);
    return false;
  }

  // Compleet: vier spelers hebben bevestigd.
  const vierRijen = spelendVan(p).slice(0, MAX_SPELERS);
  if (!p.compleetGemeld && vierRijen.length === MAX_SPELERS && vierRijen.every((r) => r.status === "bevestigd")) {
    const vier = vierRijen.map((r) => spelerVan(ctx, r.spelerId)).filter(Boolean) as Speler[];
    // Bleef wie al boekte in de partij, dan blijft die boeken (de baan kan al geboekt zijn).
    // Anders boekt wie de partij net compleet maakte, zodat er niet nog op iemand anders gewacht hoeft te worden.
    // Was de baan al geboekt (er viel iemand in), dan blijft wie boekte de boeker, ook als die zelf niet meer meespeelt.
    let boeker = vier.find((s) => s.id === p.boekerId) ?? (p.geboekt ? spelerVan(ctx, p.boekerId) : undefined) ?? vier.find((s) => s.id === laatste);
    if (!boeker) {
      // Wie het minst vaak heeft geboekt, boekt nu (zo rouleert het).
      const keer = (s: Speler) => ctx.partijen.filter((q) => q.boekerId === s.id).length;
      boeker = vier.slice().sort((a, b) => keer(a) - keer(b) || a.id - b.id)[0];
    }
    // Alleen als niemand anders de partij intussen al compleet heeft gemeld (twee spelers die tegelijk bevestigen).
    const gelukt = await db
      .update(partijen)
      .set({ compleetGemeld: true, boekerId: boeker.id })
      .where(and(eq(partijen.id, p.id), eq(partijen.compleetGemeld, false)))
      .returning({ id: partijen.id });
    if (!gelukt.length) {
      const [nu] = await db.select().from(partijen).where(eq(partijen.id, p.id));
      if (nu) Object.assign(p, { compleetGemeld: nu.compleetGemeld, boekerId: nu.boekerId });
      return false;
    }
    p.compleetGemeld = true;
    p.boekerId = boeker.id;
    mails.push(...gaatDoor(ctx, p, vier, boeker, laatste));
    return !p.geboekt && boeker.id === laatste;
  }
  return false;
}

// ---- Baan geboekt / betaallink (Tikkie) delen ----
// Zodra wie boekt de baan op "geboekt" zet, krijgen de andere spelers een mail dat de baan geboekt is,
// met de Tikkie erin als die meteen is geplakt (en ook zonder Tikkie gaat de mail).
// Plakt die later alsnog (of een nieuwe) betaallink, dan krijgen wie nog niet betaald hebben die per mail.
export async function meldGeboekt(partijId: number, soort: "geboekt" | "betaallink" = "geboekt") {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || (soort === "betaallink" && !p.betaallink)) return;
  const club = clubVan(ctx, p.clubId);
  const boeker = spelerVan(ctx, p.boekerId);
  const pr = P.prijs(club, p.duur, p.datum, P.tijdId(naarMin(p.tijd), naarMin(p.tijd) + p.duur));
  const bedrag = pr ? ` Je deel is ongeveer € ${pr.perPersoon.toFixed(2).replace(".", ",")}.` : "";
  const wie = boeker?.naam ?? "Wie de baan boekt";
  const planner = { label: "Naar de Padelplanner", url: `${siteUrl()}/?tab=planning` };
  const mails: Mail[] = [];
  for (const r of spelendVan(p).slice(0, MAX_SPELERS)) {
    if (r.spelerId === p.boekerId || r.status !== "bevestigd") continue;
    if (soort === "betaallink" && r.betaald) continue;
    const s = spelerVan(ctx, r.spelerId);
    if (!kanMail(s)) continue;
    const metLink = !!p.betaallink && !r.betaald;
    mails.push({
      aan: s.email!,
      naam: s.naam,
      onderwerp: soort === "geboekt"
        ? `De baan is geboekt: padel op ${dagTekst(p.datum)}`
        : `Betaal je deel van de baan voor ${dagTekst(p.datum)}`,
      tekst:
        `Hoi ${s.naam},\n\n${wie} heeft de baan geboekt voor de partij van ${partijTekst(ctx, p)}.` +
        (soort === "geboekt" ? " De partij is rond, tot dan!" : "") +
        (metLink
          ? `${bedrag}\n\nBetaal je deel via de Tikkie hieronder. Op de site kun je daarna aangeven dat je hebt betaald.`
          : `${bedrag}\n\nEr is (nog) geen Tikkie bij de partij gezet. Spreek met ${wie} af hoe je je deel betaalt.`),
      knoppen: metLink ? [{ label: "Betaal je deel (Tikkie)", url: p.betaallink! }, planner] : [planner],
    });
  }
  await verstuur(mails);
}

// ---- Antwoorden op een uitnodiging (via de e-mail of op de site) ----
export type Antwoord = { ok: true; tekst: string; boeken?: { club: string; url: string } } | { ok: false; fout: string; status?: number };

export async function beantwoord(partijId: number, spelerId: number, ja: boolean): Promise<Antwoord> {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || nlMoment(p.datum, p.tijd) < Date.now()) return { ok: false, fout: "Deze partij bestaat niet meer of is al voorbij.", status: 404 };
  if (p.geannuleerd) return ja ? { ok: false, fout: "Deze partij is geannuleerd: er konden niet genoeg spelers.", status: 409 } : { ok: true, tekst: "Deze partij was al geannuleerd." };
  const s = spelerVan(ctx, spelerId);
  if (!s) return { ok: false, fout: "Onbekende speler.", status: 404 };
  const rij = p.rijen.find((r) => r.spelerId === spelerId);
  const mails: Mail[] = [];
  // "Kan toch niet"-mails aan de anderen; niet nodig als de partij daardoor wordt geannuleerd (dan krijgen ze die mail).
  const afzegMails: Mail[] = [];
  let tekst: string;

  if (ja) {
    if (rij?.status === "bevestigd") {
      // Klikt wie boekt nog een keer (bijv. opnieuw via de mail): laat de boekknop dan weer zien.
      if (p.compleetGemeld && p.boekerId === s.id && !p.geboekt) {
        const club = clubVan(ctx, p.clubId);
        return {
          ok: true,
          tekst: `Je had al bevestigd en jij boekt de baan. Nog niet gedaan? Boek nu bij ${club.naam}. Geboekt? Druk daarna op de site bij de partij op "Baan is geboekt" en plak eventueel je Tikkie.`,
          boeken: { club: club.naam, url: club.boeken },
        };
      }
      return { ok: true, tekst: "Je had al bevestigd. Tot dan!" };
    }
    if (rij?.status === "uitgenodigd") {
      await db.update(partijDeelnemers).set({ status: "bevestigd" }).where(and(eq(partijDeelnemers.partijId, p.id), eq(partijDeelnemers.spelerId, s.id)));
      rij.status = "bevestigd";
      tekst = "Top, je doet mee! Zodra alle vier spelers hebben bevestigd, krijg je een mail wie de baan boekt.";
    } else {
      if (speeltAlOpDag(ctx, s.id, p.datum, p.id)) return { ok: false, fout: "Je staat die dag al bij een andere partij. Je kunt maar één keer per dag spelen.", status: 409 };
      if (p.automatisch && kanNietOpDag(ctx, s.id, p.datum, p.id))
        return { ok: false, fout: "Je hebt die dag al een andere partij afgezegd of niet op tijd bevestigd, dus je wordt die dag niet meer ingepland.", status: 409 };
      // Zelf opgeven (of terugkomen na een afzegging): achteraan, dus reserve als er al vier zijn.
      const nu = new Date();
      const waarden = { status: "bevestigd", aangemeld: nu, token: rij?.token ?? null };
      await db
        .insert(partijDeelnemers)
        .values({ partijId: p.id, spelerId: s.id, ...waarden })
        .onConflictDoUpdate({ target: [partijDeelnemers.partijId, partijDeelnemers.spelerId], set: waarden });
      p.rijen = [...p.rijen.filter((r) => r.spelerId !== s.id), { ...(rij ?? { partijId: p.id, spelerId: s.id, uitgenodigd: null, herinnerd: false }), ...waarden } as Deelnemer];
      const plek = spelendVan(p).findIndex((r) => r.spelerId === s.id);
      tekst = plek < MAX_SPELERS ? "Je doet mee!" : "De partij is al vol. Je staat op de reservelijst en schuift door als iemand afzegt.";
    }
  } else {
    if (!rij || !isActief(rij)) return { ok: true, tekst: "Je stond al niet (meer) bij deze partij." };
    const speeldeMee = spelendVan(p).slice(0, MAX_SPELERS).some((r) => r.spelerId === s.id);
    if (p.automatisch) {
      // Bewaren als afgezegd, zodat we deze speler niet opnieuw voor deze partij vragen.
      await db.update(partijDeelnemers).set({ status: "afgezegd" }).where(and(eq(partijDeelnemers.partijId, p.id), eq(partijDeelnemers.spelerId, s.id)));
      rij.status = "afgezegd";
    } else {
      await db.delete(partijDeelnemers).where(and(eq(partijDeelnemers.partijId, p.id), eq(partijDeelnemers.spelerId, s.id)));
      p.rijen = p.rijen.filter((r) => r.spelerId !== s.id);
    }
    const laat = nlMoment(p.datum, p.tijd) - Date.now() <= 3 * UUR;
    tekst = !p.automatisch ? "Je bent afgemeld."
      : !speeldeMee ? "Je staat niet meer op de reservelijst."
      : laat ? "Je bent afgemeld. De partij begint binnen 3 uur, dus we zoeken niet meer automatisch een vervanger. De andere spelers krijgen een mail."
      : p.compleetGemeld ? "Je bent afgemeld. We zoeken een vervanger: eerst op de reservelijst, daarna bij andere spelers die kunnen. De anderen krijgen een mail."
      : "Jammer! We vragen iemand anders.";
    // Was de partij al compleet, dan horen de anderen het en zoeken we opnieuw.
    if (speeldeMee && p.compleetGemeld) {
      // Is de baan al geboekt, dan blijft die op naam van wie boekte: die hoeft niet opnieuw te boeken.
      const boekerWeg = p.boekerId === s.id && !p.geboekt;
      const geboektDoorMij = p.boekerId === s.id && p.geboekt;
      await db.update(partijen).set({ compleetGemeld: false, ...(boekerWeg ? { boekerId: null } : {}) }).where(eq(partijen.id, p.id));
      p.compleetGemeld = false;
      if (boekerWeg) p.boekerId = null;
      if (geboektDoorMij) tekst += " De baan blijft op jouw naam staan; spreek met de vervanger af hoe die jou betaalt.";
      for (const r of spelendVan(p)) {
        const ander = spelerVan(ctx, r.spelerId);
        if (!kanMail(ander)) continue;
        afzegMails.push({
          aan: ander.email!,
          naam: ander.naam,
          onderwerp: `${s.naam} kan toch niet op ${dagTekst(p.datum)}`,
          tekst:
            `Hoi ${ander.naam},\n\n${s.naam} kan toch niet meedoen aan de partij van ${partijTekst(ctx, p)}.\n\n` +
            (p.automatisch && !laat
              ? "We zoeken een vervanger: eerst op de reservelijst, daarna bij andere spelers die kunnen. Je krijgt een mail zodra de partij weer compleet is."
              : "De partij begint binnenkort, dus we zoeken niet automatisch meer een vervanger. Weet je iemand die kan invallen? Vraag het gerust.") +
            (p.geboekt ? `\n\nDe baan is al geboekt${spelerVan(ctx, p.boekerId) ? ` door ${spelerVan(ctx, p.boekerId)!.naam}` : ""} en blijft staan.` : "") +
            (boekerWeg ? `\n\nLet op: ${s.naam} zou de baan boeken. Zodra de partij weer compleet is, boekt iemand anders.` : ""),
          knoppen: [{ label: "Naar de Padelplanner", url: `${siteUrl()}/?tab=planning` }],
        });
      }
    }
  }
  // Opnieuw ophalen: bevestigde een andere speler net tegelijk, dan telt die ook mee.
  const [vers] = await db.select().from(partijen).where(eq(partijen.id, p.id));
  if (vers) Object.assign(p, { compleetGemeld: vers.compleetGemeld, boekerId: vers.boekerId });
  p.rijen = await db.select().from(partijDeelnemers).where(eq(partijDeelnemers.partijId, p.id));
  const ikBoek = await werkBij(ctx, p, mails, ja ? s.id : undefined);
  if (!p.geannuleerd) mails.unshift(...afzegMails);
  await verstuur(mails);
  if (!ja && p.geannuleerd) tekst = "Je bent afgemeld. Er is geen vervanger gevonden, dus de partij is geannuleerd. De andere spelers krijgen een mail.";
  if (ikBoek) {
    const club = clubVan(ctx, p.clubId);
    return {
      ok: true,
      tekst: `Je bent de vierde, de partij gaat door! Jij boekt de baan: doe dat nu meteen bij ${club.naam}. Geboekt? Druk daarna op de site bij de partij op "Baan is geboekt" en plak eventueel je Tikkie.`,
      boeken: { club: club.naam, url: club.boeken },
    };
  }
  // Meedoen in een partij die (nu) compleet is, maar iemand anders boekt: zeg dat er meteen bij.
  if (ja && p.compleetGemeld && spelendVan(p).slice(0, MAX_SPELERS).some((r) => r.spelerId === s.id)) {
    const boeker = spelerVan(ctx, p.boekerId);
    if (boeker && boeker.id !== s.id) tekst = `Je doet mee en de partij is compleet, dus hij gaat door! ${boeker.naam} boekt de baan.`;
  }
  return { ok: true, tekst };
}

// Na het aanmaken van een partij op de site: meteen aanvullen met uitnodigingen.
export async function werkPartijBij(partijId: number) {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p) return;
  const mails: Mail[] = [];
  await werkBij(ctx, p, mails);
  await verstuur(mails);
}

// ---- Nieuwe partijen zoeken ----
// Speelduur: de langste die iedereen in het groepje wil. Starttijd en club: waar mogelijk een live vrije baan.
async function liveKeuze(datum: string, slot: any, duur: number, opties: any[]) {
  try {
    const r = await fetch(`${siteUrl()}/api/banen?datum=${datum}&slot=${slot.id}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const live = await r.json();
    const eind = naarMin(slot.tot);
    let beste: { clubId: string; tijd: string; prijs: number } | null = null;
    for (const o of opties) {
      const c = live?.clubs?.[o.club.id];
      if (!c?.live || !c.boekbaar) continue;
      for (const st of c.starts ?? []) {
        if (naarMin(st.tijd) + duur > eind) continue;
        const prijzen = (st.banen ?? []).map((b: any) => b.prijzen?.[String(duur)]).filter((x: any) => x != null);
        if (!prijzen.length) continue;
        const prijs = Math.min(...prijzen);
        if (!beste || prijs < beste.prijs) beste = { clubId: o.club.id, tijd: st.tijd, prijs };
        break;
      }
    }
    return beste;
  } catch {
    return null;
  }
}

function zonderAfgezegdeDagen(ctx: Context, s: Speler, dagen: string[]): Speler {
  const weg = dagen.filter((d) => kanNietOpDag(ctx, s.id, d));
  if (!weg.length) return s;
  const weken: Speler["weken"] = {};
  for (const [w, v] of Object.entries(s.weken)) {
    const tijdvakken = { ...v.tijdvakken };
    for (const d of weg) delete tijdvakken[d];
    weken[w] = { ...v, tijdvakken };
  }
  return { ...s, weken };
}

async function zoekNieuwePartijen(ctx: Context, mails: Mail[]) {
  // Niet wachten tot iedereen heeft ingevuld: zodra vier passende spelers op hetzelfde moment kunnen, wordt er gepland.
  // Maar alleen als er op dat moment ook echt een baan vrij is: anders worden er geen uitnodigingen verstuurd.
  const dagen: string[] = [];
  const maxDagenVooruit = P.boekingsHorizon(ctx.clubs);
  for (let i = MIN_DAGEN_VOORUIT; i <= maxDagenVooruit; i++) dagen.push(plusDagen(ctx.vandaag, i));
  const vandaagDatum = P.parseKey(ctx.vandaag);
  const begin = Date.now();
  let gemaakt = 0;
  let checks = 0;
  const geprobeerd = new Set<string>();
  const perWeek = new Map<string, string[]>();
  for (const d of dagen) perWeek.set(maandag(d), [...(perWeek.get(maandag(d)) ?? []), d]);
  // Binnen de tijdslimiet van de functie blijven: niet eindeloos clubs blijven bevragen.
  const genoegGezocht = () => checks >= MAX_BAAN_CHECKS || Date.now() - begin > MAX_ZOEKTIJD;
  for (const weekDagen of perWeek.values()) {
    while (gemaakt < MAX_NIEUW_PER_RUN && !genoegGezocht()) {
      // Alleen spelers die deze week nog willen spelen (volgens "hoe vaak").
      // Dagen waarop iemand al een partij afzegde of niet bevestigde, tellen niet mee als beschikbaar.
      const pool = ctx.spelers.filter((s) => heeftRuimte(ctx, s, weekDagen[0])).map((s) => zonderAfgezegdeDagen(ctx, s, weekDagen));
      if (pool.length < MAX_SPELERS) break;
      const kandidaten = P.plan(pool, ctx.clubs, vandaagDatum, 30, weekDagen);
      let gekozen: { k: any; groep: Speler[]; duur: number; clubId: string; tijd: string } | null = null;
      for (const k of kandidaten) {
        if (genoegGezocht()) break;
        const sleutel = k.datum + k.slot.id + k.voorbeeldGroep.join("|");
        if (geprobeerd.has(sleutel)) continue;
        geprobeerd.add(sleutel);
        const groep = k.voorbeeldGroep.map((n: string) => pool.find((s) => s.naam === n)).filter(Boolean) as Speler[];
        // Alleen clubs waar je op die dag al kunt boeken.
        const opties = k.opties.filter((o: any) => o.status.soort === "boekbaar");
        if (groep.length !== MAX_SPELERS || !opties.length) continue;
        const duur = Math.max(...k.duren.map(Number));
        // Eerst kijken of de spelers in principe passen, pas daarna de clubs bevragen.
        const voorlopig = { datum: k.datum, tijd: k.slot.van, duur, clubId: opties[0].club.id };
        if (!groep.every((s, i) => pastBij(ctx, s, voorlopig, groep.filter((_, j) => j !== i)))) continue;
        checks++;
        const live = await liveKeuze(k.datum, k.slot, duur, opties);
        if (!live) continue; // geen vrije baan (of de club was niet bereikbaar): niemand uitnodigen
        const voorstel = { datum: k.datum, tijd: live.tijd, duur, clubId: live.clubId };
        if (groep.every((s, i) => pastBij(ctx, s, voorstel, groep.filter((_, j) => j !== i)))) {
          gekozen = { k, groep, duur, clubId: live.clubId, tijd: live.tijd };
          break;
        }
      }
      if (!gekozen) break;
      const { k, groep, duur, clubId, tijd } = gekozen;
      const [nieuw] = await db
        .insert(partijen)
        .values({ datum: k.datum, tijd, duur, clubId, automatisch: true, opmerking: "Automatisch gepland" })
        .returning();
      const p: Partij = { ...nieuw, rijen: [] };
      ctx.partijen.push(p);
      for (const s of groep) await nodigUit(ctx, p, s, mails);
      for (const s of groep) {
        const m = uitnodiging(ctx, p, s, p.rijen.find((r) => r.spelerId === s.id)!.token!);
        if (m) mails.push(m);
      }
      gemaakt++;
    }
  }
  return gemaakt;
}

// ---- Elk uur ----
export async function automatischPlannen() {
  const ctx = await laad();
  const mails: Mail[] = [];
  const nu = Date.now();
  let verlopen = 0;

  for (const p of ctx.partijen) {
    if (nlMoment(p.datum, p.tijd) < nu || p.geannuleerd) continue;
    for (const r of p.rijen) {
      if (r.status !== "uitgenodigd" || !r.uitgenodigd) continue;
      const tot = verlooptOp(r.uitgenodigd, p);
      if (tot <= nu) {
        // Niet op tijd gereageerd: plek vrijgeven.
        await db.update(partijDeelnemers).set({ status: "verlopen" }).where(and(eq(partijDeelnemers.partijId, p.id), eq(partijDeelnemers.spelerId, r.spelerId)));
        r.status = "verlopen";
        verlopen++;
      }
    }
  }
  for (const p of ctx.partijen) await werkBij(ctx, p, mails);
  await dagHerinneringen(ctx, mails);
  const nieuw = await zoekNieuwePartijen(ctx, mails);
  await verstuur(mails);
  console.log(`Automatisch plannen: ${nieuw} nieuwe partij(en), ${verlopen} verlopen uitnodiging(en), ${mails.length} e-mail(s).`);
}

// Gegevens van een uitnodiging opzoeken via de sleutel uit de e-mail.
export async function zoekUitnodiging(token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const [r] = await db.select().from(partijDeelnemers).where(eq(partijDeelnemers.token, token));
  return r ?? null;
}

// ---- Herinnering op de dag zelf ----
// Zo'n 3 à 4 uur voor een partij die doorgaat: tijd, club, wie er meespelen, en de Tikkie voor wie nog niet heeft betaald.
async function dagHerinneringen(ctx: Context, mails: Mail[]) {
  const nu = Date.now();
  for (const p of ctx.partijen) {
    if (!p.compleetGemeld || p.dagHerinnerd || p.geannuleerd) continue;
    const start = nlMoment(p.datum, p.tijd);
    if (start <= nu || start - nu > 4 * UUR) continue;
    const vier = spelendVan(p).slice(0, MAX_SPELERS);
    if (vier.length < MAX_SPELERS) continue;
    await db.update(partijen).set({ dagHerinnerd: true }).where(eq(partijen.id, p.id));
    p.dagHerinnerd = true;
    const club = clubVan(ctx, p.clubId);
    const boeker = spelerVan(ctx, p.boekerId);
    const namen = vier.map((r) => spelerVan(ctx, r.spelerId)?.naam).filter(Boolean) as string[];
    const pr = P.prijs(club, p.duur, p.datum, P.tijdId(naarMin(p.tijd), naarMin(p.tijd) + p.duur));
    const bedrag = pr ? ` (ongeveer € ${pr.perPersoon.toFixed(2).replace(".", ",")})` : "";
    for (const r of vier) {
      const s = spelerVan(ctx, r.spelerId);
      if (!kanMail(s)) continue;
      const ikBoek = s.id === p.boekerId;
      const tikkie = !ikBoek && p.geboekt && !!p.betaallink && !r.betaald;
      mails.push({
        aan: s.email!,
        naam: s.naam,
        onderwerp: `Vandaag padel om ${p.tijd} bij ${club.naam}`,
        tekst:
          `Hoi ${s.naam},\n\nVandaag is het zover!\n\n` +
          `Wanneer: ${partijTekst(ctx, p)}\nSpelers: ${naamLijst(namen)}\n` +
          (p.geboekt
            ? `Baan: geboekt${boeker ? ` door ${boeker.naam}` : ""}.`
            : ikBoek ? "Let op: de baan staat nog niet op geboekt. Boek hem nu en zet hem op de site op geboekt." : `Let op: de baan staat nog niet op geboekt${boeker ? `; ${boeker.naam} boekt hem` : ""}.`) +
          (p.opmerking && p.opmerking !== "Automatisch gepland" ? `\nOpmerking: ${p.opmerking}` : "") +
          (tikkie ? `\n\nJe hebt je deel${bedrag} nog niet betaald. Dat kan via de Tikkie hieronder.` : "") +
          `\n\nKun je toch niet? Meld je dan zo snel mogelijk af op de site, dan krijgen de anderen bericht. Veel plezier!`,
        knoppen: [
          ...(tikkie ? [{ label: "Betaal je deel (Tikkie)", url: p.betaallink! }] : []),
          ...(ikBoek && !p.geboekt ? [{ label: `Boek bij ${club.naam}`, url: club.boeken }] : []),
          { label: "Naar de Padelplanner", url: `${siteUrl()}/?tab=planning` },
        ],
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
