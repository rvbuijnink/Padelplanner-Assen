// 06-nummers. Lezen gebeurt altijd via de beperkte databaserol "padel_lezer" met row level security:
// de database geeft alleen je eigen nummer en dat van bevestigde medespelers van een partij die jij hebt bevestigd,
// tot een dag na de partij (zie de migratie "beveilig_telefoons"). Lukt dat niet, dan worden er geen nummers getoond.
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { telefoons } from "../db/schema.js";

// Nederlands mobiel nummer: 06-12345678, +31 6 12345678 of 0031612345678. Opgeslagen als "0612345678".
export function leesTelefoon(x: unknown): string | null | undefined {
  if (x === null || x === undefined || (typeof x === "string" && !x.trim())) return null;
  if (typeof x !== "string") return undefined;
  const kaal = x.replace(/[\s\-().]/g, "");
  const m = /^(?:\+31|0031|0)6(\d{8})$/.exec(kaal);
  return m ? "06" + m[1] : undefined;
}
// Link voor "Stuur bericht via WhatsApp".
export const waLink = (nummer: string) => "https://wa.me/316" + nummer.slice(2);
export const toonNummer = (nummer: string) => "06-" + nummer.slice(2);

export async function slaTelefoonOp(spelerId: number, nummer: string | null) {
  if (!nummer) {
    await db.delete(telefoons).where(eq(telefoons.spelerId, spelerId));
    return;
  }
  await db
    .insert(telefoons)
    .values({ spelerId, nummer, bijgewerkt: new Date() })
    .onConflictDoUpdate({ target: telefoons.spelerId, set: { nummer, bijgewerkt: new Date() } });
}

// Alleen of iemand een nummer heeft (niet het nummer zelf): nodig om te mogen bevestigen.
export async function heeftTelefoon(spelerId: number) {
  const r = await db.select({ id: telefoons.spelerId }).from(telefoons).where(eq(telefoons.spelerId, spelerId));
  return r.length > 0;
}
export async function idsMetTelefoon() {
  return new Set((await db.select({ id: telefoons.spelerId }).from(telefoons)).map((r) => r.id));
}

const rijenVan = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);

// De nummers die deze speler mag zien, volgens de database (row level security).
export async function zichtbareTelefoons(spelerId: number): Promise<Map<number, string>> {
  try {
    const rijen = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role padel_lezer`);
      await tx.execute(sql`select set_config('padel.speler_id', ${String(spelerId)}, true)`);
      return rijenVan(await tx.execute(sql`select speler_id, nummer from telefoons`));
    });
    return new Map(rijen.map((r) => [Number(r.speler_id), String(r.nummer)]));
  } catch (e) {
    console.error("Nummers lezen via row level security mislukt; er worden geen nummers getoond.", e);
    return new Map();
  }
}
