// Electron's entry point inside `app.asar`. Electron itself only ever loads
// this tiny file; everything else lives in `resources/app-<version>/` and is
// loaded by ../../loader.js. Keeping `main` identical to the development entry
// (`./out/main/index.js`) also satisfies electron-builder's asar entry check.
require('../../loader.js')
