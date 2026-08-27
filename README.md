# Jurisprudence canadienne et greffes du Québec — connecteur MCP

Serveur MCP autonome sur Cloudflare Workers, exposant la **REST API de CanLII** sous forme
d'outils orientés **vérification de références** plutôt que d'enveloppes d'endpoints, plus
trois outils **hors ligne** sur les greffes et palais de justice du Québec.

- **Page publique** : <https://jurisprudence.poirierlavoie.ca/> — bilingue, trois thèmes
- **Point d'entrée** : `https://jurisprudence.poirierlavoie.ca/mcp/<secret>`
- **Worker** `jurisprudence` · **base D1** `canlii`
- Propriétaire : Jason Poirier Lavoie (avocat, Québec)

L'API de CanLII est en **lecture seule** et ne renvoie que des **métadonnées** — jamais le
texte d'une décision. La valeur du connecteur tient donc à trois usages :

1. **Éprouver** une citation tirée de la doctrine, d'un moteur de recherche ou d'un texte
   produit par une IA — existence et identité, de façon déterministe ;
2. **Retrouver** une décision à partir des noms des parties lorsque la citation n'est pas
   constructible (recueils, identifiants SOQUIJ) ;
3. **Identifier** précisément une décision, puis en obtenir l'hyperlien `canlii.ca` afin
   d'en tirer le texte par un autre moyen.

À quoi s'ajoute, depuis le 2026-07-30, la lecture d'un **numéro de dossier de cour du
Québec** et le **répertoire des palais de justice** — la pratique quotidienne autour des
mêmes décisions.

### ⚠ Deux sources, deux préfixes

La distinction est **sémantique**, pas cosmétique, et elle est **vérifiée par les tests** :

| Préfixe | Source | Appels |
|---|---|---|
| `canlii_` (10) | la collection de **CanLII** — couverture et verdicts en dépendent | oui |
| `greffe_` `palais_` (3) | un **relevé local** du ministère de la Justice du Québec, daté | **aucun** |

Servir une adresse de palais sous `canlii_` attribuerait à CanLII une donnée dont il n'est
pas la source. C'est précisément ce que la décision D8 interdit.

---

## ⚠ Contrat de vérité

> Reproduit **in extenso** de la spécification §2. Un vérificateur de citations qui promet
> plus qu'il ne tient est **pire qu'aucun outil** : il transforme une incertitude connue en
> fausse assurance, dans un contexte où la sanction est déontologique.

### Ce que l'API établit

- l'**existence** d'une décision dans la collection de CanLII ;
- son **identité** : intitulé, citation, date, numéro de dossier de cour, mots-clés,
  hyperlien `canlii.ca` ;
- ses **rapports de citation** : ce qu'elle cite, ce qui la cite, les dispositions qu'elle
  cite ;
- pour un texte législatif : type, régime de dates, dates de début et de fin, indicateur
  d'abrogation.

### Ce que l'API n'établit pas, et qu'aucun outil ne doit laisser croire

- le **texte** de la décision — il n'existe aucun endpoint de plein texte ni de recherche
  par mots du texte ;
- l'**autorité actuelle** — aucun historique d'appel, aucun indicateur de traitement
  (suivi, distingué, infirmé), aucun pourvoi pendant, aucun refus de permission d'appeler ;
- le **dispositif** ou le motif pour lequel une décision est invoquée ;
- l'**exhaustivité** — la couverture a des bornes historiques, et la documentation
  reconnaît un délai de diffusion pour lequel elle recommande de prévoir un jeu de deux
  jours.

### Conséquences imposées au code

1. Toute sortie d'outil **heuristique** (`canlii_find_case`, `canlii_subsequent_history`)
   se termine par sa mise en garde, **dans le corps de la réponse** et non seulement dans
   la description de l'outil.
2. Un verdict `INTROUVABLE` n'est **jamais** formulé comme « cette décision n'existe pas ».
   Il énumère les explications concurrentes (numéro erroné, hors collection, diffusion
   récente).
3. Un verdict `CONFIRMÉE` porte, dans la même sortie, la phrase indiquant qu'il n'établit
   ni l'autorité actuelle ni le dispositif.
4. Les valeurs brutes renvoyées par CanLII sont **toujours affichées** en cas d'écart — le
   praticien tranche, l'outil ne masque pas.

