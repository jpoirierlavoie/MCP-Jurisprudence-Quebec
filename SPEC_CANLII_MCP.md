# Spécification — Connecteur MCP « Jurisprudence canadienne et greffes du Québec »

**Destinataire :** Claude Code
**Auteur de la spéc. :** (préparé pour Jason Poirier Lavoie)
**Cible :** nouveau dépôt autonome — Worker Cloudflare, D1, TypeScript
**Modèle de référence :** le Worker `legislation` / base D1 `qclaw` (connecteur « Législation du Québec »)
**Statut :** prêt à implémenter — lire **§1 (décisions arrêtées)** et **§2 (contrat de vérité)** avant toute ligne de code

---

## 0. Résumé exécutif

Construire un serveur MCP autonome, hébergé sur Cloudflare Workers, exposant la **REST API de CanLII** sous forme d'outils orientés *vérification de références* plutôt que de simples enveloppes d'endpoints.

L'API de CanLII est en **lecture seule** et ne renvoie que des **métadonnées** — jamais le texte d'une décision. La valeur professionnelle du connecteur tient donc à trois usages :

1. **Éprouver** une citation tirée de la doctrine, d'un moteur de recherche ou d'un texte produit par une IA — existence et identité, de façon déterministe ;
2. **Retrouver** une décision à partir des noms des parties lorsque la citation n'est pas constructible (recueils, identifiants SOQUIJ) ;
3. **Identifier** précisément une décision, puis en obtenir l'hyperlien `canlii.ca` afin d'en tirer le texte par un autre moyen.

L'architecture calque celle du Worker `legislation` : un Worker TypeScript sans cadriciel, une base D1 avec migrations Wrangler et une table FTS5 en *external content*, des sorties en **texte français compact** (et non en JSON), une table `search_log` pour la télémétrie des échecs, et des descriptions d'outils qui portent elles-mêmes leurs mises en garde.

Deux différences structurelles avec `legislation` : (a) la source de vérité est **distante** (l'API de CanLII), donc il faut un client sortant étranglé, réessayé et journalisé ; (b) la clef d'API est un **secret personnel à quota**, donc le point d'entrée doit être **authentifié**, contrairement au corpus législatif qui est public.

---

## 1. Décisions arrêtées (et pourquoi)

Ces décisions sont prises. Ne pas les rouvrir sans instruction contraire ; les points restés ouverts sont regroupés en **§16**.

| # | Décision | Motif |
|---|---|---|
| D1 | **TypeScript**, pas Python | Le moteur natif des Workers est `workerd` (JS/TS). Les *Python Workers* (Pyodide) restent en bêta, avec démarrages à froid et contraintes de paquets. Le Worker `legislation` est déjà en TS ; la symétrie l'emporte. Le code ici est de la plomberie HTTP + un analyseur de citations : lisible sans expertise TS. *Si Python devient impératif, la cible n'est pas Workers mais Cloud Run — dire non à Workers plutôt que faire du Python contraint.* |
| D2 | **Aucun cadriciel** (pas de Hono, pas d'`agents`, pas du SDK MCP officiel) | Un routeur `fetch` de trente lignes suffit. Zéro dépendance d'exécution = zéro surface Dependabot, cohérent avec la philosophie « zéro nouvelle dépendance » d'Athéna. |
| D3 | **Streamable HTTP, mode JSON sans état** | Un message JSON-RPC par `POST`. Pas de SSE, pas de `Mcp-Session-Id`. Identique à la phase I d'Athéna ; c'est le transport que `claude.ai` privilégie. Le dépôt `alhwyn/canlii-mcp` utilise SSE — **ne pas l'imiter sur ce point**. |
| D4 | **Sortie en texte français**, pas en JSON | Conforme à `qclaw` : `qclaw_resolve_reference` renvoie « RLRQ, c. CCQ-1991, art. 1 (à jour au 2026-04-01) … », non un objet. Plus lisible pour le modèle, moins verbeux, et le format porte la mise en garde. |
| D5 | **D1 sert à la fois d'index et de cache**, pas de KV | Le compte ne possède aucun *namespace* KV ; `qclaw` fonctionne sur D1 seul. Les métadonnées d'une décision sont quasi immuables : un cache permanent est correct. |
| D6 | **Le cache se remplit par l'usage** | Tout balayage effectué pour répondre à une requête est **persisté**. Le « miroir » n'est donc pas un téléchargement en masse, mais la sédimentation des appels déjà faits. Le moissonnage planifié (§11) reste facultatif et désactivé par défaut. |
| D7 | **Authentification par secret partagé** dans le chemin *ou* l'en-tête `Authorization` | Ce qui est protégé n'est pas du contenu confidentiel — les métadonnées sont publiques — mais **la clef d'API et son quota**. Un secret de 256 bits sur TLS est proportionné. Chemin d'évolution vers OAuth 2.1 documenté en §9.4. |
| D8 | **Nom d'hôte `jurisprudence.poirierlavoie.ca`**, Worker `jurisprudence`, base D1 `canlii`, préfixe d'outils `canlii_` | Symétrie avec `legislation.poirierlavoie.ca`. Le nom d'hôte évite d'employer la marque d'un tiers ; le préfixe d'outil la conserve, parce que la couverture et les verdicts *dépendent* de la collection de CanLII et que le modèle doit le savoir. |
| D9 | **Outils composites**, pas des enveloppes 1:1 d'endpoints | Un outil `canlii_verify_citations` qui analyse, construit, appelle, compare et rend un verdict fait en un aller-retour ce qui en exigerait quatre. C'est aussi la seule façon d'imposer la mise en garde au bon endroit. |
| D10 | **Auto-correction du répertoire des tribunaux** | La correspondance code de citation → `databaseId` n'est documentée que pour `csc-scc`. Les identifiants fédéraux sont incertains. Le système apprend : sur échec, il essaie la variante linguistique et consigne celle qui a fonctionné (§6.4). |

---

## 2. Contrat de vérité (à lire avant d'écrire un seul outil)

Un vérificateur de citations qui promet plus qu'il ne tient est **pire qu'aucun outil** : il transforme une incertitude connue en fausse assurance, dans un contexte où la sanction est déontologique. Le code doit donc rendre ces limites structurellement inévitables.

**Ce que l'API établit :**

- l'**existence** d'une décision dans la collection de CanLII ;
- son **identité** : intitulé, citation, date, numéro de dossier de cour, mots-clés, hyperlien `canlii.ca` ;
- ses **rapports de citation** : ce qu'elle cite, ce qui la cite, les dispositions qu'elle cite ;
- pour un texte législatif : type, régime de dates, dates de début et de fin, indicateur d'abrogation.

**Ce que l'API n'établit pas, et qu'aucun outil ne doit laisser croire :**

- le **texte** de la décision — il n'existe aucun endpoint de plein texte ni de recherche par mots du texte ;
- l'**autorité actuelle** — aucun historique d'appel, aucun indicateur de traitement (suivi, distingué, infirmé), aucun pourvoi pendant, aucun refus de permission d'appeler ;
- le **dispositif** ou le motif pour lequel une décision est invoquée ;
- l'**exhaustivité** — la couverture a des bornes historiques, et la documentation reconnaît un délai de diffusion pour lequel elle recommande de prévoir un jeu de deux jours.

**Conséquences imposées au code :**

1. Toute sortie d'outil **heuristique** (`canlii_find_case`, `canlii_subsequent_history`) se termine par sa mise en garde, dans le corps de la réponse et non seulement dans la description de l'outil — c'est le motif retenu par `qclaw_find_relevant`.
2. Un verdict `INTROUVABLE` n'est **jamais** formulé comme « cette décision n'existe pas ». Il énumère les explications concurrentes (numéro erroné, hors collection, diffusion récente).
3. Un verdict `CONFIRMÉE` porte, dans la même sortie, la phrase indiquant qu'il n'établit ni l'autorité actuelle ni le dispositif.
4. Les valeurs brutes renvoyées par CanLII sont **toujours affichées** en cas d'écart — le praticien tranche, l'outil ne masque pas.

---

## 3. Architecture

### 3.1 Vue d'ensemble

```
claude.ai / Claude Code / Athéna (plus tard)
        │  POST /mcp/<secret>   (JSON-RPC 2.0, un message par requête)
        ▼
┌──────────────────────────────────────────────┐
│  Worker `jurisprudence`  (workerd, TS)       │
│                                              │
│  router → auth → JSON-RPC → registre d'outils│
│                    │                         │
│      ┌─────────────┴──────────────┐          │
│      ▼                            ▼          │
│  analyseur de citations     client CanLII    │
│  (pur, hors ligne)          (étranglé,       │
│                              réessayé)       │
│      │                            │          │
│      └────────────┬───────────────┘          │
│                   ▼                          │
│              D1 `canlii`                     │
│   databases · court_codes · cases · cases_fts│
│   citator_edges · sync_state · search_log    │
│   api_usage                                  │
└──────────────────────────────────────────────┘
                   │ HTTPS (api_key en paramètre de requête)
                   ▼
          https://api.canlii.org/v1/…
```

### 3.2 Arborescence du dépôt

```
.
├── src/
│   ├── index.ts              # fetch + scheduled ; routage ; garde d'authentification
│   ├── mcp/
│   │   ├── rpc.ts            # enveloppe JSON-RPC, codes d'erreur, initialize/ping
│   │   ├── registry.ts       # les 10 descripteurs d'outils (nom, description FR, schéma)
│   │   ├── validate.ts       # validateur JSON-Schema (sous-ensemble) — calqué sur mcp/tools.py
│   │   └── handlers/         # un fichier par outil
│   │       ├── verifyCitations.ts
│   │       ├── parseCitation.ts
│   │       ├── findCase.ts
│   │       ├── getCase.ts
│   │       ├── citator.ts
│   │       ├── subsequentHistory.ts
│   │       ├── browseCases.ts
│   │       ├── listDatabases.ts
│   │       ├── browseLegislation.ts
│   │       └── getLegislation.ts
│   ├── canlii/
│   │   ├── client.ts         # fetch sortant : étranglement, réessais, délais, quota
│   │   ├── types.ts          # types des réponses de l'API
│   │   └── errors.ts         # CanliiError (statut, code, corps redacté)
│   ├── citation/
│   │   ├── parse.ts          # analyseur (§6)
│   │   ├── normalize.ts      # pliage d'accents, casse, ponctuation, tokenisation
│   │   └── compare.ts        # comparaison d'intitulés (§6.5)
│   ├── store/
│   │   ├── cases.ts          # upsert/lecture de `cases` + FTS
│   │   ├── databases.ts      # répertoire + court_codes (+ auto-correction)
│   │   ├── citator.ts        # arêtes du citateur + TTL
│   │   └── telemetry.ts      # search_log, api_usage
│   └── format/
│       ├── fr.ts             # dates, listes, troncature
│       └── render.ts         # gabarits de sortie (Annexe A)
├── migrations/
│   ├── 0001_initial.sql
│   └── 0002_seed_court_codes.sql
├── scripts/
│   └── refresh-databases.ts  # amorçage manuel du répertoire (wrangler dev)
├── test/
│   ├── citation.parse.test.ts
│   ├── citation.compare.test.ts
│   ├── verify.test.ts
│   ├── rpc.test.ts
│   └── fixtures/             # réponses JSON de l'API, figées
├── .github/workflows/        # §12
├── wrangler.jsonc
├── biome.json
├── tsconfig.json
├── vitest.config.ts
├── package.json
└── README.md
```

### 3.3 `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "jurisprudence",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "routes": [
    { "pattern": "jurisprudence.poirierlavoie.ca", "custom_domain": true }
  ],
  "observability": { "enabled": true },
  "limits": {
    "cpu_ms": 30000,
    "subrequests": 200        // garde-fou : bien en deçà du plafond payant
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "canlii",
      "database_id": "<uuid après création>",
      "migrations_dir": "migrations"
    }
  ],
  "triggers": { "crons": ["17 6 * * 1"] },   // hebdomadaire : rafraîchit le répertoire
  "vars": {
    "MCP_ENABLED": "true",
    "CANLII_MIN_INTERVAL_MS": "250",
    "CANLII_MAX_CALLS_PER_INVOCATION": "40",
    "CANLII_TIMEOUT_MS": "15000",
    "PERSIST_SWEEPS": "true",
    "BACKFILL_ENABLED": "false",
    "DEFAULT_LANG": "fr"
  }
}
```

> **Création de la base :** `wrangler d1 create canlii --location enam` — `enam` (est de l'Amérique du Nord) est le repère de localisation le plus proche de Montréal. Aucune contrainte de résidence des données ne s'applique ici : rien de confidentiel n'y transite (§9.5).

**Dépendance au forfait.** Le forfait *Workers Free* plafonne à **50 sous-requêtes externes par invocation** et **10 ms de CPU** ; le forfait payant offre 10 000 sous-requêtes (jusqu'à 10 M) et 30 s de CPU par défaut. Les outils de balayage (`canlii_find_case` en mode vif, le moissonnage de §11) supposent le forfait **payant**. Sur le forfait gratuit, ramener `CANLII_MAX_CALLS_PER_INVOCATION` à `20` et désactiver §11. **Vérifier le forfait du compte avant d'implémenter §11.**

### 3.4 Secrets et variables

| Nom | Type | Rôle |
|---|---|---|
| `CANLII_API_KEY` | secret (`wrangler secret put`) | Clef d'API CanLII. **Jamais journalisée, jamais renvoyée, jamais dans une trace.** |
| `MCP_SHARED_SECRET` | secret | 32 octets aléatoires en hexadécimal (`openssl rand -hex 32`). |
| `MCP_SHARED_SECRET_ATHENA` | secret, **facultatif** | Second porteur du même point d'entrée, aux droits identiques : le clavardage de Pallas Athéna. Distinct pour être **révocable seul** (§9.1). Absent ⇒ un seul porteur admis. |
| `MCP_ENABLED` | var | Coupe-circuit : `"false"` ⇒ toute route MCP renvoie `404`. Calque `MCP_ENABLED` d'Athéna. |
| `CANLII_MIN_INTERVAL_MS` | var | Intervalle minimal entre deux appels sortants. |
| `CANLII_MAX_CALLS_PER_INVOCATION` | var | Plafond d'appels sortants par invocation d'outil. |
| `CANLII_TIMEOUT_MS` | var | Délai d'expiration par appel sortant. |
| `PERSIST_SWEEPS` | var | Persister en D1 les fiches moissonnées lors d'un balayage. |
| `BACKFILL_ENABLED` | var | Active le moissonnage planifié (§11). **`false` par défaut.** |

---

## 4. Schéma D1

### 4.1 `migrations/0001_initial.sql`

```sql
-- Répertoire des bases de données de CanLII (cours, tribunaux, corpus législatifs).
CREATE TABLE databases (
  id            TEXT PRIMARY KEY,          -- 'qcca', 'csc-scc', 'qcs'
  kind          TEXT NOT NULL,             -- 'case' | 'legislation'
  jurisdiction  TEXT NOT NULL,             -- 'qc', 'ca', 'on', ...
  type          TEXT,                      -- STATUTE | REGULATION | ANNUAL_STATUTE (législation)
  name_fr       TEXT,
  name_en       TEXT,
  name_norm     TEXT,                      -- plié (accents, casse) pour la recherche
  refreshed_at  TEXT NOT NULL
);
CREATE INDEX idx_db_kind ON databases(kind, jurisdiction);

