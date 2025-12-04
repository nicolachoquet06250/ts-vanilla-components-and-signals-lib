package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	ssr "signals-ssr"
	"signals-ssr/components"
)

type Manifest map[string]struct {
	File    string   `json:"file"`
	Name    string   `json:"name"`
	Source  string   `json:"src"`
	IsEntry bool     `json:"isEntry"`
	CSS     []string `json:"css"`
}

func main() {
	mux := http.NewServeMux()

	var manifest, err = os.ReadFile("../dist/.vite/manifest.json")
	if err != nil {
		log.Fatal(err)
	}

	var decoded Manifest

	_ = json.Unmarshal(manifest, &decoded)

	// Routes API simples (exemple)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	mux.HandleFunc("/assets/{path...}", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		_, err := os.Stat("../dist/" + path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, "../dist/"+path)
	})

	// Page d’accueil: SSR de la vue App générée
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" { // ne répondre que pour la racine
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")

		// App() est générée par scripts/ts2go.js dans signals-ssr/components
		view := components.AppWithProps(components.AppProps{Client: false})
		appHTML := ssr.RenderToString(view, nil)

		css := func() string {
			var css string
			for _, file := range decoded["src/entry-client.ts"].CSS {
				css += fmt.Sprintf(`<link rel="stylesheet" href="%s">`, file)
			}
			return css
		}()
		script := decoded["src/entry-client.ts"].File

		// Gabarit HTML minimal; vous pouvez y ajouter vos scripts d’hydratation si besoin
		page := fmt.Sprintf(`<!doctype html>
		<html lang="fr">
		<head>
		  <meta charset="utf-8">
		  <meta name="viewport" content="width=device-width, initial-scale=1" />
		  <title>signals SSR + mux</title>
		  <link rel="icon" href="/favicon.ico">
		  %s
		</head>
		<body>
		  <div id="app">%s</div>
		  <script async src="%s"></script>
		</body>
		</html>`, css, appHTML, script)

		println(appHTML)

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(page))
	})

	// Fichiers statiques depuis ./public (dans la racine du repo)
	// Exposés sous /static/* pour éviter les collisions de routes
	// Chemin relatif depuis go/server.go → ../public
	//static := http.StripPrefix("/static/", http.FileServer(http.Dir("../public")))
	//mux.Handle("/static/", static)

	addr := ":8080"
	log.Printf("listening on %s (net/http ServeMux)", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
