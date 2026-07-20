# Motion Cam PWA

Prima versione della webcam creativa trasformata in PWA con TypeScript e motore C++/WebAssembly opzionale.

## Funzioni già incluse

- avvio della camera tramite gesto dell'utente;
- camera frontale/posteriore;
- formato nativo, 4:3 e 16:9;
- preset FPS minimi, medi, massimi, 30 e 60 quando dichiarati dal dispositivo;
- visualizzazione degli FPS realmente elaborati;
- zoom hardware quando esposto dal browser;
- foto PNG e registrazione MP4/WebM secondo il supporto del browser;
- sospensione dell'elaborazione quando la PWA passa in background;
- buffer TypeScript riutilizzati;
- service worker, manifest e icone installabili;
- fallback TypeScript automatico se il modulo C++ non è presente.

## Avvio locale

```bash
npm install
npm run dev
```

Apri l'indirizzo HTTPS o localhost mostrato da Vite. Per provare da un telefono sulla rete locale, l'accesso alla camera richiede normalmente HTTPS.

## Build di produzione

```bash
npm run build
npm run preview
```

La cartella generata è `dist/`.

## Compilazione del motore C++

Installa e attiva Emscripten/emsdk, quindi:

```bash
npm run build:wasm
npm run build
```

Il risultato viene scritto in `public/wasm/motion_processor.wasm`. Se manca, l'app continua a funzionare con il motore TypeScript.

## Nota sulle capacità della fotocamera

FPS e zoom sono mostrati solo in base alle capacità che il browser espone. Il valore applicato può essere diverso da quello richiesto; l'app legge le impostazioni risultanti e mostra anche gli FPS effettivamente elaborati.
