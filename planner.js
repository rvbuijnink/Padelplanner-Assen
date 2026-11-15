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
    { id: '60', label: '1 uur' },
    { id: '90', label: '1,5 uur' }
  ];
  const SLOTS = [
    { id: 'ochtend', label: 'Ochtend (9–12)' },
    { id: 'middag', label: 'Middag (12–17)' },
    { id: 'avond1', label: 'Vroege avond (17–19)' },
    { id: 'avond2', label: 'Late avond (19–22)' }
  ];
  const VENSTER_DAGEN = 14;

  const pad = (n) => String(n).padStart(2, '0');
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

  function plan(responses, clubs, today, aantal) {
    const kandidaten = [];
    for (const d of volgendeDagen(today)) {
      for (const s of SLOTS) {
        const beschikbaar = responses.filter((r) => (r.beschikbaar[d] || []).includes(s.id));
        if (beschikbaar.length < 4) continue;
        const groepen = groepenVanVier(beschikbaar);
        if (!groepen.length) continue;
        const namen = new Set();
        groepen.forEach((g) => g.spelers.forEach((p) => namen.add(p.naam)));
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
        kandidaten.push({
          datum: d,
          slot: s,
          spelers: [...namen].sort(),
          aantalGroepen: groepen.length,
          voorbeeldGroep: beste.spelers.map((p) => p.naam),
          duren: beste.duren,
          opties,
          heeftVrij: opties.some((o) => o.status.soort === 'vrij')
        });
      }
    }
    kandidaten.sort(
      (a, b) =>
        b.spelers.length - a.spelers.length ||
        Number(b.heeftVrij) - Number(a.heeftVrij) ||
        a.datum.localeCompare(b.datum)
    );
    return kandidaten.slice(0, aantal || 3);
  }

  return {
    NIVEAUS, DUREN, SLOTS, VENSTER_DAGEN,
    dagKey, parseKey, dagenTussen, volgendeDagen,
    compatibel, groepenVanVier, status, prijs, plan
  };
});
