# CLAUDE.md — Jurisprudence canadienne et greffes du Québec

Connecteur MCP exposant la REST API de CanLII, **plus trois outils hors ligne sur les
greffes et palais du Québec** : `https://jurisprudence.poirierlavoie.ca/mcp/<secret>`.
Propriétaire : Jason Poirier Lavoie (avocat, Québec). **C'est un outil juridique : un
résultat faux rendu en silence est le pire défaut possible — refuser vaut toujours mieux
que deviner.**

La spécification qui fait foi est [`SPEC_CANLII_MCP.md`](SPEC_CANLII_MCP.md), versionnée à la
racine. Ses §1 (décisions arrêtées) et §2 (contrat de vérité) se lisent **avant** toute
modification.

---

## ⚠ RÈGLE DE PROPAGATION — obligatoire, sans exception

```
╔═════════════════════════════════════════════════════════════════════════════╗
║ AUCUNE modification de ce depot n'est terminee tant que ses repercussions   ║
║ n'ont pas ete EVALUEES sur les cinq surfaces ci-dessous, et INCLUSES dans   ║
║ le MEME changement.                                                         ║
║                                                                             ║
║   1. les OUTILS MCP (registre, gestionnaires, familles de prefixes)         ║
║   2. leurs DESCRIPTIONS et leurs titres                                     ║
║   3. leurs SCHEMAS d'entree                                                 ║
║   4. README.md                                                              ║
║   5. la PAGE PUBLIQUE (src/site.ts + src/site.i18n.ts) et §18               ║
╚═════════════════════════════════════════════════════════════════════════════╝
```

**Le motif.** Ces cinq surfaces décrivent la MÊME chose à cinq publics : le modèle, le
praticien, le lecteur de la spécification, le visiteur de la page, et le prochain
contributeur. Quand l'une prend du retard, elle ne tombe pas en panne — **elle continue
de répondre, avec assurance, quelque chose de faux**. Un outil renommé dont le README
garde l'ancien nom, un schéma resserré que la page annonce encore large, une réserve
retirée du corps mais laissée en vitrine : aucun de ces défauts ne lève d'erreur. C'est
exactement le mode de panne que §2 interdit, déplacé dans la documentation.

**Le coût en jetons de cette vérification est ASSUMÉ et n'est pas un motif de l'abréger.**
Relire quatre fichiers coûte moins qu'un praticien qui se fie à une description périmée.

**Une SIXIÈME surface vit hors de ce dépôt, et aucune commande d'ici ne la voit dériver.**
Le clavardage de Pallas Athéna offre les mêmes treize outils à son modèle depuis
`athena/chat/worker_tools.py`, engendré depuis `tools/list` (§19). Un outil renommé ici
laisse là-bas une fiche qui appelle un nom mort — et l'échec n'apparaît qu'au tour de
clavardage suivant, sous la forme d'un outil qui « ne marche plus ». Après tout ajout,
retrait ou renommage : relancer `athena/scripts/sync_worker_tools.py`.

### Table de propagation

| Si vous touchez… | …vérifiez ET mettez à jour |
|---|---|
| **un outil** (ajout, retrait, renommage) | `src/mcp/registry.ts` · le gestionnaire dans `src/mcp/handlers/` · `OUTILS_EN` dans `src/site.i18n.ts` (parité testée **dans les deux sens**) · le tableau ET le compte de `README.md` §« Les treize outils » · §7 ou §17 de la spécification · les compteurs de `test/garde.test.ts` et `test/rpc.test.ts` · la **liste triée des noms** dans `test/rpc.test.ts` · le préfixe choisi (`canlii_` = réponse de CanLII ; `greffe_`/`palais_` = table locale — invariant 16) · **hors dépôt** : `athena/chat/worker_tools.py`, à réengendrer par `athena/scripts/sync_worker_tools.py` (§19) |
| **une description ou un titre** | la page les rend **verbatim** : relancer `test/site.test.ts` (formulations interdites) et `test/garde.test.ts` (sous-chaînes épinglées) · `OUTILS_EN` doit rester une TRADUCTION, jamais une copie |
| **un `inputSchema`** | `src/mcp/validate.ts` n'implémente qu'un SOUS-ENSEMBLE de JSON-Schema : ne pas déclarer ce qu'il ne sait pas imposer · la page génère ses tableaux de schéma depuis le même objet · `additionalProperties: false` reste obligatoire |
| **une constante `GARDE_*`** | elle vit dans le corps des réponses **et** sur la page · `test/garde.test.ts` · `MARQUEUR_RECONCILIATION` est en plus une chaîne de COUPLAGE lue par `scripts/refresh-databases.mjs` |
| **une table de `src/qc/`** | les comptes de `test/qc.tables.test.ts` (51 palais · 57 greffes · 27 juridictions · 20 forums · 36 districts) · le nombre de lignes de la table de la page (`test/site.test.ts`) · « 43 palais et 8 points de service » dans `README.md` · les dates `RELEVE_LE` et `MJQ_MAJ` affichées |
| **la page** | `test/site.test.ts` · §18 de la spécification · la section « Page publique » de `README.md` · le style reste **identique** à celui du connecteur jumeau (invariant 21) |
| **le comportement d'un outil** | la page peut le DOCUMENTER : les exemples d'analyse y sont produits par le vrai parseur au rendu, mais la prose qui les entoure, elle, est écrite à la main |

