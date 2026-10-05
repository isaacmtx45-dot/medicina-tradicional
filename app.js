/* DK · La captura de Anyi, en la tablet.
 *
 * Las tres reglas que sostienen todo esto, y ninguna se cambia sin hablarlo:
 *
 *  1. LO CAPTURADO NO SE PIERDE NUNCA. Se guarda en la tablet en cuanto se agrega, y no
 *     se borra hasta que ella confirme que ya lo descargo. A Enrique se le quedaron 191
 *     registros sin subir, y de ahi sale esta regla.
 *  2. LA APP NO INVENTA NADA. Si el documento no esta en la base, se dice y la fila se
 *     guarda MARCADA; no se rellena a ojo.
 *  3. SIN SEÑAL FUNCIONA IGUAL. No hay ni una llamada a la red en todo el archivo.
 */
"use strict";

const BD = "mt-tablet";
/* 🔴 EA · fase 2 · La version SUBE a 2 porque entra el almacen de los viajes.
   ⚠️ Subirla dispara `onupgradeneeded`, y ahi es donde una app pierde lo que la gente ya
   capturo. Por eso los almacenes solo se CREAN si no estan —nunca se borran ni se
   recrean— y hay una prueba que siembra una captura con la version 1, abre con la 2 y
   exige que siga ahi. */
const V_BD = 2;
const ALMACENES = { registros: "registros", viajes: "viajes", ajustes: "ajustes" };

let catalogo = null;
let base = null;          // { generado, personas: {documento: {t,n,f,s,d}} }
/* 🔴 FJ (2026-09-16) · Los pacientes que ella escribió porque NO estaban en la base, con la
   misma forma que la base: {documento: {t,n,f,s,d, nuevo: true}}. Viven en la tablet para
   que la segunda atención de la misma persona ya no pida los datos otra vez. */
let nuevos = {};
let registros = [];
let viajes = [];          // EA · fase 2 · el transporte, aparte
let anulaciones = [];     // EC · lo que hay que tachar en el Drive
let sede = "";
let drive = null;          // { url, clave }
let mandando = false;

/* ---------------------------------------------------------------- almacen */

/* 🔴 Lo que corre al SUBIR la version de la base, y es donde una app pierde lo que la
   gente ya capturo. Vive en su propia funcion para poder probarlo de verdad: la prueba
   siembra una captura con la version vieja, dispara esta subida y exige que siga ahi.

   ⚠️ Los almacenes solo se CREAN si no estan. Nunca se borran, nunca se recrean, y nunca
   se toca lo que haya dentro. Una migracion que «limpia para empezar bien» es un dia de
   trabajo de Anyi en la basura, y sin ningun error. */
