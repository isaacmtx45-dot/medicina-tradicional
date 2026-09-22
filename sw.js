/* Lo que hace que la app abra SIN SEÑAL y se pueda instalar con icono.
 *
 * ⚠️ La regla que decide el diseño: en cuanto la app se instala, la tablet deja de
 * depender de la red — asi que si un archivo cambia y la copia guardada se queda vieja,
 * ella trabajaria con una version antigua SIN QUE NADA LO AVISE. Por eso:
 *
 *   · La version va en el nombre de la cache (VERSION). Al cambiarla, lo viejo se borra.
 *   · Se sirve de la cache y se pide la red EN PARALELO (stale-while-revalidate): abre
 *     al instante sin señal, y con señal se queda con lo nuevo para la proxima.
 *
 * 🔴 Y lo que NO toca: los DATOS. Lo capturado y la base viven en IndexedDB, que esto no
 * mira ni puede borrar. Vaciar la cache nunca puede costarle un registro a nadie.
 */
"use strict";

/* ⚠️ Esta línea la SELLA `empaquetar_app_tablet.py` con una huella de los demás
   archivos (DX, 2026-09-11): cualquier cambio de la app cambia el nombre de la caché
   y el teléfono cambia de versión entera. Aquí se deja «dev» a propósito: servida
   por wifi no hay service worker, y lo que se sube siempre va sellado. */
const VERSION = "mt-tablet-8405f17ba8";
const ARCHIVOS = [
  "./",
  "./index.html",
  "./estilo.css",
  "./app.js",
  "./catalogo.json",
  "./manifest.webmanifest",
  "./icono-maskable-512.png",
  "./icono-192.png",
  "./icono-512.png",
  /* GA-2 · las letras del rediseño: si falta una aquí, sin señal sale la del sistema. */
  "./fuentes/inter-latin-400.woff2",
  "./fuentes/inter-latin-500.woff2",
  "./fuentes/inter-latin-600.woff2",
  "./fuentes/poppins-latin-600.woff2",
  "./fuentes/poppins-latin-700.woff2"
];

self.addEventListener("install", evento => {
  evento.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(ARCHIVOS))
      /* Si un archivo no se puede guardar, la app tiene que instalarse igual: sin
         cache funciona con señal, y eso es mejor que no instalarse. */
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", evento => {
  evento.waitUntil(
    caches.keys()
      .then(claves => Promise.all(
        /* 🔴 GA-3 (2026-09-21) · Solo las cachés PROPIAS. En GitHub Pages todas las apps de su
           cuenta viven en el mismo origen (`isaacmtx45-dot.github.io`) y comparten las cachés:
           borrar «todo lo que no sea VERSION» le quitaba a GestionDinero (y a cualquier otra
           app de la cuenta) la copia con la que abre sin señal. */
        claves.filter(k => k.startsWith("mt-tablet-") && k !== VERSION)
              .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* 🔴🔴 DY-2 (2026-09-11) · SI EL SITIO PIDE INICIAR SESION, HAY QUE DECIRLO.
   ==========================================================================
   Su caso real: el hosting se quedo PROTEGIDO y devolvia **401** con una pagina de
   «inicia sesion» en vez de los archivos. La app seguia abriendo —con la copia
   guardada— y NADA avisaba, asi que estuvo recargando sin entender por que no
   cambiaba: *«he recargado varias veces y nada, lo veo igual»*.

   ⚠️ Lo caro no fue el 401: fue que **nadie se entero** (L-265). Un 401 no rompe nada
   visible, se comporta igual que no tener señal. Y esto solo lo puede ver el service
   worker, porque **es el unico que va a la red**: la pagina ya se pinto con lo guardado.

   Aprobado por el: *«doy el ok para lo que tu dices»*. */
const SIN_ACCESO = [401, 403];

function avisarQueNoSePudoComprobar(estado) {
  /* `includeUncontrolled` porque la pestaña que acaba de abrir todavia puede no estar
     controlada por este service worker, y es justo la que tiene que enseñar el aviso. */
  return self.clients.matchAll({includeUncontrolled: true})
    .then(paginas => paginas.forEach(
      pagina => pagina.postMessage({tipo: "sin-acceso", estado: estado})));
}

/* 🔴 DY-3 (2026-09-11) · DECIR QUE VERSION SE ESTA CORRIENDO.
   Su pregunta, despues de subir el ZIP: *«no se si está con el cambio de ahora»*. Y tenia
   razon en no poder saberlo: lo de la tanda anterior es invisible a proposito —el aviso solo
   sale si el sitio falla— asi que no habia NADA que mirar en el telefono.

   ⚠️ Contesta el service worker y no se lee `sw.js` de la red, que seria mas facil: de la red
   sale **lo que hay publicado**, y eso el ya lo puede averiguar de otra forma. Lo que no
   sabia es **lo que tiene su aparato**, y eso solo lo sabe el que se esta ejecutando. */
self.addEventListener("message", evento => {
  const dato = evento.data || {};
  if (dato.tipo !== "que-version") return;
  const puerto = evento.ports && evento.ports[0];
  if (puerto) puerto.postMessage({tipo: "version", version: VERSION});
});

self.addEventListener("fetch", evento => {
  const pedido = evento.request;
  /* Solo se atiende lo propio: un GET de esta misma app. Lo demas pasa de largo. */
  if (pedido.method !== "GET") return;
  if (new URL(pedido.url).origin !== self.location.origin) return;

  const deLaRed = fetch(pedido).then(respuesta => {
    if (respuesta && respuesta.ok) {
      const copia = respuesta.clone();
      caches.open(VERSION).then(c => c.put(pedido, copia));
    } else if (respuesta && SIN_ACCESO.indexOf(respuesta.status) !== -1) {
      /* ⚠️ Y la pagina de login NO se guarda: el `ok` de arriba ya lo impide, y meterla
         en la cache dejaria la app rota hasta desinstalarla. */
      avisarQueNoSePudoComprobar(respuesta.status);
    }
    return respuesta;
  });

  /* ⚠️ `waitUntil` no es un adorno. `respondWith` deja de retener al service worker en
     cuanto contesta con la copia guardada —o sea, al instante—, y el navegador lo puede
     apagar ANTES de que termine de preguntar por la version nueva. Sin esto, el aviso se
     perderia justo en el caso que existe para cubrir. */
  evento.waitUntil(deLaRed.catch(() => undefined));

  evento.respondWith(
    caches.match(pedido).then(
      guardado => guardado || deLaRed.catch(() => guardado))   // sin señal, vale lo guardado
  );
});
