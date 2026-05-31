---
name: github
description: "Use gh for GitHub issues, PR status, CI logs, comments, reviews, releases, and API queries."
metadata:
  openclaw:
    emoji: "🐙"
    requires:
      bins: ["gh"]
    install:
      - id: brew
        kind: brew
        formula: gh
        bins: ["gh"]
        label: "Install GitHub CLI (brew)"
      - id: apt
        kind: apt
        package: gh
        bins: ["gh"]
        label: "Install GitHub CLI (apt)"
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub repositories, issues, PRs, and CI.

## When to Use

✅ USE this skill when:
- Checking PR status, reviews, or merge readiness
- Viewing CI/workflow run status and logs
- Creating or commenting on issues
- Querying the GitHub API

## Quick Commands

```bash
# List open PRs
gh pr list --state open

# Check CI status for current branch
gh pr checks

# View issue details
gh issue view 123

# Post a comment on a PR
gh pr comment 456 --body "LGTM"

# View workflow run logs
gh run view --log
```

## GitHub API

```bash
# Query the REST API directly
gh api repos/OWNER/REPO/pulls --jq '.[].title'

# GraphQL
gh api graphql -f query='{ viewer { login } }'
```
