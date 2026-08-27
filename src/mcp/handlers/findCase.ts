/**
 * `canlii_find_case` (spécification §7.2, annexe A.2).
 *
 * Index local d'abord, puis balayage vif. Tout ce qui est moissonné est PERSISTÉ
 * (décision D6) : c'est ainsi que l'index se construit — pas par téléchargement de
 * masse, mais par sédimentation des appels déjà faits.
 *
 * ⚠ La recherche porte sur l'INTITULÉ et les MOTS-CLÉS uniquement. L'API de CanLII
 *   n'expose pas le texte des décisions ; aucune recherche par mots du texte n'est
 *   possible. La sortie le dit à chaque fois (GARDE_RECHERCHE).
 */

import { describeError } from "../../canlii/client";
import { CanliiBudgetError } from "../../canlii/errors";
import type { CaseListResponse, Lang } from "../../canlii/types";
import { compareTitles } from "../../citation/compare";
import { persisterBalayages } from "../../config";
import { pluriel, troncature } from "../../format/fr";
import {
  document,
  GARDE_RECHERCHE,
  ligneCandidat,
  noteEtranglement,
  provenance,
} from "../../format/render";
import { type CaseRow, rowFromListItem, searchLocal, upsertCases } from "../../store/cases";
import { flushUsage, logSearch } from "../../store/telemetry";
import type { ToolContext } from "../registry";
import { err, ok, type ToolResult } from "../rpc";

/** Bases québécoises usuelles, balayées quand aucun tribunal n'est précisé (§7.2). */
const BASES_QC_USUELLES = ["qcca", "qccs", "qccq"];

/** Fenêtre maximale sans tribunal précisé (§7.2 point 4). */
const FENETRE_MAX_SANS_TRIBUNAL = 3;

/**
 * `resultCount = 5000` et non le maximum de 10 000 de l'API : marge sous le plafond
 * de charge utile de 10 Mo (annexe B).
 */
const PAGE = 5000;

