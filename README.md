# Padelplanner Assen

Een kleine Netlify-site waarmee een groep padelspelers hun niveau, gewenste tegenstanders, speelduur en beschikbaarheid doorgeeft. De planner zoekt daarna de beste momenten voor een viertal en laat zien welke club dan de goedkoopste vrije baan heeft.

## Wat zit erin

- **Peiling** per speler: niveau (8–8,5 / 8,5–9 / 9–9,5 / 9,5–10), met welk niveau je wilt spelen (meerdere ranges mogelijk), speelduur (1 uur en/of 1,5 uur, beide aanvinken geeft meer opties), frequentie en beschikbaarheid voor de komende 14 dagen.
- **Planner**: zoekt momenten waarop minstens vier mensen kunnen die bij elkaar passen. Twee spelers passen bij elkaar als ze elkaars niveau accepteren en minstens één speelduur gemeen hebben. Alle vier in een viertal moeten bij elkaar passen.
- **Banen en prijzen**: vier clubs (Peakz Padel Assen, Valley Padel Assen, Plaza Sportz Assen, Padel Rolde), alleen dubbelbanen, met status "vrij / bezet / nog niet boekbaar (opent over X dagen)" en prijs per baan en per persoon.
- ATV De Hertenkamp is bewust weggelaten (buitenbanen, weer).

## Wat nog demo is

- **Vrije banen** zijn voorbeeldwaarden. Echte beschikbaarheid vraagt een koppeling per club (Playtomic of Meet & Play).
- **Prijzen** van Peakz, Valley en Plaza zijn voorbeeldprijzen. Padel Rolde heeft nog geen prijs.
- **Boekingshorizon**: alleen Peakz (28 dagen) is bevestigd. De andere clubs staan op een aanname van 14 dagen. Pas dit aan in `public/clubs.json` (`horizonDagen` en `horizonBevestigd`).

## Online zetten

Deze site gebruikt een Netlify-functie met Netlify Blobs om de antwoorden op te slaan. Slepen van een map naar Netlify Drop is daarom niet genoeg. Gebruik een van deze twee manieren:

1. Zet de map in een GitHub-repository en koppel die aan een nieuwe site in Netlify. Netlify installeert zelf `@netlify/blobs` en bouwt de functie.
2. Of gebruik de Netlify CLI: `npm install`, `npx netlify login` en dan `npx netlify deploy --prod`.

Optioneel: stel in Netlify onder Site configuration, Environment variables de variabele `GROUP_CODE` in. Spelers moeten die code dan invullen om antwoorden te zien of op te slaan. Zonder code kan iedereen met de link de namen en antwoorden zien.

## Bestanden

- `public/index.html`: de pagina
- `public/planner.js`: matching, boekingshorizon, demo-beschikbaarheid, prijzen
- `public/clubs.json`: clubs, horizons en prijzen
- `functions/responses.mjs`: opslaan en ophalen van antwoorden (`/api/responses`)
- `netlify.toml`, `package.json`: instellingen

## Nog te bouwen

- Wekelijkse herinnering (zondagavond, dinsdag voor wie nog niet heeft gereageerd) via een geplande Netlify-functie.
- Echte beschikbaarheid per club.
- Melding op het moment dat de planning van een club voor een gewenste dag opent.
