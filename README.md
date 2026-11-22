# Padelplanner Assen

Een kleine Netlify-site waarmee een groep padelspelers hun niveau, gewenste tegenstanders, speelduur en beschikbaarheid doorgeeft. De planner zoekt daarna de beste momenten voor een viertal en laat zien welke club dan de goedkoopste vrije baan heeft.

## Wat zit erin

- **Inloggen met een account** (Netlify Identity): account maken met naam, e-mailadres en wachtwoord, inloggen, wachtwoord vergeten en uitnodigingen. Elke speler hoort bij één account en elke naam kan maar door één speler worden gebruikt; je kunt alleen je eigen instellingen en beschikbaarheid aanpassen. Spelers worden niet op naam aan een account gekoppeld, zodat niemand de plek van een ander kan overnemen.

- **Vaste instellingen** per speler (één keer invullen, altijd aan te passen): je naam, 06-nummer (verplicht), speelsterkte (7,0 t/m 10,0 in stapjes van 0,1), met welk niveau je wilt spelen (een range van–tot), speelduur (1 uur en/of 1,5 uur), hoe vaak je wilt spelen (wanneer het lukt / om de week / iedere week / 2x per week / 3x per week), hoeveel tijd je minimaal wilt tussen twee partijen, per club ja of nee (minstens één ja), of je bereid bent de baan te boeken, en of je e-mails en de zondagse herinnering wilt krijgen.
- **Beschikbaarheid per week**: per week invullen, voor de hele periode waarin je al een baan kunt reserveren. Er wordt 31 dagen vooruit gekeken, de langste termijn waarop een club banen openzet (Peakz). Of een club een dag al open heeft, komt live van de club. Er is geen deadline: per week zie je of hij ingevuld is of nog open staat, en je kunt het altijd aanpassen. De automatische planner kijkt even ver vooruit. Per dag kies je met een schuifbalk je begintijd en eindtijd (07:00–23:00, per half uur), en eventueel meerdere tijden op één dag. Handig: "Neem over van vorige ingevulde week" en "Ik kan deze week niet".
- **Standaardweek**: wie meestal op dezelfde momenten kan, vult één keer een standaardweek in. Die geldt automatisch voor elke week die de speler niet zelf invult (ook voor de automatische planner). Een afwijkende week pas je gewoon aan en sla je op.
- **Zo begin je**: nieuwe spelers zien bovenaan *Geplande partijen* een checklist (instellingen opslaan → beschikbaarheid invullen → wachten op een uitnodiging). Die verdwijnt zodra de eerste twee stappen klaar zijn.
- **Wie heeft ingevuld** (alleen beheerder): overzicht per speler per week.
- **Beste momenten** (alleen beheerder): zoekt momenten waarop minstens vier mensen kunnen die bij elkaar passen. Spelers passen bij elkaar als ze elkaars niveau accepteren, minstens één speelduur gemeen hebben en er een club is waar niemand van het viertal "Niet" heeft gekozen. Daarna wordt op prijs gesorteerd.
- **Banen en prijzen**: vijf clubs (Peakz Padel Assen, ATV De Hertenkamp, Valley Padel Assen, Plaza Sportz Assen en, als laatste keus, Padel Rolde), alleen dubbelbanen, met status "vrij / bezet / nog niet boekbaar (opent over X dagen)" en prijs per baan en per persoon.

## Partijen en e-mail

Alles draait om het begin van de partij (T).