**Ces quatre conséquences sont verrouillées par `test/garde.test.ts`.** Ce fichier n'éprouve
pas une fonctionnalité : il empêche une *disparition*. Le mode de panne redouté n'est pas
l'erreur, c'est le **silence** — une refonte de gabarit qui rend des sorties impeccables
dont la garantie a discrètement disparu. Si l'un de ses tests échoue, la bonne réaction
n'est pas de l'ajuster pour qu'il passe : c'est de remettre la mise en garde.

---

## Les treize outils

### Adossés à CanLII

| Outil | Rôle |
|---|---|
| `canlii_verify_citations` | **Pivot.** Verdict par citation : CONFIRMÉE · DISCORDANTE · INTROUVABLE · NON CONSTRUCTIBLE · ILLISIBLE |
| `canlii_find_case` | Recherche par noms des parties ; index local puis balayage vif |
| `canlii_get_case` | Fiche officielle d'une décision |
| `canlii_citator` | Ce qu'une décision cite, ce qui la cite, les dispositions qu'elle cite |
| `canlii_subsequent_history` | **Indice heuristique** de sorts ultérieurs — ne remplace pas un citateur |
| `canlii_browse_cases` | Décisions d'un tribunal, avec les huit filtres de dates |
| `canlii_list_databases` | Répertoire des cours et corpus législatifs |
| `canlii_browse_legislation` | Lois et règlements d'une base législative |
| `canlii_get_legislation` | Fiche d'une loi : dates, abrogation, découpage |
| `canlii_parse_citation` | Analyse hors ligne d'une citation — **aucun appel** |

### Tables locales du Québec — **aucun appel, jamais**

| Outil | Rôle |
|---|---|
| `greffe_parse_court_file_number` | `500-05-123456-241` → greffe, district judiciaire, tribunal, compétence. Un préfixe `TAL-`, `C.F.-`… désigne le tribunal qui numérote lui-même |
| `palais_list` | Répertoire des 43 palais et 8 points de service, filtrable par district, type ou texte libre |
| `palais_get` | Fiche d'un lieu : adresse, greffes qui y siègent, localités desservies d'une cour itinérante |

Sorties en **texte français**, jamais en JSON (décision D4).

**Ce que les trois outils du Québec n'établissent PAS** : qu'un dossier existe ou soit actif.
Ils lisent une **nomenclature** et un **relevé d'adresses**, pas un registre — le connecteur
n'a accès à aucun plumitif. Les adresses datent du **2026-07-15** et **aucune coordonnée
téléphonique** n'est portée : les palais déménagent, et il faut vérifier auprès du Ministère
avant toute signification ou tout dépôt. Ces réserves vivent **dans le corps des réponses**
et sont verrouillées par `test/garde.test.ts`, comme celles de CanLII.

---

## 🔒 Réserve de secret professionnel

> Spécification §9.5.

Ce connecteur est, sur ce plan, exceptionnellement propre : ce qui sort de l'infrastructure,
ce sont des **citations, des identifiants de tribunaux et des dates**. Aucun nom de client,
aucun fait de dossier, aucun document.

**Une seule réserve** : `canlii_find_case` prend des **noms de parties**. Si ce nom est celui
d'une partie à un dossier en cours plutôt que celui d'une décision publiée, la requête révèle
à CanLII un intérêt de recherche. Le risque est faible — CanLII est un organisme sans but
lucratif canadien, et la recherche jurisprudentielle nominative est l'usage normal du site —
mais il n'est pas nul, et il mérite d'être connu plutôt que découvert.

---

## Page publique (§18)

`GET /` sert une page **statique et bilingue** (français · anglais, thème auto / clair /
sombre) qui décrit les treize outils, leurs schémas, la structure d'un numéro de dossier
judiciaire et le répertoire des greffes.

**Tout y dérive des données vives** : les outils viennent de `listToolDescriptors()` — la
fonction même que sert `tools/list` —, les issues d'analyse du **vrai parseur exécuté au
rendu**, les greffes des tables de `src/qc/`, les réserves des constantes `GARDE_*`. Une
valeur recopiée deviendrait fausse sans qu'aucun test n'échoue ; il n'y a donc aucune copie.

Trois propriétés de sa route sont délibérées et testées : égalité stricte sur `/` ;
**hors** du bloc `/mcp`, dont la garde d'origine refuserait la page à tout visiteur venu
d'un lien externe ; et **aucun en-tête CORS**, sans quoi la page pourrait servir d'oracle
à une autre origine. Le secret n'y paraît jamais — seulement sa forme. Elle est servie
même lorsque `MCP_ENABLED=false` : le coupe-circuit protège la surface MCP, pas la
documentation.

