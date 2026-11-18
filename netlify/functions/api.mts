// API voor de Padelplanner.
// Spelers loggen in met Netlify Identity; elke speler hoort bij één account.
// GET /api/spelers           -> alle spelers met vaste instellingen en beschikbaarheid per week (ingelogd)
// PUT /api/profiel           -> je eigen vaste instellingen opslaan (ingelogd)
// PUT /api/beschikbaarheid   -> je eigen beschikbaarheid voor één week opslaan (ingelogd)
// GET /api/clubs             -> door de beheerder ingevulde clubgegevens (prijzen, boekingshorizon)
// PUT /api/clubs             -> clubgegevens van één club opslaan (beheercode nodig als BEHEER_CODE is ingesteld)
// GET /api/overzicht         -> wie heeft welke week ingevuld (alleen beheerder, beheercode nodig)
// GET /api/partijen          -> komende geplande partijen: je eigen partijen, of alle partijen voor de beheerder (ingelogd)
// POST /api/partijen/aanmelden | /afmelden | /verwijderen | /geboekt | /nietgeboekt  { id } (ingelogd)
// POST /api/partijen/geboekt { id, link? } -> baan geboekt; de anderen krijgen een mail (met Tikkie als die er is)
// POST /api/partijen/betaallink { id, link }  -> wie boekt deelt (later) een Tikkie; de anderen krijgen die per mail
// POST /api/partijen/betaald | /nietbetaald { id, spelerId } -> bijhouden wie zijn deel heeft betaald
// GET  /api/antwoord?t=...   -> gegevens van een uitnodiging uit de e-mail (geen inlog nodig, de sleutel is genoeg)
// POST /api/antwoord         { t, a: "ja" | "nee" } -> uitnodiging beantwoorden
import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { getUser, verifyRequestOrigin, AuthError } from "@netlify/identity";
import { db } from "../../db/index.js";
import { beantwoord, meldGeboekt, zoekUitnodiging, spelendVan, isActief } from "../../lib/automatisch.js";
import { spelers, beschikbaarheid, clubGegevens, partijen, partijDeelnemers } from "../../db/schema.js";

// Met welk niveau je wilt spelen: één range van-tot, opgeslagen als ["8.0-9.2"].
function leesWens(x: unknown): string[] | null {
  let van: unknown, tot: unknown;
  if (Array.isArray(x) && x.length === 1 && typeof x[0] === "string") [van, tot] = x[0].split("-");
  else if (x && typeof x === "object" && !Array.isArray(x)) ({ van, tot } = x as any);
  else return null;
  const a = leesNiveau(van), b = leesNiveau(tot);
  if (!a || !b || Number(a) > Number(b)) return null;
  return [a + "-" + b];
}
// Speelsterkte: 7.0 t/m 10.0 in stapjes van 0.1, opgeslagen als tekst met één decimaal (bv. "8.2").
function leesNiveau(x: unknown): string | null {
  const g = typeof x === "number" ? x : typeof x === "string" ? Number(x.replace(",", ".")) : NaN;
  if (!Number.isFinite(g)) return null;
  const t = Math.round(g * 10);
  if (Math.abs(g * 10 - t) > 1e-6 || t < 70 || t > 100) return null;
  return (t / 10).toFixed(1);
}
const DUREN = ["60", "90"];
// Oude dagdelen worden omgezet naar tijden; nieuwe invoer is "UU:MM-UU:MM" (per half uur).
const OUDE_SLOTS: Record<string, [number, number]> = { ochtend: [540, 720], middag: [720, 1020], avond1: [1020, 1140], avond2: [1140, 1320] };
const TIJD = /^([01]\d|2[0-4]):(00|30)-([01]\d|2[0-4]):(00|30)$/;
const hhmm = (m: number) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
function leesTijden(lijst: unknown[]): string[] | null {
  const r: [number, number][] = [];
  for (const x of lijst) {
    if (typeof x !== "string") return null;
    if (OUDE_SLOTS[x]) { r.push([...OUDE_SLOTS[x]]); continue; }
    const m = TIJD.exec(x);
    if (!m) return null;
    const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
    if (a >= b || b > 1440) return null;
    r.push([a, b]);
  }
  r.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of r) {
    const l = out[out.length - 1];
    if (l && a <= l[1]) l[1] = Math.max(l[1], b);
    else out.push([a, b]);
  }
  return out.map(([a, b]) => hhmm(a) + "-" + hhmm(b));
}
const FREQ = ["wanneer-het-lukt", "tweewekelijks", "wekelijks", "2x-per-week", "3x-per-week"];
const CLUBS = ["peakz", "valley", "plaza", "rolde", "hertenkamp"];
// "zomer" (alleen lente en zomer) kan alleen bij buitenbanen.
const BUITEN = ["hertenkamp"];
const VOORKEUR = ["wel", "zomer", "niet"];
const MAX_WEKEN_VOORUIT = 6;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fout = (tekst: string, status = 400) => json({ fout: tekst }, status);

