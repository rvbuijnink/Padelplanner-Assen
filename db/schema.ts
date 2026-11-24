import { pgTable, serial, text, timestamp, integer, jsonb, primaryKey, date, boolean, doublePrecision } from "drizzle-orm/pg-core";

// Vaste instellingen per speler: past je zelden aan.
export const spelers = pgTable("spelers", {
  id: serial().primaryKey(),
  slug: text().notNull().unique(),
  // Netlify Identity-account van de speler. Leeg bij spelers van vóór het inloggen; die worden
  // gekoppeld zodra iemand met dezelfde naam inlogt en zijn instellingen opslaat.
  userId: text("user_id").unique(),
  naam: text().notNull(),
  // Gastspeler: alleen een naam, door de beheerder aan een partij toegevoegd. Geen account, e-mail, 06-nummer
  // of speelsterkte; wordt nooit automatisch ingepland of als boeker gekozen.
  gast: boolean().notNull().default(false),
  niveau: text().notNull(),
  wensNiveaus: jsonb("wens_niveaus").$type<string[]>().notNull(),
  duren: jsonb().$type<string[]>().notNull(),
  frequentie: text().notNull(),
  // Minimaal aantal vrije dagen tussen twee partijen: 0 (maakt niet uit, wel nooit twee op één dag), 1 of 2.
  rustDagen: integer("rust_dagen").notNull().default(0),
  // clubId -> "graag" | "prima" | "niet"
  clubVoorkeur: jsonb("club_voorkeur").$type<Record<string, string>>().notNull().default({}),
  // E-mailadres van het account (overgenomen bij inloggen) en of de speler e-mails wil krijgen.
  email: text(),
  mailAan: boolean("mail_aan").notNull().default(true),
  // Of de speler op zondagavond een herinnering wil als er nog weken zonder beschikbaarheid zijn.
  herinneringAan: boolean("herinnering_aan").notNull().default(true),
  // Of de speler bereid is de baan te boeken (en een Tikkie te maken).
  boekBereid: boolean("boek_bereid").notNull().default(true),
  // Standaardweek: weekdag ("0" = maandag … "6" = zondag) -> tijden "UU:MM-UU:MM".
  // Geldt voor elke week die de speler niet zelf heeft ingevuld. Leeg = geen standaardweek.
  standaardWeek: jsonb("standaard_week").$type<Record<string, string[]>>(),
  bijgewerkt: timestamp("bijgewerkt", { withTimezone: true }).notNull().defaultNow(),
});

// Beschikbaarheid per speler per week (week = datum van de maandag).
// Een rij met lege tijdvakken betekent: ingevuld, maar kan die week niet.
export const beschikbaarheid = pgTable(
  "beschikbaarheid",
  {
    spelerId: integer("speler_id").notNull().references(() => spelers.id, { onDelete: "cascade" }),
    week: date().notNull(),
    // datum (YYYY-MM-DD) -> lijst van tijden "UU:MM-UU:MM" (oudere rijen kunnen nog dagdeel-id's bevatten)
    tijdvakken: jsonb().$type<Record<string, string[]>>().notNull(),
    bijgewerkt: timestamp("bijgewerkt", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spelerId, t.week] })]
);

// Echte clubgegevens die de beheerder invult. Overschrijft de standaardwaarden uit public/clubs.json.
export const clubGegevens = pgTable("club_gegevens", {
  clubId: text("club_id").primaryKey(),
  prijs60: doublePrecision("prijs_60"),
  prijs90: doublePrecision("prijs_90"),
  dalPrijs60: doublePrecision("dal_prijs_60"),
  dalPrijs90: doublePrecision("dal_prijs_90"),
  horizonDagen: integer("horizon_dagen").notNull(),
  horizonBevestigd: boolean("horizon_bevestigd").notNull().default(false),
  opentOm: text("opent_om"),
  opmerking: text().notNull().default(""),
  bijgewerkt: timestamp("bijgewerkt", { withTimezone: true }).notNull().defaultNow(),
});

