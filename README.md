# Copy Match Checker · Punch Toolkit — Fase 1 (MVP)

Herramienta web para que el equipo de **Production / QA** compare automáticamente el **copy aprobado** (PDF o Word) contra el **contenido implementado** en una página live o staging, y genere un reporte estructurado de diferencias, omisiones, inconsistencias y problemas de acrónimos.

## 📁 Estructura del proyecto

```
Copy Match Checker/
├── index.html            ← La herramienta completa (HTML + CSS + JS en un solo archivo)
├── serve.py              ← Servidor local opcional: sirve la página + fetch sin CORS (recomendado)
├── README.md             ← Este archivo
├── test/                 ← Generador de archivos de prueba (PDF/DOCX reales)
└── full-build-v0.4/      ← Build avanzado archivado (Google Docs, multi-URL, historial,
                            diccionarios). Base para la Fase 2 — NO se usa en la Fase 1.
```

> La herramienta es **un solo archivo `index.html` autocontenido** (se abre con doble clic). `serve.py`
> es **opcional pero recomendado**: habilita el fetch confiable de URLs sin las limitaciones de CORS.

## ▶️ Cómo probarlo localmente

**Opción A (la más simple):** doble clic en `index.html` → se abre en tu navegador. Listo.

**Opción B (servidor local — RECOMENDADO):**
```
py serve.py
```
y abre `http://localhost:5500`. Esto habilita el **fetch del lado servidor** (`/fetch`), que lee
cualquier URL sin CORS ni proxies públicos — funciona con staging de WP Engine, HubSpot, etc.

Luego:
1. **Client Name** y **Page Name** (opcionales, para el reporte).
2. **Sube el copy aprobado** (PDF o DOCX) — espera el mensaje verde *"Loaded N copy blocks"*.
3. Ingresa la **Page URL**.
4. Elige **Page Type** y el **Scope** (Main content / Navigation / Footer / CTAs / Links).
5. Clic en **Run QA Check**.
6. Revisa el **Summary**, la **tabla de issues**, la **Acronym Review**, y exporta con **Export CSV** o **Copy Report**.

## 🎨 Diseño

Dashboard oscuro estilo Punch Toolkit (paleta del *Content Migrator*): fondos neutros casi negros, cards gris oscuro, acento rosa/magenta `#f01e5a`, íconos de línea SVG, badges de prioridad y tablas claras.

## 🔎 Qué revisa (Fase 1)

| Issue Type | Detecta |
|---|---|
| **Missing Copy** | Copy aprobado que no aparece en la página |
| **Copy Mismatch** | Diferencias de wording entre aprobado y publicado |
| **Extra Section** | Texto en el sitio que no está en el documento aprobado (posible contenido heredado/desactualizado) |
| **CTA Issue** | Botones / CTAs con texto incorrecto o faltante |
| **Acronym Issue** | Acrónimos mal definidos, sin definir, usados antes de tiempo, o con variaciones de formato |
| **Typo / Spacing / Punctuation** | Palabras repetidas, espacios dobles, espacio antes de puntuación |
| **Link Review** | Links visibles con destinos sospechosos / placeholder |

### Contenido que la herramienta IGNORA (scaffolding del documento)

Tus documentos de copy traen mucho contenido que **no** debe estar en la página. La herramienta lo detecta y lo **ignora automáticamente** (no lo marca como error):

- **Caja SEO / Yoast** completa (encabezados *y* valores): `Page SEO Info`, `Copy from here to propagate Yoast`, `Focus Keyphrase`, `Meta Description`, `SEO Title`, etc.
- **Intro / meta de la página**: `Page Goal:`, `Goal CTA:`, breadcrumbs (`Services > FedRAMP`), slugs (`/fedramp`), títulos tipo *"High Value Pages"*.
- **Anotaciones / instrucciones** entre corchetes **sin link**: `[Card 1]`, `[Tab 1]`, etc.

> **Excepción — botones:** un corchete **con paréntesis**, tipo `[Explore XRAMP] (/xramp)`, NO es scaffolding: es un **botón/CTA** que **debe** estar en el sitio. El **botón es solo el texto del corchete** (*"Explore XRAMP"*); el paréntesis es una **indicación sobre el botón** (no es contenido visible):
> - Si la indicación es un **link** (`/xramp`, `https://…`, `#`, `tel:`…) → verifica que el botón esté en la página **y que el link coincida** (link distinto → CTA Issue Medium).
> - Si la indicación es **texto** (ej. `(opens the demo modal)`) → solo verifica que el botón esté en la página; la nota se muestra como contexto, nunca se exige como copy.
>
> Botón faltante → CTA Issue (High).
- **Textos indicativos en rosado/magenta** (solo `.docx`): se ignoran siempre, nunca aparecen como error ni observación.

### Texto alternativo en verde (solo `.docx`)

