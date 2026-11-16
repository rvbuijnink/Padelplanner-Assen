import { pgTable, serial, text, timestamp, integer, jsonb, primaryKey, date, boolean, doublePrecision } from "drizzle-orm/pg-core";

// Vaste instellingen per speler: past je zelden aan.
export const spelers = pgTable("spelers", {
  id: serial().primaryKey(),
  slug: text().notNull().unique(),
  naam: text().notNull(),
  niveau: text().notNull(),
  wensNiveaus: jsonb("wens_niveaus").$type<string[]>().notNull(),
  duren: jsonb().$type<string[]>().notNull(),
  frequentie: text().notNull(),
  // clubId -> "graag" | "prima" | "niet"
  clubVoorkeur: jsonb("club_voorkeur").$type<Record<string, string>>().notNull().default({}),
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
