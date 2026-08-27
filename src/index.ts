/**
 * Worker « Jurisprudence canadienne et greffes du Québec » — routage, authentification,
 * coupe-circuit, et gestionnaire planifié (spécification §8, §9, §11).
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║ ⚠ NE JAMAIS JOURNALISER `request.url` (§9.2).                                ║
 * ║                                                                              ║
 * ║ Le secret partagé voyage dans le CHEMIN de l'URL (`POST /mcp/<secret>`),      ║
 * ║ parce que c'est la seule forme que tous les clients MCP savent produire.      ║
 * ║ Toute trace, tout `console.log`, tout message d'erreur qui reproduirait       ║
 * ║ l'URL entière publierait le secret dans `wrangler tail` et dans les journaux  ║
 * ║ d'observabilité. On journalise la MÉTHODE, le NOM D'OUTIL et le STATUT —      ║
 * ║ jamais le chemin. C'est le prix de la simplicité du modèle D7, et il doit     ║
 * ║ figurer ici en toutes lettres pour que personne ne le paie par accident.      ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import { runScheduled } from "./backfill";
import { createClient } from "./canlii/client";
import { mcpActif } from "./config";
import { callTool, INSTRUCTIONS, listToolDescriptors, SERVER_INFO, TOOLS } from "./mcp/registry";
import {
  err,
  errorResponse,
  INTERNAL_ERROR,
  INVALID_REQUEST,
  isNotification,
  JsonRpcError,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  parseMessage,
  type RequestId,
  resultResponse,
  type ToolResult,
} from "./mcp/rpc";
import { pagePubliqueHtml } from "./site";

/** Versions du protocole servies. La plus élevée EN TÊTE (§8). */
const VERSIONS = ["2025-06-18", "2025-03-26"] as const;

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/**
 * Origines de navigateur admises.
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║ Deux exigences DISTINCTES se rejoignent ici, et il faut les servir toutes    ║
 * ║ les deux :                                                                   ║
 * ║                                                                              ║
 * ║ 1. CORS. `claude.ai` est une application de NAVIGATEUR. Sans pré-vol accepté ║
 * ║    et sans `Access-Control-Allow-Origin`, le navigateur refuse la requête —   ║
 * ║    et le connecteur se solde par « Impossible de joindre le serveur », alors  ║
 * ║    que le même point d'entrée répond parfaitement à un client serveur.        ║
 * ║                                                                              ║
 * ║ 2. Défense contre le RÉ-ATTACHEMENT DNS, exigée par la spécification MCP :    ║
 * ║    une origine de navigateur non reconnue est REFUSÉE. Une origine absente    ║
 * ║    (appel serveur à serveur, scripts/mcp-client.mjs) reste admise — c'est le  ║
 * ║    motif retenu par `athena/mcp/bearer.py`.                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */
const ORIGINES_PAR_DEFAUT = ["https://claude.ai", "https://claude.com"];

function originesAdmises(env: Env): string[] {
  const brut = (env.ALLOWED_ORIGINS as string | undefined) ?? "";
  const sup = brut
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return [...ORIGINES_PAR_DEFAUT, ...sup];
}

/** Origine à refléter, ou null si l'origine est absente ou refusée. */
function originAutorisee(request: Request, env: Env): string | null {
  const o = request.headers.get("Origin");
  if (!o) return null; // serveur à serveur : pas de CORS à négocier
  return originesAdmises(env).includes(o) ? o : null;
}

/** Une origine de NAVIGATEUR présente mais non reconnue doit être refusée. */
function origineRefusee(request: Request, env: Env): boolean {
  const o = request.headers.get("Origin");
  return Boolean(o) && !originesAdmises(env).includes(o as string);
}

/**
 * En-têtes CORS d'une réponse effective.
 *
 * `Vary: Origin` est obligatoire : sans lui, un cache intermédiaire pourrait
 * resservir à une origine la réponse calculée pour une autre.
 */
function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    // Le client lit ces en-têtes ; sans exposition explicite ils lui sont invisibles.
    "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Protocol-Version",
  };
}

function jsonResponse(body: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin) },
  });
}

/**
 * Réponse au pré-vol CORS.
 *
 * ⚠ Le pré-vol est traité AVANT toute vérification du secret, et c'est
 *   obligatoire : un navigateur émet `OPTIONS` SANS en-tête d'authentification et
 *   sans corps. Exiger le secret ici ferait échouer le pré-vol, donc la requête
 *   réelle, donc le connecteur — sans que rien n'ait été authentifié pour autant.
 *   Le pré-vol ne divulgue rien : il ne fait qu'annoncer ce que le serveur accepte.
 */
