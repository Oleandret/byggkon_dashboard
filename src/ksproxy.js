import crypto from "crypto";
import { Readable } from "stream";
import { getConfig } from "./settings.js";

// KS-systemet er en egen app på sin egen Railway-tjeneste. Den vises som fane
// her, og må da ligge på samme opphav som dashboardet: *.up.railway.app står på
// Public Suffix List, så et direkte iframe til det andre vertsnavnet ville fått
// sesjonscookien blokkert. Derfor speiler vi KS under /ks i stedet.
export const KS_PREFIX = "/ks";

// Hopp over hop-by-hop-felt og alt vi setter selv. Klientens egen
// x-forwarded-prefix fjernes med vilje, slik at den ikke kan dikteres utenfra.
const DROPP_INN = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
  "x-forwarded-prefix", "x-ks-identitet",
]);
// fetch pakker ut komprimerte svar, så lengde og koding fra KS stemmer ikke lenger.
// set-cookie slippes heller ikke gjennom: identiteten signeres på nytt for hver
// forespørsel, så KS trenger ingen egen cookie her — og da kan ingen KS-sesjon
// bli liggende igjen i nettleseren etter at dashboardet er logget ut.
const DROPP_UT = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive",
  "set-cookie",
]);

const MAKS_KROPP = 25 * 1024 * 1024;

// Eksportert slik at formatet kan testes mot KS sin lesIdentitet.
export function signerIdentitet(identitet, hemmelighet) {
  const kropp = Buffer.from(JSON.stringify({ ...identitet, utstedt: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", hemmelighet).update(kropp).digest("base64url");
  return `${kropp}.${sig}`;
}

export function ksOppsett() {
  const c = getConfig();
  return {
    url: String(c.ksUrl || "").trim().replace(/\/+$/, ""),
    hemmelighet: String(c.ksSsoSecret || ""),
  };
}

export const ksKlar = () => {
  const { url, hemmelighet } = ksOppsett();
  return Boolean(url && hemmelighet);
};

function lesKropp(req) {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const biter = [];
    let lengde = 0;
    req.on("data", (bit) => {
      lengde += bit.length;
      if (lengde > MAKS_KROPP) {
        req.destroy();
        reject(new Error("For stor forespørsel"));
        return;
      }
      biter.push(bit);
    });
    req.on("end", () => resolve(biter.length ? Buffer.concat(biter) : undefined));
    req.on("error", reject);
  });
}

export async function ksProxy(req, res) {
  const { url, hemmelighet } = ksOppsett();
  if (!url || !hemmelighet) {
    return res.status(503).send("KS-systemet er ikke konfigurert. Sett KS_URL og KS_SSO_SECRET.");
  }

  // req.url er relativ til mountet, altså uten /ks.
  const mål = `${url}${req.url === "/" ? "/" : req.url}`;
  const headers = {};
  for (const [navn, verdi] of Object.entries(req.headers)) {
    if (!DROPP_INN.has(navn) && verdi !== undefined) headers[navn] = verdi;
  }
  headers["x-forwarded-prefix"] = KS_PREFIX;
  headers["x-ks-identitet"] = signerIdentitet(
    {
      epost: req.session?.user?.email || "",
      navn: req.session?.user?.name || "",
      stilling: req.session?.user?.jobTitle || "",
    },
    hemmelighet,
  );

  let kropp;
  try {
    kropp = await lesKropp(req);
  } catch {
    return res.status(413).send("Filen er for stor.");
  }

  let svar;
  try {
    svar = await fetch(mål, {
      method: req.method,
      headers,
      body: kropp,
      // KS sender 302 til /ks/... som nettleseren skal følge selv; følger vi
      // dem her, mister brukeren adressen sin.
      redirect: "manual",
    });
  } catch (err) {
    console.error("KS-proxy feilet:", err.message);
    return res.status(502).send("Fikk ikke kontakt med KS-systemet.");
  }

  res.status(svar.status);
  svar.headers.forEach((verdi, navn) => {
    if (!DROPP_UT.has(navn.toLowerCase())) res.setHeader(navn, verdi);
  });
  if (!svar.body) return res.end();
  Readable.fromWeb(svar.body).pipe(res);
}