function crearAlmacenes(db) {
  if (!db.objectStoreNames.contains(ALMACENES.registros)) {
    db.createObjectStore(ALMACENES.registros, { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(ALMACENES.viajes)) {
    db.createObjectStore(ALMACENES.viajes, { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(ALMACENES.ajustes)) {
    db.createObjectStore(ALMACENES.ajustes);
  }
}

function abrirBD() {
  return new Promise((ok, mal) => {
    const p = indexedDB.open(BD, V_BD);
    p.onupgradeneeded = () => crearAlmacenes(p.result);
    p.onsuccess = () => ok(p.result);
    p.onerror = () => mal(p.error);
  });
}

function conAlmacen(nombre, modo, hacer) {
  return abrirBD().then(db => new Promise((ok, mal) => {
    const t = db.transaction(nombre, modo);
    const peticion = hacer(t.objectStore(nombre));
    /* Se devuelve SIEMPRE el resultado de la peticion, aunque sea `undefined`.
       ⚠️ La primera version devolvia el objeto interno cuando el valor no existia
       —«dame la sede» sin sede guardada—, y entonces `(await leerAjuste("sede")) || ""`
       se quedaba con ESE objeto, porque un objeto nunca es falso. Con eso la sede
       dejaba de ser texto y no se podia ni guardar un registro. Lo cazo la prueba de la
       app, no leerlo. */
    t.oncomplete = () => ok(peticion && "result" in peticion ? peticion.result : undefined);
    t.onerror = () => mal(t.error);
    t.onabort = () => mal(t.error || new Error("transaccion cancelada"));
  }));
}

const guardarAjuste = (k, v) => conAlmacen(ALMACENES.ajustes, "readwrite", s => s.put(v, k));
const leerAjuste = k => conAlmacen(ALMACENES.ajustes, "readonly", s => s.get(k));
const guardarRegistro = r => conAlmacen(ALMACENES.registros, "readwrite", s => s.put(r));
const borrarRegistro = id => conAlmacen(ALMACENES.registros, "readwrite", s => s.delete(id));
const leerRegistros = () => conAlmacen(ALMACENES.registros, "readonly", s => s.getAll());
const guardarViaje = v => conAlmacen(ALMACENES.viajes, "readwrite", s => s.put(v));
const borrarViaje = id => conAlmacen(ALMACENES.viajes, "readwrite", s => s.delete(id));
const leerViajes = () => conAlmacen(ALMACENES.viajes, "readonly", s => s.getAll());

/* ------------------------------------------------------------------ util */

const $ = id => document.getElementById(id);

function brindis(texto, ms) {
  const caja = $("brindis");
  caja.textContent = texto;
  caja.hidden = false;
  clearTimeout(brindis._t);
  brindis._t = setTimeout(() => { caja.hidden = true; }, ms || 2600);
}

function hoy() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/* La fecha va como la escribe la matriz: d/m/aaaa. El campo del navegador la entrega
   como aaaa-mm-dd, asi que se traduce aqui y no en el programa de escritorio. */
function fechaParaElPrograma(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? Number(m[3]) + "/" + m[2] + "/" + m[1] : (iso || "");
}

function soloDigitos(t) { return String(t || "").replace(/\D+/g, ""); }
/* 🔴 AM (2026-10-03) · El DOCUMENTO no es solo dígitos: los AS y MS llevan letras
   (código del municipio + letras). Con `soloDigitos` perdía las letras y quedaba otro documento, y la base
   decía «no aparece». Las letras se quedan, en mayúscula. (El valor del viaje sí es solo
   dígitos: ese sigue con `soloDigitos`.) */
/* El botón de debajo de cada documento cambia entre el teclado numérico y el de letras.
   Delegado en el documento: así sirve para los dos módulos sin engancharlo uno por uno. */
document.addEventListener("click", function (ev) {
  const boton = ev.target.closest ? ev.target.closest("[data-letras]") : null;
  if (!boton) return;
  const campo = document.getElementById(boton.dataset.letras);
  if (!campo) return;
  const aLetras = campo.getAttribute("inputmode") !== "text";
  campo.setAttribute("inputmode", aLetras ? "text" : "numeric");
  boton.textContent = aLetras ? "Volver al teclado de números"
                              : "¿Lleva letras (AS / MS)? Teclado con letras";
  /* El teclado solo cambia al volver a enfocar: se quita el foco y se pone otra vez. */
  campo.blur();
  setTimeout(function () { campo.focus(); }, 50);
});
function limpiarDocumento(t) { return String(t || "").toUpperCase().replace(/[^0-9A-Z]+/g, ""); }

/* ------------------------------------------------------------- arranque */

async function arrancar() {
  catalogo = await (await fetch("catalogo.json", { cache: "no-cache" })).json();
  llenarSedes();
  llenarTipos();
  llenarCups();
  llenarMotivos();
  /* Después de llenarlos: la hoja se arma con las opciones que el select ya tiene. */
  vestirDesplegables();

  pedirQueNoSeBorre();          // GA1-1 · sin esperar: no frena el arranque
  sede = (await leerAjuste("sede")) || "";
  if (sede) $("sede").value = sede;
  base = (await leerAjuste("base")) || null;
  drive = (await leerAjuste("drive")) || null;
  registros = (await leerRegistros()) || [];
  viajes = (await leerViajes()) || [];
  anulaciones = (await leerAjuste("anulaciones")) || [];
  nuevos = (await leerAjuste("pacientesNuevos")) || {};
  registros.sort((a, b) => (b.creado || "").localeCompare(a.creado || ""));

  $("fecha").value = (await leerAjuste("ultimaFecha")) || hoy();
  $("tFecha").value = hoy();

  llenarTransporte();
  pintarViajes();
  irA("menu");            /* EA · la app abre por el menu, no por la captura */
  pintarBase();
  pintarLista();
  pintarEnvio();
  revisarSede();
  conectar();

  /* 🔴 A partir de aquí los botones responden. Antes de `conectar()` la app se ve
     entera —los desplegables ya están llenos— pero no reacciona a nada, así que hace
     falta poder distinguir «pintada» de «lista». */
  window.__listo = true;

  /* Al abrir se manda lo que quedara pendiente, sin molestar: es el caso normal —
     capturó sin señal en el terreno y ahora está en la IPS con wifi. */
  mandarPendientes(true);

  if ("serviceWorker" in navigator) {
    /* 🔴 DY-2 · El service worker es el UNICO que va a la red, asi que es el unico que
       puede enterarse de que el sitio dejo de entregar los archivos. Se escucha ANTES de
       registrar, para no perderse el primer mensaje. */
    navigator.serviceWorker.addEventListener(
      "message", evento => mensajeDelServicio(evento.data));
    vigilarActualizacion();
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* Sin service worker la app funciona igual; lo que se pierde es poder
         instalarla y abrirla sin señal. No es motivo para tumbar nada. */
    });
  }
}

/* 🔴🔴 GA2-4 (2026-09-21) · LA VERSIÓN NUEVA TIENE QUE VERSE, NO SOLO ESTAR.
   ==========================================================================
   Su captura del portátil: «Más…» decía la versión NUEVA (`mt-tablet-9739d59c73`) y la
   pantalla era la VIEJA. No era un fallo del rediseño sino del orden: el `sw.js` sirve
   primero lo guardado —para abrir al instante y sin señal— y trae lo nuevo por detrás; el
   service worker nuevo se instala y toma el control (`skipWaiting` + `claim`), así que
   contesta la versión nueva, pero la página que ya estaba pintada es la de antes hasta
   volver a abrirla.

   Cuando cambia el service worker que controla la página (`controllerchange`), se RECARGA
   sola — salvo que haya algo escrito a medias, porque recargar lo borraría. Entonces sale
   un aviso con un botón, y actualiza ella cuando termine.
   ⚠️ La PRIMERA vez que se instala no hay controlador previo: eso no es una actualización y
   no se recarga (sería recargar en el primer arranque sin motivo). */
function hayAlgoAMedias() {
  const escrito = ["documento", "nNombre", "tDocumento"]  // lo que se escribe POR PERSONA: el viaje (origen, destino, valor, placa) se queda puesto a propósito
    .some(id => { const el = $(id); return el && el.value && el.value.trim() !== ""; });
  const abierto = !!document.querySelector("dialog[open], .ventana-fondo, .hoja-fondo");
  return escrito || abierto;
}

function vigilarActualizacion() {
  const sw = navigator.serviceWorker;
  let habiaControlador = !!sw.controller;
  let recargando = false;
  sw.addEventListener("controllerchange", () => {
    if (!habiaControlador) { habiaControlador = true; return; }
    if (recargando) return;
    if (!hayAlgoAMedias()) { recargando = true; location.reload(); return; }
    const caja = $("avisoActualizar");
    if (caja) caja.hidden = false;
  });
  const boton = $("botonActualizar");
  if (boton) boton.addEventListener("click", () => { recargando = true; location.reload(); });
}

/* 🔴🔴 DY-2 (2026-09-11) · «LO VEO IGUAL»: DECIR QUE NO SE PUDO COMPROBAR LA VERSION.
   ====================================================================================
   Aprobado por el: *«doy el ok para lo que tu dices»*. El sitio se quedo protegido y
   contestaba **401** en vez de los archivos; la app seguia abriendo con la copia guardada
   y el se paso un rato recargando: *«he recargado varias veces y nada, lo veo igual»*.

   ⚠️ Lo que se dice y lo que NO:

   * **No dice «error»**, porque no lo hay: lo capturado, la base y descargar funcionan
     igual. Decir «error» haria que dejara de capturar por miedo a perder el dia.
   * **Dice que lo que ve es la copia guardada**, que es la parte que no se puede adivinar
     mirando la pantalla — y es justo lo que a el le faltaba para no seguir recargando.
   * **Lleva el numero** (401/403): es el dato con el que se arregla, y sin el hay que
     volver a medirlo desde fuera. */
/* ======================================================================
   EA · fase 2 (2026-09-12) · EL MODULO DE TRANSPORTE (S50008)
   ======================================================================
   Su decision, viendo el programa de Enrique: el transporte es un MODULO APARTE, no un
   CUPS mas dentro de la captura. Y con razon — necesita seis datos que una atencion no
   tiene: medio, placa, origen, destino, valor y a quien llevo.

   🔴 **Se captura PLANO: una fila por persona**, repitiendo los datos del viaje. Es la
   forma que ya usaba el APK y la que el lector del programa entiende; el plano oficial es
   jerarquico (`1|` viaje, `2|` beneficiado) y **el programa agrupa al importar**, no ella.
   Pedirle que arme la jerarquia en una tablet seria pedirle que haga de programa. */

const COLUMNAS_TRANSPORTE = [
  /* ⚠️ Estos nombres NO son un invento: son los que el programa YA sabe leer del volcado
     del APK (`lector_matriz_mt._COL_TRANSPORTE` y `_COL_BENEFICIARIO`). Escribir columnas
     nuevas habria obligado a tocar el lector y a re-probarlo entero. */
  "TIPO ID", "DOCUMENT", "TRANSPORT_DATE", "TRANSPORT_MEDIUM_CODE", "PLATE",
  "ORIGIN_PLACE", "DESTINATION_PLACE", "TOTAL_VALUE", "BENEFICIARY_TYPE_CODE",
  "BENEFIT_CODE", "SEDE"
];

const cfgTransporte = () => (catalogo && catalogo.transporte) || {};

function llenarTransporte() {
  const t = cfgTransporte();
  const poner = (sel, valores, textos) => {
    sel.innerHTML = "";
    valores.forEach(v => sel.appendChild(
      new Option(textos ? v + " · " + textos[v] : v, v)));
  };
  poner($("tTipo"), (catalogo && catalogo.tipos_documento) || [], null);
  $("tTipo").value = "CC";
  poner($("tMedio"), Object.keys(t.medios || {}).sort(ordenNumerico), t.medios || {});
  poner($("tBeneficiado"), Object.keys(t.tipos_beneficiado || {}).sort(ordenNumerico),
        t.tipos_beneficiado || {});

  /* Los motivos del traslado son los del subcodigo de transporte, del MISMO catalogo que
     usa el otro modulo: no hay una segunda lista que se pueda quedar vieja. */
  const cups = (catalogo && catalogo.cups && catalogo.cups[t.cups]) || {subcodigos: {}};
  const sub = Object.keys(cups.subcodigos)[0];
  const motivos = (sub && cups.subcodigos[sub].motivos) || {};
  poner($("tMotivo"), Object.keys(motivos).sort(ordenNumerico), motivos);
  $("tMotivo").dataset.subcodigo = sub || "";
  ajustarPlaca();
}

/* La placa solo existe si el medio es un vehiculo; con cualquier otro va `NA`. Se deja
   VER, bloqueada, en vez de esconderla: asi se entiende por que no se escribe. */
function ajustarPlaca() {
  const t = cfgTransporte();
  const esVehiculo = $("tMedio").value === (t.medio_con_placa || "1");
  const placa = $("tPlaca");
  placa.disabled = !esVehiculo;
  if (!esVehiculo) {
    placa.value = t.placa_no_aplica || "NA";
  } else if (placa.value === (t.placa_no_aplica || "NA")) {
    placa.value = "";
  }
}

function fallarViaje(texto, foco) {
  const caja = $("tAviso");
  caja.textContent = texto;
  caja.hidden = false;
  if (foco && $(foco)) $(foco).focus();
  return false;
}

async function agregarViaje() {
  $("tAviso").hidden = true;
  if (!sede) return fallarViaje("Escoge la sede arriba antes de capturar.", "sede");

  const doc = limpiarDocumento($("tDocumento").value);
  if (!doc) return fallarViaje("Falta el número de documento.", "tDocumento");
  if (!$("tFecha").value) return fallarViaje("Falta la fecha del viaje.", "tFecha");
  if (!$("tMedio").value) return fallarViaje("Falta el medio de transporte.", "tMedio");

  const t = cfgTransporte();
  const placa = ($("tPlaca").value || "").trim().toUpperCase();
  if (!placa) return fallarViaje("Falta la placa del vehículo.", "tPlaca");

  const origen = ($("tOrigen").value || "").trim();
  const destino = ($("tDestino").value || "").trim();
  if (!origen) return fallarViaje("Falta el lugar de origen.", "tOrigen");
  if (!destino) return fallarViaje("Falta el lugar de destino.", "tDestino");

  /* El valor va SIN puntos ni comas, que es lo que pide el plano — y con puntos es como
     se escribe por costumbre. Se limpia aqui en vez de regañarla por ello. */
  const valor = soloDigitos($("tValor").value);
  if (!valor) return fallarViaje("Falta el valor total del viaje.", "tValor");

  if (!$("tBeneficiado").value) {
    return fallarViaje("Falta decir si es el paciente o un acompañante.", "tBeneficiado");
  }
  if (!$("tMotivo").value) return fallarViaje("Falta el motivo del traslado.", "tMotivo");

  const viaje = {
    id: Date.now() + "-" + Math.random().toString(16).slice(2, 8),
    sede: sede,
    tipo: $("tTipo").value,
    documento: doc,
    fecha: $("tFecha").value,
    medio: $("tMedio").value,
    placa: placa,
    origen: origen,
    destino: destino,
    valor: valor,
    beneficiado: $("tBeneficiado").value,
    motivo: $("tMotivo").value,
    descargado: false,
    cuando: new Date().toISOString()
  };
  await guardarViaje(viaje);
  viajes.push(viaje);
  pintarViajes();

  /* Se quedan puestos los datos DEL VIAJE y se limpia la persona: lo normal es capturar
     el mismo viaje para el acompañante justo despues. Es la misma idea que en el otro
     modulo, donde se quedan el documento y la fecha. */
  $("tDocumento").value = "";
  $("tTipo").dataset.tocado = "";
  pintarQuienEs("tDocumento", "tQuienEs", "tTipo");
  $("tDocumento").focus();
  brindis("Transporte guardado.");
  return true;
}

function pintarViajes() {
  const lista = $("tLista");
  const t = cfgTransporte();
  $("tCuantos").textContent = String(viajes.length);
  lista.innerHTML = "";
  viajes.slice().reverse().forEach(v => {
    const li = document.createElement("li");
    const datos = document.createElement("div");
    datos.className = "datos";
    const quien = base && personaDe(v.documento);
    const titulo = document.createElement("span");
    titulo.className = "titulo";
    titulo.textContent = (quien && quien.n) || ("Documento " + v.documento);
    const detalle = document.createElement("span");
    detalle.className = "detalle";
    detalle.textContent = v.fecha + " · " + v.origen + " → " + v.destino +
      " · " + ((t.medios || {})[v.medio] || ("medio " + v.medio)) +
      (v.placa && v.placa !== (t.placa_no_aplica || "NA") ? " " + v.placa : "") +
      " · " + ((t.tipos_beneficiado || {})[v.beneficiado] || "") +
      " · motivo " + v.motivo;
    datos.appendChild(titulo);
    datos.appendChild(detalle);
    const quitar = document.createElement("button");
    quitar.type = "button";
    quitar.className = "secundario";
    quitar.textContent = "Quitar";
    quitar.addEventListener("click", () => quitarViaje(v));
    li.appendChild(datos);
    li.appendChild(quitar);
    lista.appendChild(li);
  });
}

async function quitarViaje(v) {
  const p = base && personaDe(v.documento);
  const quien = (p && p.n) || v.documento;
  const si = await preguntar("Quitar el transporte",
    ["¿Quitar el viaje de " + quien + " del " + v.fecha + "?",
     v.enviado ? "Se borra de este aparato y se tacha en el Drive."
               : "Esto no se puede deshacer."], "Quitar", true);
  if (!si) return;
  await apuntarAnulacion(v, "transporte");
  await borrarViaje(v.id);
  viajes = viajes.filter(x => x.id !== v.id);
  pintarViajes();
  pintarEnvio();
  if (v.enviado) mandarPendientes(true);
}

function csvDeViajes(vs) {
  const escapar = valor => {
    const t = String(valor === null || valor === undefined ? "" : valor);
    return /[",;\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const lineas = [COLUMNAS_TRANSPORTE.join(",")];
  vs.forEach(v => {
    lineas.push([v.tipo, v.documento, fechaParaElPrograma(v.fecha), v.medio, v.placa,
                 v.origen, v.destino, v.valor, v.beneficiado, v.motivo, v.sede]
                .map(escapar).join(","));
  });
  return "﻿" + lineas.join("\r\n") + "\r\n";
}

async function descargarViajes() {
  if (viajes.length === 0) { brindis("No hay transporte que descargar."); return; }
  const nombre = "transporte_" + (sede || "SIN_SEDE") + "_" + hoy() + ".csv";
  const blob = new Blob([csvDeViajes(viajes)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  /* Igual que en el otro modulo: descargar MARCA, no borra. Si el archivo se pierde por
     el camino, lo capturado sigue aqui y se puede volver a bajar. */
  for (const v of viajes) {
    if (!v.descargado) { v.descargado = true; await guardarViaje(v); }
  }
  pintarViajes();
}

/* ======================================================================
   EA (2026-09-11) · EL MENU: MOVERSE ENTRE MODULOS
   ======================================================================
   Con la forma del programa de Enrique, que es la que el escogio. La app **arranca en el
   menu**, no en la captura: con dos modulos, entrar directo a uno seria decidir por ella.

   ⚠️ Se esconde con el atributo `hidden`, no con una clase: asi el navegador lo saca del
   orden de lectura y del tabulador. Una pantalla «escondida» con `opacity` sigue estando
   ahi para el teclado y para quien usa lector de pantalla. */
const PANTALLAS = {menu: "pantallaMenu", medicina: "pantallaMedicina",
                   transporte: "pantallaTransporte"};
const TITULOS = {menu: "Makushama IPS", medicina: "Medicina Tradicional",
                 transporte: "Transporte"};

function irA(nombre) {
  Object.keys(PANTALLAS).forEach(clave => {
    const caja = $(PANTALLAS[clave]);
    if (caja) caja.hidden = (clave !== nombre);
  });
  const titulo = $("tituloBarra");
  if (titulo) titulo.textContent = TITULOS[nombre] || TITULOS.menu;
  /* 🔴 EH · En el menú manda el logo; dentro de un módulo, la flecha de volver. Los dos
     ocupan la MISMA casilla de la rejilla, así que la barra mide igual en las dos
     pantallas y el título no se mueve al entrar y salir. */
  const enElMenu = (nombre === "menu");
  const atras = $("atrasBarra"), logo = $("logoBarra");
  if (atras) atras.hidden = enElMenu;
  if (logo) logo.hidden = !enElMenu;
  /* GA-2 · La sección activa se marca en la navegación (lateral o barra de abajo). */
  document.querySelectorAll("[data-nav]").forEach(b => {
    if (b.dataset.nav === nombre) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (enElMenu) pintarInicio();
  /* Al cambiar de pantalla se vuelve arriba: si no, se entra a un modulo por la mitad. */
  window.scrollTo(0, 0);
}

/* ======================================================================
   🔴 GA-2 (2026-09-21) · EL INICIO DEL REDISEÑO: saludo y cuatro cifras
   ======================================================================
   Maqueta aprobada por él. Cada cifra sale de lo que la app YA guarda y que otra pantalla
   ya enseña —`registros`, `viajes`, lo marcado `descargado` o `enviado`, y la base—, así
   que no hay una segunda cuenta que pueda contradecir a la primera.
   ⚠️ El saludo NO lleva nombre: esta página se publica y la usa quien capture. */
function hoyISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-"
    + String(d.getDate()).padStart(2, "0");
}

function pintarInicio() {
  const poner = (id, texto) => { const el = $(id); if (el) el.textContent = texto; };
  const hora = new Date().getHours();
  poner("saludo", hora < 12 ? "Buenos días" : hora < 19 ? "Buenas tardes" : "Buenas noches");

  const hoy = hoyISO();
  /* `creado` y `cuando` se guardan en ISO de la hora universal: para decir «hoy» se leen
     en la hora de aquí, o lo capturado después de las 7 de la noche contaría como mañana. */
  const esDeHoy = iso => {
    if (!iso) return false;
    const d = new Date(iso);
    return !isNaN(d) && (d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")
      + "-" + String(d.getDate()).padStart(2, "0")) === hoy;
  };
  const atencionesHoy = registros.filter(r => esDeHoy(r.creado)).length;
  const viajesHoy = viajes.filter(v => esDeHoy(v.cuando)).length;
  poner("cifraHoy", String(atencionesHoy + viajesHoy));
  poner("cifraHoyDetalle", atencionesHoy + (atencionesHoy === 1 ? " atención" : " atenciones")
    + " · " + viajesHoy + (viajesHoy === 1 ? " viaje" : " viajes"));

  const sinBajar = registros.filter(r => !r.descargado).length
    + viajes.filter(v => !v.descargado).length;
  poner("cifraSinDescargar", String(sinBajar));
  poner("cifraSinDescargarDetalle", sinBajar ? "descárgalo antes de irte" : "todo descargado");

  const total = registros.length + viajes.length;
  if (drive && drive.url) {
    const mandados = registros.filter(r => r.enviado).length
      + viajes.filter(v => v.enviado).length;
    poner("cifraDrive", mandados + " / " + total);
    poner("cifraDriveDetalle", total - mandados
      ? (total - mandados) + " esperan internet" : "todo mandado");
  } else {
    poner("cifraDrive", "—");
    poner("cifraDriveDetalle", "sin conexión configurada");
  }

  if (base && base.personas) {
    const n = Object.keys(base.personas).length;
    poner("cifraBase", n.toLocaleString("es-CO"));
    poner("cifraBaseDetalle", "del " + (base.generado || "?"));
  } else {
    poner("cifraBase", "—");
    poner("cifraBaseDetalle", "sin cargar: Más… → Cargar la base");
  }
}

/* 🔴 Lo que TODAVIA no esta hecho lo dice, y dice que hacer entre tanto. Callarlo o
   enseñar una pantalla vacia se lee como que la app se rompio (§4.9: lo que falla sin
   avisar es lo caro). Este aviso se quita al cerrar la fase 5. */
/* EA · fase 5 · La tarjeta del menu. Si hay Drive, la baja sola; si no, lo dice y
   ofrece el archivo a mano, que es lo que habia hasta hoy y sigue funcionando. */
async function irActualizarBase() {
  /* Con Drive puesto, `bajarLaBaseDelDrive` ya se encarga de todo —incluido ofrecer el
     archivo a mano si en la carpeta no hay base, que es el caso de la opcion (B)—. Sin
     Drive, explica por que no puede y se abre el selector. */
  if (drive && drive.url) return bajarLaBaseDelDrive();
  await bajarLaBaseDelDrive();
  $("archivoBase").click();
}

/* El boton global de sincronizar. En la fase 4 mandará los DOS módulos; hoy manda lo de
   Medicina Tradicional, que es lo unico que hay. */
async function sincronizarTodo() {
  if (!drive || !drive.url) {
    return avisar("Sincronizar", [
      "Todavía no hay conexión con el Drive configurada.",
      "Se pone una sola vez en Medicina Tradicional → Más… → Conexión con el Drive."]);
  }
  if (porMandar().length + porMandarViajes().length === 0) {
    return avisar("Sincronizar", ["No hay registros pendientes por sincronizar."]);
  }
  await mandarPendientes(false);
}

/* Un SOLO sitio decide que hacer con lo que manda el service worker.
   ⚠️ Y no es por orden: el nombre del aviso (`tipo`) lo escriben DOS archivos que no se
   ven entre si —`sw.js` lo manda y este lo lee—, asi que una errata ahi no da ningun
   error, solo silencio. Con la funcion suelta, la prueba puede pasarle el mensaje REAL
   que produce el service worker y comprobar que los dos hablan el mismo idioma. */
function mensajeDelServicio(dato) {
  dato = dato || {};
  if (dato.tipo === "sin-acceso") avisarQueNoSePudoComprobar(dato.estado);
}

/* 🔴🔴 DY-3 (2026-09-11) · QUÉ VERSIÓN ESTÁ CORRIENDO ESTE APARATO.
   ====================================================================================
   Su pregunta despues de subir el ZIP: *«no se si está con el cambio de ahora»*. Y no habia
   forma de saberlo: lo de la tanda anterior es invisible a proposito —el aviso del 401 solo
   sale si el sitio falla—, asi que en el telefono no habia NADA que mirar. Escogio verlo en
   «Más…» (se le ofrecio la cabecera y dijo que ahi no).

   ⚠️ Se le pregunta al service worker que esta ACTIVO, no se lee `sw.js` de la red. De la red
   sale lo que hay PUBLICADO —que ya se puede medir desde fuera— y lo que el no sabia es lo
   que tiene SU aparato. Son dos cosas distintas y justo la diferencia entre ellas es el
   problema que esto viene a resolver.

   ⚠️ Y con tope de tiempo: si el service worker no contesta —o no hay, que es lo que pasa
   servida por wifi para probar— se dice **que no se sabe**, no se deja «comprobando…» para
   siempre ni se inventa un numero. */
function versionQueEstaCorriendo(espera) {
  return new Promise(resolver => {
    const sw = navigator.serviceWorker;
    if (!sw || !sw.controller) return resolver(null);
    const canal = new MessageChannel();
    const reloj = setTimeout(() => resolver(null), espera || 2000);
    canal.port1.onmessage = evento => {
      clearTimeout(reloj);
      resolver((evento.data || {}).version || null);
    };
    try {
      sw.controller.postMessage({tipo: "que-version"}, [canal.port2]);
    } catch (e) {
      clearTimeout(reloj);
      resolver(null);
    }
  });
}

/* 🔴 GA1-1 (2026-09-21) · Que el navegador NO borre lo capturado.
   La app ahora va también en el PORTÁTIL de Anyi, instalada desde Chrome. En un PC, si le
   falta espacio, Chrome puede vaciar lo que las páginas guardan —y aquí eso es lo capturado
   sin descargar y la base—, salvo que la página haya pedido guardado PERSISTENTE y se lo
   hayan concedido. Pedirlo no cuesta nada y no pregunta nada: Chrome lo concede solo a una
   app instalada. Se pide al arrancar y se dice en «Más…» si quedó concedido. */
async function pedirQueNoSeBorre() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (e) {
    return null;
  }
}

async function pintarGuardado() {
  const caja = $("guardadoSeguro");
  if (!caja) return;
  const seguro = await pedirQueNoSeBorre();
  caja.textContent = seguro === true
    ? "Guardado protegido: el navegador no lo borrará aunque le falte espacio."
    : seguro === false
      ? "El navegador NO protegió lo guardado. Instala la app (no la uses como página) y descarga seguido."
      : "Este navegador no dice si protege lo guardado. Descarga seguido.";
}

async function pintarVersion(espera) {
  const caja = $("versionApp");
  if (!caja) return;
  const version = await versionQueEstaCorriendo(espera);
  if (version) { caja.textContent = "versión " + version; return; }

  /* ⚠️ DOS motivos distintos, y NO pueden decir lo mismo. Lo destapó sabotear la prueba:
     con una errata en el nombre del mensaje, la app —instalada y funcionando— decía «no
     está instalada», que es mentira y manda a quien lo lea a reinstalarla para nada.
     Que no conteste y que no esté son cosas opuestas y se arreglan al revés. */
  const instalada = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  caja.textContent = instalada
    ? "versión: no se pudo averiguar; cierra la app y vuelve a abrirla"
    : "versión: la app no está instalada en este navegador";
}

function avisarQueNoSePudoComprobar(estado) {
  const caja = $("avisoVersion");
  if (!caja) return;
  caja.textContent =
    "Estás viendo la copia guardada en este aparato. La página pidió iniciar sesión ("
    + (estado || "sin respuesta") + "), así que no se pudo comprobar si hay una versión "
    + "nueva. Captura y descarga con normalidad, y avísale a Isaac.";
  caja.hidden = false;
}

/* ======================================================================
   DY (2026-09-11) · LOS AVISOS Y LAS PREGUNTAS, CON EL DISEÑO DE LA APP
   ======================================================================
   Su captura: al quitar una atención salía el cuadro del NAVEGADOR —«stellar-rugelach-
   2d22db.netlify.app says · Cancel / OK»—, gris, en inglés y con la dirección de la
   página. Textual: *«no quiero que salga de esa manera, tambien todas la alertas o
   cuadros que demuestre la app… que tengan el mismo diseño de la app, para que no
   parezca de pagina generica»*. Por eso la app ya NO usa `confirm`, `alert` ni `prompt`,
   y una prueba lo vigila.

   ⚠️ El texto va en PÁRRAFOS (una lista), no en una sola cadena con saltos: dos de los
   avisos viejos enseñaban los saltos como barra y ene literales por un escape mal escrito
   (L-264), y así ya no hay escape que se pueda escribir mal. */
function ventana(opciones) {
  const o = Object.assign({titulo: "", texto: [], aceptar: "Aceptar", cancelar: null,
                           peligro: false}, opciones || {});
  const parrafos = Array.isArray(o.texto) ? o.texto : [o.texto];
  return new Promise(resolver => {
    const fondo = document.createElement("div");
    fondo.className = "ventana-fondo";
    const caja = document.createElement("div");
    caja.className = "ventana";
    caja.setAttribute("role", "alertdialog");
    caja.setAttribute("aria-modal", "true");
    if (o.titulo) {
      const h = document.createElement("h3");
      h.textContent = o.titulo;
      caja.appendChild(h);
    }
    parrafos.filter(Boolean).forEach(t => {
      const p = document.createElement("p");
      p.textContent = t;
      caja.appendChild(p);
    });

    const botones = document.createElement("div");
    botones.className = "ventana-botones";
    const cerrar = valor => {
      document.removeEventListener("keydown", teclado);
      fondo.remove();
      resolver(valor);
    };
    let no = null;
    if (o.cancelar) {
      no = document.createElement("button");
      no.type = "button";
      no.className = "ventana-no";
      no.textContent = o.cancelar;
      no.addEventListener("click", () => cerrar(false));
      botones.appendChild(no);
    }
    const si = document.createElement("button");
    si.type = "button";
    si.className = "ventana-si" + (o.peligro ? " peligro" : "");
    si.textContent = o.aceptar;
    si.addEventListener("click", () => cerrar(true));
    botones.appendChild(si);
    caja.appendChild(botones);
    fondo.appendChild(caja);

    const teclado = e => { if (e.key === "Escape") cerrar(!o.cancelar); };
    document.addEventListener("keydown", teclado);
    /* Tocar fuera cierra solo lo que se puede cancelar: un aviso hay que leerlo. */
    fondo.addEventListener("click", e => {
      if (e.target === fondo && o.cancelar) cerrar(false);
    });
    document.body.appendChild(fondo);
    /* En lo que BORRA, el foco va a «Cancelar»: un toque de más no debe borrar nada. */
    (o.peligro && no ? no : si).focus();
  });
}

/* Una pregunta de sí o no. Devuelve una promesa: `if (!(await preguntar(...))) return;` */
function preguntar(titulo, texto, aceptar, peligro) {
  return ventana({titulo: titulo, texto: texto, aceptar: aceptar || "Sí",
                  cancelar: "Cancelar", peligro: !!peligro});
}

/* Un aviso con un solo botón. */
function avisar(titulo, texto) {
  return ventana({titulo: titulo, texto: texto, aceptar: "Entendido"});
}

/* ======================================================================
   DX (2026-09-11) · LOS DESPLEGABLES, CON EL DISEÑO DE LA APP
   ======================================================================
   Su queja, con capturas: *«seria bueno que el desplegable de los codigos y subcodigos
   sea igual del diseño de la pagina»*. Los `<select>` los dibuja el SISTEMA —gris, con
   su tipografia y sus circulitos— y no se pueden pintar con CSS.

   ⚠️ **El `<select>` se queda y sigue mandando.** Lo que se agrega es un boton y una
   hoja que escriben en el: asi todo lo que ya lee `$("cups").value` —la validacion, el
   guion de las pruebas, el «Agregar y seguir»— sigue funcionando igual. Reescribirlo con
   objetos propios habria obligado a tocar media app para cambiar como se ve.

   ⚠️ Y se sincroniza en los TRES sitios donde el valor puede cambiar: cuando el usuario
   escoge, cuando la app lo cambia sola (`$("cups").value = ""` al agregar) y cuando se
   vuelven a llenar las opciones. Sin lo segundo, el boton se quedaba enseñando el
   servicio anterior con el select ya vacio. */

const VESTIDOS = new WeakMap();

function vestirSelect(sel, titulo) {
  if (VESTIDOS.has(sel)) return VESTIDOS.get(sel);

  const caja = document.createElement("div");
  caja.className = "desplegable";
  sel.parentNode.insertBefore(caja, sel);
  caja.appendChild(sel);

  const boton = document.createElement("button");
  boton.type = "button";
  boton.className = "desplegable-boton";
  boton.setAttribute("aria-haspopup", "listbox");
  caja.appendChild(boton);

  const pintar = () => {
    const op = sel.options[sel.selectedIndex];
    const texto = op ? op.text : "";
    const partes = texto.split(" · ");
    boton.innerHTML = "";
    const etiqueta = document.createElement("span");
    etiqueta.className = "desplegable-texto" + (sel.value ? "" : " vacio");
    if (sel.value && partes.length > 1) {
      const codigo = document.createElement("b");
      codigo.textContent = partes[0];
      etiqueta.appendChild(codigo);
      etiqueta.appendChild(document.createTextNode(" " + partes.slice(1).join(" · ")));
    } else {
      etiqueta.textContent = texto || "— escoge —";
    }
    boton.appendChild(etiqueta);
    const flecha = document.createElement("span");
    flecha.className = "desplegable-flecha";
    flecha.textContent = "▾";
    boton.appendChild(flecha);
    boton.disabled = sel.disabled;
  };

  boton.addEventListener("click", () => abrirHoja(sel, titulo || "Escoge"));
  sel.addEventListener("change", pintar);
  new MutationObserver(pintar).observe(sel, {childList: true});

  /* El valor también cambia por código, y eso no dispara ningún evento. */
  const propio = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(sel, "value", {
    configurable: true,
    get() { return propio.get.call(this); },
    set(v) { propio.set.call(this, v); pintar(); }
  });
  const propioDes = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "disabled");
  Object.defineProperty(sel, "disabled", {
    configurable: true,
    get() { return propioDes.get.call(this); },
    set(v) { propioDes.set.call(this, v); pintar(); }
  });

  VESTIDOS.set(sel, pintar);
  pintar();
  return pintar;
}

/* Cuántas opciones hacen falta para que valga la pena el buscador. Con los 51 subcodigos
   de S50003 buscar es lo unico practico; con cuatro CUPS, un buscador estorba. */
const BUSCAR_DESDE = 9;

function abrirHoja(sel, titulo) {
  if (sel.disabled) return;
  const fondo = document.createElement("div");
  fondo.className = "hoja-fondo";
  const hoja = document.createElement("div");
  hoja.className = "hoja";
  fondo.appendChild(hoja);

  const cabecera = document.createElement("div");
  cabecera.className = "hoja-cabecera";
  const h = document.createElement("h3");
  h.textContent = titulo;
  const cerrar = document.createElement("button");
  cerrar.type = "button";
  cerrar.className = "hoja-cerrar";
  cerrar.setAttribute("aria-label", "Cerrar");
  cerrar.textContent = "✕";
  cabecera.appendChild(h);
  cabecera.appendChild(cerrar);
  hoja.appendChild(cabecera);

  const opciones = Array.from(sel.options).filter(o => o.value !== "" || o.selected);
  let buscador = null;
  if (opciones.length >= BUSCAR_DESDE) {
    buscador = document.createElement("input");
    buscador.className = "hoja-buscar";
    buscador.setAttribute("inputmode", "search");
    buscador.placeholder = "Buscar por código o por texto…";
    hoja.appendChild(buscador);
  }

  const lista = document.createElement("div");
  lista.className = "hoja-lista";
  lista.setAttribute("role", "listbox");
  hoja.appendChild(lista);

  const filas = [];
  Array.from(sel.options).forEach(op => {
    const fila = document.createElement("button");
    fila.type = "button";
    fila.className = "hoja-opcion" + (op.value === sel.value ? " puesta" : "");
    fila.setAttribute("role", "option");
    const partes = op.text.split(" · ");
    if (op.value && partes.length > 1) {
      const codigo = document.createElement("b");
      codigo.textContent = partes[0];
      fila.appendChild(codigo);
      const desc = document.createElement("span");
      desc.textContent = partes.slice(1).join(" · ");
      fila.appendChild(desc);
    } else {
      fila.textContent = op.text;
    }
    fila.addEventListener("click", () => {
      sel.value = op.value;
      sel.dispatchEvent(new Event("change", {bubbles: true}));
      quitar();
    });
    lista.appendChild(fila);
    filas.push({fila: fila, texto: (op.text || "").toLowerCase()});
  });

  const quitar = () => {
    document.removeEventListener("keydown", teclado);
    fondo.remove();
  };
  const teclado = e => { if (e.key === "Escape") quitar(); };
  document.addEventListener("keydown", teclado);
  cerrar.addEventListener("click", quitar);
  /* Tocar FUERA cierra; tocar dentro no. Es lo que se espera de una hoja en el móvil. */
  fondo.addEventListener("click", e => { if (e.target === fondo) quitar(); });
  if (buscador) {
    buscador.addEventListener("input", () => {
      const q = buscador.value.trim().toLowerCase();
      filas.forEach(f => { f.fila.hidden = q && !f.texto.includes(q); });
    });
  }

  document.body.appendChild(fondo);
  const puesta = lista.querySelector(".puesta");
  if (puesta) puesta.scrollIntoView({block: "center"});
  /* ⚠️ El buscador NO se enfoca solo: en el móvil abriría el teclado encima de la lista
     y taparía justo lo que se viene a mirar. */
}

function vestirDesplegables() {
  /* 🔴 EH · La sede YA NO se viste de desplegable: ahora son dos botones dentro de la
     pantalla (`pintarBotonesDeSede`). Vestirla además dejaría dos controles vivos para el
     mismo dato, y el que se quedara sin repintar mentiría sobre la sede puesta. */
  vestirSelect($("tipo"), "Tipo de documento");
  vestirSelect($("cups"), "Servicio (CUPS)");
  vestirSelect($("subcodigo"), "Subcódigo");
  vestirSelect($("motivo"), "Código de motivo");
  vestirSelect($("nSexo"), "Sexo");                 /* FJ · paciente nuevo */
  /* EA · fase 2 */
  vestirSelect($("tTipo"), "Tipo de documento");
  vestirSelect($("tMedio"), "Medio de transporte");
  vestirSelect($("tBeneficiado"), "Tipo de beneficiado");
  vestirSelect($("tMotivo"), "Motivo del traslado");
  /* FJ-4 · las fechas, en día/mes/año */
  ["fecha", "tFecha", "nNacimiento"].forEach(vestirFecha);
}

/* 🔴 FJ-4 · El campo de fecha del sistema se pinta con el formato del IDIOMA DEL TELÉFONO: en
   el suyo salía `09/11/2026` para el 11 de septiembre, mientras la tarjeta decía `11/09/2026`.
   Es la trampa de EJ (Excel dándole la vuelta al día y al mes) puesta en la pantalla de quien
   captura. No hay forma de pedirle al navegador otro formato, así que el texto del campo se
   hace invisible y encima se pinta el nuestro. El campo sigue siendo el del sistema —el
   calendario se abre igual— y su `value` sigue en ISO, que es lo que usa todo lo demás.
   ⚠️ El `value` se envuelve porque la app lo pone por código (la última fecha, hoy, vaciar
   el nuevo) y eso NO dispara ningún evento: sin esto el texto pintado se quedaría viejo. */
function vestirFecha(id) {
  const el = $(id);
  if (!el || el.dataset.vestida) return;
  el.dataset.vestida = "1";
  el.classList.add("fecha-nativa");
  const muestra = document.createElement("span");
  muestra.className = "fecha-visible";
  muestra.setAttribute("aria-hidden", "true");
  el.parentElement.appendChild(muestra);
  const nativo = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const pintar = () => {
    const v = nativo.get.call(el);
    const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || "");
    muestra.textContent = p ? p[3] + "/" + p[2] + "/" + p[1] : "dd/mm/aaaa";
    muestra.classList.toggle("vacia", !p);
  };
  Object.defineProperty(el, "value", {
    configurable: true,
    get() { return nativo.get.call(el); },
    set(x) { nativo.set.call(el, x); pintar(); }
  });
  el.addEventListener("input", pintar);
  el.addEventListener("change", pintar);
  /* 🔴 GA2-5 (2026-09-22) · EL CALENDARIO ES NUESTRO. El del sistema salía blanco y azul en
     medio de la app (su captura) y ese cuadro NO se puede pintar con CSS. El campo pasa a ser
     de texto y de solo lectura —así el teléfono no saca el teclado— y el toque abre
     `abrirCalendario`. El `value` sigue en ISO: nada de lo que lo lee se entera del cambio. */
  el.type = "text";
  el.readOnly = true;
  el.setAttribute("inputmode", "none");
  el.setAttribute("aria-haspopup", "dialog");
  const icono = document.createElement("span");
  icono.className = "fecha-icono";
  icono.setAttribute("aria-hidden", "true");
  el.parentElement.appendChild(icono);
  const titulo = (el.labels && el.labels[0] && el.labels[0].textContent) || "Fecha";
  el.addEventListener("click", () => abrirCalendario(el, titulo));
  el.addEventListener("keydown", e => {
    if (e.key === " " || e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); abrirCalendario(el, titulo); }
  });
  pintar();
}

/* GA2-5 · El calendario, con el diseño de la app. Va en la misma hoja que los desplegables
   (`.hoja-fondo`), así que el aviso de «hay algo a medias» (`hayAlgoAMedias`) lo ve igual.
   Tres vistas: días → meses → años (tocando el título). La de años existe por la fecha de
   NACIMIENTO: bajar 60 años de mes en mes serían 720 toques. */
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
               "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS_SEMANA = ["do", "lu", "ma", "mi", "ju", "vi", "sá"];

function abrirCalendario(el, titulo) {
  if (el.disabled || document.querySelector(".hoja-fondo")) return;
  const iso = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-"
    + String(d.getDate()).padStart(2, "0");
  const deISO = v => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || "");
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const puesta = deISO(el.value);
  const hoyD = new Date(); hoyD.setHours(0, 0, 0, 0);
  /* Sin fecha puesta, el nacimiento arranca en la vista de AÑOS: es lo primero que hay que buscar. */
  let foco = puesta || hoyD;
  let vista = (!puesta && el.id === "nNacimiento") ? "anios" : "dias";

  const fondo = document.createElement("div");
  fondo.className = "hoja-fondo calendario-fondo";
  const hoja = document.createElement("div");
  hoja.className = "hoja calendario";
  hoja.setAttribute("role", "dialog");
  hoja.setAttribute("aria-label", titulo);
  fondo.appendChild(hoja);
  hoja.innerHTML =
    '<div class="hoja-cabecera"><h3></h3>' +
    '<button type="button" class="hoja-cerrar" aria-label="Cerrar">✕</button></div>' +
    '<div class="cal-nav"><button type="button" class="cal-flecha" data-paso="-1" aria-label="Anterior">‹</button>' +
    '<button type="button" class="cal-titulo"></button>' +
    '<button type="button" class="cal-flecha" data-paso="1" aria-label="Siguiente">›</button></div>' +
    '<div class="cal-rejilla"></div>' +
    '<div class="cal-pie"><button type="button" class="cal-borrar">Borrar</button>' +
    '<button type="button" class="cal-hoy">Hoy</button></div>';
  hoja.querySelector("h3").textContent = titulo;
  const rejilla = hoja.querySelector(".cal-rejilla");
  const botonTitulo = hoja.querySelector(".cal-titulo");

  const boton = (texto, clase, alPulsar) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = clase;
    b.textContent = texto;
    b.addEventListener("click", alPulsar);
    rejilla.appendChild(b);
    return b;
  };

  const pintar = () => {
    rejilla.innerHTML = "";
    rejilla.className = "cal-rejilla " + vista;
    const anio = foco.getFullYear(), mes = foco.getMonth();
    if (vista === "dias") {
      botonTitulo.textContent = MESES[mes][0].toUpperCase() + MESES[mes].slice(1) + " de " + anio;
      DIAS_SEMANA.forEach(d => {
        const s = document.createElement("span");
        s.className = "cal-semana";
        s.textContent = d;
        rejilla.appendChild(s);
      });
      const primero = new Date(anio, mes, 1);
      const inicio = new Date(anio, mes, 1 - primero.getDay());
      for (let i = 0; i < 42; i++) {
        const d = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + i);
        let clase = "cal-dia";
        if (d.getMonth() !== mes) clase += " fuera";
        if (d.getTime() === hoyD.getTime()) clase += " hoy";
        if (puesta && d.getTime() === puesta.getTime()) clase += " puesta";
        if (d.getTime() === foco.getTime()) clase += " enfocado";
        const b = boton(String(d.getDate()), clase, () => escoger(d));
        b.dataset.fecha = iso(d);
        b.tabIndex = d.getTime() === foco.getTime() ? 0 : -1;
      }
    } else if (vista === "meses") {
      botonTitulo.textContent = String(anio);
      MESES.forEach((m, i) => {
        let clase = "cal-mes";
        if (puesta && puesta.getFullYear() === anio && puesta.getMonth() === i) clase += " puesta";
        boton(m.slice(0, 3), clase, () => {
          foco = new Date(anio, i, Math.min(foco.getDate(), 28));
          vista = "dias"; pintar();
        });
      });
    } else {
      const desde = anio - (anio % 12);
      botonTitulo.textContent = desde + " – " + (desde + 11);
      for (let a = desde; a < desde + 12; a++) {
        let clase = "cal-mes";
        if (puesta && puesta.getFullYear() === a) clase += " puesta";
        if (a === hoyD.getFullYear()) clase += " hoy";
        boton(String(a), clase, () => {
          foco = new Date(a, foco.getMonth(), Math.min(foco.getDate(), 28));
          vista = "meses"; pintar();
        });
      }
    }
    botonTitulo.disabled = vista === "anios";
  };

  const mover = paso => {
    const a = foco.getFullYear(), m = foco.getMonth();
    if (vista === "dias") foco = new Date(a, m + paso, Math.min(foco.getDate(), 28));
    else if (vista === "meses") foco = new Date(a + paso, m, 1);
    else foco = new Date(a + 12 * paso, m, 1);
    pintar();
  };

  const quitar = () => {
    document.removeEventListener("keydown", teclado, true);
    fondo.remove();
    el.focus();
  };
  const poner = valor => {
    el.value = valor;
    el.dispatchEvent(new Event("input", {bubbles: true}));
    el.dispatchEvent(new Event("change", {bubbles: true}));
    quitar();
  };
  const escoger = d => poner(iso(d));

  /* Teclado, para el portátil: flechas mueven el día, RePág/AvPág el mes, Enter escoge. */
  const teclado = e => {
    if (e.key === "Escape") { e.preventDefault(); quitar(); return; }
    if (vista !== "dias") return;
    const pasos = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7};
    if (e.key in pasos) {
      e.preventDefault();
      foco = new Date(foco.getFullYear(), foco.getMonth(), foco.getDate() + pasos[e.key]);
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      mover(e.key === "PageUp" ? -1 : 1);
    } else if (e.key === "Enter" && document.activeElement &&
               document.activeElement.classList.contains("cal-dia")) {
      return;   // el propio botón lo escoge
    } else {
      return;
    }
    pintar();
    const b = rejilla.querySelector(".cal-dia.enfocado");
    if (b) b.focus();
  };
  document.addEventListener("keydown", teclado, true);

  hoja.querySelectorAll(".cal-flecha").forEach(
    b => b.addEventListener("click", () => mover(Number(b.dataset.paso))));
  botonTitulo.addEventListener("click", () => {
    vista = vista === "dias" ? "meses" : "anios"; pintar();
  });
  hoja.querySelector(".hoja-cerrar").addEventListener("click", quitar);
  hoja.querySelector(".cal-hoy").addEventListener("click", () => escoger(hoyD));
  hoja.querySelector(".cal-borrar").addEventListener("click", () => poner(""));
  fondo.addEventListener("click", e => { if (e.target === fondo) quitar(); });

  pintar();
  document.body.appendChild(fondo);
  const inicial = rejilla.querySelector(".cal-dia.enfocado") || rejilla.querySelector("button");
  /* En el teléfono no hay teclado que abrir aquí (son botones), así que enfocar no estorba. */
  if (inicial) inicial.focus();
}