- **Aanmelden:** account met e-mailadres en 06-nummer, plus niveau, speelduur, beschikbaarheid, per club ja of nee (minstens één ja) en of je bereid bent de baan te boeken. Het 06-nummer is verplicht: instellingen opslaan kan niet zonder, en spelers zonder 06-nummer worden niet ingepland of als vervanger gevraagd (anders kunnen ze niet bevestigen en loopt de partij vast). Een partij wordt alleen gepland als minstens één van de vier bereid is de baan te boeken.
- **Match (vanaf 7 dagen voor T):** elk uur van 08:00 tot en met 17:00 zoekt de site partijen die over minimaal 7 dagen plaatsvinden, tot 31 dagen vooruit (de langste termijn, Peakz). Clubs die een dag nog niet open hebben, slaat de live controle over. Elke ronde controleert de 4 beste momenten en daarna een deel van de rest dat elk uur opschuift, zodat in de loop van de dag alle momenten live worden bekeken: vier spelers die qua niveau, speelduur en tijd passen, een club die alle vier op ja hebben staan en waar live een baan vrij is. Clubkeuze: vrije baan → goedkoopste per persoon (live prijs) → bij gelijke prijs de club waar het langst geleden een partij was. Padel Rolde is de laatste keus: die wordt alleen gekozen als er bij geen andere club een baan vrij is, ook als Rolde goedkoper is. Geen vrije baan: niemand wordt uitgenodigd.
- **Boeken:** eerst krijgt één bereidwillige speler (met 06-nummer) een mail met club, tijd en bedrag per persoon (baanprijs / 4). Boekt die niet binnen 4 uur (klok loopt van 08:00 tot 22:00), of klikt die op *Ik kan niet boeken*, dan vraagt de site de volgende. Na *Baan is geboekt* (met Tikkie-link) gaan de uitnodigingen de deur uit.
- **Uitnodigen en bevestigen:** mail met club, tijd, bedrag per persoon, uiterste reactietijd als klokslag en *Ik doe mee* / *Ik kan niet*. Reactietijd 12 uur; tussen 22:00 en 08:00 loopt de klok niet en gaan er geen mails uit (ze wachten in een wachtrij tot 08:00). Wie bevestigt, ziet meteen de Tikkie. Zijn alle vier bevestigd, dan krijgt iedereen een "gaat door"-mail met medespelers, boeker en Tikkie.
- **Op de dag zelf:** een paar uur van tevoren (niet vóór 08:00) een herinnering met tijd, club, medespelers en de Tikkie als die nog openstaat.
- **Afzeggen:** *Ik kan niet meer* op de partijpagina zet de speler op afgemeld, mailt de medespelers en de boeker en toont hoeveel tijd er nog is om gratis te annuleren. Tot 72 uur voor T zoekt de site automatisch een vervanger (met de club op ja). Tussen 72 en 50 uur kiest de boeker *We zoeken een vervanger* of *Partij annuleren*; bevestigde spelers kunnen zelf iemand voorstellen. Om 50 uur vraagt de site de boeker te beslissen: annuleren of doorgaan met drie (bedrag gedeeld door 3). Na 48 uur kan er niet gratis meer worden geannuleerd.
- **Boeker zegt af:** de site wijst een andere bevestigde speler aan, die de baan moet overnemen (*Ik neem de baan over*). Annuleren en omboeken gebeuren bij de club zelf.

## 06-nummers en privacy

- Nummers staan in een aparte tabel `telefoons` met **row level security** in de database: de site leest ze als de beperkte rol `padel_lezer`, die alleen je eigen nummer ziet en dat van spelers die net als jij hebben bevestigd voor dezelfde (niet-geannuleerde) partij, tot het einde van de partij (begintijd plus speelduur). Daarna verdwijnen de nummers meteen.
- Nummers staan nooit in een e-mail, alleen op de partijpagina, met een knop *Stuur bericht via WhatsApp* (wa.me-link). Geen WhatsApp Business-koppeling.
- Je kunt je nummer altijd aanpassen bij Vaste instellingen (leegmaken kan niet, het nummer is verplicht). *Account verwijderen* wist je speler, beschikbaarheid, nummer en inlogaccount, en meldt je eerst netjes af voor komende partijen.

E-mail kan gratis via Gmail. Zet `SMTP_USER` op het Gmail-adres en `SMTP_PASS` op een app-wachtwoord van dat account (Google-account → Beveiliging → tweestapsverificatie aan → App-wachtwoorden). Je kunt ook Brevo gebruiken (`BREVO_API_KEY` + `MAIL_AFZENDER`) of Resend (`RESEND_API_KEY` + `MAIL_AFZENDER`). Zonder deze instellingen werkt alles wel, maar dan staan de uitnodigingen alleen op de site.

## Koppeling met de clubs

- **Live vrije banen** voor alle vijf de clubs. De functie `netlify/functions/banen.mts` (`/api/banen?datum=…&slot=19:00-22:00`) haalt per begintijd (elk half uur binnen de gekozen tijd) de vrije **dubbelbanen** met prijs op:
  - Valley Padel Assen en Padel Rolde via RacketIQ;
  - Peakz Padel Assen via de openbare reserverings-API van Foys (ongeveer 4 weken vooruit);
  - Plaza Sportz Assen (3 weken vooruit) en ATV De Hertenkamp (2 weken vooruit) via de openbare clubpagina van KNLTB Meet & Play. Dit leest de pagina uit zoals een browser dat doet, en kan dus stuk gaan als Meet & Play hun site verandert; de site valt dan terug op de boekknop.
  Antwoorden worden 10 minuten gecachet, in de functie en op de CDN van Netlify, zodat de clubs niet worden belast.
