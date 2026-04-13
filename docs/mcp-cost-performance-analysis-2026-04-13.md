# Analyse synthese du MCP Obsidian Vault

Date: 2026-04-13

## Objectif

Cette note synthétise une revue orientée architecture logicielle senior et optimisation LLM du serveur MCP `obsidian-vault-mcp`.

Objectifs de l'analyse :

- identifier les sources probables de surconsommation de tokens dans un client comme Claude
- distinguer les couts de transport, de contexte LLM, et de performance serveur
- proposer un plan d'optimisation priorise pour reduire le cout d'usage sans degrader l'utilite du MCP

## Resume executif

Le MCP fonctionne correctement, mais il expose aujourd'hui plusieurs mecanismes qui augmentent fortement le cout total d'une session LLM :

- certains tools renvoient deux fois la meme information textuelle
- plusieurs tools retournent des contenus complets alors qu'un usage exploratoire aurait besoin de vues plus etroites
- la recherche effectue trop de relectures de fichiers et rescane plus large que necessaire
- le catalogue d'outils est plus large que ce qui est necessaire pour un usage Claude centre sur l'exploration et l'edition de notes

Conclusion :

- le principal cout n'est pas le transport MCP lui-meme
- le principal cout est la quantite de texte reinjectee dans le contexte du modele
- les optimisations les plus rentables sont applicatives et contractuelles, pas seulement techniques

## Validation effectuee

Verification locale :

- `npm test` : OK
- `npm run build` : OK

Mesures realisees localement sur le code du repo et sur des vaults de test synthetiques.

## Constat 1 : duplication inutile de contenu dans les reponses

### `fetchOpenAI`

Le tool construit actuellement une reponse contenant a la fois :

- `content`
- `text`

Ces deux champs contiennent la meme note complete.

Impact mesure sur une note d'environ 19.3k caracteres :

- taille actuelle : ~39.2 KB
- estimation tokens : ~9.8k
- taille sans `text` : ~19.8 KB
- estimation tokens sans `text` : ~5.0k

Gain potentiel immediat :

- environ 50 % sur les reponses de `fetch`

Reference principale :

- `src/vault-service.ts`, methode `fetchOpenAI`

### `searchOpenAI`

Le tool renvoie a la fois :

- `excerpt`
- `text`

Ici aussi, `text` duplique l'extrait.

Impact mesure sur 8 resultats :

- taille actuelle : ~4.3 KB
- estimation tokens : ~1.1k
- taille sans `text` : ~3.1 KB
- estimation tokens sans `text` : ~0.8k

Gain potentiel immediat :

- environ 29 % sur les resultats de recherche OpenAI

Reference principale :

- `src/vault-service.ts`, methode `searchOpenAI`

## Constat 2 : certains tools renvoient trop de texte par defaut

### `read_note`

`read_note` renvoie le contenu complet de la note. C'est acceptable pour une lecture ciblee, mais couteux si le modele l'utilise trop tot dans une session.

Mesure sur note de test :

- taille : ~19.8 KB
- estimation tokens : ~4.9k

### `read_note_excerpt`

`read_note_excerpt` est beaucoup plus economique et plus adapte a une premiere passe.

Mesure sur le meme contenu :

- taille : ~1.5 KB
- estimation tokens : ~0.4k

Conclusion :

- il faut orienter explicitement le modele vers `read_note_excerpt` avant `read_note`

### `update_note_draft`

Le tool renvoie actuellement `draft_content`, c'est-a-dire le brouillon complet apres application de la transformation.

Mesure :

- taille actuelle : ~19.8 KB
- estimation tokens : ~5.0k
- taille sans `draft_content` : ~406 B
- estimation tokens sans `draft_content` : ~0.1k

Conclusion :

- `draft_content` est probablement le poste le plus couteux a optimiser apres `fetchOpenAI`
- ce champ devrait devenir optionnel, active seulement en cas de besoin explicite

Reference principale :

- `src/vault-service.ts`, methode `updateNoteDraft`

## Constat 3 : la recherche est plus couteuse qu'elle ne devrait l'etre

Le pipeline de recherche actuel suit globalement ce schema :

1. `rg` pour recuperer un premier signal lexical
2. parcours recursif de tout le perimetre autorise
3. relecture fichier par fichier pour extraire metadata et recalculer le score
4. relecture additionnelle des top resultats pour enrichissement
5. relecture additionnelle encore dans `searchOpenAI`

Effets :

- trop d'I/O disque
- latence croissante avec la taille du vault
- cout indirect sur le LLM, car plus la recherche est lente, plus le modele a tendance a multiplier les tours

Mesures de latence sur vaults synthetiques :

- ~300 notes : ~197 a ~321 ms
- ~800 notes : ~640 a ~707 ms

Ces chiffres restent raisonnables pour un petit serveur local, mais la tendance montre un surcout structurel qui deviendra visible sur de vrais vaults plus gros.

References principales :

