// API voor de Padelplanner.
// Spelers loggen in met Netlify Identity; elke speler hoort bij één account.
// GET /api/spelers           -> alle spelers met vaste instellingen en beschikbaarheid per week (ingelogd)
// PUT /api/profiel           -> je eigen vaste instellingen opslaan (ingelogd)
// PUT /api/beschikbaarheid   -> je eigen beschikbaarheid voor één week opslaan (ingelogd)
// GET /api/overzicht         -> wie heeft welke week ingevuld (alleen beheerder, beheercode nodig)
// GET /api/partijen          -> komende geplande partijen: je eigen partijen, of alle partijen voor de beheerder (ingelogd)
// POST /api/partijen/aanmelden | /afmelden | /verwijderen | /geboekt | /nietgeboekt  { id } (ingelogd)
// POST /api/partijen/geboekt { id, link? } -> baan geboekt; de anderen krijgen een mail (met Tikkie als die er is)
// POST /api/partijen/betaallink { id, link }  -> wie boekt deelt (later) een Tikkie; de anderen krijgen die per mail
// POST /api/partijen/betaald | /nietbetaald { id, spelerId } -> bijhouden wie zijn deel heeft betaald
// GET  /api/antwoord?t=...   -> gegevens van een uitnodiging uit de e-mail (geen inlog nodig, de sleutel is genoeg)
// POST /api/antwoord         { t, a: "ja" | "nee" } -> uitnodiging beantwoorden
// GET  /api/agenda?t=...     -> agenda-afspraak (.ics) van een partij, via de sleutel uit de e-mail
// GET  /api/partijen/open    -> momenten waarop drie passende spelers kunnen en live een baan vrij is (ingelogd)
// POST /api/partijen/meedoen { datum, tijd, duur, clubId, spelers } -> "Ik speel mee en boek de baan"
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { getUser, verifyRequestOrigin, AuthError, admin } from "@netlify/identity";
import { db } from "../../db/index.js";
import { beantwoord, markeerGeboekt, meldBetaallink, zoekUitnodiging, spelendVan, isActief, agendaVoor, boekerKeuze, kandidatenVoor, stelVoor, partijInfo, reactieTotVan, openPartijenVoor, speelMeeEnBoek, type Keuze } from "../../lib/automatisch.js";
import { leesTelefoon, slaTelefoonOp, zichtbareTelefoons, waLink, toonNummer } from "../../lib/telefoon.js";
// @ts-ignore - gedeelde planner-logica (CommonJS)
import Planner from "../../src/planner.cjs";
const P: any = Planner;
import { spelers, beschikbaarheid, partijen, partijDeelnemers } from "../../db/schema.js";

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
// De clubs; per club ja ("wel") of nee ("niet"). Padel Rolde is de laatste keus.
const CLUBS = ["peakz", "hertenkamp", "valley", "plaza", "rolde"];
const VOORKEUR = ["wel", "niet"];
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
const maandagVan = (k: string) => plusDagen(k, -((new Date(utc(k)).getUTCDay() + 6) % 7));

