/**
 * TEST DE GARDE DU CONTRAT DE VÉRITÉ (spécification §2, §13).
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║ Ce fichier n'éprouve pas une fonctionnalité : il empêche une DISPARITION.     ║
 * ║                                                                              ║
 * ║ Les mises en garde de §2 sont ce qui distingue un vérificateur de citations   ║
 * ║ honnête d'un outil qui transforme une incertitude connue en fausse assurance. ║
 * ║ Elles vivent dans des gabarits, et un gabarit se refond. Le mode de panne     ║
 * ║ redouté n'est donc pas l'erreur — c'est le SILENCE : une refonte qui rend     ║
 * ║ des sorties impeccables, dont la garantie a discrètement disparu.             ║
 * ║                                                                              ║
 * ║ Si un test d'ici échoue, la bonne réaction n'est PAS de l'ajuster pour qu'il  ║
 * ║ passe : c'est de remettre la mise en garde.                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  EXPLICATIONS_INTROUVABLE,
  GARDE_CITATEUR,
  GARDE_DOSSIER,
  GARDE_PALAIS,
  GARDE_RECHERCHE,
  GARDE_SANS_ADRESSE,
  GARDE_SORTS_PIED,
  GARDE_SORTS_TETE,
  GARDE_VERIFICATION,
} from "../src/format/render";
import { callTool, listToolDescriptors, TOOLS } from "../src/mcp/registry";
import dunsmuir from "./fixtures/dunsmuir.json";
import qcca2005 from "./fixtures/qcca2005.json";
import { fakeClient, resetDb, seedDatabases, texte, toolCtx } from "./helpers";

beforeEach(async () => {
  await resetDb();
  await seedDatabases();
});

/**
 * Compare en ignorant les blancs.
 *
 * `numeroter()` (annexe A) indente les lignes de continuation d'un bloc numéroté :
 * une mise en garde sur deux lignes s'y retrouve donc indentée. Ce qui doit être
 * verrouillé, c'est sa PRÉSENCE, pas sa colonne — sans quoi le test casserait au
 * premier changement de mise en page, et la tentation serait de l'affaiblir.
 */
function contient(sortie: string, bloc: string): boolean {
  const plat = (s: string) => s.replace(/\s+/g, " ").trim();
  return plat(sortie).includes(plat(bloc));
}

/** Formulations qui affirmeraient plus que l'API n'établit. Aucune n'est permise. */
const FORMULATIONS_INTERDITES = [
  /n'existe pas/i,
  /n'a jamais existé/i,
  /\ba été infirmée\b/i,
  /\ba été confirmée en appel\b/i,
  /\btoujours en vigueur\b/i,
  /\bfait autorité\b/i,
  /\bcitation valide\b/i,
];