const slug = (s: string) =>
  s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const DATUM = /^\d{4}-\d{2}-\d{2}$/;
const utc = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const dagenTussen = (a: string, b: string) => Math.round((utc(b) - utc(a)) / 86400000);
const vandaag = () => new Date(Date.now() + 1 * 3600000).toISOString().slice(0, 10); // ruwweg Nederlandse tijd
const plusDagen = (k: string, n: number) => new Date(utc(k) + n * 86400000).toISOString().slice(0, 10);
const isMaandag = (k: string) => new Date(utc(k)).getUTCDay() === 1;

async function leesBody(req: Request) {
  const text = await req.text();
  if (text.length > 20000) throw new Error("Bericht te groot.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Ongeldige invoer.");
  }
}

type Gebruiker = { id: string; email?: string };
const isBeheer = (req: Request) => {
  const code = Netlify.env.get("BEHEER_CODE");
  return !!code && req.headers.get("x-beheercode") === code;
};

async function mijnSpeler(user: Gebruiker) {
  const [s] = await db.select().from(spelers).where(eq(spelers.userId, user.id));
  return s ?? null;
}

async function alleSpelers(user: Gebruiker, beheer: boolean) {
  // Alleen weken die nog niet voorbij zijn zijn relevant.
  const vanaf = plusDagen(vandaag(), -7);
  const [rijen, weken] = await Promise.all([
    db.select().from(spelers).orderBy(spelers.naam),
    db.select().from(beschikbaarheid).where(gte(beschikbaarheid.week, vanaf)),
  ]);
  return rijen.map((s) => {
    const eigen = weken.filter((w) => w.spelerId === s.id);
    const isIk = s.userId === user.id;
    const perWeek: Record<string, { tijdvakken: Record<string, string[]>; bijgewerkt?: string }> = {};
    for (const w of eigen) {
      // Van andere spelers alleen de tijden die de planner nodig heeft: niet wanneer ze iets hebben
      // ingevuld en niet welke weken ze hebben afgemeld. Wie wat heeft ingevuld ziet alleen de beheerder.
      if (isIk) perWeek[w.week] = { tijdvakken: w.tijdvakken, bijgewerkt: w.bijgewerkt.toISOString() };
      // Beschikbaarheid van anderen alleen voor de beheerder (voor "Beste momenten"); de site plant verder zelf.
      else if (beheer && Object.keys(w.tijdvakken).length) perWeek[w.week] = { tijdvakken: w.tijdvakken };
    }
    return {
      eigen: isIk,
      naam: s.naam,
      niveau: s.niveau,
      wensNiveaus: s.wensNiveaus,
      duren: s.duren,
      frequentie: s.frequentie,
      rustDagen: s.rustDagen,
      clubVoorkeur: s.clubVoorkeur,
      ...(isIk ? { mailAan: s.mailAan, email: s.email } : {}),
      bijgewerkt: s.bijgewerkt.toISOString(),
      weken: perWeek,
    };
  });
}