Aucune requête tierce : ni CDN, ni police distante, ni image. Sans JavaScript, le français
s'affiche et tout reste lisible.

---

## Architecture

```
claude.ai / Claude Code
        │  POST /mcp/<secret>   (JSON-RPC 2.0, un message par requête)
        ▼
  Worker `jurisprudence` (workerd, TypeScript, ZÉRO dépendance d'exécution)
    routeur → authentification → JSON-RPC → registre d'outils
        │                  │                        │
   analyseur de       tables du Québec        client CanLII
   citations          `src/qc/` — greffes,    (séquentiel, étranglé,
   (pur, hors ligne)  palais, juridictions     réessayé)
        │             (PUR, aucune E/S)             │
        └────────────┬────────────────────────────┬─┘
                     ▼                            ▼
                D1 `canlii`                 https://api.canlii.org/v1/…
                index ET cache
```

Les tables `src/qc/` sont des **constantes TypeScript**, non une base : rien ne les réécrit
à l'exécution, et les trois outils qui s'en servent ne peuvent donc ni échouer, ni consommer
de quota, ni dépendre du réseau. Leur fraîcheur est celle du dépôt — d'où la réserve datée.

**Transport** : Streamable HTTP, **mode JSON sans état** — un message JSON-RPC par `POST`,
pas de SSE, pas de `Mcp-Session-Id`.

**Le cache se remplit par l'usage** : tout balayage effectué pour répondre à une requête est
persisté. Ce n'est pas un miroir téléchargé, c'est la sédimentation des appels déjà faits.

---

## Mise en service

```bash
npm ci
npx wrangler d1 create canlii --location enam     # reporter l'UUID dans wrangler.jsonc
npx wrangler d1 migrations apply canlii --remote

# Secrets — à saisir SOI-MÊME : ces valeurs ne doivent transiter par aucun journal.
npx wrangler secret put CANLII_API_KEY
openssl rand -hex 32                              # puis :
npx wrangler secret put MCP_SHARED_SECRET

# FACULTATIF — second porteur, aux droits identiques : le clavardage de Pallas Athéna
# (§19). Il n'ouvre rien de plus ; il existe pour que les deux clients se révoquent
# SÉPARÉMENT. Omis, un seul porteur est admis.
openssl rand -hex 32
npx wrangler secret put MCP_SHARED_SECRET_ATHENA

npx wrangler deploy
```

### Répertoire des tribunaux (§4.3) — réconcilié, et à re-vérifier périodiquement

Les correspondances « code de citation → databaseId » ne sont documentées que pour
`csc-scc`. Tout le reste était une **hypothèse** d'amorçage, et les identifiants fédéraux
composés n'étaient pas documentés du tout.

**La réconciliation a été faite contre l'API vivante le 2026-07-23**, et elle a démenti
cinq hypothèses : `caf-fca` et `cf-fc` n'existent pas (les vraies bases sont `fca` et
`fct`), le fragment français de la Cour canadienne de l'impôt est `cci` et non `tcc`, et
le TAL a gardé le `databaseId` de la Régie du logement (`qcrdl`) — exactement le piège de
renommage que la spécification anticipait. Les valeurs mesurées, avec leur preuve
d'observation, sont dans `migrations/0003_reconcile_court_codes.sql` : **une installation
neuve les obtient donc par les migrations**, sans manœuvre manuelle.

Ce qui reste utile, et qu'il faut refaire quand un tribunal est créé, fusionné ou renommé :

```bash
node scripts/refresh-databases.mjs --remote --sql
```

Le script **n'écrit rien en base** : il rafraîchit le répertoire, dénonce les hypothèses que
CanLII dément, et produit un gabarit SQL à relire. Corriger automatiquement une
correspondance de tribunal reviendrait à figer une erreur en silence — c'est pourquoi la
dernière étape reste un geste humain.

### Recette manuelle (§14 étape 8)

```bash
node scripts/mcp-client.mjs --remote tools/call canlii_verify_citations \
  '{"citations":[{"citation":"2008 CSC 9"},{"citation":"2020 QCCA 999999"},{"citation":"[1985] C.A. 105"}]}'
```

Attendu : *Dunsmuir* CONFIRMÉE · `2020 QCCA 999999` INTROUVABLE (avec les explications
concurrentes) · `[1985] C.A. 105` NON CONSTRUCTIBLE (avec renvoi à `canlii_find_case`).

### Après le déploiement