function llenarSedes() {
  const sel = $("sede");
  sel.innerHTML = "";
  sel.appendChild(new Option("— escoge —", ""));
  Object.keys(catalogo.sedes).forEach(nombre => {
    sel.appendChild(new Option(nombre, nombre));
  });
  pintarBotonesDeSede();
}

/* 🔴 EH (2026-09-12) · La sede, en DOS BOTONES dentro de cada pantalla.
   Era un desplegable en la barra: tres toques para algo que solo tiene dos respuestas, y
   sin abrirlo no se veia cual estaba puesta.

   ⚠️ **El `<select>` sigue siendo el que manda.** Los botones solo le escriben el valor y
   le disparan su `change`, que es donde ya vive todo —guardar el ajuste, repintar y
   revisar—. Duplicar esa logica aqui seria tener dos sitios que deciden la sede, que es
   justo el dato que no se puede equivocar. */
function pintarBotonesDeSede() {
  const puesta = $("sede").value || "";
  const nombres = Object.keys(catalogo.sedes || {});
  document.querySelectorAll("[data-sedes] .sedes-botones").forEach(caja => {
    /* Se redibuja entero solo si cambió la lista: si no, basta con mover la marca —así no
       se pierde el foco de quien esté navegando con teclado. */
    if (caja.children.length !== nombres.length) {
      caja.innerHTML = "";
      nombres.forEach(nombre => {
        const boton = document.createElement("button");
        boton.type = "button";
        boton.className = "sede-boton";
        boton.textContent = nombre;
        boton.dataset.sede = nombre;
        boton.addEventListener("click", () => {
          const sel = $("sede");
          sel.value = nombre;
          sel.dispatchEvent(new Event("change"));
        });
        caja.appendChild(boton);
      });
    }
    Array.from(caja.children).forEach(boton => {
      boton.setAttribute("aria-pressed", boton.dataset.sede === puesta ? "true" : "false");
    });
  });
}