// Overzicht voor de beheerder: per speler per week of en wanneer er is ingevuld.
async function overzicht(req: Request) {
  const beheer = Netlify.env.get("BEHEER_CODE");
  if (!beheer) return fout("Stel eerst een beheercode in (BEHEER_CODE); zonder beheercode is dit overzicht voor niemand zichtbaar.", 403);
  if (req.headers.get("x-beheercode") !== beheer) return fout("Beheercode klopt niet.", 401);
  const vanaf = plusDagen(vandaag(), -7);
  const [rijen, weken] = await Promise.all([
    db.select({ id: spelers.id, naam: spelers.naam }).from(spelers).orderBy(spelers.naam),
    db.select().from(beschikbaarheid).where(gte(beschikbaarheid.week, vanaf)),
  ]);
  return json({
    spelers: rijen.map((s) => {
      const perWeek: Record<string, { tijdvakken: Record<string, string[]>; bijgewerkt: string }> = {};
      for (const w of weken) if (w.spelerId === s.id) perWeek[w.week] = { tijdvakken: w.tijdvakken, bijgewerkt: w.bijgewerkt.toISOString() };
      return { naam: s.naam, weken: perWeek };
    }),
  });
}

// ---- Geplande partijen ----
const MAX_SPELERS = 4;
// Spelers zien alleen hun eigen partijen (waarvoor ze zijn uitgenodigd, waar ze meedoen of reserve zijn,
// of die ze zelf hebben gepland). De beheerder ziet alle partijen.
async function allePartijen(user: Gebruiker, beheer: boolean) {
  const mij = await mijnSpeler(user);
  const alle = await db.select().from(partijen).where(gte(partijen.datum, vandaag())).orderBy(asc(partijen.datum), asc(partijen.tijd));
  const alleIds = alle.map((p) => p.id);
  const rijen = alleIds.length ? await db.select().from(partijDeelnemers).where(inArray(partijDeelnemers.partijId, alleIds)) : [];
  const lijst = beheer
    ? alle
    : alle.filter((p) => !!mij && (p.aangemaaktDoor === mij.id || rijen.some((r) => r.partijId === p.id && r.spelerId === mij.id && isActief(r))));
  const namen = new Map((await db.select({ id: spelers.id, naam: spelers.naam }).from(spelers)).map((x) => [x.id, x.naam]));
  return lijst.map((p) => {
    const actief = spelendVan({ ...p, rijen: rijen.filter((r) => r.partijId === p.id) });
    const mijnRij = rijen.find((r) => r.partijId === p.id && r.spelerId === mij?.id);
    const toon = (r: (typeof rijen)[number]) => ({ naam: namen.get(r.spelerId) ?? "?", ik: r.spelerId === mij?.id, status: r.status, boekt: !!p.boekerId && r.spelerId === p.boekerId, id: r.spelerId, betaald: r.betaald });
    const vier = actief.slice(0, MAX_SPELERS);
    return {
      id: p.id,
      datum: p.datum,
      tijd: p.tijd,
      duur: p.duur,
      clubId: p.clubId,
      opmerking: p.opmerking,
      automatisch: p.automatisch,
      vanMij: !!mij && p.aangemaaktDoor === mij.id,
      // "uitgenodigd", "bevestigd" (speler of reserve) of null
      mijnStatus: mijnRij && isActief(mijnRij) ? mijnRij.status : null,
      doeIkMee: !!mijnRij && isActief(mijnRij),
      compleet: vier.length === MAX_SPELERS && vier.every((r) => r.status === "bevestigd"),
      boeker: p.boekerId ? namen.get(p.boekerId) ?? null : null,
      boekerIkke: !!mij && p.boekerId === mij.id,
      geboekt: p.geboekt,
      betaallink: p.betaallink,
      deelnemers: vier.map(toon),
      reserves: actief.slice(MAX_SPELERS).map(toon),
    };
  });
}

