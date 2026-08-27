/**
 * Secrets du Worker — déclarés ici parce qu'ils N'APPARAISSENT PAS dans
 * `wrangler.jsonc` et ne peuvent donc pas être générés par `wrangler types`.
 * C'est voulu : un secret dans le fichier de configuration serait un secret versionné.
 *
 * ⚠ DEUX interfaces à augmenter, et non une. `wrangler types` émet à la fois
 *   `interface Env extends __BaseEnv_Env {}` au niveau GLOBAL (ce que voit le code du
 *   Worker) et `Cloudflare.Env` dans le namespace (ce que voit `env` importé de
 *   `cloudflare:test`). Les deux héritent de la même base mais sont distinctes :
 *   n'en augmenter qu'une laisse l'autre aveugle, et l'erreur ne se manifeste que
 *   dans les tests ou qu'en production, selon celle qu'on a oubliée.
 *
 * Les deux secrets sont posés par `wrangler secret put` en production et par
 * `.dev.vars` en développement. Tous deux sont OPTIONNELS au type près : le Worker
 * doit se comporter sainement quand ils manquent — démarrage sans secret = une
 * authentification qui refuse TOUT, jamais qui laisse tout passer.
 */

interface WorkerSecrets {
  /**
   * Clef d'API CanLII. JAMAIS journalisée, JAMAIS renvoyée, JAMAIS dans une trace :
   * toute URL sortante passe par `redactUrl()` avant d'atteindre un journal.
   */
  CANLII_API_KEY?: string;
  /** Secret partagé du point d'entrée MCP (D7) — 32 octets en hexadécimal. */
  MCP_SHARED_SECRET?: string;
  /**
   * SECOND secret du même point d'entrée, aux droits IDENTIQUES, et FACULTATIF.
   *
   * Il n'ouvre rien de plus : il existe pour que le clavardage de Pallas Athéna et le
   * connecteur claude.ai se révoquent SÉPARÉMENT. Un seul secret partagé par deux
   * clients ne se fait pas tourner sans les éteindre tous les deux — et un connecteur
   * compromis obligerait alors à interrompre le cabinet.
   *
   * Absent, le Worker se comporte exactement comme avant : un seul porteur admis.
   */
  MCP_SHARED_SECRET_ATHENA?: string;
}

interface Env extends WorkerSecrets {}

declare namespace Cloudflare {
  interface Env extends WorkerSecrets {}
}