function llenarTipos() {
  const sel = $("tipo");
  sel.innerHTML = "";
  catalogo.tipos_documento.forEach(t => sel.appendChild(new Option(t, t)));
  sel.value = "CC";
}

/* DX (2026-09-11) · En orden NUMERICO, no alfabetico. El suyo: *«quisiera que los
   codigos, subcodigos y codigo de motivo se vean en orden numerico, y que no sean
   desorganizado»*. Alfabeticamente salia `S50003-1, S50003-10, S50003-12, S50003-13,
   S50003-2, S50003-20…`, que es como se veia en su telefono. */
function ordenNumerico(a, b) {
  const numeros = t => (String(t).match(/\d+/g) || []).map(Number);
  const na = numeros(a), nb = numeros(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = na[i] === undefined ? -1 : na[i];
    const y = nb[i] === undefined ? -1 : nb[i];
    if (x !== y) return x - y;
  }
  return String(a).localeCompare(String(b));
}

function llenarCups() {
  const sel = $("cups");
  sel.innerHTML = "";
  sel.appendChild(new Option("— escoge —", ""));
  Object.keys(catalogo.cups).sort(ordenNumerico).forEach(c => {
    sel.appendChild(new Option(c + " · " + catalogo.cups[c].descripcion, c));
  });
}

