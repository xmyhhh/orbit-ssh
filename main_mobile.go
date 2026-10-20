//go:build android || androidtest

package main

import (
	"fmt"
	"os"

	"orbitssh/src/app"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: orbit <config-directory> <local-files-directory>")
		os.Exit(2)
	}
	if err := app.RunMobile(os.Stdin, os.Stdout, os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, "Orbit Android backend stopped:", err)
		os.Exit(1)
	}
}