async function wijzigPartij(user: Gebruiker, actie: string, b: any, beheer = false) {
  const mij = await mijnSpeler(user);
  if (!mij) return fout("Sla eerst je vaste instellingen op.", 404);
  const id = Number(b.id);
  if (!Number.isInteger(id)) return fout("Onbekende partij.");
  const [p] = await db.select().from(partijen).where(eq(partijen.id, id));
  if (!p || dagenTussen(vandaag(), p.datum) < 0) return fout("Deze partij bestaat niet (meer).", 404);
  if (actie === "aanmelden" || actie === "afmelden") {
    const r = await beantwoord(id, mij.id, actie === "aanmelden");
    return r.ok ? json({ ok: true, tekst: r.tekst, boeken: r.boeken }) : fout(r.fout, r.status);
  } else if (actie === "geboekt" || actie === "nietgeboekt" || actie === "betaallink") {
    if (p.boekerId !== mij.id && !beheer) return fout("Alleen wie de baan boekt (of de beheerder) kan dit aanpassen.", 403);
    if (actie === "nietgeboekt") {
      await db.update(partijen).set({ geboekt: false }).where(eq(partijen.id, id));
      return json({ ok: true });
    }
    // Tikkie (of andere betaallink) is optioneel bij "geboekt".
    const heeftLink = typeof b.link === "string";
    const link = heeftLink ? b.link.trim() : "";
    if (link) {
      let url: URL | null = null;
      try { url = new URL(link); } catch {}
      if (!url || url.protocol !== "https:" || link.length > 500) return fout("Plak een geldige betaallink (die begint met https://), of laat het veld leeg.");
    }
    const nieuweLink = !!link && link !== p.betaallink;
    const set: { geboekt?: boolean; betaallink?: string | null } = {};
    if (heeftLink && (link || actie === "betaallink")) set.betaallink = link || null;
    if (actie === "geboekt") set.geboekt = true;
    if (Object.keys(set).length) await db.update(partijen).set(set).where(eq(partijen.id, id));
    if (actie === "geboekt" && !p.geboekt) {
      await meldGeboekt(id, "geboekt");
      return json({ ok: true, tekst: link ? "De baan staat op geboekt. De andere spelers krijgen een mail met je Tikkie." : "De baan staat op geboekt. De andere spelers krijgen daar een mail over." });
    }
    if (nieuweLink) await meldGeboekt(id, "betaallink");
    return json({ ok: true, tekst: actie === "geboekt" ? "De baan stond al op geboekt." : !link ? "De betaallink is weggehaald." : nieuweLink ? "De betaallink is gedeeld. De andere spelers krijgen hem per mail." : "De betaallink stond er al." });
  } else if (actie === "betaald" || actie === "nietbetaald") {
    const spelerId = Number(b.spelerId);
    if (!Number.isInteger(spelerId)) return fout("Onbekende speler.");
    if (spelerId !== mij.id && p.boekerId !== mij.id && !beheer) return fout("Alleen wie de baan boekt (of de speler zelf) kan dit aanpassen.", 403);
    const r = await db
      .update(partijDeelnemers)
      .set({ betaald: actie === "betaald" })
      .where(and(eq(partijDeelnemers.partijId, id), eq(partijDeelnemers.spelerId, spelerId)))
      .returning({ id: partijDeelnemers.spelerId });
    if (!r.length) return fout("Deze speler hoort niet bij deze partij.", 404);
  } else if (actie === "verwijderen") {
    if (p.aangemaaktDoor !== mij.id && !beheer) return fout("Alleen wie de partij heeft gepland (of de beheerder) kan deze verwijderen.", 403);
    await db.delete(partijen).where(eq(partijen.id, id));
  } else return fout("Niet gevonden.", 404);
  return json({ ok: true });
}

