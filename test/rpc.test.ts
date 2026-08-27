/**
 * Transport MCP (spécification §8, §9 ; plan de test §13).
 *
 * On appelle le Worker par son export `fetch` plutôt que par `SELF`, afin de pouvoir
 * faire varier `env` (coupe-circuit, secret absent) d'un test à l'autre.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { parseMessage } from "../src/mcp/rpc";
import { type JsonSchema, validateArgs } from "../src/mcp/validate";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
/** Second porteur (§19) — le clavardage de Pallas Athéna. Droits identiques. */
const SECRET_ATHENA = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

// `wrangler types` fige chaque var sur sa valeur LITTÉRALE de wrangler.jsonc :
// `Partial<Env>` garde donc `MCP_ENABLED: "true"` et interdit de l'éteindre dans un
// test. L'élargissement est confiné à ce helper — ailleurs, la précision du type
// reste un garde-fou utile.
function envAvec(over: Record<string, unknown> = {}): Env {
  return {
    ...env,
    MCP_SHARED_SECRET: SECRET,
    CANLII_API_KEY: "clef-de-test",
    ...over,
  } as unknown as Env;
}

async function appeler(
  body: unknown,
  opts: {
    secret?: string | null;
    method?: string;
    headers?: Record<string, string>;
    env?: Env;
  } = {},
): Promise<Response> {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const chemin = secret === null ? "/mcp" : `/mcp/${secret}`;
  const ctx = createExecutionContext();
  const req = new Request(`https://jurisprudence.poirierlavoie.ca${chemin}`, {
    method: opts.method ?? "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: opts.method && opts.method !== "POST" ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(req, opts.env ?? envAvec(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe("CORS — sans quoi claude.ai ne peut pas joindre le serveur", () => {
  const SECRET_URL = `https://x/mcp/${SECRET}`;

  /**
   * Défaut réel constaté à la mise en service : le serveur répondait parfaitement
   * à un client SERVEUR (curl, scripts/mcp-client.mjs) et restait injoignable
   * depuis claude.ai, qui est une application de NAVIGATEUR. Le pré-vol `OPTIONS`
   * recevait un 405 et les réponses ne portaient aucun en-tête CORS : le
   * navigateur refusait avant même de lire la réponse.
   */
  it("répond au pré-vol OPTIONS SANS exiger le secret", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://x/mcp/peu-importe", {
        method: "OPTIONS",
        headers: {
          Origin: "https://claude.ai",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
      envAvec(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    // Un navigateur émet le pré-vol sans authentification : l'exiger casserait tout.
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain(
      "content-type",
    );
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("une réponse réelle porte Access-Control-Allow-Origin", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(SECRET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://claude.ai" },
        body: JSON.stringify(rpc("ping")),
      }),
      envAvec(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    // Sans cet en-tête, le navigateur bloque la LECTURE de la réponse, même 200.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
  });

  it("un 401 porte aussi les en-têtes CORS, sinon l'erreur est illisible", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://x/mcp/mauvais-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://claude.ai" },
        body: JSON.stringify(rpc("ping")),
      }),
      envAvec(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
  });

  it("REFUSE une origine de navigateur inconnue (ré-attachement DNS)", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(SECRET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify(rpc("ping")),
      }),
      envAvec(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    // 403 MÊME avec le bon secret : l'origine est jugée avant l'authentification.
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("un appel SANS origine (serveur à serveur) reste admis", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(SECRET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpc("ping")),
      }),
      envAvec(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("ALLOWED_ORIGINS ajoute une origine sans retirer claude.ai", async () => {
    const e = envAvec({ ALLOWED_ORIGINS: "https://exemple.test" });
    for (const [origine, attendu] of [
      ["https://exemple.test", 200],
      ["https://claude.ai", 200],
      ["https://autre.test", 403],
    ] as Array<[string, number]>) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(SECRET_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origine },
          body: JSON.stringify(rpc("ping")),
        }),
        e,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status, origine).toBe(attendu);
    }
  });
});

