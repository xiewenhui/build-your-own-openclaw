//go:build linux || darwin

package main

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

// dropPrivileges sets the child process uid/gid to AGENT_RUN_UID / AGENT_RUN_GID
// before it starts. If those env vars are unset or empty, this is a no-op.
// Only compiled on Linux and macOS; Windows builds use privdrop_windows.go.
func dropPrivileges(cmd *exec.Cmd) {
	uidStr := os.Getenv("AGENT_RUN_UID")
	gidStr := os.Getenv("AGENT_RUN_GID")
	if uidStr == "" && gidStr == "" {
		return
	}

	cred := &syscall.Credential{}
	if uidStr != "" {
		uid, err := strconv.ParseUint(uidStr, 10, 32)
		if err == nil {
			u := uint32(uid)
			cred.Uid = u
		}
	}
	if gidStr != "" {
		gid, err := strconv.ParseUint(gidStr, 10, 32)
		if err == nil {
			g := uint32(gid)
			cred.Gid = g
		}
	}

	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Credential = cred
}
