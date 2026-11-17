import { pgTable, serial, text, timestamp, integer, jsonb, primaryKey, date, boolean, doublePrecision } from "drizzle-orm/pg-core";

// Vaste instellingen per speler: past je zelden aan.
export const spelers = pgTable("spelers", {
  id: serial().primaryKey(),
  slug: text().notNull().unique(),
  // Netlify Identity-account van de speler. Leeg bij spelers van vóór het inloggen; die worden
  // gekoppeld zodra iemand met dezelfde naam inlogt en zijn instellingen opslaat.
  userId: text("user_id").unique(),
  naam: text().notNull(),
  niveau: text().notNull(),
  wensNiveaus: jsonb("wens_niveaus").$type<string[]>().notNull(),
  duren: jsonb().$type<string[]>().notNull(),
  frequentie: text().notNull(),
  // clubId -> "graag" | "prima" | "niet"
  clubVoorkeur: jsonb("club_voorkeur").$type<Record<string, string>>().notNull().default({}),
  // E-mailadres van het account (overgenomen bij inloggen) en of de speler e-mails wil krijgen.
  email: text(),
  mailAan: boolean("mail_aan").notNull().default(true),
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
  aangemaakt: timestamp("aangemaakt", { withTimezone: true }).notNull().defaultNow(),
});

// Wie zich voor een partij heeft opgegeven. De eerste vier spelen, de rest is reserve.
export const partijDeelnemers = pgTable(
  "partij_deelnemers",
  {
    partijId: integer("partij_id").notNull().references(() => partijen.id, { onDelete: "cascade" }),
    spelerId: integer("speler_id").notNull().references(() => spelers.id, { onDelete: "cascade" }),
    aangemeld: timestamp("aangemeld", { withTimezone: true }).notNull().defaultNow(),
    // "uitgenodigd" (wacht op antwoord), "bevestigd", "afgezegd" of "verlopen" (niet op tijd gereageerd).
    status: text().notNull().default("bevestigd"),
    // Geheime sleutel voor de knoppen in de e-mail (bevestigen zonder inloggen).
    token: text().unique(),
    uitgenodigd: timestamp("uitgenodigd", { withTimezone: true }),
    herinnerd: boolean().notNull().default(false),
    // Of deze speler zijn deel van de baan heeft betaald aan wie boekte.
    betaald: boolean().notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.partijId, t.spelerId] })]
);
