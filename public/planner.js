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
  // Beschikbaarheid vul je per week in, uiterlijk 2 weken van tevoren.
  const WEKEN_ZICHTBAAR = 4; // deze week + 3 weken vooruit
  const DEADLINE_DAGEN = 14;
  const FREQUENTIES = [
    { id: 'wanneer-het-lukt', label: 'Wanneer het lukt' },
    { id: 'tweewekelijks', label: 'Om de week' },
    { id: 'wekelijks', label: 'Iedere week' },
    { id: '2x-per-week', label: '2x per week' }
  ];
  const VOORKEUREN = [
    { id: 'wel', label: 'Wel' },
    { id: 'niet', label: 'Niet' }
  ];

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

  // Maandag van de week waarin deze dag valt
  function maandagVan(d) {
    const dag = (d.getDay() + 6) % 7; // ma=0 ... zo=6
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dag);
  }
  function weken(today, n) {
    const ma = maandagVan(today);
    const out = [];
    for (let i = 0; i < (n || WEKEN_ZICHTBAAR); i++) {
      out.push(dagKey(new Date(ma.getFullYear(), ma.getMonth(), ma.getDate() + 7 * i)));
    }
    return out;
  }
  function dagenVanWeek(weekKey) {
    const ma = parseKey(weekKey);
    return volgendeDagen(ma, 7);
  }
  function deadline(weekKey) {
    const d = parseKey(weekKey);
    d.setDate(d.getDate() - DEADLINE_DAGEN);
    return dagKey(d);
  }
  // Status van een week voor één speler: ingevuld, open (deadline nog niet voorbij) of te laat.
  function weekStatus(speler, weekKey, today) {
    const w = speler && speler.weken && speler.weken[weekKey];
    const dl = deadline(weekKey);
    const dagenTot = dagenTussen(today, parseKey(dl));
    if (w) return { soort: 'ingevuld', bijgewerkt: w.bijgewerkt, deadline: dl, dagenTotDeadline: dagenTot };
    return { soort: dagenTot >= 0 ? 'open' : 'te-laat', deadline: dl, dagenTotDeadline: dagenTot };
  }
  // Alle weken samenvoegen tot één overzicht datum -> tijdvakken
  function beschikbaarVan(speler) {
    const out = {};
    for (const w of Object.values(speler.weken || {})) {
      for (const [d, sl] of Object.entries(w.tijdvakken || {})) out[d] = sl;
    }
    return out;
  }
  // Alles behalve 'niet' telt als 'wel' (ook oudere waarden zoals 'graag' of 'prima').
  const voorkeurVan = (speler, clubId) => (speler.clubVoorkeur && speler.clubVoorkeur[clubId] === 'niet' ? 'niet' : 'wel');

  // Twee spelers passen bij elkaar als ze elkaars niveau accepteren
  // en minstens één speelduur gemeenschappelijk hebben.
  function gemeenschappelijkeDuren(a, b) {
    return a.duren.filter((d) => b.duren.includes(d));
  }
  // Twee spelers moeten ook minstens één club delen waar ze allebei willen spelen.
  function gedeeldeClub(groep, clubs) {
    return clubs.some((c) => groep.every((p) => voorkeurVan(p, c.id) !== 'niet'));
  }
  function compatibel(a, b, clubs) {
    return (
      (!clubs || gedeeldeClub([a, b], clubs)) &&
      a.wensNiveaus.includes(b.niveau) &&
      b.wensNiveaus.includes(a.niveau) &&
      gemeenschappelijkeDuren(a, b).length > 0
    );
  }

  // Alle groepjes van 4 waarin iedereen bij iedereen past
  // en alle vier minstens één speelduur gemeen hebben.
  function groepenVanVier(spelers, clubs) {
    const res = [];
    const n = spelers.length;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (!compatibel(spelers[i], spelers[j], clubs)) continue;
        for (let k = j + 1; k < n; k++) {
          if (!compatibel(spelers[i], spelers[k], clubs) || !compatibel(spelers[j], spelers[k], clubs)) continue;
          for (let l = k + 1; l < n; l++) {
            const g = [spelers[i], spelers[j], spelers[k], spelers[l]];
            if (!compatibel(g[0], g[3], clubs) || !compatibel(g[1], g[3], clubs) || !compatibel(g[2], g[3], clubs)) continue;
            const duren = g[0].duren.filter((d) => g.every((p) => p.duren.includes(d)));
            if (duren.length === 0) continue;
            if (clubs && !gedeeldeClub(g, clubs)) continue;
            res.push({ spelers: g, duren });
          }
        }
      }
    return res;
  }

  // Boekbaarheid per club op basis van de boekingshorizon (hoe ver vooruit de club boekingen openzet).
  // Of er op dat moment echt nog een baan vrij is, zie je pas op de boekingspagina van de club.
  function status(club, datumKey, slotId, today) {
    const dagen = dagenTussen(today, parseKey(datumKey));
    if (dagen < 0) return { soort: 'verleden' };
    if (club.horizonDagen != null && dagen > club.horizonDagen) {
      const opent = parseKey(datumKey);
      opent.setDate(opent.getDate() - club.horizonDagen);
      return { soort: 'nog-niet', opentOp: dagKey(opent), dagenTotOpening: dagenTussen(today, opent) };
    }
    return { soort: 'boekbaar' };
  }

  // Daluren: maandag t/m vrijdag, ochtend en middag (tot 17:00).
  function isDal(datumKey, slotId) {
    if (!datumKey || !slotId) return false;
    const wd = parseKey(datumKey).getDay();
    return wd >= 1 && wd <= 5 && (slotId === 'ochtend' || slotId === 'middag');
  }

  // Prijs per baan voor 60 of 90 minuten. Zonder 90-minutenprijs: 1,5 x de 60-minutenprijs.
  function prijs(club, minuten, datumKey, slotId) {
    const dal = isDal(datumKey, slotId);
    const p60 = (dal && club.dalPrijs60 != null) ? club.dalPrijs60 : club.prijs60;
    const p90 = (dal && club.dalPrijs90 != null) ? club.dalPrijs90 : (dal && club.dalPrijs60 != null ? null : club.prijs90);
    let perBaan;
    if (Number(minuten) === 90) perBaan = p90 != null ? p90 : p60 != null ? p60 * 1.5 : null;
    else perBaan = p60 != null ? p60 : p90 != null ? p90 / 1.5 : null;
    if (perBaan == null) return null;
    return { perBaan, perPersoon: perBaan / 4, dal: dal && (club.dalPrijs60 != null || club.dalPrijs90 != null) };
  }

  // Clubs uit clubs.json samenvoegen met de gegevens die de beheerder heeft ingevuld.
  function voegClubsSamen(basis, gegevens) {
    return basis.map((c) => {
      const g = (gegevens || {})[c.id];
      const club = Object.assign({}, c, {
        prijs60: c.prijsPerBaan60 != null ? c.prijsPerBaan60 : null,
        prijs90: null, dalPrijs60: null, dalPrijs90: null, opmerking: ''
      });
      if (!g) return club;
      return Object.assign(club, {
        prijs60: g.prijs60, prijs90: g.prijs90, dalPrijs60: g.dalPrijs60, dalPrijs90: g.dalPrijs90,
        horizonDagen: g.horizonDagen, horizonBevestigd: g.horizonBevestigd, opentOm: g.opentOm,
        opmerking: g.opmerking || '', prijsBron: (g.prijs60 != null || g.prijs90 != null) ? 'club' : 'onbekend',
        bijgewerkt: g.bijgewerkt
      });
    });
  }

  // Of de hele groep bij deze club wil spelen.
  function clubOk(groep, club) {
    return groep.every((p) => voorkeurVan(p, club.id) !== 'niet');
  }

  // spelers: [{ naam, niveau, wensNiveaus, duren, clubVoorkeur, weken }]
  function plan(spelers, clubs, today, aantal, dagen) {
    const lijst = spelers.map((s) => Object.assign({}, s, { beschikbaar: beschikbaarVan(s) }));
    const kandidaten = [];
    for (const d of dagen || volgendeDagen(today)) {
      for (const s of SLOTS) {
        const beschikbaar = lijst.filter((r) => (r.beschikbaar[d] || []).includes(s.id));
        if (beschikbaar.length < 4) continue;
        const groepen = groepenVanVier(beschikbaar, clubs);
        if (!groepen.length) continue;
        const namen = new Set();
        groepen.forEach((g) => g.spelers.forEach((p) => namen.add(p.naam)));
        // Kies het groepje met de meeste gemeenschappelijke speelduren en de meeste clubs waar iedereen wil spelen
        const aantalClubs = (g) => clubs.filter((c) => clubOk(g.spelers, c)).length;
        const beste = groepen.slice().sort((a, b) => b.duren.length - a.duren.length || aantalClubs(b) - aantalClubs(a))[0];
        const opties = clubs
          .filter((c) => clubOk(beste.spelers, c))
          .map((c) => ({ club: c, status: status(c, d, s.id, today) }))
          .filter((o) => o.status.soort === 'boekbaar' || o.status.soort === 'nog-niet')
          .map((o) => Object.assign(o, { prijs: prijs(o.club, beste.duren[0], d, s.id) }))
          .sort((a, b) => {
            const va = a.status.soort === 'boekbaar' ? 0 : 1;
            const vb = b.status.soort === 'boekbaar' ? 0 : 1;
            if (va !== vb) return va - vb;
            return (a.prijs ? a.prijs.perPersoon : 1e9) - (b.prijs ? b.prijs.perPersoon : 1e9);
          });
        kandidaten.push({
          datum: d,
          slot: s,
          spelers: [...namen].sort(),
          aantalGroepen: groepen.length,
          voorbeeldGroep: beste.spelers.map((p) => p.naam),
          duren: beste.duren,
          opties,
          heeftVrij: opties.some((o) => o.status.soort === 'boekbaar')
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
    NIVEAUS, DUREN, SLOTS, VENSTER_DAGEN, WEKEN_ZICHTBAAR, DEADLINE_DAGEN, VOORKEUREN, FREQUENTIES,
    dagKey, parseKey, dagenTussen, volgendeDagen,
    maandagVan, weken, dagenVanWeek, deadline, weekStatus, beschikbaarVan, voorkeurVan, clubOk,
    compatibel, groepenVanVier, status, prijs, isDal, voegClubsSamen, plan
  };
});
