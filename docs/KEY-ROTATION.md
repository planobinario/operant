# Rotación de la clave de la extensión

> **Por qué existe este documento**: la clave privada RSA de la extensión estuvo
> commiteada en `native-host/key_info.json` (commit `148ad5f`). Mientras estuvo
> publicada, cualquiera podía leerla y publicar actualizaciones de la extensión
> instalada en el perfil de cualquier usuario: Chrome acepta la firma sin pedir
> permiso. **Una clave publicada está comprometida aunque luego se borre**, así
> que la única forma de cerrar el riesgo es rotarla.

## Qué cambió

| | Antes | Después |
|---|---|---|
| Extension ID | `apolplekoldkaignccbfcnejmoochdhf` | `ojipilmpchlgciidajpcgjkmfpghccjk` |
| Clave pública | la que estaba en el repo | la de `src/manifest.json` |
| Versión | 0.4.1 | 0.5.0 |

El ID **cambia** porque Chrome lo deriva de la clave pública
(`SHA-256` de la SPKI DER, 16 bytes, cada nibble mapeado a `a`-`p`). No hay forma
de conservar el ID con una clave nueva.

## Migración para un usuario

Es un cambio disruptivo y hay que hacerlo en este orden. Si se hace al revés, el
host queda registrado contra un ID que ya no existe.

1. **Recargar la extensión.** En `chrome://extensions`, *Cargar descomprimida*
   sobre `src/`. Chrome le asignará el ID nuevo.
2. **Copiar el ID que muestra** la tarjeta de la extensión.
3. **Reejecutar el host nativo** con el binario nuevo. El instalador detecta
   Chrome, Edge y Firefox y **vuelve a registrar** el manifiesto de Native
   Messaging con `allowed_origins` del ID nuevo. Borra el registro anterior.
4. Comprobar en el panel que ya no aparece "el host nativo no está instalado".

Los pasos 1 y 3 no dependen del orden entre sí, pero el 4 sí: sin rehacer el
registro, la extensión nueva no puede hablar con el host.

## Migración para desarrollo

```bash
npm run host:build                      # compila el host y lo deja en native-host/
npm run key:verify                      # comprueba que los 3 IDs coinciden
node scripts/check-version.mjs          # comprueba que las 6 versiones coinciden
npm test
```

`npm run key:verify` es la red que evita la deriva: compara el ID derivado de la
clave del manifest, el de `native-host/key_info.json` y el `EXTENSION_ID` de
`native-host-rs/src/installer.rs`. También hay un test con el mismo criterio
(`tests/unit/extension-id.test.js`).

## Rotar otra vez

```bash
node scripts/gen-extension-key.mjs      # genera el par nuevo y escribe ambos ficheros
# 1. copiar key_info.json -> src/manifest.json  campo `key`
# 2. actualizar EXTENSION_ID en native-host-rs/src/installer.rs
npm run key:verify                      # debe pasar antes de commitear
```

Los tres sitios se cambian **a mano** porque cada uno lo lee un consumidor
distinto (Chrome, la documentación y el instalador del host). Automatizarlo es
una tentación peligrosa: un script que reescriba `installer.rs` puede dejar el
host apuntando a un ID que nadie ha revisado.

## La clave privada

- Vive **solo** en `native-host/.secrets/extension_key.pem`, que está en
  `.gitignore` y **nunca** se sube.
- Si se pierde, no pasa nada: se genera un par nuevo y se repite la migración.
  Lo único que se pierde es la continuidad del ID.
- Si aparece en un commit, **no basta con borrarlo del árbol**: hay que rotar y
  reescribir el historial (esto es lo que se hizo aquí).

## Historial

El historial se reescribió para eliminar de todos los commits:

- `native-host/operant-host.exe` (2.588.160 B commiteados)
- `native-host/key_info.json` (que contenía la clave privada en `148ad5f`)

Los hashes de commit han cambiado. Eso significa que **cualquier clon existente
hay que reinicializarlo**, y que un `push` a un remoto exige `--force-with-lease`.

Verificación tras la reescritura:

```bash
npm run check:secrets       # sin claves privadas ni binarios en el índice
git rev-list --all --objects | grep -i '\.exe$'   # sin resultados
git log --all --oneline -- native-host/key_info.json
```

La primera comprobación la hace `scripts/check-no-secrets.mjs` sobre `git
ls-files`, y es el mismo paso que ejecuta la CI. El marcador de cabecera PEM se
construye dentro del script por piezas: un documento que explains este incidente
no debe poder hacer fallar su propio escáner.