// Standaardweek: { "0".."6": ["UU:MM-UU:MM", ...] } (0 = maandag). null of leeg = geen standaardweek.
function leesStandaardweek(x: unknown): Record<string, string[]> | null | undefined {
  if (x === null || x === undefined) return null;
  if (typeof x !== "object" || Array.isArray(x)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (!/^[0-6]$/.test(k) || !Array.isArray(v) || v.length > 12) return undefined;
    const t = leesTijden(v);
    if (!t) return undefined;
    if (t.length) out[k] = t;
  }
  return Object.keys(out).length ? out : null;
}

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
  const mij = await mijnSpeler(user);
  const eigenNummer = mij ? (await zichtbareTelefoons(mij.id)).get(mij.id) ?? null : null;
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
    // Voor de beheerder (Beste momenten) telt de standaardweek van anderen mee in de weken die ze niet zelf invulden.
    const komend = Array.from({ length: MAX_WEKEN_VOORUIT + 1 }, (_, i) => plusDagen(vanaf, 7 + 7 * i)).map(maandagVan);
    const weken2 = !isIk && beheer && s.standaardWeek ? P.vulStandaardweek(perWeek, s.standaardWeek, komend.filter((w) => !eigen.some((x) => x.week === w))) : perWeek;
    return {
      eigen: isIk,
      naam: s.naam,
      niveau: s.niveau,
      wensNiveaus: s.wensNiveaus,
      duren: s.duren,
      frequentie: s.frequentie,
      rustDagen: s.rustDagen,
      clubVoorkeur: s.clubVoorkeur,
      ...(isIk ? { mailAan: s.mailAan, herinneringAan: s.herinneringAan, standaardWeek: s.standaardWeek ?? null, email: s.email, boekBereid: s.boekBereid, telefoon: eigenNummer ? toonNummer(eigenNummer) : null } : {}),
      bijgewerkt: s.bijgewerkt.toISOString(),
      weken: weken2,
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
  // Geannuleerde partijen gaan niet door en worden niet meer getoond.
  const lijst = beheer
    ? alle.filter((p) => !p.geannuleerd)
    : alle.filter((p) => !p.geannuleerd).filter((p) => !!mij && (p.aangemaaktDoor === mij.id || rijen.some((r) => r.partijId === p.id && r.spelerId === mij.id && isActief(r))));
  const namen = new Map((await db.select({ id: spelers.id, naam: spelers.naam }).from(spelers)).map((x) => [x.id, x.naam]));
  // 06-nummers: de database (row level security) bepaalt welke deze speler mag zien.
  const nummers = mij ? await zichtbareTelefoons(mij.id) : new Map<number, string>();
  const info = await partijInfo(lijst.map((p) => p.id));
  return lijst.map((p) => {
    const actief = spelendVan({ ...p, rijen: rijen.filter((r) => r.partijId === p.id) });
    const mijnRij = rijen.find((r) => r.partijId === p.id && r.spelerId === mij?.id);
    const toon = (r: (typeof rijen)[number]) => {
      const nr = r.status === "bevestigd" ? nummers.get(r.spelerId) : undefined;
      return { naam: namen.get(r.spelerId) ?? "?", ik: r.spelerId === mij?.id, status: r.status, boekt: !!p.boekerId && r.spelerId === p.boekerId, id: r.spelerId, betaald: r.betaald,
        ...(nr ? { telefoon: toonNummer(nr), whatsapp: waLink(nr) } : {}),
        ...(r.status === "uitgenodigd" ? { reactieTot: reactieTotVan(r, p) } : {}) };
    };
    const extra = info.get(p.id);
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
      bedrag: extra?.bedrag ?? null,
      bedragDrie: extra?.bedragDrie ?? null,
      gratisTot: extra?.gratisTot ?? null,
      boekenTot: extra?.boekenTot ?? null,
      besluit: p.besluit,
      overnameNodig: p.overnameNodig,
      vorigeBoeker: extra?.vorigeBoeker ?? null,
      afgemeld: rijen.filter((r) => r.partijId === p.id && r.status === "afgezegd").map((r) => namen.get(r.spelerId) ?? "?"),
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
  if (p.geannuleerd) return fout("Deze partij is geannuleerd: er konden niet genoeg spelers.", 409);
  if (actie === "aanmelden" || actie === "afmelden") {
    const r = await beantwoord(id, mij.id, actie === "aanmelden");
    return r.ok ? json({ ok: true, tekst: r.tekst, boeken: r.boeken, betaallink: r.betaallink, bedrag: r.bedrag }) : fout(r.fout, r.status);
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
      await markeerGeboekt(id);
      return json({ ok: true, tekst: "De baan staat op geboekt. De andere spelers krijgen nu hun uitnodiging" + (link ? ", en wie bevestigt ziet meteen je Tikkie." : ". Zet er nog een Tikkie bij, dan kan wie bevestigt meteen betalen.") });
    }
    if (nieuweLink) await meldBetaallink(id);
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
  } else if (actie === "keuze") {
    const keuze = b.keuze as Keuze;
    if (!["nietboeken", "zoeken", "annuleren", "drie", "overnemen"].includes(keuze)) return fout("Onbekende keuze.");
    const r = await boekerKeuze(id, mij.id, keuze, beheer);
    return r.ok ? json({ ok: true, tekst: r.tekst }) : fout(r.fout, r.status);
  } else if (actie === "voorstel") {
    const r = await stelVoor(id, mij.id, Number(b.spelerId), beheer);
    return r.ok ? json({ ok: true, tekst: r.tekst }) : fout(r.fout, r.status);
  } else if (actie === "kandidaten") {
    return json({ kandidaten: await kandidatenVoor(id) });
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
  // Standaardweek en herinneringen zijn optioneel: niet meegestuurd = niet aanpassen.
  const metStandaard = "standaardWeek" in b;
  const standaardWeek = metStandaard ? leesStandaardweek(b.standaardWeek) : null;
  if (standaardWeek === undefined) return fout("Ongeldige standaardweek.");

  const clubVoorkeur: Record<string, string> = {};
  for (const c of CLUBS) {
    const v = b.clubVoorkeur?.[c] ?? "wel";
    if (!VOORKEUR.includes(v)) return fout("Ongeldige clubkeuze.");
    clubVoorkeur[c] = v;
  }
  if (CLUBS.every((c) => clubVoorkeur[c] === "niet")) return fout("Zet minstens één club op ja.");
  // 06-nummer: verplicht. Zonder nummer kan een speler niet bevestigen en zou een partij vastlopen.
  const telefoon = leesTelefoon(b.telefoon);
  if (!telefoon) return fout("Vul je 06-nummer in (bijv. 06-12345678). Dat is verplicht: zonder nummer kun je niet worden ingepland.");

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
    ...(typeof b.boekBereid === "boolean" ? { boekBereid: b.boekBereid } : {}),
    ...(typeof b.herinneringAan === "boolean" ? { herinneringAan: b.herinneringAan } : {}),
    ...(metStandaard ? { standaardWeek } : {}),
    bijgewerkt: new Date(),
  };
  const mij = await mijnSpeler(user);
  // Elke naam hoort bij precies één account. Spelers worden niet meer op naam aan een account gekoppeld,
  // zodat niemand de plek van een andere speler kan overnemen door diens naam te kiezen.
  const [zelfdeNaam] = await db.select({ id: spelers.id }).from(spelers).where(eq(spelers.slug, key));
  if (zelfdeNaam && zelfdeNaam.id !== mij?.id)
    return fout("Deze naam is al in gebruik door een andere speler. Kies een andere naam (bijv. met je achternaam erbij).", 409);

  if (mij) await db.update(spelers).set({ slug: key, ...waarden }).where(eq(spelers.id, mij.id));
  else await db.insert(spelers).values({ slug: key, userId: user.id, ...waarden });
  const nu = await mijnSpeler(user);
  if (nu) await slaTelefoonOp(nu.id, telefoon);
  return json({ ok: true });
}

// Account verwijderen: speler, beschikbaarheid, 06-nummer en deelnames (cascade) en het inlogaccount.
async function verwijderAccount(user: Gebruiker) {
  const mij = await mijnSpeler(user);
  if (mij) {
    // Eerst netjes afmelden voor komende partijen, zodat de anderen bericht krijgen en er een vervanger komt.
    const mijn = await db.select({ id: partijDeelnemers.partijId }).from(partijDeelnemers)
      .innerJoin(partijen, eq(partijen.id, partijDeelnemers.partijId))
      .where(and(eq(partijDeelnemers.spelerId, mij.id), gte(partijen.datum, vandaag()), inArray(partijDeelnemers.status, ["gepland", "uitgenodigd", "bevestigd"])));
    for (const r of mijn) { try { await beantwoord(r.id, mij.id, false); } catch (e) { console.error(e); } }
    await slaTelefoonOp(mij.id, null);
    await db.delete(spelers).where(eq(spelers.id, mij.id));
  }
  try { await admin.deleteUser(user.id); } catch (e) { console.error("Inlogaccount verwijderen mislukt", e); }
  return json({ ok: true });
}

async function slaBeschikbaarheidOp(user: Gebruiker, b: any) {
  const speler = await mijnSpeler(user);
  if (!speler) return fout("Sla eerst je vaste instellingen op, daarna kun je je beschikbaarheid invullen.", 404);

  const week = b.week;
  if (typeof week !== "string" || !DATUM.test(week) || !isMaandag(week)) return fout("Ongeldige week.");
  const tot = dagenTussen(vandaag(), week);
  // Minstens een week vooruit: de site plant niet korter van tevoren. Van de eerste week tellen dus alleen
  // de dagen vanaf 7 dagen na vandaag; eerdere dagen worden genegeerd.
  if (tot + 6 < P.MIN_DAGEN_VOORUIT) return fout("Beschikbaarheid kun je alleen invullen voor dagen die minstens een week vooruit liggen.");
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
    if (tijden.length && dagenTussen(vandaag(), d) >= P.MIN_DAGEN_VOORUIT) tijdvakken[d] = tijden;
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

// Alleen de standaardweek opslaan (vanaf het tabblad Beschikbaarheid).
async function slaStandaardweekOp(user: Gebruiker, b: any) {
  const mij = await mijnSpeler(user);
  if (!mij) return fout("Sla eerst je vaste instellingen op.", 404);
  const standaardWeek = leesStandaardweek(b.standaardWeek);
  if (standaardWeek === undefined) return fout("Ongeldige standaardweek.");
  await db.update(spelers).set({ standaardWeek }).where(eq(spelers.id, mij.id));
  return json({ ok: true });
}

// Agenda-afspraak via de link in de e-mail.
async function agenda(req: Request) {
  const r = await zoekUitnodiging(new URL(req.url).searchParams.get("t") ?? "");
  if (!r) return fout("Deze link klopt niet (meer).", 404);
  const ics = await agendaVoor(r.partijId, r.spelerId);
  if (!ics) return fout("Je doet niet (meer) mee aan deze partij.", 404);
  return new Response(ics, {
    headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="padel.ics"', "cache-control": "no-store" },
  });
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
      geannuleerd: p.geannuleerd,
      partij: { datum: p.datum, tijd: p.tijd, duur: p.duur, clubId: p.clubId },
      reactieTot: r.status === "uitgenodigd" ? reactieTotVan(r, p) : null,
      bedrag: (await partijInfo([p.id])).get(p.id)?.bedrag ?? null,
      betaallink: r.status === "bevestigd" && p.boekerId !== r.spelerId ? p.betaallink : null,
      spelers: actief.slice(0, MAX_SPELERS).map((x) => ({ naam: namen.get(x.spelerId) ?? "?", status: x.status })),
    });
  }
  const b = await leesBody(req);
  const r = await zoekUitnodiging(typeof b.t === "string" ? b.t : "");
  if (!r) return fout("Deze link klopt niet (meer).", 404);
  if (b.a !== "ja" && b.a !== "nee") return fout("Kies ja of nee.");
  const uit = await beantwoord(r.partijId, r.spelerId, b.a === "ja");
  return uit.ok ? json({ ok: true, tekst: uit.tekst, boeken: uit.boeken, betaallink: uit.betaallink, bedrag: uit.bedrag }) : fout(uit.fout, uit.status);
}

