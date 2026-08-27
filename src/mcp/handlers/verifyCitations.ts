/**
 * `canlii_verify_citations` — L'OUTIL PIVOT (spécification §7.1, annexe A.1).
 *
 * Cinq verdicts : CONFIRMÉE · DISCORDANTE · INTROUVABLE · NON CONSTRUCTIBLE · ILLISIBLE.
 *
 * Les quatre conséquences du contrat de vérité (§2) sont ici, et chacune est
 * verrouillée par `test/garde.test.ts` :
 *   1. la mise en garde figure dans le CORPS de la réponse, pas seulement dans la
 *      description de l'outil ;
 *   2. un INTROUVABLE n'est JAMAIS formulé comme « cette décision n'existe pas » : il
 *      énumère les explications concurrentes ;
 *   3. un CONFIRMÉE porte, dans la MÊME sortie, la phrase indiquant qu'il n'établit ni
 *      l'autorité actuelle ni le dispositif ;
 *   4. en cas d'écart, les valeurs BRUTES de CanLII sont toujours affichées — le
 *      praticien tranche, l'outil ne masque pas.
 */

import { describeError } from "../../canlii/client";
import type { Lang } from "../../canlii/types";
import { compareTitles } from "../../citation/compare";
import { formLabel, parseCitation, resolve } from "../../citation/parse";
import { dateFr, pluriel } from "../../format/fr";
import {
  EXPLICATIONS_INTROUVABLE,
  ficheDecision,
  GARDE_VERIFICATION,
  noteEtranglement,
  numeroter,
} from "../../format/render";
import { type CaseRow, searchLocal } from "../../store/cases";
import { loadDirectory } from "../../store/databases";
import { lookupCase } from "../../store/lookup";
import { flushUsage, logSearchBatch } from "../../store/telemetry";
import type { ToolContext } from "../registry";
import { ok, type ToolResult } from "../rpc";

type Verdict =
  | "CONFIRMÉE"
  | "DISCORDANTE"
  | "INTROUVABLE"
  | "NON CONSTRUCTIBLE"
  | "ILLISIBLE"
  | "INDÉTERMINÉE";

interface Demande {
  citation: string;
  expected_title?: string;
  expected_year?: number;
}