/* Al escoger el CUPS, el desplegable del subcodigo se llena SOLO con los suyos. */
function llenarSubcodigos() {
  const sel = $("subcodigo");
  const cups = $("cups").value;
  sel.innerHTML = "";
  sel.appendChild(new Option("— escoge —", ""));
  if (!cups) { llenarMotivos(); return; }
  const subs = catalogo.cups[cups].subcodigos;
  Object.keys(subs).sort(ordenNumerico).forEach(s => {
    const texto = subs[s].descripcion || "";
    sel.appendChild(new Option(s + (texto ? " · " + texto : ""), s));
  });
  llenarMotivos();
}

/* DJ · El motivo sale del SUBCODIGO, y con eso el error que hoy bloquea abril
   (`motivo_de_otro_subcodigo`) no se puede cometer: solo se ofrecen los que caben.
   Medido: 29 de los 51 subcodigos admiten uno solo, y ahi se escoge solo. */
function llenarMotivos() {
  const sel = $("motivo");
  const ayuda = $("ayudaMotivo");
  const cups = $("cups").value;
  const sub = $("subcodigo").value;
  sel.innerHTML = "";

  if (!cups || !sub) {
    sel.appendChild(new Option("— escoge antes el subcódigo —", ""));
    sel.disabled = true;
    ayuda.textContent = "";
    return;
  }
  const motivos = catalogo.cups[cups].subcodigos[sub].motivos || {};
  const codigos = Object.keys(motivos).sort(ordenNumerico);
  sel.disabled = codigos.length === 0;

  if (codigos.length === 0) {
    sel.appendChild(new Option("— este subcódigo no lleva motivo —", ""));
    ayuda.textContent = "Este subcódigo no tiene motivo en el catálogo.";
    return;
  }
  if (codigos.length > 1) sel.appendChild(new Option("— escoge —", ""));
  codigos.forEach(m => sel.appendChild(new Option(m + " · " + motivos[m], m)));

  if (codigos.length === 1) {
    sel.value = codigos[0];
    ayuda.textContent = "Solo admite uno: " + codigos[0] + " · " + motivos[codigos[0]];
  } else {
    ayuda.textContent = "Obligatorio · admite " + codigos.length + " motivos: escoge uno.";
  }
}

/* ----------------------------------------------------------- quien es */

function personaDe(documento) {
  const doc = String(documento);
  /* La base de Dusakawi MANDA; lo que ella escribió solo cuenta si ahí no está. */
  if (base && base.personas && base.personas[doc]) return base.personas[doc];
  return nuevos[doc] || null;
}

/* ⚠️ Los dos modulos preguntan lo mismo —«¿de quien es este documento?»— asi que la
   funcion recibe QUE campos mirar en vez de tener una copia por modulo. Dos copias de
   esto acabarian diciendo cosas distintas del mismo paciente. */
function pintarQuienEs(idDoc, idCaja, idTipo) {
  idDoc = idDoc || "documento"; idCaja = idCaja || "quienEs"; idTipo = idTipo || "tipo";
  const caja = $(idCaja);
  const doc = limpiarDocumento($(idDoc).value);
  caja.className = "quien";
  /* FJ · El bloque del paciente nuevo es solo de la captura de medicina. */
  const bloqueNuevo = idCaja === "quienEs" ? $("pacienteNuevo") : null;
  if (bloqueNuevo) bloqueNuevo.hidden = true;

  if (!doc) {
    caja.classList.add("vacio");
    caja.textContent = "Escribe el documento para ver de quién es.";
    return;
  }
  if (!base) {
    caja.classList.add("vacio");
    caja.textContent = "Sin base cargada: no se puede comprobar de quién es.";
    return;
  }
  const p = personaDe(doc);
  if (!p) {
    caja.classList.add("ausente");
    caja.innerHTML = "<strong>No aparece en la base</strong>" +
      "<span class=\"detalle\">" + (bloqueNuevo
        ? "Escribe abajo su nombre, fecha de nacimiento y sexo: queda como paciente nuevo."
        : "Se puede capturar igual y queda marcado, para que Isaac lo revise.") + "</span>";
    if (bloqueNuevo) bloqueNuevo.hidden = false;
    return;
  }
  caja.classList.add("hallado");
  const enOtraSede = sede && p.d && p.d !== sede
    ? " · <b>en la base figura en " + p.d + "</b>" : "";
  caja.innerHTML = "<strong>" + p.n + "</strong>" +
    "<span class=\"detalle\">" + (p.t || "?") + " · nació " + (p.f || "?") +
    " · " + (p.s || "?") + enOtraSede +
    (p.nuevo ? " · <b>paciente nuevo (lo escribiste tú)</b>" : "") + "</span>";

  /* El tipo de la base se PROPONE, no se impone: manda el que ella escriba, porque la
     base dice el de HOY y la atencion puede ser de hace meses (DH). */
  if (p.t && !$(idTipo).dataset.tocado) {
    const opciones = Array.from($(idTipo).options).map(o => o.value);
    if (opciones.indexOf(p.t) >= 0) $(idTipo).value = p.t;
  }
}

/* ------------------------------------------------------------ capturar */

function queLeFalta(r) {
  const faltas = [];
  /* FJ-3 · «la base» a secas se leía como «el Drive»: con el paciente ya mandado, él creyó
     que no había subido. Se dice CUÁL base. */
  if (r.nuevo) faltas.push("paciente nuevo: no está en la base de Dusakawi");
  else if (!r.nombre) faltas.push("no está en la base de Dusakawi");
  if (!r.motivo) faltas.push("sin código de motivo");
  return faltas;
}

