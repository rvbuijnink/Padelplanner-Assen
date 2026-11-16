// Live vrije padelbanen bij clubs met een openbaar leesbaar boekingssysteem.
// GET /api/banen?datum=YYYY-MM-DD&slot=avond2
//
// Ondersteund: RacketIQ (Valley Padel Assen, Padel Rolde). Dit systeem geeft per begintijd
// de vrije banen terug, daarom vragen we alleen de begintijden binnen het gevraagde tijdvak op.
// Peakz (Foys) en Plaza (KNLTB Meet & Play) tonen vrije banen alleen na inloggen; die blijven
// zonder live gegevens.
//
// Om de clubs niet te belasten wordt elk antwoord 10 minuten gecachet: in het geheugen van de
// functie én op de CDN van Netlify (gedeeld tussen alle bezoekers).

type Koppeling = { id: string; host: string; groupId: number };

const KOPPELINGEN: Koppeling[] = [
  { id: "valley", host: "assen.valleypadel.nl", groupId: 2061 },
  { id: "rolde", host: "boeken.padelrolde.nl", groupId: 2097 },
];

// Tijdvakken zoals in public/planner.js. Begintijden elk half uur, zolang er nog 1 uur past.
const SLOTS: Record<string, [number, number]> = {
  ochtend: [9, 12],
  middag: [12, 17],
  avond1: [17, 19],
  avond2: [19, 22],
};
const begintijden = (slot: string) => {
  const [van, tot] = SLOTS[slot];
  const out: string[] = [];
  for (let m = van * 60; m + 60 <= tot * 60; m += 30) {
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

async function haal(url: string) {
  const r = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "Padelplanner-Assen/1.0 (groepsplanner)" },
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
  return { live: true, boekbaar: true, boekbaarTot, boekingsLink, starts };
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
  if (!SLOTS[slot]) return json({ fout: "Ongeldig tijdvak." }, 400);
  const vandaag = new Date().toISOString().slice(0, 10);
  const dagen = (Date.parse(datum) - Date.parse(vandaag)) / 86400000;
  if (dagen < -1 || dagen > 60) return json({ fout: "Datum ligt buiten het bereik." }, 400);

  const clubs: Record<string, unknown> = {};
  let alleGelukt = true;
  await Promise.all(
    KOPPELINGEN.map(async (k) => {
      try {
        clubs[k.id] = await racketIq(k, datum, slot);
      } catch (e) {
        alleGelukt = false;
        console.error(`Beschikbaarheid ${k.id} mislukt`, e);
        clubs[k.id] = { live: false, fout: "Kon de beschikbaarheid niet ophalen." };
      }
    })
  );
  // Alleen cachen op de CDN als alles gelukt is, zodat een storing niet 10 minuten blijft hangen.
  return json({ datum, slot, opgehaald: new Date().toISOString(), clubs }, 200, alleGelukt);
};

export const config = { path: "/api/banen" };
