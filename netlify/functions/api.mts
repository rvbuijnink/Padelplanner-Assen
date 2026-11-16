// API voor de Padelplanner.
// GET /api/spelers           -> alle spelers met vaste instellingen en beschikbaarheid per week
// PUT /api/profiel           -> vaste instellingen van één speler opslaan (zelfde naam = aanpassen)
// PUT /api/beschikbaarheid   -> beschikbaarheid van één speler voor één week opslaan
// GET /api/clubs             -> door de beheerder ingevulde clubgegevens (prijzen, boekingshorizon)
// PUT /api/clubs             -> clubgegevens van één club opslaan (beheercode nodig als BEHEER_CODE is ingesteld)
import { eq, gte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { spelers, beschikbaarheid, clubGegevens } from "../../db/schema.js";

const NIVEAUS = ["n80", "n85", "n90", "n95"];
const DUREN = ["60", "90"];
const SLOTS = ["ochtend", "middag", "avond1", "avond2"];
const FREQ = ["wanneer-het-lukt", "tweewekelijks", "wekelijks", "2x-per-week"];
const CLUBS = ["peakz", "valley", "plaza", "rolde"];
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

async function leesBody(req: Request) {
  const text = await req.text();
  if (text.length > 20000) throw new Error("Bericht te groot.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Ongeldige invoer.");
  }
}

async function zoekSpeler(naam: unknown) {
  const n = typeof naam === "string" ? naam.trim() : "";
  const key = slug(n);
  if (!key) return null;
  const [s] = await db.select().from(spelers).where(eq(spelers.slug, key));
  return s ?? null;
}

async function alleSpelers() {
  // Alleen weken die nog niet voorbij zijn zijn relevant.
  const vanaf = plusDagen(vandaag(), -7);
  const [rijen, weken] = await Promise.all([
    db.select().from(spelers).orderBy(spelers.naam),
    db.select().from(beschikbaarheid).where(gte(beschikbaarheid.week, vanaf)),
  ]);
  return rijen.map((s) => {
    const eigen = weken.filter((w) => w.spelerId === s.id);
    const perWeek: Record<string, { tijdvakken: Record<string, string[]>; bijgewerkt: string }> = {};
    for (const w of eigen) perWeek[w.week] = { tijdvakken: w.tijdvakken, bijgewerkt: w.bijgewerkt.toISOString() };
    return {
      naam: s.naam,
      niveau: s.niveau,
      wensNiveaus: s.wensNiveaus,
      duren: s.duren,
      frequentie: s.frequentie,
      clubVoorkeur: s.clubVoorkeur,
      bijgewerkt: s.bijgewerkt.toISOString(),
      weken: perWeek,
    };
  });
}

async function slaProfielOp(b: any) {
  const naam = typeof b.naam === "string" ? b.naam.trim() : "";
  if (naam.length < 1 || naam.length > 40) return fout("Naam is verplicht (max 40 tekens).");
  const key = slug(naam);
  if (!key) return fout("Ongeldige naam.");
  if (!NIVEAUS.includes(b.niveau)) return fout("Kies je speelsterkte.");
  if (!Array.isArray(b.wensNiveaus) || !b.wensNiveaus.length || !b.wensNiveaus.every((x: string) => NIVEAUS.includes(x)))
    return fout("Kies minstens één niveau waarmee je wilt spelen.");
  if (!Array.isArray(b.duren) || !b.duren.length || !b.duren.every((x: string) => DUREN.includes(x)))
    return fout("Kies minstens één speelduur.");
  if (!FREQ.includes(b.frequentie)) return fout("Kies hoe vaak je wilt spelen.");

  const clubVoorkeur: Record<string, string> = {};
  for (const c of CLUBS) {
    const v = b.clubVoorkeur?.[c] ?? "wel";
    if (!VOORKEUR.includes(v)) return fout("Ongeldige baanvoorkeur.");
    clubVoorkeur[c] = v;
  }
  if (CLUBS.every((c) => clubVoorkeur[c] === "niet")) return fout("Kies minstens één club waar je wel wilt spelen.");

  const waarden = {
    naam,
    niveau: b.niveau,
    wensNiveaus: [...new Set<string>(b.wensNiveaus)],
    duren: [...new Set<string>(b.duren)],
    frequentie: b.frequentie,
    clubVoorkeur,
    bijgewerkt: new Date(),
  };
  await db
    .insert(spelers)
    .values({ slug: key, ...waarden })
    .onConflictDoUpdate({ target: spelers.slug, set: waarden });
  return json({ ok: true });
}

async function slaBeschikbaarheidOp(b: any) {
  const speler = await zoekSpeler(b.naam);
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
    if (!Array.isArray(sl) || !sl.every((x: string) => SLOTS.includes(x))) return fout("Ongeldig tijdvak.");
    if (sl.length) tijdvakken[d] = [...new Set<string>(sl)];
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

export default async (req: Request) => {

  const pad = new URL(req.url).pathname.replace(/\/+$/, "");
  try {
    if (pad === "/api/clubs" && req.method === "GET") return json({ clubs: await alleClubGegevens() });
    if (pad === "/api/clubs" && (req.method === "PUT" || req.method === "POST")) return await slaClubOp(req, await leesBody(req));
    if (pad === "/api/spelers" && req.method === "GET") return json({ spelers: await alleSpelers() });
    if (pad === "/api/profiel" && (req.method === "PUT" || req.method === "POST")) return await slaProfielOp(await leesBody(req));
    if (pad === "/api/beschikbaarheid" && (req.method === "PUT" || req.method === "POST"))
      return await slaBeschikbaarheidOp(await leesBody(req));
    return fout("Niet gevonden.", 404);
  } catch (e) {
    const bericht = e instanceof Error ? e.message : "Onbekende fout.";
    if (bericht === "Bericht te groot." || bericht === "Ongeldige invoer.") return fout(bericht);
    console.error(e);
    return fout("Er ging iets mis op de server.", 500);
  }
};

export const config = { path: ["/api/spelers", "/api/profiel", "/api/beschikbaarheid", "/api/clubs"] };