async function agregar() {
  const aviso = $("avisoCampo");
  aviso.hidden = true;

  if (!sede) { revisarSede(); return; }

  const doc = limpiarDocumento($("documento").value);
  const fechaISO = $("fecha").value;
  const cups = $("cups").value;
  const sub = $("subcodigo").value;

  if (!doc) return fallar("Falta el número de documento.", "documento");
  if (!fechaISO) return fallar("Falta la fecha de prestación.", "fecha");
  /* Sin CUPS no se agrega, y es distinto de que falte el nombre: una atencion sin
     servicio no cuenta para ninguna meta y no se puede validar, asi que guardarla
     seria guardar una fila que hay que rehacer entera. */
  if (!cups) return fallar("Falta el servicio (CUPS): sin él la atención no cuenta para ninguna meta.", "cups");
  if (!sub) return fallar("Falta el subcódigo.", "subcodigo");

  /* 🔴 DX · El motivo tiene que ser UNO DE LOS DEL SUBCODIGO. Antes el campo se podia
     escribir y por ahi entro el `564` con el `S50003-8` —que admite 8— en su propia
     prueba. La plataforma lo habria rechazado, y el error `motivo_de_otro_subcodigo` es
     justo el que bloqueaba abril. */
  const admitidos = Object.keys((catalogo.cups[cups].subcodigos[sub] || {}).motivos || {});
  const motivo = $("motivo").value.trim();
  /* 🔴 DY · El motivo es OBLIGATORIO: lo decidió él el 2026-09-11 —«el motivo siempre
     es obligatorio»—. Supera lo de DX, que dejaba guardar sin motivo y lo marcaba.
     Solo puede quedar vacío si el subcódigo no admite ninguno. */
  if (admitidos.length && !motivo) {
    return fallar("Falta el código de motivo: escoge uno de los " + admitidos.length +
                  " que admite " + sub + ".", "motivo");
  }
  if (motivo && !admitidos.includes(motivo)) {
    return fallar("El motivo " + motivo + " no es de " + sub + ". Escoge uno de la lista.",
                  "motivo");
  }

  let p = personaDe(doc);
  /* 🔴 FJ · Sin la persona en la base (ni entre los nuevos), sus datos son OBLIGATORIOS:
     decisión suya del 2026-09-16 —«que Anyi también tenga que escribir eso»—. */
  /* ⚠️ Solo con una base CARGADA: sin base todos parecerían nuevos y tendría que escribir
     los datos de cada paciente. Sin base se captura como antes, marcado. */
  const hayBase = !!(base && base.personas);
  let esNuevo = hayBase && (!p || !!p.nuevo);
  if (!p && hayBase) {
    const nombre = $("nNombre").value.trim().replace(/\s+/g, " ").toUpperCase();
    const nacimientoISO = $("nNacimiento").value;
    const sexo = $("nSexo").value;
    if (nombre.split(" ").length < 2)
      return fallar("Es un paciente nuevo: escribe su nombre completo (nombres y apellidos).",
                    "nNombre");
    if (!nacimientoISO) return fallar("Falta la fecha de nacimiento del paciente nuevo.",
                                      "nNacimiento");
    if (nacimientoISO > fechaISO)
      return fallar("La fecha de nacimiento no puede ser posterior a la atención.",
                    "nNacimiento");
    if (!sexo) return fallar("Falta el sexo del paciente nuevo.", "nSexo");
    p = { t: $("tipo").value, n: nombre, f: fechaParaElPrograma(nacimientoISO), s: sexo,
          d: sede, nuevo: true, creado: new Date().toISOString() };
    nuevos[doc] = p;
    await guardarAjuste("pacientesNuevos", nuevos);
    $("nNombre").value = ""; $("nNacimiento").value = ""; $("nSexo").value = "";
  }
  const registro = {
    id: (Date.now() + "-" + Math.random().toString(36).slice(2, 8)),
    creado: new Date().toISOString(),
    sede: sede,
    tipo: $("tipo").value,
    documento: doc,
    nombre: p ? p.n : "",
    sedeBase: p && !p.nuevo ? (p.d || "") : "",
    /* FJ · lo que ella escribió viaja con la atención, para el programa y el Drive. */
    nacimiento: esNuevo ? (p.f || "") : "",
    sexo: esNuevo ? (p.s || "") : "",
    nuevo: esNuevo,
    fecha: fechaParaElPrograma(fechaISO),
    cups: cups,
    subcodigo: sub,
    motivo: motivo,
    descargado: false
  };

  await guardarRegistro(registro);
  registros.unshift(registro);
  await guardarAjuste("ultimaFecha", fechaISO);

  /* El documento y la fecha se CONSERVAN; lo que se limpia es el codigo. Lo normal es
     que la misma persona lleve dos servicios del mismo dia. */
  $("cups").value = "";
  llenarSubcodigos();
  $("cups").focus();

  pintarLista();
  pintarEnvio();
  pintarQuienEs();
  /* Se intenta en el acto y en silencio. Si no hay señal, queda para luego: lo que no
     puede pasar es que ella tenga que acordarse de mandarlo. */
  mandarPendientes(true);
  const faltas = queLeFalta(registro);
  brindis(faltas.length ? "Agregado · " + faltas.join(" y ")
                        : "Agregado · " + (registro.nombre || registro.documento));
}

function fallar(texto, campo) {
  const aviso = $("avisoCampo");
  aviso.textContent = texto;
  aviso.hidden = false;
  const el = $(campo);
  if (el) el.focus();
}

function pintarLista() {
  const ul = $("lista");
  $("cuantos").textContent = String(registros.length);
  ul.innerHTML = "";
  if (registros.length === 0) {
    const li = document.createElement("li");
    li.className = "vacia";
    li.style.background = "transparent";
    li.style.border = "0";
    li.textContent = "Todavía no has capturado nada.";
    ul.appendChild(li);
    return;
  }
  registros.forEach(r => {
    const faltas = queLeFalta(r);
    const li = document.createElement("li");
    if (faltas.length) li.classList.add("incompleto");
    if (r.descargado) li.classList.add("enviado");

    const datos = document.createElement("div");
    datos.className = "datos";
    const t = document.createElement("span");
    t.className = "titulo";
    t.textContent = (r.nombre || r.documento) + " · " + r.subcodigo;
    const d = document.createElement("span");
    d.className = "detalle";
    d.textContent = [r.tipo + " " + r.documento, r.fecha,
                     r.motivo ? "motivo " + r.motivo : null,
                     faltas.length ? "⚠ " + faltas.join(" · ") : null,
                     r.descargado ? "ya descargado" : null,
                     (drive && drive.url && !r.enviado) ? "sin mandar" : null,
                     // FJ-3 · que lo mandado se DIGA; callarlo se leía como «no subió».
                     r.enviado ? "✓ en el Drive" : null]
                    .filter(Boolean).join("  ·  ");
    datos.appendChild(t);
    datos.appendChild(d);

    const quitar = document.createElement("button");
    quitar.className = "quitar";
    quitar.type = "button";
    quitar.textContent = "✕";
    quitar.title = "Quitar";
    quitar.addEventListener("click", () => quitarUno(r));

    li.appendChild(datos);
    li.appendChild(quitar);
    ul.appendChild(li);
  });
}

async function quitarUno(r) {
  const quien = r.nombre || r.documento;
  /* EC · Se DICE que también se quita del Drive cuando ya se había mandado: si no, ella
     no sabría si la fila mala sigue por ahí. */
  const donde = r.enviado
    ? "Se borra de este aparato y se tacha en el Drive."
    : "Se borra de este aparato.";
  if (!(await preguntar("¿Quitar esta atención?",
                        [quien + " · " + r.subcodigo, donde],
                        "Quitar", true))) return;
  await apuntarAnulacion(r, "medicina");
  await borrarRegistro(r.id);
  registros = registros.filter(x => x.id !== r.id);
  pintarLista();
  pintarEnvio();
  brindis(r.enviado ? "Quitado. Se tachará en el Drive." : "Quitado");
  if (r.enviado) mandarPendientes(true);
}

/* ------------------------------------------------------------ descargar */

/* Las columnas son EXACTAMENTE las que el ValidadorMakushama ya sabe leer
   (`importar_capturado_mt`), incluido el tipo de documento. */
const COLUMNAS = ["tipo documento", "documento", "fecha", "subcodigo",
                  "codigo motivo", "sede",
                  /* FJ · solo se llenan en los pacientes nuevos */
                  "nombre", "fecha nacimiento", "sexo"];

function csvDeRegistros(rs) {
  const escapar = v => {
    const t = String(v === null || v === undefined ? "" : v);
    return /[",;\n]/.test(t) ? "\"" + t.replace(/"/g, "\"\"") + "\"" : t;
  };
  const lineas = [COLUMNAS.join(",")];
  rs.forEach(r => {
    lineas.push([r.tipo, r.documento, r.fecha, r.subcodigo, r.motivo, r.sede,
                 r.nuevo ? r.nombre : "", r.nacimiento || "", r.sexo || ""]
                .map(escapar).join(","));
  });
  /* CRLF y BOM para que Excel lo abra bien de un doble clic. */
  return "﻿" + lineas.join("\r\n") + "\r\n";
}

async function descargar() {
  if (registros.length === 0) { brindis("No hay nada que descargar."); return; }
  const nombre = "capturado_" + (sede || "SIN_SEDE") + "_" + hoy() + ".csv";
  const blob = new Blob([csvDeRegistros(registros)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  /* Se MARCA lo descargado, no se borra: si el archivo se pierde por el camino, lo
     capturado sigue aqui y se puede volver a bajar. Borrar es un acto aparte. */
  for (const r of registros) {
    if (!r.descargado) { r.descargado = true; await guardarRegistro(r); }
  }
  await guardarAjuste("ultimaDescarga", new Date().toISOString());
  pintarLista();
  pintarUltimaDescarga();
  brindis("Descargado: " + nombre, 4200);
}

async function pintarUltimaDescarga() {
  const cuando = await leerAjuste("ultimaDescarga");
  $("ultimaDescarga").textContent = cuando
    ? "Última descarga: " + new Date(cuando).toLocaleString("es-CO", {dateStyle: "short", timeStyle: "short"})
    : "Nada descargado todavía.";
}

async function vaciarDescargados() {
  /* ⚠️ Con el Drive conectado hace falta ADEMAS que esté mandado. Borrar algo que se
     descargó pero no llegó al Drive dejaría a Isaac con el archivo y a la hoja sin la
     fila — y nadie se enteraría hasta cuadrar las metas. */
  const yaEstan = registros.filter(
    r => r.descargado && (!drive || !drive.url || r.enviado));
  if (yaEstan.length === 0) { brindis("No hay nada descargado que borrar."); return; }
  if (!(await preguntar("¿Borrar lo ya descargado?",
                        ["Se van a borrar " + yaEstan.length + " atención(es) que YA descargaste.",
                         "Lo que no se ha descargado se queda."],
                        "Borrar", true))) return;
  for (const r of yaEstan) await borrarRegistro(r.id);
  /* 🔴 Se quitan EXACTAMENTE los que se borraron, no «los descargados».
     ⚠️ Filtrando por `descargado` a secas se iba de la lista también lo que estaba
     descargado pero SIN MANDAR —que en la tablet seguía guardado—, así que la pantalla
     y lo guardado decían cosas distintas y él podía creer que ya estaba subido. Lo cazó
     la prueba del envío, no leerlo. */
  const borrados = new Set(yaEstan.map(r => r.id));
  registros = registros.filter(r => !borrados.has(r.id));
  pintarLista();
  pintarEnvio();
  brindis("Borradas " + yaEstan.length);
}

/* ---------------------------------------------------------------- Drive */

/* DL · Lo capturado se ANEXA solo a la hoja compartida del Drive.
 *
 * Su encargo del 2026-09-02, y la razon que da lo reencuadra: no es comodidad, es
 * CONTINUIDAD — *«si yo me voy ella tenga esa informacion»*.
 *
 * 🔴 Las reglas que no se relajan, y son las mismas de la descarga:
 *
 *  · MANDAR NO BORRA. Se marca y se queda en la tablet. A Enrique se le quedaron 191
 *    registros sin subir, y de ahi sale todo esto.
 *  · SIN SEÑAL SE SIGUE CAPTURANDO, y lo pendiente se manda cuando la haya. La
 *    sincronizacion es una comodidad; **el boton de descargar siempre existe**.
 *  · CADA REGISTRO LLEVA SU IDENTIFICADOR y el script no lo anexa dos veces: si la
 *    respuesta se pierde por el camino, se reintenta y el repetido se descarta. Sin eso
 *    una mala señal llena la hoja de duplicados, que es lo que penalizan las reglas 6 y
 *    7 del Anexo 7.
 */

/* ======================================================================
   EC (2026-09-12) · QUITAR DEL DRIVE LO QUE SE LLENO MAL
   ======================================================================
   Su encargo: *«sería bueno que en la propia app se pueda eliminar un registro del drive
   por si se llega a equivocar Anyi en la llenada de datos»*. Hasta hoy «Quitar» borraba
   **solo de la tablet** y la fila se quedaba en la hoja para siempre.

   🔴 **No se borra: se MARCA anulada** (decisión suya). La fila se queda con su fecha en
   la columna `anulado`, y el programa se la salta al importar. Borrarla dejaría la hoja
   limpia pero sin rastro de qué se quitó ni cuándo — y son atenciones de pacientes.

   ⚠️ **La anulación queda PENDIENTE hasta que el Drive la confirme**, igual que las
   capturas. Ella puede equivocarse en el terreno, sin señal: si se intentara una sola vez
   y se perdiera, la fila mala se quedaría en la hoja sin que nadie lo supiera. */
async function apuntarAnulacion(registro, tipo) {
  /* Solo tiene sentido para lo que YA se mandó: lo que nunca salió de la tablet no está
     en ninguna hoja que tachar. */
  if (!registro.enviado) return;
  if (anulaciones.some(a => a.id === registro.id)) return;
  anulaciones.push({id: registro.id, tipo: tipo, cuando: new Date().toISOString()});
  await guardarAjuste("anulaciones", anulaciones);
}

function porAnular(tipo) {
  return anulaciones.filter(a => a.tipo === tipo).map(a => a.id);
}

function porMandar() {
  return registros.filter(r => !r.enviado);
}

/* EA · fase 4 · Lo pendiente del transporte. Aparte, porque va a otra hoja del Drive. */
function porMandarViajes() {
  return viajes.filter(v => !v.enviado);
}

/* ⚠️ `text/plain` a proposito: con `application/json` el navegador manda antes una
   peticion de comprobacion (preflight) que Apps Script no contesta, y el envio falla
   con un error de CORS que no habla de nada de esto. */
async function hablarConElDrive(cuerpo, segundos) {
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), (segundos || 25) * 1000);
  try {
    const respuesta = await fetch(drive.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ clave: drive.clave }, cuerpo)),
      signal: corte.signal,
      redirect: "follow"
    });
    if (!respuesta.ok) throw new Error("el Drive respondió " + respuesta.status);
    return JSON.parse(await respuesta.text());
  } finally {
    clearTimeout(reloj);
  }
}