describe("§9.3 — limitation de débit", () => {
  const SECRET_URL = `https://x/mcp/${SECRET}`;
  /** Faux limiteur : accepte `n` requêtes puis refuse. */
  const limiteur = (n: number) => {
    let vues = 0;
    return { limit: async () => ({ success: ++vues <= n }) };
  };

  it("répond 429 avec Retry-After une fois le seuil franchi", async () => {
    const e = envAvec({ RATE_LIMITER: limiteur(1) });
    const appel = async () => {
      const ctx = createExecutionContext();
      const r = await worker.fetch(
        new Request(SECRET_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rpc("ping")),
        }),
        e,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return r;
    };
    expect((await appel()).status).toBe(200);
    const refus = await appel();
    expect(refus.status).toBe(429);
    expect(refus.headers.get("Retry-After")).toBe("60");
  });

  it("le PRÉ-VOL n'est JAMAIS limité", async () => {
    // Un 429 sur un pré-vol ne remonte au navigateur que comme un échec CORS
    // opaque : le connecteur casserait sans que le motif soit lisible nulle part.
    const e = envAvec({ RATE_LIMITER: limiteur(0) });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(SECRET_URL, {
        method: "OPTIONS",
        headers: { Origin: "https://claude.ai", "Access-Control-Request-Method": "POST" },
      }),
      e,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
  });

  it("limite AVANT l'authentification : une rafale mal authentifiée cesse de coûter", async () => {
    const e = envAvec({ RATE_LIMITER: limiteur(0) });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://x/mcp/mauvais-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpc("ping")),
      }),
      e,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(429); // et non 401 : on n'a même pas comparé le secret
  });

  it("FAIL OPEN : binding absent ou en panne => la requête passe", async () => {
    // La limitation protège le COÛT, pas l'accès. Échouer fermé sur un compteur
    // indisponible rendrait le connecteur inutilisable pour protéger une facture.
    for (const rl of [
      undefined,
      {
        limit: async () => {
          throw new Error("panne");
        },
      },
    ]) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(SECRET_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rpc("ping")),
        }),
        envAvec({ RATE_LIMITER: rl }),
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
    }
  });
});

describe("§8 — routage", () => {
  it("GET /health répond 200 sans authentification", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://x/health"), envAvec(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET et DELETE sur /mcp répondent 405 — aucun flux SSE, aucune session", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await appeler(null, { method });
      expect(res.status).toBe(405);
      // OPTIONS figure desormais dans Allow : le pre-vol CORS est servi (claude.ai
      // est un client de NAVIGATEUR). GET et DELETE restent refuses.
      expect(res.headers.get("Allow")).toBe("POST, OPTIONS");
    }
  });

  it("tout le reste répond 404", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://x/autre"), envAvec(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it("MCP_ENABLED = « false » => 404 PARTOUT, /health compris", async () => {
    const eteint = envAvec({ MCP_ENABLED: "false" });
    const ctx = createExecutionContext();
    const sante = await worker.fetch(new Request("https://x/health"), eteint, ctx);
    await waitOnExecutionContext(ctx);
    expect(sante.status).toBe(404);

    const mcp = await appeler(rpc("ping"), { env: eteint });
    expect(mcp.status).toBe(404);
  });
});

