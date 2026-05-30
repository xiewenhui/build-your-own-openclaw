//go:build windows

package main

import "os/exec"

// dropPrivileges is a no-op on Windows.
// Windows privilege separation requires a different mechanism (token impersonation)
// that is out of scope for this educational implementation.
func dropPrivileges(_ *exec.Cmd) {}