function preflight(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, MCP-Protocol-Version, Accept, Last-Event-ID",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

/**
 * Comparaison À TEMPS CONSTANT, sur les empreintes plutôt que sur les chaînes (§9.1).
 *
 * Passer par SHA-256 neutralise aussi l'écart de LONGUEUR : `timingSafeEqual` exige
 * deux tampons de même taille et lèverait sur des chaînes de longueurs différentes —
 * ce qui, en soi, divulguerait la longueur du secret.
 */
async function secretOk(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Le secret présenté est-il l'un des secrets admis ?
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║ DEUX SECRETS, DES DROITS IDENTIQUES, ET UNE SEULE RAISON : LA RÉVOCATION.     ║
 * ║                                                                              ║
 * ║ `MCP_SHARED_SECRET` sert le connecteur claude.ai ; `MCP_SHARED_SECRET_ATHENA` ║
 * ║ sert le clavardage de Pallas Athéna. Le second n'ouvre AUCUN droit de plus —  ║
 * ║ ce que protège D7 reste la clef d'API et son quota, pas un périmètre de       ║
 * ║ données. Ils sont distincts pour qu'un porteur se retire SEUL : faire tourner ║
 * ║ celui de claude.ai ne doit pas éteindre le cabinet, ni l'inverse.             ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * ⚠ FERMÉ PAR DÉFAUT. Le second secret étant facultatif, la tentation serait de
 *   traiter « aucun secret configuré » comme « rien à comparer » : ce serait le
 *   défaut ouvert par omission que §9.1 interdit. Liste vide ⇒ `some` rend faux ⇒
 *   tout est refusé, exactement comme avant.
 *
 * ⚠ On compare les DEUX, sans court-circuit, et on ne journalise ni ne renvoie jamais
 *   lequel a servi (§9.2) : les deux échecs sont le même 401.
 */
async function secretAdmis(presente: string, env: Env): Promise<boolean> {
  const attendus = [env.MCP_SHARED_SECRET, env.MCP_SHARED_SECRET_ATHENA].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const verdicts = await Promise.all(attendus.map((attendu) => secretOk(presente, attendu)));
  return verdicts.some(Boolean);
}

/** Extrait le secret présenté : dernier segment du chemin, ou en-tête Authorization. */
function presentedSecret(request: Request, pathname: string): string | null {
  const entete = request.headers.get("Authorization");
  if (entete?.startsWith("Bearer ")) {
    const v = entete.slice(7).trim();
    if (v.length > 0) return v;
  }
  const m = /^\/mcp\/(.+)$/.exec(pathname);
  if (m?.[1]) return decodeURIComponent(m[1]);
  return null;
}

function unauthorized(origin: string | null = null): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...JSON_HEADERS, "WWW-Authenticate": "Bearer", ...corsHeaders(origin) },
  });
}

function methodNotAllowed(origin: string | null = null): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { ...JSON_HEADERS, Allow: "POST, OPTIONS", ...corsHeaders(origin) },
  });
}

/**
 * Limitation de débit (§9.3) : 60 requêtes/minute par IP, dans le Worker.
 *
 * ⚠ FAIL OPEN délibéré. Si le binding manque (développement local, mauvaise
 *   configuration) ou si l'appel échoue, on LAISSE PASSER.
 *
 *   Ce choix se justifie parce que la limitation de débit n'est PAS le contrôle
 *   d'accès : l'authentification, elle, échoue fermée (sans aucun secret configuré,
 *   tout est refusé). Ici, la seule chose protégée est le coût — requêtes Workers
 *   facturables et quota CanLII. Échouer fermé sur un compteur indisponible
 *   rendrait le connecteur inutilisable pour protéger une facture, ce qui est le
 *   mauvais arbitrage.
 */
async function debitAcceptable(request: Request, env: Env): Promise<boolean> {
  const limiteur = env.RATE_LIMITER;
  if (!limiteur) return true;
  // L'IP du client vue par Cloudflare. La documentation déconseille l'IP comme clef
  // dans le cas général (elle est partagée derrière un NAT) ; pour un connecteur
  // mono-usager, deux usagers derrière la même sortie partageraient un budget de
  // 60/min, ce qui est sans portée pratique ici.
  const ip = request.headers.get("CF-Connecting-IP") ?? "sans-ip";
  try {
    const { success } = await limiteur.limit({ key: ip });
    return success;
  } catch {
    return true;
  }
}

