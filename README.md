# Padelplanner Assen

Een kleine Netlify-site waarmee een groep padelspelers hun niveau, gewenste tegenstanders, speelduur en beschikbaarheid doorgeeft. De planner zoekt daarna de beste momenten voor een viertal en laat zien welke club dan de goedkoopste vrije baan heeft.

## Wat zit erin

- **Inloggen met een account** (Netlify Identity): account maken met naam, e-mailadres en wachtwoord, inloggen, wachtwoord vergeten en uitnodigingen. Elke speler hoort bij één account; je kunt alleen je eigen instellingen en beschikbaarheid aanpassen. Spelers van vóór het inloggen worden gekoppeld zodra iemand met dezelfde naam inlogt en zijn instellingen opslaat.

- **Vaste instellingen** per speler (één keer invullen, altijd aan te passen): je naam, speelsterkte (8–8,5 / 8,5–9 / 9–9,5 / 9,5–10), met welk niveau je wilt spelen, speelduur (1 uur en/of 1,5 uur), hoe vaak je wilt spelen (wanneer het lukt / om de week / iedere week / 2x per week) en per club of je er wel of niet wilt spelen.
- **Beschikbaarheid per week**: per week invullen, voor de hele periode waarin je al een baan kunt reserveren. Het aantal weken volgt de langste boekingshorizon van de clubs (Peakz: 28 dagen, dus ongeveer een maand; hooguit 6 weken). Er is geen deadline: per week zie je of hij ingevuld is of nog open staat, en je kunt het altijd aanpassen. De automatische planner kijkt even ver vooruit. Per dag kies je met een schuifbalk je begintijd en eindtijd (07:00–23:00, per half uur), en eventueel meerdere tijden op één dag. Handig: "Neem over van vorige ingevulde week" en "Ik kan deze week niet".
- **Wie heeft ingevuld**: overzicht per speler per week.
- **Planner**: zoekt momenten waarop minstens vier mensen kunnen die bij elkaar passen. Spelers passen bij elkaar als ze elkaars niveau accepteren, minstens één speelduur gemeen hebben en er een club is waar niemand van het viertal "Niet" heeft gekozen. Daarna wordt op prijs gesorteerd.
- **Banen en prijzen**: vier clubs (Peakz Padel Assen, Valley Padel Assen, Plaza Sportz Assen, Padel Rolde), alleen dubbelbanen, met status "vrij / bezet / nog niet boekbaar (opent over X dagen)" en prijs per baan en per persoon.
- ATV De Hertenkamp is bewust weggelaten (buitenbanen, weer).

## Partijen en e-mail

- **Automatisch plannen:** de site wacht niet tot iedereen heeft ingevuld; zodra vier passende spelers op hetzelfde moment kunnen én er bij een club live een baan vrij is, plant de site een potje en krijgen zij een uitnodiging per e-mail (zonder herinneringen). Spelers zien bij Geplande potjes alleen hun eigen potjes; de beheerder (met beheercode) ziet alle potjes. Dat gebeurt op basis van beschikbaarheid, niveau, speelduur en clubvoorkeur. De site houdt ook rekening met hoe vaak iemand wil spelen: 1x per week, 2x per week of om de week. Wie minder speelde of vaker reserve was, krijgt voorrang. Er wordt alleen gepland als er live een baan vrij is (is een club even niet bereikbaar, dan probeert de site het een uur later opnieuw); bij meerdere vrije banen wint de goedkoopste. Wie ook kan maar niet is ingedeeld, komt op de reservelijst.
- **Zelf maken:** met *Maak partij* bij een moment in Planning maak je zelf een partij.
- **Bevestigen:** uitgenodigde spelers hebben 24 uur, op de site of via de knoppen in de e-mail. Wie afzegt of niet reageert, wordt vervangen door de eerste reserve. Partijen met een open plek staan onder *Nog 1 speler nodig*, voor spelers met een passend niveau.
- **Boeken:** als er vier spelers zijn, krijgt degene die het langst niet heeft geboekt de boektaak. Boekt die niet binnen 4 uur nadat boeken kan, dan gaat de taak naar een ander. Na *Baan geboekt*, met baannummer, prijs en eventueel een Tikkie-link, ziet iedereen het bedrag per persoon. Is de baan weg, dan toont de site andere vrije tijden en clubs op dezelfde dag.

E-mail kan gratis via Gmail. Zet `SMTP_USER` op het Gmail-adres en `SMTP_PASS` op een app-wachtwoord van dat account (Google-account → Beveiliging → tweestapsverificatie aan → App-wachtwoorden). Je kunt ook Brevo gebruiken (`BREVO_API_KEY` + `MAIL_AFZENDER`) of Resend (`RESEND_API_KEY` + `MAIL_AFZENDER`). Zonder deze instellingen werkt alles wel, maar dan staan de uitnodigingen alleen op de site.

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
- `src/planner.cjs`: matching, boekingshorizon, prijzen (incl. daltarief). Bij de build wordt dit gebundeld naar `public/planner.js` en de server gebruikt het ook
- `lib/automatisch.ts`: partijen, uitnodigingen, reserves, boektaak en automatisch plannen
- `lib/mail.ts`: e-mail versturen (Gmail/SMTP, Brevo of Resend)
- `netlify/functions/automatisch-plannen.mts`: draait elk uur; geeft verlopen uitnodigingen vrij, nodigt de volgende speler uit, stuurt de "gaat door"-mail en plant nieuwe potjes
- `public/clubs.json`: clubs, horizons en prijzen
- `netlify/functions/banen.mts`: live vrije banen (`/api/banen`)
- `netlify/functions/api.mts`: `/api/spelers` (ophalen), `/api/profiel` (vaste instellingen) `/api/beschikbaarheid` (één week) en `/api/clubs` (clubgegevens)
- `db/schema.ts`: tabellen `spelers`, `beschikbaarheid`, `club_gegevens`, `partijen` en `partij_deelnemers`; na een wijziging `npx drizzle-kit generate --name <naam>`
- `netlify.toml`, `package.json`: instellingen

## Nog te bouwen

- Melding op het moment dat de planning van een club voor een gewenste dag opent.
