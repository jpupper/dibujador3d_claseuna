# DibujoLiveShare

Lienzo **3D colaborativo en vivo**. Todos los clientes que abren la página están conectados
al mismo servidor y comparten **un único contexto 3D**: lo que dibuja uno aparece al instante
en la pantalla de los demás, y el que entra tarde recibe el dibujo completo.

- Servidor: **Node + Express + Socket.IO** → `server.js`
- Frontend: **three.js** + Socket.IO client → todo dentro de `public/`
- Estado persistente en `data/strokes.json` (sobrevive al reinicio del servidor)

---

## Instalar y correr

```
install.bat    (una sola vez: instala express, socket.io, three y prepara public/vendor)
run.bat        (arranca el servidor)
```

`run.bat` imprime dos links:

- `http://localhost:3210` → para vos
- `http://<tu-ip-de-red>:3210` → **pasáselo a los demás** (tienen que estar en la misma red/WiFi)

Se puede cambiar el puerto: `set PORT=4000 && node server.js`.

---

## Desde el celular (o cualquier PC de la red)

1. `run.bat` imprime el link de red (ej. `http://192.168.0.8:3210`) y ese mismo link aparece
   en el panel "Compartí este link" — siempre con la IP de red, aunque abras la app en `localhost`.
2. En el celular, **conectado a la misma WiFi**, abrí esa dirección. Ya podés dibujar.
3. **1 dedo dibuja** · **2 dedos orbitan y hacen zoom** · el botón **☰** (arriba a la derecha)
   oculta los paneles para dibujar a pantalla completa en el teléfono.

El servidor escucha en `0.0.0.0`, así que acepta conexiones de toda la red; lo único que puede
frenarlo es el Firewall de Windows. Tiene que existir una regla entrante para `node.exe` en el
perfil de red que estés usando (Privado o Público). Para revisarlo o crearla, como Administrador:

```
netsh advfirewall firewall add rule name="DibujoLiveShare" dir=in action=allow protocol=TCP localport=3210
```

Cambiá `3210` por el puerto real (mirá el banner de `run.bat`) y, si tu red figura como Pública,
agregá `profile=public`. Si aun así el celular no entra, revisá que el router no tenga
"aislamiento de clientes" (AP isolation) activado.

## Cómo se dibuja en 3D

| Acción | Qué hace |
|---|---|
| **Click izquierdo + arrastrar** | dibuja sobre el plano que está a la **profundidad** actual |
| **Click derecho + arrastrar** | **rota la cámara** (orbita alrededor del dibujo) |
| **Rueda del mouse** | acerca / aleja la cámara |
| **Shift + rueda** | mueve el plano de dibujo más cerca o más lejos (**profundidad**) |
| **Click del medio + arrastrar** | paneo |
| **1…8** | color |
| **B / E** | pincel / borrador |
| **Ctrl+Z** | deshacer tu último trazo |
| **↑ / ↓** | profundidad del plano |
| **R** | resetear cámara · **H** ayuda |
| **Táctil** | 1 dedo dibuja · 2 dedos orbitan y hacen zoom |

**Cómo funciona la profundidad:** el mouse se proyecta con un rayo sobre un plano
perpendicular a la cámara ubicado a `depth` unidades de distancia. El punto final se guarda
en **coordenadas de mundo**, no de pantalla. Por eso, si dibujás a distintas profundidades y
después girás la cámara, el dibujo se ve **en volumen** (no es un dibujo plano pegado a la pantalla).

El plano de dibujo actual se muestra como una grilla celeste translúcida, y el rayo punteado
indica dónde va a caer el pincel.

## Colaboración

- Cada usuario tiene un color asignado por el servidor y aparece en la lista de conectados.
- Mientras alguien dibuja, su trazo se ve **crecer en vivo** en las otras pantallas.
- Cada uno ve el cursor 3D de los demás (esferita + nombre) en su profundidad actual.
- **Deshacer** sólo borra tu propio último trazo. **Limpiar** borra todo para todos (pide confirmación).
- **Exportar/Importar** JSON para guardar o cargar un dibujo.

