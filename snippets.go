package main

import (
	_ "embed"
	"encoding/json"
)

//go:embed frontend/src/data/snippets.json
var snippetCatalogJSON []byte

type snippetCatalog struct {
	Version  int       `json:"version"`
	Snippets []Snippet `json:"snippets"`
}

var builtinSnippets = func() snippetCatalog {
	var catalog snippetCatalog
	if err := json.Unmarshal(snippetCatalogJSON, &catalog); err != nil {
		panic(err)
	}
	return catalog
}()

func upgradeSnippetCatalog(state *State) bool {
	if state.SnippetCatalogVersion >= builtinSnippets.Version {
		return false
	}
	ids, commands := map[string]bool{}, map[string]bool{}
	for _, snippet := range state.Snippets {
		ids[snippet.ID], commands[snippet.Command] = true, true
	}
	for _, snippet := range builtinSnippets.Snippets {
		// Do not restore the three original presets if a user deleted them.
		legacy := snippet.ID == "system" || snippet.ID == "disk" || snippet.ID == "process"
		if !legacy && !ids[snippet.ID] && !commands[snippet.Command] {
			state.Snippets = append(state.Snippets, snippet)
			ids[snippet.ID], commands[snippet.Command] = true, true
		}
	}
	state.SnippetCatalogVersion = builtinSnippets.Version
	return true
}