describe("§9.1 — authentification", () => {
  it("secret erroné => 401 avec WWW-Authenticate", async () => {
    const res = await appeler(rpc("ping"), { secret: "mauvais-secret" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("secret de longueur différente => 401, sans lever", async () => {
    // Le passage par SHA-256 neutralise l'écart de longueur : `timingSafeEqual`
    // lèverait sur des tampons de tailles différentes.
    const res = await appeler(rpc("ping"), { secret: "x" });
    expect(res.status).toBe(401);
  });

  it("/mcp sans secret => 401", async () => {
    const res = await appeler(rpc("ping"), { secret: null });
    expect(res.status).toBe(401);
  });

  it("accepte le secret par l'en-tête Authorization: Bearer", async () => {
    const res = await appeler(rpc("ping"), {
      secret: null,
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
  });

  it("REFUSE TOUT quand aucun secret n'est configuré (défaut fermé)", async () => {
    // Les DEUX secrets absents. Le second étant facultatif, la régression à craindre
    // est « rien à comparer, donc on laisse passer » : c'est ce que ce test interdit.
    const sansSecret = {
      ...envAvec(),
      MCP_SHARED_SECRET: undefined,
      MCP_SHARED_SECRET_ATHENA: undefined,
    };
    const res = await appeler(rpc("ping"), { env: sansSecret as Env });
    expect(res.status).toBe(401);
  });

  // ── Second porteur (§19) ─────────────────────────────────────────────────
  //
  // Le clavardage de Pallas Athéna présente SON secret, aux droits identiques. Ce qui
  // est vérifié ici n'est pas un privilège mais une INDÉPENDANCE : chacun ouvre, et
  // retirer l'un laisse l'autre debout — sans quoi une rotation éteindrait les deux.

  it("le second secret authentifie, par le chemin comme par l'en-tête", async () => {
    const deux = envAvec({ MCP_SHARED_SECRET_ATHENA: SECRET_ATHENA });

    const parChemin = await appeler(rpc("ping"), { secret: SECRET_ATHENA, env: deux });
    expect(parChemin.status).toBe(200);

    const parEntete = await appeler(rpc("ping"), {
      secret: null,
      headers: { Authorization: `Bearer ${SECRET_ATHENA}` },
      env: deux,
    });
    expect(parEntete.status).toBe(200);
  });

  it("les deux porteurs coexistent : configurer le second n'invalide pas le premier", async () => {
    const deux = envAvec({ MCP_SHARED_SECRET_ATHENA: SECRET_ATHENA });
    const res = await appeler(rpc("ping"), { secret: SECRET, env: deux });
    expect(res.status).toBe(200);
  });

  it("révocation SÉPARÉE : retirer le premier laisse le second ouvrir, et l'inverse", async () => {
    const sansPremier = envAvec({
      MCP_SHARED_SECRET: undefined,
      MCP_SHARED_SECRET_ATHENA: SECRET_ATHENA,
    });
    expect((await appeler(rpc("ping"), { secret: SECRET_ATHENA, env: sansPremier })).status).toBe(
      200,
    );
    expect((await appeler(rpc("ping"), { secret: SECRET, env: sansPremier })).status).toBe(401);

    const sansSecond = envAvec({ MCP_SHARED_SECRET_ATHENA: undefined });
    expect((await appeler(rpc("ping"), { secret: SECRET, env: sansSecond })).status).toBe(200);
    expect((await appeler(rpc("ping"), { secret: SECRET_ATHENA, env: sansSecond })).status).toBe(
      401,
    );
  });

  it("deux secrets configurés n'admettent pas pour autant un troisième", async () => {
    const deux = envAvec({ MCP_SHARED_SECRET_ATHENA: SECRET_ATHENA });
    const res = await appeler(rpc("ping"), { secret: "mauvais-secret", env: deux });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("le secret bon passe", async () => {
    const res = await appeler(rpc("ping"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
  });
});

describe("§8 — méthodes JSON-RPC", () => {
  it("initialize négocie la version demandée", async () => {
    const res = await appeler(rpc("initialize", { protocolVersion: "2025-03-26" }));
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo).toMatchObject({ name: "jurisprudence-canlii" });
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it("initialize rend la plus élevée servie quand la demande est inconnue", async () => {
    const res = await appeler(rpc("initialize", { protocolVersion: "1999-01-01" }));
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("les instructions d'initialisation portent le contrat de vérité", async () => {
    const res = await appeler(rpc("initialize", {}));
    const body = (await res.json()) as { result: { instructions: string } };
    expect(body.result.instructions).toContain("MÉTADONNÉES");
    expect(body.result.instructions).toContain("autorité actuelle");
  });

  it("une notification répond 202 avec un corps vide", async () => {
    const ctx = createExecutionContext();
    const req = new Request(`https://x/mcp/${SECRET}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const res = await worker.fetch(req, envAvec(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("tools/list rend les 10 outils, tous décrits et annotés", async () => {
    const res = await appeler(rpc("tools/list"));
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: Record<string, unknown>;
          annotations: Record<string, boolean>;
        }>;
      };
    };
    const outils = body.result.tools;
    expect(outils).toHaveLength(13);
    for (const t of outils) {
      expect(t.name).toMatch(/^(canlii|greffe|palais)_/);
      expect(t.description.length).toBeGreaterThan(80);
      expect(t.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
      // §7, conventions : additionalProperties false sur TOUS les schémas.
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
    expect(outils.map((t) => t.name).sort()).toEqual(
      [
        "canlii_browse_cases",
        "canlii_browse_legislation",
        "canlii_citator",
        "canlii_find_case",
        "canlii_get_case",
        "canlii_get_legislation",
        "canlii_list_databases",
        "canlii_parse_citation",
        "canlii_subsequent_history",
        "canlii_verify_citations",
        "greffe_parse_court_file_number",
        "palais_get",
        "palais_list",
      ].sort(),
    );
  });

  /**
   * La frontière de §17 : `canlii_` promet que la réponse vient de la collection de
   * CanLII. Un outil servi sous ce préfixe alors qu'il lit une table locale
   * attribuerait à CanLII une donnée dont il n'est pas la source — l'inverse exact de
   * ce que D8 protège. Ce test fait de la scission une CONTRAINTE, non une note.
   */
  it("le préfixe dit la SOURCE : canlii_ pour CanLII, greffe_/palais_ pour le relevé local", async () => {
    const res = await appeler(rpc("tools/list"));
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const noms = body.result.tools.map((t) => t.name);

    const canlii = noms.filter((n) => n.startsWith("canlii_"));
    const locaux = noms.filter((n) => n.startsWith("greffe_") || n.startsWith("palais_"));

    expect(canlii).toHaveLength(10);
    expect(locaux).toHaveLength(3);
    // Aucun outil ne relève des deux familles, et aucun n'échappe aux deux.
    expect(canlii.length + locaux.length).toBe(noms.length);
    // Les outils locaux ne portent JAMAIS la marque de CanLII, nulle part dans le nom.
    for (const n of locaux) expect(n).not.toMatch(/canlii/i);
  });

  it("une méthode inconnue rend -32601", async () => {
    const res = await appeler(rpc("resources/list"));
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it("un outil inconnu rend isError, PAS une erreur JSON-RPC", async () => {
    const res = await appeler(rpc("tools/call", { name: "canlii_inexistant", arguments: {} }));
    const body = (await res.json()) as {
      result: { isError: boolean; content: [{ text: string }] };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Outil inconnu");
  });

  it("des arguments invalides rendent isError, PAS une erreur JSON-RPC (§8)", async () => {
    const res = await appeler(
      rpc("tools/call", { name: "canlii_parse_citation", arguments: { citation: 42 } }),
    );
    const body = (await res.json()) as {
      result: { isError: boolean; content: [{ text: string }] };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("chaîne de caractères");
  });

  it("un argument non déclaré est refusé (additionalProperties: false)", async () => {
    const res = await appeler(
      rpc("tools/call", {
        name: "canlii_parse_citation",
        arguments: { citation: "2020 QCCA 495", inconnu: true },
      }),
    );
    const body = (await res.json()) as {
      result: { isError: boolean; content: [{ text: string }] };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("n'est pas un argument reconnu");
  });

  it("JSON illisible rend -32700", async () => {
    const ctx = createExecutionContext();
    const req = new Request(`https://x/mcp/${SECRET}`, { method: "POST", body: "{pas du json" });
    const res = await worker.fetch(req, envAvec(), ctx);
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("un lot (tableau) est refusé", async () => {
    const res = await appeler([rpc("ping"), rpc("ping", undefined, 2)]);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain("groupées");
  });

  it("une version de protocole inconnue en en-tête rend 400", async () => {
    const res = await appeler(rpc("ping"), { headers: { "MCP-Protocol-Version": "2001-01-01" } });
    expect(res.status).toBe(400);
  });

  it("n'émet PAS structuredContent (symétrie avec qclaw, D4)", async () => {
    const res = await appeler(
      rpc("tools/call", {
        name: "canlii_parse_citation",
        arguments: { citation: "2020 QCCA 495" },
      }),
    );
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result).not.toHaveProperty("structuredContent");
    expect(Object.keys(body.result).sort()).toEqual(["content", "isError"]);
  });
});

describe("parseMessage — validation de forme", () => {
  it("refuse un jsonrpc absent ou faux", () => {
    expect(() => parseMessage('{"method":"ping","id":1}')).toThrow();
    expect(() => parseMessage('{"jsonrpc":"1.0","method":"ping","id":1}')).toThrow();
  });
  it("refuse une méthode vide", () => {
    expect(() => parseMessage('{"jsonrpc":"2.0","method":"","id":1}')).toThrow();
  });
  it("refuse un id objet", () => {
    expect(() => parseMessage('{"jsonrpc":"2.0","method":"ping","id":{}}')).toThrow();
  });
  it("accepte params absent", () => {
    expect(parseMessage('{"jsonrpc":"2.0","method":"ping","id":1}').params).toBeUndefined();
  });
});

describe("validateArgs — port du sous-ensemble d'Athéna", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      titre: { type: "string", minLength: 2, maxLength: 10 },
      n: { type: "integer", minimum: 1, maximum: 5 },
      choix: { type: "string", enum: ["a", "b"] },
      liste: { type: "array", minItems: 1, maxItems: 2, items: { type: "integer", minimum: 0 } },
      drapeau: { type: "boolean" },
    },
    required: ["titre"],
    additionalProperties: false,
  };

  it("accepte un objet conforme", () => {
    expect(
      validateArgs(schema, { titre: "abc", n: 3, choix: "a", liste: [1], drapeau: true }),
    ).toEqual([]);
  });

  it("signale le manquant, l'inconnu, le type, l'enum et les bornes", () => {
    const e = validateArgs(schema, { n: 9, choix: "z", inconnu: 1 });
    expect(e.join(" ")).toContain("« titre » est obligatoire");
    expect(e.join(" ")).toContain("« inconnu » n'est pas un argument reconnu");
    expect(e.join(" ")).toContain("inférieur ou égal à 5");
    expect(e.join(" ")).toContain("l'une de ces valeurs");
  });

  it("compte les caractères NON BLANCS pour minLength", () => {
    expect(validateArgs(schema, { titre: "   " }).join(" ")).toContain("non blancs");
  });

  it("valide les éléments d'un tableau, un niveau", () => {
    expect(validateArgs(schema, { titre: "ab", liste: [1, -3] }).join(" ")).toContain("liste[1]");
    expect(validateArgs(schema, { titre: "ab", liste: [] }).join(" ")).toContain("au moins 1");
    expect(validateArgs(schema, { titre: "ab", liste: [1, 2, 3] }).join(" ")).toContain(
      "au plus 2",
    );
  });

  it("un booléen n'est pas soumis aux bornes numériques", () => {
    expect(validateArgs(schema, { titre: "ab", drapeau: true })).toEqual([]);
    expect(validateArgs(schema, { titre: "ab", n: true }).join(" ")).toContain("entier");
  });
});