export async function verifyCitations(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const demandes = (args.citations ?? []) as Demande[];
  const lang = (args.lang as Lang) ?? "fr";
  const refresh = args.refresh === true;
  const now = ctx.now ?? new Date();
  const dir = await loadDirectory(ctx.db);
  const connus = (code: string) => dir.courtCodes.has(code);

  const blocs: string[] = [];
  const journal: Parameters<typeof logSearchBatch>[1] = [];
  let budgetEpuise = false;

  for (const d of demandes) {
    const citation = String(d.citation ?? "").trim();
    const parsed = parseCitation(citation, connus);
    const res = resolve(parsed.primary, dir);

    // ── ILLISIBLE ──────────────────────────────────────────────────────────
    if (parsed.primary.kind === "unparsed") {
      blocs.push(
        [
          `${citation} — ILLISIBLE`,
          "Aucune forme de citation reconnue (ni citation neutre, ni citation attribuée",
          "par CanLII, ni recueil, ni identifiant d'éditeur).",
          "→ Fournir la citation neutre, ou les noms des parties et l'année à canlii_find_case.",
        ].join("\n"),
      );
      journal.push({
        tool: "canlii_verify_citations",
        query: citation,
        lang,
        result_count: 0,
        verdict: "ILLISIBLE",
      });
      continue;
    }

    // ── NON CONSTRUCTIBLE (recueils, éditeurs, CanLII sans parenthèses) ────
    if (
      parsed.primary.kind === "reporter" ||
      parsed.primary.kind === "publisher" ||
      res.constructible === "non"
    ) {
      const lignes = [`${citation} — NON CONSTRUCTIBLE`, res.raison];
      // §7.1 étape 1 : si `expected_title` est fourni, enchaîner AUTOMATIQUEMENT une
      // recherche bornée et proposer les candidats. Le balayage vif est exclu ici :
      // il faut rester dans le budget d'une vérification par lot.
      if (d.expected_title) {
        const bornes = d.expected_year
          ? { yearFrom: d.expected_year - 1, yearTo: d.expected_year + 1 }
          : {};
        const candidats = await searchLocal(ctx.db, d.expected_title, { ...bornes, limit: 5 });
        if (candidats.length > 0) {
          lignes.push(
            "",
            `Candidats de l'index local (${pluriel(candidats.length, "fiche", "fiches")}) :`,
          );
          for (const c of candidats) {
            lignes.push(
              `  · ${c.title} — ${c.citation ?? c.neutral_cite ?? "—"} (${dateFr(c.decision_date)})`,
            );
          }
          lignes.push(
            "→ Confirmer avec canlii_find_case (balayage vif) puis canlii_verify_citations.",
          );
        } else {
          lignes.push(
            "",
            `→ Fournir les noms des parties et l'année à canlii_find_case (rien dans l'index local pour « ${d.expected_title} »).`,
          );
        }
      } else {
        lignes.push("→ Fournir les noms des parties et l'année à canlii_find_case.");
      }
      blocs.push(lignes.join("\n"));
      journal.push({
        tool: "canlii_verify_citations",
        query: citation,
        lang,
        result_count: 0,
        verdict: "NON CONSTRUCTIBLE",
        fallback: parsed.primary.kind,
      });
      continue;
    }

    // ── Résolution, avec la boucle d'auto-correction (§6.4) ────────────────
    const form = parsed.primary as import("../../citation/parse").ResolvableForm;
    let lookup: Awaited<ReturnType<typeof lookupCase>>;
    try {
      lookup = await lookupCase(form, res, {
        db: ctx.db,
        client: ctx.client,
        dir,
        lang,
        refresh,
        now,
      });
    } catch (e) {
      blocs.push(`${citation} — INDÉTERMINÉE\n${describeError(e)}`);
      journal.push({
        tool: "canlii_verify_citations",
        query: citation,
        lang,
        result_count: 0,
        verdict: "INDÉTERMINÉE",
        fallback: "exception",
      });
      continue;
    }

    if (lookup.status === "budget") {
      budgetEpuise = true;
      blocs.push(
        `${citation} — INDÉTERMINÉE\nBudget d'appels épuisé : cette citation n'a pas pu être vérifiée.`,
      );
      journal.push({
        tool: "canlii_verify_citations",
        query: citation,
        lang,
        result_count: 0,
        verdict: "INDÉTERMINÉE",
        fallback: "budget",
      });
      continue;
    }

    if (lookup.status === "erreur") {
      // Une panne réseau n'est PAS une absence : la présenter en INTROUVABLE
      // affirmerait un fait qu'on n'a pas constaté.
      blocs.push(
        `${citation} — INDÉTERMINÉE\nCanLII n'a pas pu être interrogé. Ce n'est PAS un constat d'absence : réessayer.`,
      );
      journal.push({
        tool: "canlii_verify_citations",
        query: citation,
        lang,
        result_count: 0,
        verdict: "INDÉTERMINÉE",
        fallback: lookup.fallback,
      });
      continue;
    }

    if (lookup.status === "base_inconnue") {
      blocs.push(
        [`${citation} — INTROUVABLE`, lookup.message ?? "", EXPLICATIONS_INTROUVABLE]
          .filter(Boolean)
          .join("\n"),
      );
      journal.push({
        tool: "canlii_verify_citations",
        query: citation,
        lang,
        result_count: 0,
        verdict: "INTROUVABLE",
        database_id: res.databaseId,
        fallback: "unknown_court",
      });
      continue;
    }

    if (lookup.status === "introuvable" || !lookup.row) {
      blocs.push(
        [
          `${citation} — INTROUVABLE`,
          `Forme ${parsed.primary.kind === "neutral" ? "neutre" : "attribuée par CanLII"} bien formée (${res.databaseId} / ${res.caseId}), mais aucune fiche.`,
          EXPLICATIONS_INTROUVABLE,
        ].join("\n"),
      );
      journal.push({
        tool: "canlii_verify_citations",
        query: citation,
        lang,
        result_count: 0,
        verdict: "INTROUVABLE",
        database_id: res.databaseId,
        fallback: lookup.fallback,
      });
      continue;
    }

    // ── Comparaison : intitulé (§6.5) et année ────────────────────────────
    const row = lookup.row;
    const ecarts = comparer(row, d);
    const verdict: Verdict = ecarts.length === 0 ? "CONFIRMÉE" : "DISCORDANTE";
    blocs.push(rendreFiche(citation, verdict, row, ecarts, parsed.parallel.map(formLabel)));
    journal.push({
      tool: "canlii_verify_citations",
      query: citation,
      lang,
      result_count: 1,
      verdict,
      database_id: row.database_id,
      fallback: lookup.fallback,
    });
  }

  await logSearchBatch(ctx.db, journal);
  await flushUsage(ctx.db, ctx.client.usage(), now);

  const entete = `Vérification de ${pluriel(demandes.length, "citation", "citations")} — collection CanLII.`;
  const corps = blocs.map((b, i) => numeroter(i + 1, b)).join("\n\n");
  // La note de rythme précède la mise en garde de §2 et ne s'y substitue jamais :
  // l'une parle de ce que le résultat établit, l'autre du temps qu'il a pris.
  const pied = [
    budgetEpuise ? "Budget d'appels épuisé — résultat partiel." : "",
    noteEtranglement(ctx.client.usage().throttled),
    GARDE_VERIFICATION,
  ]
    .filter((p) => p.length > 0)
    .join("\n\n");

  return ok([entete, corps, pied].join("\n\n"));
}

