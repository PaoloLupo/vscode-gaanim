# Pendiente: cómo retomar este proyecto en local

Estado de la primera versión de la extensión y lo que falta para darla por
terminada. Todo lo de abajo se hizo y probó en un contenedor Linux sin
pantalla ni GPU; nada se ha abierto todavía en un VS Code de escritorio.

## 1. Poner en marcha

```bash
git clone https://github.com/PaoloLupo/vscode-gaanim
cd vscode-gaanim
npm install
npm run build        # dist/extension.js
npm test             # 44 pruebas unitarias, sin VS Code
```

Para probarla a mano: abre la carpeta en VS Code y pulsa **F5**. Hace falta
crear antes `.vscode/launch.json` (no está en el repo):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Extensión",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}", "C:/ruta/a/un/proyecto/gaanim"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

También vale `npm run package` e instalar el `.vsix` resultante
(*Extensions → … → Install from VSIX*).

## 2. Qué está verificado

- `npm run typecheck`, `npm run build` y `npm run package` (un `.vsix` de
  68 KB) pasan.
- `npm test`: 44 pruebas de los analizadores (símbolos de la escena, guion
  `script.md`, línea de tiempo, salida de `check`, matemáticas Typst, nudge,
  assets, marcadores de tomas, `--help`, `gaanim.toml`), portadas de las de
  gaanim.nvim más casos nuevos. Encontraron y se corrigieron dos fallos (la
  columna de los marcadores de `vo.wait_until` y `1.` al hacer nudge).
- `scripts/gen_typst_symbols.py` regenera `src/core/typstSymbols.json`
  idéntico byte a byte desde codex 0.3.0.
- Contra el binario real de **Gaanim 0.13.0** (Linux, Xvfb y lavapipe de
  Mesa): `inspect --json`, `check --message-format json`,
  `export --frame <nombre>` y la vista previa con `--listen stdio`
  (`follow`, `loop`, `unloop`, `seek`, `ready` con la línea de tiempo,
  `playhead`) dan exactamente los formatos que lee la extensión, y `--help`
  tiene las cuatro marcas que usa `src/core/caps.ts`.

## 3. Qué falta comprobar (por orden)

1. **La suite de integración** (`test/integration/suite.ts`) ya pasa entera
   en Windows 11 (VS Code 1.142, Node 24): 13/13 con el `gaanim` falso y
   13/13 con Gaanim 0.13.0 real, en carpetas con espacios. Para llegar ahí se
   corrigió que en Windows el `gaanim` falso va envuelto en un `.cmd`, que
   los `.cmd` se lanzan con el programa y los argumentos entre comillas
   (`src/core/spawn.ts`) y que el aviso *Exported …* ya no bloquea el
   comando. Falta pasarla en Linux y macOS. Se ejecuta con:

   ```bash
   npm run test:integration        # descarga VS Code y usa el gaanim falso
   ```

   y contra el Gaanim real:

   ```bash
   gaanim init slides /tmp/charla
   GAANIM_TEST_BIN=$(which gaanim) GAANIM_TEST_PROJECT=/tmp/charla npm run test:integration
   ```

   Si falla algo, el log de la extensión está en *Output → Gaanim*.

2. **Prueba a mano en VS Code de escritorio**, que es lo que nunca se vio:
   - la barra lateral *Gaanim* (árbol *Timeline* y *Projects*) y el panel
     *Preview Timeline* (webview con la escena a escala);
   - inlay hints, code lenses, hover, completado de assets y de Typst;
   - *Preview at Cursor*, *Follow*, *Loop*, la marca del playhead y las
     líneas que se animan;
   - *Live mode* (guarda con *Save without Formatting* mientras escribes);
   - la barra de estado (estado de la vista previa e instante del cursor);
   - el guion al lado (`Ctrl+Alt+G T`, `Ctrl+Alt+G G`) y sus tiempos en
     verde/ámbar/rojo;
   - *Present…*, exportaciones con progreso y *Export Still at Cursor*;
   - *Check Setup* y *Search Documentation…*.

