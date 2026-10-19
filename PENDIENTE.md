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
   comando. En CI pasa también en Linux y macOS con el `gaanim` falso. Se
   ejecuta con:

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

6. **Workspaces** (Gaanim 0.15, `gaanim project`): la suite
   `test/integration/workspace.ts` pasa 12/12 con el `gaanim` falso y 12/12
   con el real sobre una copia de `test/fixtures/channel` con `.venv`
   (`GAANIM_TEST_WORKSPACE`). Con Pylance de verdad (copia de las extensiones
   de Python en una instancia de prueba) el intérprete pasa al `.venv` del
   workspace y `python.analysis.extraPaths` recibe `common`, con lo que
   `import style` se resuelve. Queda verlo a mano: la pregunta del modo
   `ask`, la vista *Projects* (iconos, botones en línea, menús), el elector
   de miembro y la barra de estado en un módulo compartido, *New Workspace…*
   (abre otra carpeta) y el aviso de `members` al crear un miembro fuera de
   los patrones.

## 4. Cosas por decidir o mejorar

- **CI**: `.github/workflows/ci.yml` corre en Linux, Windows y macOS
  typecheck, pruebas unitarias, la suite de integración con el `gaanim`
  falso (con `xvfb-run` en Linux) y `npm run package`, y sube el `.vsix`
  desde Linux. La suite con el Gaanim real no está en CI: su vista previa
  necesita GPU (o lavapipe) y el binario de Gaanim.
- **Publicar**: `.github/workflows/release.yml` publica al empujar una
  etiqueta `vX.Y.Z` igual a la versión de `package.json`: empaqueta, crea la
  release de GitHub con el `.vsix` y lo sube al Marketplace (secreto
  `VSCE_PAT`) y a Open VSX (secreto `OVSX_PAT`); la tienda sin secreto se
  salta. Falta crear el publisher `paololupo` en ambas tiendas y los dos
  tokens.
- **Marca**: `images/icon.png`, `images/activity.svg` e `images/banner.png`
  salen de `scripts/gen_brand.py`, que importa `tools/generate_brand.py` del
  repo de Gaanim; si cambia la marca, ejecutarlo de nuevo. Los colores del
  cabezal (`gaanim.playhead*`, `gaanim.animatingBackground`) y del panel
  *Preview Timeline* usan la paleta de `docs/assets/brand/README.md`.
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