interface Ecart {
  champ: string;
  attendu: string;
  obtenu: string;
  note: string;
}

/**
 * Compare l'attendu et l'obtenu.
 *
 * ⚠ Un appariement PARTIEL vaut DISCORDANTE, jamais CONFIRMÉE (§6.5). Mieux vaut un
 *   faux signalement qu'une fausse assurance.
 */
function comparer(row: CaseRow, d: Demande): Ecart[] {
  const ecarts: Ecart[] = [];

  if (d.expected_title) {
    const c = compareTitles(d.expected_title, row.title);
    if (c.verdict !== "appariement") {
      ecarts.push({
        champ: "Intitulé",
        attendu: d.expected_title,
        obtenu: row.title,
        note:
          c.verdict === "partiel"
            ? `appariement partiel (indice ${c.jaccard.toFixed(2).replace(".", ",")}) — traité comme une discordance`
            : "discordance",
      });
    }
  }

  if (d.expected_year && row.decision_date) {
    const annee = Number(row.decision_date.slice(0, 4));
    if (Number.isFinite(annee) && annee !== d.expected_year) {
      ecarts.push({
        champ: "Année",
        attendu: String(d.expected_year),
        obtenu: String(annee),
        note: `date complète chez CanLII : ${dateFr(row.decision_date)}`,
      });
    }
  }

  return ecarts;
}

function rendreFiche(
  citation: string,
  verdict: Verdict,
  row: CaseRow,
  ecarts: Ecart[],
  paralleles: string[],
): string {
  const lignes = [`${citation} — ${verdict}`];

  // §2 conséquence n° 4 : en cas d'écart, les DEUX valeurs, toujours.
  for (const e of ecarts) {
    lignes.push(`${e.champ} attendu : « ${e.attendu} »`);
    lignes.push(`${e.champ} obtenu  : « ${e.obtenu} »`);
    lignes.push(`(${e.note})`);
  }

  lignes.push(ficheDecision(row));

  if (paralleles.length > 0) {
    lignes.push(`Formes parallèles dans la citation soumise : ${paralleles.join(" ; ")}`);
  }

  if (verdict === "DISCORDANTE") {
    lignes.push(
      "→ La citation existe mais ne désigne pas la décision annoncée. Vérifier la source.",
    );
  }

  return lignes.join("\n");
}
