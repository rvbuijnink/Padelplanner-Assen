// Slaat de peilingantwoorden op in Netlify Blobs en geeft ze terug.
// GET  /api/responses  -> alle antwoorden
// POST /api/responses  -> één speler opslaan (zelfde naam = overschrijven)
import { getStore } from "@netlify/blobs";

const NIVEAUS = ["n80", "n85", "n90", "n95"];
const DUREN = ["60", "90"];
const SLOTS = ["ochtend", "middag", "avond1", "avond2"];
const FREQ = ["wekelijks", "tweewekelijks", "wanneer-het-lukt"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const slug = (s) =>
  s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export default async (req) => {
  // Optionele groepscode: stel GROUP_CODE in als omgevingsvariabele in Netlify.
  const code = Netlify.env.get("GROUP_CODE");
  if (code && req.headers.get("x-groepscode") !== code) {
    return json({ fout: "Groepscode klopt niet." }, 401);
  }

  const store = getStore("padelplanner");

  if (req.method === "GET") {
    const { blobs } = await store.list();
    const responses = [];
    for (const b of blobs) {
      const v = await store.get(b.key, { type: "json" });
      if (v) responses.push(v);
    }
    return json({ responses });
  }

  if (req.method === "POST") {
    const text = await req.text();
    if (text.length > 20000) return json({ fout: "Bericht te groot." }, 413);
    let b;
    try { b = JSON.parse(text); } catch { return json({ fout: "Ongeldige invoer." }, 400); }

    const naam = typeof b.naam === "string" ? b.naam.trim() : "";
    if (naam.length < 1 || naam.length > 40) return json({ fout: "Naam is verplicht (max 40 tekens)." }, 400);
    if (!NIVEAUS.includes(b.niveau)) return json({ fout: "Kies je niveau." }, 400);
    if (!Array.isArray(b.wensNiveaus) || !b.wensNiveaus.length || !b.wensNiveaus.every((x) => NIVEAUS.includes(x)))
      return json({ fout: "Kies minstens één niveau waartegen je wilt spelen." }, 400);
    if (!Array.isArray(b.duren) || !b.duren.length || !b.duren.every((x) => DUREN.includes(x)))
      return json({ fout: "Kies minstens één speelduur." }, 400);
    if (!FREQ.includes(b.frequentie)) return json({ fout: "Kies hoe vaak je wilt spelen." }, 400);

    const beschikbaar = {};
    const dagen = Object.keys(b.beschikbaar || {});
    if (dagen.length > 31) return json({ fout: "Te veel dagen." }, 400);
    for (const d of dagen) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ fout: "Ongeldige datum." }, 400);
      const sl = b.beschikbaar[d];
      if (!Array.isArray(sl) || !sl.every((x) => SLOTS.includes(x))) return json({ fout: "Ongeldig tijdvak." }, 400);
      if (sl.length) beschikbaar[d] = [...new Set(sl)];
    }

    const key = slug(naam);
    if (!key) return json({ fout: "Ongeldige naam." }, 400);
    const record = {
      naam,
      niveau: b.niveau,
      wensNiveaus: [...new Set(b.wensNiveaus)],
      duren: [...new Set(b.duren)],
      frequentie: b.frequentie,
      beschikbaar,
      bijgewerkt: new Date().toISOString(),
    };
    await store.setJSON(key, record);
    return json({ ok: true });
  }

  return json({ fout: "Methode niet toegestaan." }, 405);
};

export const config = { path: "/api/responses" };
