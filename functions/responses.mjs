// Slaat de peilingantwoorden op in Netlify Blobs en geeft ze terug.
// Alleen voor ingelogde spelers (Netlify Identity).
// GET  /api/responses  -> alle antwoorden (eigen antwoord gemarkeerd met eigen: true)
// POST /api/responses  -> eigen antwoord opslaan (één antwoord per account)
import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";

const NIVEAUS = ["n80", "n85", "n90", "n95"];
const DUREN = ["60", "90"];
const FREQ = ["2x-per-week", "wekelijks", "tweewekelijks", "wanneer-het-lukt"];

// Blokken van een half uur waarin je kunt spelen, van 08:30 tot 22:00.
const BLOKKEN = [];
for (let m = 8 * 60 + 30; m < 22 * 60; m += 30)
  BLOKKEN.push(String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const sleutel = (user) => "u-" + user.id;

export default async (req) => {
  const user = await getUser();
  if (!user) return json({ fout: "Log eerst in." }, 401);

  // Optionele groepscode: stel GROUP_CODE in als omgevingsvariabele in Netlify.
  const code = Netlify.env.get("GROUP_CODE");
  if (code && req.headers.get("x-groepscode") !== code) {
    return json({ fout: "Groepscode klopt niet." }, 401);
  }

  const store = getStore("padelplanner");
  const mijnKey = sleutel(user);

  if (req.method === "GET") {
    const { blobs } = await store.list();
    const accounts = [];
    const oud = [];
    for (const b of blobs) {
      const v = await store.get(b.key, { type: "json" });
      if (!v) continue;
      const { uid, ...openbaar } = v;
      if (b.key.startsWith("u-")) accounts.push({ ...openbaar, eigen: b.key === mijnKey });
      else oud.push(openbaar);
    }
    // Antwoorden van voor het inloggen tellen mee, tenzij dezelfde naam al
    // een antwoord via een account heeft.
    const namen = new Set(accounts.map((r) => r.naam.toLowerCase()));
    const responses = accounts.concat(oud.filter((r) => !namen.has(r.naam.toLowerCase())));
    return json({ responses });
  }

  if (req.method === "POST") {
    const text = await req.text();
    if (text.length > 30000) return json({ fout: "Bericht te groot." }, 413);
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
      if (!Array.isArray(sl) || !sl.every((x) => BLOKKEN.includes(x))) return json({ fout: "Ongeldige speeltijd." }, 400);
      if (sl.length) beschikbaar[d] = BLOKKEN.filter((x) => sl.includes(x));
    }

    const record = {
      versie: 2,
      uid: user.id,
      naam,
      niveau: b.niveau,
      wensNiveaus: [...new Set(b.wensNiveaus)],
      duren: [...new Set(b.duren)],
      frequentie: b.frequentie,
      beschikbaar,
      bijgewerkt: new Date().toISOString(),
    };
    await store.setJSON(mijnKey, record);
    return json({ ok: true });
  }

  return json({ fout: "Methode niet toegestaan." }, 405);
};

export const config = { path: "/api/responses" };