export default async (req: Request) => {

  const pad = new URL(req.url).pathname.replace(/\/+$/, "");
  try {
    if (pad === "/api/overzicht" && req.method === "GET") return await overzicht(req);
    if (pad === "/api/antwoord" && (req.method === "GET" || req.method === "POST")) return await antwoord(req);
    if (pad === "/api/agenda" && req.method === "GET") return await agenda(req);

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
    if (pad === "/api/standaardweek" && schrijven) return await slaStandaardweekOp(user, await leesBody(req));
    if (pad === "/api/partijen" && req.method === "GET") return (async () => { const beheer = isBeheer(req); return json({ partijen: await allePartijen(user, beheer), beheer }); })();
    // Partijen met een vrije baan waar nog één speler ontbreekt (live berekend) en "Ik speel mee en boek de baan".
    if (pad === "/api/partijen/open" && req.method === "GET") {
      const mij = await mijnSpeler(user);
      return json(mij ? await openPartijenVoor(mij.id) : { partijen: [] });
    }
    if (pad === "/api/partijen/meedoen" && req.method === "POST") {
      const mij = await mijnSpeler(user);
      if (!mij) return fout("Sla eerst je vaste instellingen op.", 404);
      const r = await speelMeeEnBoek(mij.id, await leesBody(req));
      return r.ok ? json({ ok: true, tekst: r.tekst, id: r.id, boeken: r.boeken }) : fout(r.fout, r.status);
    }
    if (pad === "/api/account" && req.method === "DELETE") { verifyRequestOrigin(req); return await verwijderAccount(user); }
    const m = /^\/api\/partijen\/(aanmelden|afmelden|verwijderen|geboekt|nietgeboekt|betaallink|betaald|nietbetaald|keuze|voorstel|kandidaten)$/.exec(pad);
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

export const config = { path: ["/api/spelers", "/api/profiel", "/api/beschikbaarheid", "/api/overzicht", "/api/partijen", "/api/partijen/*", "/api/antwoord", "/api/agenda", "/api/standaardweek", "/api/account"] };
