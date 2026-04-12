# Obsidian Vault MCP

Serveur MCP distant minimal pour un vault Obsidian, avec policy côté serveur et workflow d’écriture limité à `branch -> commit -> push -> pull request`.

## Ce que fait cette V1

- expose un endpoint MCP distant en Streamable HTTP sur `POST /mcp`
- fournit exactement 4 tools: `read_note`, `search_notes`, `update_note_draft`, `propose_change`
- charge une policy YAML et bloque les chemins interdits côté serveur
- ouvre une PR GitHub après écriture dans un worktree git temporaire, pour éviter de salir le clone principal du vault
- laisse `update_note_draft` sans effet de bord et réserve `propose_change` au flux d’écriture

## Prérequis

- Node.js 18+
- un clone git local du repo du vault
- un remote `origin` configuré sur ce clone
- un token GitHub capable d’ouvrir une pull request sur le repo cible

## Installation

```bash
npm install
cp .env.example .env
```

Renseigne ensuite les variables de `.env`:

- `VAULT_REPO_ROOT`: chemin absolu vers le clone local du vault
- `VAULT_POLICY_FILE`: chemin du YAML de policy
- `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN`
- `MCP_AUTH_TOKEN`: optionnel, pour exiger `Authorization: Bearer ...` sur les requêtes MCP

## Lancer le serveur

```bash
npm run dev
```

Puis en production:

```bash
npm run build
npm start
```

L’endpoint de santé est `GET /health`.

## Test E2E réel

Un harness réel est disponible pour exécuter le flux MCP complet contre un vrai clone git et un vrai repo GitHub.

Prépare d’abord un fichier `.env.e2e` à partir de [.env.e2e.example](/Users/hervedarritchon/Documents/obsidian-vault-mcp/.env.e2e.example), puis lance :

```bash
npm run test:e2e:real
```

Le script vérifie maintenant 5 choses avant même le flux PR:

- démarre le serveur MCP localement sur un port éphémère ;
- appelle les tools via un client MCP HTTP ;
- valide `read_note`, `search_notes` et `update_note_draft` sur une vraie note ;
- vérifie qu’une lecture sur une zone blacklistée est bien refusée ;
- vérifie qu’un `expected_sha256` périmé est bien rejeté ;
- exécute ensuite `propose_change` si `E2E_SKIP_PROPOSE_CHANGE=false` ;
- vérifie que la PR GitHub a bien été créée ;
- peut fermer la PR et supprimer la branche si `E2E_CLEANUP=true`.

### Repo sandbox recommandé

Pour éviter de polluer ton vrai vault, prépare un repo sandbox dédié :

- un repo GitHub séparé, par exemple `obsidian-mcp-e2e-vault`
- un clone local de ce repo, utilisé comme vault Obsidian
- une note sandbox déjà commitée sur `main`
- une policy E2E qui autorise seulement ce sous-arbre en `write_via_pr`

Le point important est que `E2E_NOTE_PATH` doit déjà exister dans l’historique de `E2E_BASE_BRANCH`. Si le fichier est seulement présent en local mais pas tracké sur `main`, le full E2E refusera `propose_change`.

### Token GitHub

Le full E2E a besoin d’un `GITHUB_TOKEN` uniquement quand `E2E_SKIP_PROPOSE_CHANGE=false`.

Setup recommandé :

- utilise un token dédié au repo sandbox, pas à ton vrai vault ;
- si tu prends un fine-grained PAT, restreins-le explicitement au repo sandbox ;
- donne-lui au minimum la permission repository `Pull requests: Read and write`, car c’est ce qui débloque la création de PR ;
- si tu veux activer `E2E_CLEANUP=true`, vérifie aussi que ce token peut fermer la PR et supprimer la branche de test.

Le symptôme classique d’un token insuffisant est :

```text
GitHub pull request creation failed: 403 {"message":"Resource not accessible by personal access token", ...}
```

Dans ce cas, commence par élargir les permissions du token sur le repo sandbox avant de toucher au code.

### Exemple de `.env.e2e`

Les variables clés sont :

- `VAULT_REPO_ROOT` : clone local du repo sandbox
- `VAULT_POLICY_FILE` : policy YAML utilisée pour l’E2E
- `E2E_NOTE_PATH` : note réelle lue, draftée puis modifiée via PR
- `E2E_BLACKLISTED_PATH` : chemin volontairement interdit, utilisé pour vérifier le refus policy
- `E2E_SKIP_PROPOSE_CHANGE=true` : mode pré-PR, utile pour un premier passage sans GitHub
- `E2E_SKIP_PROPOSE_CHANGE=false` : mode complet, avec branche, push et PR
- `E2E_CLEANUP=true` : ferme la PR de test et supprime la branche après validation