// Geplande partijen: een speler zet een moment en club vast, anderen geven zich op.
export const partijen = pgTable("partijen", {
  id: serial().primaryKey(),
  datum: date().notNull(),
  // starttijd "UU:MM"
  tijd: text().notNull(),
  // speelduur in minuten: 60 of 90
  duur: integer().notNull(),
  clubId: text("club_id").notNull(),
  opmerking: text().notNull().default(""),
  aangemaaktDoor: integer("aangemaakt_door").references(() => spelers.id, { onDelete: "set null" }),
  // Automatisch aanvullen: de site nodigt passende spelers per e-mail uit tot er vier hebben bevestigd.
  automatisch: boolean().notNull().default(false),
  // Wie de baan boekt (gekozen zodra vier spelers hebben bevestigd).
  boekerId: integer("boeker_id").references(() => spelers.id, { onDelete: "set null" }),
  // Of de "gaat door"-mail al is verstuurd voor de huidige vier spelers.
  compleetGemeld: boolean("compleet_gemeld").notNull().default(false),
  // Of de baan echt geboekt is (aangevinkt door wie boekt of door de beheerder).
  geboekt: boolean().notNull().default(false),
  // Betaallink (bijv. een Tikkie) die wie boekt deelt met de andere spelers.
  betaallink: text(),
  // Of de herinnering op de dag van de partij al is verstuurd.
  dagHerinnerd: boolean("dag_herinnerd").notNull().default(false),
  // Geannuleerd: er konden niet genoeg spelers en er was geen vervanger. De partij blijft bewaard,
  // zodat wie afzegde of niet reageerde die dag niet opnieuw wordt ingepland.
  geannuleerd: boolean().notNull().default(false),
  // Uiterste moment waarop de aangewezen boeker de baan moet boeken; daarna wijst de site de volgende bereidwillige speler aan.
  boekenTot: timestamp("boeken_tot", { withTimezone: true }),
  // Prijs van de baan (uit de live koppeling bij het plannen); het bedrag per persoon is dit gedeeld door 4.
  baanPrijs: doublePrecision("baan_prijs"),
  // Spelers die het boeken hebben laten lopen of hebben doorgegeven: die worden niet opnieuw als boeker gevraagd.
  afgewezenBoekers: jsonb("afgewezen_boekers").$type<number[]>().notNull().default([]),
  // Keuze van de boeker als er tussen 72 en 50 uur voor aanvang een speler ontbreekt: "zoeken" of "drie" (doorgaan met drie).
  besluit: text(),
  // Of de boeker al gevraagd is te kiezen (72 uur) en te beslissen (50 uur).
  keuzeGemeld: boolean("keuze_gemeld").notNull().default(false),
  beslisGemeld: boolean("beslis_gemeld").notNull().default(false),
  // De boeker zei af: een andere speler is aangewezen en moet de baan nog overnemen van de vorige boeker.
  overnameNodig: boolean("overname_nodig").notNull().default(false),
  vorigeBoekerId: integer("vorige_boeker_id").references(() => spelers.id, { onDelete: "set null" }),
  aangemaakt: timestamp("aangemaakt", { withTimezone: true }).notNull().defaultNow(),
});

// Wie zich voor een partij heeft opgegeven. De eerste vier spelen, de rest is reserve.
export const partijDeelnemers = pgTable(
  "partij_deelnemers",
  {
    partijId: integer("partij_id").notNull().references(() => partijen.id, { onDelete: "cascade" }),
    spelerId: integer("speler_id").notNull().references(() => spelers.id, { onDelete: "cascade" }),
    aangemeld: timestamp("aangemeld", { withTimezone: true }).notNull().defaultNow(),
    // "gepland" (gekozen, wacht tot de baan geboekt is; nog niet uitgenodigd), "uitgenodigd" (wacht op antwoord), "bevestigd", "afgezegd", "verlopen" (niet op tijd gereageerd)
    // of "geannuleerd" (de partij ging niet door; deze speler kan die dag gewoon opnieuw worden ingepland).
    // of "verwijderd" (door de beheerder eruit gehaald; niet opnieuw voor deze partij uitgenodigd, die dag wel elders in te plannen).
    status: text().notNull().default("bevestigd"),
    // Geheime sleutel voor de knoppen in de e-mail (bevestigen zonder inloggen).
    token: text().unique(),
    uitgenodigd: timestamp("uitgenodigd", { withTimezone: true }),
    // Uiterste reactietijd. De klok loopt niet tussen 22:00 en 08:00.
    reactieTot: timestamp("reactie_tot", { withTimezone: true }),
    herinnerd: boolean().notNull().default(false),
    // Of deze speler zijn deel van de baan heeft betaald aan wie boekte.
    betaald: boolean().notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.partijId, t.spelerId] })]
);

// 06-nummers staan los van de spelers, met row level security in de database:
// een speler ziet alleen zijn eigen nummer en dat van bevestigde medespelers van een partij die hij zelf heeft bevestigd,
// tot een dag na de partij. Zie de migratie "beveilig_telefoons". Nummers komen nooit in een e-mail.
export const telefoons = pgTable("telefoons", {
  spelerId: integer("speler_id").primaryKey().references(() => spelers.id, { onDelete: "cascade" }),
  nummer: text().notNull(),
  bijgewerkt: timestamp("bijgewerkt", { withTimezone: true }).notNull().defaultNow(),
});

// Tussen 22:00 en 08:00 gaan er geen e-mails uit: die wachten hier tot de ochtend.
export const mailWachtrij = pgTable("mail_wachtrij", {
  id: serial().primaryKey(),
  mail: jsonb().notNull(),
  aangemaakt: timestamp("aangemaakt", { withTimezone: true }).notNull().defaultNow(),
});