async function slaProfielOp(user: Gebruiker, b: any) {
  const naam = typeof b.naam === "string" ? b.naam.trim() : "";
  if (naam.length < 1 || naam.length > 40) return fout("Naam is verplicht (max 40 tekens).");
  const key = slug(naam);
  if (!key) return fout("Ongeldige naam.");
  const niveau = leesNiveau(b.niveau);
  if (!niveau) return fout("Kies je speelsterkte (7,0 t/m 10,0).");
  const wensNiveaus = leesWens(b.wensNiveaus);
  if (!wensNiveaus) return fout("Kies met welk niveau je wilt spelen (een range tussen 7,0 en 10,0).");
  if (!Array.isArray(b.duren) || !b.duren.length || !b.duren.every((x: string) => DUREN.includes(x)))
    return fout("Kies minstens één speelduur.");
  if (!FREQ.includes(b.frequentie)) return fout("Kies hoe vaak je wilt spelen.");
  const rustDagen = b.rustDagen === undefined ? 0 : Number(b.rustDagen);
  if (![0, 1, 2].includes(rustDagen)) return fout("Kies hoeveel tijd je minimaal wilt tussen twee partijen.");

  const clubVoorkeur: Record<string, string> = {};
  for (const c of CLUBS) {
    const v = b.clubVoorkeur?.[c] ?? "wel";
    if (!VOORKEUR.includes(v) || (v === "zomer" && !BUITEN.includes(c))) return fout("Ongeldige baanvoorkeur.");
    clubVoorkeur[c] = v;
  }
  if (CLUBS.every((c) => clubVoorkeur[c] === "niet")) return fout("Kies minstens één club waar je wel wilt spelen.");

  const waarden = {
    naam,
    niveau,
    wensNiveaus,
    duren: [...new Set<string>(b.duren)],
    frequentie: b.frequentie,
    rustDagen,
    clubVoorkeur,
    email: user.email ?? null,
    mailAan: b.mailAan !== false,
    bijgewerkt: new Date(),
  };
  const mij = await mijnSpeler(user);
  const [zelfdeNaam] = await db.select().from(spelers).where(eq(spelers.slug, key));
  if (zelfdeNaam && zelfdeNaam.id !== mij?.id && zelfdeNaam.userId)
    return fout("Deze naam is al in gebruik door een andere speler. Kies een andere naam (bijv. met je achternaam erbij).", 409);

  if (mij) {
    // Bestaande speler: naam en instellingen bijwerken.
    if (zelfdeNaam && zelfdeNaam.id !== mij.id) return fout("Er bestaat al een speler met deze naam.", 409);
    await db.update(spelers).set({ slug: key, ...waarden }).where(eq(spelers.id, mij.id));
  } else if (zelfdeNaam) {
    // Speler van vóór het inloggen met dezelfde naam: aan dit account koppelen.
    const bijgewerkt = await db
      .update(spelers)
      .set({ userId: user.id, ...waarden })
      .where(and(eq(spelers.id, zelfdeNaam.id), isNull(spelers.userId)))
      .returning({ id: spelers.id });
    if (!bijgewerkt.length) return fout("Deze naam is al in gebruik door een andere speler.", 409);
  } else {
    await db.insert(spelers).values({ slug: key, userId: user.id, ...waarden });
  }
  return json({ ok: true });
}