Exemple minimal :

```dotenv
VAULT_REPO_ROOT=/absolute/path/to/obsidian-mcp-e2e-vault
VAULT_POLICY_FILE=./config/vault-access-policy.e2e.yaml

GITHUB_OWNER=your-user-or-org
GITHUB_REPO=obsidian-mcp-e2e-vault
GITHUB_TOKEN=github_pat_xxx

E2E_NOTE_PATH=Obsician MCP E2E Vault/Bienvenue.md
E2E_SEARCH_ROOT=Obsician MCP E2E Vault
E2E_SEARCH_QUERY=coffre
E2E_BLACKLISTED_PATH=Private/e2e-secret.md
E2E_SKIP_PROPOSE_CHANGE=false
E2E_CLEANUP=false
```

### Lecture du résultat

Le rapport console sépare maintenant :

- les étapes positives attendues ;
- les protections attendues, affichées en vert quand le refus ou le mismatch se produisent correctement ;
- le résumé final avec mode, note, branche et URL de PR si le run va jusqu’au bout.

En pratique :

- `✅ Refuse blacklisted read` veut dire que la policy bloque bien une zone interdite ;
- `✅ Reject stale hash` veut dire que le garde-fou de fraîcheur empêche un write à partir d’un état périmé ;
- `✅ E2E passed` veut dire que les protections et le flux nominal ont tous les deux été validés.

## Format de policy

La policy d’exemple est dans [config/vault-access-policy.example.yaml](/Users/hervedarritchon/Documents/obsidian-vault-mcp/config/vault-access-policy.example.yaml).

Elle supporte trois effets:

- `deny`: refus total
- `propose_only`: lecture + brouillon, sans écriture
- `write_via_pr`: lecture + écriture + PR obligatoire

Les règles `deny` sont absolues. Ensuite, la dernière règle compatible la plus permissive gagne entre `propose_only` et `write_via_pr`. À défaut, `defaults` s’applique.

## Contrat des tools

### `read_note`

Entrée:

```json
{
  "path": "02-Work/TOR2e/specs/community.md"
}
```

### `search_notes`

Entrée:

```json
{
  "query": "Chronicle tab",
  "roots": ["02-Work/TOR2e/specs"],
  "limit": 10
}
```

### `update_note_draft`

Entrée:

```json
{
  "path": "02-Work/TOR2e/specs/community.md",
  "mode": "replace_section",
  "section_heading": "## Chronicle tab",
  "content": "## Chronicle tab\n...\n",
  "expected_sha256": "..."
}
```

### `propose_change`

Entrée:

```json
{
  "title": "Refine Chronicle tab spec",
  "base_branch": "main",
  "branch_name": "ai/tor2e/refine-chronicle-tab",
  "commit_message": "ai(tor2e): refine chronicle tab spec",
  "changes": [
    {
      "path": "02-Work/TOR2e/specs/community.md",
      "mode": "replace_section",
      "section_heading": "## Chronicle tab",
      "content": "## Chronicle tab\n...\n",
      "expected_sha256": "..."
    }
  ],
  "pr_body": "Scope: 1 file only. Policy-checked. No rename/move."
}
```

## Notes de conception

- `search_notes` fait un scan markdown simple et portable, sans index dédié
- `replace_section` supporte les headings ATX (`#`, `##`, `###`, etc.)
- `propose_change` refuse les branches déjà existantes pour éviter les collisions silencieuses
- le serveur est stateless côté transport MCP: un `POST` par appel, pas de session longue

## Connexion à ChatGPT

Une fois le serveur exposé en HTTPS via un tunnel ou un reverse proxy:

1. active le Developer mode dans ChatGPT
2. crée une app MCP distante
3. renseigne l’URL publique pointant vers `/mcp`
4. teste d’abord sur un chemin `write_via_pr` simple et un seul fichier

## Suite logique

- branch protection GitHub sur `main`
- authentification plus forte que le bearer token statique si tu passes en usage partagé
- index de recherche si le vault devient volumineux
- mode `replace_full` sur nouveaux fichiers si tu veux autoriser la création de notes
