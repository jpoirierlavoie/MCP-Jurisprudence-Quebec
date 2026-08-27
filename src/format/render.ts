/**
 * Gabarits de sortie (spécification annexe A) et MISES EN GARDE du contrat de
 * vérité (§2).
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║ Les constantes de mise en garde ci-dessous sont IMPOSÉES.                     ║
 * ║                                                                              ║
 * ║ §2 exige qu'elles vivent dans le CORPS DE LA RÉPONSE, et pas seulement dans   ║
 * ║ la description de l'outil : une description n'est lue qu'une fois, une sortie ║
 * ║ est lue à chaque appel. Elles sont verrouillées par `test/garde.test.ts`, qui ║
 * ║ échoue si une refonte de gabarit les fait disparaître — le mode de panne      ║
 * ║ redouté n'étant pas l'erreur, mais le SILENCE.                                ║
 * ║                                                                              ║
 * ║ Ne pas reformuler. Un vérificateur de citations qui promet plus qu'il ne      ║
 * ║ tient est pire qu'aucun outil : il transforme une incertitude connue en       ║
 * ║ fausse assurance, dans un contexte où la sanction est déontologique.          ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import type { CaseRow } from "../store/cases";
import { dateFr, joindre, motsCles, nombreFr, ou } from "./fr";

// ── Mises en garde imposées (§2) ──────────────────────────────────────────────

/** Pied de `canlii_verify_citations` — annexe A.1, verbatim. */
export const GARDE_VERIFICATION =
  "Établit l'existence et l'identité, jamais l'autorité actuelle (aucun historique\n" +
  "d'appel, aucun indicateur de traitement) ni le contenu du dispositif.";

/** Pied de `canlii_find_case` — annexe A.2, verbatim. */
export const GARDE_RECHERCHE =
  "Recherche sur l'intitulé et les mots-clés uniquement — l'API de CanLII n'expose\n" +
  "pas le texte des décisions.";

/** Tête de `canlii_subsequent_history` — annexe A.3, verbatim. */
export const GARDE_SORTS_TETE = "Sorts ultérieurs — INDICE HEURISTIQUE, à vérifier à la source.";

/** Pied de `canlii_subsequent_history` — annexe A.3, verbatim. */
export const GARDE_SORTS_PIED =
  "Ce résultat n'indique NI le sens du traitement (confirmée, infirmée, distinguée),\n" +
  "NI les pourvois pendants, NI les refus de permission d'appeler. Ce n'est pas un\n" +
  "citateur professionnel.";

/** Pied du citateur (§7.4). */
export const GARDE_CITATEUR =
  "Listes brutes : elles n'indiquent AUCUN sens de traitement (suivi, distingué,\n" +
  "infirmé). Pour les dispositions québécoises, enchaîner avec le connecteur\n" +
  "« Législation du Québec » afin d'en lire le texte officiel.";

/**
 * Note d'ÉTRANGLEMENT — rendue seulement quand CanLII a effectivement refusé des
 * appels pendant CETTE invocation.
 *
 * ⚠ CE N'EST PAS UNE MISE EN GARDE DE §2, et il ne faut pas la confondre avec une.
 *   Les mises en garde bornent ce qu'un résultat ÉTABLIT ; celle-ci ne dit rien de la
 *   vérité du résultat — les appels étranglés ont été rejoués, et un verdict rendu
 *   reste un verdict rendu. Elle parle de RYTHME.
 *
 *   Elle existe quand même, et pour un motif de §2 : sans elle, un modèle qui voit un
 *   appel lent, ou un résultat partiel, n'a aucun moyen de distinguer « CanLII m'a
 *   demandé de ralentir » de « la collection ne contient rien ». La seconde lecture
 *   est précisément l'erreur que ce connecteur existe pour empêcher. On nomme donc la
 *   cause plutôt que de la laisser deviner.
 *
 *   Muette quand rien n'a été étranglé : une note affichée à chaque appel cesse
 *   d'être lue, et celle-ci doit l'être le jour où elle paraît.
 */
export function noteEtranglement(etranglements: number): string {
  if (etranglements <= 0) return "";
  const pluriel = etranglements > 1 ? "appels" : "appel";
  return [
    `CanLII a étranglé ${nombreFr(etranglements)} ${pluriel} pendant cet appel (HTTP 429).`,
    "Ils ont été rejoués et le rythme a été réduit d'office : les résultats ci-dessus",
    "ne sont ni tronqués ni affaiblis par ce fait. Un lot plus petit, ou repris plus",
    "tard, s'exécutera plus vite.",
  ].join("\n");
}

/** Rappel du délai de diffusion, employé par `canlii_browse_cases` (§7.6). */
export const GARDE_DIFFUSION =
  "La diffusion sur CanLII connaît un délai : prévoir un jeu de deux jours sur les\n" +
  "filtres de date de diffusion.";

/**
 * Marqueur de la réconciliation exigée par §4.3.
 *
 * ⚠ Chaîne de COUPLAGE : `scripts/refresh-databases.mjs` la cherche dans la sortie de
 *   `canlii_list_databases` pour décider si le répertoire est livrable. La reformuler
 *   sans toucher au script produirait un FEU VERT MENSONGER sur la seule barrière que
 *   §4.3 qualifie de bloquante. Épinglée par test/tools.test.ts.
 */
export const MARQUEUR_RECONCILIATION = "⚠ RÉCONCILIATION REQUISE";

/** Explications concurrentes d'un INTROUVABLE (§2, conséquence n° 2). */
export const EXPLICATIONS_INTROUVABLE =
  "Explications possibles : numéro erroné · décision hors de la collection ·\n" +
  "diffusion récente (prévoir un jeu de 2 jours).";

