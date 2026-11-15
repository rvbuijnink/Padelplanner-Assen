# Padelplanner Assen

Een kleine Netlify-site waarmee een groep padelspelers hun niveau, gewenste tegenstanders, speelduur en beschikbaarheid doorgeeft. De planner zoekt daarna de beste momenten voor een viertal, laat zien wie er dan kan spelen en welke club de goedkoopste vrije baan heeft.

## Wat zit erin

- **Inloggen** met Netlify Identity (e-mail en wachtwoord). Alleen ingelogde spelers kunnen hun beschikbaarheid doorgeven en de antwoorden van anderen zien. Iedere speler heeft één antwoord per account.
- **Peiling** per speler: niveau (8–8,5 / 8,5–9 / 9–9,5 / 9,5–10), met welk niveau je wilt spelen (meerdere ranges mogelijk), speelduur (1 uur en/of 1,5 uur), frequentie (2x per week, 1x per week, om de week of wanneer het lukt) en beschikbaarheid voor de komende 14 dagen.
- **Speeltijden**: per dag kies je met een schuifbalk van hoe laat tot hoe laat je kunt spelen, per half uur, tussen 8:30 en 22:00. Kun je op een dag op meer momenten, dan voeg je met "Nog een moment kiezen op deze dag" een extra schuifbalk toe. De laatste starttijd is 20:30.
- **Planner**: zoekt starttijden waarop minstens vier mensen kunnen die bij elkaar passen. Een speler telt mee als de speelduur binnen zijn of haar speeltijd past. Twee spelers passen bij elkaar als ze elkaars niveau accepteren en minstens één speelduur gemeen hebben. Per week toont de planner de twee beste momenten op verschillende dagen, met wie er kan spelen.
- **Banen en prijzen**: vier clubs (Peakz Padel Assen, Valley Padel Assen, Plaza Sportz Assen, Padel Rolde), alleen dubbelbanen, met status "vrij" of "nog niet boekbaar (opent over X dagen)" en prijs per baan en per persoon. Bezette banen en momenten waarop alles bezet is worden niet getoond.
- ATV De Hertenkamp is bewust weggelaten (buitenbanen, weer).

## Wat nog demo is

- **Vrije banen** zijn voorbeeldwaarden. Echte beschikbaarheid vraagt een koppeling per club (Playtomic of Meet & Play).
- **Prijzen** van Peakz, Valley en Plaza zijn voorbeeldprijzen. Padel Rolde heeft nog geen prijs.
- **Boekingshorizon**: alleen Peakz (28 dagen) is bevestigd. De andere clubs staan op een aanname van 14 dagen. Pas dit aan in `public/clubs.json` (`horizonDagen` en `horizonBevestigd`).

## Accounts beheren

Standaard kan iedereen met de link een account maken (met bevestiging per e-mail). Wil je alleen spelers die je zelf uitnodigt, zet dan in Netlify onder Project configuration, Identity de registratie op "Invite only" en nodig spelers uit via het tabblad Identity.

Optioneel: stel de omgevingsvariabele `GROUP_CODE` in. Spelers moeten die code dan naast het inloggen ook invullen.

## Bestanden

- `public/index.html`: de pagina
- `public/planner.js`: matching, speeltijden, boekingshorizon, demo-beschikbaarheid, prijzen
- `public/clubs.json`: clubs, horizons en prijzen
- `src/auth.js`: inloggen; wordt bij de build gebundeld naar `public/auth.js`
- `functions/responses.mjs`: opslaan en ophalen van antwoorden (`/api/responses`), alleen voor ingelogde spelers
- `netlify.toml`, `package.json`: instellingen

## Nog te bouwen

- Wekelijkse herinnering (zondagavond, dinsdag voor wie nog niet heeft gereageerd) via een geplande Netlify-functie.
- Echte beschikbaarheid per club.
- Melding op het moment dat de planning van een club voor een gewenste dag opent.
