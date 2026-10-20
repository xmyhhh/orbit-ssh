// Package local runs terminals on the local machine, such as a login shell or
// a WSL distribution.
//
// Every platform provides its own shell list and its own way to start a
// console, so the rest of the code only deals with the types below.
package local

import "io"

// Terminal is a console on the local machine.
type Terminal interface {
	io.ReadWriteCloser
	Resize(cols, rows int) error
	Wait() (uint32, error)
}

// Shell is one of the shells the system provides.
type Shell struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

// ShellInfo lists the local shells of the system.
type ShellInfo struct {
	Supported bool    `json:"supported"`
	Shells    []Shell `json:"shells"`
	Message   string  `json:"message"`
}