async function mandarPendientes(silencioso) {
  if (!drive || !drive.url || mandando) return null;
  const pendientes = porMandar();
  const pendientesViajes = porMandarViajes();
  const aAnular = porAnular("medicina");
  const aAnularViajes = porAnular("transporte");
  if (!pendientes.length && !pendientesViajes.length
      && !aAnular.length && !aAnularViajes.length) { pintarEnvio(); return null; }
  if (!navigator.onLine) {
    /* Sin señal no se intenta: se dice y se deja para luego. Intentarlo igual solo
       alarga la espera y acaba en un error que asusta sin motivo. */
    pintarEnvio("sin señal");
    return null;
  }

  mandando = true;
  pintarEnvio("mandando");
  try {
    const carga = pendientes.map(r => ({
      id: r.id, tipo: r.tipo, documento: r.documento, fecha: r.fecha,
      subcodigo: r.subcodigo, motivo: r.motivo, sede: r.sede,
      nombre: r.nombre, creado: r.creado,
      nacimiento: r.nacimiento || "", sexo: r.sexo || "", nuevo: !!r.nuevo
    }));
    /* EA · fase 4 · Los dos modulos en el MISMO envio: es lo que el vio en el programa
       de Enrique —«Sincroniza globalmente todo lo pendiente de todos los modulos»— y
       ademas evita que con mala señal se vaya uno y el otro no. */
    const cargaViajes = pendientesViajes.map(v => ({
      id: v.id, tipo: v.tipo, documento: v.documento, fecha: v.fecha,
      medio: v.medio, placa: v.placa, origen: v.origen, destino: v.destino,
      valor: v.valor, beneficiado: v.beneficiado, motivo: v.motivo,
      sede: v.sede, creado: v.cuando
    }));
    const respuesta = await hablarConElDrive(
      { registros: carga, viajes: cargaViajes,
        anular: aAnular, anular_viajes: aAnularViajes }, 40);
    if (!respuesta || respuesta.ok !== true) {
      throw new Error((respuesta && respuesta.error) || "respuesta que no se entiende");
    }
    /* 🔴 Se marca lo que el Drive CONFIRMA, no lo que se mandó. Lo repetido tambien
       cuenta como guardado: ya estaba en la hoja. */
    const guardados = new Set([].concat(respuesta.guardados || [],
                                        respuesta.repetidos || []));
    let cuantos = 0;
    for (const r of pendientes) {
      if (guardados.has(r.id)) {
        r.enviado = true;
        r.enviadoEl = new Date().toISOString();
        await guardarRegistro(r);
        cuantos++;
      }
    }
    /* 🔴 Y lo mismo con el transporte. ⚠️ Si el buzon del Drive es de ANTES no conoce
       los viajes: contesta «ok» sin hablar de ellos, y marcarlos como enviados los
       perderia EN SILENCIO. Por eso se mira si la respuesta los menciona siquiera. */
    let cuantosViajes = 0;
    const elBuzonSabeDeViajes = respuesta.viajes_guardados !== undefined
                             || respuesta.viajes_repetidos !== undefined;
    /* 🔴 EC-2 (2026-09-12) · Y lo MISMO para las anulaciones, que se me había quedado
       fuera. Él borró unos pacientes, el buzón todavía era el de antes, y la app solo
       dijo «1 sin mandar al Drive» — sin decir POR QUÉ. Textual: «borré los pacientes
       pero no veo en la hoja que diga que está anulado». */
    const elBuzonSabeAnular = respuesta.anulados !== undefined
                           || respuesta.viajes_anulados !== undefined;
    const seQuedaronViajes = pendientesViajes.length && !elBuzonSabeDeViajes;
    const seQuedaronAnulaciones = (aAnular.length + aAnularViajes.length)
                                  && !elBuzonSabeAnular;
    const elBuzonEsDeAntes = seQuedaronViajes || seQuedaronAnulaciones;
    if (pendientesViajes.length && elBuzonSabeDeViajes) {
      const idosV = new Set([].concat(respuesta.viajes_guardados || [],
                                      respuesta.viajes_repetidos || []));
      for (const v of pendientesViajes) {
        if (idosV.has(v.id)) {
          v.enviado = true;
          v.enviadoEl = new Date().toISOString();
          await guardarViaje(v);
          cuantosViajes++;
        }
      }
      pintarViajes();
    }

    /* 🔴 Las anulaciones se quitan de la lista SOLO cuando el Drive las confirma. Si el
       buzón es de antes no las menciona siquiera, y entonces se quedan esperando: una
       anulación perdida es una fila mala que se queda en la hoja sin que nadie lo sepa. */
    const confirmadas = new Set([].concat(respuesta.anulados || [],
                                          respuesta.viajes_anulados || []));
    if (confirmadas.size) {
      anulaciones = anulaciones.filter(a => !confirmadas.has(a.id));
      await guardarAjuste("anulaciones", anulaciones);
    }

    pintarLista();
    if (elBuzonEsDeAntes) {
      /* ⚠️ Se pinta la banda y NO se espera a ningún cuadro: este mismo camino corre
         solo al abrir la app y al volver la señal, y quedarse esperando un clic dejaría
         el envío colgado. El cuadro solo sale cuando lo pidió una persona. */
      pintarEnvio("buzón viejo", seQuedaronAnulaciones ? "anulaciones" : "transporte");
      if (!silencioso) {
        avisar("El buzón del Drive es de antes", [
          seQuedaronAnulaciones
            ? "Lo que quitaste NO se ha tachado en la hoja: el buzón todavía no sabe " +
              "hacerlo. Se queda apuntado aquí y se tachará en cuanto se actualice."
            : "Las atenciones sí se mandaron, pero el buzón todavía no sabe recibir el " +
              "TRANSPORTE: se queda aquí, sin perderse.",
          "Isaac tiene que volver a publicar el script del Drive (Implementar → " +
          "Gestionar implementaciones → Nueva versión)."]);
      }
    } else {
      pintarEnvio();
    }
    if (!elBuzonEsDeAntes && !silencioso) {
      const partes = [];
      if (cuantos) partes.push(cuantos + " atención(es)");
      if (cuantosViajes) partes.push(cuantosViajes + " de transporte");
      brindis((partes.join(" y ") || "nada") + " en el Drive", 3800);
    }
    return cuantos + cuantosViajes;
  } catch (e) {
    /* ⚠️ Un fallo al mandar NO puede perder nada ni tumbar la app: lo capturado sigue
       aqui y se reintenta. Solo se dice. */
    pintarEnvio("falló", String(e && e.message || e));
    if (!silencioso) {
      avisar("No se pudo mandar al Drive",
             ["Lo capturado NO se ha perdido: sigue aquí y se vuelve a intentar.",
              "Detalle: " + (e && e.message || e)]);
    }
    return null;
  } finally {
    mandando = false;
  }
}

function pintarEnvio(estado, detalle) {
  pintarInicio();            // GA-2 · «En el Drive» del Inicio, al día
  const caja = $("avisoEnvio");
  const boton = $("enviar");
  const faltan = porMandar().length + porMandarViajes().length + anulaciones.length;
  boton.hidden = !(drive && drive.url);

  if (!drive || !drive.url) { caja.hidden = true; return; }

  /* 🔴 ED (2026-09-12) · La banda sale SOLO cuando hay algo que decir. Su reporte: *«el
     mensaje… nunca se quita»* — y era verdad: con el Drive puesto se quedaba en verde
     («Todo mandado al Drive») para siempre, ocupando el sitio de arriba de todas las
     pantallas para decir que no pasa nada.

     ⚠️ Es la regla que el programa ya tiene escrita (§6.3 de la agenda): *«si avisa todos
     los días diciendo "no hay nada", en dos semanas se deja de mirar»*. Y entonces el día
     que diga algo de verdad —«el buzón es de antes»— tampoco se mira.

     Que se mandó bien ya lo dice el mensajito que sale y se va solo; y «conectado y al
     día» se ve en Más opciones → Conexión con el Drive, que es su sitio. */
  if (!estado && !faltan) { caja.hidden = true; return; }

  caja.hidden = false;
  caja.className = "aviso azul";
  if (estado === "mandando") {
    caja.textContent = "Mandando " + faltan + " al Drive…";
  } else if (estado === "sin señal") {
    caja.className = "aviso naranja";
    caja.textContent = "Sin señal. " + faltan + " sin mandar; se van cuando haya.";
  } else if (estado === "buzón viejo") {
    /* 🔴 Dura hasta que él vuelva a publicar el script. No es un aviso de un momento:
       mientras siga así, o el transporte no llega o lo que se quitó no se tacha — y como
       no se pierde nada, un cuadro que se cierra y ya se olvidaría. */
    caja.className = "aviso naranja";
    caja.textContent = detalle === "anulaciones"
      ? ("El buzón del Drive es de antes y no sabe TACHAR: " + anulaciones.length
         + " sin tachar en la hoja, apuntadas aquí. Isaac tiene que volver a publicar "
         + "el script del Drive.")
      : ("El buzón del Drive es de antes y no recibe el TRANSPORTE: "
         + porMandarViajes().length + " esperando aquí, sin perderse. "
         + "Isaac tiene que volver a publicar el script del Drive.");
  } else if (estado === "falló") {
    caja.className = "aviso naranja";
    caja.textContent = "No se pudo mandar (" + (detalle || "") + "). "
                     + faltan + " esperando. Nada se ha perdido.";
  } else {
    caja.textContent = faltan + " sin mandar al Drive.";
  }
}

async function pintarConfigDrive() {
  const el = $("estadoDrive");
  if (drive && drive.url) {
    el.textContent = "Conectado. " + porMandar().length + " sin mandar.";
  } else {
    el.textContent = "Sin configurar: lo capturado se pasa con «Descargar».";
  }
}

async function probarDrive() {
  const url = $("urlDrive").value.trim();
  const clave = $("claveDrive").value.trim();
  const salida = $("resultadoDrive");
  if (!url) { salida.textContent = "Falta la dirección."; return; }

  const antes = drive;
  drive = { url: url, clave: clave };
  salida.textContent = "Probando…";
  try {
    const r = await hablarConElDrive({ prueba: true }, 25);
    if (!r || r.ok !== true) throw new Error((r && r.error) || "no contestó bien");
    await guardarAjuste("drive", drive);
    salida.textContent = "Listo: conectado a «" + (r.hoja || "la hoja") + "».";
    pintarEnvio();
    pintarConfigDrive();
    mandarPendientes(true);
  } catch (e) {
    drive = antes;                       // no se guarda una conexión que no funciona
    salida.textContent = "No funcionó: " + (e && e.message || e);
  }
}

