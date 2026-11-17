# ArcPlay — cliente invitado

Página pública para entrar en una partida de ArcPlay sin instalar extensiones. Comparte vídeo y audio del juego del anfitrión por WebRTC y envía controles de teclado y ratón solo cuando el invitado los activa.

Para publicar la versión 1.3 debes **compilar el proyecto** y subir el contenido de `dist/web-invitado` a GitHub Pages. La biblioteca Trystero se incluye en el archivo local `trystero.bundle.js`, no desde un CDN.

El anfitrión debe usar la **extensión de la misma versión**. ArcPlay no dispone de servidor propio: los participantes se encuentran mediante relays públicos Nostr. Ciertas redes pueden requerir TURN para el vídeo.
