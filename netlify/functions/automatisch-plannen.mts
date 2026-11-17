// Elk uur: verlopen uitnodigingen vrijgeven, partijen aanvullen met de volgende speler die kan,
// "gaat door"-mails sturen en nieuwe partijen zoeken zodra vier passende spelers op hetzelfde moment kunnen.
import { automatischPlannen } from "../../lib/automatisch.js";

export default async () => {
  await automatischPlannen();
};

export const config = { schedule: "7 * * * *" };