-- Correspondance : code de citation neutre -> databaseId + fragment employé dans caseId.
-- Seule 'csc-scc' est documentée ; le reste est amorcé puis CORRIGÉ à l'usage (§6.4).
CREATE TABLE court_codes (
  code          TEXT PRIMARY KEY,          -- 'QCCA', 'CSC', 'SCC', 'CAF' (majuscules)
  database_id   TEXT NOT NULL,
  caseid_code   TEXT NOT NULL,             -- fragment DANS le caseId : 'qcca', 'scc'
  jurisdiction  TEXT NOT NULL,
  lang          TEXT,                      -- 'fr' | 'en' | NULL (langue-neutre)
  verified      INTEGER NOT NULL DEFAULT 0,-- 1 = confirmé par un appel réussi
  note          TEXT
);

-- Codes entre parenthèses des citations attribuées par CanLII : « (QC CQ) ».
CREATE TABLE paren_codes (
  juris_code    TEXT NOT NULL,             -- 'QC', 'CA', 'ON'
  court_code    TEXT NOT NULL,             -- 'CQ', 'CS', 'CA', 'SCC'
  database_id   TEXT NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (juris_code, court_code)
);

-- Fiches de décisions : à la fois index de recherche et cache.
CREATE TABLE cases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id     TEXT NOT NULL,
  case_id         TEXT NOT NULL,
  lang            TEXT,                    -- langue sous laquelle CanLII a clé le caseId
  title           TEXT NOT NULL,
  title_norm      TEXT NOT NULL,           -- plié : accents, casse, ponctuation
  citation        TEXT,
  neutral_cite    TEXT,                    -- extraite et normalisée : '2020 QCCA 495'
  docket_number   TEXT,
  decision_date   TEXT,                    -- 'YYYY-MM-DD'
  keywords        TEXT,
  url             TEXT,
  concatenated_id TEXT,
  source          TEXT NOT NULL,           -- 'lookup' | 'sweep' | 'backfill'
  fetched_at      TEXT NOT NULL,
  UNIQUE (database_id, case_id)
);
CREATE INDEX idx_cases_date    ON cases(database_id, decision_date DESC);
CREATE INDEX idx_cases_neutral ON cases(neutral_cite);
CREATE INDEX idx_cases_docket  ON cases(docket_number);

-- Recherche plein texte sur l'INTITULÉ et les mots-clés — jamais sur le texte
-- de la décision, que l'API n'expose pas.
CREATE VIRTUAL TABLE cases_fts USING fts5(
  title, keywords,
  database_id UNINDEXED, case_id UNINDEXED,
  content='cases', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2"
);
CREATE TRIGGER cases_ai AFTER INSERT ON cases BEGIN
  INSERT INTO cases_fts(rowid, title, keywords, database_id, case_id)
  VALUES (new.id, new.title, new.keywords, new.database_id, new.case_id);
END;
CREATE TRIGGER cases_ad AFTER DELETE ON cases BEGIN
  INSERT INTO cases_fts(cases_fts, rowid, title, keywords, database_id, case_id)
  VALUES ('delete', old.id, old.title, old.keywords, old.database_id, old.case_id);
END;
CREATE TRIGGER cases_au AFTER UPDATE ON cases BEGIN
  INSERT INTO cases_fts(cases_fts, rowid, title, keywords, database_id, case_id)
  VALUES ('delete', old.id, old.title, old.keywords, old.database_id, old.case_id);
  INSERT INTO cases_fts(rowid, title, keywords, database_id, case_id)
  VALUES (new.id, new.title, new.keywords, new.database_id, new.case_id);
END;

-- Arêtes du citateur.
CREATE TABLE citator_edges (
  from_database_id  TEXT NOT NULL,
  from_case_id      TEXT NOT NULL,
  rel               TEXT NOT NULL,         -- 'citing' | 'cited' | 'legislation'
  to_database_id    TEXT,
  to_case_id        TEXT,
  to_legislation_id TEXT,
  to_title          TEXT,
  to_citation       TEXT,
  fetched_at        TEXT NOT NULL
);
CREATE INDEX idx_edges_from ON citator_edges(from_database_id, from_case_id, rel);

-- État de moisson d'une arête : distingue « vide » de « jamais demandé ».
CREATE TABLE citator_state (
  database_id TEXT NOT NULL,
  case_id     TEXT NOT NULL,
  rel         TEXT NOT NULL,
  edge_count  INTEGER NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (database_id, case_id, rel)
);

-- Curseurs du moissonnage planifié (§11).
CREATE TABLE sync_state (
  database_id   TEXT PRIMARY KEY,
  cursor_date   TEXT,
  cursor_offset INTEGER NOT NULL DEFAULT 0,
  last_run_at   TEXT,
  complete      INTEGER NOT NULL DEFAULT 0
);

