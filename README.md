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

Le script :

- démarre le serveur MCP localement sur un port éphémère ;
- appelle les tools via un client MCP HTTP ;
- exécute `read_note`, `search_notes`, `update_note_draft`, puis `propose_change` ;
- vérifie que la PR GitHub a bien été créée ;
- peut fermer la PR et supprimer la branche si `E2E_CLEANUP=true`.

Pour un premier passage sûr, cible un fichier sandbox existant comme `02-Work/TOR2e/working/test-note.md`.

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
