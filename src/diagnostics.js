// Tilkoblingstest mot Tripletex. Kjøres fra admin-siden, går ett steg om gangen
// og stopper ved første feil, slik at svaret peker på hvor det faktisk klikker
// – ikke bare at "noe" er galt.
import { getConfig } from "./settings.js";
import { apiGet, credentialKind, resetSession, whoAmI } from "./tripletexApi.js";

function short(value, max = 500) {
  return String(value ?? "").slice(0, max);
}

// Tripletex sine *To-datoer er eksklusive, så "til og med i dag" betyr i morgen.
// Testen går utenom datalaget for å holde uttrekkene små, og må derfor gjøre
// den samme omregningen selv.
function ymdOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
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
      const cred = credentialKind();
      if (cred.kind === "none") throw new Error("Ingen Tripletex-nøkkel er satt.");
      const miljø =
        config.tripletexEnv === "test"
          ? "testmiljøet (api-test.tripletex.tech)"
          : "produksjon (tripletex.no)";
      if (cred.kind === "refresh") {
        return `Refresh token (tlxr_…) fra Selskap → API-tokens. Kaller ${miljø}.`;
      }
      return (
        `Verdien tolkes som et employee token${cred.consumerToken ? " med consumer token" : " uten consumer token"}. ` +
        `Kaller ${miljø}.`
      );
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
      const data = await apiGet("/timesheet/entry", {
        dateFrom: ymdOffset(-30),
        dateTo: ymdOffset(1),
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
      const data = await apiGet("/balanceSheet", {
        dateFrom: `${new Date().getFullYear()}-01-01`,
        dateTo: ymdOffset(1),
        accountNumberFrom: 3000,
        accountNumberTo: 4000, // eksklusiv, så dette dekker 3000–3999
        from: 0,
        count: 1,
      });
      const total = data?.fullResultSize ?? (data?.values || []).length;
      return `Saldobalansen svarer (${total} inntektskontoer med bevegelse i år).`;
    }
  );

  // Kryssjekk: omsetning hittil i år fra hovedboken mot summen av utgående
  // fakturaer eks. mva i samme periode. De skal ikke stemme eksakt – periodisering,
  // manuelle bilag og kreditnotaer gjør forskjell – men er avviket stort, er noe
  // galt med selve uttrekket. Det var slik den eksklusive dateTo-en ga for lav
  // omsetning uten at noe så ut til å feile.
  await step(
    "Kryssjekk omsetning",
    "Stort avvik betyr som regel at en periode eller et kontointervall er feil avgrenset – ikke at regnskapet er feil.",
    async () => {
      const yearStart = `${new Date().getFullYear()}-01-01`;
      const tomorrow = ymdOffset(1);
      const [ledger, invoices] = await Promise.all([
        apiGet("/balanceSheet", {
          dateFrom: yearStart,
          dateTo: tomorrow,
          accountNumberFrom: 3000,
          accountNumberTo: 4000,
          from: 0,
          count: 1000,
          fields: "account(id,number),balanceChange",
        }),
        apiGet("/invoice", {
          invoiceDateFrom: yearStart,
          invoiceDateTo: tomorrow,
          from: 0,
          count: 1000,
          fields: "id,amountExcludingVat",
        }),
      ]);
      const fromLedger = (ledger?.values || []).reduce((s, r) => s + -(r.balanceChange || 0), 0);
      const invoiceRows = invoices?.values || [];
      const fromInvoices = invoiceRows.reduce((s, i) => s + (i.amountExcludingVat || 0), 0);
      const nok = (n) => Math.round(n).toLocaleString("nb-NO");
      const truncated = (invoices?.fullResultSize ?? invoiceRows.length) > invoiceRows.length;
      const diff = fromLedger === 0 ? 1 : Math.abs(fromLedger - fromInvoices) / Math.abs(fromLedger);
      const note = truncated ? " (fakturasummen er basert på de første 1000 fakturaene)" : "";
      return (
        `Hovedbok (3000–3999): ${nok(fromLedger)} kr. Fakturert eks. mva: ${nok(fromInvoices)} kr. ` +
        `Avvik ${Math.round(diff * 100)} %${note}.`
      );
    }
  );

  // Grunnlaget bak faktureringsgraden, så tallet kan holdes opp mot Tripletex
  // sin egen timerapport for samme periode i stedet for å måtte tros på.
  await step(
    "Kryssjekk faktureringsgrad",
    "Stemmer ikke timene med Tripletex, er det perioden eller hvem som telles med som avviker – ikke selve timeføringen.",
    async () => {
      const data = await apiGet("/timesheet/entry", {
        dateFrom: ymdOffset(-28),
        dateTo: ymdOffset(1),
        from: 0,
        count: 1000,
        fields: "id,hours,chargeableHours,employee(id)",
      });
      const rows = data?.values || [];
      const hours = rows.reduce((s, r) => s + (r.hours || 0), 0);
      const billable = rows.reduce((s, r) => s + (r.chargeableHours || 0), 0);
      const people = new Set(rows.map((r) => r.employee?.id).filter((x) => x != null)).size;
      const rate = hours > 0 ? Math.round((billable / hours) * 100) : 0;
      const truncated = (data?.fullResultSize ?? rows.length) > rows.length;
      const nb = (n) => n.toLocaleString("nb-NO", { maximumFractionDigits: 1 });
      return (
        `Siste 4 uker: ${nb(billable)} fakturerbare av ${nb(hours)} førte timer = ${rate} %, ` +
        `fordelt på ${people} ansatte.` +
        (truncated ? " Merk: bare de første 1000 timeføringene er med i denne kontrollen." : "")
      );
    }
  );

  return { ok: !failed, checkedAt: new Date().toISOString(), steps };
}