- `src/vault-service.ts`, `searchNotes`
- `src/vault-service.ts`, `searchDirectory`
- `src/vault-service.ts`, `searchFile`
- `src/vault-service.ts`, `enrichSearchResult`
- `src/vault-service.ts`, `searchOpenAI`

## Constat 4 : le catalogue d'outils est un peu trop large pour Claude

Le serveur enregistre actuellement 12 tools.

Pour un usage Claude orienté lecture et edition de notes, certains tools se recouvrent :

- `search` et `search_notes`
- `fetch` et `read_note`

Le probleme n'est pas seulement la duplication fonctionnelle. Chaque tool ajoute aussi :

- du schema JSON
- des descriptions
- des choix supplementaires pour le modele
- davantage de chances que le modele prenne un chemin couteux

Conclusion :

- un profil d'exposition "Claude minimal" reduirait le cout fixe et guiderait mieux le modele

Reference principale :

- `src/app.ts`

## Constat 5 : le serveur est stateless au niveau HTTP

Le endpoint MCP recree un `McpServer` et un `StreamableHTTPServerTransport` a chaque requete.

Ce choix est defensif et simple a heberger, mais il a deux consequences possibles :

- le client peut etre pousse a relister plus souvent les tools
- il devient plus difficile d'amortir certains couts de session

Ce point n'est probablement pas la source principale du cout tokens, mais il peut contribuer au cout fixe de dialogue selon le comportement exact du client MCP.

Reference principale :

- `src/app.ts`, route `POST /mcp`

## Ce qui n'est pas prioritaire

Les petits champs repetitifs comme `policy`, `url` ou `target` ont un impact marginal par rapport au contenu textuel.

Mesures indicatives :

- suppression de `policy` et `url` sur `read_note` : gain faible
- suppression de `text` ou `draft_content` : gain majeur

Il ne faut donc pas commencer par micro-optimiser les metadonnees.

## Recommandations priorisees

### P0

1. Supprimer les duplications de payload
   - retirer `text` de `fetchOpenAI` ou `content`
   - retirer `text` de `searchOpenAI`

2. Rendre `update_note_draft` leger par defaut
   - garder hashes, warnings et `diff_summary`
   - rendre `draft_content` optionnel via un flag explicite

3. Introduire un profil "Claude minimal"
   - exposer prioritairement `search_notes`, `list_notes`, `read_note_excerpt`, `read_section`, `update_note_draft`, `propose_change`
   - desactiver ou cacher `search` et `fetch` pour cette cible

4. Mieux guider le modele dans les descriptions d'outils
   - indiquer que `read_note_excerpt` doit etre prefere a `read_note`
   - indiquer que les lectures completes sont couteuses

### P1

5. Refondre la recherche en deux etapes
   - phase 1 : candidats via `rg`
   - phase 2 : reranking seulement sur un petit top-N

6. Ajouter un cache memoise dans le processus
   - metadata de note
   - extrait de note
   - `describeDocument`
   - contenu lu recemment

7. Eviter les relectures inutiles dans la chaine de recherche
   - reutiliser les metadata deja calculees
   - eviter que `searchOpenAI` relise les notes deja enrichies

### P2

8. Ajouter de la telemetrie d'usage et de cout
   - `duration_ms`
   - `response_bytes`
   - `estimated_tokens_out`
   - `files_scanned`
   - `files_read`
   - `cache_hit`

9. Ajouter des variantes de lecture plus fines
   - `max_chars`
   - `start_line`
   - `end_line`
   - lecture par heading

## Backlog recommande

Traduction backlog directe :

- P0 : dedoublonnage des payloads `fetch` et `search`
- P0 : mode compact pour `update_note_draft`
- P0 : profil d'outils minimal pour Claude
- P0 : clarification des descriptions/outils pour guider le modele vers les chemins peu couteux
- P1 : optimisation structurelle du moteur de recherche
- P1 : cache memoise intra-process
- P2 : telemetrie de cout et de latence
- P2 : lectures partielles parametrables

## Strategie de mesure recommande

Pour objectiver les gains apres correction :

1. Instrumenter chaque tool avec la taille de reponse et une estimation de tokens sortants.
2. Comparer trois parcours reels :
   - recherche simple
   - lecture puis modification
   - exploration multi-tours
3. Mesurer :
   - nombre moyen de tool calls
   - taille moyenne et p95 des payloads
   - latence moyenne et p95
   - estimation du total de tokens reinjectes au modele

## Conclusion

Le MCP est sain fonctionnellement, mais son contrat actuel est trop genereux en texte pour un usage LLM economique.

Le meilleur retour sur investissement viendra de :

- supprimer les doublons
- rendre les reponses compactes par defaut
- reduire le nombre de tools exposes au modele
- optimiser la recherche pour limiter les relectures

Ces changements sont relativement localises et devraient permettre de reduire le cout d'usage de maniere sensible sans remettre en cause l'architecture generale du projet.
