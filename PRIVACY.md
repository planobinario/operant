# Política de privacidad de Operant

**Versión del producto:** 0.5.0
**Última actualización:** 2026-10-05
**Ámbito:** la extensión `Operant - Media Engine & Browser Agent` para Chrome
(114+) y Firefox (121+), y el host nativo opcional `operant-host.exe`.

Esta política describe lo que la extensión **hace** con los datos. Se ha escrito
contra el código, no contra la intención: cada afirmación de aquí está
sostenida por una comprobación automática (`scripts/check-manifest.mjs`) o por el
código fuente, y ninguna afirma algo que el producto no haga.

---

## 1. Resumen

Operant **no recoge, no transmite y no vende ningún dato personal.** No hay
telemetría, ni analítica, ni crash reporter, ni un solo pixel de nada. Todo el
análisis ocurre en tu equipo.

| Pregunta | Respuesta |
|---|---|
| ¿Recoge datos personales? | No. |
| ¿Los transmite a un servidor propio? | No. No hay servidor. |
| ¿Vende o comparte datos? | No. |
| ¿Lee datos de otros programas? | No. El host no abre perfiles del navegador. |
| ¿Usa cookies de seguimiento? | No. Ninguna. |
| ¿Instala software de terceros? | Sí, **a petición tuya**: `yt-dlp` y `ffmpeg` (ver §5). |
| ¿Acceso a red? | Sí, **a petición tuya**, a las URLs que descargas y a los motores de búsqueda inversa **solo si pulsas el botón** (ver §4). |

## 2. Qué se guarda, y dónde

Todo en el almacenamiento local del navegador, en tu perfil. Nada sale.

| Dato | Dónde | Por qué | Cuánto |
|---|---|---|---|
| Medios detectados en las páginas que visitas | `chrome.storage.session` | Alimentar el panel | Se borra al cerrar el navegador |
| Ajustes de la interfaz (tema, vista, concurrencia) | `chrome.storage.local` | Recordar preferencias | Un valor por ajuste |
| Historial de descargas | `chrome.storage.local` | Poder repetirlas | El que tú veas |
| URLs seleccionadas | `chrome.storage.local` | Reanudar tras recargar | 400 como máximo |
| Estado del host nativo (versión, herramientas) | `chrome.storage.local` | Mostrar el estado | Un objeto |

**No se guarda nada de:** navegación fuera de las pestañas donde usas Operant,
historial del navegador, contraseñas, marcadores, cookies, historial de
descargas del sistema.

## 3. Permisos, y qué se hace con cada uno

Los permisos se piden **por función**, no "porque sí".

| Permiso | Para qué | Cuándo se usa |
|---|---|---|
| `storage` | Guardar ajustes e historial | Local |
| `sidePanel` | El panel lateral | Siempre abierto mientras uses la extensión |
| `downloads` | Escribir el fichero que descargas | Al descargar |
| `webRequest` | Detectar vídeo/audio que carga la página (incluido HLS en segmentos) | Al navegar |
| `webNavigation` | Detectar cambios de URL y recargas | Al navegar |
| `nativeMessaging` | Hablar con el host nativo opcional | Solo si lo instalas |
| `declarativeNetRequest` | Reenviar tu `Referer` (y `Cookie` si lo autorizas) al descargar, para no ser rechazado por CDs con anti-hotlink | Solo al descargar. **No existe en Firefox: el paquete de Firefox no lo declara.** |
| `scripting` | Reinyectar el script de contenido si la extensión se recarga | Automático |
| `<all_urls>` (acceso de red) | Leer el tamaño de un recurso y descargarlo | Al descargar o measuring |
| `cookies` (**opcional**) | Reenviar tus cookies al descargar, cuando el sitio exige sesión | **Solo si lo aceptas en el diálogo.** Puedes rechazarlo y la extensión sigue funcionando |

### Sobre `activeTab`

La versión 0.4.1 declaraba `activeTab` sin usarlo en ninguna parte del código.
Se ha eliminado en 0.5.0, y `scripts/check-manifest.mjs` falla en CI si un
permiso declarado vuelve a no usarse. No puedes concedernos un permiso que no
usamos.

### Sobre las cookies, en concreto

Si aceptas el permiso opcional `cookies`:

- Solo se leen cookies **del dominio del recurso que tú estás descargando**.
- Solo se añaden a la petición de descarga de ese recurso.
- No se almacenan, no se copian a otro sitio y no se envían a nadie más.
- Puedes retirarlo en cualquier momento desde los permisos de la extensión, y
  la extensión sigue funcionando (dejando de superar los sitios que exigen
  sesión).

