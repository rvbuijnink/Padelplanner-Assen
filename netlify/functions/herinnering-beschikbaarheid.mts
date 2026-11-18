// Elke zondagavond: spelers die voor de komende weken nog geen beschikbaarheid hebben ingevuld krijgen een herinnering.
import { herinnerBeschikbaarheid } from "../../lib/automatisch.js";

export default async () => {
  await herinnerBeschikbaarheid();
};

// 18:00 UTC = 19:00 (winter) of 20:00 (zomer) Nederlandse tijd.
export const config = { schedule: "0 18 * * 0" };