async function quitarDrive() {
  if (!(await preguntar("¿Quitar la conexión con el Drive?",
                        ["Lo capturado NO se borra, y se sigue pudiendo pasar con «Descargar»."],
                        "Quitar"))) {
    return;
  }
  drive = null;
  await guardarAjuste("drive", null);
  $("urlDrive").value = "";
  $("claveDrive").value = "";
  $("resultadoDrive").textContent = "Quitada.";
  pintarEnvio();
  pintarConfigDrive();
}

/* ----------------------------------------------------------------- base */

function pintarBase() {
  const el = $("estadoBase");
  /* 🔴 EH · Delante va la SEDE, en morado, porque es el dato que no se puede equivocar; lo
     de la base va detrás. Se arma con `innerHTML` y no con `textContent` porque la sede
     lleva su `<b>` — y el texto sale del catálogo y del propio archivo de base, no de
     nada que alguien escriba a mano. */
  const conSede = txt => (sede ? "<b>" + sede + "</b> · " : "") + txt;
  if (!base) {
    el.innerHTML = conSede("base: sin cargar");
    $("avisoBase").hidden = false;
    pintarInicio();          // GA-2 · la cifra de la base del Inicio
    return;
  }
  const cuantas = Object.keys(base.personas || {}).length;
  /* La fecha se ve SIEMPRE, para que ella sepa si esta trabajando con una de hace
     tres meses. */
  el.innerHTML = conSede("base: " + cuantas + (cuantas === 1 ? " persona" : " personas")
                 + " · del " + (base.generado || "?"));
  $("avisoBase").hidden = true;
  pintarInicio();            // GA-2 · la cifra de la base del Inicio
}

/* ======================================================================
   EA · fase 5 (2026-09-12) · BAJAR LA BASE DESDE EL DRIVE
   ======================================================================
   Su decision: *«que sea por drive»*. Hasta hoy la base se pasaba a mano —un archivo por
   cable o por WhatsApp— y eso significa que quien digita trabaja con la base que le
   pasaron la ultima vez, que puede ser de hace tres meses.

   🔴 **Y esto NO puede vivir en el hosting de la app**: son pacientes reales (§10). Vive
   en SU Drive, detras de su clave, y solo sale cuando la app la pide. Por eso hace falta
   tener puesta la conexion con el Drive para poder bajarla.

   ⚠️ Manda la MAS RECIENTE, que es la regla que el dio: *«si hay un paciente con rc de
   marzo pero que en julio cambio a ti pues mandaria la de julio»*. El buzon escoge el
   archivo mas nuevo de la carpeta; la app enseña siempre de que fecha es la que tiene. */
async function bajarLaBaseDelDrive() {
  if (!drive || !drive.url) {
    return avisar("Actualizar base de datos", [
      "Para bajar la base sola hace falta la conexión con el Drive.",
      "Se pone una sola vez en Medicina Tradicional → Más… → Conexión con el Drive.",
      "Mientras tanto puedes cargarla a mano con el archivo que te pase Isaac."]);
  }
  if (!navigator.onLine) {
    return avisar("Sin señal", [
      "Para bajar la base hace falta señal.",
      "Lo que ya tienes guardado sigue funcionando igual: puedes capturar sin señal."]);
  }

  brindis("Bajando la base…", 2500);
  let respuesta;
  try {
    respuesta = await hablarConElDrive({ pedir: "base" }, 60);
  } catch (e) {
    return avisar("No se pudo bajar la base", [
      "La base que ya tienes NO se ha tocado: sigue igual.",
      "Detalle: " + (e && e.message || e)]);
  }

  /* 🔴 El buzón viejo no sabe de esto y contesta «ok» sin la base. Si no se distingue,
     la app diría «listo» sin haber bajado nada — que es el fallo silencioso de siempre. */
  if (respuesta && respuesta.ok === true && !respuesta.base) {
    return avisar("El buzón del Drive es de antes", [
      "Contestó bien, pero todavía no sabe servir la base de pacientes.",
      "Isaac tiene que volver a publicar el script del Drive (Implementar → Gestionar " +
      "implementaciones → Nueva versión).",
      "Tu base no se ha tocado."]);
  }
  /* 🔴 EB-2 · El caso de la opción (B), que es la que él escogió: el Drive está puesto
     para sincronizar, pero la base se pasa A MANO. Entonces no hay archivo de base en la
     carpeta, y el buzón lo dice. A quien usa la tablet eso no le sirve —«súbelo ahí» es
     algo que ella no puede hacer—, así que se le ofrece lo que SÍ puede: cargarla del
     archivo que le pasen. */
  if (respuesta && respuesta.ok !== true
      && String(respuesta.error || "").indexOf("base_pacientes") >= 0) {
    const aMano = await preguntar("La base no está en el Drive", [
      "En la carpeta del Drive no hay ninguna base de pacientes.",
      "Puedes cargarla del archivo que te pase Isaac. ¿La buscamos?"], "Buscar el archivo");
    if (aMano) $("archivoBase").click();
    return;
  }
  if (!respuesta || respuesta.ok !== true) {
    return avisar("No se pudo bajar la base", [
      (respuesta && respuesta.error) || "El Drive contestó algo que no se entiende.",
      "La base que ya tienes sigue igual."]);
  }

  let datos;
  try {
    datos = JSON.parse(respuesta.base);
    if (!datos || !datos.personas || typeof datos.personas !== "object") {
      throw new Error("no trae personas");
    }
  } catch (e) {
    return avisar("Lo que hay en el Drive no es la base", [
      "El archivo «" + (respuesta.nombre || "?") + "» no tiene la forma de la base de " +
      "pacientes. Tu base no se ha tocado.",
      "Detalle: " + (e && e.message || e)]);
  }

  const antes = base ? Object.keys(base.personas || {}).length : 0;
  base = datos;
  await guardarAjuste("base", datos);
  pintarBase();
  pintarQuienEs();
  pintarQuienEs("tDocumento", "tQuienEs", "tTipo");
  const ahora = Object.keys(datos.personas).length;
  await avisar("Base actualizada", [
    ahora + " personas, del " + (datos.generado || "?") + ".",
    antes ? ("Antes tenías " + antes + ".") : "Antes no había ninguna."]);
}

async function cargarBaseDeArchivo(archivo) {
  try {
    const datos = JSON.parse(await archivo.text());
    if (!datos || !datos.personas || typeof datos.personas !== "object") {
      throw new Error("no trae personas");
    }
    base = datos;
    await guardarAjuste("base", datos);
    pintarBase();
    pintarQuienEs();
    brindis("Base cargada: " + Object.keys(datos.personas).length + " personas", 3600);
  } catch (e) {
    avisar("Ese archivo no es la base de pacientes",
           ["Tiene que ser el .json que te pasa Isaac.", "Detalle: " + e.message]);
  }
}

/* -------------------------------------------------------------- enlaces */

function revisarSede() {
  $("avisoSede").hidden = !!sede;
  $("panelCaptura").style.opacity = sede ? "1" : ".55";
  pintarBotonesDeSede();
  /* 🔴 EH · La sede BAJÓ a la pantalla pero se sigue leyendo ARRIBA, todo el rato.
     Escogerla abajo está bien; perderla de vista, no: atribuirle a una sede las
     atenciones de la otra es el error más caro de este proceso. */
  pintarBase();
}

function conectar() {
  $("sede").addEventListener("change", async e => {
    sede = e.target.value;
    await guardarAjuste("sede", sede);
    revisarSede();
    pintarQuienEs();
  });

  /* ⚠️ Envuelto a proposito: `addEventListener("input", pintarQuienEs)` le pasa el
     EVENTO como primer argumento, y desde que la funcion recibe «que campos
     mirar» eso valia como si fuera un id. El `|| "documento"` no lo salvaba,
     porque un Event no es falso. Lo cazo la prueba del round-trip: el tipo de
     documento dejaba de proponerse desde la base. */
  $("documento").addEventListener("input", () => pintarQuienEs());
  $("tipo").addEventListener("change", e => { e.target.dataset.tocado = "1"; });
  $("cups").addEventListener("change", llenarSubcodigos);
  $("subcodigo").addEventListener("change", llenarMotivos);
  $("agregar").addEventListener("click", agregar);

  $("descargar").addEventListener("click", descargar);
  $("descargar2").addEventListener("click", descargar);
  $("mas").addEventListener("click", () => {
    pintarUltimaDescarga(); pintarVersion(); pintarGuardado(); $("dialogoMas").showModal(); });
  $("cerrarMas").addEventListener("click", () => $("dialogoMas").close());
  $("vaciar").addEventListener("click", vaciarDescargados);

  $("enviar").addEventListener("click", () => mandarPendientes(false));
  $("abrirDrive").addEventListener("click", () => {
    $("urlDrive").value = (drive && drive.url) || "";
    $("claveDrive").value = (drive && drive.clave) || "";
    $("resultadoDrive").textContent = "";
    $("dialogoDrive").showModal();
  });
  $("cerrarDrive").addEventListener("click", () => $("dialogoDrive").close());
  $("probarDrive").addEventListener("click", probarDrive);
  $("quitarDrive").addEventListener("click", quitarDrive);
  $("mas").addEventListener("click", pintarConfigDrive);

  /* 🔴 Cuando vuelve la señal se manda solo. Es el caso para el que existe todo esto:
     ella captura en el terreno sin cobertura y al llegar a la IPS se sube sin que nadie
     se acuerde de nada. */
  window.addEventListener("online", () => mandarPendientes(true));

  $("cargarBase").addEventListener("click", () => $("archivoBase").click());
  $("irCargarBase").addEventListener("click", () => $("archivoBase").click());
  $("archivoBase").addEventListener("change", e => {
    if (e.target.files && e.target.files[0]) cargarBaseDeArchivo(e.target.files[0]);
    e.target.value = "";
  });

  /* Enter encadena los campos, que es como se captura de verdad: un dato, Enter,
     el siguiente. */
  /* EA · El menu */
  $("irMedicina").addEventListener("click", () => irA("medicina"));
  $("irTransporte").addEventListener("click", () => irA("transporte"));

  /* EA · fase 2 · el modulo de transporte */
  $("tDocumento").addEventListener(
    "input", () => pintarQuienEs("tDocumento", "tQuienEs", "tTipo"));
  $("tTipo").addEventListener("change", e => { e.target.dataset.tocado = "1"; });
  $("tMedio").addEventListener("change", ajustarPlaca);
  $("tAgregar").addEventListener("click", agregarViaje);
  $("tDescargar").addEventListener("click", descargarViajes);
  $("tDocumento").addEventListener("keydown",
    e => { if (e.key === "Enter") $("tFecha").focus(); });
  $("irSincronizar").addEventListener("click", sincronizarTodo);
  $("irBase").addEventListener("click", irActualizarBase);
  /* EB · el mismo cuadro de «Más…», alcanzable sin entrar a ningún módulo */
  $("masDesdeMenu").addEventListener("click", () => {
    pintarUltimaDescarga(); pintarVersion(); pintarGuardado(); pintarConfigDrive();
    $("dialogoMas").showModal();
  });
  document.querySelectorAll("[data-volver]").forEach(
    b => b.addEventListener("click", () => irA("menu")));
  /* GA-2 · La navegación del rediseño: las secciones van con `irA`, y las acciones pulsan
     el MISMO botón que ya existía, para que no haya dos caminos que hagan cosas distintas. */
  document.querySelectorAll("[data-nav]").forEach(
    b => b.addEventListener("click", () => irA(b.dataset.nav)));
  document.querySelectorAll("[data-accion]").forEach(
    b => b.addEventListener("click", () => { const o = $(b.dataset.accion); if (o) o.click(); }));

  /* FJ · con el paciente nuevo a la vista, Enter lleva a sus datos antes que a la fecha. */
  $("documento").addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    (!$("pacienteNuevo").hidden ? $("nNombre") : $("fecha")).focus();
  });
  $("nNombre").addEventListener("keydown", e => { if (e.key === "Enter") $("nNacimiento").focus(); });
  $("motivo").addEventListener("keydown", e => { if (e.key === "Enter") agregar(); });
}

window.__mt = { csvDeRegistros, fechaParaElPrograma, queLeFalta, COLUMNAS,
                porMandar, mandarPendientes, irA, PANTALLAS,
                csvDeViajes, COLUMNAS_TRANSPORTE, crearAlmacenes, V_BD,
                porMandarViajes, bajarLaBaseDelDrive, porAnular,
                personaDe, nuevos: () => nuevos, hayAlgoAMedias };

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", arrancar);
} else {
  arrancar();
}
