# Padelplanner Assen

Een kleine Netlify-site waarmee een groep padelspelers hun niveau, gewenste tegenstanders, speelduur en beschikbaarheid doorgeeft. De planner zoekt daarna de beste momenten voor een viertal en laat zien welke club dan de goedkoopste vrije baan heeft.

## Wat zit erin

- **Vaste instellingen** per speler (één keer invullen, altijd aan te passen): speelsterkte (8–8,5 / 8,5–9 / 9–9,5 / 9,5–10), met welk niveau je wilt spelen, speelduur (1 uur en/of 1,5 uur), hoe vaak je wilt spelen (wanneer het lukt / om de week / iedere week / 2x per week) en per club of je er wel of niet wilt spelen.
- **Beschikbaarheid per week**: iedere week opnieuw invullen, uiterlijk 2 weken van tevoren (deadline = maandag twee weken voor de week). Je ziet deze week en drie weken vooruit, met per week de status (ingevuld / invullen vóór … / deadline voorbij). Daarna kun je het nog aanpassen. Handig: "Neem over van vorige ingevulde week" en "Ik kan deze week niet".
- **Wie heeft ingevuld**: overzicht per speler per week.
- **Planner**: zoekt momenten waarop minstens vier mensen kunnen die bij elkaar passen. Spelers passen bij elkaar als ze elkaars niveau accepteren, minstens één speelduur gemeen hebben en er een club is waar niemand van het viertal "Niet" heeft gekozen. Daarna wordt op prijs gesorteerd.
- **Banen en prijzen**: vier clubs (Peakz Padel Assen, Valley Padel Assen, Plaza Sportz Assen, Padel Rolde), alleen dubbelbanen, met status "vrij / bezet / nog niet boekbaar (opent over X dagen)" en prijs per baan en per persoon.
- ATV De Hertenkamp is bewust weggelaten (buitenbanen, weer).

## Koppeling met de clubs

Geen van de clubs biedt een openbare koppeling voor vrije banen (Peakz via de eigen app/Foys, Valley en Padel Rolde via RacketIQ, Plaza via KNLTB Meet & Play). Ook Padelchecker heeft geen openbare API. Daarom:

- Bij elk voorgesteld moment en in het banenoverzicht staat per club een **boekknop** naar de boekingspagina van die club, plus een knop **Vergelijk vrije banen op Padelchecker**.
- De planner laat per club zien of een dag al **boekbaar** is of wanneer de boeking opent, op basis van de boekingshorizon.
- Op het tabblad **Beheer clubs** vul je de echte prijzen in (1 uur, 1,5 uur en daltarief voor ma–vr tot 17:00), hoeveel dagen vooruit je kunt boeken, hoe laat een nieuwe dag opengaat en een opmerking. Zolang een club niet is ingevuld, gelden de voorbeeldwaarden uit `public/clubs.json`.
- Optioneel: stel `BEHEER_CODE` in als omgevingsvariabele. Alleen wie die code kent, kan dan clubgegevens wijzigen.

## Online zetten

Deze site gebruikt een Netlify-functie met Netlify Database (Postgres) om spelers en beschikbaarheid op te slaan. Netlify voert de migraties in `netlify/database/migrations` automatisch uit bij een deploy. Slepen van een map naar Netlify Drop is daarom niet genoeg. Gebruik een van deze twee manieren:

1. Zet de map in een GitHub-repository en koppel die aan een site in Netlify.
2. Of gebruik de Netlify CLI: `npm install`, `npx netlify login` en dan `npx netlify deploy --prod`.

Optioneel: stel in Netlify onder Site configuration, Environment variables de variabele `GROUP_CODE` in. Spelers moeten die code dan invullen om antwoorden te zien of op te slaan. Zonder code kan iedereen met de link de namen en antwoorden zien.

## Bestanden

- `public/index.html`: de pagina
- `public/planner.js`: matching, boekingshorizon, prijzen (incl. daltarief)
- `public/clubs.json`: clubs, horizons en prijzen
- `netlify/functions/api.mts`: `/api/spelers` (ophalen), `/api/profiel` (vaste instellingen) `/api/beschikbaarheid` (één week) en `/api/clubs` (clubgegevens)
- `db/schema.ts`: tabellen `spelers`, `beschikbaarheid` en `club_gegevens`; na een wijziging `npx drizzle-kit generate --name <naam>`
- `netlify.toml`, `package.json`: instellingen

## Nog te bouwen

- Wekelijkse herinnering (zondagavond, dinsdag voor wie nog niet heeft gereageerd) via een geplande Netlify-functie.
- Melding op het moment dat de planning van een club voor een gewenste dag opent.