## Pantalla de salida: `output3d`

```
http://localhost:3210/output3d
```

Segunda vista del mismo servidor, pensada para un proyector, un segundo monitor o para
capturar con OBS. **Muestra sólo el resultado final:**

- los trazos **a medio hacer no se dibujan**: se guardan en un buffer silencioso
- cuando el trazo **termina** (`stroke:end`), entra completo a la escena de una sola vez
- al abrirse pide el estado y dibuja todo lo ya terminado; nunca muestra trabajo en curso

Además entra como **pantalla** (`?view=1`): el servidor no la cuenta como usuario (no aparece
en la lista de conectados del resto), no le registra ningún evento de escritura y por lo tanto
**no puede dibujar, deshacer ni limpiar**. Si querés ver el trazo crecer en vivo, usá la página
normal; `output3d` es para el resultado.

Parámetros y teclas:

```
?spin=0      desactiva el giro automático de cámara (por defecto gira lento)
?grid=0      oculta la grilla de referencia
?dist=14     distancia de cámara
?speed=0.05  velocidad del giro (rad/s)

R  giro on/off      C  resetear cámara      G  grilla      F  pantalla completa
```

Para que `output3d` sea siempre coherente, el protocolo garantiza que **todo trazo que entra
al estado compartido recibe su `stroke:end`** (también cuando el servidor cierra un trazo que
quedó sin terminar porque el mismo usuario empezó otro) y que un trazo **abandonado** (el
cliente se desconecta a medias) se anuncia con `stroke:remove`, que no queda en el estado, y
así las pantallas sueltan lo que tenían bufferizado.

## API de depuración

Desde la consola del navegador:

```js
__dls.state.depth = 12;                 // cambiar profundidad
__dls.addStrokeFromPoints([[0,0,0],[1,1,0],[2,0,1]], '#4cc9f0', 0.15);
__dls.strokeCount; __dls.pointCount; __dls.rig.reset();
socket.emit('clear');                   // limpiar para todos
```

Servidor: `GET /health` → `{ok, users, strokes, points}` y `GET /api/state` → estado completo.

## Verificación

```
npm run verify      (o npm test)
```

Arranca **su propia** instancia en un puerto libre y con un `STATE_FILE` temporal
(en `%TEMP%`, así no toca `data/strokes.json`), conecta 3 clientes socket reales,
comprueba replicación en ambos sentidos, persistencia, entrada tardía al contexto,
cursores, deshacer, import y limpiar, y apaga el servidor. Sale con código ≠ 0 si algo falla.

`STATE_FILE=... PORT=...` permiten correr varias salas aisladas en el mismo equipo.

La parte de WebGL (dibujo con puntero sobre el canvas, rotación de cámara, retícula y
plano de profundidad) se verifica a mano en el navegador: no hay forma de cubrirla sin
un navegador real con WebGL.

## Estructura

```
dibujoliveshare/
├── server.js            # servidor: estado compartido, sockets, persistencia, modo pantalla
├── package.json
├── install.bat          # npm install + prepara public/vendor/three
├── run.bat              # arranca la app
├── tests/verify.mjs     # verificación automática (npm run verify)
├── data/strokes.json    # estado guardado (se crea solo)
└── public/
    ├── index.html       # lienzo para dibujar
    ├── app.js           # puntero -> 3D, cámara, profundidad, red
    ├── style.css
    ├── engine3d.js      # motor compartido: sala, cámara orbital, trazos
    ├── output3d.html    # pantalla de salida (solo el resultado final)
    ├── output3d.js      # sólo lectura: bufferiza y dibuja trazos terminados
    ├── output3d.css
    └── vendor/          # three.js copiado por install.bat
```

`app.js` y `output3d.js` comparten `engine3d.js`, así que la geometría de los trazos y la
sala son una sola implementación: lo que cambies ahí se ve igual en las dos vistas.
