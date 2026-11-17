// Automatisch plannen met e-mail.
// - De site zoekt zelf momenten waarop vier passende spelers kunnen én er live een baan vrij is, en maakt daar een partij van.
// - Die spelers krijgen een uitnodiging per e-mail met "Ik doe mee" / "Kan toch niet".
// - Wie afzegt of niet op tijd reageert, wordt vervangen door de volgende speler die ook kan.
// - Hebben vier spelers bevestigd, dan krijgt iedereen een mail dat de partij doorgaat en wie de baan boekt.
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

// Uiterste moment om te reageren: de helft van de tijd tot de partij, minstens 2 en hooguit 24 uur.
export function verlooptOp(uitgenodigd: Date, partij: { datum: string; tijd: string }) {
  const start = nlMoment(partij.datum, partij.tijd);
  const marge = Math.min(24 * UUR, Math.max(2 * UUR, (start - uitgenodigd.getTime()) / 2));
  return uitgenodigd.getTime() + marge;
}

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
      return { ...s, weken };
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
const overlapt = (a: Partij, datum: string, tijd: string, duur: number) =>
  a.datum === datum && naarMin(a.tijd) < naarMin(tijd) + duur && naarMin(tijd) < naarMin(a.tijd) + a.duur;

// Hoe vaak iemand per week wil spelen. "Om de week": niet als er de week ervoor of erna al een partij is.
function heeftRuimte(ctx: Context, s: Speler, datum: string, behalve?: number) {
  const mijn = ctx.partijen.filter((p) => p.id !== behalve && p.rijen.some((r) => r.spelerId === s.id && isActief(r)));
  const week = maandag(datum);
  const dezeWeek = mijn.filter((p) => maandag(p.datum) === week).length;
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
  // Niet tegelijk in een andere partij, en niet opnieuw vragen op een dag waarop iemand al heeft afgezegd.
  for (const q of ctx.partijen) {
    if (q.id === p.id) continue;
    const r = q.rijen.find((x) => x.spelerId === s.id);
    if (!r) continue;
    if (isActief(r) && overlapt(q, p.datum, p.tijd, p.duur)) return false;
    if (!isActief(r) && q.datum === p.datum && q.automatisch) return false;
  }
  return true;
}

// Voorrang voor wie de komende tijd het minst speelt.
const aantalPartijen = (ctx: Context, s: Speler) =>
  ctx.partijen.filter((p) => p.datum >= ctx.vandaag && p.rijen.some((r) => r.spelerId === s.id && isActief(r))).length;

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
      (p.automatisch ? `Bij het plannen was er bij ${clubVan(ctx, p.clubId).naam} nog een baan vrij. Die wordt geboekt zodra alle vier spelers hebben bevestigd.\n\n` : "") +
      `Wanneer: ${partijTekst(ctx, p)}\n` +
      `Met: ${anderen.length ? naamLijst(anderen) : "nog onbekend"}\n\n` +
      `Laat het weten vóór ${tot}. Reageer je niet op tijd, dan vragen we iemand anders.`,
    knoppen: antwoordLinks(token),
  };
}