- Ajouter le connecteur dans `claude.ai` : URL
  `https://jurisprudence.poirierlavoie.ca/mcp/<secret>`, nom
  « Jurisprudence canadienne et greffes du Québec ».
- ~~Créer une règle de limitation de débit au tableau de bord~~ — **fait, mais autrement**
  (2026-07-23). La limitation de débit de §9.3 est implémentée **dans le Worker**
  (binding `ratelimits`, 60 requêtes/minute par IP), et non par une règle WAF de zone :
  celle-ci dépend du forfait de la ZONE, indisponible ici malgré l'abonnement Pro. Le
  résultat est meilleur — la règle est versionnée, relue et testée, et surtout elle vise
  `/mcp` **sans avoir à écrire un motif de chemin** ; or ce chemin contient le secret, et
  une expression WAF est visible au tableau de bord comme dans les journaux d'audit.
  Aucune action manuelle n'est requise.
- Après une semaine d'usage, dépouiller `search_log` et corriger l'analyseur sur les formes
  réellement rencontrées :

```sql
SELECT query, COUNT(*) n FROM search_log
WHERE tool = 'canlii_verify_citations' AND verdict IN ('ILLISIBLE','INTROUVABLE')
GROUP BY query ORDER BY n DESC LIMIT 50;
```

---

## Développement

```bash
cp .dev.vars.example .dev.vars    # y mettre la clef CanLII et un secret de DEV
npx wrangler dev
npx tsc --noEmit && npx biome check . && npx vitest run
npx wrangler d1 migrations apply canlii --local
```

Les tests s'exécutent dans **workerd** avec une D1 locale et des réponses de CanLII figées
(`test/fixtures/`) : **la suite est verte sans la clef d'API**, faute de quoi elle
dépendrait du quota d'une clef personnelle.

⚠ `wrangler dev` avec une vraie clef dans `.dev.vars` fait de **vrais appels** et consomme
le quota.

---

## Sécurité

- **La clef d'API ne quitte jamais le processus.** Toute URL journalisée passe par
  `redactUrl()` ; aucune sortie d'outil ne contient d'URL `api.canlii.org`. Verrouillé par
  test de non-régression.
- **Ne jamais journaliser `request.url`** : le secret partagé voyage dans le chemin. On
  journalise la méthode, le nom d'outil et le statut — jamais le chemin (§9.2).
- Comparaison du secret **à temps constant**, sur les empreintes SHA-256 — ce qui neutralise
  aussi l'écart de longueur.
- **Deux secrets admis, aux droits identiques, révocables séparément** (§9.1, §19) :
  `MCP_SHARED_SECRET` pour le connecteur claude.ai, `MCP_SHARED_SECRET_ATHENA` —
  facultatif — pour le clavardage de Pallas Athéna. Le second ne délimite aucun
  périmètre ; il évite qu'une rotation ou une révocation éteigne les deux clients à la
  fois. Aucun secret configuré ⇒ **tout est refusé** (fermé par défaut), et les deux
  échecs rendent le même `401`, sans jamais dire lequel a servi.
- `MCP_ENABLED=false` ⇒ **404 sur toutes les routes MCP**, `/health` compris.
- Chemin d'évolution vers OAuth 2.1 documenté en §9.4 de la spécification — **non
  implémenté** : la complexité n'est pas justifiée par la valeur protégée, qui est la clef
  d'API et son quota, non du contenu confidentiel.

---

## Questions restées ouvertes

- **§16.1 — moissonnage de masse : TRANCHÉ, ce sera non (2026-07-23).** Décision du
  praticien : pas de téléchargement en masse. `src/backfill.ts` reste écrit et testé mais
  **ne s'exécute pas** — `BACKFILL_ENABLED=false`, et aucun cron quotidien n'est déclaré,
  de sorte que l'activer exigerait deux gestes délibérés. Le cache continue de se remplir
  par l'usage (D6), ce qui est autre chose : la sédimentation des appels réellement faits,
  et non un aspirateur. Rouvrir la question supposerait de la poser d'abord à CanLII.
- **§16.2 — quota et débit.** Non publiés. Les valeurs par défaut sont prudentes (250 ms
  entre appels, 40 appels par invocation, aucune concurrence sortante) ; à ajuster après
  réponse de CanLII.

## Référence

Spécification complète : [`SPEC_CANLII_MCP.md`](SPEC_CANLII_MCP.md).
Connecteur jumeau pour le droit législatif québécois : « Législation du Québec »
(`legislation.poirierlavoie.ca`).
