# Verso — letras de Spotify traducidas en vivo

Una pequeña app web local que acompaña la reproducción de Spotify con letras sincronizadas y una traducción automática al español.

## Requisitos

- Un navegador actual y conexión a internet.
- Una cuenta Spotify.
- Una app gratuita de Spotify for Developers para obtener un Client ID.

La app usa **LRCLIB** para buscar letras con marcas de tiempo y el endpoint web gratuito de **Google Translate** para traducir cada línea. No se incluye ninguna clave de servicios de traducción y el token de Spotify queda en memoria de la pestaña. LRCLIB o Google Translate pueden limitar solicitudes y la traducción automática puede no estar disponible para algunas líneas.

## Ejecutar en Windows

1. Abrí una terminal en la carpeta del proyecto.
2. Ejecutá `py server.py`.
3. Abrí <http://127.0.0.1:8888>.
4. Abrí la app; conectá Spotify para mostrar la canción y sus letras sincronizadas.

No abras `index.html` directamente: Spotify necesita una dirección HTTP local para el retorno de inicio de sesión.

## Conectar Spotify

1. Entrá a [Spotify for Developers](https://developer.spotify.com/dashboard) y creá una app.
2. En la configuración de la app agregá el Redirect URI `http://127.0.0.1:8888/callback` y guardá los cambios.
3. Copiá el Client ID, abrí **Conectar Spotify** en Verso y pegalo.
4. Confirmá los permisos de lectura y control de reproducción.

La app solicita `user-read-currently-playing`, `user-read-playback-state` y `user-modify-playback-state`. Este último permiso habilita los controles del reproductor y saltar a una línea al tocarla. Spotify requiere una cuenta Premium para saltar a una posición específica. Spotify puede restringir qué usuarios de prueba pueden autorizar una app en modo Development; agregalos desde el dashboard si es necesario. Las letras proceden de LRCLIB, no de Spotify.

## Publicar en Vercel

Este proyecto es estático y no necesita una compilación. Importá el repositorio de GitHub en Vercel y dejá en blanco los campos **Build Command** y **Output Directory**. `vercel.json` conserva la ruta `/callback` para que Spotify vuelva a la app después de autorizarla. Luego de obtener el dominio asignado por Vercel, agregá `https://TU-DOMINIO.vercel.app/callback` como Redirect URI en Spotify for Developers. Usá ese mismo dominio para abrir la app y conectar Spotify.

## Alcance

Se muestran letras sincronizadas cuando LRCLIB dispone de ellas. Las letras sin marcas de tiempo no se pueden presentar con sincronización precisa. La app consulta Spotify cada 2,5 segundos, interpola el progreso entre consultas y busca/traduce letras al cambiar de canción. El uso depende de servicios web gratuitos de terceros, que pueden cambiar límites o disponibilidad.

El selector de idioma permite traducir a español, inglés, portugués, francés, italiano, alemán, japonés o coreano. El panel de letras se puede estirar desde su borde inferior y conserva la altura elegida en ese navegador; el tamaño del texto también se puede ajustar.

## Archivos

- `index.html`: estructura de la interfaz.
- `styles.css`: estilos adaptables a móvil y escritorio.
- `app.js`: Spotify PKCE, lectura de LRCLIB, traducción y sincronización.