## 4. Red: a qué se conecta Operant

Operant solo hace peticiones a **la URL que tú descargas**. No hay peticiones a
servicios propios ni de terceros en segundo plano.

### 4.1 Descargas y mediciones

| Destino | Cuándo | Qué se envía |
|---|---|---|
| La URL del recurso | Al descargarlo | La petición y sus cabeceras |
| El dominio de la descarga | Al pedir el tamaño | Una petición `HEAD` o de 1 byte |
| `github.com/yt-dlp/yt-dlp` | Si pulsas "instalar/actualizar yt-dlp" | Petición de descarga |
| `www.gyan.dev` | Si pulsas "instalar/actualizar ffmpeg" | Petición de descarga |

No hay CDN de terceros, ni analítica, ni fuentes web, ni peticiones de
actualización propia. La extensión no tiene red más allá de esto.

### 4.2 Búsqueda inversa de imagen (única salida de contenido)

Operant ofrece buscar imágenes similares. **Es la única función en la que el
contenido que estás mirando sale de tu equipo a un tercero**, y por eso va
separada:

- **Con URL pública** (una imagen que ya está en internet): se abre en tu
  navegador la búsqueda con la URL como parámetro. No se sube nada.
- **Con contenido local** (un frame capturado, una imagen que solo existe en tu
  pantalla): hay que subirlo a un alojamiento temporal para poder buscarlo. Se
  usa **Litterbox (catbox)**, con expiración de **1 hora**, y **solo después de
  que pulses un botón que te pregunta expresamente**:

  > "Para buscar este vídeo/imagen, se subirá temporalmente a un servicio de
  > alojamiento de imágenes anónimo (Litterbox, expira en 1h). ¿Continuar?"

- Tope de 32 MB por subida.
- El servicio de búsqueda recibe, lógicamente, la imagen o su URL. Eso es lo que
  pides al usar la función.

Motores de búsqueda inversa disponibles: **Google Lens, Yandex, SauceNAO,
TinEye, IQDB y trace.moe**. Cada uno recibe la URL de la imagen.

**Si no quieres que nada salga de tu equipo, no uses esta función.** El resto de
Operant no envía contenido.

### 4.3 Lo que esta lista comprueba

`tests/unit/privacy-claims.test.js` enumera los destinos de red reales del
código —los literales dentro de `fetch()`, las constantes de URL del host y las
URL de búsqueda inversa— y falla si alguno no está documentado aquí. Si mañana se
añade un destino nuevo, la CI se pone roja hasta que se documente.

Esa comprobación es estática: no puede ver una fuga de datos por una vía que el
análisis no recorre. Es una red, no una prueba de integridad.

## 5. Herramientas de terceros (yt-dlp y ffmpeg)

El **host nativo es opcional**. Si no lo instalas, Operant sigue funcionando:
solo pierde las funciones que necesitan descargar y procesar fuera del
navegador.

Si lo instalas, el host:

- **No lee tu perfil del navegador.** No abre `Cookies`, ni `Login Data`, ni
  `History`, ni los perfiles de Chrome, Edge o Firefox. (Comprobado: ninguna
  referencia a esas rutas en el código.)
- Descarga `yt-dlp` de GitHub y `ffmpeg` de `www.gyan.dev`, **solo cuando
  pulsas el botón**, y los deja en `~/Operant/bin/`.
- Escribes en disco en tu carpeta de descargas o en `~/Downloads/Operant/`.
- Habla con el navegador por Native Messaging, con un protocolo que solo acepta
  peticiones originadas en esta extensión.

Si en algún momento futuro el host necesitara leer tu sesión del navegador, eso
**no** ocurriría en silencio: requeriría un permiso nuevo, una explicación aquí y
una versión nueva.

## 6. Contenido que descargas

Lo que descargas es responsabilidad de la web de origen. Operant no modifica el
contenido, no lo re-sirve y no lo comparte.

## 7. Cambios en esta política

Cada cambio sube la versión del producto y la fecha de arriba. El historial de
cambios está en el repositorio, junto al código.

## 8. Contacto

Las incidencias y preguntas se abren como *issue* en el repositorio del proyecto.
Ahí están también las fuentes, que es la forma más directa de comprobar cualquier
afirmación de este documento.

---

## Nota de honestidad

No somos una empresa con un departamento legal, así que esta política no es un
documento legal: es una descripción técnica verificable de lo que hace el
código, escrita para que puedas comprobarla. Si algo de aquí no coincide con lo
que hace la extensión, **es un error nuestro y hay que corregir el código**, no
esta página.