-- Télémétrie : ce que l'on cherche et ne trouve pas est le signal le plus utile.
CREATE TABLE search_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  tool         TEXT NOT NULL,
  query        TEXT NOT NULL,
  database_id  TEXT,
  lang         TEXT,
  result_count INTEGER NOT NULL,
  verdict      TEXT,                       -- verify_citations
  fallback     TEXT
);
CREATE INDEX idx_search_log_misses ON search_log(tool, ts) WHERE result_count = 0;

-- Consommation quotidienne : le quota de CanLII n'est pas publié (§16.2).
CREATE TABLE api_usage (
  day       TEXT PRIMARY KEY,              -- 'YYYY-MM-DD' UTC
  calls     INTEGER NOT NULL DEFAULT 0,
  errors    INTEGER NOT NULL DEFAULT 0,
  throttled INTEGER NOT NULL DEFAULT 0
);
```

### 4.2 Politique de fraîcheur

| Donnée | TTL | Motif |
|---|---|---|
| Fiche de décision (`cases`) | **permanent** | Intitulé, citation, date et numéro de dossier ne changent pas. Rafraîchissement forcé par l'argument `refresh`. |
| `citator_edges` où `rel='cited'` ou `'legislation'` | **permanent** | Ce qu'une décision cite est figé au jour de son prononcé. |
| `citator_edges` où `rel='citing'` | **30 jours** | Cette liste croît indéfiniment. |
| `databases` | **7 jours** (cron hebdomadaire) | Les tribunaux sont créés, fusionnés et renommés (Régie du logement → TAL ; CLP/CRT → TAT). |

### 4.3 `migrations/0002_seed_court_codes.sql`

Amorce **minimale** et honnête : uniquement ce qui est soit documenté, soit vérifiable de visu. Tout le reste sera découvert et corrigé à l'usage (§6.4). Les lignes `verified = 0` sont des hypothèses, **et le code doit les traiter comme telles**.

```sql
INSERT INTO court_codes (code, database_id, caseid_code, jurisdiction, lang, verified, note) VALUES
  -- Documenté par la documentation de l'API (exemple Dunsmuir).
  ('CSC',   'csc-scc', 'scc',   'ca', 'fr', 1, 'documenté : caseBrowse/fr/csc-scc/2008scc9'),
  ('SCC',   'csc-scc', 'scc',   'ca', 'en', 1, 'documenté'),
  -- Cours du Québec : le code neutre est langue-neutre et paraît identique au databaseId.
  ('QCCA',  'qcca',  'qcca',  'qc', NULL, 0, 'hypothèse : identité'),
  ('QCCS',  'qccs',  'qccs',  'qc', NULL, 0, 'hypothèse : identité'),
  ('QCCQ',  'qccq',  'qccq',  'qc', NULL, 0, 'hypothèse : identité'),
  ('QCCM',  'qccm',  'qccm',  'qc', NULL, 0, 'hypothèse : identité'),
  ('QCTAL', 'qctal', 'qctal', 'qc', NULL, 0, 'hypothèse : identité'),
  ('QCTAT', 'qctat', 'qctat', 'qc', NULL, 0, 'hypothèse : identité'),
  ('QCTAQ', 'qctaq', 'qctaq', 'qc', NULL, 0, 'hypothèse : identité'),
  ('QCTP',  'qctp',  'qctp',  'qc', NULL, 0, 'hypothèse : identité'),
  -- Fédéral : les databaseId composés NE SONT PAS documentés. À corriger à l'usage.
  ('CAF',   'caf-fca', 'fca', 'ca', 'fr', 0, 'À VÉRIFIER — motif csc-scc supposé'),
  ('FCA',   'caf-fca', 'fca', 'ca', 'en', 0, 'À VÉRIFIER'),
  ('CF',    'cf-fc',   'fc',  'ca', 'fr', 0, 'À VÉRIFIER'),
  ('FC',    'cf-fc',   'fc',  'ca', 'en', 0, 'À VÉRIFIER'),
  ('CCI',   'cci-tcc', 'tcc', 'ca', 'fr', 0, 'À VÉRIFIER'),
  ('TCC',   'cci-tcc', 'tcc', 'ca', 'en', 0, 'À VÉRIFIER');

INSERT INTO paren_codes (juris_code, court_code, database_id, verified) VALUES
  ('QC', 'CA',  'qcca', 0),
  ('QC', 'CS',  'qccs', 0),
  ('QC', 'CQ',  'qccq', 0),   -- documenté par l'exemple 2002 CanLII 32322 (QC CQ)
  ('QC', 'CM',  'qccm', 0),
  ('CA', 'SCC', 'csc-scc', 1),
  ('CA', 'CSC', 'csc-scc', 1);
```

> **Tâche d'amorçage obligatoire après le premier déploiement.** Exécuter `scripts/refresh-databases.ts` (ou l'outil `canlii_list_databases` avec `refresh: true`), puis réconcilier `court_codes.database_id` contre les `databaseId` réellement renvoyés par `caseBrowse/fr/`. **Ne pas livrer les lignes fédérales `verified = 0` sans cette réconciliation** ; si un `databaseId` amorcé n'existe pas au répertoire, corriger la ligne et passer `verified = 1`.

---

## 5. Client CanLII

### 5.1 Contrat

```ts
// src/canlii/client.ts
export interface CanliiClient {
  get<T>(path: string, params?: Record<string, string | number>): Promise<T>;
  callsMade(): number;
}
```

- Base : `https://api.canlii.org/v1`. **HTTPS uniquement** — le HTTP n'est plus pris en charge par l'API.
- `api_key` ajoutée systématiquement en paramètre de requête, **après** les autres paramètres.
- Le client est instancié **une fois par invocation d'outil** et porte son propre compteur, afin que `CANLII_MAX_CALLS_PER_INVOCATION` soit un plafond réel et non global.

### 5.2 Étranglement, réessais, délais

Le quota de CanLII n'est pas publié (§16.2). Le comportement par défaut est donc délibérément prudent :