### Comment vérifier

La porte habituelle ne suffit pas : elle attrape la dérive **testée**, pas la dérive
**rédactionnelle**. Après elle, relire réellement les surfaces concernées.

```bash
npx wrangler types && npx tsc --noEmit && npx biome check . && npx vitest run

# Puis, pour tout changement d'outil : CONFRONTER le registre au README.
# Un écart ici est une dérive, MÊME SI la suite entière est verte.
diff <(grep -oE "^  (canlii|greffe|palais)_[a-z_]+" src/mcp/registry.ts | tr -d ' ' | sort) \
     <(grep -oE '`(canlii|greffe|palais)_[a-z_]+`' README.md | tr -d '`' | sort -u)
```

La page, elle, ne peut pas dériver sur ce point : elle DÉRIVE du registre (invariant 19).
C'est le README et la spécification qui prennent du retard, parce qu'ils sont écrits à la
main — d'où la confrontation ci-dessus, et la relecture des §7, §17 et §18.

---

## Architecture

Worker TypeScript sans cadriciel, **zéro dépendance d'exécution** (D2), base D1 `canlii`,
transport Streamable HTTP en **mode JSON sans état** (D3). Config : `wrangler.jsonc`.

```
src/index.ts      routage, authentification à temps constant, coupe-circuit, cron
src/mcp/          rpc.ts (JSON-RPC) · validate.ts (JSON-Schema en sous-ensemble)
                  registry.ts (les 13 descripteurs) · handlers/ (un par outil)
src/citation/     analyseur PUR — parse, normalize, compare. AUCUNE E/S.
src/canlii/       client sortant : étranglement, réessais, redactUrl
src/store/        D1 : cases (+FTS) · databases (auto-correction) · citator · telemetry
                  lookup.ts — la boucle d'auto-correction, en UN SEUL exemplaire
src/qc/           §17 — tables du Québec, PURES : palais · greffes · lieux (MJQ) ·
                  juridictions · forums · dossier.ts (parseur) · lookup.ts.
                  Constantes, PAS de D1.