3. **El viaje de vuelta desde Gaanim** (`GAANIM_EDITOR`): *Open in the
   editor* en el inspector, la consola o el panel de errores debería abrir la
   línea en esta ventana. `src/editorLink.ts` busca el CLI del editor
   (`code`, `cursor`, `codium`) junto a `vscode.env.appRoot` y, si no lo
   encuentra, usa el enlace `vscode://paololupo.gaanim/open?...` con
   `explorer.exe` / `open` / `xdg-open`. Comprobar sobre todo en Windows y
   con rutas con espacios; si no funciona, el ajuste
   `gaanim.preview.editorCommand` permite fijarlo a mano.

4. **Windows**: `previewPath` en `src/preview.ts` manda a la vista previa la
   ruta tal como la escribe la línea de tiempo (mayúscula en la unidad,
   barras), porque `follow` compara rutas exactas. La suite real en Windows
   (*preview at cursor* con `follow`) pasa, y `gaanim.path` apuntando a un
   `.cmd` en una ruta con espacios también; queda verlo a mano con varios
   archivos de escena.

5. **Atajos**: todos van bajo `Ctrl+Alt+G` y el nudge es
   `Ctrl+Alt+A` / `Ctrl+Alt+X`. Revisar que no choquen con los tuyos.

## 4. Cosas por decidir o mejorar

- **CI**: añadir un workflow de GitHub Actions con `npm ci`, `npm test` y
  `npm run package` (y quizá `npm run test:integration` con `xvfb-run`).
- **Publicar** en el Marketplace y en Open VSX con el publisher `paololupo`
  (crear el publisher y un token; `npx vsce publish`, `npx ovsx publish`).
- **Icono**: `images/icon.png` es una copia de
  `docs/assets/brand/gaanim-icon-512.png` del repo de Gaanim; si cambia la
  marca, copiarlo de nuevo.
- **Idioma**: la interfaz está en inglés, como el editor de Gaanim y
  gaanim.nvim. Si se quiere en español, VS Code usa `package.nls.*.json` y
  `vscode.l10n`.
- **Recarga sin guardar**: el modo live guarda el archivo; no hay forma de
  mandar a la vista previa un buffer sin guardar porque `--listen` no tiene
  esa orden.
- **Ideas del roadmap de gaanim.nvim** aún sin hacer aquí: resaltado de
  Typst dentro de las cadenas (gramática TextMate inyectada) y reproducir una
  toma desde una palabra.

## 5. Mapa del código

| Archivo | Qué hace |
|---|---|
| `src/extension.ts` | registra comandos, proveedores, vistas y eventos |
| `src/core/*` | lógica pura sin `vscode` (la que cubren las pruebas unitarias) |
| `src/cli.ts` | lanza `gaanim`, lee JSON por líneas, detecta capacidades |
| `src/preview.ts` | vista previa con `--listen stdio`: here, follow, loop, seek, present |
| `src/inspect.ts` | caché de la línea de tiempo (del `ready` o de `gaanim inspect`) |
| `src/check.ts` | `gaanim check` como problemas en su línea |
| `src/exporter.ts` | exportaciones con progreso cancelable, stills, rangos |
| `src/providers.ts` | inlay hints, lenses, hover, acciones, símbolos, completado |
| `src/scriptView.ts` | el guion al lado, saltos, secciones nuevas, tiempos |
| `src/takeInspector.ts` | dónde cae cada `vo.wait_until` en su toma |
| `src/views.ts`, `src/scrubber.ts`, `src/statusBar.ts` | barra lateral, panel, barra de estado |
| `src/live.ts`, `src/nudge.ts`, `src/decorations.ts` | modo live, nudge, marcas del playhead |
| `src/docs.ts`, `src/doctor.ts`, `src/python.ts`, `src/projects.ts` | docs, *Check Setup*, `.venv`, proyectos |
| `test/core.test.ts` | pruebas unitarias |
| `test/integration/` | suite de integración, `gaanim` falso y arnés de code-server |