function tooManyRequests(origin: string | null): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: { ...JSON_HEADERS, "Retry-After": "60", ...corsHeaders(origin) },
  });
}

/** Origine de navigateur présente mais non reconnue (§ défense ré-attachement DNS). */
function forbiddenOrigin(): Response {
  return new Response(JSON.stringify({ error: "forbidden_origin" }), {
    status: 403,
    headers: JSON_HEADERS,
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

/**
 * Page publique (§18).
 *
 * ⚠ AUCUN en-tête CORS, comme `/health`. Sans `Access-Control-Allow-Origin`, aucun
 *   script d'une autre origine ne peut LIRE cette réponse : la page ne peut pas
 *   servir d'oracle. En ajouter « pour faire comme le reste » serait une régression.
 *
 * Ces en-têtes de sécurité sont les PREMIERS du dépôt, et c'est normal : servir du
 * `text/html` fait de cette origine une origine de DOCUMENT, ce qu'elle n'était pas
 * tant que tout était du JSON consommé hors navigateur.
 */
function pagePublique(request: Request): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    // Rien n'est chargé d'un tiers : le style et le script sont en ligne, il n'y a
    // ni police distante, ni CDN, ni image.
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // Volontairement court, et SANS `s-maxage` long : le rendu ne coûte rien (des
    // tables en mémoire), alors qu'un cache d'arête durable ferait survivre la page
    // à son propre déploiement.
    "Cache-Control": "public, max-age=600",
  };
  const html = pagePubliqueHtml();
  return request.method === "HEAD"
    ? new Response(null, { status: 200, headers })
    : new Response(html, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Coupe-circuit (§8) : « false » => 404 sur TOUTES les routes MCP, /health
    // compris. Un /health qui répondrait encore révélerait que le service existe.
    const actif = mcpActif(env);

    if (pathname === "/health") {
      return actif ? jsonResponse({ status: "ok" }) : notFound();
    }

    // ── Page publique (§18) ──────────────────────────────────────────────────
    //
    // ⚠ ÉGALITÉ STRICTE, jamais `startsWith("/")` : le `notFound()` final doit rester
    //   la réponse de tout le reste, et c'est épinglé par un test.
    //
    // ⚠ DÉLIBÉRÉMENT HORS de la garde du bloc `/mcp` ci-dessous. Le contrôle
    //   d'origine, la limitation de débit et l'authentification y vivent TOUS ; une
    //   page publique doit répondre à n'importe quel navigateur, et ne doit donc pas
    //   passer par `origineRefusee()`. Corollaire à ne pas oublier : ne JAMAIS
    //   remonter ces contrôles en portée globale « par cohérence », ce qui casserait
    //   la page pour tout visiteur arrivant par un lien d'un autre site.
    //
    // ⚠ ET DÉLIBÉRÉMENT AVANT le coupe-circuit. `MCP_ENABLED=false` protège la
    //   SURFACE MCP — la clef d'API et son quota ; il n'y a rien à protéger ici. La
    //   page ne porte ni secret ni donnée vivante : elle existe pour être lue, et
    //   c'est précisément quand le connecteur est coupé qu'on veut pouvoir lire
    //   pourquoi. Exception assumée au principe énoncé pour `/health`.
    if (pathname === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }
      return pagePublique(request);
    }

    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      if (!actif) return notFound();

      // Défense contre le ré-attachement DNS (spécification MCP) : une origine de
      // NAVIGATEUR présente mais inconnue est refusée d'emblée. Une origine absente
      // (serveur à serveur) passe — elle n'est pas soumise à la politique de même
      // origine et ne peut donc pas être détournée de cette façon.
      if (origineRefusee(request, env)) return forbiddenOrigin();
      const origin = originAutorisee(request, env);

      // Pré-vol CORS AVANT l'authentification : le navigateur l'émet sans en-tête
      // d'authentification. L'exiger ici casserait le connecteur sans rien protéger.
      if (request.method === "OPTIONS" && origin) return preflight(origin);

      // Limitation de débit APRÈS le pré-vol, et avant tout le reste (§9.3).
      //
      // L'ordre est délibéré des deux côtés : un 429 sur un pré-vol casserait le
      // connecteur de façon incompréhensible (le navigateur ne rapporte qu'un échec
      // CORS), tandis que limiter AVANT le contrôle de méthode et l'authentification
      // fait que même une rafale de requêtes mal formées ou mal authentifiées cesse
      // de coûter — ce qui est précisément l'objet de la mesure.
      if (!(await debitAcceptable(request, env))) return tooManyRequests(origin);

      // Aucun flux SSE, aucune session à supprimer : mode JSON sans état (D3).
      if (request.method !== "POST") return methodNotAllowed(origin);

      const presente = presentedSecret(request, pathname);
      if (!presente || !(await secretAdmis(presente, env))) {
        return unauthorized(origin);
      }
      return await handleMcp(request, env, ctx, origin);
    }

    return notFound();
  },

  /**
   * Cron hebdomadaire (lundi 06:17 UTC) : rafraîchit le répertoire des bases.
   * Le moissonnage de masse (§11) n'est atteint que si BACKFILL_ENABLED === "true",
   * ce qui n'est PAS le cas par défaut et ne doit pas l'être avant la détermination
   * de §16.1 auprès de CanLII.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
};

async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  origin: string | null,
): Promise<Response> {
  // Négociation d'en-tête : absent => la plus ancienne version servie.
  const entete = request.headers.get("MCP-Protocol-Version");
  if (entete !== null && !VERSIONS.includes(entete as (typeof VERSIONS)[number])) {
    return jsonResponse(
      errorResponse(
        null,
        INVALID_REQUEST,
        `Version de protocole non prise en charge ; versions servies : ${VERSIONS.join(", ")}.`,
      ),
      400,
      origin,
    );
  }

  let message: ReturnType<typeof parseMessage>;
  try {
    message = parseMessage(await request.text());
  } catch (e) {
    const je = e instanceof JsonRpcError ? e : new JsonRpcError(PARSE_ERROR, "Erreur d'analyse.");
    return jsonResponse(errorResponse(je.requestId, je.code, je.message), 200, origin);
  }

  // notifications/initialized, notifications/cancelled, … : accusé de réception vide.
  if (isNotification(message))
    return new Response(null, { status: 202, headers: corsHeaders(origin) });

  const id = (message.id ?? null) as RequestId;
  const params = message.params ?? {};

  try {
    switch (message.method) {
      case "initialize":
        return jsonResponse(resultResponse(id, initialize(params)), 200, origin);
      case "ping":
        return jsonResponse(resultResponse(id, {}), 200, origin);
      case "tools/list":
        return jsonResponse(resultResponse(id, { tools: listToolDescriptors() }), 200, origin);
      case "tools/call":
        return jsonResponse(resultResponse(id, await toolsCall(params, env, ctx)), 200, origin);
      default:
        return jsonResponse(
          errorResponse(id, METHOD_NOT_FOUND, `Méthode inconnue : ${message.method}`),
          200,
          origin,
        );
    }
  } catch (e) {
    if (e instanceof JsonRpcError) {
      return jsonResponse(errorResponse(id, e.code, e.message), 200, origin);
    }
    // Journalisation SANS l'URL (§9.2) : méthode et nature de l'échec, rien d'autre.
    console.error("échec de répartition MCP", {
      method: message.method,
      error: e instanceof Error ? e.name : "inconnu",
    });
    return jsonResponse(errorResponse(id, INTERNAL_ERROR, "Erreur interne."), 200, origin);
  }
}

function initialize(params: Record<string, unknown>): Record<string, unknown> {
  const demandee = params.protocolVersion;
  const negociee =
    typeof demandee === "string" && VERSIONS.includes(demandee as (typeof VERSIONS)[number])
      ? demandee
      : VERSIONS[0]; // la plus élevée que l'on serve
  return {
    protocolVersion: negociee,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

async function toolsCall(
  params: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const nom = params.name;
  if (typeof nom !== "string" || !(nom in TOOLS)) {
    // Outil inconnu : c'est une erreur d'EXÉCUTION rendue au modèle, pas une faute de
    // protocole — le modèle doit pouvoir la lire et se corriger (§7, conventions).
    return err(
      `Outil inconnu : « ${String(nom).slice(0, 80)} ». Outils disponibles : ${Object.keys(TOOLS).join(", ")}.`,
    );
  }

  const args = params.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return err("« arguments » doit être un objet.");
  }

  const client = createClient(env);
  const debut = Date.now();
  try {
    return await callTool(nom, args as Record<string, unknown>, { env, db: env.DB, client, ctx });
  } catch (e) {
    console.error("échec d'exécution d'outil", {
      tool: nom,
      ms: Date.now() - debut,
      error: e instanceof Error ? e.name : "inconnu",
    });
    return err(
      "L'outil a échoué pour une raison interne. Réessayer ; si l'échec persiste, le signaler.",
    );
  }
}
