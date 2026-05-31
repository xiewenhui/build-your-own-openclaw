# Process Fields Reference

Output fields from `node sysinfo.js processes`:

## Linux/macOS (ps aux)

| Field | Description |
|-------|-------------|
| `user` | Process owner |
| `pid` | Process ID |
| `cpu` | CPU usage % (snapshot) |
| `mem` | Memory usage % of total RAM |
| `cmd` | Command and arguments |

## Windows (tasklist)

| Field | Description |
|-------|-------------|
| `name` | Executable name |
| `pid` | Process ID |
| `memKB` | Memory usage in KB |

## Notes

- CPU% is a point-in-time snapshot, not an average.
- To kill a process: `kill <pid>` (Linux/macOS) or `taskkill /PID <pid> /F` (Windows).
- For continuous monitoring, use `top` (Linux/macOS) or Task Manager (Windows).
