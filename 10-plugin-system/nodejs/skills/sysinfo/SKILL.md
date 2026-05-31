---
name: sysinfo
description: "Query system information: CPU usage, memory, disk space, running processes, OS details."
metadata:
  openclaw:
    emoji: "💻"
    requires:
      bins: ["node"]
    install: []
---

# System Info Skill

Query the local system's resource usage and process state using the bundled scripts.

## CPU & Memory

```bash
node {baseDir}/scripts/sysinfo.js cpu
node {baseDir}/scripts/sysinfo.js memory
```

## Disk Usage

```bash
node {baseDir}/scripts/sysinfo.js disk
```

## Running Processes (top 10 by CPU)

```bash
node {baseDir}/scripts/sysinfo.js processes
```

## Full Summary

```bash
node {baseDir}/scripts/sysinfo.js all
```

## Notes

- All output is JSON for easy parsing.
- `{baseDir}` is replaced with the absolute path to this skill directory at runtime.
- For detailed process analysis, see `{baseDir}/references/proc-fields.md`.
