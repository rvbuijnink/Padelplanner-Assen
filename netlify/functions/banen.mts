// Live vrije padelbanen bij clubs met een openbaar leesbaar boekingssysteem.
// GET /api/banen?datum=YYYY-MM-DD&slot=19:00-22:00 (of een oud dagdeel zoals avond2)
//
// Ondersteund:
// - RacketIQ (Valley Padel Assen, Padel Rolde): per begintijd de vrije banen, daarom vragen we
//   alleen de begintijden binnen het gevraagde tijdvak op.
// - Foys (Peakz Padel Assen): openbare zoek-API die per baan alle tijdvakken van een dag geeft.
// - KNLTB Meet & Play (Plaza Sportz Assen): de openbare clubpagina (Livewire) toont per begintijd
//   de vrije banen. We bootsen dezelfde aanroep na als de pagina zelf doet.
//
// Om de clubs niet te belasten wordt elk antwoord 10 minuten gecachet: in het geheugen van de
// functie én op de CDN van Netlify (gedeeld tussen alle bezoekers).

type Koppeling = { id: string; host: string; groupId: number };

const KOPPELINGEN: Koppeling[] = [
  { id: "valley", host: "assen.valleypadel.nl", groupId: 2061 },
  { id: "rolde", host: "boeken.padelrolde.nl", groupId: 2097 },
];

const PEAKZ = {
  id: "peakz",
  federatie: "df82f4dd-fd87-4af5-9c2f-656fe1a44357",
  locatie: "33d2846b-f15c-48fe-83fa-3218526fa323", // Assen - Fokkerstraat
  reserveringstype: 6, // Baanreservering
  link: "https://www.peakzpadel.nl/reserveren/court-booking/reservation",
};

const PLAZA = {
  id: "plaza",
  pagina: "https://meetandplay.nl/club/88140",
  horizonDagen: 21, // "Onze banen zijn 3 weken vooruit te boeken."
  padelSportId: 2,
};

// Tijdvakken zoals in public/planner.js. Begintijden elk half uur, zolang er nog 1 uur past.
const SLOTS: Record<string, [number, number]> = {
  ochtend: [9, 12],
  middag: [12, 17],
  avond1: [17, 19],
  avond2: [19, 22],
};
// Of een tijd "UU:MM-UU:MM" zoals die uit de schuifbalken komt.
const leesSlot = (slot: string): [number, number] | null => {
  if (SLOTS[slot]) return [SLOTS[slot][0] * 60, SLOTS[slot][1] * 60];
  const m = /^([01]\d|2[0-4]):(00|30)-([01]\d|2[0-4]):(00|30)$/.exec(slot);
  if (!m) return null;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return a + 60 <= b && b <= 1440 ? [a, b] : null;
};
const begintijden = (slot: string) => {
  const [van, tot] = leesSlot(slot)!;
  const out: string[] = [];
  for (let m = van; m + 60 <= tot && out.length < 32; m += 30) {
    out.push(String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));
  }
  return out;
};

const CACHE_MS = 10 * 60 * 1000;
const geheugen = new Map<string, { tot: number; data: unknown }>();
async function gecachet<T>(sleutel: string, maak: () => Promise<T>): Promise<T> {
  const hit = geheugen.get(sleutel);
  if (hit && hit.tot > Date.now()) return hit.data as T;
  const data = await maak();
  geheugen.set(sleutel, { tot: Date.now() + CACHE_MS, data });
  if (geheugen.size > 500) for (const [k, v] of geheugen) if (v.tot < Date.now()) geheugen.delete(k);
  return data;
}

const UA = "Padelplanner-Assen/1.0 (groepsplanner)";

async function haal(url: string, extra: Record<string, string> = {}) {
  const r = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA, ...extra },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

type Baan = { id: string; naam: string; prijzen: Record<string, number> };

async function racketIq(k: Koppeling, datum: string, slot: string) {
  const basis = `https://${k.host}/web/api/group/${k.groupId}/v2/bookings`;
  const overzicht: any = await gecachet(`ov:${k.id}:${datum}`, () => haal(`${basis}/simpleOverview?date=${datum}`));
  const boekbaarTot: string | null = overzicht?.bookableUntil ?? null;
  const boekingsLink = `https://${k.host}/nl/booking`;
  if (boekbaarTot && datum > boekbaarTot) {
    return { live: true, boekbaar: false, boekbaarTot, opentOm: overzicht?.opensAt ?? null, boekingsLink, starts: [] };
  }

  const starts = await Promise.all(
    begintijden(slot).map(async (tijd) => {
      const d: any = await gecachet(`cc:${k.id}:${datum}:${tijd}`, () =>
        haal(`${basis}/checkcart?date=${datum}&from=${tijd}&to=24:00&firstRequest=0`)
      );
      const banen: Baan[] = [];
      for (const c of d?.court_availability ?? []) {
        const baan = c.court ?? {};
        // Alleen dubbelbanen (4 spelers) die niet uitgeschakeld zijn.
        if (baan.disabled || baan.sport !== "padel" || Number(baan.max_players) < 4) continue;
        const prijzen: Record<string, number> = {};
        for (const du of c.durations ?? []) {
          const vrij = (du.availability ?? []).find((a: any) => String(a.start_date_time).slice(11, 16) === tijd);
          if (vrij && (du.duration === "60" || du.duration === "90")) prijzen[du.duration] = Number(vrij.price);
        }
        if (Object.keys(prijzen).length) banen.push({ id: String(baan.id), naam: String(baan.name), prijzen });
      }
      return { tijd, banen };
    })
  );
  return { live: true, boekbaar: true, boekbaarTot, boekingsLink, diepeLink: true, starts };
}