- *Beste momenten* (alleen beheerder) bekijkt de 8 beste momenten (waarop de meeste spelers kunnen), toont er 3 en zet momenten met een live vrije baan bovenaan. Daarna komen momenten met een club die je zelf moet controleren, en als laatste momenten waarop live alles vol is.
- Elke vrije tijd is een **boekknop**. Bij Valley en Rolde staan datum, tijd, speelduur en baan al ingevuld; bij Peakz en Plaza opent de boekingspagina van de club.
- Prijzen, vrije banen en boekingstermijnen komen altijd live uit de boekingssystemen van de clubs; er worden geen vaste prijzen of termijnen meer bijgehouden.
- **Boekingslink in de mail:** de boeker krijgt een knop die meteen op de goede plek uitkomt. Bij Valley en Rolde staan datum, begintijd en speelduur al ingevuld; bij Plaza en De Hertenkamp (Meet & Play) opent de juiste dag; bij Peakz opent de boekingspagina (daar kan de link geen datum meegeven).

## Online zetten

Deze site gebruikt een Netlify-functie met Netlify Database (Postgres) om spelers en beschikbaarheid op te slaan. Netlify voert de migraties in `netlify/database/migrations` automatisch uit bij een deploy. Slepen van een map naar Netlify Drop is daarom niet genoeg. Gebruik een van deze twee manieren:

1. Zet de map in een GitHub-repository en koppel die aan een site in Netlify.
2. Of gebruik de Netlify CLI: `npm install`, `npx netlify login` en dan `npx netlify deploy --prod`.

Alleen ingelogde spelers kunnen de site gebruiken; ze zien hun eigen gegevens en partijen, en van medespelers alleen wat nodig is. Stel `BEHEER_CODE` in (een lange, willekeurige code) voor de beheerweergaven: *Beste momenten*, *Wie heeft ingevuld?* en alle geplande partijen.

## Bestanden

- `public/index.html`: de pagina
- `src/auth.js`: inloggen, bij de build gebundeld naar `public/auth.js`
- `src/planner.cjs`: matching, boekingslinks per club. Bij de build wordt dit gebundeld naar `public/planner.js` en de server gebruikt het ook
- `lib/automatisch.ts`: partijen, uitnodigingen, reserves, boektaak en automatisch plannen
- `lib/mail.ts`: e-mail versturen (Gmail/SMTP, Brevo of Resend), met een wachtrij voor mails tussen 22:00 en 08:00
- `lib/telefoon.ts`: 06-nummers opslaan en lezen via row level security
- `netlify/functions/automatisch-plannen.mts`: draait elk uur; geeft verlopen uitnodigingen vrij, nodigt de volgende speler uit, stuurt de "gaat door"-mail en de herinnering op de dag zelf, en plant nieuwe potjes
- `netlify/functions/herinnering-beschikbaarheid.mts`: draait op zondagavond; herinnert spelers aan open weken
- `public/clubs.json`: vaste gegevens per club (naam, boekingspagina, annuleervoorwaarden); prijzen en vrije banen komen live
- `netlify/functions/banen.mts`: live vrije banen (`/api/banen`)
- `netlify/functions/api.mts`: `/api/spelers` (ophalen), `/api/profiel` (vaste instellingen), `/api/beschikbaarheid` (één week), `/api/standaardweek`, `/api/partijen` (geplande partijen en acties zoals bevestigen, afzeggen en geboekt), `/api/antwoord` en `/api/agenda` (links uit de e-mail), `/api/overzicht` (beheer) en `/api/account` (account verwijderen)
- `db/schema.ts`: tabellen `spelers`, `beschikbaarheid`, `club_gegevens`, `partijen`, `partij_deelnemers`, `telefoons` en `mail_wachtrij`; na een wijziging `npx drizzle-kit generate --name <naam>`
- `netlify.toml`, `package.json`: instellingen

## Nog te bouwen

- Melding op het moment dat de planning van een club voor een gewenste dag opent.