- **Séquentiel.** Aucune concurrence sortante. Un utilisateur unique n'a rien à y gagner et un pic peut coûter la clef.
- **Intervalle minimal** de `CANLII_MIN_INTERVAL_MS` (250 ms) entre deux appels de la même invocation.
- **Réessais** sur `429`, `500`, `502`, `503`, `504` : trois tentatives, temporisation exponentielle `500 ms × 2ⁿ` plus gigue de 0–200 ms ; si un en-tête `Retry-After` est présent, il **prime**. Incrémenter `api_usage.throttled` à chaque `429`.
- **Pas de réessai** sur `400`, `401`, `403`, `404`.
- **Délai** : `AbortSignal.timeout(CANLII_TIMEOUT_MS)`.
- **Plafond dur** : au-delà de `CANLII_MAX_CALLS_PER_INVOCATION`, lever `CanliiBudgetError` ; le gestionnaire d'outil renvoie alors les résultats **partiels** obtenus, assortis d'une mention explicite (« budget d'appels épuisé — résultat partiel »), plutôt qu'une erreur sèche.
- **Charge utile** : l'API refuse les transferts supérieurs à 10 Mo et renvoie alors un objet portant `"error": "TOO_LONG"`. Le détecter et le traduire en français ; réduire `resultCount` de moitié et réessayer une fois.

### 5.3 Journalisation et rédaction

**La clef d'API ne doit jamais quitter le processus.** Toute journalisation d'URL passe par :

```ts
export function redactUrl(u: string): string {
  const url = new URL(u);
  if (url.searchParams.has("api_key")) url.searchParams.set("api_key", "***");
  return url.toString();
}
```

Le corps d'une réponse d'erreur est journalisé tronqué à 512 caractères, après passage par `redactUrl`. Aucune sortie d'outil ne contient d'URL `api.canlii.org` — uniquement des hyperliens `canlii.ca`.

---

## 6. L'analyseur de citations

C'est le cœur du connecteur. Il est **pur** (aucune E/S), donc entièrement testable hors ligne.

### 6.1 Formes reconnues

| Forme | Exemple | Constructible | Sortie de l'analyseur |
|---|---|---|---|
| Neutre | `2020 QCCA 495` | oui | `{kind:'neutral', year:2020, code:'QCCA', number:495}` |
| Neutre, SCC français | `2008 CSC 9` | oui | code `CSC` → `caseid_code` `scc` |
| Attribuée par CanLII | `2002 CanLII 32322 (QC CQ)` | oui | `{kind:'canlii', year, number, juris:'QC', court:'CQ'}` |
| Neutre enchâssée | `Dunsmuir c. Nouveau-Brunswick, [2008] 1 RCS 190, 2008 CSC 9 (CanLII)` | oui | l'analyseur **balaie** la chaîne et retient la forme neutre |
| Recueil | `[1996] 3 R.C.S. 211` · `[1985] C.A. 105` · `[1998] R.J.Q. 1234` | non | `{kind:'reporter', reporter:'R.C.S.', year, page}` |
| Identifiant d'éditeur | `J.E. 94-1234` · `REJB 1998-09876` · `EYB 2005-12345` · `AZ-51234567` · `D.T.E. 2004T-123` | non | `{kind:'publisher', scheme:'SOQUIJ'|'Yvon Blais'}` |
| Non reconnue | `voir l'arrêt de la Cour d'appel` | non | `{kind:'unparsed'}` |

**Le balayage prime sur l'appariement total.** Une citation doctrinale complète contient presque toujours la forme neutre au milieu d'autres éléments ; l'analyseur doit l'y trouver. Ordre de recherche : (1) forme attribuée par CanLII, (2) forme neutre, (3) recueils, (4) identifiants d'éditeurs. Si plusieurs formes coexistent, retenir la constructible et **mentionner les autres** dans le champ `parallel`.

### 6.2 Expressions régulières de référence

```ts
// Citation neutre : année + identifiant de tribunal (lettres majuscules) + numéro d'ordre.
const NEUTRAL = /\b(1[89]\d{2}|20\d{2})\s+([A-Z]{2,8})\s+(\d{1,6})\b/g;

// Citation attribuée par CanLII, avec son couple de codes entre parenthèses.
const CANLII  = /\b(1[89]\d{2}|20\d{2})\s+CanLII\s+(\d{1,7})\s*\(\s*([A-Z]{2})\s+([A-Z]{1,6})\s*\)/gi;

// Recueils : [année] volume? sigle page.
const REPORTER = /\[(1[89]\d{2}|20\d{2})\]\s*(\d+)?\s*((?:[A-Z]\.){2,4}|R\.?C\.?S\.?|RCS|SCR|R\.?J\.?Q\.?|C\.?A\.?|C\.?S\.?|C\.?Q\.?)\s*(\d+)/g;

// Identifiants d'éditeurs.
const PUBLISHER = /\b(J\.?E\.?\s*\d{2,4}-\d+|REJB\s*\d{4}-\d+|EYB\s*\d{4}-\d+|AZ-\d{6,10}|D\.?T\.?E\.?\s*\d{4}T?-\d+)\b/gi;
```

Écarter les faux positifs de `NEUTRAL` : un code de deux lettres suivi d'un numéro peut apparaître fortuitement. Exiger que le code figure dans `court_codes` **ou** corresponde au motif d'un identifiant de tribunal canadien (2 à 8 majuscules, commençant par un code de ressort connu : `QC`, `ON`, `BC`, `AB`, `SK`, `MB`, `NS`, `NB`, `PE`, `NL`, `YK`, `NT`, `NU`, ou un code fédéral). Un code inconnu mais bien formé produit `constructible: 'probable'` — on tente l'appel et on consigne le résultat.

### 6.3 Construction du `caseId`

```
caseId = `${year}${caseid_code}${number}`      // formes neutres, minuscules, sans rembourrage
caseId = `${year}canlii${number}`              // formes attribuées par CanLII
```

`databaseId` provient de `court_codes.database_id` (formes neutres) ou de `paren_codes.database_id` (formes CanLII).

**Contrôle croisé disponible.** L'API expose un champ `concatenatedId` de la forme `${year}${databaseId}${number}` (« 2008csc-scc9 »). Il n'existe aucun endpoint qui l'accepte en entrée, mais il permet de **valider** qu'un `databaseId` déduit est le bon lorsqu'une fiche est obtenue par un autre chemin. L'utiliser dans la boucle d'auto-correction.

### 6.4 Auto-correction du répertoire

Lorsqu'une résolution directe échoue par `404` alors que la forme est bien constructible :

1. Si `court_codes.lang` n'est pas nul, **réessayer avec le code de la langue opposée** dans le `caseId` (`2008csc9` ↔ `2008scc9`). Réussite ⇒ mettre à jour `court_codes.caseid_code`, passer `verified = 1`, consigner dans `note`.
2. Si le `databaseId` est composé (`a-b`) et que l'échec persiste, **réessayer avec chaque moitié** comme `databaseId`. Réussite ⇒ corriger `court_codes.database_id`.
3. Si le `databaseId` déduit **n'existe pas** dans `databases`, ne pas appeler l'API : renvoyer `INTROUVABLE` en indiquant que le tribunal n'est pas au répertoire, et proposer `canlii_list_databases`.
4. Chaque échec définitif est consigné dans `search_log` avec `fallback = 'unknown_court'`.

Le coût de cette boucle est plafonné : **au plus deux tentatives supplémentaires par citation**, comptées dans le budget d'appels.

### 6.5 Comparaison d'intitulés

Normaliser (`src/citation/normalize.ts`) : minuscules, pliage des diacritiques (`NFD` + suppression des marques combinantes), suppression de la ponctuation, réduction des espaces, et retrait des jetons vides de sens — `c`, `v`, `et`, `al`, `inc`, `ltee`, `ltd`, `corp`, `cie`, `la`, `le`, `les`, `de`, `du`, `des`.

Verdict d'appariement, sur les jetons restants :

- **appariement** si tous les jetons significatifs du plus court sont présents dans le plus long ;
- **appariement partiel** si l'indice de Jaccard ≥ 0,5 ;
- **discordance** sinon.

Un **appariement partiel** produit le verdict `DISCORDANTE`, jamais `CONFIRMÉE` : mieux vaut un faux signalement qu'une fausse assurance. Les deux intitulés sont affichés verbatim, côte à côte.

> **Piège à couvrir en test :** les intitulés anonymisés du droit de la famille et de la protection de la jeunesse (« Droit de la famille — 20495 », « Protection de la jeunesse — 231234 ») ne contiennent aucun nom de partie. La comparaison doit fonctionner sur le numéro et ne pas produire de discordance pour absence de patronyme.

---

## 7. Les dix outils

**Conventions communes** — appliquées sans exception :

- Nom d'outil en anglais, **description et sortie en français** (motif `qclaw`).
- `annotations: { readOnlyHint: true, openWorldHint: true }` sur tous les outils.
- `additionalProperties: false` sur tous les schémas.
- Tout paramètre `lang` : `enum ["fr","en"]`, défaut `"fr"`.
- Toute liste : `limit` avec défaut et maximum documentés ; troncature signalée en toutes lettres (« 50 premiers sur 214 »).
- Toute sortie d'outil heuristique se termine par sa mise en garde (§2).
- Erreur d'exécution ⇒ `{ content: [...], isError: true }` en français, **jamais** une erreur JSON-RPC (réservée aux fautes de protocole).

### 7.1 `canlii_verify_citations` — l'outil pivot

> **Description (verbatim) :** « Vérifie une ou plusieurs citations de jurisprudence contre la collection de CanLII. Pour chacune : un verdict (CONFIRMÉE, DISCORDANTE, INTROUVABLE, NON CONSTRUCTIBLE, ILLISIBLE), la fiche officielle (intitulé, citation, date, n° de dossier, hyperlien) et, s'il y a lieu, l'écart avec l'intitulé attendu. Établit l'EXISTENCE et l'IDENTITÉ d'une décision ; n'établit NI son autorité actuelle (aucun historique d'appel, aucun indicateur de traitement), NI le contenu de son dispositif. Outil de choix pour éprouver des références tirées de la doctrine, d'un moteur de recherche ou d'un texte rédigé par une IA. Les citations de recueils (R.C.S., R.J.Q., C.A.) et les identifiants d'éditeurs (J.E., REJB, EYB, AZ) ne sont pas résolubles directement : enchaîner avec canlii_find_case. »

```jsonc
{
  "type": "object",
  "properties": {
    "citations": {
      "type": "array", "minItems": 1, "maxItems": 25,
      "items": {
        "type": "object",
        "properties": {
          "citation":       { "type": "string", "maxLength": 400 },
          "expected_title": { "type": "string", "maxLength": 300 },
          "expected_year":  { "type": "integer", "minimum": 1800, "maximum": 2100 }
        },
        "required": ["citation"],
        "additionalProperties": false
      }
    },
    "lang":    { "type": "string", "enum": ["fr", "en"] },
    "refresh": { "type": "boolean" }
  },
  "required": ["citations"],
  "additionalProperties": false
}
```

**Algorithme, par citation :**

1. Analyser (§6). `unparsed` ⇒ `ILLISIBLE`. `reporter`/`publisher` ⇒ `NON CONSTRUCTIBLE` — et si `expected_title` est fourni, **enchaîner automatiquement** un `find_case` borné (± 1 an) et proposer les candidats.
2. Cache `cases` (sauf `refresh`). Sinon `GET caseBrowse/{lang}/{db}/{caseId}/`, avec la boucle d'auto-correction (§6.4). Persister la fiche obtenue.
3. `404` définitif ⇒ `INTROUVABLE`.
4. Comparer : intitulé (§6.5), année de `decisionDate` contre `expected_year`. Concordance ⇒ `CONFIRMÉE` ; écart ⇒ `DISCORDANTE`, les deux valeurs affichées.
5. Consigner dans `search_log` (`tool`, `query`, `verdict`).

Gabarit de sortie : **Annexe A.1**.

### 7.2 `canlii_find_case`

> **Description :** « Recherche une décision par les noms des parties ou un fragment d'intitulé, avec tribunal et bornes de date facultatifs. Sert de rattrapage lorsque la citation n'est pas constructible (recueils, SOQUIJ) ou lorsqu'on ne connaît que les parties et l'année. Interroge d'abord l'index local, puis balaie la base de CanLII sur la fenêtre demandée. La recherche porte sur l'INTITULÉ et les mots-clés uniquement — l'API de CanLII n'expose pas le texte des décisions et ne permet aucune recherche par mots du texte. »

```jsonc
{
  "type": "object",
  "properties": {
    "title":       { "type": "string", "minLength": 2, "maxLength": 200 },
    "database_id": { "type": "string", "maxLength": 20 },
    "year_from":   { "type": "integer", "minimum": 1800, "maximum": 2100 },
    "year_to":     { "type": "integer", "minimum": 1800, "maximum": 2100 },
    "lang":        { "type": "string", "enum": ["fr", "en"] },
    "limit":       { "type": "integer", "minimum": 1, "maximum": 25 },
    "live":        { "type": "boolean" }
  },
  "required": ["title"],
  "additionalProperties": false
}
```

**Algorithme :**

