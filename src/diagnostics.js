// Tilkoblingstest mot Tripletex. Kjøres fra admin-siden, går ett steg om gangen
// og stopper ved første feil, slik at svaret peker på hvor det faktisk klikker
// – ikke bare at "noe" er galt.
import { getConfig } from "./settings.js";
import { apiGet, hasCredentials, resetSession, whoAmI } from "./tripletexApi.js";

function short(value, max = 500) {
  return String(value ?? "").slice(0, max);
}

export async function runConnectionTests() {
  const steps = [];
  let failed = false;

  async function step(name, hint, fn) {
    if (failed) {
      steps.push({ name, status: "skipped", detail: "Ikke kjørt – et tidligere steg feilet." });
      return null;
    }
    const startedAt = Date.now();
    try {
      const result = await fn();
      steps.push({ name, status: "ok", detail: short(result || "OK"), ms: Date.now() - startedAt });
      return result;
    } catch (err) {
      failed = true;
      steps.push({
        name,
        status: "error",
        detail: short(err?.message || err),
        hint,
        ms: Date.now() - startedAt,
      });
      return null;
    }
  }

  const config = getConfig();

  await step(
    "Nøkkel",
    "Sett TRIPLETEX_JWT i Railway. Nøkkelen lages i Tripletex under Selskap → API-tokens av en bruker med admin-rettigheter.",
    () => {
      if (!hasCredentials()) throw new Error("Ingen Tripletex-nøkkel er satt.");
      const miljø = config.tripletexEnv === "test" ? "testmiljøet (api-test.tripletex.tech)" : "produksjon (tripletex.no)";
      return config.tripletexJwt
        ? `TRIPLETEX_JWT er satt. Kaller ${miljø}.`
        : `Consumer- og employee-token er satt. Kaller ${miljø}.`;
    }
  );

  await step(
    "Innlogging",
    "Les Tripletex sin egen forklaring over – den peker som regel rett på hva som er galt.",
    async () => {
      resetSession(); // tving en fersk innlogging, ellers tester vi en gammel
      const me = await whoAmI();
      const v = me?.value || me || {};
      const who = [
        v.companyName || v.company?.name || (v.companyId ? `selskap ${v.companyId}` : ""),
        v.employeeName || v.employee?.name || v.firstName,
      ]
        .filter(Boolean)
        .join(" · ");
      return who ? `Pålogget: ${who}` : "Pålogget Tripletex.";
    }
  );

  await step(
    "Prosjekter",
    "Innloggingen virker, men prosjektdata kommer ikke ut. Sjekk rettighetene til brukeren nøkkelen ble laget for.",
    async () => {
      const data = await apiGet("/project", {
        isClosed: false,
        from: 0,
        count: 1,
        fields: "id,number,name,customer(id,name)",
      });
      const values = data?.values;
      if (!Array.isArray(values)) throw new Error("Uventet svar – fant ingen 'values'-liste.");
      const total = data.fullResultSize ?? values.length;
      if (!values.length) return `Ingen aktive prosjekter i Tripletex (${total} totalt).`;
      return `${total} aktive prosjekter. Første: ${values[0].number || "?"} ${values[0].name || ""}`.trim();
    }
  );

  await step(
    "Timer",
    "Prosjekter kommer ut, men ikke timeføringer. Sjekk at brukeren har tilgang til timelistene.",
    async () => {
      const today = new Date();
      const from = new Date(today);
      from.setDate(from.getDate() - 30);
      const data = await apiGet("/timesheet/entry", {
        dateFrom: from.toISOString().slice(0, 10),
        dateTo: today.toISOString().slice(0, 10),
        from: 0,
        count: 1,
        fields: "id,date,hours,employee(id,firstName,lastName)",
      });
      const total = data?.fullResultSize ?? (data?.values || []).length;
      return `${total} timeføringer siste 30 dager.`;
    }
  );

  await step(
    "Regnskap",
    "Saldobalansen svarer ikke. Økonomi-fanen vil være tom. Sjekk at brukeren har tilgang til regnskapet.",
    async () => {
      const today = new Date();
      const janFirst = new Date(today.getFullYear(), 0, 1);
      const data = await apiGet("/balanceSheet", {
        dateFrom: janFirst.toISOString().slice(0, 10),
        dateTo: today.toISOString().slice(0, 10),
        accountNumberFrom: 3000,
        accountNumberTo: 3999,
        from: 0,
        count: 1,
      });
      const total = data?.fullResultSize ?? (data?.values || []).length;
      return `Saldobalansen svarer (${total} inntektskontoer med bevegelse i år).`;
    }
  );

  return { ok: !failed, checkedAt: new Date().toISOString(), steps };
}
