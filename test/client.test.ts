/**
 * Client CanLII (spécification §5, plan de test §13).
 *
 * Le test capital de ce fichier est le DERNIER : la clef d'API ne doit apparaître
 * dans aucune sortie journalisable. Il est écrit comme un test de non-régression sur
 * `redactUrl` parce que la fuite, si elle survient, sera silencieuse — la clef
 * partira dans `wrangler tail` sans que rien ne casse.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createClient, describeError, parseRetryAfter } from "../src/canlii/client";
import {
  CanliiBudgetError,
  CanliiError,
  CanliiTimeoutError,
  redactUrl,
} from "../src/canlii/errors";

const CLEF = "clef-secrete-a-ne-jamais-divulguer-42";

/** Fabrique un `fetch` factice qui joue une file de réponses et note les URL vues. */
function fakeFetch(reponses: Array<Response | (() => Response | Promise<Response>)>) {
  const vues: string[] = [];
  let i = 0;
  const impl = (async (input: RequestInfo | URL) => {
    vues.push(String(input));
    const r = reponses[Math.min(i, reponses.length - 1)];
    i++;
    if (typeof r === "function") return await r();
    return r!.clone();
  }) as unknown as typeof fetch;
  return { impl, vues, appels: () => i };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

/** Client de test : aucune attente réelle, gigue nulle, plafond explicite. */
function client(
  reponses: Array<Response | (() => Response | Promise<Response>)>,
  overrides: Partial<{ maxCalls: number; minIntervalMs: number; timeoutMs: number }> = {},
) {
  const f = fakeFetch(reponses);
  const dormis: number[] = [];
  const c = createClient(
    { ...env, CANLII_API_KEY: CLEF },
    {
      fetchImpl: f.impl,
      sleepImpl: async (ms) => {
        dormis.push(ms);
      },
      jitterImpl: () => 0,
    },
    { minIntervalMs: 0, ...overrides },
  );
  return { c, f, dormis };
}

describe("§5.1 — construction des URL", () => {
  it("cible https://api.canlii.org/v1 et place api_key en dernier", async () => {
    const { c, f } = client([json({ ok: true })]);
    await c.get("caseBrowse/fr/csc-scc/2008scc9/");
    const url = new URL(f.vues[0]!);
    expect(url.origin + url.pathname).toBe(
      "https://api.canlii.org/v1/caseBrowse/fr/csc-scc/2008scc9/",
    );
    expect([...url.searchParams.keys()].at(-1)).toBe("api_key");
  });

  it("transmet les paramètres et ignore les valeurs vides", async () => {
    const { c, f } = client([json({ cases: [] })]);
    await c.get("caseBrowse/fr/qcca/", {
      offset: 0,
      resultCount: 5000,
      decisionDateAfter: "2020-01-01",
      decisionDateBefore: "",
    });
    const url = new URL(f.vues[0]!);
    expect(url.searchParams.get("resultCount")).toBe("5000");
    expect(url.searchParams.get("decisionDateAfter")).toBe("2020-01-01");
    expect(url.searchParams.has("decisionDateBefore")).toBe(false);
  });
});

describe("§5.2 — étranglement, réessais, délais", () => {
  it("réessaie sur 429 et respecte Retry-After, qui PRIME sur la temporisation", async () => {
    const { c, f, dormis } = client([
      () => new Response("throttled", { status: 429, headers: { "Retry-After": "7" } }),
      () => json({ ok: true }),
    ]);
    await expect(c.get("caseBrowse/fr/")).resolves.toEqual({ ok: true });
    expect(f.appels()).toBe(2);
    // 7 s de Retry-After, et non 500 ms de temporisation exponentielle.
    expect(dormis).toContain(7000);
    expect(c.usage().throttled).toBe(1);
  });

  it("temporise PLUS LONGTEMPS sur 429 que sur 5xx, Retry-After absent", async () => {
    // Un 5xx est un incident ; un 429 est une CONSIGNE. Employer la même base pour
    // les deux revient à ignorer la consigne tout en croyant l'appliquer.
    const c429 = client([
      () => new Response("throttled", { status: 429 }),
      () => json({ ok: true }),
    ]);
    await c429.c.get("caseBrowse/fr/");
    const c503 = client([
      () => new Response("boom", { status: 503 }),
      () => json({ ok: true }),
    ]);
    await c503.c.get("caseBrowse/fr/");
    expect(c429.dormis).toContain(2000);
    expect(c503.dormis).toContain(500);
    expect(Math.max(...c429.dormis)).toBeGreaterThan(Math.max(...c503.dormis));
  });

  it("RALENTIT D'OFFICE le reste de l'invocation après un 429", async () => {
    // Le quota de CanLII n'est pas publié : le refus est la seule mesure qu'on ait.
    // Un lot qui touche la limite doit cesser de la retoucher appel après appel.
    const { c, dormis } = client(
      [
        () => new Response("throttled", { status: 429 }),
        () => json({ ok: true }),
        () => json({ ok: true }),
      ],
      { minIntervalMs: 600 },
    );
    await c.get("caseBrowse/fr/a");
    const avant = dormis.length;
    await c.get("caseBrowse/fr/b");
    const attentes = dormis.slice(avant);
    // 600 doublé une fois par l'unique 429 : l'appel suivant attend ~1200, pas ~600.
    //
    // ⚠ On compare par INTERVALLE, jamais par égalité. `#throttle` dort
    //   `intervalle − temps déjà écoulé` : quelques millisecondes de vrai temps
    //   passent entre la réponse et l'attente suivante, si bien qu'on observe 1198
    //   plutôt que 1200. Une égalité stricte ici passe la plupart du temps et échoue
    //   une fois sur trois — un test instable qu'on finirait par désarmer.
    expect(attentes.some((ms) => ms > 1000 && ms <= 1200)).toBe(true);
    expect(attentes.every((ms) => ms <= 1200)).toBe(true);
    expect(c.usage().throttled).toBe(1);
  });

  it("l'adaptation est PLAFONNÉE et meurt avec l'invocation", async () => {
    const rafale = Array.from({ length: 6 }, () =>
      () => new Response("throttled", { status: 429 }),
    );
    const { c } = client([...rafale, () => json({ ok: true })], {
      minIntervalMs: 600,
      maxCalls: 40,
    });
    // Trois tentatives par appel : deux appels suffisent à empiler six 429.
    await expect(c.get("caseBrowse/fr/a")).rejects.toThrow();
    await expect(c.get("caseBrowse/fr/b")).rejects.toThrow();
    expect(c.usage().throttled).toBe(6);

    // Un client NEUF repart au rythme configuré : aucun état ne fuit entre
    // invocations, et c'est délibéré (il n'y a pas d'objet durable ici).
    const neuf = client([() => json({ ok: true }), () => json({ ok: true })], {
      minIntervalMs: 600,
    });
    await neuf.c.get("caseBrowse/fr/a");
    await neuf.c.get("caseBrowse/fr/b");
    // Même prudence : ~600, et RIEN au-delà — l'intervalle n'a pas été hérité.
    expect(neuf.dormis.some((ms) => ms > 400 && ms <= 600)).toBe(true);
    expect(neuf.dormis.every((ms) => ms <= 600)).toBe(true);
  });

  it("Retry-After PRIME encore sur la base allongée du 429", async () => {
    const { c, dormis } = client([
      () => new Response("t", { status: 429, headers: { "Retry-After": "3" } }),
      () => json({ ok: true }),
    ]);
    await c.get("caseBrowse/fr/");
    expect(dormis).toContain(3000);
    expect(dormis).not.toContain(2000);
  });

  it("temporise en exponentielle quand Retry-After est absent", async () => {
    const { c, dormis } = client([
      () => new Response("boom", { status: 503 }),
      () => new Response("boom", { status: 503 }),
      () => json({ ok: true }),
    ]);
    await c.get("caseBrowse/fr/");
    expect(dormis).toEqual([500, 1000]); // 500 × 2⁰ puis 500 × 2¹, gigue nulle
  });

  it("ne réessaie PAS sur 400/401/403/404", async () => {
    for (const status of [400, 401, 403, 404]) {
      const { c, f } = client([() => new Response("non", { status })]);
      await expect(c.get("caseBrowse/fr/x/y/")).rejects.toBeInstanceOf(CanliiError);
      expect(f.appels()).toBe(1);
    }
  });

  it("abandonne après trois tentatives et compte une erreur", async () => {
    const { c, f } = client([() => new Response("boom", { status: 500 })]);
    await expect(c.get("caseBrowse/fr/")).rejects.toBeInstanceOf(CanliiError);
    expect(f.appels()).toBe(3);
    expect(c.usage().errors).toBe(1);
  });

  it("traduit une expiration de délai", async () => {
    const { c } = client([
      () => {
        const e = new Error("timed out");
        e.name = "TimeoutError";
        throw e;
      },
    ]);
    await expect(c.get("caseBrowse/fr/")).rejects.toBeInstanceOf(CanliiTimeoutError);
  });

  it("plafonne les appels et lève CanliiBudgetError", async () => {
    const { c, f } = client([json({ ok: true })], { maxCalls: 2 });
    await c.get("caseBrowse/fr/");
    await c.get("caseBrowse/fr/");
    await expect(c.get("caseBrowse/fr/")).rejects.toBeInstanceOf(CanliiBudgetError);
    expect(f.appels()).toBe(2); // le troisième appel n'a JAMAIS quitté le Worker
    expect(c.remaining()).toBe(0);
  });

  it("respecte l'intervalle minimal entre deux appels", async () => {
    const { c, dormis } = client([json({ ok: true })], { minIntervalMs: 250 });
    await c.get("caseBrowse/fr/");
    await c.get("caseBrowse/fr/");
    expect(dormis.some((ms) => ms > 0 && ms <= 250)).toBe(true);
  });
});

describe("§5.2 — charge utile TOO_LONG", () => {
  it("halve resultCount et réessaie UNE FOIS", async () => {
    let vu = 0;
    const { c, f } = client([
      () => {
        vu++;
        return json({ error: "TOO_LONG", message: "payload too large" });
      },
      () => json({ cases: [{ title: "ok" }] }),
    ]);
    const r = await c.get<{ cases: unknown[] }>("caseBrowse/fr/qccq/", {
      offset: 0,
      resultCount: 5000,
    });
    expect(r.cases).toHaveLength(1);
    expect(vu).toBe(1);
    expect(new URL(f.vues[1]!).searchParams.get("resultCount")).toBe("2500");
  });

  it("laisse remonter si TOO_LONG persiste après réduction", async () => {
    const { c } = client([() => json({ error: "TOO_LONG" })]);
    await expect(
      c.get("caseBrowse/fr/qccq/", { offset: 0, resultCount: 5000 }),
    ).rejects.toMatchObject({ code: "TOO_LONG" });
  });

  it("détecte un corps d'erreur applicatif rendu avec un statut 200", async () => {
    const { c } = client([() => json({ error: "TOO_LONG" })]);
    await expect(c.get("caseBrowse/fr/")).rejects.toBeInstanceOf(CanliiError);
  });
});

describe("Retry-After", () => {
  it("lit un nombre de secondes", () => {
    expect(parseRetryAfter("12")).toBe(12000);
  });
  it("lit une date HTTP", () => {
    const now = Date.parse("2026-07-23T12:00:00Z");
    expect(parseRetryAfter("Thu, 23 Jul 2026 12:00:30 GMT", now)).toBe(30000);
  });
  it("rend null sur en-tête absent ou illisible", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("bientôt")).toBeNull();
  });
});