El texto en **verde** se usa como reemplazo más corto del texto principal. La herramienta lo trata así:
- Si la versión verde **aparece en el sitio** → se marca como **Observación** (azul/INFO), no como error.
- Si el verde está en el copy pero **no** en el sitio → **se ignora por completo** (ni error ni observación).

> ⚠️ El color (verde/rosado) **solo se lee en archivos `.docx`** (Word). En PDF no hay color de texto accesible — ahí funciona el filtrado por patrón (SEO, intro, corchetes), pero para verde/rosado usa Word.

### Acronym Consistency Checker

Regla aplicada: **primera mención = Término Completo (ACRÓNIMO)**; usos posteriores = solo el acrónimo. Detecta:
- Acrónimos usados **antes** de ser definidos · **nunca** definidos · **definidos más de una vez**.
- **Definiciones inconsistentes** del término completo.
- **Variaciones de formato/casing**: `POAM` vs `POA&M`, `Conmon` vs `ConMon`, etc. (incluye un diccionario base de seguridad: CMMC, POA&M, ConMon, ATO, FedRAMP, NIST, SSP, RMF).

La sección **Acronym Review** muestra: Priority · Acronym · First Mention Found · Expected Format · Issue · Suggested Fix.

### Marcar issues como resueltos

Cada fila tiene un **checkbox** a la izquierda. Al marcarlo, el issue se **atenúa y se mueve al final** de la lista, y el contador muestra *"N open"* (pendientes). Útil para ir tachando lo resuelto y mantener arriba solo lo que falta. (Un nuevo *Run QA Check* limpia las marcas.)

## 🌐 Sobre la extracción de la URL (CORS) — importante

Los navegadores **bloquean** leer el HTML de otro dominio directamente (política CORS). La herramienta tiene **tres niveles**, en orden:

1. **Servidor local (`serve.py`) — el más confiable.** Si abres la herramienta con `py serve.py`, el fetch lo hace **Python del lado servidor** (endpoint `/fetch`), sin CORS ni proxies públicos. Lee WP Engine staging, HubSpot, etc. directamente. La herramienta lo intenta **primero** automáticamente.
2. **Proxies públicos (fallback).** Si abriste el archivo sin `serve.py`, intenta `corsproxy.io` y `allorigins` (JSON/raw). Son **frágiles**: tienen rate limits y `corsproxy.io` **rechaza el origen `null` de `file://` con 403** — por eso conviene usar `serve.py`.
3. **Paste page HTML / text.** Para staging con **contraseña**, detrás de firewall, o si todo falla: abre la página en tu navegador, `Ctrl+U` (ver código fuente) o selecciona el texto, y pégalo. **Siempre funciona.**

> **¿Por qué "All proxies failed" si antes funcionaba?** Casi siempre es porque abriste el `index.html` con **doble clic (`file://`)**: `corsproxy.io` bloquea ese origen (403) y allorigins puede estar saturado. Solución: ábrelo con `py serve.py` → `http://localhost:5500`.

El servidor (`serve.py`) usa solo la **stdlib de Python** (sin instalar nada) y manda un `User-Agent` de navegador. Para staging con credenciales, se le pueden agregar headers de auth en el futuro.

## 🧪 Archivos de prueba

`test/make_samples.py` genera un `.docx` y un `.pdf` reales (solo con la stdlib de Python) para probar los parsers:
```
py test/make_samples.py
```

## ⚠️ Limitaciones de la Fase 1

- **CORS:** con `serve.py` el fetch es confiable; sin él (doble clic) depende de proxies públicos frágiles. Páginas con login/contraseña requieren el modo **Paste**.
- **PDF escaneado (imagen):** no tiene texto seleccionable → no se puede extraer. Avisa y hay que pegar el texto.
- **Word:** solo `.docx` moderno (no `.doc` antiguo).
- **Typos / puntuación / espacios:** heurísticas básicas (palabras repetidas, espacios dobles, espacio antes de signo), no un corrector ortográfico completo.
- **Terminology / Outdated Copy:** se detectan parcialmente vía Mismatch/Extra Section; no hay glosario de terminología todavía.
- Compara **una página a la vez**.

## 🚀 Qué sigue (Fase 2 y más)

Ya prototipado en `full-build-v0.4/`:
- **Google Docs** como fuente del copy + lectura de **comentarios y replies** (OAuth Drive API).
- Comparar un doc contra **múltiples URLs** + **vista comparativa** lado a lado.
- **Historial** por cliente/página y **diccionarios de acrónimos por cliente**.
- **Backend/proxy propio** para fetch confiable y staging con credenciales.

## 🛠️ Dependencias (vía CDN, sin instalar)

- [`pdf.js`](https://mozilla.github.io/pdf.js/) — extracción de texto de PDF.
- [`mammoth.js`](https://github.com/mwilliamson/mammoth.js) — extracción de texto de DOCX.
