/* Planner-logica: werkt in de browser (window.Planner) en in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NIVEAUS = [
    { id: 'n80', label: '8 – 8,5' },
    { id: 'n85', label: '8,5 – 9' },
    { id: 'n90', label: '9 – 9,5' },
    { id: 'n95', label: '9,5 – 10' }
  ];
  const DUREN = [
    { id: '60', label: '1 uur', min: 60 },
    { id: '90', label: '1,5 uur', min: 90 }
  ];
  const FREQUENTIES = [
    { id: '2x-per-week', label: '2x per week' },
    { id: 'wekelijks', label: '1x per week' },
    { id: 'tweewekelijks', label: 'Om de week' },
    { id: 'wanneer-het-lukt', label: 'Wanneer het lukt' }
  ];
  const VENSTER_DAGEN = 14;

  const pad = (n) => String(n).padStart(2, '0');
  const naarMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const naarTijd = (m) => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  const reeks = (van, tot) => { const out = []; for (let m = naarMin(van); m < naarMin(tot); m += 30) out.push(naarTijd(m)); return out; };

  // Speeltijden per dagdeel. Beschikbaarheid wordt opgeslagen als blokken van
  // een half uur: blok "19:00" betekent dat je van 19:00 tot 19:30 kunt spelen.
  const DAGDELEN = [
    { id: 'ochtend', label: 'Ochtend', van: '08:30', tot: '12:00' },
    { id: 'middag', label: 'Middag', van: '12:00', tot: '18:00' },
    { id: 'avond', label: 'Avond', van: '18:00', tot: '22:00', laatsteStart: '20:30' }
  ];
  const BLOKKEN = reeks('08:30', '22:00');
  const LAATSTE_START = '20:30';
  const STARTS = BLOKKEN.filter((t) => naarMin(t) <= naarMin(LAATSTE_START));
  const dagdeelVan = (t) => DAGDELEN.find((d) => naarMin(t) >= naarMin(d.van) && naarMin(t) < naarMin(d.tot));
  const SLOTS = STARTS.map((t) => ({ id: t, label: t, dagdeel: dagdeelVan(t).id }));

  const dagKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  function parseKey(k) {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function dagenTussen(a, b) {
    const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / 86400000);
  }
  function volgendeDagen(today, n) {
    const out = [];
    for (let i = 0; i < (n || VENSTER_DAGEN); i++) {
      out.push(dagKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)));
    }
    return out;
  }

  // Oudere antwoorden (dagdelen of starttijden) omzetten naar blokken.
  const OUD = {
    ochtend: reeks('09:00', '12:00'),
    middag: reeks('12:00', '17:00'),
    avond1: reeks('18:00', '19:00'),
    avond2: reeks('19:00', '22:00')
  };
  function normaliseer(r) {
    if (r.versie === 2) return r;
    const beschikbaar = {};
    for (const [d, sl] of Object.entries(r.beschikbaar || {})) {
      const set = new Set();
      for (const x of sl) {
        if (OUD[x]) OUD[x].forEach((b) => set.add(b));
        else if (/^\d\d:\d\d$/.test(x)) reeks(x, naarTijd(Math.min(naarMin(x) + 90, 22 * 60))).forEach((b) => set.add(b));
      }
      beschikbaar[d] = BLOKKEN.filter((b) => set.has(b));
    }
    return Object.assign({}, r, { beschikbaar, versie: 2 });
  }

  // Kan deze speler op deze dag om deze tijd zo lang spelen?
  function kanSpelen(r, datumKey, start, minuten) {
    const blokken = r.beschikbaar[datumKey] || [];
    return reeks(start, naarTijd(naarMin(start) + minuten)).every((b) => blokken.includes(b));
  }

  // Twee spelers passen bij elkaar als ze elkaars niveau accepteren
  // en minstens één speelduur gemeenschappelijk hebben.
  function gemeenschappelijkeDuren(a, b) {
    return a.duren.filter((d) => b.duren.includes(d));
  }
  function compatibel(a, b) {
    return (
      a.wensNiveaus.includes(b.niveau) &&
      b.wensNiveaus.includes(a.niveau) &&
      gemeenschappelijkeDuren(a, b).length > 0
    );
  }

  // Alle groepjes van 4 waarin iedereen bij iedereen past
  // en alle vier minstens één speelduur gemeen hebben.
  function groepenVanVier(spelers) {
    const res = [];
    const n = spelers.length;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (!compatibel(spelers[i], spelers[j])) continue;
        for (let k = j + 1; k < n; k++) {
          if (!compatibel(spelers[i], spelers[k]) || !compatibel(spelers[j], spelers[k])) continue;
          for (let l = k + 1; l < n; l++) {
            const g = [spelers[i], spelers[j], spelers[k], spelers[l]];
            if (!compatibel(g[0], g[3]) || !compatibel(g[1], g[3]) || !compatibel(g[2], g[3])) continue;
            const duren = g[0].duren.filter((d) => g.every((p) => p.duren.includes(d)));
            if (duren.length === 0) continue;
            res.push({ spelers: g, duren });
          }
        }
      }
    return res;
  }

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // DEMO: boekbaarheid per club. Echte beschikbaarheid komt later via koppelingen.
  function status(club, datumKey, slotId, today) {
    const dagen = dagenTussen(today, parseKey(datumKey));
    if (dagen < 0) return { soort: 'verleden' };
    if (dagen > club.horizonDagen) {
      const opent = parseKey(datumKey);
      opent.setDate(opent.getDate() - club.horizonDagen);
      return { soort: 'nog-niet', opentOp: dagKey(opent), dagenTotOpening: dagenTussen(today, opent) };
    }
    const vrij = Math.max(0, (hash(club.id + datumKey + slotId) % (club.banen + 2)) - 1);
    return { soort: vrij > 0 ? 'vrij' : 'bezet', vrij };
  }

  function prijs(club, minuten) {
    if (club.prijsPerBaan60 == null) return null;
    const perBaan = club.prijsPerBaan60 * (minuten / 60);
    return { perBaan, perPersoon: perBaan / 4 };
  }

  function alleKandidaten(responses, clubs, today) {
    responses = responses.map(normaliseer);
    const kandidaten = [];
    for (const d of volgendeDagen(today)) {
      for (const s of SLOTS) {
        // Per speler alleen de speelduren die op dit starttijdstip passen.
        const beschikbaar = responses
          .map((r) => Object.assign({}, r, { duren: r.duren.filter((du) => kanSpelen(r, d, s.id, Number(du))) }))
          .filter((r) => r.duren.length);
        if (beschikbaar.length < 4) continue;
        const groepen = groepenVanVier(beschikbaar);
        if (!groepen.length) continue;
        const inGroep = new Map();
        groepen.forEach((g) => g.spelers.forEach((p) => inGroep.set(p.naam, p.duren)));
        // Kies het groepje met de meeste gemeenschappelijke speelduren
        const beste = groepen.slice().sort((a, b) => b.duren.length - a.duren.length)[0];
        const opties = clubs
          .map((c) => ({ club: c, status: status(c, d, s.id, today) }))
          .filter((o) => o.status.soort === 'vrij' || o.status.soort === 'nog-niet')
          .sort((a, b) => {
            const va = a.status.soort === 'vrij' ? 0 : 1;
            const vb = b.status.soort === 'vrij' ? 0 : 1;
            if (va !== vb) return va - vb;
            const pa = prijs(a.club, 60), pb = prijs(b.club, 60);
            return (pa ? pa.perPersoon : 1e9) - (pb ? pb.perPersoon : 1e9);
          });
        // Momenten waarop alle clubs bezet zijn, tonen we niet.
        if (!opties.length) continue;
        kandidaten.push({
          datum: d,
          slot: s,
          spelers: [...inGroep.keys()].sort((a, b) => a.localeCompare(b, 'nl')),
          spelerDuren: Object.fromEntries(inGroep),
          aantalGroepen: groepen.length,
          voorbeeldGroep: beste.spelers.map((p) => p.naam),
          duren: beste.duren,
          opties,
          heeftVrij: opties.some((o) => o.status.soort === 'vrij')
        });
      }
    }
    // Per dagdeel alleen de beste starttijd houden; andere starttijden met
    // evenveel spelers worden als alternatief getoond.
    const volgorde = (id) => SLOTS.findIndex((s) => s.id === id);
    const beter = (a, b) =>
      b.spelers.length - a.spelers.length ||
      Number(b.heeftVrij) - Number(a.heeftVrij) ||
      a.datum.localeCompare(b.datum) ||
      volgorde(a.slot.id) - volgorde(b.slot.id);
    const perDagdeel = {};
    for (const k of kandidaten) {
      const sleutel = k.datum + '|' + k.slot.dagdeel;
      (perDagdeel[sleutel] = perDagdeel[sleutel] || []).push(k);
    }
    const uit = [];
    for (const lijst of Object.values(perDagdeel)) {
      lijst.sort(beter);
      const top = lijst[0];
      top.alternatieven = lijst
        .slice(1)
        .filter((k) => k.spelers.length === top.spelers.length)
        .map((k) => k.slot.id)
        .sort();
      uit.push(top);
    }
    return uit.sort(beter);
  }

  function plan(responses, clubs, today, aantal) {
    return alleKandidaten(responses, clubs, today).slice(0, aantal || 3);
  }

  // Maandag van de week waarin een datum valt.
  function weekStart(key) {
    const d = parseKey(key);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return dagKey(d);
  }

  // Beste momenten per week, op verschillende dagen. Het tweede moment ligt
  // bij voorkeur minstens een dag na of voor het eerste.
  function planPerWeek(responses, clubs, today, perWeek) {
    const weken = {};
    for (const k of alleKandidaten(responses, clubs, today)) {
      (weken[weekStart(k.datum)] = weken[weekStart(k.datum)] || []).push(k);
    }
    return Object.keys(weken).sort().map((week) => {
      const lijst = weken[week];
      const gekozen = [];
      while (gekozen.length < (perWeek || 2)) {
        const vrij = lijst.filter((k) => !gekozen.some((g) => g.datum === k.datum));
        const ruim = vrij.filter((k) => gekozen.every((g) => Math.abs(dagenTussen(parseKey(g.datum), parseKey(k.datum))) >= 2));
        const volgende = ruim[0] || vrij[0];
        if (!volgende) break;
        gekozen.push(volgende);
      }
      return { week, momenten: gekozen.sort((a, b) => a.datum.localeCompare(b.datum)) };
    });
  }

  return {
    NIVEAUS, DUREN, SLOTS, DAGDELEN, BLOKKEN, STARTS, LAATSTE_START, FREQUENTIES, VENSTER_DAGEN,
    naarMin, naarTijd, reeks, dagKey, parseKey, dagenTussen, volgendeDagen, normaliseer, weekStart,
    kanSpelen, compatibel, groepenVanVier, status, prijs, plan, planPerWeek
  };
});
