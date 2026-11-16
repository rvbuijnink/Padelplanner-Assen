# Padelplanner Assen

Een kleine Netlify-site waarmee een groep padelspelers hun niveau, gewenste tegenstanders, speelduur en beschikbaarheid doorgeeft. De planner zoekt daarna de beste momenten voor een viertal en laat zien welke club dan de goedkoopste vrije baan heeft.

## Wat zit erin

- **Inloggen met een account** (Netlify Identity): account maken met naam, e-mailadres en wachtwoord, inloggen, wachtwoord vergeten en uitnodigingen. Elke speler hoort bij één account; je kunt alleen je eigen instellingen en beschikbaarheid aanpassen. Spelers van vóór het inloggen worden gekoppeld zodra iemand met dezelfde naam inlogt en zijn instellingen opslaat.

- **Vaste instellingen** per speler (één keer invullen, altijd aan te passen): je naam, speelsterkte (8–8,5 / 8,5–9 / 9–9,5 / 9,5–10), met welk niveau je wilt spelen, speelduur (1 uur en/of 1,5 uur), hoe vaak je wilt spelen (wanneer het lukt / om de week / iedere week / 2x per week) en per club of je er wel of niet wilt spelen.
- **Beschikbaarheid per week**: iedere week opnieuw invullen, uiterlijk 2 weken van tevoren (deadline = maandag twee weken voor de week). Je ziet deze week en drie weken vooruit, met per week de status (ingevuld / invullen vóór … / deadline voorbij). Daarna kun je het nog aanpassen. Per dag kies je met een schuifbalk je begintijd en eindtijd (07:00–23:00, per half uur), en eventueel meerdere tijden op één dag. Handig: "Neem over van vorige ingevulde week" en "Ik kan deze week niet".
- **Wie heeft ingevuld**: overzicht per speler per week.
- **Planner**: zoekt momenten waarop minstens vier mensen kunnen die bij elkaar passen. Spelers passen bij elkaar als ze elkaars niveau accepteren, minstens één speelduur gemeen hebben en er een club is waar niemand van het viertal "Niet" heeft gekozen. Daarna wordt op prijs gesorteerd.
- **Banen en prijzen**: vier clubs (Peakz Padel Assen, Valley Padel Assen, Plaza Sportz Assen, Padel Rolde), alleen dubbelbanen, met status "vrij / bezet / nog niet boekbaar (opent over X dagen)" en prijs per baan en per persoon.
- ATV De Hertenkamp is bewust weggelaten (buitenbanen, weer).

## Koppeling met de clubs

- **Live vrije banen** voor alle vier de clubs. De functie `netlify/functions/banen.mts` (`/api/banen?datum=…&slot=19:00-22:00`) haalt per begintijd (elk half uur binnen de gekozen tijd) de vrije **dubbelbanen** met prijs op:
  - Valley Padel Assen en Padel Rolde via RacketIQ;
  - Peakz Padel Assen via de openbare reserverings-API van Foys (ongeveer 4 weken vooruit);
  - Plaza Sportz Assen via de openbare clubpagina van KNLTB Meet & Play (3 weken vooruit). Dit leest de pagina uit zoals een browser dat doet, en kan dus stuk gaan als Meet & Play hun site verandert; de site valt dan terug op de boekknop.
  Antwoorden worden 10 minuten gecachet, in de functie en op de CDN van Netlify, zodat de clubs niet worden belast.
- De planner bekijkt de 8 beste momenten (waarop de meeste spelers kunnen) en zet momenten met een live vrije baan bovenaan. Daarna komen momenten met een club die je zelf moet controleren, en als laatste momenten waarop live alles vol is.
- Elke vrije tijd is een **boekknop**. Bij Valley en Rolde staan datum, tijd, speelduur en baan al ingevuld; bij Peakz en Plaza opent de boekingspagina van de club.
- Op het tabblad **Beheer clubs** vul je prijzen en boekingshorizon in; die worden gebruikt als een live koppeling even niet werkt. Met `BEHEER_CODE` scherm je dat af.

## Online zetten

Deze site gebruikt een Netlify-functie met Netlify Database (Postgres) om spelers en beschikbaarheid op te slaan. Netlify voert de migraties in `netlify/database/migrations` automatisch uit bij een deploy. Slepen van een map naar Netlify Drop is daarom niet genoeg. Gebruik een van deze twee manieren:

1. Zet de map in een GitHub-repository en koppel die aan een site in Netlify.
2. Of gebruik de Netlify CLI: `npm install`, `npx netlify login` en dan `npx netlify deploy --prod`.

Iedereen met de link kan de namen en antwoorden zien en invullen. Optioneel: stel `BEHEER_CODE` in om het wijzigen van clubgegevens af te schermen.

## Bestanden

- `public/index.html`: de pagina
- `src/auth.js`: inloggen, bij de build gebundeld naar `public/auth.js`
- `public/planner.js`: matching, boekingshorizon, prijzen (incl. daltarief)
- `public/clubs.json`: clubs, horizons en prijzen
- `netlify/functions/banen.mts`: live vrije banen (`/api/banen`)
- `netlify/functions/api.mts`: `/api/spelers` (ophalen), `/api/profiel` (vaste instellingen) `/api/beschikbaarheid` (één week) en `/api/clubs` (clubgegevens)
- `db/schema.ts`: tabellen `spelers`, `beschikbaarheid` en `club_gegevens`; na een wijziging `npx drizzle-kit generate --name <naam>`
- `netlify.toml`, `package.json`: instellingen

## Nog te bouwen

- Wekelijkse herinnering (zondagavond, dinsdag voor wie nog niet heeft gereageerd) via een geplande Netlify-functie.
- Melding op het moment dat de planning van een club voor een gewenste dag opent.