// Zet losse vrije tijdvakken om naar het formaat per begintijd, beperkt tot het gevraagde tijdvak.
type Vrij = { tijd: string; duur: number; baanId: string; naam: string; prijs: number };
function perBegintijd(vrij: Vrij[], slot: string) {
  const tijden = begintijden(slot);
  return tijden.map((tijd) => {
    const banen = new Map<string, Baan>();
    for (const v of vrij) {
      if (v.tijd !== tijd || (v.duur !== 60 && v.duur !== 90)) continue;
      const b = banen.get(v.baanId) ?? { id: v.baanId, naam: v.naam, prijzen: {} };
      b.prijzen[String(v.duur)] = v.prijs;
      banen.set(v.baanId, b);
    }
    return { tijd, banen: [...banen.values()] };
  });
}

// ---- Peakz (Foys) ----
async function peakz(datum: string, slot: string) {
  const url =
    `https://api.foys.io/court-booking/public/api/v1/locations/search?reservationTypeId=${PEAKZ.reserveringstype}` +
    `&locationId=${PEAKZ.locatie}&playingTimes=60&playingTimes=90&date=${datum}`;
  const d: any = await gecachet(`foys:${datum}`, () => haal(url, { "x-federationid": PEAKZ.federatie }));
  const loc = (Array.isArray(d) ? d : []).find((l: any) => l?.id === PEAKZ.locatie || l?.city === "Assen");
  // Voorbij de boekingshorizon geeft Foys geen locatie terug.
  if (!loc) return { live: true, boekbaar: false, boekbaarTot: null, boekingsLink: PEAKZ.link, starts: [] };
  const vrij: Vrij[] = [];
  for (const baan of loc.inventoryItemsTimeSlots ?? []) {
    if (!/double/i.test(String(baan.type ?? baan.inventoryItemType?.name ?? ""))) continue; // alleen dubbelbanen
    for (const t of baan.timeSlots ?? []) {
      if (!t.isAvailable || String(t.startTime).slice(0, 10) !== datum) continue;
      vrij.push({ tijd: String(t.startTime).slice(11, 16), duur: Number(t.duration), baanId: String(baan.id), naam: String(baan.name), prijs: Number(t.price) });
    }
  }
  return { live: true, boekbaar: true, boekbaarTot: null, boekingsLink: PEAKZ.link, starts: perBegintijd(vrij, slot) };
}

// ---- Plaza (KNLTB Meet & Play, Livewire) ----
type MpSessie = { cookie: string; csrf: string; snapshot: string };
const ontsnap = (t: string) =>
  t.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

