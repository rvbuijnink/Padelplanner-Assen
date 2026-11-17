// Elk uur: verlopen uitnodigingen vrijgeven, herinneringen sturen, potjes aanvullen met de volgende
// speler die kan, "gaat door"-mails sturen en nieuwe potjes zoeken voor weken waarvan de invuldeadline voorbij is.
import { automatischPlannen } from "../../lib/automatisch.js";

export default async () => {
  await automatischPlannen();
};

export const config = { schedule: "7 * * * *" };
