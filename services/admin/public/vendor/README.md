# vendor/

Fremdcode, der auf dem eigenen Server ausgeliefert wird.

## mermaid.min.js

Mermaid 11.16.1, unveraendert aus dem npm-Paket (`package/dist/mermaid.min.js`).

Warum hier und nicht per CDN: die Content-Security-Policy erlaubt Skripte nur
vom eigenen Host (`script-src 'self'`), und die Doku-Seite soll auch dann
Diagramme zeigen, wenn ein fremdes CDN blockiert oder nicht erreichbar ist.

Benutzt von `/admin/doku.html` (erzeugt aus `docs/SOFTWARE-ARCHITEKTUR.md`).

Aktualisieren:

    npm pack mermaid@<version>
    tar -xzf mermaid-<version>.tgz package/dist/mermaid.min.js
    cp package/dist/mermaid.min.js services/admin/public/vendor/mermaid.min.js