describe("§5.3 — LA CLEF NE QUITTE JAMAIS LE PROCESSUS", () => {
  it("redactUrl remplace api_key par ***", () => {
    const r = redactUrl(`https://api.canlii.org/v1/caseBrowse/fr/?offset=0&api_key=${CLEF}`);
    expect(r).not.toContain(CLEF);
    expect(r).toContain("api_key=***");
  });

  it("redactUrl ne renvoie jamais une chaîne illisible telle quelle", () => {
    expect(redactUrl(`pas-une-url?api_key=${CLEF}`)).not.toContain(CLEF);
  });

  it("aucune surface d'une erreur CanliiError ne porte la clef", async () => {
    const { c } = client([() => new Response(`refusé pour ${CLEF}`, { status: 403 })]);
    const err = (await c.get("caseBrowse/fr/").catch((e) => e)) as CanliiError;
    expect(err).toBeInstanceOf(CanliiError);
    // message, url, pile : aucune de ces surfaces ne doit contenir la clef.
    expect(err.message).not.toContain(CLEF);
    expect(err.url).not.toContain(CLEF);
    expect(String(err.stack ?? "")).not.toContain(CLEF);
    expect(JSON.stringify({ m: err.message, u: err.url })).not.toContain(CLEF);
    // Le corps distant est conservé pour le diagnostic : c'est CanLII qui l'a écrit,
    // pas nous — mais il ne doit jamais atteindre une sortie d'outil (cf. garde.test).
  });

  it("une erreur d'expiration ne porte pas la clef", async () => {
    const { c } = client([
      () => {
        const e = new Error("timed out");
        e.name = "TimeoutError";
        throw e;
      },
    ]);
    const err = (await c.get("caseBrowse/fr/").catch((e) => e)) as CanliiTimeoutError;
    expect(err.message).not.toContain(CLEF);
    expect(err.url).not.toContain(CLEF);
  });

  it("describeError rend du français sans clef ni URL d'api.canlii.org", () => {
    const messages = [
      describeError(new CanliiBudgetError(40, 40)),
      describeError(new CanliiError(403, `https://api.canlii.org/v1/x?api_key=${CLEF}`, "non")),
      describeError(new CanliiError(429, "https://api.canlii.org/v1/x", "non")),
      describeError(new CanliiTimeoutError(`https://api.canlii.org/v1/x?api_key=${CLEF}`, 15000)),
      describeError(new Error("autre")),
    ];
    for (const m of messages) {
      expect(m).not.toContain(CLEF);
      expect(m).not.toContain("api.canlii.org");
    }
  });
});