async function slaBeschikbaarheidOp(user: Gebruiker, b: any) {
  const speler = await mijnSpeler(user);
  if (!speler) return fout("Sla eerst je vaste instellingen op, daarna kun je je beschikbaarheid invullen.", 404);

  const week = b.week;
  if (typeof week !== "string" || !DATUM.test(week) || !isMaandag(week)) return fout("Ongeldige week.");
  const tot = dagenTussen(vandaag(), week);
  if (tot < -7) return fout("Deze week is al voorbij.");
  if (tot > MAX_WEKEN_VOORUIT * 7) return fout("Deze week ligt te ver vooruit.");

  const tijdvakken: Record<string, string[]> = {};
  const invoer = b.tijdvakken && typeof b.tijdvakken === "object" ? b.tijdvakken : {};
  for (const d of Object.keys(invoer)) {
    if (!DATUM.test(d)) return fout("Ongeldige datum.");
    const verschil = dagenTussen(week, d);
    if (verschil < 0 || verschil > 6) return fout("Datum valt buiten deze week.");
    const sl = invoer[d];
    const tijden = Array.isArray(sl) && sl.length <= 12 ? leesTijden(sl) : null;
    if (!tijden) return fout("Ongeldige tijd.");
    if (tijden.length) tijdvakken[d] = tijden;
  }

  await db
    .insert(beschikbaarheid)
    .values({ spelerId: speler.id, week, tijdvakken, bijgewerkt: new Date() })
    .onConflictDoUpdate({
      target: [beschikbaarheid.spelerId, beschikbaarheid.week],
      set: { tijdvakken, bijgewerkt: new Date() },
    });
  return json({ ok: true });
}

async function alleClubGegevens() {
  const rijen = await db.select().from(clubGegevens);
  const out: Record<string, unknown> = {};
  for (const r of rijen) out[r.clubId] = { ...r, bijgewerkt: r.bijgewerkt.toISOString() };
  return out;
}

function bedrag(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 500) return undefined;
  return Math.round(n * 100) / 100;
}

async function slaClubOp(req: Request, b: any) {
  const beheer = Netlify.env.get("BEHEER_CODE");
  if (beheer && req.headers.get("x-beheercode") !== beheer) return fout("Beheercode klopt niet.", 401);
  if (!CLUBS.includes(b.clubId)) return fout("Onbekende club.");
  const prijzen = { prijs60: bedrag(b.prijs60), prijs90: bedrag(b.prijs90), dalPrijs60: bedrag(b.dalPrijs60), dalPrijs90: bedrag(b.dalPrijs90) };
  if (Object.values(prijzen).some((v) => v === undefined)) return fout("Vul prijzen in als bedrag in euro's (bijv. 32,50).");
  const horizon = Number(b.horizonDagen);
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 120) return fout("Boekingshorizon moet tussen 1 en 120 dagen liggen.");
  const opentOm = typeof b.opentOm === "string" && b.opentOm.trim() ? b.opentOm.trim() : null;
  if (opentOm && !/^([01]\d|2[0-3]):[0-5]\d$/.test(opentOm)) return fout("Tijdstip moet als UU:MM (bijv. 07:00).");
  const opmerking = typeof b.opmerking === "string" ? b.opmerking.trim().slice(0, 300) : "";
  const waarden = {
    ...(prijzen as Record<string, number | null>),
    horizonDagen: horizon,
    horizonBevestigd: !!b.horizonBevestigd,
    opentOm,
    opmerking,
    bijgewerkt: new Date(),
  };
  await db.insert(clubGegevens).values({ clubId: b.clubId, ...waarden }).onConflictDoUpdate({ target: clubGegevens.clubId, set: waarden });
  return json({ ok: true });
}

