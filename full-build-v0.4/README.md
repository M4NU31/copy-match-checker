# Copy Match Checker · Punch Toolkit

Herramienta web para que el equipo de **Production / QA** compare el **copy aprobado** (PDF, Word o Google Doc) contra el **contenido implementado** en una página live o staging, y genere un reporte de diferencias, omisiones, inconsistencias y problemas de acrónimos.

## 📁 Estructura del proyecto

```
Copy Match Checker/
├── index.html     ← Interfaz (estructura del dashboard)
├── styles.css     ← Estilo dark dashboard (cards, badges, tablas)
├── app.js         ← Lógica: parseo de docs, extracción de página, comparación, acrónimos, export
└── README.md      ← Este archivo
```

> Todo corre **100% en el navegador** (client-side). No hay backend ni instalación.

## ▶️ Cómo usarla

1. Abre **`index.html`** en Chrome o Edge (doble clic, o arrástralo a una pestaña).
2. **Approved Copy** → sube un PDF/DOCX, pega el texto, o conecta un Google Doc.
3. **Page to Compare** → ingresa la URL de staging/live.
4. Elige el **Scope** (main, nav, footer, CTAs, links) y el **Page Type**.
5. Clic en **Run QA Check**.
6. Revisa el **Summary**, la **tabla de issues**, el panel **Acronym Review** y exporta a **CSV** o **copia el reporte**.

### ⚠️ Sobre el fetch de la URL (importante)

Los navegadores bloquean peticiones cross-origin (CORS). La herramienta ofrece dos métodos:

- **Auto-fetch (CORS proxy)** — prueba varios proxies públicos en orden con timeout (`corsproxy.io`, `allorigins` JSON y raw, `codetabs`). Funciona para muchas páginas públicas (WordPress, HubSpot, estáticas, landing/thank-you/resource pages), incluyendo staging de WP Engine (`*.wpenginepowered.com`) **siempre que no estén protegidas con contraseña**.
- **Paste page HTML / text** — para páginas con login, **staging protegido con contraseña**, detrás de firewall, o cuando todos los proxies fallan: abre la página, `Ctrl+U` (ver código fuente) o selecciona todo el texto renderizado, y pégalo. Siempre funciona.

> Si una página de staging pide usuario/contraseña (HTTP basic auth), **ningún proxy público puede leerla** — usa el modo *Paste*. Un backend propio (Fase 5) sí podría con credenciales.

## 🔎 Qué revisa el MVP

| Issue Type | Detecta |
|---|---|
| **Missing Copy** | Copy aprobado que no aparece en la página |
| **Copy Mismatch** | Diferencias de wording entre aprobado y publicado |
| **Extra Section** | Texto en el sitio que no está en el documento aprobado |
| **CTA Issue** | Botones / CTAs con texto incorrecto o faltante |
| **Acronym Issue** | Acrónimos mal definidos, sin definir, usados antes de tiempo, variaciones |
| **Typo / Spacing / Punctuation** | Palabras repetidas, dobles espacios, espacio antes de puntuación |
| **Link Review** | Links visibles con destinos sospechosos / placeholder |

### Acronym Consistency Checker

Regla aplicada: **primera mención = Término Completo (ACRÓNIMO)**; usos posteriores = solo el acrónimo.

Detecta:
- Acrónimos usados **antes** de ser definidos.
- Acrónimos **nunca** definidos en la página.
- Acrónimos **definidos más de una vez**.
- **Definiciones inconsistentes** del término completo.
- **Variaciones de formato**: `POAM` vs `POA&M`, `Conmon` vs `ConMon`, etc.

## 🧠 Cómo funciona la comparación (app.js)

1. **Parseo de documento** — `pdf.js` (PDF) y `mammoth.js` (DOCX) extraen texto plano → se divide en bloques.
2. **Extracción de página** — el HTML se parsea en un DOM desconectado; se eliminan `script/style/svg`; se respeta el scope (nav/footer/main); se extraen headings, párrafos, bullets, CTAs y links visibles.
3. **Matching** — para cada bloque aprobado se busca el mejor bloque de la página por **similitud** (Levenshtein normalizado + Jaccard para textos largos):
   - `≥ 0.95` → match correcto.
   - `0.55–0.95` → **Copy Mismatch** (o CTA Issue).
   - `< 0.55` → **Missing Copy**.
   - Bloques de la página sin match → **Extra Section**.
4. **Match score** = % de bloques aprobados encontrados en la página.
5. **Acronym check** + chequeos mecánicos (typos/espacios/puntuación).