describe("§2 — les treize outils existent et se décrivent", () => {
  it("expose exactement treize outils : dix CanLII, trois du Québec", () => {
    expect(Object.keys(TOOLS)).toHaveLength(13);
  });

  it("chacun porte une description non vide et un schéma fermé", () => {
    for (const [nom, t] of Object.entries(TOOLS)) {
      expect(t.description.length, nom).toBeGreaterThan(80);
      expect(t.inputSchema.additionalProperties, nom).toBe(false);
    }
  });

  it("chacun porte un titre lisible, distinct du nom", () => {
    for (const d of listToolDescriptors()) {
      const titre = d.title as string;
      expect(typeof titre, String(d.name)).toBe("string");
      expect(titre.length, String(d.name)).toBeGreaterThan(3);
      expect(titre, String(d.name)).not.toBe(d.name);
      // Le titre est du français lisible, pas un identifiant recyclé.
      expect(titre, String(d.name)).not.toMatch(/^(canlii|greffe|palais)_/);
    }
  });

  it("le titre des outils HEURISTIQUES ou HORS LIGNE porte leur réserve", () => {
    // Le titre s'affiche dans l'invite d'autorisation : c'est le dernier endroit
    // où la réserve peut être lue AVANT que l'outil ne s'exécute.
    const t = Object.fromEntries(listToolDescriptors().map((d) => [d.name, d.title as string]));
    expect(t.canlii_subsequent_history).toMatch(/heuristique/i);
    expect(t.canlii_citator).toMatch(/brute/i);
    expect(t.canlii_parse_citation).toMatch(/hors ligne/i);
    expect(t.greffe_parse_court_file_number).toMatch(/hors ligne/i);
  });

  it("tous sont annotés en lecture seule et monde ouvert (§7)", () => {
    for (const d of listToolDescriptors()) {
      expect(d.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
  });

  it("les descriptions des outils PORTENT elles-mêmes leurs limites", () => {
    // §7.1 : l'outil pivot doit dire ce qu'il n'établit pas.
    expect(TOOLS.canlii_verify_citations!.description).toContain("n'établit NI son autorité");
    expect(TOOLS.canlii_verify_citations!.description).toContain("dispositif");
    // §7.2 : pas de recherche par mots du texte.
    expect(TOOLS.canlii_find_case!.description).toContain("n'expose pas le texte des décisions");
    // §7.3 : la fiche ne rend pas le texte.
    expect(TOOLS.canlii_get_case!.description).toContain("Ne renvoie PAS le texte");
    // §7.4 : listes brutes, aucun sens de traitement.
    expect(TOOLS.canlii_citator!.description).toContain("aucun sens de traitement");
    // §7.5 : ne remplace pas un citateur professionnel.
    expect(TOOLS.canlii_subsequent_history!.description).toContain(
      "NE REMPLACE PAS un citateur professionnel",
    );
    // §7.9 : renvoi au connecteur « Législation du Québec » pour le texte.
    expect(TOOLS.canlii_get_legislation!.description).toContain("Législation du Québec");
  });

  it("le citateur n'expose AUCUN paramètre lang (l'API n'accepte que « en »)", () => {
    expect(TOOLS.canlii_citator!.inputSchema.properties).not.toHaveProperty("lang");
  });
});

describe("§16.2 — l'étranglement est DIT, et jamais confondu avec un verdict", () => {
  it("le dit quand il a eu lieu, SANS déloger la mise en garde de §2", async () => {
    const client = fakeClient({ "caseBrowse/fr/csc-scc/2008scc9/": dunsmuir }, { throttled: 3 });
    const t = texte(
      await callTool(
        "canlii_verify_citations",
        { citations: [{ citation: "2008 CSC 9" }] },
        toolCtx(client),
      ),
    );
    expect(t).toContain("429");
    expect(t).toContain("étranglé");
    // Elle S'AJOUTE à la garde de §2, elle ne la remplace pas : l'une parle du
    // rythme, l'autre de ce que le résultat établit.
    expect(contient(t, GARDE_VERIFICATION)).toBe(true);
    expect(t).toContain("CONFIRMÉE");
  });

  it("dit que le résultat n'en est PAS affaibli — sinon la note se lit comme une réserve", async () => {
    const client = fakeClient({ "caseBrowse/fr/csc-scc/2008scc9/": dunsmuir }, { throttled: 1 });
    const t = texte(
      await callTool(
        "canlii_verify_citations",
        { citations: [{ citation: "2008 CSC 9" }] },
        toolCtx(client),
      ),
    );
    // Le mode de panne redouté : un modèle qui lit « étranglé » et en conclut que
    // la vérification est douteuse, ou pire, que la décision est introuvable.
    expect(t).toContain("ni tronqués ni affaiblis");
  });

  it("SE TAIT quand rien n'a été étranglé — une note constante cesse d'être lue", async () => {
    const client = fakeClient({ "caseBrowse/fr/csc-scc/2008scc9/": dunsmuir });
    const t = texte(
      await callTool(
        "canlii_verify_citations",
        { citations: [{ citation: "2008 CSC 9" }] },
        toolCtx(client),
      ),
    );
    expect(t).not.toContain("429");
    expect(t).not.toContain("étranglé");
    expect(contient(t, GARDE_VERIFICATION)).toBe(true);
  });

  it("canlii_find_case le dit aussi : c'est l'outil qui appelle le plus", async () => {
    const client = fakeClient({}, { throttled: 2 });
    const t = texte(
      await callTool(
        "canlii_find_case",
        { title: "Dunsmuir", database_id: "csc-scc" },
        toolCtx(client),
      ),
    );
    expect(t).toContain("429");
    expect(contient(t, GARDE_RECHERCHE)).toBe(true);
  });
});

describe("§2 conséquence n° 1 — la mise en garde est dans le CORPS de la réponse", () => {
  it("canlii_verify_citations la porte en pied, même sur un CONFIRMÉE", async () => {
    const client = fakeClient({ "caseBrowse/fr/csc-scc/2008scc9/": dunsmuir });
    const t = texte(
      await callTool(
        "canlii_verify_citations",
        { citations: [{ citation: "2008 CSC 9" }] },
        toolCtx(client),
      ),
    );
    expect(t).toContain("CONFIRMÉE");
    // §2 conséquence n° 3 : dans la MÊME sortie.
    expect(contient(t, GARDE_VERIFICATION)).toBe(true);
  });

  it("canlii_find_case la porte, même quand rien n'est trouvé", async () => {
    const client = fakeClient({});
    const t = texte(
      await callTool(
        "canlii_find_case",
        { title: "Untel c. Unetelle", database_id: "qcca", live: false },
        toolCtx(client),
      ),
    );
    expect(contient(t, GARDE_RECHERCHE)).toBe(true);
  });

  it("canlii_subsequent_history la porte EN TÊTE ET EN PIED", async () => {
    const client = fakeClient({
      "caseBrowse/fr/qcca/2005qcca304/": qcca2005,
      "caseCitator/en/qcca/2005qcca304/citingCases": { citingCases: [] },
    });
    const t = texte(
      await callTool("canlii_subsequent_history", { citation: "2005 QCCA 304" }, toolCtx(client)),
    );
    expect(contient(t, GARDE_SORTS_TETE)).toBe(true);
    expect(contient(t, GARDE_SORTS_PIED)).toBe(true);
    // La tête doit précéder le corps : la réserve se lit AVANT le résultat.
    expect(t.indexOf(GARDE_SORTS_TETE)).toBeLessThan(t.indexOf(GARDE_SORTS_PIED));
  });

  it("canlii_citator la porte", async () => {
    const client = fakeClient({
      "caseBrowse/fr/qcca/2005qcca304/": qcca2005,
      "caseCitator/en/qcca/2005qcca304/citedCases": { citedCases: [] },
    });
    const t = texte(
      await callTool(
        "canlii_citator",
        { citation: "2005 QCCA 304", rel: "cited" },
        toolCtx(client),
      ),
    );
    expect(contient(t, GARDE_CITATEUR)).toBe(true);
  });
});

describe("§2 conséquence n° 2 — un INTROUVABLE n'est jamais une négation d'existence", () => {
  it("énumère les explications concurrentes", async () => {
    const t = texte(
      await callTool(
        "canlii_verify_citations",
        { citations: [{ citation: "2020 QCCA 999999" }] },
        toolCtx(fakeClient({})),
      ),
    );
    expect(t).toContain("INTROUVABLE");
    expect(contient(t, EXPLICATIONS_INTROUVABLE)).toBe(true);
    expect(t).toContain("numéro erroné");
    expect(t).toContain("hors de la collection");
    expect(t).toContain("diffusion récente");
  });

  it("aucune sortie n'emploie une formulation interdite", async () => {
    const client = fakeClient({
      "caseBrowse/fr/csc-scc/2008scc9/": dunsmuir,
      "caseBrowse/fr/qcca/2005qcca304/": qcca2005,
    });
    const sorties = [
      texte(
        await callTool(
          "canlii_verify_citations",
          {
            citations: [
              { citation: "2008 CSC 9" },
              { citation: "2020 QCCA 999999" },
              { citation: "[1985] C.A. 105" },
              { citation: "voir l'arrêt de la Cour d'appel" },
            ],
          },
          toolCtx(client),
        ),
      ),
      texte(
        await callTool("canlii_parse_citation", { citation: "2020 QCCA 495" }, toolCtx(client)),
      ),
      texte(await callTool("canlii_get_case", { citation: "2008 CSC 9" }, toolCtx(client))),
      // §17 — les sorties du Québec obéissent à la MÊME interdiction, y compris sur
      // leurs chemins d'absence, qui sont précisément ceux où la tentation existe.
      texte(await callTool("palais_get", { greffe_number: "999" }, toolCtx(client))),
      texte(await callTool("palais_get", { greffe_number: "614" }, toolCtx(client))),
      texte(await callTool("palais_get", { palais: "Trifouillis" }, toolCtx(client))),
      texte(await callTool("palais_list", { district: "Vaudreuil" }, toolCtx(client))),
      texte(
        await callTool(
          "greffe_parse_court_file_number",
          { court_file_number: "999-99-1" },
          toolCtx(client),
        ),
      ),
    ];
    for (const s of sorties) {
      for (const interdite of FORMULATIONS_INTERDITES) {
        expect(s, `formulation interdite ${interdite}`).not.toMatch(interdite);
      }
    }
  });
});

/**
 * §17 — les tables du Québec ne viennent PAS de CanLII, et leur mode de panne n'est
 * pas l'absence mais la PÉREMPTION : une adresse juste hier, fausse aujourd'hui,
 * rendue avec le même aplomb dans les deux cas. La réserve datée est donc la seule
 * chose qui distingue un répertoire utile d'un répertoire dangereux.
 */
describe("§17 — les réserves des outils du Québec ne disparaissent pas", () => {
  it("TOUTE sortie palais_* porte la réserve de péremption ET sa date", async () => {
    const c = () => toolCtx(fakeClient({}));
    const sorties = [
      texte(await callTool("palais_list", {}, c())),
      texte(await callTool("palais_list", { district: "Montréal" }, c())),
      texte(await callTool("palais_list", { district: "Vaudreuil" }, c())), // vide
      texte(await callTool("palais_get", { greffe_number: "500" }, c())),
      texte(await callTool("palais_get", { greffe_number: "614" }, c())), // sans adresse
      texte(await callTool("palais_get", { greffe_number: "999" }, c())), // inconnu
      texte(await callTool("palais_get", { palais: "Montréal" }, c())),
      texte(await callTool("palais_get", { palais: "Trifouillis" }, c())), // introuvable
    ];
    for (const s of sorties) {
      expect(contient(s, GARDE_PALAIS), "réserve de péremption absente").toBe(true);
      expect(s).toContain("2026-07-15");
    }
  });

  it("toute sortie du parseur porte sa réserve de nomenclature", async () => {
    const c = () => toolCtx(fakeClient({}));
    for (const n of ["500-05-123456-241", "TAL-594531", "XYZ-1", "500", "999-99-1", "614-05-1"]) {
      const s = texte(
        await callTool("greffe_parse_court_file_number", { court_file_number: n }, c()),
      );
      expect(contient(s, GARDE_DOSSIER), `réserve absente pour « ${n} »`).toBe(true);
    }
  });

  it("une adresse INCONNUE n'est jamais rendue comme une adresse INEXISTANTE", async () => {
    // Le pendant exact de la règle INTROUVABLE. Formuler l'inconnu comme une absence
    // ferait renoncer un praticien à une démarche possible.
    //
    // 635 ne figure PLUS ici : la réconciliation du 2026-07-30 lui a trouvé une
    // adresse (Kuujjuaq, son siège fixe selon le MJQ). C'est la bonne façon de sortir
    // de cette liste — par une source, jamais en assouplissant la formulation.
    for (const numero of ["525", "614", "625", "640", "652", "715"]) {
      const s = texte(
        await callTool("palais_get", { greffe_number: numero }, toolCtx(fakeClient({}))),
      );
      expect(s, numero).toContain("Aucune adresse publiée");
      expect(contient(s, GARDE_SANS_ADRESSE), numero).toBe(true);
    }
  });

  it("l'absence de coordonnées est ANNONCÉE, non laissée à découvrir", async () => {
    const s = texte(
      await callTool("palais_get", { greffe_number: "500" }, toolCtx(fakeClient({}))),
    );
    expect(s).toContain("AUCUNE");
    expect(s).toContain("téléphone");
  });

  it("aucun nom de tribunal n'est DEVINÉ pour un préfixe inconnu", async () => {
    const s = texte(
      await callTool(
        "greffe_parse_court_file_number",
        { court_file_number: "ZZZZ-1" },
        toolCtx(fakeClient({})),
      ),
    );
    expect(s).toContain("NON répertorié");
    // Aucun des vingt forums connus ne doit apparaître dans une réponse « inconnu ».
    expect(s).not.toMatch(/Tribunal administratif|Cour fédérale|Cour suprême/);
  });

  it("les outils du Québec n'écrivent RIEN — pas même dans search_log (§9.5)", async () => {
    // Un numéro de dossier désigne un dossier EN COURS bien plus directement qu'une
    // citation. Les outils canlii_* consignent leur requête pour affiner l'analyseur ;
    // ceux-ci ne le font pas, et ce n'est pas un oubli. Sans ce test, un ajout de
    // télémétrie « par cohérence » se ferait sans que personne ne voie le glissement.
    const avant = await env.DB.prepare("SELECT COUNT(*) AS n FROM search_log").first<{
      n: number;
    }>();

    const c = () => toolCtx(fakeClient({}));
    await callTool(
      "greffe_parse_court_file_number",
      { court_file_number: "500-17-987654-321" },
      c(),
    );
    await callTool("palais_list", { district: "Montréal" }, c());
    await callTool("palais_get", { greffe_number: "500" }, c());

    const apres = await env.DB.prepare("SELECT COUNT(*) AS n FROM search_log").first<{
      n: number;
    }>();
    expect(apres?.n).toBe(avant?.n);
  });

  it("les outils du Québec ne prétendent JAMAIS venir de CanLII", async () => {
    const c = () => toolCtx(fakeClient({}));
    const sorties = [
      texte(await callTool("palais_list", {}, c())),
      texte(await callTool("palais_get", { greffe_number: "500" }, c())),
      texte(
        await callTool("greffe_parse_court_file_number", { court_file_number: "500-05-1" }, c()),
      ),
    ];
    for (const s of sorties) {
      expect(s).not.toMatch(/canlii\.ca|api\.canlii\.org/i);
      // Le renvoi À l'outil canlii_* reste permis ; l'attribution ne l'est pas.
      expect(s).not.toMatch(/selon CanLII|d'après CanLII|source : CanLII/i);
    }
  });
});

describe("§2 conséquence n° 4 — en cas d'écart, les DEUX valeurs brutes", () => {
  it("affiche l'attendu ET l'obtenu, verbatim", async () => {
    const client = fakeClient({ "caseBrowse/fr/qcca/2005qcca304/": qcca2005 });
    const t = texte(
      await callTool(
        "canlii_verify_citations",
        {
          citations: [
            {
              citation: "2005 QCCA 304",
              expected_title: "Syndicat des employés d'Hydro-Québec c. Hydro-Québec",
            },
          ],
        },
        toolCtx(client),
      ),
    );
    expect(t).toContain("Syndicat des employés d'Hydro-Québec c. Hydro-Québec");
    expect(t).toContain("Association provinciale des retraités d'Hydro-Québec c. Hydro-Québec");
  });

  it("affiche l'année attendue ET l'année obtenue", async () => {
    const client = fakeClient({ "caseBrowse/fr/qcca/2005qcca304/": qcca2005 });
    const t = texte(
      await callTool(
        "canlii_verify_citations",
        { citations: [{ citation: "2005 QCCA 304", expected_year: 2004 }] },
        toolCtx(client),
      ),
    );
    expect(t).toContain("DISCORDANTE");
    expect(t).toContain("2004");
    expect(t).toContain("2005");
  });
});

describe("§5.3 — la clef d'API ne quitte jamais le processus", () => {
  it("aucune sortie d'outil ne contient d'URL api.canlii.org", async () => {
    // Le client factice lève des 404 dont l'URL PORTE une clef : si un gestionnaire
    // recopiait le message d'erreur tel quel, la fuite apparaîtrait ici.
    const client = fakeClient({
      "caseBrowse/fr/csc-scc/2008scc9/": dunsmuir,
      "caseBrowse/fr/qcca/2005qcca304/": qcca2005,
    });
    const sorties = [
      texte(
        await callTool(
          "canlii_verify_citations",
          { citations: [{ citation: "2008 CSC 9" }, { citation: "2020 QCCA 999999" }] },
          toolCtx(client),
        ),
      ),
      texte(await callTool("canlii_get_case", { citation: "2020 QCCA 999999" }, toolCtx(client))),
      texte(
        await callTool(
          "canlii_find_case",
          { title: "Hydro-Québec", database_id: "qcca", live: false },
          toolCtx(client),
        ),
      ),
      texte(await callTool("canlii_list_databases", {}, toolCtx(client))),
    ];
    for (const s of sorties) {
      expect(s).not.toContain("api.canlii.org");
      expect(s).not.toContain("api_key");
      expect(s).not.toContain("SECRET");
    }
  });
});

describe("§7 — conventions communes", () => {
  it("une erreur d'exécution est un RÉSULTAT isError, jamais une erreur JSON-RPC", async () => {
    const r = await callTool("canlii_get_case", {}, toolCtx(fakeClient({})));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.type).toBe("text");
  });

  it("un outil inconnu se plaint en français sans lever", async () => {
    const r = await callTool("canlii_inexistant", {}, toolCtx(fakeClient({})));
    expect(r.isError).toBe(true);
    expect(texte(r)).toContain("Outil inconnu");
  });

  it("toutes les sorties sont du TEXTE, jamais du JSON structuré (D4)", async () => {
    const r = await callTool(
      "canlii_parse_citation",
      { citation: "2008 CSC 9" },
      toolCtx(fakeClient({})),
    );
    expect(r).not.toHaveProperty("structuredContent");
    expect(() => JSON.parse(texte(r))).toThrow();
  });
});