// Uitnodiging uit de e-mail: de sleutel in de link bepaalt om welke partij en welke speler het gaat.
async function antwoord(req: Request) {
  if (req.method === "GET") {
    const r = await zoekUitnodiging(new URL(req.url).searchParams.get("t") ?? "");
    if (!r) return fout("Deze link klopt niet (meer).", 404);
    const [p] = await db.select().from(partijen).where(eq(partijen.id, r.partijId));
    if (!p) return fout("Deze partij bestaat niet meer.", 404);
    const rijen = await db.select().from(partijDeelnemers).where(eq(partijDeelnemers.partijId, p.id));
    const namen = new Map((await db.select({ id: spelers.id, naam: spelers.naam }).from(spelers)).map((x) => [x.id, x.naam]));
    const actief = spelendVan({ ...p, rijen });
    return json({
      naam: namen.get(r.spelerId) ?? "",
      status: r.status,
      reserve: isActief(r) && actief.findIndex((x) => x.spelerId === r.spelerId) >= MAX_SPELERS,
      voorbij: dagenTussen(vandaag(), p.datum) < 0,
      partij: { datum: p.datum, tijd: p.tijd, duur: p.duur, clubId: p.clubId },
      spelers: actief.slice(0, MAX_SPELERS).map((x) => ({ naam: namen.get(x.spelerId) ?? "?", status: x.status })),
    });
  }
  const b = await leesBody(req);
  const r = await zoekUitnodiging(typeof b.t === "string" ? b.t : "");
  if (!r) return fout("Deze link klopt niet (meer).", 404);
  if (b.a !== "ja" && b.a !== "nee") return fout("Kies ja of nee.");
  const uit = await beantwoord(r.partijId, r.spelerId, b.a === "ja");
  return uit.ok ? json({ ok: true, tekst: uit.tekst, boeken: uit.boeken }) : fout(uit.fout, uit.status);
}

export default async (req: Request) => {

  const pad = new URL(req.url).pathname.replace(/\/+$/, "");
  try {
    if (pad === "/api/clubs" && req.method === "GET") return json({ clubs: await alleClubGegevens() });
    if (pad === "/api/clubs" && (req.method === "PUT" || req.method === "POST")) return await slaClubOp(req, await leesBody(req));
    if (pad === "/api/overzicht" && req.method === "GET") return await overzicht(req);
    if (pad === "/api/antwoord" && (req.method === "GET" || req.method === "POST")) return await antwoord(req);

    // Alles hieronder alleen voor ingelogde spelers.
    const user = await getUser();
    if (!user) return fout("Log eerst in.", 401);
    const schrijven = req.method === "PUT" || req.method === "POST";
    if (schrijven) verifyRequestOrigin(req);
    if (pad === "/api/spelers" && req.method === "GET") {
      const mij = await mijnSpeler(user);
      // E-mailadres van het account bijhouden, zodat uitnodigingen aankomen.
      if (mij && user.email && mij.email !== user.email) await db.update(spelers).set({ email: user.email }).where(eq(spelers.id, mij.id));
      const beheer = isBeheer(req);
      return json({ spelers: await alleSpelers(user, beheer), beheer });
    }
    if (pad === "/api/profiel" && schrijven) return await slaProfielOp(user, await leesBody(req));
    if (pad === "/api/beschikbaarheid" && schrijven) return await slaBeschikbaarheidOp(user, await leesBody(req));
    if (pad === "/api/partijen" && req.method === "GET") return (async () => { const beheer = isBeheer(req); return json({ partijen: await allePartijen(user, beheer), beheer }); })();
    const m = /^\/api\/partijen\/(aanmelden|afmelden|verwijderen|geboekt|nietgeboekt|betaallink|betaald|nietbetaald)$/.exec(pad);
    if (m && req.method === "POST") return await wijzigPartij(user, m[1], await leesBody(req), isBeheer(req));
    return fout("Niet gevonden.", 404);
  } catch (e) {
    if (e instanceof AuthError) return fout("Dit verzoek is niet toegestaan.", 403);
    const bericht = e instanceof Error ? e.message : "Onbekende fout.";
    if (bericht === "Bericht te groot." || bericht === "Ongeldige invoer.") return fout(bericht);
    console.error(e);
    return fout("Er ging iets mis op de server.", 500);
  }
};

export const config = { path: ["/api/spelers", "/api/profiel", "/api/beschikbaarheid", "/api/clubs", "/api/overzicht", "/api/partijen", "/api/partijen/*", "/api/antwoord"] };