function gaatDoor(ctx: Context, p: Partij, vier: Speler[], boeker: Speler): Mail[] {
  const club = clubVan(ctx, p.clubId);
  const pr = P.prijs(club, p.duur, p.datum, P.tijdId(naarMin(p.tijd), naarMin(p.tijd) + p.duur));
  const kosten = pr ? ` De baan kost ongeveer € ${pr.perBaan.toFixed(2).replace(".", ",")}, dat is € ${pr.perPersoon.toFixed(2).replace(".", ",")} per persoon.` : "";
  return vier.filter(kanMail).map((s) => ({
    aan: s.email!,
    naam: s.naam,
    onderwerp: `De partij van ${dagTekst(p.datum)} om ${p.tijd} gaat door`,
    tekst:
      `Hoi ${s.naam},\n\nAlle vier spelers hebben bevestigd. De partij gaat door!\n\n` +
      `Wanneer: ${partijTekst(ctx, p)}\nSpelers: ${naamLijst(vier.map((x) => x.naam))}\n\n` +
      (s.id === boeker.id
        ? `Jij boekt de baan. Doe dat zo snel mogelijk via de knop hieronder.${kosten} Is er geen baan meer vrij? Laat het de anderen weten.\n\nGeboekt? Zet dat bij de partij op de site en plak daar je Tikkie (of andere betaallink). De anderen krijgen die dan vanzelf per mail; je hebt hun nummers niet nodig.`
        : `${boeker.naam} boekt de baan.${kosten}`) +
      `\n\nKun je toch niet? Meld je dan af op de site, dan zoeken we een vervanger.`,
    knoppen: s.id === boeker.id ? [{ label: `Boek bij ${club.naam}`, url: club.boeken }, { label: "Naar de Padelplanner", url: `${siteUrl()}/?tab=planning` }] : [{ label: "Naar de Padelplanner", url: `${siteUrl()}/?tab=planning` }],
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

async function werkBij(ctx: Context, p: Partij, mails: Mail[]) {
  const start = nlMoment(p.datum, p.tijd);
  if (start < Date.now()) return;
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

  // Compleet: vier spelers hebben bevestigd.
  const vierRijen = spelendVan(p).slice(0, MAX_SPELERS);
  if (!p.compleetGemeld && vierRijen.length === MAX_SPELERS && vierRijen.every((r) => r.status === "bevestigd")) {
    const vier = vierRijen.map((r) => spelerVan(ctx, r.spelerId)).filter(Boolean) as Speler[];
    let boeker = vier.find((s) => s.id === p.boekerId);
    if (!boeker) {
      // Wie het minst vaak heeft geboekt, boekt nu (zo rouleert het).
      const keer = (s: Speler) => ctx.partijen.filter((q) => q.boekerId === s.id).length;
      boeker = vier.slice().sort((a, b) => keer(a) - keer(b) || a.id - b.id)[0];
    }
    await db.update(partijen).set({ compleetGemeld: true, boekerId: boeker.id }).where(eq(partijen.id, p.id));
    p.compleetGemeld = true;
    p.boekerId = boeker.id;
    mails.push(...gaatDoor(ctx, p, vier, boeker));
  }
}

// ---- Betaallink (Tikkie) delen ----
// Wie boekt plakt een betaallink; de andere spelers die nog niet hebben betaald krijgen die per mail.
export async function deelBetaallink(partijId: number) {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || !p.betaallink) return;
  const club = clubVan(ctx, p.clubId);
  const boeker = spelerVan(ctx, p.boekerId);
  const pr = P.prijs(club, p.duur, p.datum, P.tijdId(naarMin(p.tijd), naarMin(p.tijd) + p.duur));
  const bedrag = pr ? ` Je deel is ongeveer € ${pr.perPersoon.toFixed(2).replace(".", ",")}.` : "";
  const wie = boeker?.naam ?? "Wie de baan boekte";
  const mails: Mail[] = [];
  for (const r of spelendVan(p).slice(0, MAX_SPELERS)) {
    if (r.spelerId === p.boekerId || r.betaald || r.status !== "bevestigd") continue;
    const s = spelerVan(ctx, r.spelerId);
    if (!kanMail(s)) continue;
    mails.push({
      aan: s.email!,
      naam: s.naam,
      onderwerp: `Betaal je deel van de baan voor ${dagTekst(p.datum)}`,
      tekst:
        `Hoi ${s.naam},\n\n${wie} heeft de baan geboekt voor de partij van ${partijTekst(ctx, p)}.${bedrag}\n\n` +
        `Betaal je deel via de knop hieronder. Op de site kun je daarna aangeven dat je hebt betaald.`,
      knoppen: [{ label: "Betaal je deel", url: p.betaallink }, { label: "Naar de Padelplanner", url: `${siteUrl()}/?tab=planning` }],
    });
  }
  await verstuur(mails);
}

// ---- Antwoorden op een uitnodiging (via de e-mail of op de site) ----
export type Antwoord = { ok: true; tekst: string } | { ok: false; fout: string; status?: number };

export async function beantwoord(partijId: number, spelerId: number, ja: boolean): Promise<Antwoord> {
  const ctx = await laad();
  const p = ctx.partijen.find((x) => x.id === partijId);
  if (!p || nlMoment(p.datum, p.tijd) < Date.now()) return { ok: false, fout: "Deze partij bestaat niet meer of is al voorbij.", status: 404 };
  const s = spelerVan(ctx, spelerId);
  if (!s) return { ok: false, fout: "Onbekende speler.", status: 404 };
  const rij = p.rijen.find((r) => r.spelerId === spelerId);
  const mails: Mail[] = [];
  let tekst: string;

  if (ja) {
    if (rij?.status === "bevestigd") return { ok: true, tekst: "Je had al bevestigd. Tot dan!" };
    if (rij?.status === "uitgenodigd") {
      await db.update(partijDeelnemers).set({ status: "bevestigd" }).where(and(eq(partijDeelnemers.partijId, p.id), eq(partijDeelnemers.spelerId, s.id)));
      rij.status = "bevestigd";
      tekst = "Top, je doet mee! Zodra alle vier spelers hebben bevestigd, krijg je een mail wie de baan boekt.";
    } else {
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
    tekst = p.automatisch ? "Jammer! We vragen iemand anders." : "Je bent afgemeld.";
    // Was de partij al compleet, dan horen de anderen het en zoeken we opnieuw.
    if (speeldeMee && p.compleetGemeld) {
      const boekerWeg = p.boekerId === s.id;
      await db.update(partijen).set({ compleetGemeld: false, ...(boekerWeg ? { boekerId: null } : {}) }).where(eq(partijen.id, p.id));
      p.compleetGemeld = false;
      if (boekerWeg) p.boekerId = null;
      for (const r of spelendVan(p)) {
        const ander = spelerVan(ctx, r.spelerId);
        if (!kanMail(ander)) continue;
        mails.push({
          aan: ander.email!,
          naam: ander.naam,
          onderwerp: `${s.naam} kan toch niet op ${dagTekst(p.datum)}`,
          tekst:
            `Hoi ${ander.naam},\n\n${s.naam} kan toch niet meedoen aan de partij van ${partijTekst(ctx, p)}.\n\n` +
            (p.automatisch ? "We zoeken een vervanger. Je krijgt een mail zodra de partij weer compleet is." : "Kijk op de site of iemand anders kan invallen.") +
            (boekerWeg ? `\n\nLet op: ${s.naam} zou de baan boeken. Is die al geboekt, spreek dan onderling af wie hem overneemt.` : ""),
          knoppen: [{ label: "Naar de Padelplanner", url: `${siteUrl()}/?tab=planning` }],
        });
      }
    }
  }
  await werkBij(ctx, p, mails);
  await verstuur(mails);
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
      const pool = ctx.spelers.filter((s) => heeftRuimte(ctx, s, weekDagen[0]));
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
    if (nlMoment(p.datum, p.tijd) < nu) continue;
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