## 🔗 Google Docs Comments Review (Fase 2 — implementado)

La herramienta ya lee **comentarios y replies** de un Google Doc vía la **Google Drive API** y los clasifica en la sección **Google Doc Comments Review** (columnas: Status · Comment or Feedback · Related Copy · Possible Impact · Suggested Action).

Clasificación automática:
- **Open + sugiere cambio** → *posible cambio de copy pendiente*.
- **Resolved** → *cambio probablemente ya aplicado* (verificar en la página).
- **Resolved pero el copy relacionado no está en la página** → *version drift* (prioridad alta).
- Cruza el `Related Copy` (texto anclado del comentario) contra el texto de la página de la última corrida.

### Setup (una sola vez)

1. En **Google Cloud Console** crea un proyecto y habilita la **Google Drive API**.
2. Crea un **OAuth 2.0 Client ID** (tipo: *Web application*).
3. Agrega el origen de esta página como *Authorized JavaScript origin* (ej. `http://localhost:5500`; si la hospedas, su dominio).
4. En la herramienta: pestaña **Google Doc URL** → abre *"Google API setup"* → pega el **Client ID**.
5. Pega la URL del Google Doc y clic en **🔗 Connect Google (comments)** → autoriza con tu cuenta.

> Scope usado: `drive.readonly`. El token vive solo en tu navegador; no se envía a ningún servidor.
> OAuth requiere un origen http(s) (no funciona desde `file://`) — usa el servidor local o un hosting.

**¿Sin credenciales?** Usa **🧪 Demo comments** para ver el output con datos de ejemplo, o **📄 Load text (no login)** para leer solo el texto de un doc compartido como *"Anyone with the link"*.

## 🧪 Archivos de prueba

`test/make_samples.py` genera un `.docx` y un `.pdf` reales (solo con la stdlib de Python, sin instalar nada) cuyo contenido coincide con `example.com`, para probar los parsers y el fetch en vivo:

```
py test/make_samples.py
```

## 🚀 Fase 3 (implementado)

- **Multi-URL** — el campo *Page URL(s)* acepta varias URLs (una por línea). Un doc aprobado se compara contra cada una; un **switcher** arriba del summary permite cambiar entre reportes por URL (cada uno con su score). El método *Paste page* sigue siendo de página única.
- **Historial por cliente/página** — cada corrida se guarda en `localStorage` (últimas 25). El botón **🕑 History** lista los batches guardados (cliente · página · fecha · #URLs · score promedio) y restaura el reporte completo con un clic. Persiste entre recargas. **🗑 Clear history** lo limpia.
- **Comentarios del Google Doc en la tabla principal** — los comentarios accionables se agregan como filas tipo **Google Doc Comment Issue** (drift → High, cambio pendiente → Medium), con su propio tab **GDoc**. El drift se reevalúa **por URL** al cambiar de pestaña en el switcher.

## 🧩 Fase 4 (implementado)

- **Diccionarios de acrónimos por cliente** — botón **📚 Acronyms**: define/edita/borra acrónimos y su término completo por cliente (según el campo *Client Name*), guardados en `localStorage`. Extienden el diccionario base (CMMC, POA&M, ConMon, ATO, FedRAMP, NIST, SSP, RMF) y alimentan el Acronym Checker automáticamente. Ej.: define `SPRS = Supplier Performance Risk System` para un cliente y el checker exigirá su definición completa en la primera mención.
- **Vista comparativa lado-a-lado** — en corridas multi-URL, el botón **⚎ Compare URLs** muestra una matriz: una fila por issue distinto, una columna por URL, y un badge de prioridad en cada celda donde ese issue aparece. Ideal para ver qué páginas comparten el mismo error (copy faltante, CTA incorrecto, etc.).

## 🔭 Roadmap (Fase 5)

- Scope avanzado (modals, hidden content).
- Backend opcional para fetch confiable (evita el proxy CORS y permite fetch en paralelo).
- Exportar el historial completo / reporte multi-URL en un solo archivo (CSV/JSON).
- Importar/exportar diccionarios de acrónimos entre clientes.

## 🛠️ Dependencias (vía CDN, sin instalar)

- [`pdf.js`](https://mozilla.github.io/pdf.js/) — extracción de texto de PDF.
- [`mammoth.js`](https://github.com/mwilliamson/mammoth.js) — extracción de texto de DOCX.
- [Google Identity Services](https://developers.google.com/identity/oauth2/web) — OAuth para leer comentarios del Google Doc.

Requiere conexión a internet la primera vez (carga las librerías y usa el proxy de fetch).