1. **Index local d'abord** : `cases_fts MATCH ?` filtré par `database_id` et par la fenêtre de dates. Résultats suffisants ⇒ renvoyer, en indiquant la provenance.
2. **Balayage vif** si `live` (défaut : vrai lorsque l'index rend moins de trois candidats) : pour chaque année de la fenêtre, `GET caseBrowse/{lang}/{db}/?offset=0&resultCount=5000&decisionDateAfter=YYYY-01-01&decisionDateBefore=YYYY-12-31`, pagination par `offset` jusqu'à épuisement ou plafond de budget. `resultCount = 5000` et non le maximum de 10 000 : marge sous le plafond de 10 Mo.
3. Filtrer côté Worker sur `title_norm` (§6.5). **Persister toutes les fiches moissonnées** si `PERSIST_SWEEPS` — c'est ainsi que l'index se construit (D6). Écriture par lots `db.batch()` de 100 énoncés.
4. `database_id` absent : exiger une fenêtre de dates d'au plus 3 ans et balayer les bases québécoises usuelles (`qcca`, `qccs`, `qccq`) ; au-delà, refuser en demandant de préciser le tribunal.

Gabarit : **Annexe A.2**.

### 7.3 `canlii_get_case`

> **Description :** « Fiche officielle d'une décision : intitulé, citation, date, numéro de dossier de cour, mots-clés et hyperlien canlii.ca. Accepte soit une citation (« 2020 QCCA 495 »), soit le couple database_id + case_id. Ne renvoie PAS le texte de la décision : suivre l'hyperlien. »

Paramètres : `citation` **ou** (`database_id` + `case_id`) ; `lang` ; `refresh`. Valider qu'exactement l'une des deux formes est fournie.

### 7.4 `canlii_citator`

> **Description :** « Citateur : décisions citées PAR une décision (`cited`), décisions qui LA citent (`citing`), ou dispositions législatives qu'elle cite (`legislation`). Les listes sont brutes : elles n'indiquent aucun sens de traitement (suivi, distingué, infirmé). Pour les dispositions québécoises, enchaîner avec le connecteur « Législation du Québec » afin d'en lire le texte officiel. »

Paramètres : `database_id`, `case_id` (ou `citation`), `rel` (`enum ["cited","citing","legislation"]`), `limit` (défaut 50, max 100), `offset`, `refresh`.

> **Contrainte de l'API à coder en dur :** le chemin du citateur **n'accepte que `en`** comme segment de langue. Construire `caseCitator/en/{db}/{caseId}/{metadataType}` quel que soit le `lang` demandé, et rendre malgré tout la sortie en français. Ne pas exposer de paramètre `lang` sur cet outil.

Correspondance `rel` → `metadataType` : `cited` → `citedCases`, `citing` → `citingCases`, `legislation` → `citedLegislations`.

### 7.5 `canlii_subsequent_history`

> **Description :** « Indice heuristique de sorts ultérieurs : parmi les décisions qui citent la décision de départ, retient celles qui émanent d'une juridiction supérieure et dont l'intitulé ressemble au sien. NE REMPLACE PAS un citateur professionnel : n'indique pas si la décision a été infirmée, confirmée ou distinguée, et ne détecte ni les pourvois pendants, ni les refus de permission d'appeler, ni les désistements. À vérifier systématiquement à la source. »

Algorithme : `citing` ⇒ filtrer sur (a) `database_id` de rang supérieur selon la table de hiérarchie ci-dessous, (b) similarité d'intitulé ≥ 0,5 (§6.5), (c) `decisionDate` postérieure. Trier par date croissante.

| Base de départ | Juridictions supérieures |
|---|---|
| `qccq`, `qctal`, `qctat`, `qctaq` | `qccs`, `qcca`, `csc-scc` |
| `qccs` | `qcca`, `csc-scc` |
| `qcca` | `csc-scc` |
| autres | `csc-scc` |

La sortie porte **en tête et en pied** la mise en garde. Aucune formulation affirmative (« a été infirmée ») n'est permise : uniquement « indice », « susceptible », « à vérifier ».

### 7.6 `canlii_browse_cases`

> **Description :** « Liste les décisions d'un tribunal, les plus récemment diffusées en tête, avec filtres de date : date de la décision (`decision_date_*`), date de diffusion sur CanLII (`published_*`) ou date de dernière modification (`modified_*`, `changed_*`). Utile pour la veille et pour cerner la couverture de CanLII pour un tribunal donné. »

Paramètres : `database_id` (obligatoire), `lang`, `offset` (défaut 0), `limit` (défaut 25, **max 100** — bien en deçà du maximum de 10 000 de l'API : au-delà, la sortie est inexploitable par un modèle), plus les huit filtres de dates, tous au format `AAAA-MM-JJ` et **inclusifs**.

Rappeler dans la sortie, lorsqu'un filtre `published_*` est employé, le délai de diffusion et le jeu de deux jours recommandé.

### 7.7 `canlii_list_databases`

> **Description :** « Répertoire des bases de CanLII : cours et tribunaux (`kind='case'`) ou corpus législatifs (`kind='legislation'`), avec leur databaseId et leur ressort. Point de départ de toute commande exigeant un database_id. »

Paramètres : `kind`, `jurisdiction`, `query` (recherche sur `name_norm`), `refresh`. Sert le répertoire local si `refreshed_at` a moins de 7 jours ; sinon `GET caseBrowse/{lang}/` et `GET legislationBrowse/{lang}/`, puis mise à jour (deux appels — le rafraîchissement est aussi ce que fait le cron).

### 7.8 `canlii_browse_legislation`

> **Description :** « Liste les lois ou règlements d'une base législative (p. ex. « qcs » pour les lois du Québec), avec leur legislationId, leur citation et leur type. »

### 7.9 `canlii_get_legislation`

> **Description :** « Fiche d'une loi ou d'un règlement : citation, type, régime de dates (entrée en vigueur), dates de début et de fin, indicateur d'abrogation et découpage en parties. Utile pour dater une disposition ou vérifier une abrogation. Pour le TEXTE d'une loi ou d'un règlement du Québec, utiliser le connecteur « Législation du Québec », qui rend le texte officiel verbatim. »

Rendre `repealed` en français explicite (« Abrogé : oui / non ») et afficher `dateScheme`, `startDate`, `endDate`.

### 7.10 `canlii_parse_citation`

> **Description :** « Analyse une citation sans appeler CanLII : indique la forme reconnue (citation neutre, citation attribuée par CanLII, recueil, identifiant d'éditeur), et, si elle est constructible, le database_id et le case_id qui en découlent. Outil de diagnostic ; pour vérifier réellement l'existence d'une décision, utiliser canlii_verify_citations. »

Aucun appel sortant, aucune écriture. Utile au débogage de la table `court_codes` et pour expliquer un `NON CONSTRUCTIBLE`.

---

## 8. Transport MCP et routage

| Route | Méthode | Réponse |
|---|---|---|
| `/mcp/<secret>` | `POST` | Point d'entrée MCP (Streamable HTTP, mode JSON sans état) |
| `/mcp` | `POST` | `401` + `WWW-Authenticate: Bearer` (le secret peut aussi venir de l'en-tête `Authorization`) |
| `/mcp*` | `GET`, `DELETE` | `405` — aucun flux SSE, aucune session |
| `/health` | `GET` | `200 {"status":"ok"}` — sans authentification, sans divulgation |
| tout le reste | — | `404` |

`MCP_ENABLED !== "true"` ⇒ **`404` sur toutes les routes MCP**, y compris `/health`. Coupe-circuit identique à celui d'Athéna.

**Méthodes JSON-RPC :** `initialize`, `notifications/initialized` (⇒ `202`, corps vide), `tools/list`, `tools/call`, `ping`. Toute autre méthode ⇒ `-32601`.

`initialize` : négocier `protocolVersion` (accepter `2025-06-18` et `2025-03-26` ; renvoyer la plus élevée commune) ; `serverInfo: { name: "jurisprudence-canlii", version: <package.json> }` ; `capabilities: { tools: {} }`.

**Enveloppe de résultat**, calquée sur `mcp/tools.py` d'Athéna :

```ts
{ content: [{ type: "text", text: <sortie française> }], isError: false }
```

Ne **pas** émettre `structuredContent` : `qclaw` ne le fait pas, la sortie est du texte destiné à être lu, et la symétrie prime.

**Validation des arguments** : porter `validate_args` de `athena/mcp/tools.py` en TypeScript — même sous-ensemble (`type`, `properties`, `required`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `items` sur un niveau, `additionalProperties: false`), mêmes messages, en français. Échec ⇒ `isError: true`, jamais une erreur JSON-RPC.

---

## 9. Sécurité

### 9.1 Authentification

Le secret est accepté sous deux formes, afin de couvrir tous les clients :

1. dernier segment du chemin : `POST /mcp/<secret>` ;
2. en-tête : `Authorization: Bearer <secret>`.

**Deux secrets sont admis**, aux droits strictement identiques : `MCP_SHARED_SECRET`
(connecteur claude.ai) et `MCP_SHARED_SECRET_ATHENA` (clavardage de Pallas Athéna,
§19). Le second est facultatif ; absent, un seul porteur est admis et le comportement
est celui d'avant. Ils ne délimitent aucun périmètre — ce que protège D7 reste la clef
d'API et son quota — et n'existent séparément que pour la **révocation** : faire
tourner le secret de claude.ai ne doit pas éteindre le clavardage du cabinet, ni
l'inverse. Corollaires : le Worker reste **fermé par défaut** (aucun secret configuré ⇒
tout est refusé), les deux échecs rendent le **même** `401`, et aucune réponse ni aucune
trace ne dit lequel a servi.

Comparaison **à temps constant**, sur les empreintes plutôt que sur les chaînes (ce qui neutralise aussi l'écart de longueur) :

```ts
async function secretOk(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
```

### 9.2 Journalisation

L'URL complète d'une requête entrante contient le secret. **Ne jamais journaliser `request.url` tel quel** : journaliser la méthode, le nom de l'outil et le statut. Le secret est remplacé par `/mcp/***` dans toute trace. Cette contrainte est le prix de la simplicité du modèle D7 et doit figurer en commentaire dans `src/index.ts`.

### 9.3 Étranglement au bord

Ajouter dans le tableau de bord Cloudflare une règle de limitation de débit sur `jurisprudence.poirierlavoie.ca` : **60 requêtes/minute par IP**, action « bloquer ». Défense en profondeur si le secret fuit.

### 9.4 Chemin d'évolution vers OAuth 2.1

Si le connecteur est un jour partagé, ou si un audit l'exige, remplacer §9.1 par `@cloudflare/workers-oauth-provider` : émission des jetons dans KV, `/.well-known/oauth-protected-resource` (RFC 9728) et `/.well-known/oauth-authorization-server` (RFC 8414), enregistrement dynamique de client (RFC 7591) restreint aux URI de rappel de Claude. C'est exactement ce qui existe déjà dans la phase I d'Athéna — le flux est connu. **Ne pas l'implémenter maintenant** : la complexité n'est pas justifiée par la valeur protégée.

### 9.5 Secret professionnel

Ce connecteur est, sur ce plan, exceptionnellement propre : ce qui sort de l'infrastructure, ce sont des **citations, des identifiants de tribunaux et des dates**. Aucun nom de client, aucun fait de dossier, aucun document.

**Une seule réserve, à documenter dans le README** : `canlii_find_case` prend des **noms de parties**. Si ce nom est celui d'une partie à un dossier en cours plutôt que celui d'une décision publiée, la requête révèle à CanLII un intérêt de recherche. Le risque est faible — CanLII est un organisme sans but lucratif canadien, et la recherche jurisprudentielle nominative est l'usage normal du site — mais il n'est pas nul, et il mérite d'être connu plutôt que découvert.

---

## 10. Observabilité

- `observability: { enabled: true }` dans `wrangler.jsonc` ; consultation par `wrangler tail`.
- **Une ligne `search_log` par invocation d'outil**, y compris en cas de succès : c'est la matière première du réglage de l'analyseur. Les échecs (`result_count = 0`) sont indexés séparément.
- **`api_usage`** incrémentée à chaque appel sortant (`calls`), erreur (`errors`) et `429` (`throttled`). Requête d'exploitation :

```sql
SELECT day, calls, errors, throttled FROM api_usage ORDER BY day DESC LIMIT 30;
```

- **Aucun journal ne contient** la clef d'API, le secret partagé, ni une URL non redactée.
- Requête de diagnostic de l'analyseur — les citations que l'on ne sait pas résoudre :

```sql
SELECT query, COUNT(*) n FROM search_log
WHERE tool = 'canlii_verify_citations' AND verdict IN ('ILLISIBLE','INTROUVABLE')
GROUP BY query ORDER BY n DESC LIMIT 50;
```

---

## 11. Moissonnage planifié — facultatif, désactivé par défaut

**Ne pas activer sans la détermination de §16.1.**

Motif : un index local complet des cours du Québec rendrait `canlii_find_case` instantané et fiable, au lieu de dépendre d'un balayage. La documentation de l'API paraît prévoir cet usage — les filtres `changedAfter` / `modifiedAfter` n'ont guère d'autre raison d'être que la tenue à jour d'une copie locale, et `resultCount` monte à 10 000. Cela reste une **lecture de la documentation, non une autorisation**.

Conception, si activé (`BACKFILL_ENABLED = "true"`) :

- Déclencheur `cron` quotidien ; **plafond de 15 minutes** de durée pour une exécution planifiée, et 30 s de CPU pour un intervalle inférieur à l'heure — l'exécution doit donc être **reprenable**.
- Bases visées : liste dans une variable `BACKFILL_DATABASES` (p. ex. `qcca,qccs,qccq,qctal`).
- Par base, deux phases : (a) **rattrapage** en remontant le temps par fenêtres annuelles depuis `sync_state.cursor_date` ; (b) **delta** quotidien par `changedAfter = dernière exécution − 2 jours` (le jeu recommandé par la documentation).
- Curseur persisté après **chaque page**, jamais seulement en fin d'exécution.
- Budget d'appels sortants distinct et plus généreux que celui des outils, mais borné ; abandon propre à l'approche du plafond de durée.
- Ordre de grandeur : environ 300 octets par fiche ; quelques centaines de milliers de décisions québécoises tiennent largement sous le plafond de taille d'une base D1 — **le vérifier à l'implémentation contre la page des limites de D1**, et prévoir le partage par base si nécessaire.

---

## 12. CI/CD

Dépôt GitHub distinct, calqué sur les protections d'Athéna : **actions épinglées par SHA**, permissions minimales, jetons à portée réduite.

| Fichier | Contenu |
|---|---|
| `.github/workflows/ci.yml` | `tsc --noEmit` · Biome (lint + format) · Vitest avec `@cloudflare/vitest-pool-workers` · `wrangler deploy --dry-run` |
| `.github/workflows/codeql.yml` | CodeQL, langage `javascript-typescript` |
| `.github/workflows/osv-scanner.yml` | OSV-Scanner sur `package-lock.json` |
| `.github/workflows/trivy.yml` | Trivy, mode système de fichiers |
| `.github/workflows/scorecard.yml` | OpenSSF Scorecard |
| `.github/dependabot.yml` | npm + github-actions, hebdomadaire |
| `.github/workflows/deploy.yml` | Sur `push` vers `main` : `wrangler d1 migrations apply canlii --remote` **puis** `wrangler deploy` |

**Ordre impératif dans `deploy.yml` : les migrations d'abord, le déploiement ensuite.** Le schéma inverse déploie du code qui lit des colonnes inexistantes. Secret de dépôt : `CLOUDFLARE_API_TOKEN` (portée : édition des Workers + D1 sur le seul compte visé).

---

## 13. Plan de test

**Analyseur (`citation.parse.test.ts`) — matrice obligatoire.** Chaque ligne est un cas :

| Entrée | Attendu |
|---|---|
| `2020 QCCA 495` | `qcca` / `2020qcca495` |
| `2020 qcca 495` | idem (insensible à la casse) |
| `2008 CSC 9` | `csc-scc` / `2008scc9` |
| `2008 SCC 9` | `csc-scc` / `2008scc9` |
| `Dunsmuir c. Nouveau-Brunswick, [2008] 1 RCS 190, 2008 CSC 9 (CanLII)` | neutre extraite ; `[2008] 1 RCS 190` en `parallel` |
| `2002 CanLII 32322 (QC CQ)` | `qccq` / `2002canlii32322` |
| `2005 QCCA 304 (CanLII)` | `qcca` / `2005qcca304` |
| `[1996] 3 R.C.S. 211` | `reporter`, non constructible |
| `[1985] C.A. 105` | `reporter`, non constructible |
| `J.E. 94-1234` | `publisher` (SOQUIJ), non constructible |
| `REJB 1998-09876` · `EYB 2005-12345` · `AZ-51234567` | `publisher`, non constructible |
| `art. 1457 C.c.Q.` | `unparsed` (c'est une disposition, pas une décision) |
| `2023 QCTAL 12345` | `qctal` / `2023qctal12345` |
| `voir la décision de la Cour d'appel` | `unparsed` |
| `2020 XXQQ 12` | code inconnu ⇒ `constructible: 'probable'` |

**Comparaison d'intitulés :** accents (`Québec` ≡ `Quebec`), formes sociétaires (`9044-3422 Québec Inc.` ≡ `9044-3422 Quebec inc`), séparateurs (`c.` ≡ `v.`), intitulés anonymisés (`Droit de la famille — 20495`), inversion des parties ⇒ appariement, patronyme différent ⇒ discordance.

**Vérification (`verify.test.ts`, réponses figées) :** les cinq verdicts ; auto-correction `csc`↔`scc` avec mise à jour de `court_codes` ; `404` sur base inconnue **sans** appel sortant ; budget épuisé ⇒ résultat partiel annoncé.

**Client :** réessai sur `429` respectant `Retry-After` ; pas de réessai sur `400` ; expiration de délai ; `TOO_LONG` ⇒ `resultCount` halvé puis réessai unique ; **assertion que la clef n'apparaît dans aucune sortie de journal** (test de non-régression sur `redactUrl`).

**Transport (`rpc.test.ts`) :** `initialize` négocie la version ; `tools/list` rend 10 outils tous pourvus d'une description non vide ; `tools/call` sur outil inconnu ⇒ `isError`; `GET /mcp/<secret>` ⇒ `405` ; secret erroné ⇒ `401` ; `MCP_ENABLED = "false"` ⇒ `404` partout.

**Persistance :** un balayage remplit `cases` **et** `cases_fts` (déclencheurs) ; un second appel identique ne fait aucun appel sortant ; `refresh: true` en refait un.

**Contrat de vérité (test de garde) :** pour chaque outil heuristique, assertion que la sortie **contient** sa mise en garde. Ce test empêche qu'une refonte du gabarit la fasse disparaître silencieusement.

---

## 14. Déploiement — marche à suivre

1. Demander la clef d'API par le formulaire de commentaires de CanLII, en décrivant l'usage : outil interne de vérification de références pour une pratique d'avocat au Québec. **Y poser les questions de §16.1 et §16.2 dans le même message.**
2. `wrangler d1 create canlii --location enam` ; reporter l'`database_id` dans `wrangler.jsonc`.
3. `wrangler d1 migrations apply canlii --remote`.
4. `wrangler secret put CANLII_API_KEY` ; `openssl rand -hex 32` puis `wrangler secret put MCP_SHARED_SECRET`.
5. Créer l'enregistrement DNS `jurisprudence` sur la zone `poirierlavoie.ca` (domaine personnalisé du Worker — Cloudflare le gère).
6. `wrangler deploy`.
7. **Amorçage du répertoire** : appeler `canlii_list_databases` avec `refresh: true`, puis réconcilier `court_codes` et `paren_codes` (§4.3) ; passer `verified = 1` sur les lignes confirmées.
8. **Recette manuelle** : vérifier `2008 CSC 9` (⇒ *Dunsmuir*), une décision de la Cour d'appel du Québec connue, une citation volontairement fausse (`2020 QCCA 999999` ⇒ `INTROUVABLE`), une citation de recueil (⇒ `NON CONSTRUCTIBLE` avec candidats).
9. Ajouter le connecteur dans `claude.ai` : URL `https://jurisprudence.poirierlavoie.ca/mcp/<secret>`, nom « Jurisprudence canadienne et greffes du Québec ».
10. Activer la règle de limitation de débit (§9.3).
11. Après une semaine d'usage : dépouiller `search_log` (§10) et corriger l'analyseur sur les formes réellement rencontrées.

---

## 15. Récapitulatif des livrables de code

1. `src/index.ts` — routage, garde d'authentification à temps constant, coupe-circuit, gestionnaire `scheduled`.
2. `src/mcp/` — enveloppe JSON-RPC, registre des 10 outils, validateur de schéma, 10 gestionnaires.
3. `src/citation/` — analyseur, normalisation, comparaison d'intitulés. **Aucune E/S.**
4. `src/canlii/` — client étranglé et réessayé, types, erreurs, `redactUrl`.
5. `src/store/` — accès D1 : fiches + FTS, répertoire + auto-correction, citateur avec TTL, télémétrie.
6. `src/format/` — gabarits de sortie (Annexe A), formatage français des dates et des listes.
7. `migrations/0001_initial.sql`, `migrations/0002_seed_court_codes.sql`.
8. `test/` — matrice de l'analyseur, comparaison, vérification, client, transport, persistance, garde du contrat de vérité.
9. `.github/workflows/` — 6 workflows + `dependabot.yml`, actions épinglées par SHA.
10. `README.md` — mise en service, réserve de §9.5, et **reproduction in extenso du contrat de vérité de §2**.

---

## 16. Questions ouvertes pour le praticien

1. **Conditions d'utilisation et copie locale.** La conception fait sédimenter en D1 les fiches déjà consultées (D6) — difficilement distinguable d'un cache. Le **moissonnage planifié** (§11) est autre chose : c'est un téléchargement en masse. Il reste désactivé jusqu'à détermination. *À poser à CanLII en même temps que la demande de clef.*
2. **Quota et débit.** Aucun n'est publié. Les valeurs par défaut sont prudentes ; les demander explicitement lors de la demande de clef et ajuster `CANLII_MIN_INTERVAL_MS`.
3. **Forfait Cloudflare Workers.** Le gratuit plafonne à 50 sous-requêtes externes et 10 ms de CPU par invocation : le balayage vif et §11 supposent le forfait payant. *À confirmer avant §11.*
4. **Modèle d'authentification.** Secret partagé (D7) retenu pour la v1. Confirmer, ou demander OAuth 2.1 dès le départ (§9.4).
5. **Bases à indexer** si §11 est activé — proposition : `qcca`, `qccs`, `qccq`, `qctal`.
6. **Langue de la spécification.** Rédigée en français, comme `claude_spec-elabore-theorie-de-la-cause.md`. Le code, les identifiants et les noms d'outils restent en anglais.

---

## 17. Extension — greffes et palais du Québec (HORS CanLII)

*Ajoutée le 2026-07-30. Les §1 à §16 décrivent un connecteur adossé à la seule collection de CanLII ; la présente section étend le connecteur à des données d'une AUTRE provenance, et pose la frontière entre les deux.*

### 17.1 La frontière des sources, et pourquoi elle est dans le nom des outils

La décision **D8** conserve le préfixe `canlii_` parce que « la couverture et les verdicts DÉPENDENT de la collection de CanLII et que le modèle doit le savoir ». Le même raisonnement, appliqué à des données qui ne viennent PAS de CanLII, impose la conclusion inverse : leur donner le préfixe `canlii_` attribuerait à CanLII une adresse de palais de justice dont il n'est pas la source. D'où **deux familles** :

| Préfixe | Source | Appels sortants | Mode de panne redouté |
|---|---|---|---|
| `canlii_` (10) | collection de CanLII | oui | l'absence prise pour une inexistence |
| `greffe_`, `palais_` (3) | relevé local du ministère de la Justice du Québec (MJQ) | **aucun** | la **péremption** prise pour une vérité |

La scission est **vérifiée par `test/rpc.test.ts`** : aucun outil ne relève des deux familles ni n'échappe aux deux, et aucun outil local ne porte la chaîne `canlii` dans son nom. Ajouter un outil oblige donc à choisir sa famille délibérément.

### 17.2 `greffe_parse_court_file_number`

Analyse `NNN-NN-NNNNNN-NNN` : positions 1-3 le greffe (palais + district judiciaire), positions 5-6 la juridiction (tribunal + compétence + type de greffe). **Les positions 7 et suivantes ne sont PAS analysées** : il n'existe ni somme de contrôle ni règle d'année, et en inventer une rejetterait des numéros valides.

Un **préfixe alphabétique** (`TAL-`, `TAQ-`, `C.F.-`…) désigne un corps qui numérote ses dossiers lui-même : le préfixe EST la réponse à « quel tribunal ». Il se résout contre la table des forums, insensiblement aux points (`C.F.` ≡ `CF`). `is_administrative` n'est vrai que pour la catégorie *administratif* — **une cour fédérale n'est pas un tribunal administratif**. Un préfixe **inconnu** reste prudent (administratif, forum nul) et **n'est jamais une erreur** : aucun nom de tribunal n'est deviné.

Le code est un **port** de `parse_court_file_number` de Pallas Athéna, éprouvé par un **différentiel de 127 entrées** rejouées des deux côtés (`test/fixtures/dossier-athena.json`). Une divergence se répare dans le code, jamais dans la fixture.

### 17.3 `palais_list` · 17.4 `palais_get`

Répertoire des **43 palais de justice et 8 points de service** du MJQ, avec adresse municipale, greffes qui y siègent, district judiciaire et, pour les cours itinérantes, les localités desservies. `palais_get` accepte **exactement l'une** de deux formes (numéro de greffe OU nom), contrôlée dans le gestionnaire — le validateur de §8 ne sait pas exprimer `oneOf`.

### 17.5 Conséquences imposées au code (le contrat de vérité, transposé)

1. **La réserve de péremption, DATÉE, dans le corps de chaque réponse `palais_*`.** Le relevé est du **2026-07-15**. Sans sa date, le lecteur ne peut pas juger du risque qu'il prend ; les palais déménagent, et l'outil doit renvoyer à la liste officielle **avant toute signification ou tout dépôt**.
2. **Une adresse INCONNUE n'est jamais rendue comme INEXISTANTE.** Six greffes (525, 614, 635, 640, 652, 715) n'ont aucune adresse résolvable, dont quatre cours itinérantes. C'est le pendant exact de la règle INTROUVABLE de §2 : on énumère les explications concurrentes.
3. **Aucune coordonnée n'est portée**, et l'outil le DIT plutôt que de le laisser découvrir. Ni Athéna ni aucune donnée ouverte n'en fournit, et `justice.gouv.qc.ca` refuse toute requête automatisée. Le champ `contacts` existe, vide, **en tableau** : un palais publie plusieurs numéros, un par chambre — Montréal en publie au moins quatre.
4. **Trois pièges se conservent, ne se corrigent pas.** `point_de_service` désigne les greffes de cour **itinérante** côté greffe et les points de service du **MJQ** côté palais : ils divergent par construction. Le **nom d'un palais n'est pas sa ville** (Chicoutimi est à Saguenay ; Havre-Aubert aux Îles-de-la-Madeleine) — d'où une jointure par `palais_key`, jamais par le nom. **Kuujjuaq** est un palais publié qu'aucun greffe ne nomme : il reste non rattaché plutôt que deviné.

Ces conséquences sont verrouillées par `test/garde.test.ts`, au même titre que celles de §2, et les sorties du Québec entrent dans le balayage des **formulations interdites** — par leurs chemins d'ABSENCE, qui sont précisément ceux où la tentation existe.

### 17.6 Où vivent les données, et pourquoi pas en D1

**Constantes TypeScript** (`src/qc/`), et non une migration. La règle qui sépare les deux précédents du dépôt : `court_codes` vit en D1 parce que la boucle de §6.4 le **réécrit** ; ces tables-ci ne sont jamais réécrites, rien à l'exécution ne les contredit. Le gain décisif est que les trois outils restent **purs** — aucune lecture D1, donc aucun mode de panne, aucun quota, aucune dépendance au réseau. La transcription est **générée** depuis la source d'Athéna, non recopiée : 130 lignes recopiées à la main, c'est une adresse fausse qui ne se signale par aucune erreur.

### 17.7 Ce qui reste à faire

Les **coordonnées** (téléphone par chambre, courriels de service) s'ajouteront depuis la page officielle « Numéros des greffes des palais de justice et des points de service de justice », enregistrée à la main puisqu'elle est inaccessible automatiquement. Elle servira **deux fois** : remplir `contacts`, et **réconcilier les 56 numéros de greffe** contre la source officielle — une vérification du même ordre que §4.3, à consigner avec sa date.

---

## 18. Page publique (`GET /`)

*Ajoutée le 2026-07-30. Les §1 à §17 décrivent une surface exclusivement JSON, consommée par des clients MCP. Cette section ajoute la PREMIÈRE surface HTML, sur la même origine que `/mcp/<secret>` — d'où le soin.*

### 18.1 Ce que la page est, et ce qu'elle n'est pas

Une page **statique, publique, bilingue** décrivant le connecteur : ses treize outils, leurs schémas, la structure d'un numéro de dossier judiciaire québécois et ses issues, et le répertoire des greffes et palais. Elle sert deux publics — qui n'a pas accès au connecteur, et qui l'utilise et veut relire le contrat.

Elle n'est **pas** une console, n'accepte aucune saisie, n'appelle rien et n'écrit rien.

### 18.2 Route et sécurité

`GET` et `HEAD` sur **`/` exactement** ; toute autre méthode rend `405`. Le `404` final reste la réponse de tout autre chemin — l'égalité stricte est la garantie que la page n'est pas un fourre-tout.

Trois propriétés, toutes testées :

1. **Hors du bloc `/mcp`.** Le contrôle d'origine (§9.6), la limitation de débit (§9.3) et l'authentification (§9.1) y vivent tous. Une page publique doit répondre à n'importe quel navigateur : elle ne passe donc par aucun d'eux. **Corollaire impératif** : ne jamais remonter ces contrôles en portée globale « par cohérence », ce qui refuserait la page à tout visiteur arrivant d'un lien externe.
2. **Aucun en-tête CORS**, comme `/health`. Sans `Access-Control-Allow-Origin`, aucun script d'une autre origine ne peut LIRE la réponse : la page ne peut pas servir d'oracle.
3. **Le secret n'y paraît jamais.** La page documente la FORME `/mcp/<secret>`. Un test refuse toute chaîne de 32 caractères hexadécimaux ou plus, tout `Bearer`, et toute mention de `api.canlii.org` ou `api_key`.

**Exception au coupe-circuit (§8), délibérée.** `MCP_ENABLED=false` rend `404` sur `/health` et sur `/mcp` — au motif qu'un point d'entrée qui répondrait encore révélerait que le service existe. La page, elle, **reste servie** : elle existe pour être vue, ne porte ni secret ni donnée vivante, et c'est précisément quand le connecteur est coupé qu'on veut pouvoir lire pourquoi.

**En-têtes.** Servir du `text/html` fait de cette origine une origine de DOCUMENT, ce qu'elle n'était pas tant que tout était du JSON. D'où, sur `/` seulement : `Content-Security-Policy: default-src 'none'` avec `frame-ancestors 'none'` et `base-uri 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. `Cache-Control` court et **sans `s-maxage`** : le rendu ne coûte rien, et un cache d'arête durable ferait survivre la page à son propre déploiement.

### 18.3 Le contenu DÉRIVE des données, il ne les recopie pas

C'est la règle qui gouverne toute la section. Une page qui recopierait un titre d'outil, une borne de schéma ou une adresse de palais deviendrait fausse **sans qu'aucun test n'échoue**.

| Rendu | Source |
|---|---|
| Outils : nom, titre, description | `listToolDescriptors()` — la fonction même que sert `tools/list` |
| Schémas : types, bornes, `enum`, `required` | le `inputSchema` même que le validateur applique (§8) |
| Issues de l'analyse d'un numéro | `analyserNumeroDossier()` **exécutée au rendu** sur des exemples |
| Greffes, palais, districts, localités | les tables de `src/qc/` (§17) |
| Codes de juridiction | `JURIDICTIONS` |
| Réserves | les constantes `GARDE_*` **verbatim** |

Les exemples d'analyse sont **vivants** : la page appelle le vrai parseur et affiche ce qu'il rend. Cette documentation ne peut donc pas diverger du comportement — même raisonnement que le différentiel de §17.2.

### 18.4 Bilinguisme et thème

**Les deux langues sont émises**, une règle CSS en masque une (`html.l-fr [data-l=en]`). Le choix se fait dans le navigateur avant le premier rendu, depuis `localStorage` puis `navigator.language`. **Sans JavaScript, le français s'affiche et tout le contenu reste lisible.**

**Thème à trois états** : `auto → clair → sombre → auto`. « Auto » n'est pas une classe mais l'**absence** des deux autres — c'est ce qui rend la main à `prefers-color-scheme` — et il se persiste en *supprimant* la clef.

⚠ Langue et thème vivent sur le MÊME `<html>`. Écrire `className` en bloc dans l'un des deux gestionnaires effacerait l'autre classe **en silence** : les gestionnaires n'emploient que `classList`, et le script de tête les **compose**.

**L'anglais est du contenu NEUF.** Le dépôt est francophone et le français y est canonique — c'est lui que le modèle reçoit. `src/site.i18n.ts` ne porte donc **que** l'anglais, jamais une copie française. La parité est testée dans les **deux** sens, et aucune traduction ne peut être identique à son original.

### 18.5 Ce que la page doit dire, et qu'un site vitrine tairait

- Les **trois réserves imposées** (`GARDE_PALAIS` avec sa date, `GARDE_SANS_ADRESSE`, `GARDE_DOSSIER`), verbatim et dans le corps.
- **Aucune coordonnée n'est portée** — ni téléphone, ni courriel, ni heures — pour aucun palais, avec renvoi au ministère de la Justice. C'est une propriété de la donnée, énoncée plutôt que laissée à découvrir.
- Les **six greffes sans adresse publiée**, formulés comme « inconnue » et jamais « inexistante ».
- La **frontière des sources** : `canlii_*` contre `greffe_*`/`palais_*`. La section des greffes ne mentionne pas CanLII, et un test le vérifie.
- Les **formulations interdites** de §2 sont refusées dans la prose propre à la page. Les fiches d'outils en sont exclues du balayage : elles rendent les descriptions de §7 **verbatim**, dont l'une contient « a été infirmée » à l'intérieur d'une négation.

### 18.6 Autonomie

Aucune dépendance, **aucune requête tierce** : ni police distante, ni CDN, ni image, ni analytique. CSS et JavaScript sont en ligne dans le même module. Un test refuse tout `<script src>`, toute feuille de style externe et tout `@import`.

Deux gardes de dérive : **aucune couleur en dur** hors des deux jeux de variables (une couleur écrite en dur ne bascule pas et devient invisible dans l'un des deux thèmes), et les deux jeux déclarent **exactement** les mêmes variables.

---

## 19. Second porteur — le clavardage de Pallas Athéna

Athéna, le gestionnaire de pratique du même praticien, a un clavardage interne dont le
moteur de tour appelle Vertex AI directement (`:rawPredict` pour les modèles Anthropic,
`:generateContent` pour Gemini) et **exécute lui-même les appels d'outil**. Il consomme
ce connecteur comme n'importe quel autre client MCP.

**Rien n'a été ajouté au protocole pour lui**, et c'est le point important :

- il présente son secret par `Authorization: Bearer` sur `POST /mcp` — la forme 2 de
  §9.1, prévue dès l'origine « afin de couvrir tous les clients » ;
- il n'émet aucun en-tête `Origin` (appel serveur à serveur), donc la défense contre le
  ré-attachement DNS le laisse passer, comme `scripts/mcp-client.mjs` ;
- le **mode JSON sans état** de D3 lui permet un simple POST par appel, sans poignée de
  main `initialize` et sans `Mcp-Session-Id` à porter.

**Aucune façade REST n'a été ajoutée**, et il ne faut pas en ajouter : elle dupliquerait
les gestionnaires, ferait diverger deux surfaces d'un même outil, et contredirait D3. Le
client MCP vit du côté d'Athéna.

**Pourquoi l'exécution reste chez Athéna** plutôt que d'être confiée à un mécanisme de
MCP distant du côté de Google : le moteur de tour est l'endroit où vivent la ligne
d'audit de chaque appel d'outil, le mécanisme d'autorisation, le déchargement des gros
blocs et le calcul du coût. Sortir les appels d'outil de ce registre reviendrait à
perdre la traçabilité, qui est précisément ce qu'un dossier privilégié exige.

**Ce que le second secret change, et ce qu'il ne change pas.** Il ne délimite aucun
périmètre : les treize outils lui répondent comme au premier porteur. Il n'existe que
pour la révocation séparée (§9.1). Une conséquence assumée : la limitation de débit de
§9.3 est **par IP**, donc les deux clients ne se gênent pas — mais ils partagent le même
quota d'API CanLII, et c'est bien ce quota que D7 protège.

---

## Annexe A — Gabarits de sortie (verbatim)

### A.1 `canlii_verify_citations`

```
Vérification de 3 citation(s) — collection CanLII.

1. 2008 CSC 9 — CONFIRMÉE
   Dunsmuir c. Nouveau-Brunswick
   [2008] 1 RCS 190, 2008 CSC 9 (CanLII) · csc-scc · 2008-03-07
   N° de dossier : 31459
   Mots-clés : équité procédurale — raisonnabilité — arbitre — norme — contrôle judiciaire
   https://canlii.ca/t/1vxsn

2. [1985] C.A. 105 — NON CONSTRUCTIBLE
   Forme reconnue : recueil (Recueils de jurisprudence du Québec, Cour d'appel).
   L'API de CanLII ne résout pas les citations de recueils.
   → Fournir les noms des parties et l'année à canlii_find_case.

3. 2020 QCCA 999999 — INTROUVABLE
   Forme neutre bien formée (qcca / 2020qcca999999), mais aucune fiche.
   Explications possibles : numéro erroné · décision hors de la collection ·
   diffusion récente (prévoir un jeu de 2 jours).

Établit l'existence et l'identité, jamais l'autorité actuelle (aucun historique
d'appel, aucun indicateur de traitement) ni le contenu du dispositif.
```

Verdict `DISCORDANTE` — les deux valeurs, toujours :

```
2. 2005 QCCA 304 — DISCORDANTE
   Attendu  : « Syndicat des employés d'Hydro-Québec c. Hydro-Québec »
   Obtenu   : « Association provinciale des retraités d'Hydro-Québec c. Hydro-Québec »
   2005 QCCA 304 (CanLII) · qcca · 2005-03-31
   https://canlii.ca/t/...
   → La citation existe mais ne désigne pas la décision annoncée. Vérifier la source.
```

### A.2 `canlii_find_case`

```
3 candidat(s) pour « Hydro-Québec » (qcca, 2004→2006) :

1. Association provinciale des retraités d'Hydro-Québec c. Hydro-Québec
   2005 QCCA 304 (CanLII) · 2005-03-31 · qcca/2005qcca304
   https://canlii.ca/t/...
2. …

Provenance : index local (2 fiches) + balayage vif (1 appel, 1 843 fiches
parcourues, persistées).

Recherche sur l'intitulé et les mots-clés uniquement — l'API de CanLII n'expose
pas le texte des décisions.
```

### A.3 `canlii_subsequent_history`

```
Sorts ultérieurs — INDICE HEURISTIQUE, à vérifier à la source.

Départ : 2018 QCCS 1234 — Untel c. Unetelle (2018-03-15)

1. Unetelle c. Untel — 2019 QCCA 456 (CanLII) · 2019-03-20 · qcca
   Similarité d'intitulé : 0,86 · juridiction supérieure
   https://canlii.ca/t/...

Ce résultat n'indique NI le sens du traitement (confirmée, infirmée, distinguée),
NI les pourvois pendants, NI les refus de permission d'appeler. Ce n'est pas un
citateur professionnel.
```

---

## Annexe B — Endpoints de l'API employés

| Outil | Endpoint | Notes |
|---|---|---|
| `canlii_list_databases` | `caseBrowse/{lang}/` · `legislationBrowse/{lang}/` | Deux appels ; rafraîchi hebdomadairement |
| `canlii_browse_cases`, `canlii_find_case` | `caseBrowse/{lang}/{db}/?offset=&resultCount=` + filtres de dates | `resultCount` ≤ 5 000 par page (marge sous 10 Mo) |
| `canlii_get_case`, `canlii_verify_citations` | `caseBrowse/{lang}/{db}/{caseId}/` | Le chemin de résolution déterministe |
| `canlii_citator`, `canlii_subsequent_history` | `caseCitator/en/{db}/{caseId}/{metadataType}` | **`en` obligatoire** dans le chemin |
| `canlii_browse_legislation` | `legislationBrowse/{lang}/{db}/` | |
| `canlii_get_legislation` | `legislationBrowse/{lang}/{db}/{legislationId}/` | |

Contraintes transversales : **HTTPS uniquement** ; charge utile plafonnée à **10 Mo** (erreur `TOO_LONG`) ; dates au format **AAAA-MM-JJ**, bornes **inclusives** ; `caseId` renvoyé dans les listes sous forme d'objet clé par langue (`{"en": "..."}` ou `{"fr": "..."}`) — **aplatir à la lecture**.