export async function findCase(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const titre = String(args.title ?? "").trim();
  const databaseId = (args.database_id as string | undefined)?.trim() || null;
  const lang = (args.lang as Lang) ?? "fr";
  const limit = Math.min(Math.max((args.limit as number) ?? 10, 1), 25);
  const now = ctx.now ?? new Date();

  const anneeCourante = now.getUTCFullYear();
  const yearFrom = (args.year_from as number | undefined) ?? null;
  const yearTo = (args.year_to as number | undefined) ?? null;

  if (yearFrom && yearTo && yearFrom > yearTo) {
    return err("« year_from » doit être antérieure ou égale à « year_to ».");
  }

  // ── 1. Index local ───────────────────────────────────────────────────────
  const locales = await searchLocal(ctx.db, titre, {
    databaseId,
    yearFrom,
    yearTo,
    limit: limit * 2,
  });

  // Défaut de `live` : vrai lorsque l'index rend moins de trois candidats (§7.2).
  const live = args.live === undefined ? locales.length < 3 : args.live === true;

  let parcourues = 0;
  let appels = 0;
  let vives: CaseRow[] = [];
  let noteBalayage: string | null = null;
  let budgetEpuise = false;

  if (live) {
    // Sans tribunal précisé : fenêtre d'au plus 3 ans et bases québécoises usuelles.
    const bases = databaseId ? [databaseId] : BASES_QC_USUELLES;
    const debut = yearFrom ?? (yearTo ? yearTo - FENETRE_MAX_SANS_TRIBUNAL + 1 : anneeCourante - 2);
    const fin = yearTo ?? anneeCourante;
    const etendue = fin - debut + 1;

    if (!databaseId && etendue > FENETRE_MAX_SANS_TRIBUNAL) {
      return err(
        `Sans « database_id », la fenêtre de dates ne peut pas dépasser ${FENETRE_MAX_SANS_TRIBUNAL} ans ` +
          `(demandée : ${etendue} ans, ${debut}→${fin}). Préciser le tribunal (voir canlii_list_databases) ` +
          "ou resserrer year_from / year_to.",
      );
    }

    try {
      const r = await balayer(ctx, bases, debut, fin, lang, titre, now);
      vives = r.retenues;
      parcourues = r.parcourues;
      appels = r.appels;
      budgetEpuise = r.budgetEpuise;
    } catch (e) {
      noteBalayage = `Balayage interrompu — ${describeError(e)}`;
    } finally {
      await flushUsage(ctx.db, ctx.client.usage(), now);
    }
  }

  // ── 3. Fusion et classement ──────────────────────────────────────────────
  const parClef = new Map<string, CaseRow>();
  for (const r of [...locales, ...vives]) parClef.set(`${r.database_id}/${r.case_id}`, r);
  const tous = [...parClef.values()].sort(
    (a, b) =>
      similarite(titre, b.title) - similarite(titre, a.title) ||
      (b.decision_date ?? "").localeCompare(a.decision_date ?? ""),
  );
  const rendus = tous.slice(0, limit);

  await logSearch(ctx.db, {
    tool: "canlii_find_case",
    query: titre,
    database_id: databaseId,
    lang,
    result_count: rendus.length,
    fallback: live ? "sweep" : null,
  });

  const prov = provenance({
    locales: locales.length,
    appels,
    parcourues,
    persistees: persisterBalayages(ctx.env),
  });

  if (rendus.length === 0) {
    return ok(
      [
        `Aucun candidat pour « ${titre} »${databaseId ? ` (${databaseId})` : ""}${fenetreLabel(yearFrom, yearTo)}.`,
        "",
        prov,
        noteBalayage,
        budgetEpuise ? "Budget d'appels épuisé — résultat partiel." : null,
        // ⚠ C'EST ICI QUE LA NOTE COMPTE LE PLUS. « Aucun candidat » PLUS un
        //   étranglement, c'est exactement la configuration où un modèle conclut à
        //   l'inexistence d'une décision alors que des appels ont été refusés. Le
        //   paragraphe qui suit énumère déjà les explications concurrentes ; celle-ci
        //   en est une, et elle est la seule que le connecteur puisse CONSTATER.
        noteEtranglement(ctx.client.usage().throttled) || null,
        "",
        "Une absence de candidat n'établit pas l'inexistence de la décision : la couverture",
        "de CanLII a des bornes historiques, et la diffusion connaît un délai.",
        "",
        GARDE_RECHERCHE,
      ]
        .filter((s): s is string => s !== null)
        .join("\n"),
    );
  }

  const entete =
    `${pluriel(rendus.length, "candidat", "candidats")} pour « ${titre} »` +
    `${databaseId ? ` (${databaseId}` : " ("}${fenetreLabel(yearFrom, yearTo, true)}) :`;

  const tronque = troncature(rendus.length, tous.length);
  const pied = [
    prov,
    tronque ? `Troncature : ${tronque}.` : null,
    noteBalayage,
    budgetEpuise ? "Budget d'appels épuisé — résultat partiel." : null,
    // Le balayage est l'outil qui appelle le plus : c'est ici qu'un étranglement
    // se lit le plus facilement comme « rien trouvé ». On le nomme.
    noteEtranglement(ctx.client.usage().throttled) || null,
    "",
    GARDE_RECHERCHE,
  ]
    .filter((s): s is string => s !== null)
    .join("\n");

  return ok(document(entete, rendus.map(ligneCandidat), pied));
}

function fenetreLabel(from: number | null, to: number | null, nu = false): string {
  if (!from && !to) return nu ? "toutes années" : "";
  const f = from ?? "…";
  const t = to ?? "…";
  return nu ? `${f}→${t}` : ` (${f}→${t})`;
}

function similarite(requete: string, titre: string): number {
  return compareTitles(requete, titre).jaccard;
}

/**
 * Balaie CanLII année par année, page par page.
 *
 * Chaque page est UNE sous-requête. Le budget d'appels de l'invocation est le vrai
 * plafond : quand il tombe, on rend les résultats PARTIELS obtenus plutôt qu'une
 * erreur sèche (§5.2) — le travail déjà payé en appels réseau ne doit pas être perdu.
 */
async function balayer(
  ctx: ToolContext,
  bases: string[],
  debut: number,
  fin: number,
  lang: Lang,
  titre: string,
  now: Date,
): Promise<{ retenues: CaseRow[]; parcourues: number; appels: number; budgetEpuise: boolean }> {
  const retenues: CaseRow[] = [];
  let parcourues = 0;
  const avant = ctx.client.callsMade();
  let budgetEpuise = false;

  const persister = persisterBalayages(ctx.env);

  boucle: for (const base of bases) {
    for (let annee = fin; annee >= debut; annee--) {
      let offset = 0;
      for (;;) {
        if (ctx.client.remaining() === 0) {
          budgetEpuise = true;
          break boucle;
        }
        let page: CaseListResponse;
        try {
          page = await ctx.client.get<CaseListResponse>(`caseBrowse/${lang}/${base}/`, {
            offset,
            resultCount: PAGE,
            decisionDateAfter: `${annee}-01-01`,
            decisionDateBefore: `${annee}-12-31`,
          });
        } catch (e) {
          if (e instanceof CanliiBudgetError) {
            budgetEpuise = true;
            break boucle;
          }
          throw e;
        }
        const items = page.cases ?? [];
        if (items.length === 0) break;
        parcourues += items.length;

        const lignes = items
          .map((it) => rowFromListItem(it, base, lang, "sweep", now))
          .filter((r): r is CaseRow => r !== null)
          .map((r) => ({ ...r, decision_date: r.decision_date ?? `${annee}-01-01` }));

        // D6 : tout balayage est persisté. C'est ainsi que l'index se construit.
        if (persister) await upsertCases(ctx.db, lignes);

        for (const l of lignes) {
          const c = compareTitles(titre, l.title);
          if (c.verdict !== "discordance") retenues.push(l);
        }

        if (items.length < PAGE) break;
        offset += items.length;
      }
    }
  }

  return { retenues, parcourues, appels: ctx.client.callsMade() - avant, budgetEpuise };
}