src/format/       fr.ts (dates, listes) · render.ts (gabarits annexe A + mises en garde)
src/site.ts       §18 — page publique GET /. site.i18n.ts : l'ANGLAIS seulement.
src/backfill.ts   §11 — écrit, testé, INERTE
```

⚠ Deux `lookup.ts` coexistent et ne se ressemblent pas : `src/store/lookup.ts` est la
boucle d'auto-correction (§6.4, avec E/S) ; `src/qc/lookup.ts` est une consultation de
table en mémoire (aucune E/S). Ne pas fusionner.

## Commandes

```bash
npx wrangler types && npx tsc --noEmit     # toujours avant commit
npx biome check .                          # --write pour corriger
npx vitest run                             # 443 tests, sans réseau ni clef
npx wrangler dev                           # exige .dev.vars
npx wrangler deploy --dry-run              # valide paquet + config, sans jeton
npx wrangler d1 migrations apply canlii --local|--remote
node scripts/mcp-client.mjs --local tools/list
node scripts/refresh-databases.mjs --remote --sql   # réconciliation §4.3
```

## Invariants critiques

1. **`INSERT ... ON CONFLICT DO UPDATE`, JAMAIS `INSERT OR REPLACE`** sur `cases`. REPLACE
   change le `rowid` et fait diverger l'index FTS5 en *external content* — **en silence**.
2. **Une fiche est clée sur l'identifiant DEMANDÉ**, pas sur celui que CanLII renvoie.
   L'API rend `caseId` sous la clef de SA langue : demander `2008scc9` renvoie
   `{"fr": "2008csc9"}`. Clée sur la réponse, la fiche est rangée là où personne ne la
   cherche : le cache ne sert jamais et chaque vérification rappelle l'API. *(Défaut réel,
   trouvé par test.)*
3. **`source` distingue une FICHE d'une ligne de balayage, et ne se rétrograde jamais.**
   Un balayage (`browse`, `find`) persiste 4 champs : ni date, ni numéro de dossier, ni
   hyperlien. Deux règles en découlent, et elles se tiennent :
   *(a)* seule une ligne `source = 'lookup'` peut servir de fiche ou de vérification —
   servir une ligne de balayage rendrait un document amputé étiqueté « index local », et
   pire, ferait sauter en silence le contrôle de l'année faute de date ;
   *(b)* l'UPSERT enregistre la MEILLEURE provenance atteinte, jamais la dernière — sinon
   tout balayage recroisant une fiche déjà résolue la disqualifierait du cache et
   rachèterait l'appel. Un suivi quotidien à fenêtres chevauchantes recroise TOUT : le
   cache ne servirait jamais. *(Les deux moitiés sont des défauts réels, trouvés par
   test ; verrouillées dans `test/persist.test.ts` et `test/tools.test.ts`.)*
4. **Les mises en garde de §2 vivent dans le CORPS des réponses**, pas seulement dans les
   descriptions d'outils. `test/garde.test.ts` échoue si elles disparaissent. Un test de
   garde qui échoue se **répare en remettant la garantie**, jamais en ajustant le test.
   Corollaire : **pas de `structuredContent`, pas d'`outputSchema`** — un client qui reçoit
   un objet typé laisse tomber la prose, et la réserve part avec elle SANS qu'aucun test
   n'échoue. Réexaminé le 2026-07-23, maintenu. L'argument contraire est réel (un champ
   `verdict` ne se lit pas de travers ; un consommateur par programme voudrait du typé)
   mais le gain est marginal devant une perte silencieuse. **Si** un consommateur par
   programme existe un jour, la réponse n'est PAS `structuredContent` : c'est un paramètre
   `format: {enum:["texte","json"]}` dont la charge utile porte `avertissement` en champ
   **obligatoire**, de sorte que la réserve voyage à l'intérieur des données. Quatre
   conditions cumulatives, et le texte reste le défaut. Argument complet en commentaire
   au-dessus de `ok()` dans `src/mcp/rpc.ts` — le lire avant d'y toucher.
5. **Ne jamais journaliser `request.url`** : le secret partagé est dans le chemin (§9.2).
   Aucune sortie d'outil ne contient d'URL `api.canlii.org` — elles portent la clef d'API.
6. **La boucle d'auto-correction (§6.4) vit dans `src/store/lookup.ts`, en un seul
   exemplaire.** Deux implémentations d'une même heuristique d'apprentissage divergeraient,
   et l'une enseignerait au répertoire ce que l'autre ignore. *(Une duplication a déjà été
   supprimée pour ce motif.)*
7. **`NEUTRAL` porte le drapeau `/i`** — sans lui, « 2020 qcca 495 » (exigé par §13) ne
   s'analyse pas. Le drapeau fait alors capturer « CanLII » comme code de tribunal : deux
   parades cumulatives (masquage des plages CanLII appariées d'abord, puis rejet explicite
   du code `CANLII`). Retirer l'une rouvre le défaut ; les deux sont testées.
8. **Un tribunal absent du répertoire ⇒ INTROUVABLE SANS appel sortant** (§6.4 point 3).
   Un appel voué à l'échec coûte du quota et produirait un « introuvable » qui ferait croire
   à l'absence de la décision.
9. **Une panne réseau n'est PAS une absence.** Un 401, un 429 ou une expiration rendent
   `INDÉTERMINÉE`, jamais `INTROUVABLE` : affirmer une absence qu'on n'a pas constatée est
   exactement ce que §2 interdit. Seul un **404** justifie un rattrapage puis un INTROUVABLE.
10. **Un appariement d'intitulé PARTIEL vaut DISCORDANTE, jamais CONFIRMÉE** (§6.5). Mieux
    vaut un faux signalement qu'une fausse assurance.
11. **Les intitulés anonymisés se comparent par leur NUMÉRO** (« Droit de la famille —
    20495 ») : ils ne contiennent aucun nom de partie, et deux décisions distinctes de la
    même série partagent tous leurs jetons alphabétiques.
12. **Le citateur n'accepte que `en`** dans le chemin (annexe B). D'où l'absence de tout
    paramètre `lang` sur `canlii_citator` : en exposer un serait mensonger.
13. **La télémétrie n'échoue jamais l'outil qu'elle observe** : table absente, écriture
    refusée — tout est avalé.
14. **Les fins de ligne sont LF dans la copie de travail** (`.gitattributes`) : sinon Biome
    local (CRLF sous Windows) et la CI (Linux) divergent en permanence.
15. **§11 est inerte et le reste : la question est TRANCHÉE (2026-07-23) — pas de
    moissonnage de masse.** Deux verrous : `BACKFILL_ENABLED="false"` et aucun cron
    quotidien déclaré. Ce n'est plus une question ouverte mais une décision du
    praticien : ne pas basculer le drapeau, même « pour essayer ». Le remplissage du
    cache par l'usage (D6) n'est pas concerné — c'est autre chose.
16. **Le PRÉFIXE d'un outil annonce sa SOURCE, et c'est vérifié (§17).** `canlii_*` (10)
    signifie « la réponse vient de la collection de CanLII » ; `greffe_*` et `palais_*` (3)
    lisent un relevé LOCAL du ministère de la Justice du Québec, sans aucun appel. Servir
    une adresse de palais sous `canlii_` attribuerait à CanLII une donnée dont il n'est pas
    la source — l'inverse exact de ce que D8 protège. `test/rpc.test.ts` épingle la
    scission ; ajouter un outil oblige à choisir sa famille délibérément.
17. **Les tables de `src/qc/` sont un RELEVÉ DATÉ, pas une vérité.** Leur mode de panne
    n'est pas l'absence mais la **péremption** : une adresse juste hier, fausse aujourd'hui,
    rendue avec le même aplomb. D'où `GARDE_PALAIS`, qui porte la date **dans le corps** de
    chaque réponse. Et trois pièges à ne PAS « corriger » : `point_de_service` (greffe
    itinérant) ≠ `location_type` (point de service du MJQ) ≠ `lieux.itinerant` (le LIEU) —
    les **trois** divergent par construction ; le nom d'un palais n'est pas sa ville
    (Chicoutimi est à Saguenay) ; une adresse absente est **inconnue**, jamais inexistante —
    le pendant exact de la règle INTROUVABLE. On sort de cette liste par une SOURCE :
    `lieux.ts` en a sorti le greffe 635, jamais en assouplissant la formulation.
18. **`lieux.ts` est le relevé OFFICIEL du MJQ (2026-07-22), et il fait autorité sur le
    rattachement.** Un greffe dessert souvent PLUSIEURS lieux, ce que `palais_key` (1:1) ne
    sait pas dire. La réconciliation du 2026-07-30 en a tiré deux corrections réelles :
    le greffe **625 (Senneterre)** manquait — « 625-… » rendait « greffe inconnu » sur un
    greffe qui existe — et **Kuujjuaq** relève du greffe **635**, ce qu'Athéna refusait de
    deviner. `adresseDuGreffe` essaie `palais_key` PUIS le siège fixe du MJQ : les
    gestionnaires doivent passer par elle, jamais lire `palais_key` en direct, sous peine
    de faire diverger deux outils sur le même greffe.
19. **La page publique DÉRIVE des données, elle ne les recopie pas (§18).** Outils et
    schémas viennent de `listToolDescriptors()`, les issues d'analyse du VRAI parseur
    exécuté au rendu, les greffes des tables de `src/qc/`, les réserves des constantes
    `GARDE_*`. Une valeur recopiée deviendrait fausse **sans qu'aucun test n'échoue**.
    Trois propriétés de sa route sont load-bearing : égalité stricte sur `/` ;
    **délibérément hors du bloc `/mcp`** (n'y remontez JAMAIS le contrôle d'origine
    « par cohérence », la page cesserait de répondre aux visiteurs venus d'ailleurs) ;
    et **aucun en-tête CORS**, sans quoi la page deviendrait un oracle. Elle survit au
    coupe-circuit : exception assumée, car elle ne porte ni secret ni donnée vivante.
20. **Le parseur de dossiers est un PORT, éprouvé par différentiel.** `src/qc/dossier.ts`
    reproduit `parse_court_file_number` d'Athéna, et `test/fixtures/dossier-athena.json`
    rejoue 127 entrées des deux côtés. Il n'y a **ni somme de contrôle ni règle d'année** :
    ne pas en inventer. Un préfixe alphabétique inconnu reste prudent et n'est **jamais**
    une erreur. Une divergence du différentiel se répare dans le code, pas dans la fixture.
21. **La page partage le style du connecteur JUMEAU, au caractère près.** Les deux jeux de
    variables, la police (`16px/1.6 Georgia`), les tailles de titres et la grille (barre
    latérale de 13rem, rupture à 78rem) sont repris de « Législation du Québec ». Les deux
    sites appartiennent au même praticien et se consultent l'un après l'autre : une
    divergence de teinte ou de police les ferait passer pour deux outils sans rapport.
    Toute retouche ici se porte là-bas, et réciproquement. Deux gardes tiennent la
    cohérence interne : **aucune couleur en dur** hors des deux jeux (une couleur figée ne
    bascule pas et devient invisible dans l'un des thèmes), et les deux jeux déclarent
    **exactement** les mêmes variables.

## Procédure sûre

Coder → **propager (règle ci-dessus)** → `wrangler types` → `tsc --noEmit` →
`biome check` → `vitest run` → `wrangler deploy --dry-run` → déployer.

La propagation vient **avant** la porte technique, et non après : c'est la seule étape
qu'aucune commande ne peut réclamer à votre place. **Les migrations D1 passent AVANT le
déploiement** (`deploy.yml`) : l'ordre inverse met en ligne du code qui lit des colonnes
inexistantes.

## Secrets

- `CANLII_API_KEY` et `MCP_SHARED_SECRET` : posés par `wrangler secret put`, saisis par
  Jason lui-même. **Ne jamais les afficher, les lire en contexte, ni les écrire dans un
  fichier versionné.**
- `MCP_SHARED_SECRET_ATHENA` : **facultatif**, même règle. Second porteur du point
  d'entrée, aux droits IDENTIQUES — il n'ouvre aucun outil de plus. Il existe pour que
  le clavardage de Pallas Athéna et le connecteur claude.ai se révoquent SÉPARÉMENT
  (§9.1, §19). L'authentification reste **fermée par défaut** : aucun secret configuré
  ⇒ tout est refusé. Ne jamais journaliser lequel des deux a servi.
- `.dev.vars` (dev), `mcp.url` (URL de prod avec secret), `*.token` : **gitignorés**.
- Commits signés, footer `Co-Authored-By:` adapté au modèle courant. Un commit par
  sous-tâche.

## État

**Livré et en production** sur `jurisprudence.poirierlavoie.ca`, 443 tests verts. Treize
outils — dix `canlii_*`, trois `greffe_*`/`palais_*` — et une page publique bilingue sur
la même origine (§18).

**DEUX clients, et non un** (§19) : le connecteur claude.ai, et le clavardage de Pallas
Athéna, qui appelle `POST /mcp` en `Authorization: Bearer` avec son propre secret. Rien
n'a été ajouté au protocole pour lui — la forme par en-tête et le mode JSON sans état de
D3 suffisaient. Conséquence pratique : **une modification d'outil se répercute désormais
sur un sixième public**, `athena/chat/worker_tools.py`, engendré depuis `tools/list` par
`athena/scripts/sync_worker_tools.py`. Ce fichier n'est pas dans ce dépôt et la porte
d'ici ne peut pas le voir dériver : après tout ajout, retrait ou renommage d'outil,
relancer le générateur côté Athéna.

La réconciliation du répertoire (§4.3) est **faite** contre l'API vivante : elle a
démenti cinq hypothèses d'amorçage, consignées avec leur preuve d'observation dans
`migrations/0003_reconcile_court_codes.sql` (`caf-fca`/`cf-fc` inexistants — les vraies
bases sont `fca` et `fct` ; fragment français `cci` et non `tcc` ; le TAL a gardé le
`databaseId` de la Régie du logement, `qcrdl`). Les tests de `test/persist.test.ts`
verrouillent ces six correspondances : ils empêchent une réapplication de 0002 seule de
ressusciter les hypothèses fausses sur une base neuve.

Les lignes encore `verified = 0` ne sont pas un reliquat : elles sont **inertes par
construction** (invariant 8 — un tribunal absent du répertoire rend INTROUVABLE sans
appel sortant), et se confirmeront à l'usage par la boucle de §6.4.
