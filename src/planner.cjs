/* Planner-logica: gedeeld door de browser (gebundeld naar public/planner.js als window.Planner) en de server. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NIVEAUS = [
    { id: 'n70', label: '7 – 7,5' },
    { id: 'n75', label: '7,5 – 8' },
    { id: 'n80', label: '8 – 8,5' },
    { id: 'n85', label: '8,5 – 9' },
    { id: 'n90', label: '9 – 9,5' },
    { id: 'n95', label: '9,5 – 10' }
  ];
  // Speelsterkte is een getal van 7,0 t/m 10,0 in stapjes van 0,1 (opgeslagen als "8.2").
  // Oudere profielen hebben nog een range-id (bv. 'n80'); die blijven werken.
  const NIVEAU_MIN = 7, NIVEAU_MAX = 10, NIVEAU_STAP = 0.1;
  function niveauGetal(niveau) {
    const oud = /^n(\d{2})$/.exec(niveau || '');
    if (oud) return Number(oud[1]) / 10;
    const g = Number(niveau);
    return Number.isFinite(g) ? g : NaN;
  }
  // Bij welke range (id) hoort een speelsterkte? 8,5 valt in '8,5 – 9'; 10,0 valt in '9,5 – 10'.
  function rangeVan(niveau) {
    const t = Math.round(niveauGetal(niveau) * 10);
    if (!Number.isFinite(t)) return null;
    const b = Math.min(95, Math.max(70, Math.floor(t / 5) * 5));
    return 'n' + b;
  }
  function geldigNiveau(niveau) {
    const g = Number(niveau);
    return typeof niveau === 'string' && /^\d{1,2}\.\d$/.test(niveau) && g >= NIVEAU_MIN && g <= NIVEAU_MAX;
  }
  const niveauLabel = (niveau) => niveauGetal(niveau).toFixed(1).replace('.', ',');
  // Met welk niveau iemand wil spelen: een range van-tot, opgeslagen als ["8.0-9.2"].
  // Oudere profielen hebben nog losse range-id's (bv. ['n80', 'n85']); die blijven werken.
  const WENS = /^(\d{1,2}\.\d)-(\d{1,2}\.\d)$/;
  function wensBereik(wens) {
    const lijst = Array.isArray(wens) ? wens : [];
    const m = lijst.length === 1 && WENS.exec(lijst[0]);
    if (m) return [Number(m[1]), Number(m[2])];
    const oud = lijst.map((id) => niveauGetal(id)).filter(Number.isFinite);
    if (!oud.length) return null;
    return [Math.min(...oud), Math.min(NIVEAU_MAX, Math.max(...oud) + 0.5)];
  }
  function geldigeWens(wens) {
    if (!Array.isArray(wens) || wens.length !== 1) return false;
    const m = WENS.exec(wens[0]);
    return !!m && geldigNiveau(m[1]) && geldigNiveau(m[2]) && Number(m[1]) <= Number(m[2]);
  }
  // Wil iemand met deze wens spelen met iemand van dit niveau?
  function wilMet(wens, niveau) {
    const lijst = Array.isArray(wens) ? wens : [];
    const m = lijst.length === 1 && WENS.exec(lijst[0]);
    if (!m) return lijst.includes(rangeVan(niveau));
    const t = Math.round(niveauGetal(niveau) * 10);
    return t >= Math.round(Number(m[1]) * 10) && t <= Math.round(Number(m[2]) * 10);
  }
  const wensLabel = (wens) => { const b = wensBereik(wens); return b ? b.map((g) => g.toFixed(1).replace('.', ',')).join(' – ') : ''; };
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
  // Oude dagdelen (van vóór de schuifbalken) worden omgezet naar tijden.
  const OUDE_SLOTS = { ochtend: [540, 720], middag: [720, 1020], avond1: [1020, 1140], avond2: [1140, 1320] };
  // Schuifbalken lopen van 07:00 tot 23:00 in stappen van een half uur.
  const DAG_VAN = 7 * 60, DAG_TOT = 23 * 60, STAP = 30;
  const VENSTER_DAGEN = 14;
  // Beschikbaarheid vul je per week in, voor de hele periode waarin je bij een club al een baan kunt reserveren.
  const WEKEN_ZICHTBAAR = 5;
  // Hoe ver vooruit er gepland wordt: de langste termijn waarop een club banen openzet (Peakz, ongeveer een maand).
  // Of een dag bij een club al open is en wat een baan kost, komt live uit het boekingssysteem van de club.
  const HORIZON_STANDAARD = 31;
  const HORIZON_MAX = 6 * 7;
  const FREQUENTIES = [
    { id: 'wanneer-het-lukt', label: 'Wanneer het lukt' },
    { id: 'tweewekelijks', label: 'Om de week' },
    { id: 'wekelijks', label: 'Iedere week' },
    { id: '2x-per-week', label: '2x per week' },
    { id: '3x-per-week', label: '3x per week' }
  ];
  // Per club ja of nee. (Oudere profielen kunnen nog 'zomer' hebben; dat telt buiten lente en zomer als 'nee'.)
  const VOORKEUREN = [
    { id: 'wel', label: 'Ja' },
    { id: 'niet', label: 'Nee' }
  ];
  // Lente en zomer: 21 maart t/m 22 september.
  const LENTE_ZOMER = ['03-21', '09-22'];

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
  const naarMin = (t) => { const [u, m] = String(t).split(':').map(Number); return u * 60 + m; };
  const naarTijd = (m) => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  // "19:00-21:30" (of een oud dagdeel) -> [van, tot] in minuten
  function leesTijd(s) {
    if (OUDE_SLOTS[s]) return OUDE_SLOTS[s].slice();
    const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(String(s));
    if (!m) return null;
    const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
    return a < b && b <= 1440 ? [a, b] : null;
  }
  const tijdId = (a, b) => naarTijd(a) + '-' + naarTijd(b);
  const tijdLabel = (id) => { const r = leesTijd(id); return r ? naarTijd(r[0]) + '–' + naarTijd(r[1]) : String(id); };
  // Lijst met tijden van één dag: gesorteerd en overlappende tijden samengevoegd, als [[van, tot]].
  function tijdenVan(lijst) {
    const r = (lijst || []).map(leesTijd).filter(Boolean).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of r) {
      const l = out[out.length - 1];
      if (l && a <= l[1]) l[1] = Math.max(l[1], b);
      else out.push([a, b]);
    }
    return out;
  }
  const normaliseer = (lijst) => tijdenVan(lijst).map(([a, b]) => tijdId(a, b));
  // Hoeveel minuten iemand vanaf tijdstip t aaneengesloten kan.
  function vrijVanaf(tijden, t) {
    for (const [a, b] of tijden) if (a <= t && t < b) return b - t;
    return 0;
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
  // Hoe ver vooruit er bij minstens één club een baan te reserveren is (de langste boekingshorizon), in dagen.
  function boekingsHorizon(clubs) {
    const h = (clubs || []).map((c) => Number(c.horizonDagen)).filter((n) => Number.isFinite(n) && n > 0);
    return Math.min(HORIZON_MAX, h.length ? Math.max(...h) : HORIZON_STANDAARD);
  }
  // De weken (maandagen) van deze week tot en met de week waarin de boekingshorizon eindigt.
  function wekenBinnenHorizon(today, clubs) {
    const laatste = new Date(today.getFullYear(), today.getMonth(), today.getDate() + boekingsHorizon(clubs));
    return weken(today, Math.round(dagenTussen(maandagVan(today), maandagVan(laatste)) / 7) + 1);
  }
  // Status van een week voor één speler: ingevuld of nog open.
  function weekStatus(speler, weekKey) {
    const w = speler && speler.weken && speler.weken[weekKey];
    if (w && w.standaard) return { soort: 'standaard' };
    if (w) return { soort: 'ingevuld', bijgewerkt: w.bijgewerkt };
    return { soort: 'open' };
  }
  // Standaardweek (weekdag "0" = maandag … "6" = zondag -> tijden) omzetten naar de datums van één week.
  function standaardVoorWeek(standaard, weekKey) {
    const out = {};
    dagenVanWeek(weekKey).forEach((d, i) => { const t = standaard && standaard[String(i)]; if (t && t.length) out[d] = t.slice(); });
    return out;
  }
  // Weken die de speler niet zelf heeft ingevuld krijgen de standaardweek (gemarkeerd met standaard: true).
  function vulStandaardweek(weken, standaard, weekKeys) {
    const out = Object.assign({}, weken || {});
    if (!standaard || !Object.keys(standaard).length) return out;
    for (const w of weekKeys) if (!out[w]) out[w] = { tijdvakken: standaardVoorWeek(standaard, w), standaard: true };
    return out;
  }
  // Alle weken samenvoegen tot één overzicht datum -> tijdvakken
  function beschikbaarVan(speler) {
    const out = {};
    for (const w of Object.values(speler.weken || {})) {
      for (const [d, sl] of Object.entries(w.tijdvakken || {})) out[d] = sl;
    }
    return out;
  }
  const isLenteZomer = (datumKey) => {
    const md = String(datumKey).slice(5, 10);
    return md >= LENTE_ZOMER[0] && md <= LENTE_ZOMER[1];
  };
  // Alles behalve 'niet' en 'zomer' telt als 'wel' (ook oudere waarden zoals 'graag' of 'prima').
  // Met een datum wordt 'zomer' buiten lente en zomer 'niet'; zonder datum blijft het 'zomer'.
  function voorkeurVan(speler, clubId, datumKey) {
    const v = speler.clubVoorkeur && speler.clubVoorkeur[clubId];
    if (v === 'niet') return 'niet';
    if (v === 'zomer') return datumKey && !isLenteZomer(datumKey) ? 'niet' : 'zomer';
    return 'wel';
  }

  // Twee spelers passen bij elkaar als ze elkaars niveau accepteren
  // en minstens één speelduur gemeenschappelijk hebben.
  function gemeenschappelijkeDuren(a, b) {
    return a.duren.filter((d) => b.duren.includes(d));
  }
  // Twee spelers moeten ook minstens één club delen waar ze allebei willen spelen.
  function gedeeldeClub(groep, clubs, datumKey) {
    return clubs.some((c) => groep.every((p) => voorkeurVan(p, c.id, datumKey) !== 'niet'));
  }
  function compatibel(a, b, clubs, datumKey) {
    return (
      (!clubs || gedeeldeClub([a, b], clubs, datumKey)) &&
      wilMet(a.wensNiveaus, b.niveau) &&
      wilMet(b.wensNiveaus, a.niveau) &&
      gemeenschappelijkeDuren(a, b).length > 0
    );
  }

  // Alle groepjes van 4 waarin iedereen bij iedereen past
  // en alle vier minstens één speelduur gemeen hebben.
  function groepenVanVier(spelers, clubs, datumKey) {
    const res = [];
    const n = spelers.length;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (!compatibel(spelers[i], spelers[j], clubs, datumKey)) continue;
        for (let k = j + 1; k < n; k++) {
          if (!compatibel(spelers[i], spelers[k], clubs, datumKey) || !compatibel(spelers[j], spelers[k], clubs, datumKey)) continue;
          for (let l = k + 1; l < n; l++) {
            const g = [spelers[i], spelers[j], spelers[k], spelers[l]];
            if (!compatibel(g[0], g[3], clubs, datumKey) || !compatibel(g[1], g[3], clubs, datumKey) || !compatibel(g[2], g[3], clubs, datumKey)) continue;
            const duren = g[0].duren.filter((d) => g.every((p) => p.duren.includes(d)));
            if (duren.length === 0) continue;
            if (clubs && !gedeeldeClub(g, clubs, datumKey)) continue;
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

  // Daluren: maandag t/m vrijdag, met een starttijd vóór 17:00.
  function isDal(datumKey, slotId) {
    if (!datumKey || !slotId) return false;
    const wd = parseKey(datumKey).getDay();
    const r = leesTijd(slotId);
    return wd >= 1 && wd <= 5 && !!r && r[0] < 17 * 60;
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

  // Clubs zonder vaste prijzen of boekingstermijn: vrije banen, prijzen en hoe ver vooruit je kunt boeken komen live van de club.
  function liveClubs(basis) {
    return basis.map((c) => Object.assign({}, c, {
      prijs60: null, prijs90: null, dalPrijs60: null, dalPrijs90: null,
      horizonDagen: null, horizonBevestigd: false, opentOm: null, prijsBron: 'live', opmerking: ''
    }));
  }

  // Link waarmee je meteen op de goede plek bij de club uitkomt.
  // RacketIQ (Valley, Rolde) vult datum, tijd en speelduur in; Meet & Play (Plaza, De Hertenkamp) de datum; Peakz opent de boekingspagina.
  function boekLink(club, datumKey, tijd, duur) {
    if (!club) return null;
    const basis = club.boeken;
    if (!datumKey) return basis;
    if (club.linkSoort === 'racketiq') {
      return basis + '?date=' + datumKey + (tijd ? '&time=' + tijd : '') + (duur ? '&duration=' + duur : '');
    }
    if (club.linkSoort === 'meetandplay') {
      const [j, m, d] = datumKey.split('-');
      return basis + '?date=' + d + '-' + m + '-' + j;
    }
    return basis;
  }

  // Of de hele groep bij deze club wil spelen (op die datum, als die is meegegeven).
  function clubOk(groep, club, datumKey) {
    return groep.every((p) => voorkeurVan(p, club.id, datumKey) !== 'niet');
  }

  // spelers: [{ naam, niveau, wensNiveaus, duren, clubVoorkeur, weken }]
  // Per dag wordt elk half uur gekeken wie er vanaf dat moment 1 of 1,5 uur aaneengesloten kan.
  function plan(spelers, clubs, today, aantal, dagen) {
    const lijst = spelers.map((s) => {
      const per = {};
      for (const [d, t] of Object.entries(beschikbaarVan(s))) per[d] = tijdenVan(t);
      return Object.assign({}, s, { tijden: per });
    });
    const minDuur = Math.min(...DUREN.map((d) => Number(d.id)));
    const kandidaten = [];
    for (const d of dagen || volgendeDagen(today)) {
      let vorige = null;
      for (let t = DAG_VAN; t + minDuur <= 1440; t += STAP) {
        const beschikbaar = [];
        for (const r of lijst) {
          const rest = vrijVanaf(r.tijden[d] || [], t);
          const duren = r.duren.filter((x) => Number(x) <= rest);
          if (duren.length) beschikbaar.push(Object.assign({}, r, { duren, rest }));
        }
        if (beschikbaar.length < 4) { vorige = null; continue; }
        // Spelers met kanBoeken === false (niet bereid of geen 06-nummer) kunnen de baan niet boeken:
        // een groepje moet minstens één speler hebben die dat wel kan.
        const groepen = groepenVanVier(beschikbaar, clubs, d).filter((g) => g.spelers.some((p) => p.kanBoeken !== false));
        if (!groepen.length) { vorige = null; continue; }
        const namen = new Set();
        groepen.forEach((g) => g.spelers.forEach((p) => namen.add(p.naam)));
        const sleutel = [...namen].sort().join('|');
        // Zelfde spelers als een half uur eerder: dat moment is al gevonden.
        if (vorige && vorige.sleutel === sleutel && t < vorige.tot) continue;
        // Kies het groepje met de meeste gemeenschappelijke speelduren en de meeste clubs waar iedereen wil spelen
        const aantalClubs = (g) => clubs.filter((c) => clubOk(g.spelers, c, d)).length;
        const beste = groepen.slice().sort((a, b) => b.duren.length - a.duren.length || aantalClubs(b) - aantalClubs(a))[0];
        const tot = t + Math.min(...beste.spelers.map((p) => p.rest));
        vorige = { sleutel, tot };
        const id = tijdId(t, tot);
        const slot = { id, van: naarTijd(t), tot: naarTijd(tot), label: tijdLabel(id) };
        const opties = clubs
          .filter((c) => clubOk(beste.spelers, c, d))
          .map((c) => ({ club: c, status: status(c, d, id, today) }))
          .filter((o) => o.status.soort === 'boekbaar' || o.status.soort === 'nog-niet')
          .map((o) => Object.assign(o, { prijs: prijs(o.club, beste.duren[0], d, id) }))
          .sort((a, b) => {
            const va = a.status.soort === 'boekbaar' ? 0 : 1;
            const vb = b.status.soort === 'boekbaar' ? 0 : 1;
            if (va !== vb) return va - vb;
            const la = a.club.laatsteKeus ? 1 : 0, lb = b.club.laatsteKeus ? 1 : 0;
            if (la !== lb) return la - lb;
            return (a.prijs ? a.prijs.perPersoon : 1e9) - (b.prijs ? b.prijs.perPersoon : 1e9);
          });
        kandidaten.push({
          datum: d,
          slot,
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
        a.datum.localeCompare(b.datum) ||
        a.slot.van.localeCompare(b.slot.van)
    );
    // Overlappende momenten op dezelfde dag met (een deel van) dezelfde spelers en speelduren maar één keer tonen.
    const gekozen = [];
    for (const k of kandidaten) {
      const dubbel = gekozen.some((g) => g.datum === k.datum && k.slot.van < g.slot.tot && g.slot.van < k.slot.tot &&
        k.spelers.every((n) => g.spelers.includes(n)) && k.duren.every((x) => g.duren.includes(x)));
      if (!dubbel) gekozen.push(k);
      if (gekozen.length >= (aantal || 3)) break;
    }
    return gekozen;
  }

  return {
    NIVEAUS, NIVEAU_MIN, NIVEAU_MAX, NIVEAU_STAP, niveauGetal, rangeVan, geldigNiveau, niveauLabel, wensBereik, geldigeWens, wilMet, wensLabel, DUREN, SLOTS, OUDE_SLOTS, DAG_VAN, DAG_TOT, STAP, VENSTER_DAGEN,
    naarMin, naarTijd, leesTijd, tijdId, tijdLabel, tijdenVan, normaliseer, vrijVanaf, WEKEN_ZICHTBAAR, HORIZON_STANDAARD, HORIZON_MAX, VOORKEUREN, FREQUENTIES,
    dagKey, parseKey, dagenTussen, volgendeDagen,
    maandagVan, weken, dagenVanWeek, boekingsHorizon, wekenBinnenHorizon, weekStatus, standaardVoorWeek, vulStandaardweek, beschikbaarVan, voorkeurVan, isLenteZomer, clubOk,
    compatibel, groepenVanVier, status, prijs, isDal, voegClubsSamen, liveClubs, boekLink, plan
  };
});