let mpSessie: { tot: number; s: MpSessie } | null = null;
async function nieuweMpSessie(): Promise<MpSessie> {
  const r = await fetch(PLAZA.pagina, { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const html = await r.text();
  const csrf = /data-csrf="([^"]+)"/.exec(html)?.[1];
  const snapshot = [...html.matchAll(/wire:snapshot="([^"]+)"/g)].map((m) => ontsnap(m[1])).find((x) => x.includes("court-show"));
  if (!csrf || !snapshot) throw new Error("Meet & Play: pagina-opbouw onbekend");
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { cookie, csrf, snapshot };
}
async function mpHtml(updates: Record<string, unknown>, opnieuw = true): Promise<string> {
  if (!mpSessie || mpSessie.tot < Date.now()) mpSessie = { tot: Date.now() + 30 * 60 * 1000, s: await nieuweMpSessie() };
  const { cookie, csrf, snapshot } = mpSessie.s;
  const r = await fetch("https://meetandplay.nl/livewire/update", {
    method: "POST",
    headers: { "user-agent": UA, "content-type": "application/json", accept: "application/json", "x-livewire": "true", cookie, referer: PLAZA.pagina },
    body: JSON.stringify({ _token: csrf, components: [{ snapshot, updates, calls: [] }] }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    mpSessie = null;
    if (opnieuw && (r.status === 419 || r.status === 401 || r.status === 403)) return mpHtml(updates, false);
    throw new Error("HTTP " + r.status);
  }
  const d: any = await r.json();
  const html = d?.components?.[0]?.effects?.html;
  if (typeof html !== "string") throw new Error("Meet & Play: onverwacht antwoord");
  return html;
}
// Vrije dubbelbanen uit de HTML van één begintijd.
function leesMpSlots(html: string, tijd: string): Vrij[] {
  const vrij: Vrij[] = [];
  const secties = html.split(/<div class="mp-court-type"/).slice(1);
  for (const sectie of secties) {
    const soort = /wire:key="court-type-([^"]+)"/.exec(sectie)?.[1] ?? "";
    if (!/dubbel/i.test(soort)) continue;
    for (const blok of sectie.split(/class="timeslot-container"/).slice(1)) {
      const t = /timeslot-time">\s*(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*<small>\s*(\d+)\s*minuten/.exec(blok);
      const naam = /timeslot-name">\s*([^<]+?)\s*</.exec(blok)?.[1];
      const prijs = /€\s*([\d.]+(?:,\d+)?)/.exec(blok)?.[1];
      if (!t || !naam || !prijs || t[1] !== tijd) continue;
      vrij.push({ tijd, duur: Number(t[3]), baanId: ontsnap(naam).replace(/\s+/g, " "), naam: ontsnap(naam).replace(/\s+/g, " "), prijs: Number(prijs.replace(/\./g, "").replace(",", ".")) });
    }
  }
  return vrij;
}
async function plaza(datum: string, slot: string) {
  const vandaag = new Date().toISOString().slice(0, 10);
  const boekbaarTot = new Date(Date.parse(vandaag) + PLAZA.horizonDagen * 86400000).toISOString().slice(0, 10);
  if (datum > boekbaarTot) return { live: true, boekbaar: false, boekbaarTot, boekingsLink: PLAZA.pagina, starts: [] };
  const [j, m, d] = datum.split("-");
  const mpDatum = `${d}-${m}-${j}`;
  // Eerst de begintijden waarop nog iets vrij is, daarna alleen die binnen het tijdvak.
  const overzicht = await gecachet(`mp:${datum}`, () => mpHtml({ date: mpDatum, tenantSportId: PLAZA.padelSportId }));
  const beschikbaar = new Set([...overzicht.matchAll(/id="time-(\d{2}:\d{2})"/g)].map((x) => x[1]));
  const tijden = begintijden(slot).filter((t) => beschikbaar.has(t));
  const vrij = (
    await Promise.all(
      tijden.map((tijd) =>
        gecachet(`mp:${datum}:${tijd}`, async () =>
          leesMpSlots(await mpHtml({ date: mpDatum, tenantSportId: PLAZA.padelSportId, time: tijd }), tijd)
        )
      )
    )
  ).flat();
  return { live: true, boekbaar: true, boekbaarTot, boekingsLink: PLAZA.pagina, starts: perBegintijd(vrij, slot) };
}

const json = (data: unknown, status = 200, cache = false) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=0, must-revalidate",
      ...(cache
        ? {
            "netlify-cdn-cache-control": "public, durable, s-maxage=600, stale-while-revalidate=300",
            "netlify-vary": "query=datum|slot",
          }
        : { "netlify-cdn-cache-control": "no-store" }),
    },
  });

export default async (req: Request) => {
  const url = new URL(req.url);
  const datum = url.searchParams.get("datum") ?? "";
  const slot = url.searchParams.get("slot") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return json({ fout: "Ongeldige datum." }, 400);
  if (!leesSlot(slot)) return json({ fout: "Ongeldig tijdvak." }, 400);
  const vandaag = new Date().toISOString().slice(0, 10);
  const dagen = (Date.parse(datum) - Date.parse(vandaag)) / 86400000;
  if (dagen < -1 || dagen > 60) return json({ fout: "Datum ligt buiten het bereik." }, 400);

  const clubs: Record<string, unknown> = {};
  let alleGelukt = true;
  const bronnen: [string, () => Promise<unknown>][] = [
    ...KOPPELINGEN.map((k): [string, () => Promise<unknown>] => [k.id, () => racketIq(k, datum, slot)]),
    [PEAKZ.id, () => peakz(datum, slot)],
    [PLAZA.id, () => plaza(datum, slot)],
  ];
  await Promise.all(
    bronnen.map(async ([id, haalOp]) => {
      try {
        // Eén keer opnieuw proberen: de systemen van de clubs haperen soms even.
        clubs[id] = await haalOp().catch(async (e) => {
          console.warn(`Beschikbaarheid ${id} eerste poging mislukt`, e);
          await new Promise((r) => setTimeout(r, 400));
          return haalOp();
        });
      } catch (e) {
        alleGelukt = false;
        console.error(`Beschikbaarheid ${id} mislukt`, e);
        clubs[id] = { live: false, fout: "Kon de beschikbaarheid niet ophalen." };
      }
    })
  );
  // Alleen cachen op de CDN als alles gelukt is, zodat een storing niet 10 minuten blijft hangen.
  return json({ datum, slot, opgehaald: new Date().toISOString(), clubs }, 200, alleGelukt);
};

export const config = { path: "/api/banen" };