// ── Mises en garde des tables du Québec (§17) ─────────────────────────────────
//
// Les trois constantes ci-dessous obéissent à la MÊME règle que celles de CanLII
// ci-dessus, pour une raison différente : les tables `src/qc/` ne viennent PAS de
// CanLII, elles sont un relevé daté du ministère de la Justice du Québec. Leur
// mode de panne n'est pas l'absence mais la PÉREMPTION — une adresse juste hier,
// fausse aujourd'hui, et rendue avec le même aplomb dans les deux cas.

/**
 * Pied imposé de toute sortie `palais_*`. Porte la DATE du relevé : sans elle, le
 * lecteur ne peut pas juger du risque qu'il prend.
 */
export const GARDE_PALAIS =
  "Adresses relevées auprès du ministère de la Justice du Québec le 2026-07-15.\n" +
  "Les palais de justice déménagent : VÉRIFIER la liste officielle du Ministère\n" +
  "avant toute signification ou tout dépôt.";

/**
 * Adresse absente — le pendant exact de la règle INTROUVABLE de §2.
 *
 * ⚠ « Aucune adresse publiée » n'est PAS « il n'existe pas d'adresse ». Six greffes
 *   sont concernés, dont quatre cours itinérantes qui siègent là où la cour se
 *   déplace. Formuler l'inconnu comme une absence ferait renoncer un praticien à
 *   une démarche possible.
 */
export const GARDE_SANS_ADRESSE =
  "Cela n'établit PAS qu'il n'en existe aucune : ce greffe siège en cour itinérante,\n" +
  "ou son adresse n'a pas été relevée. La demander au ministère de la Justice.";

/** Pied imposé de `greffe_parse_court_file_number`. */
export const GARDE_DOSSIER =
  "Cet outil lit une NOMENCLATURE : il n'établit pas que ce dossier existe, ni qu'il\n" +
  "est actif. Les positions 7 et suivantes (séquence et contrôle) ne sont pas\n" +
  "analysées — aucune somme de contrôle n'est vérifiée.";

// ── Rendu d'une fiche ─────────────────────────────────────────────────────────

/**
 * Hyperlien public. On ne rend JAMAIS d'URL `api.canlii.org` (§5.3) : uniquement
 * l'hyperlien `canlii.ca` que l'API fournit.
 */
export function lien(row: { url: string | null }): string | null {
  const u = (row.url ?? "").trim();
  if (u.length === 0) return null;
  return u.includes("api.canlii.org") ? null : u;
}

/**
 * Bloc d'identité d'une décision, tel qu'à l'annexe A.1 :
 *
 *   Dunsmuir c. Nouveau-Brunswick
 *   [2008] 1 RCS 190, 2008 CSC 9 (CanLII) · csc-scc · 2008-03-07
 *   N° de dossier : 31459
 *   Mots-clés : équité procédurale — raisonnabilité — …
 *   https://canlii.ca/t/1vxsn
 */
export function ficheDecision(row: CaseRow, options: { avecIds?: boolean } = {}): string {
  const lignes: string[] = [row.title];
  lignes.push(
    joindre([
      ou(row.citation, row.neutral_cite ?? "—"),
      row.database_id,
      dateFr(row.decision_date),
    ]),
  );
  if (options.avecIds) lignes.push(`Identifiants : ${row.database_id} / ${row.case_id}`);
  if (row.docket_number) lignes.push(`N° de dossier : ${row.docket_number}`);
  const mc = motsCles(row.keywords);
  if (mc) lignes.push(`Mots-clés : ${mc}`);
  const l = lien(row);
  if (l) lignes.push(l);
  return lignes.join("\n");
}

/** Ligne compacte d'une décision dans une liste de candidats (annexe A.2). */
export function ligneCandidat(row: CaseRow): string {
  const lignes: string[] = [row.title];
  lignes.push(
    joindre([
      ou(row.citation, row.neutral_cite ?? "—"),
      dateFr(row.decision_date),
      `${row.database_id}/${row.case_id}`,
    ]),
  );
  const l = lien(row);
  if (l) lignes.push(l);
  return lignes.join("\n");
}

/** Numérote un bloc et indente ses lignes de continuation (annexe A). */
export function numeroter(index: number, bloc: string): string {
  const lignes = bloc.split("\n");
  const tete = `${index}. ${lignes[0] ?? ""}`;
  const suite = lignes.slice(1).map((l) => (l.length > 0 ? `   ${l}` : l));
  return [tete, ...suite].join("\n");
}

/** Assemble un document : titre, blocs numérotés, pied de mise en garde. */
export function document(entete: string, blocs: string[], pied?: string | null): string {
  const corps = blocs.map((b, i) => numeroter(i + 1, b)).join("\n\n");
  return [entete, corps, pied ?? ""].filter((s) => s.trim().length > 0).join("\n\n");
}

/** Mention de provenance et de coût d'un balayage (annexe A.2). */
export function provenance(opts: {
  locales: number;
  appels: number;
  parcourues: number;
  persistees: boolean;
}): string {
  if (opts.appels === 0) {
    return `Provenance : index local (${nombreFr(opts.locales)} fiche(s)), aucun appel à CanLII.`;
  }
  const persist = opts.persistees ? ", persistées" : "";
  return (
    `Provenance : index local (${nombreFr(opts.locales)} fiche(s)) + balayage vif ` +
    `(${nombreFr(opts.appels)} appel(s), ${nombreFr(opts.parcourues)} fiche(s) parcourues${persist}).`
  );
}
